import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  composePrompt,
  type TextAttachment,
} from '../src/workbench-input';
const MAX_SESSIONS = 16;
const MAX_TOTAL_CHARS = 128000;
export class AttachmentDrafts {
  private values = new Map<string, TextAttachment[]>();
  constructor(saved?: unknown) {
    if (
      !saved ||
      typeof saved !== 'object' ||
      !('attachments' in saved) ||
      !Array.isArray(saved.attachments)
    )
      return;
    for (const row of saved.attachments.slice(-MAX_SESSIONS)) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string') continue;
      try {
        this.set(row[0], row[1]);
      } catch {
        /* Ignore invalid local preferences. */
      }
    }
  }
  get(session: string): TextAttachment[] {
    return this.values.get(session)?.map((file) => ({ ...file })) ?? [];
  }
  set(session: string, files: unknown) {
    if (session.length > 256 || !Array.isArray(files) || files.length > MAX_ATTACHMENTS)
      throw new Error('Too many attached files');
    const seen = new Set<string>();
    const valid: TextAttachment[] = [];
    for (const file of files) {
      if (
        !file ||
        typeof file !== 'object' ||
        typeof file.id !== 'string' ||
        file.id.length === 0 ||
        file.id.length > 200 ||
        seen.has(file.id) ||
        typeof file.name !== 'string' ||
        file.name.length > 4096 ||
        typeof file.text !== 'string' ||
        file.text.includes('\0') ||
        new TextEncoder().encode(file.text).length > MAX_ATTACHMENT_BYTES
      )
        throw new Error('Invalid text attachment');
      seen.add(file.id);
      valid.push({ id: file.id, name: file.name, text: file.text });
    }
    if (valid.length) composePrompt('', valid);
    const total =
      [...this.values].reduce(
        (n, [key, rows]) =>
          n +
          (key === session
            ? 0
            : rows.reduce((sum, file) => sum + file.text.length + file.name.length, 0)),
        0,
      ) + valid.reduce((n, file) => n + file.text.length + file.name.length, 0);
    if (
      total > MAX_TOTAL_CHARS ||
      (!this.values.has(session) && valid.length && this.values.size >= MAX_SESSIONS)
    )
      throw new Error('Attachment draft storage budget reached; remove an attachment first');
    this.values.delete(session);
    if (valid.length) this.values.set(session, valid);
  }
  snapshot() {
    return {
      attachments: [...this.values].map(([key, rows]) => [key, rows.map((file) => ({ ...file }))]),
    };
  }
}
