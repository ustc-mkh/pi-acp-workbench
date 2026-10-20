import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  commandReceipt,
  commitBatch,
  contentRef,
  entryHeader,
  historyCursor,
  historyPage,
  INLINE_TEXT_BYTES,
  jsonBytes,
  checkJsonBudget,
  MAX_CONTENT_BYTES,
  MAX_QUERY_BYTES,
  MAX_VIEW_BYTES,
  queryLimit,
  queryRequest,
  queryCommand,
  sessionSummary,
  sessionView,
  typedPrompt,
  textBody,
  toolHeader,
} from '../src/workbench-protocol';

const fixture = () =>
  JSON.parse(readFileSync(new URL('./fixtures/rewrite/ipc-v3.json', import.meta.url), 'utf8'));

describe('IPC v3 fixed contracts (not yet the production transport)', () => {
  it('bounds typed context identities/scalars and actual provider select catalogues independently', () => {
    const context = { type: 'context', id: 'selection', name: 'src/a.ts:1', text: 'chosen' };
    expect(
      typedPrompt.parse({ parts: [{ type: 'text', text: '中🌏'.repeat(50000) }] }).parts,
    ).toHaveLength(1);
    for (const prompt of [
      'old string',
      { parts: [{ type: 'text', text: '🌏'.repeat(100001) }] },
      { parts: [context, context] },
      { parts: [{ ...context, text: '中'.repeat(21846) }] },
    ])
      expect(() => typedPrompt.parse(prompt)).toThrow();
    const setting = {
      id: 'thought_level',
      name: 'Thinking',
      category: 'thought_level',
      current_value: 'low',
      choices: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    };
    const view = fixture().view;
    expect(
      sessionView.parse({ ...view, catalogue: { ...view.catalogue, selects: [setting] } }).catalogue
        .selects,
    ).toEqual([setting]);
    for (const selects of [
      [setting, setting],
      [{ ...setting, current_value: 'invented' }],
      Array.from({ length: 33 }, (_, i) => ({ ...setting, id: `setting-${i}` })),
    ])
      expect(() =>
        sessionView.parse({ ...view, catalogue: { ...view.catalogue, selects } }),
      ).toThrow();
  });
  it('shares Rust DTO fixture, no history in list/view/receipts and large rows use refs', () => {
    const f = fixture();
    const summary = sessionSummary.parse(f.summary);
    const view = sessionView.parse(f.view);
    const entries = f.entries.map((v: unknown) => entryHeader.parse(v));
    const tools = f.tools.map((v: unknown) => toolHeader.parse(v));
    for (const r of [...f.receipts, { Loaded: { view } }]) {
      expect(JSON.stringify(commandReceipt.parse(r))).not.toContain('transcript');
    }
    expect(JSON.stringify(summary)).not.toContain('catalogue');
    expect(JSON.stringify(view)).not.toContain('transcript');
    expect(jsonBytes(entries[1])).toBeLessThan(1024);
    expect(
      commitBatch.parse({
        session: summary.id,
        revision: view.revision,
        view,
        entries,
        tools,
        removed: false,
      }).entries,
    ).toHaveLength(2);
  });
  it('counts UTF-8 and escaped JSON bytes, including full envelope overhead', () => {
    const text = '中🌏\n"\\\u0000'.repeat(100);
    const value = { text };
    const exact = Buffer.byteLength(JSON.stringify(value));
    expect(jsonBytes(value)).toBe(exact);
    expect(exact).toBeGreaterThan(Buffer.byteLength(text));
    expect(checkJsonBudget(value, exact)).toBe(value);
    expect(() => checkJsonBudget(value, exact - 1)).toThrow();
    const inline = '🌏'.repeat(INLINE_TEXT_BYTES / 4);
    expect(textBody.parse({ Inline: { text: inline } })).toBeDefined();
    expect(() => textBody.parse({ Inline: { text: inline + '中' } })).toThrow();
  });
  it('rejects invalid refs, paths, URLs, forged fields, unknown kinds and byte overflow', () => {
    const ref = fixture().entries[1].text.Archived.content;
    expect(contentRef.parse(ref).bytes).toBe(MAX_CONTENT_BYTES);
    for (const patch of [
      { id: '/etc/passwd' },
      { id: 'https://example.com' },
      { path: '/tmp/file' },
      { sha256: 'a'.repeat(63) },
      { sha256: 'A'.repeat(64) },
      { kind: 'Path' },
      { bytes: MAX_CONTENT_BYTES + 1 },
      { bytes: -1 },
      { bytes: 0.5 },
    ])
      expect(() => contentRef.parse({ ...ref, ...patch })).toThrow();
    expect(() => textBody.parse({ Archived: { content: { ...ref, kind: 'ToolDiff' } } })).toThrow();
    expect(() =>
      toolHeader.parse({ ...fixture().tools[0], content: [{ Text: { content: ref } }] }),
    ).toThrow();
  });
  it('requires safe nonnegative seq/revision and rejects version 2 cursors', () => {
    for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => sessionSummary.parse({ ...fixture().summary, revision: bad })).toThrow();
      expect(() => entryHeader.parse({ ...fixture().entries[0], seq: bad })).toThrow();
    }
    expect(
      sessionSummary.parse({ ...fixture().summary, revision: Number.MAX_SAFE_INTEGER }).revision,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(() =>
      historyCursor.parse({ version: 2, session: 'session-1', before_seq: 1, max_entry_seq: 2 }),
    ).toThrow();
    expect(() =>
      queryRequest.parse({
        version: 2,
        id: 1,
        command: { method: 'inspect', session: 'session-1' },
      }),
    ).toThrow();
    expect(
      queryRequest.parse({
        version: 3,
        id: 1,
        command: { method: 'inspect', session: 'session-1' },
      }),
    ).toBeDefined();
    expect(queryLimit(undefined, 50, 100)).toBe(50);
    for (const n of [0, -1, 101, 1.5]) expect(() => queryLimit(n, 50, 100)).toThrow();
  });
  it('rejects oversized view/metadata/batch and identity mismatches without truncation', () => {
    const f = fixture();
    const huge = structuredClone(f.view);
    huge.catalogue.commands.push({
      name: 'large',
      description: '中'.repeat(MAX_VIEW_BYTES),
      input_hint: null,
    });
    expect(() => sessionView.parse(huge)).toThrow();
    expect(() =>
      toolHeader.parse({ ...f.tools[0], title: '\\'.repeat(MAX_QUERY_BYTES) }),
    ).toThrow();
    const batch = {
      session: 'session-1',
      revision: 7,
      view: f.view,
      entries: f.entries,
      tools: f.tools,
      removed: false,
    };
    expect(() => commitBatch.parse({ ...batch, revision: 8 })).toThrow();
    expect(() => commitBatch.parse({ ...batch, removed: true })).toThrow();
    const row = { ...f.entries[0], text: { Inline: { text: '\\'.repeat(INLINE_TEXT_BYTES) } } };
    const entries = Array.from({ length: 100 }, (_, i) => ({
      ...row,
      seq: i + 1,
      id: `entry-${i}`,
    }));
    expect(() => historyPage.parse({ entries, next_cursor: null })).toThrow();
  });
  it('binds cursors to session/turn and validates slice/SQL limits', () => {
    for (const value of [
      { method: 'list', limit: 101 },
      { method: 'list', cursor: { version: 3, max_created_seq: 10, before_seq: 11 } },
      {
        method: 'history',
        session: 's',
        cursor: { version: 3, session: 'other', max_entry_seq: 10, before_seq: 5 },
      },
      { method: 'history', session: 's', limit: 201 },
      {
        method: 'tools',
        session: 's',
        turn: 't',
        cursor: { version: 3, session: 's', turn: 'other', after_tool: 'tool' },
      },
      {
        method: 'content',
        ref: fixture().entries[1].text.Archived.content,
        offset: MAX_CONTENT_BYTES + 1,
      },
      {
        method: 'content',
        ref: fixture().entries[1].text.Archived.content,
        offset: 0,
        length: 65537,
      },
    ])
      expect(() => queryCommand.parse(value)).toThrow();
  });
  it('retains the pending interaction count and key identity boundary', () => {
    const interaction = {
      id: 'i-1',
      kind: 'Permission',
      title: 'Allow?',
      detail: '',
      fields: [],
      options: [{ id: 'yes', label: 'Yes' }],
      expires_at: null,
    };
    expect(() =>
      sessionView.parse({ ...fixture().view, pending_interactions: { wrong: interaction } }),
    ).toThrow();
    const items = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`i-${i}`, { ...interaction, id: `i-${i}` }]),
    );
    expect(() => sessionView.parse({ ...fixture().view, pending_interactions: items })).toThrow();
  });
});
