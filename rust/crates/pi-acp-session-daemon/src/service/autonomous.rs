//! Pi extension-triggered runs are independent of the client request phase.
//! Their ids scope completion, cancellation and persistence across overlapping
//! settled I/O and a newly accepted user request.
use super::*;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub(super) struct Runs {
    pub autonomous: HashMap<String, Autonomous>,
    pub current: Option<String>,
    pub managed_input: Option<String>,
    pub managed_excluded: HashSet<String>,
    pub persistence: Arc<tokio::sync::Mutex<()>>,
    pub worker_epoch: u64,
}
pub(super) struct Autonomous {
    pub running: bool,
    pub cancelled: bool,
    pub entries: HashSet<String>,
    pub cancel_task: Option<tokio::task::JoinHandle<()>>,
    pub checkpoint: tokio_util::sync::CancellationToken,
}
impl Runs {
    pub fn busy(&self) -> bool {
        !self.autonomous.is_empty()
    }
    pub fn running(&self) -> bool {
        self.current
            .as_ref()
            .and_then(|id| self.autonomous.get(id))
            .is_some_and(|run| run.running)
    }
    pub fn cancelled(&self) -> bool {
        self.current
            .as_ref()
            .and_then(|id| self.autonomous.get(id))
            .is_some_and(|run| run.cancelled)
    }
    pub fn clear(&mut self) {
        for run in self.autonomous.values_mut() {
            run.checkpoint.cancel();
            if let Some(task) = run.cancel_task.take() {
                task.abort();
            }
        }
        self.autonomous.clear();
        self.current = None;
    }
}
impl Runtime {
    pub(super) fn busy(&self) -> bool {
        self.phase.busy() || self.runs.busy()
    }
}

#[derive(Clone)]
pub(super) struct Host {
    pub store: Arc<SharedHistoryStore>,
    pub events: Arc<TaskOutbox>,
    pub broadcast: Broadcast,
    pub report: Report,
    pub closed: Arc<AtomicBool>,
}

/// Called under the runtime mutex before applying the notification. End tasks
/// retain their id; they cannot clear a newer run or a client's active phase.
pub(super) fn observe(r: &mut Runtime, rt: &Rt, update: &Value, host: &Host) {
    let Some(meta) = update.pointer("/_meta/pi-workbench-run") else {
        return;
    };
    let Some(id) = meta
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 100)
    else {
        return;
    };
    let Some(running) = meta.get("running").and_then(Value::as_bool) else {
        return;
    };
    if meta.get("autonomous").and_then(Value::as_bool) != Some(true) {
        if running {
            // A native wake can win the race after the daemon saved the user
            // input. Move that same durable entry to its ACTUAL start boundary,
            // rather than treating the preceding autonomous output as its reply.
            if let Some(input) = r.runs.managed_input.as_ref() {
                if let Some(index) = r.state.entries.iter().position(|entry| &entry.id == input) {
                    let entry = r.state.entries.remove(index);
                    r.state.entries.push(entry);
                }
            }
        }
        return;
    }
    if running {
        if r.runs.autonomous.contains_key(id) {
            return;
        }
        r.runs.current = Some(id.into());
        let checkpoint = tokio_util::sync::CancellationToken::new();
        let cancel = checkpoint.clone();
        let checkpoint_rt = rt.clone();
        let checkpoint_host = host.clone();
        let run_id = id.to_string();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                }
                if let Err(error) = save_snapshot(&checkpoint_host.store, &checkpoint_rt).await {
                    let agent = {
                        let mut r = checkpoint_rt.lock_unpoisoned();
                        if !r
                            .runs
                            .autonomous
                            .get(&run_id)
                            .is_some_and(|run| run.running)
                        {
                            break;
                        }
                        r.error = Some(error.clone());
                        r.agent.clone()
                    };
                    (checkpoint_host.report)(&error);
                    if let Some(agent) = agent {
                        agent.dispose();
                    }
                    break;
                }
            }
        });
        r.runs.autonomous.insert(
            id.into(),
            Autonomous {
                running: true,
                cancelled: false,
                entries: HashSet::new(),
                cancel_task: None,
                checkpoint,
            },
        );
        r.error = None;
        return;
    }
    let Some(run) = r.runs.autonomous.get_mut(id) else {
        return;
    };
    if !run.running {
        return;
    }
    run.running = false;
    run.checkpoint.cancel();
    if let Some(task) = run.cancel_task.take() {
        task.abort();
    }
    let cancelled = run.cancelled || meta.get("cancelled").and_then(Value::as_bool) == Some(true);
    let error = meta.get("error").and_then(Value::as_str).map(String::from);
    let entries: Vec<Entry> = r
        .state
        .entries
        .iter()
        .filter(|entry| run.entries.contains(&entry.id))
        .cloned()
        .collect();
    let snapshot = r.snapshot.clone();
    if r.runs.current.as_deref() == Some(id) {
        r.runs.current = None;
        for (_, settle) in r.permissions.drain() {
            let _ = settle.send(None);
        }
        r.state.permissions.clear();
    }
    if error.is_some() {
        r.error = error.clone();
    }
    let id = id.to_string();
    let Host {
        store,
        events,
        broadcast,
        report,
        closed,
    } = host.clone();
    let rt = rt.clone();
    tokio::spawn(async move {
        let completion = async {
            // Persist before marking idle: a queued user request must not race
            // this commit, nor may idle eviction discard uncommitted output.
            save_snapshot(&store, &rt).await?;
            let cwd = snapshot.cwd.clone();
            let accessor: StateAccessor = Arc::new(move || {
                Some((
                    snapshot.id.clone(),
                    snapshot.session_number,
                    entries.clone(),
                    0,
                    Some(snapshot.title.clone()),
                ))
            });
            let publication = TurnPublication::new(
                events,
                accessor,
                cwd,
                0,
                format!("autonomous:{id}"),
                "background".into(),
                crate::outbox::PublicationControl {
                    report: report.clone(),
                    closed,
                },
            );
            publication
                .finish(
                    error,
                    Some(if cancelled { "cancelled" } else { "end_turn" }),
                )
                .await
        }
        .await;
        let event = {
            let mut r = rt.lock_unpoisoned();
            if r.runs.autonomous.remove(&id).is_none() {
                return;
            }
            if let Err(error) = completion {
                report(&error);
                r.error = Some(error);
            }
            view_state_with_type(&r)
        };
        broadcast(event);
    });
}

pub(super) fn capture(r: &mut Runtime, update: &Value) {
    let Some(id) = r.runs.current.as_ref() else {
        return;
    };
    let Some(run) = r.runs.autonomous.get_mut(id).filter(|run| run.running) else {
        return;
    };
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let entry = if matches!(kind, "tool_call" | "tool_call_update") {
        r.state.entries.iter().find(|entry| {
            entry.tool.as_ref().and_then(|tool| tool.get("toolCallId")) == update.get("toolCallId")
        })
    } else if matches!(kind, "agent_message_chunk" | "agent_thought_chunk") {
        r.state.entries.last()
    } else {
        None
    };
    if let Some(entry) = entry {
        run.entries.insert(entry.id.clone());
        if r.runs.managed_input.is_some() {
            r.runs.managed_excluded.insert(entry.id.clone());
        }
    }
}

pub(super) async fn cancel(rt: &Rt) -> bool {
    let target = {
        let mut r = rt.lock_unpoisoned();
        let Some(id) = r.runs.current.clone() else {
            return false;
        };
        let Some(run) = r.runs.autonomous.get_mut(&id).filter(|run| run.running) else {
            return false;
        };
        if run.cancelled {
            return true;
        }
        run.cancelled = true;
        for (_, settle) in r.permissions.drain() {
            let _ = settle.send(None);
        }
        r.state.permissions.clear();
        (id, r.agent.clone(), acp_session_id(&r).to_string())
    };
    let (id, agent, acp_id) = target;
    let weak = Arc::downgrade(rt);
    let reference = agent.clone();
    let run_id = id.clone();
    let task = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let Some(rt) = weak.upgrade() else { return };
        let agent = {
            let r = rt.lock_unpoisoned();
            if r.runs.current.as_deref() != Some(&run_id) || !r.runs.cancelled() {
                return;
            }
            r.agent
                .as_ref()
                .zip(reference.as_ref())
                .filter(|(a, b)| Arc::ptr_eq(a, b))
                .map(|(a, _)| a.clone())
        };
        if let Some(agent) = agent {
            agent.dispose();
        }
    });
    {
        let mut r = rt.lock_unpoisoned();
        if let Some(run) = r.runs.autonomous.get_mut(&id).filter(|run| run.running) {
            run.cancel_task = Some(task);
        } else {
            task.abort();
        }
    }
    if let Some(agent) = agent {
        agent.cancel(&acp_id).await;
    }
    true
}
