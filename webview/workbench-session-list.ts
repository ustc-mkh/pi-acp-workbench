import {
  HARNESSES,
  type HistoryClearReport,
  type SessionFilter,
  type SessionId,
  type SessionSummary,
} from '../src/workbench-protocol';
import type { UiCommand, WorkbenchUiState } from '../src/workbench-ui';
import { element, button } from './workbench-elements';
import { reconcile } from './workbench-dom';
import type { Preferences } from './workbench-preferences';

interface SessionListOptions {
  getState(): WorkbenchUiState | undefined;
  preferences: Preferences;
  send(command: UiCommand): void;
  persist(): void;
  close(): void;
}
export function createSessionList({
  getState,
  preferences,
  send,
  persist,
  close,
}: SessionListOptions) {
  const historySearch = element('input');
  historySearch.type = 'search';
  historySearch.placeholder = '搜索会话名称、目录…';
  historySearch.setAttribute('aria-label', '搜索全部会话');
  historySearch.maxLength = 300;
  const historyHarness = element('select');
  historyHarness.setAttribute('aria-label', 'History harness filter');
  for (const value of ['', ...HARNESSES]) {
    const option = element('option', value || '全部 Agent');
    option.value = value;
    historyHarness.append(option);
  }
  const historyFilter = (): SessionFilter => ({
    text: historySearch.value.trim(),
    harness: (historyHarness.value || null) as SessionFilter['harness'],
  });
  const search = () => send({ type: 'refresh', filter: historyFilter() });
  const historyControls = element('section');
  historyControls.className = 'history-search-controls';
  historyControls.append(historySearch, historyHarness, button('Search history', search));
  historySearch.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) search();
  });
  const clearProgress = element('section');
  let historyReleaseConfirm: SessionId | undefined;
  const sessions = element('div');
  sessions.id = 'history-items';
  sessions.setAttribute('role', 'listbox');
  sessions.setAttribute('aria-label', '会话历史');
  const historyPanel = element('section');
  historyPanel.id = 'history';
  const historyHeading = element('div', '会话历史');
  historyHeading.className = 'section-label';
  const historyActions = element('span');
  historyControls.hidden = true;
  historyActions.append(
    button('搜索', () => {
      historyControls.hidden = !historyControls.hidden;
      if (!historyControls.hidden) historySearch.focus();
    }),
    button('刷新', () => send({ type: 'refresh' })),
    button('清空', () => send({ type: 'prepare_history_clear', filter: historyFilter() })),
  );
  historyHeading.append(historyActions);
  historyPanel.append(historyHeading, historyControls, clearProgress, sessions);
  const historySize = element('div');
  historySize.className = 'history-controls';
  let displayedRows = preferences.sessionRows;
  const lessHistory = button('收起历史列表', () => {
    if (displayedRows === 4) close();
    else updateSize(displayedRows === 16 ? 10 : 4);
  });
  const moreHistory = button('展开历史列表', () => updateSize(displayedRows === 4 ? 10 : 16));
  for (const [control, path, label] of [
    [lessHistory, 'M4 12l6-6 6 6', '收起历史列表'],
    [moreHistory, 'M4 8l6 6 6-6', '展开历史列表'],
  ] as const) {
    control.setAttribute('aria-label', label);
    control.title = label;
    control.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${path}"/></svg>`;
  }
  historySize.append(lessHistory, moreHistory);
  historyPanel.append(historySize);

  const page = element('div');
  page.dataset.sessionPage = 'true';
  page.append(
    button('Next session page', () => {
      const cursor = getState()?.sessionsCursor;
      if (cursor) send({ type: 'refresh', cursor });
    }),
    button('Latest session page', () => send({ type: 'refresh' })),
  );
  function updateSize(requested?: number) {
    const count = getState()?.sessions.length ?? 0;
    const maximum = count <= 4 ? 4 : count <= 10 ? 10 : 16;
    if (requested !== undefined && preferences.sessionRows !== requested) {
      preferences.sessionRows = requested;
      persist();
    }
    displayedRows = Math.min(preferences.sessionRows, maximum);
    moreHistory.toggleAttribute('disabled', displayedRows === maximum);
    if (sessions.dataset.limit !== String(displayedRows))
      sessions.dataset.limit = String(displayedRows);
  }
  let lastProgress = '[]';
  function updateProgress(operations: WorkbenchUiState['operations']) {
    const jobs = new Map<string, HistoryClearReport>();
    for (const op of operations)
      if (op.historyClear) jobs.set(op.historyClear.job, op.historyClear);
    const definition = JSON.stringify([...jobs.values()]);
    if (definition === lastProgress) return;
    lastProgress = definition;
    clearProgress.replaceChildren();
    for (const report of jobs.values()) {
      clearProgress.append(
        element(
          'p',
          `Shared clear job ${report.job}: ${report.total} frozen targets, ${report.remaining} pending, ${report.failed} failed; preview included ${report.active} active tasks and ${report.pending_deliveries} pending deliveries. Includes Telegram and all matching harnesses/directories; native files, usage and delivery/dedup identities are retained.`,
        ),
      );
      if (report.remaining)
        clearProgress.append(
          button(report.preview ? 'Confirm first clear batch…' : 'Confirm next clear batch…', () =>
            send({ type: 'clear_history_batch', job: report.job }),
          ),
        );
    }
  }
  type ListSession = Omit<SessionSummary, 'revision' | 'created_seq'> & { created_seq?: number };
  function createRow(session: ListSession, selected: boolean, trusted: boolean) {
    const { id, harness, cwd, title, created_seq, retention_days: days = 0 } = session;
    const status = typeof session.status === 'string' ? session.status : 'Failed';
    const node = element('div');
    node.className = selected ? 'history-row current' : 'history-row';
    node.dataset.key = id;
    node.dataset.sessionId = id;
    node.setAttribute('role', 'option');
    node.setAttribute('aria-selected', String(selected));
    const phase = element('span');
    phase.className = 'session-indicator';
    phase.dataset.phase = phase.title = status;
    phase.classList.toggle('running', status === 'Running');
    phase.innerHTML =
      '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 3.5h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-5 3v-3H3V4.5a1 1 0 0 1 1-1Z"/></svg>';
    const number = element(
      'span',
      created_seq === undefined ? '当前' : '#' + String(created_seq).padStart(3, '0'),
    );
    number.className = 'session-number';
    number.dataset.retention = String(days);
    number.classList.toggle('alive-long', days === 4);
    number.classList.toggle('alive-short', days === 1);
    number.title = days ? `驻留保留 ${days} 天（按最后用户输入）` : '当前未驻留；使用时恢复会话';
    const provider = element('span', harness);
    provider.className = 'history-harness';
    provider.hidden = harness === 'Pi';
    const open = button(
      title || `新对话 #${created_seq}`,
      () => {
        send({ type: 'select', session: id });
        close();
      },
      false,
      false,
    );
    open.className = 'history-open';
    open.title = `${harness} · ${cwd}`;
    const remove = button(
      '删除会话',
      () => send({ type: 'remove_session', session: id }),
      !trusted,
    );
    remove.className = 'history-delete';
    remove.title = '删除会话（保留原生数据）';
    remove.setAttribute('aria-label', `删除会话：${title || id}`);
    remove.innerHTML =
      '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.5h13M7 5.5V3h6v2.5M5 5.5l.8 11h8.4l.8-11M8 8v5.5M12 8v5.5"/></svg>';
    const running = ['Running', 'Waiting', 'Cancelling'].includes(status);
    const confirming = historyReleaseConfirm === id;
    const release = button(
      '释放会话',
      () => {
        if (running && !confirming) historyReleaseConfirm = id;
        else {
          send({ type: 'release_session', session: id, confirmed: running });
          historyReleaseConfirm = undefined;
        }
        const state = getState();
        if (state) updateRows(state);
      },
      !trusted || !days,
    );
    release.className = 'history-release';
    release.setAttribute(
      'aria-label',
      `${confirming ? '确认释放会停止当前任务：' : '释放会话：'}${title || id}`,
    );
    release.title = confirming ? '再次点击停止任务并释放；保留历史' : '释放后台会话（保留历史）';
    release.innerHTML =
      '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v8M5.5 4.5a7 7 0 1 0 9 0"/></svg>';
    node.append(phase, number, provider, open, release, remove);
    return node;
  }

  let lastRows: string | undefined;
  function updateRows(state: WorkbenchUiState) {
    // Streaming changes the transcript revision without changing the list.
    const listed: ListSession[] = state.sessions.map(({ revision: _, ...row }) => row);
    const restored = state.view?.view;
    if (restored && !listed.some((session) => session.id === restored.id)) {
      const { id, harness, cwd, status } = restored;
      listed.unshift({ id, harness, cwd, status, title: '当前会话（不在此列表页）' });
    }
    if (historyReleaseConfirm && !listed.some((session) => session.id === historyReleaseConfirm))
      historyReleaseConfirm = undefined;
    const definition = JSON.stringify([
      state.selected,
      state.trusted,
      historyReleaseConfirm,
      listed,
    ]);
    if (definition === lastRows) return;
    lastRows = definition;
    sessions.dataset.selected = state.selected || '';
    const desired = element('div');
    if (listed.length) {
      for (const session of listed)
        desired.append(createRow(session, session.id === state.selected, state.trusted));
    } else desired.append(element('p', '还没有保存的会话。'));
    const focused = document.activeElement;
    reconcile(sessions, desired);
    // Moving an existing row during a sort can blur its focused control.
    if (
      focused instanceof window.HTMLElement &&
      sessions.contains(focused) &&
      document.activeElement !== focused
    )
      focused.focus({ preventScroll: true });
  }

  function render(state: WorkbenchUiState) {
    updateSize();
    updateProgress(state.operations);
    updateRows(state);
    if (state.sessionsCursor) {
      if (!page.parentElement) sessions.after(page);
    } else page.remove();
  }

  return { panel: historyPanel, render };
}
