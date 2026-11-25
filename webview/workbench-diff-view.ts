import { element, button } from './workbench-elements';
import type { SessionView, TurnDiff, UndoReport } from '../src/workbench-protocol';
import type { UiCommand, WorkbenchUiMessage, WorkbenchUiState } from '../src/workbench-ui';

function remember<T>(cache: Map<string, T>, key: string, value: T, limit: number) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > limit) cache.delete(cache.keys().next().value!);
}

/** Diff display owns paging, undo selection and bounded preview caches. */
export class DiffView {
  private diffContents = new Map<string, { text: string; nextOffset?: number | null }>();
  private diffReads = new Set<string>();
  private attemptedDiffs = new Set<string>();
  private turnDiffs = new Map<string, TurnDiff>();
  private undoReports = new Map<string, UndoReport>();
  private undoSelections = new Map<string, Set<string>>();
  constructor(
    private state: () => WorkbenchUiState | undefined,
    private send: (message: UiCommand) => void,
    private disclosure: (key: string, fallback?: boolean) => HTMLDetailsElement,
    private error: HTMLElement,
    private schedule: () => void,
  ) {}
  clear() {
    this.turnDiffs.clear();
    this.diffReads.clear();
    this.attemptedDiffs.clear();
    this.diffContents.clear();
    this.undoSelections.clear();
    this.undoReports.clear();
  }
  requestAutomaticDiff(session: string, turn: string) {
    const state = this.state();
    const snapshot = state?.view?.view;
    const key = `${session}:${turn}`;
    if (
      !snapshot ||
      session !== state?.selected ||
      session !== snapshot.id ||
      turn === snapshot.active_turn ||
      this.turnDiffs.has(key) ||
      this.attemptedDiffs.has(key) ||
      this.diffReads.size >= 2
    )
      return;
    const entry = state.view?.entries.find((row) => row.turn === turn);
    if (!entry) return;
    this.attemptedDiffs.add(key);
    this.diffReads.add(key);
    while (this.attemptedDiffs.size > 64)
      this.attemptedDiffs.delete(this.attemptedDiffs.keys().next().value!);
    this.send({ type: 'read_turn_diff', session: snapshot.id, turn: entry.turn, automatic: true });
  }
  render(snapshot: SessionView, turn: NonNullable<SessionView['active_turn']>, busy: boolean) {
    const savedDiff = this.turnDiffs.get(`${snapshot.id}:${turn}`);
    if (!savedDiff || snapshot.active_turn === turn) return;
    const diffBox = element('article');
    diffBox.className = 'message turn-diff';
    diffBox.dataset.turnReview = 'true';
    const diffHeading = element('div');
    diffHeading.className = 'turn-diff-header';
    diffHeading.append(
      element(
        'strong',
        savedDiff.status === 'unavailable'
          ? '本轮修改 · 未能采集'
          : `本轮修改 · ${savedDiff.files.length} 个文件 · +${savedDiff.added} −${savedDiff.removed}${savedDiff.status === 'partial' ? '（部分结果）' : ''}`,
      ),
    );
    const diffActions = element('div');
    diffActions.className = 'turn-diff-actions';
    if (savedDiff.files.length) {
      const total = button('查看总 Diff', () =>
        this.send({ type: 'open_turn_diff', session: snapshot.id, turn }),
      );
      total.className = 'diff-link';
      const undo = button(
        '撤回本轮修改',
        () =>
          this.send({
            type: 'execute',
            session: snapshot.id,
            command: { method: 'undo_turn', session: snapshot.id, turn },
          }),
        busy ||
          snapshot.status !== 'Idle' ||
          savedDiff.status !== 'complete' ||
          savedDiff.next_offset !== null ||
          savedDiff.files.length > 256 ||
          savedDiff.files.reduce((n, f) => n + new TextEncoder().encode(f.path).length, 0) > 65536,
      );
      undo.className = 'diff-link undo-turn';
      undo.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const batch = (event.currentTarget as HTMLElement)
          .closest('[data-turn-review]')
          ?.querySelector<HTMLDetailsElement>('.turn-diff-batch');
        if (batch) {
          batch.hidden = false;
          batch.open = true;
        }
      });
      undo.title =
        savedDiff.status !== 'complete' ? '本轮快照不完整，无法安全撤回。' : '确认后撤回本轮修改';
      diffActions.append(total, undo);
    }
    diffHeading.append(diffActions);
    diffBox.append(diffHeading);
    const report = this.undoReports.get(`${snapshot.id}:${turn}`);
    if (report) {
      const failures = report.files.filter((file) => file.status !== 'restored');
      const restored = report.files.length - failures.length;
      const result = element('section');
      result.className = 'undo-report';
      result.setAttribute('role', 'status');
      result.append(element('p', `撤回结果 · 已恢复 ${restored}/${report.files.length} 个文件`));
      if (failures.length) {
        const list = element('ul');
        for (const file of failures)
          list.append(
            element('li', `${file.path} · ${file.status}${file.error ? ' · ' + file.error : ''}`),
          );
        result.append(list);
      }
      diffBox.append(result);
    }
    const summary = this.disclosure(`${snapshot.id}:diff:${turn}`, false);
    summary.className = 'turn-diff-files';
    summary.append(element('summary', `全部修改（${savedDiff.files.length} 个文件）`));
    if (!savedDiff.files.length) summary.append(element('p', '本轮未检测到文件净变化。'));
    const selectionKey = `${snapshot.id}:${turn}`;
    const selectedPaths = this.undoSelections.get(selectionKey) || new Set<string>();
    this.undoSelections.set(selectionKey, selectedPaths);
    while (this.undoSelections.size > 16)
      this.undoSelections.delete(this.undoSelections.keys().next().value!);
    const batchTools = this.disclosure(`${snapshot.id}:diff-batch:${turn}`, false);
    batchTools.className = 'turn-diff-batch';
    batchTools.append(element('summary', '按文件选择撤回…'));
    batchTools.hidden = !batchTools.open;
    if (savedDiff.status === 'complete') {
      batchTools.append(
        element(
          'p',
          '可按批选择最多 256 个文件（路径共 64 KiB），每批单独确认；冲突逐文件报告，可加载后续页继续选择。',
        ),
      );
      batchTools.append(
        button(
          'Undo selected files…',
          () => {
            if (selectedPaths.size)
              this.send({
                type: 'execute',
                session: snapshot.id,
                command: {
                  method: 'undo_turn',
                  session: snapshot.id,
                  turn,
                  files: [...selectedPaths],
                },
              });
          },
          busy || snapshot.status !== 'Idle',
        ),
      );
    }
    for (const [index, file] of savedDiff.files.entries()) {
      const fileDetails = this.disclosure(`${snapshot.id}:diff:${turn}:file:${file.path}`, false);
      fileDetails.className = 'turn-diff-file';
      const fileHeading = element(
        'summary',
        `${({ added: '新增', modified: '修改', deleted: '删除' } as Record<string, string>)[file.status] || file.status} · ${file.path}  +${file.added} −${file.removed}`,
      );
      fileDetails.append(fileHeading);
      const fileBody = element('div');
      summary.append(fileDetails);
      if (savedDiff.status === 'complete') {
        const choice = element('input');
        choice.type = 'checkbox';
        choice.checked = selectedPaths.has(file.path);
        choice.hidden = !batchTools.open;
        batchTools.addEventListener('toggle', () => {
          choice.hidden = !batchTools.open;
        });
        choice.setAttribute('aria-label', `Select for undo: ${file.path}`);
        choice.addEventListener('change', () => {
          if (choice.checked) {
            const bytes = [...selectedPaths, file.path].reduce(
              (n, path) => n + new TextEncoder().encode(path).length,
              0,
            );
            if (selectedPaths.size >= 256 || bytes > 65536) {
              choice.checked = false;
              this.error.textContent =
                'Undo batch limit: 256 files / 64 KiB paths. Confirm this batch before selecting more.';
              return;
            }
            selectedPaths.add(file.path);
          } else selectedPaths.delete(file.path);
        });
        fileHeading.append(choice);
      }
      if (file.old_mode !== file.new_mode)
        fileBody.append(
          element(
            'p',
            `Permissions: ${file.old_mode?.toString(8) ?? 'absent'} → ${file.new_mode?.toString(8) ?? 'absent'}`,
          ),
        );
      fileBody.append(
        button('Compare file in editor', () =>
          this.send({ type: 'open_turn_diff', session: snapshot.id, turn, file: index }),
        ),
      );
      if (file.omitted) {
        fileBody.append(
          element(
            'p',
            file.omitted === 'Diff content can be loaded in bounded slices.'
              ? '完整内容已归档，可按需读取或在编辑器中对比。'
              : file.omitted,
          ),
        );
        for (const after of [false, true])
          if ((after ? file.after : file.before) === null)
            fileBody.append(
              button(after ? 'Load after' : 'Load before', () =>
                this.send({
                  type: 'read_turn_diff_content',
                  session: snapshot.id,
                  turn,
                  file: index,
                  after,
                  offset: 0,
                }),
              ),
            );
      }
      for (const after of [false, true]) {
        const loaded = this.diffContents.get(`${snapshot.id}:${turn}:${index}:${after}`);
        if (loaded) {
          const pre = element('pre');
          pre.textContent = loaded.text.slice(0, 30000).split('\n').slice(0, 400).join('\n');
          fileBody.append(pre);
          if (loaded.text.length > 30000 || loaded.text.split('\n').length > 400)
            fileBody.append(element('p', '预览已截断；在编辑器中查看完整差异。'));
          if (
            loaded.text.length < 30000 &&
            loaded.nextOffset !== null &&
            loaded.nextOffset !== undefined
          )
            fileBody.append(
              button('Load next content slice', () =>
                this.send({
                  type: 'read_turn_diff_content',
                  session: snapshot.id,
                  turn,
                  file: index,
                  after,
                  offset: loaded.nextOffset!,
                }),
              ),
            );
        }
      }
      if (file.patch) {
        const patch = element('pre');
        patch.className = 'turn-diff-patch';
        for (const line of file.patch.slice(0, 30000).split('\n').slice(0, 400)) {
          const span = element('span', line + '\n');
          span.className = line.startsWith('+')
            ? 'diff-add'
            : line.startsWith('-')
              ? 'diff-remove'
              : line.startsWith('@@')
                ? 'diff-hunk'
                : '';
          patch.append(span);
        }
        fileBody.append(patch);
      }
      if (!file.patch && file.before !== null) {
        fileBody.append(element('h4', '修改前'));
        const pre = element('pre');
        pre.textContent = file.before ?? '';
        fileBody.append(pre);
      }
      if (!file.patch && file.after !== null) {
        fileBody.append(element('h4', '修改后'));
        const pre = element('pre');
        pre.textContent = file.after ?? '';
        fileBody.append(pre);
      }
      // Native details hides its body while collapsed. Keep the bounded
      // body reconciled so a lazy content response updates the live node,
      // rather than an old toggle listener reattaching an obsolete body.
      fileDetails.append(fileBody);
    }
    if (savedDiff.next_offset !== null)
      summary.append(
        button('Next diff page', () =>
          this.send({
            type: 'read_turn_diff',
            session: snapshot.id,
            turn,
            offset: savedDiff.next_offset!,
          }),
        ),
      );
    diffBox.append(summary);
    if (savedDiff.status === 'complete') diffBox.append(batchTools);
    const notes = element('div');
    notes.className = 'turn-diff-notes';
    const omitted = savedDiff.files.filter(
      (f) => f.omitted && f.omitted !== 'Diff content can be loaded in bounded slices.',
    ).length;
    if (omitted)
      notes.append(
        element('p', `${omitted} 个文件未采集文本内容（大小限制、二进制、子模块或读取失败）。`),
      );
    for (const warning of savedDiff.warnings) notes.append(element('p', warning));
    notes.append(
      element(
        'p',
        '工作区本轮开始到结束的净变化；不含 Git 忽略文件。并发的手工或其他会话修改也可能计入；不是文件回滚点。',
      ),
    );
    summary.append(notes);
    return diffBox;
  }
  receive(message: WorkbenchUiMessage) {
    const state = this.state();
    if (message.type === 'turn_diff_error')
      this.diffReads.delete(`${message.session}:${message.turn}`);
    if (!('session' in message) || message.session !== state?.selected) return;
    switch (message.type) {
      case 'undo_result':
        remember(this.undoReports, `${message.session}:${message.turn}`, message.report, 16);
        break;
      case 'turn_diff': {
        const key = `${message.session}:${message.turn}`;
        this.diffReads.delete(key);
        this.attemptedDiffs.delete(key);
        if (!state.view?.entries.some((row) => row.turn === message.turn)) return;
        let files = message.diff.files;
        if (message.offset) {
          const previous = this.turnDiffs.get(key);
          if (previous?.files.length !== message.offset) return;
          files = [...previous.files, ...files];
        }
        if (files.length > 5000) return;
        remember(this.turnDiffs, key, { ...message.diff, files }, 16);
        break;
      }
      case 'turn_diff_content': {
        if (!state.view?.entries.some((row) => row.turn === message.turn)) return;
        const key = `${message.session}:${message.turn}:${message.file}:${message.after}`;
        let text = message.bytes;
        if (message.offset) {
          const previous = this.diffContents.get(key);
          if (previous?.nextOffset !== message.offset) return;
          text = previous.text + text;
        }
        if (text.length > 128 * 1024) return;
        remember(this.diffContents, key, { text, nextOffset: message.next_offset }, 8);
        break;
      }
      case 'turn_diff_error':
        if (message.error) this.error.textContent = message.error;
        break;
      default:
        return;
    }
    this.schedule();
  }
}
