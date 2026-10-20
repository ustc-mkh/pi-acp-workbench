import type { EntryHeader } from './workbench-protocol';

/** Only adjacent, provider-identified text fragments belong to one message.
 * Images, missing identities, role/turn changes and gaps are hard boundaries. */
export function continuesMessage(a: EntryHeader, b: EntryHeader): boolean {
  return (
    !!a.message &&
    a.message === b.message &&
    a.turn === b.turn &&
    a.role === b.role &&
    a.seq + 1 === b.seq &&
    !a.image &&
    !b.image
  );
}
type Message = { key: string; row: EntryHeader; entries: EntryHeader[]; inlineText?: string };
export class MessageProjection {
  private messages: Message[] = [];
  private count = 0;
  private first?: string;
  private last?: string;
  update(entries: readonly EntryHeader[]) {
    // Entries are immutable. A shifted window/history prepend starts a new view;
    // normal deltas append only new fragments, rather than rejoining all text.
    let retained: Map<string, string> | undefined;
    if (
      !this.count ||
      entries.length < this.count ||
      entries[0]?.id !== this.first ||
      entries[this.count - 1]?.id !== this.last
    ) {
      retained = new Map(
        this.messages.flatMap((message) => message.entries.map((entry) => [entry.id, message.key])),
      );
      this.messages = [];
      this.count = 0;
    }
    for (let i = this.count; i < entries.length; i++) {
      const entry = entries[i],
        previous = this.messages.at(-1);
      if (previous && continuesMessage(previous.entries.at(-1)!, entry)) {
        previous.entries.push(entry);
        previous.key = retained?.get(entry.id) || previous.key;
        previous.inlineText =
          previous.inlineText !== undefined && 'Inline' in entry.text
            ? previous.inlineText + entry.text.Inline.text
            : undefined;
      } else
        this.messages.push({
          key: retained?.get(entry.id) || entry.id,
          row: entry,
          entries: [entry],
          inlineText: 'Inline' in entry.text ? entry.text.Inline.text : undefined,
        });
    }
    this.count = entries.length;
    this.first = entries[0]?.id;
    this.last = entries.at(-1)?.id;
    return this.messages;
  }
}
export function projectMessages(entries: readonly EntryHeader[]) {
  return new MessageProjection().update(entries);
}

/** Validate at the host boundary too; WHATWG URL serializes IDNs as punycode. */
export function externalDestination(value: string): string {
  if (value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value))
    throw new Error('Invalid external destination');
  const url = new URL(value);
  if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only credential-free HTTP(S) and mailto links may be opened');
  return url.href;
}
