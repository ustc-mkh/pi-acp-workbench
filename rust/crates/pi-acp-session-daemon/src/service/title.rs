use super::*;
impl SessionService {
    pub(super) async fn name_first_input(
        &self,
        rt: &Rt,
        agent: &Arc<AgentProcess>,
        request_id: &str,
        text: &str,
    ) -> Result<(), String> {
        let eligible = {
            let mut r = rt.lock_unpoisoned();
            if r.snapshot.extra.contains_key("titleAttempted")
                || r.snapshot.extra.contains_key("titleSource")
            {
                false
            } else {
                r.snapshot
                    .extra
                    .insert("titleAttempted".into(), json!(true));
                r.snapshot.harness.as_deref() == Some("pi") && !text.trim().is_empty()
            }
        };
        // Commit the attempt before any billable call. Reconnect/restart must not
        // regenerate names or inject a second user prompt.
        self.save(rt).await?;
        if !eligible || self.title_settings.get().await.model == "off" {
            return Ok(());
        }
        if agent
            .info()
            .await
            .unwrap_or(Value::Null)
            .pointer("/agentCapabilities/_meta/pi-workbench/title")
            != Some(&json!(true))
        {
            return Ok(());
        }
        let model = self.title_settings.get().await.model;
        let session_id = acp_session_id(&rt.lock_unpoisoned()).to_string();
        let result = agent.with_timeout(agent.request("_pi_workbench/title", json!({"sessionId":session_id,"model":model,"text":text.chars().take(1000).collect::<String>()})), 20000).await;
        match result {
            Ok(result) => {
                let mut r = rt.lock_unpoisoned();
                if let Some(title) = result
                    .get("title")
                    .and_then(Value::as_str)
                    .map(|s| crate::title::short_title(s, 32))
                    .filter(|s| !s.is_empty())
                {
                    r.snapshot.title = title;
                    r.snapshot
                        .extra
                        .insert("titleSource".into(), json!("generated"));
                }
                if let Some(records) = result.get("records").and_then(Value::as_array) {
                    for (i, value) in records.iter().take(16).enumerate() {
                        if let Ok(mut record) =
                            serde_json::from_value::<pi_acp_core::usage::UsageRecord>(value.clone())
                        {
                            if record.model.len() > 300 || record.timestamp == 0 {
                                continue;
                            }
                            record.id = format!("title:{request_id}:{i}");
                            record.session_id = session_id.clone();
                            record.kind = "session-title".into();
                            r.state.usage_records.push(record);
                        }
                    }
                }
            }
            Err(_) => (self.report)(
                "[title] 自动会话名生成失败或超时，保留首条输入的短文本，不自动重试。",
            ),
        }
        self.save(rt).await?;
        self.emit(rt);
        Ok(())
    }
}
