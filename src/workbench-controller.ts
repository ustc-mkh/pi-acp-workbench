import { WorkbenchClient, WorkbenchError, type RequestTicket } from './workbench-client';
import { WorkbenchSession } from './workbench-session';
import {
  durableCommand,
  type ClientCommand,
  type OperationId,
  type SessionId,
  type SessionSummary,
  type ContentRef,
  type ListCursor,
} from './workbench-protocol';
import {
  uiCommand,
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
}
/** UI owns only selection/display/workflow observers. The Rust actor owns all domain state. */
export class WorkbenchController {
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
  private workflows = new Map<
    OperationId,
    { command: ClientCommand; ticket: RequestTicket<ClientCommand> }
  >();
  private state: WorkbenchUiState = { sessions: [], operations: [], trusted: false };
  private unobserve: () => void;
  private selecting = false;
  constructor(
    readonly client: WorkbenchClient,
    private ports: WorkbenchPorts,
  ) {
    this.unobserve = client.observe({
      lost: () => {
        this.state.error =
          'Workbench connection lost. No request was resent. Explicitly select a session to reconnect.';
        this.emit();
      },
    });
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
      switch (message.type) {
        case 'ready':
        case 'refresh':
          await this.refresh(message.type === 'refresh' ? message.cursor : undefined);
          if (this.selected?.view.status !== 'disconnected') await this.selected?.refresh();
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
            !['prompt', 'cancel', 'answer', 'fork', 'set_model', 'set_mode', 'remove'].includes(
              message.command.method,
            )
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
          const result = await this.execute(message.command);
          if (message.command.method === 'prompt' && this.selected === selected && !this.closed) {
            this.ports.post({
              type: 'prompt_accepted',
              session: selected.id,
              text: message.command.prompt,
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
      this.emit();
      if (previous) await previous.stop();
      if (this.closed || generation !== this.selection) return;
      // Cold inspection is display-only and does not load a provider.
      const view = new WorkbenchSession(this.client, session);
      this.selected = view;
      view.observe(() => this.emit());
      await view.start();
    } finally {
      this.selecting = false;
      this.emit();
    }
  }
  private async execute(command: ClientCommand) {
    if (!durableCommand(command)) throw new Error('Expected a mutation');
    // Bound both retained receipt display and concurrent long-running workflows.
    if (this.workflows.size >= 16) throw new Error('Too many UI workflows are active');
    const ticket = this.client.request(command);
    const operation = ticket.operation!;
    const row: UiOperation = {
      operation,
      method: command.method,
      ...('session' in command ? { session: command.session } : {}),
      status: 'pending',
    };
    this.operations = [
      ...this.operations.filter((row) => row.status === 'pending'),
      ...this.operations.filter((row) => row.status !== 'pending').slice(-47),
      row,
    ];
    this.workflows.set(operation, { command, ticket });
    this.emit();
    try {
      const result = await ticket.result;
      row.status = 'completed';
      return result;
    } catch (error) {
      row.status = 'failed';
      row.error = error instanceof Error ? error.message : 'Operation failed';
      if (error instanceof WorkbenchError) row.code = error.code;
      throw error;
    } finally {
      this.workflows.delete(operation);
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
    this.unobserve();
    void this.selected?.stop();
    this.selected = undefined;
    // Drop observers, not host operations. No implicit cancel/remove/retry.
    this.client.dispose();
  }
}
