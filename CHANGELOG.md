# Changelog

## 0.2.1

- Remove the Pi-reported cost column from statistics.
- Move pricing to a dedicated page with a four-field card for every configured model, including unused models.
- Cache up to two idle ACP connections in memory (32 MiB retained-record budget) for warm conversation switching; release on disposal, eviction, history removal or transport configuration changes.
- Support clipboard raster images with previews, removal, image-only messages, validated ACP image transport and local history persistence.
- Reject stale or oversized image pastes and keep drafts when the agent does not support image input.

## 0.2.0

- Bundle an enhanced, pinned Pi ACP adapter with negotiated usage and bounded-summary extension methods.
- Reuse valid native compaction checkpoints; invalidate affected summaries after edits and rebuild long retained histories in bounded, cancellable chunks.
- Persist full local conversation files without the former 2 MB snapshot truncation; copy the complete original Markdown independently of compaction.
- Render closed Mermaid fences locally with theme-aware SVG, source fallback and sanitization.
- Add model/day/conversation token and cost statistics, cache hit ratios, deduplicated native request usage, and editable USD per-million-token price presets.
- Preserve billed usage across message deletion; do not rebill inherited history when branching.

## 0.1.5

- Move history deletion to the right, use more compact rows with slightly larger text, and remove status indicator tooltips.
- Add copy, branch and delete actions to user/assistant messages and tool records.
- Reconstruct edited context in fresh ACP sessions, preserving retained history, text attachments and model/thinking configuration; send it with the next ordinary prompt.
- Discard stale compaction summaries after editing; preserve complete local transcripts when loading compacted sessions.
- Persist pending reconstruction, recover ambiguous send failures in a fresh session, and keep the original usable if preparing a replacement fails.
- Reject incomplete or unsupported history rather than silently changing only the display; serialize context edits with generation and connection changes.

## 0.1.4

- Unify hover and keyboard-focus descriptions in immediate, theme-aware tooltips.
- Add per-session history deletion without interrupting a running turn or restoring deleted records on save.
- Compact history spacing and limit the visible list to four scrollable rows.
- Show a spinning ring for active output and a static chat icon for other sessions; preserve list nodes and scroll position during streaming.

## 0.1.3

- Show context usage immediately in a theme-aware tooltip, without a help cursor.
- Center a circular scroll-to-latest button at the bottom of the message area.
- Connect automatically when the chat opens; show manual reconnect after failure.
- Add a dismiss button to error banners without hiding subsequent errors.

## 0.1.2

- Move model/thinking controls and a context usage ring into the composer.
- Show a short model name when collapsed and the full provider/model names in the native menu.
- Show token usage in k/k on ring hover; remove the footer advisory.
- Deduplicate reasoning controls across providers, including stale legacy modes after model switches.

## 0.1.1

- Remove sender labels and the connected status row to give messages more space.
- Remove login and log buttons from chat; keep the command palette actions.
- Show one thinking selector when Pi exposes the same levels via both modes and config options.
- Display concise thinking levels such as `low`, preserving the original ACP option values.

## 0.1.0

- ACP v1 stdio client with capability negotiation, streamed content, cancellation, permission requests and local session history.
- Sidebar chat, editor context attachments, session mode/configuration selectors, slash commands, tool cards and VS Code diff previews.
- Offline Markdown rendering with KaTeX, MathML, chemistry, code highlighting, tables, tasks and footnotes.
- Workspace Trust, strict Webview CSP, HTML sanitization and subprocess lifecycle management.
