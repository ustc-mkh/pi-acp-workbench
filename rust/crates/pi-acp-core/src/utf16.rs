//! UTF-16 code-unit semantics — JavaScript `String.length`/`slice` count UTF-16
//! units, not Unicode scalars or bytes. Telegram chunking must split exactly like
//! the reference implementation or long messages diverge between daemons.

/// Split like telegramChunks(): chunks of at most `limit` UTF-16 units that never
/// cut a surrogate pair (a Rust char boundary is always surrogate-safe).
pub fn telegram_chunks(text: &str, limit: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut cur = String::new();
    let mut used = 0usize;
    for ch in text.chars() {
        let w = ch.len_utf16();
        if used + w > limit && !cur.is_empty() {
            chunks.push(std::mem::take(&mut cur));
            used = 0;
        }
        cur.push(ch);
        used += w;
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }
    chunks
}

/// `text.slice(-limit)` in UTF-16 units without ever starting on a lone low surrogate.
pub fn utf16_tail(text: &str, limit: usize) -> String {
    let mut used = 0usize;
    let mut start = text.len();
    for (i, ch) in text.char_indices().rev() {
        let w = ch.len_utf16();
        if used + w > limit {
            break;
        }
        used += w;
        start = i;
    }
    text[start..].to_string()
}

/// JS `.slice(0, limit)` — first `limit` UTF-16 units on char boundaries.
pub fn utf16_head(text: &str, limit: usize) -> String {
    let mut used = 0usize;
    let mut end = 0usize;
    for (i, ch) in text.char_indices() {
        let w = ch.len_utf16();
        if used + w > limit {
            break;
        }
        used += w;
        end = i + ch.len_utf8();
    }
    text[..end].to_string()
}
