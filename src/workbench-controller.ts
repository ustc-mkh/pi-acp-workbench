import { randomUUID, createHash } from 'node:crypto';
import { exportMarkdown } from './workbench-export';
import { copyLogicalMessage } from './workbench-copy';
import { externalDestination } from './workbench-messages';
import { WorkbenchClient, WorkbenchError, type RequestTicket } from './workbench-client';
import { WorkbenchSession } from './workbench-session';
import {
  durableCommand,
  operationId,
  sessionId,
  type ClientCommand,
  type OperationId,
  type SessionId,
  type SessionSummary,
  type ContentRef,
  type ListCursor,
} from './workbench-protocol';
import {
  uiCommand,
  uiOperation,
  type UiOperation,
  type WorkbenchUiMessage,
  type WorkbenchUiState,
} from './workbench-ui';

export interface WorkbenchPorts {
  post(message: WorkbenchUiMessage): void;
  trusted(): boolean;
  workspace(): string | undefined;
  /** Canonical workspace authorization before any provider/session mutation. */
  authorize(cwd: string): Promise<void>;
  copyText?(text: string): PromiseLike<void>;
  openLink?(url: string): Promise<void>;
  login?(): Promise<void>;
  configureTelegram?(): Promise<void>;
  openDiff?(turn: string, files: { path: string; before: string; after: string }[]): Promise<void>;
  confirmUndo?(session: SessionId, turn: string): Promise<boolean>;
  validateUndo?(session: SessionId, turn: string): Promise<void>;
  loadSelection?(): unknown;
  saveSelection?(session: SessionId | undefined): PromiseLike<void>;
  loadOperations?(): unknown;
  saveOperations?(operations: UiOperation[]): PromiseLike<void>;
  exportMarkdown?(session: SessionId, chunks: AsyncIterable<string>): Promise<void>;
  attachFiles?(cwd: string): Promise<import('./workbench-input').TextAttachment[]>;
}
/** UI owns only selection/display/workflow observers. The Rust actor owns all domain state. */
export class WorkbenchController {
  private turnDiffCache = new Map<string, import('./workbench-protocol').TurnDiff>();
  private selected?: WorkbenchSession;
  private selection = 0;
  private closed = false;
  private sequence = 0;
  private listRequest = 0;
  private listCursor?: ListCursor;
  private listFlight?: Promise<void>;
  private authorizationGeneration = 0;
  private uiRequest = 0;
  private emitTimer?: NodeJS.Timeout;
  private operations: UiOperation[] = [];
  private persistence: Promise<void> = Promise.resolve();
  private workflows = new Map<
    OperationId,
    { command: ClientCommand; ticket: RequestTicket<ClientCommand> }
  >();
  private state: WorkbenchUiState = { sessions: [], operations: [], trusted: false };
  private unobserve: () => void;
  private selecting = false;
  private exporting = false;
  private attaching = false;
  private undoConfirming = false;
  private restoredSelection?: SessionId;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private reconnectFlight?: Promise<void>;
  private recoveryFlight?: Promise<void>;
  constructor(
    readonly client: WorkbenchClient,
    private ports: WorkbenchPorts,
  ) {
    try {
      const savedSelection = ports.loadSelection?.();
      if (savedSelection !== undefined) this.restoredSelection = sessionId.parse(savedSelection);
    } catch {
      // Local display preferences never authorize a mutation.
    }
    const saved = ports.loadOperations?.();
    if (Array.isArray(saved) && saved.length <= 64) {
      for (const value of saved) {
        try {
          const row = uiOperation.parse(value);
          if (row.status === 'pending') row.status = 'uncertain';
          this.operations.push(row);
        } catch {
          /* Invalid local preferences never authorize a command. */
        }
      }
    }
    this.unobserve = client.observe({
      lost: () => {
        this.state.error =
          'Workbench connection lost. Reconnecting observation only; no request was resent.';
        this.scheduleReconnect();
        this.emit();
      },
    });
  }
  async authorizeForUndo(cwd: string): Promise<void> {
    if (this.closed || !this.ports.trusted()) throw new Error('Workspace trust changed');
    await this.ports.authorize(cwd);
    if (this.closed || !this.ports.trusted()) throw new Error('Workspace trust changed');
  }
  get snapshot(): WorkbenchUiState {
    return {
      ...this.state,
      selected: this.selected?.id,
      view: this.selected?.view,
      operations: this.operations,
      trusted: this.ports.trusted(),
      workspace: this.ports.workspace(),
    };
  }
  private emit() {
    if (this.closed || this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      if (!this.closed)
        this.ports.post({ type: 'state', sequence: ++this.sequence, state: this.snapshot });
    }, 30);
    this.emitTimer.unref();
  }
  async receive(value: unknown) {
    if (this.closed) return;
    try {
      const message = uiCommand.parse(value);
      if (this.undoConfirming && ['execute', 'create', 'select'].includes(message.type))
        throw new Error('Finish or cancel the undo confirmation first');
      switch (message.type) {
        case 'open_link': {
          if (!this.ports.trusted() || !this.ports.openLink)
            throw new Error('Trusted host required');
          await this.ports.openLink(externalDestination(message.url));
          break;
        }
        case 'login': {
          if (!this.ports.trusted() || !this.ports.login) throw new Error('Trusted host required');
          await this.ports.login();
          break;
        }
        case 'copy_message': {
          const selected = this.selected;
          const entry = selected?.view.entries.find((e) => e.id === message.entry);
          if (!selected || selected.id !== message.session || !entry || !this.ports.copyText)
            throw new Error('Select a visible message to copy');
          const text = await copyLogicalMessage(
            this.client,
            selected.id,
            entry.id,
            () => {
              if (this.selected !== selected || this.closed) throw new Error('Session changed');
            },
            !entry.message ? entry : undefined,
          );
          await this.ports.copyText(text);
          break;
        }
        case 'configure_telegram': {
          const cwd = this.ports.workspace();
          if (!cwd || !this.ports.configureTelegram)
            throw new Error('Open a trusted workspace to configure Telegram');
          const token = await this.authorize(cwd);
          this.assertAuthorization(token);
          await this.ports.configureTelegram();
          break;
        }
        case 'read_management': {
          try {
            const data = await this.client.call({ method: 'management', query: message.query });
            if (!this.closed)
              this.ports.post({ type: 'management', request_id: message.request_id, data });
          } catch {
            if (!this.closed)
              this.ports.post({
                type: 'management_error',
                request_id: message.request_id,
                error: 'Statistics/settings unavailable',
              });
          }
          break;
        }
        case 'attach_files': {
          const selected = this.selected;
          const snapshot = selected?.view.view;
          if (!selected || selected.id !== message.session || !snapshot)
            throw new Error('Select a session before attaching files');
          if (!this.ports.attachFiles) throw new Error('File attachments are unavailable');
          if (this.attaching) throw new Error('File selection is already in progress');
          this.attaching = true;
          try {
            const token = await this.authorize(snapshot.cwd);
            this.assertAuthorization(token);
            const files = await this.ports.attachFiles(snapshot.cwd);
            this.assertAuthorization(token);
            if (this.closed || this.selected !== selected)
              throw new Error('Session selection changed while selecting files');
            this.ports.post({ type: 'attachments', session: selected.id, files });
          } finally {
            this.attaching = false;
          }
          break;
        }
        case 'export': {
          const selected = this.selected;
          const snapshot = selected?.view.view;
          if (!selected || selected.id !== message.session || !snapshot)
            throw new Error('Select a session before exporting');
          if (!this.ports.exportMarkdown) throw new Error('Export is unavailable');
          if (this.exporting) throw new Error('An export is already in progress');
          this.exporting = true;
          try {
            const token = await this.authorize(snapshot.cwd);
            const guard = () => {
              this.assertAuthorization(token);
              if (this.closed || this.selected !== selected)
                throw new Error('Export cancelled because session selection changed');
            };
            guard();
            await this.ports.exportMarkdown(
              selected.id,
              exportMarkdown(this.client, selected.id, guard),
            );
          } finally {
            this.exporting = false;
          }
          break;
        }
        case 'refresh_names':
          await this.refresh();
          break;
        case 'recover_operations':
          await this.recoverOperations();
          break;
        case 'ready':
        case 'refresh':
          await this.recoverOperations();
          await this.refresh(message.type === 'refresh' ? message.cursor : undefined);
          if (message.type === 'ready' && !this.selected && this.restoredSelection) {
            const session = this.restoredSelection;
            this.restoredSelection = undefined;
            await this.select(session);
          } else await this.selected?.refresh();
          if (this.selected?.view.status === 'ready') this.resetReconnect();
          break;
        case 'select':
          await this.select(message.session);
          break;
        case 'create': {
          if (message.command.method !== 'create') throw new Error('Only create is allowed here');
          const token = await this.authorize(message.command.cwd);
          this.assertAuthorization(token);
          const result = await this.execute(message.command);
          if (!result || typeof result !== 'object' || !('Created' in result))
            throw new Error('Created session missing');
          this.upsert(result.Created.summary);
          await this.select(result.Created.summary.id);
          break;
        }
        case 'execute': {
          const selected = this.selected;
          if (
            !selected ||
            selected.id !== message.session ||
            !('session' in message.command) ||
            message.command.session !== selected.id
          )
            throw new Error('Session selection changed');
          if (
            ![
              'prompt',
              'cancel',
              'answer',
              'fork',
              'set_model',
              'set_mode',
              'set_option',
              'discover',
              'remove',
              'undo_turn',
              'manage',
            ].includes(message.command.method)
          )
            throw new Error('Command is not a user mutation');
          const snapshot = selected.view.view;
          const control = ['cancel', 'answer', 'remove'].includes(message.command.method);
          if (
            !snapshot ||
            (control
              ? ['removed', 'disconnected', 'syncing'].includes(selected.view.status)
              : selected.view.status !== 'ready')
          )
            throw new Error('Refresh the authoritative session before modifying it');
          let token = await this.authorize(snapshot.cwd);
          this.assertAuthorization(token);
          if (this.selected !== selected || selected.view.view?.cwd !== snapshot.cwd)
            throw new Error('Session changed while authorizing');
          if (this.closed || !this.ports.trusted()) throw new Error('Workspace trust changed');
          if (this.selected !== selected || selected.view.view?.cwd !== snapshot.cwd)
            throw new Error('Session changed while authorizing');
          if (message.command.method === 'fork') {
            const entry = message.command.request.entry;
            if (!selected.view.entries.some((row) => row.id === entry))
              throw new Error('Fork entry is not in the committed transcript');
          }
          if (['prompt', 'set_model', 'set_mode'].includes(message.command.method)) {
            // Inspect remains cold. Only an explicit authorized user mutation loads a peer.
            await this.execute({ method: 'load', session: selected.id });
            this.assertAuthorization(token);
            if (this.closed || this.selected !== selected)
              throw new Error('Session selection changed during load');
            if (this.closed || !this.ports.trusted() || this.ports.workspace() !== token.workspace)
              throw new Error('Workspace trust changed');
          }
          this.assertAuthorization(token);
          const undoTurn =
            message.command.method === 'undo_turn' ? message.command.turn : undefined;
          if (undoTurn) {
            if (!selected.view.entries.some((row) => row.turn === undoTurn))
              throw new Error('Turn is not in confirmed history');
            if (snapshot.active_turn)
              throw new Error('Wait for the active task to finish before undo');
            this.undoConfirming = true;
            try {
              await this.client.call({
                method: 'validate_undo',
                session: selected.id,
                turn: undoTurn,
              });
              this.assertAuthorization(token);
              if (!this.ports.confirmUndo || !(await this.ports.confirmUndo(selected.id, undoTurn)))
                break;
              this.assertAuthorization(token);
              if (
                this.closed ||
                this.selected !== selected ||
                !this.ports.trusted() ||
                selected.view.view?.active_turn
              )
                throw new Error(
                  'Workspace trust, task state, or selection changed during confirmation',
                );
              await this.ports.validateUndo?.(selected.id, undoTurn);
              this.assertAuthorization(token);
            } finally {
              this.undoConfirming = false;
            }
          }
          let promptOperation: import('./workbench-protocol').OperationId | undefined;
          const result = await this.execute(message.command, (operation) => {
            promptOperation = operation;
            if (message.command.method === 'prompt')
              this.ports.post({
                type: 'prompt_submitted',
                session: selected.id,
                generation: message.generation,
                operation,
              });
          });
          if (message.command.method === 'manage') await this.refresh();
          if (undoTurn && result && typeof result === 'object' && 'UndoCompleted' in result)
            this.ports.post({
              type: 'undo_result',
              session: selected.id,
              turn: undoTurn,
              report: result.UndoCompleted.report,
            });
          if (message.command.method === 'prompt' && !this.closed) {
            this.ports.post({
              type: 'prompt_accepted',
              session: selected.id,
              prompt: message.command.prompt,
              // Last-mile Pi busy rejection is a turn fact, not an acceptance rollback.
              pi_after_seq: snapshot.harness === 'Pi' ? snapshot.last_entry_seq : undefined,
              generation: message.generation,
              operation: promptOperation!,
            });
          }
          if (
            message.command.method === 'fork' &&
            result &&
            typeof result === 'object' &&
            'Forked' in result
          ) {
            this.upsert(result.Forked.summary);
            if (this.selected === selected) await this.select(result.Forked.summary.id);
          }
          if (message.command.method === 'remove') {
            if (this.selected === selected) await this.ports.saveSelection?.(undefined);
            this.invalidateList();
            this.state.sessions = this.state.sessions.filter(
              (summary) => summary.id !== selected.id,
            );
          }
          break;
        }
        case 'cancel_fork': {
          const workflow = this.workflows.get(message.operation);
          if (!workflow || workflow.command.method !== 'fork')
            throw new Error('Fork workflow is not active');
          const source = workflow.command.session;
          const snapshot = this.state.sessions.find((session) => session.id === source);
          if (!snapshot) throw new Error('Fork source is unavailable');
          const token = await this.authorize(snapshot.cwd);
          this.assertAuthorization(token);
          await this.execute({
            method: 'cancel_fork',
            session: workflow.command.session,
            operation: message.operation,
          });
          break;
        }
        case 'earlier':
        case 'latest': {
          if (this.selected?.id !== message.session) throw new Error('Session selection changed');
          if (message.type === 'earlier') await this.selected.earlier();
          else await this.selected.latest();
          break;
        }
        case 'open_turn_diff': {
          const selected = this.selected;
          if (
            !selected ||
            selected.id !== message.session ||
            !selected.view.entries.some((row) => row.turn === message.turn)
          )
            throw new Error('Turn is not in the confirmed view');
          if (!this.ports.openDiff) throw new Error('Editor diff is unavailable');
          const files: { path: string; before: string; after: string }[] = [];
          let offset = 0;
          let used = 0;
          do {
            const page = await this.client.call({
              method: 'turn_diff',
              session: selected.id,
              turn: message.turn,
              offset,
            });
            for (const [i, file] of page.files.entries()) {
              const index = offset + i;
              if (message.file !== undefined && message.file !== index) continue;
              if (file.omitted && file.omitted !== 'Diff content can be loaded in bounded slices.')
                continue;
              const text: string[] = [];
              for (const after of [false, true]) {
                let position = 0;
                let value = '';
                do {
                  const slice = await this.client.call({
                    method: 'turn_diff_content',
                    session: selected.id,
                    turn: message.turn,
                    file: index,
                    after,
                    offset: position,
                  });
                  used += Buffer.byteLength(slice.bytes);
                  if (used > 4 * 1024 * 1024) throw new Error('Editor diff exceeds 4 MiB budget');
                  value += slice.bytes;
                  if (slice.next_offset == null) break;
                  if (slice.next_offset <= position) throw new Error('Invalid diff cursor');
                  position = slice.next_offset;
                } while (true);
                text.push(value);
              }
              files.push({ path: file.path, before: text[0], after: text[1] });
            }
            if (page.next_offset == null) break;
            if (page.next_offset <= offset || page.next_offset > 5000)
              throw new Error('Invalid diff page');
            offset = page.next_offset;
          } while (true);
          if (this.selected !== selected || this.closed) break;
          if (!files.length)
            throw new Error(
              'No complete text snapshots available; review partial reasons in the card',
            );
          await this.ports.openDiff(message.turn, files);
          break;
        }
        case 'read_turn_diff': {
          const selected = this.selected;
          if (
            !selected ||
            selected.id !== message.session ||
            !selected.view.entries.some((row) => row.turn === message.turn)
          )
            throw new Error('Turn is not in the confirmed view');
          try {
            const diff = await this.client.call({
              method: 'turn_diff',
              session: selected.id,
              turn: message.turn,
              offset: message.offset,
            });
            if (this.selected !== selected || this.closed) break;
            const key = `${selected.id}:${message.turn}`;
            const previous = this.turnDiffCache.get(key);
            const start = message.offset ?? 0;
            if (start > 0 && (!previous || previous.files.length !== start))
              throw new Error('Diff page is out of order');
            const merged =
              start > 0 && previous ? { ...diff, files: [...previous.files, ...diff.files] } : diff;
            if (merged.files.length > 5000) throw new Error('Diff exceeds file budget');
            this.turnDiffCache.set(key, merged);
            while (this.turnDiffCache.size > 16)
              this.turnDiffCache.delete(this.turnDiffCache.keys().next().value!);
            if (this.selected === selected && !this.closed)
              this.ports.post({
                type: 'turn_diff',
                session: selected.id,
                turn: message.turn,
                offset: message.offset,
                diff,
              });
          } catch {
            if (this.selected === selected && !this.closed)
              this.ports.post({
                type: 'turn_diff_error',
                session: selected.id,
                turn: message.turn,
                error: 'Workspace diff unavailable',
              });
          }
          break;
        }
        case 'read_turn_diff_content': {
          const selected = this.selected;
          const diff = this.turnDiffCache.get(`${message.session}:${message.turn}`);
          if (
            !selected ||
            selected.id !== message.session ||
            !selected.view.entries.some((row) => row.turn === message.turn) ||
            !diff ||
            message.file >= diff.files.length
          )
            throw new Error('Diff file is not in the confirmed view');
          try {
            const content = await this.client.call({
              method: 'turn_diff_content',
              session: selected.id,
              turn: message.turn,
              file: message.file,
              after: message.after,
              offset: message.offset,
            });
            if (this.selected === selected && !this.closed)
              this.ports.post({
                type: 'turn_diff_content',
                session: selected.id,
                turn: message.turn,
                file: message.file,
                after: message.after,
                offset: message.offset,
                ...content,
              });
          } catch {
            if (this.selected === selected && !this.closed)
              this.ports.post({
                type: 'turn_diff_error',
                session: selected.id,
                turn: message.turn,
                error: 'Diff content unavailable',
              });
          }
          break;
        }
        case 'read_tools': {
          if (
            this.selected?.id !== message.session ||
            !this.selected.view.entries.some((entry) => entry.turn === message.turn)
          )
            throw new Error('Tool turn not in visible page');
          await this.selected.loadTools(message.turn, message.cursor);
          break;
        }
        case 'read_content': {
          const selected = this.selected;
          if (!selected || selected.id !== message.session)
            throw new Error('Content session selection changed');
          const refs: ContentRef[] = selected.view.entries.flatMap((row) =>
            'Archived' in row.text ? [row.text.Archived.content] : [],
          );
          for (const tool of selected.view.tools)
            for (const body of tool.content) {
              if ('Text' in body) refs.push(body.Text.content);
              if ('ResourceText' in body) refs.push(body.ResourceText.content);
              if ('Diff' in body) {
                if (body.Diff.old_text) refs.push(body.Diff.old_text);
                refs.push(body.Diff.new_text);
              }
            }
          const ref = refs.find(
            (ref) =>
              ref.id === message.ref.id &&
              ref.sha256 === message.ref.sha256 &&
              ref.bytes === message.ref.bytes &&
              ref.kind === message.ref.kind,
          );
          if (!ref) throw new Error('Content reference is not in this confirmed view');
          const request_id = message.request_id ?? ++this.uiRequest;
          try {
            const slice = await this.client.call({
              method: 'content',
              ref,
              offset: message.offset,
            });
            if (slice.sha256 !== ref.sha256 || slice.total_bytes !== ref.bytes)
              throw new Error('Content descriptor mismatch');
            if (this.selected === selected && !this.closed)
              this.ports.post({
                type: 'content',
                session: selected.id,
                request_id,
                ref,
                offset: message.offset,
                slice,
              });
          } catch {
            if (this.selected === selected && !this.closed)
              this.ports.post({
                type: 'content_error',
                session: selected.id,
                request_id,
                ref,
                offset: message.offset,
                error: 'Content archive read failed',
              });
          }
          break;
        }
        case 'read_image': {
          const selected = this.selected;
          if (!selected || selected.id !== message.session)
            throw new Error('Image session selection changed');
          const rows = selected.view.entries;
          const ref = rows.find((row) => row.image?.id === message.image.id)?.image;
          if (
            !ref ||
            ref.bytes !== message.image.bytes ||
            ref.mime !== message.image.mime ||
            ref.sha256 !== message.image.sha256
          )
            throw new Error('Image reference is not in this session view');
          const request_id = message.request_id ?? ++this.uiRequest;
          try {
            const asset = await this.client.call({ method: 'image', image: ref });
            if (this.selected === selected && !this.closed)
              this.ports.post({ type: 'image', session: selected.id, request_id, asset });
          } catch {
            if (this.selected === selected && !this.closed)
              this.ports.post({
                type: 'image_error',
                session: selected.id,
                request_id,
                image: ref.id,
                error: 'Image archive read failed',
              });
          }
          break;
        }
      }
      this.state.error = undefined;
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : 'Workbench action failed';
    }
    this.emit();
  }
  /** One bounded observer-recovery task, never a command replay or provider load. */
  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt++, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, delay);
    this.reconnectTimer.unref();
  }
  private resetReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectAttempt = 0;
  }
  private reconnect(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.reconnectFlight) return this.reconnectFlight;
    const selected = this.selected;
    const task = (async () => {
      try {
        await this.recoverOperations();
        if (this.closed || selected !== this.selected) return;
        if (selected) await selected.refresh();
        else {
          await this.refresh();
          if (this.closed || this.selected) return;
          if (this.restoredSelection) {
            const session = this.restoredSelection;
            this.restoredSelection = undefined;
            await this.select(session);
            if (this.snapshot.view?.status !== 'ready') {
              this.scheduleReconnect();
              return;
            }
          }
        }
        if (selected && !['ready', 'removed'].includes(selected.view.status)) {
          this.scheduleReconnect();
          return;
        }
        this.resetReconnect();
        this.state.error = undefined;
      } catch (error) {
        this.state.error = error instanceof Error ? error.message : 'Cannot reconnect';
        this.scheduleReconnect();
      } finally {
        this.emit();
      }
    })();
    this.reconnectFlight = task;
    void task.finally(() => {
      if (this.reconnectFlight === task) this.reconnectFlight = undefined;
    });
    return task;
  }
  private async authorize(cwd: string) {
    if (!this.ports.trusted()) throw new Error('Workspace trust is required');
    const token = {
      generation: ++this.authorizationGeneration,
      cwd,
      workspace: this.ports.workspace(),
    };
    await this.ports.authorize(cwd);
    this.assertAuthorization(token);
    return token;
  }
  private assertAuthorization(token: {
    generation: number;
    cwd: string;
    workspace: string | undefined;
  }) {
    if (
      this.closed ||
      !this.ports.trusted() ||
      token.generation !== this.authorizationGeneration ||
      token.workspace !== this.ports.workspace()
    )
      throw new Error('Workspace trust changed');
  }
  invalidateAuthorization() {
    this.authorizationGeneration++;
  }
  private invalidateList() {
    this.listRequest++;
    this.listCursor = undefined;
    this.state.sessionsCursor = undefined;
  }
  private upsert(summary: SessionSummary) {
    this.invalidateList();
    this.state.sessions = [summary, ...this.state.sessions.filter((item) => item.id !== summary.id)]
      .sort((a, b) => b.created_seq - a.created_seq)
      .slice(0, 100);
  }
  refresh(cursor?: ListCursor): Promise<void> {
    if (this.listFlight) return this.listFlight;
    const request = ++this.listRequest;
    this.listCursor = cursor;
    const task = (async () => {
      const events = await this.client.call({ method: 'list', cursor: this.listCursor });
      if (!this.closed && request === this.listRequest) {
        this.state.sessions = events.sessions;
        this.state.sessionsCursor = events.next_cursor ?? undefined;
        this.emit();
      }
    })();
    this.listFlight = task;
    void task
      .finally(() => {
        if (this.listFlight === task) this.listFlight = undefined;
      })
      .catch(() => {});
    return task;
  }
  private async select(session: SessionId) {
    if (this.selecting) throw new Error('Another session selection is in progress');
    this.selecting = true;
    const generation = ++this.selection;
    try {
      const previous = this.selected;
      this.selected = undefined;
      this.turnDiffCache.clear();
      this.emit();
      if (previous) await previous.stop();
      if (this.closed || generation !== this.selection) return;
      // Cold inspection is display-only and does not load a provider.
      const view = new WorkbenchSession(this.client, session);
      this.selected = view;
      view.observe((snapshot) => {
        if (this.selected !== view) return;
        if (snapshot.status === 'stale' || snapshot.status === 'disconnected')
          this.scheduleReconnect();
        this.emit();
      });
      await view.start();
      if (!this.closed && this.selected === view && view.view.view) {
        await this.ports.saveSelection?.(session);
        if (view.view.status === 'ready') this.resetReconnect();
      }
    } finally {
      this.selecting = false;
      this.emit();
    }
  }
  private persistOperations() {
    const saved = this.operations.map((row) => ({ ...row }));
    const task = this.persistence.catch(() => {}).then(() => this.ports.saveOperations?.(saved));
    this.persistence = task;
    return task;
  }
  private recoverOperations(): Promise<void> {
    if (this.recoveryFlight) return this.recoveryFlight;
    const task = this.queryOperations();
    this.recoveryFlight = task;
    void task
      .finally(() => {
        if (this.recoveryFlight === task) this.recoveryFlight = undefined;
      })
      .catch(() => {});
    return task;
  }
  private async queryOperations() {
    for (const row of this.operations) {
      if (!['pending', 'uncertain'].includes(row.status) || this.workflows.has(row.operation))
        continue;
      const result = await this.client.call(
        { method: 'operation', operation: row.operation },
        { timeoutMs: 10_000 },
      );
      if (this.closed) return;
      row.status =
        result.status === 'completed'
          ? 'completed'
          : result.status === 'failed' || result.status === 'expired'
            ? 'failed'
            : 'uncertain';
      row.code = result.status;
      row.error =
        result.status === 'failed'
          ? result.message
          : result.status === 'unknown'
            ? 'No durable receipt found. No request was resent.'
            : result.status === 'uncertain'
              ? 'Acceptance or external outcome is uncertain. Inspect the session; no request was resent.'
              : result.status === 'expired'
                ? 'Receipt expired; this operation cannot execute again.'
                : undefined;
    }
    await this.persistOperations();
  }
  private async execute(
    command: ClientCommand,
    admitted?: (operation: import('./workbench-protocol').OperationId) => void,
  ) {
    if (!durableCommand(command)) throw new Error('Expected a mutation');
    // Bound both retained receipt display and concurrent long-running workflows.
    if (this.operations.filter((row) => row.status === 'pending').length >= 16)
      throw new Error('Too many UI workflows are active');
    const unresolved = this.operations.filter((row) =>
      ['pending', 'uncertain'].includes(row.status),
    );
    const control = ['cancel', 'answer', 'remove', 'cancel_fork'].includes(command.method);
    if (unresolved.length >= (control ? 64 : 48))
      throw new Error('Resolve uncertain operation receipts before starting more workflows');
    const operation = operationId.parse(randomUUID());
    admitted?.(operation);
    const row: UiOperation = {
      operation,
      method: command.method,
      ...('session' in command ? { session: command.session } : {}),
      status: 'pending',
    };
    const terminal = this.operations.filter(
      (row) => !['pending', 'uncertain'].includes(row.status),
    );
    const terminalSlots = Math.min(47, 63 - unresolved.length);
    this.operations = [
      ...unresolved,
      ...(terminalSlots ? terminal.slice(-terminalSlots) : []),
      row,
    ];
    this.emit();
    try {
      // Persist only a handle before bytes can leave this process, never a
      // command body. Reload may query this identity but cannot replay it.
      await this.persistOperations();
      if (this.closed) throw new Error('Workbench view closed before dispatch');
      const ticket = this.client.request(command, { operation });
      this.workflows.set(operation, { command, ticket });
      const result = await ticket.result;
      row.status = 'completed';
      return result;
    } catch (error) {
      row.status =
        error instanceof WorkbenchError && error.sideEffectPossible ? 'uncertain' : 'failed';
      row.error = error instanceof Error ? error.message : 'Operation failed';
      if (error instanceof WorkbenchError) row.code = error.code;
      throw error;
    } finally {
      this.workflows.delete(operation);
      await this.persistOperations();
      this.emit();
    }
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.selection++;
    this.listRequest++;
    this.authorizationGeneration++;
    clearTimeout(this.emitTimer);
    this.resetReconnect();
    this.unobserve();
    void this.selected?.stop();
    this.selected = undefined;
    this.turnDiffCache.clear();
    // Drop observers, not host operations. No implicit cancel/remove/retry.
    this.client.dispose();
  }
}
