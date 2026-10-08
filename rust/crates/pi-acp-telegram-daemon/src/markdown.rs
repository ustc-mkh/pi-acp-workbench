//! CommonMark to Telegram text/entities. Never interpret raw HTML as Telegram markup.
//! Entity offsets and chunk boundaries use UTF-16 units (Bot API MessageEntity).
use pi_acp_core::utf16::telegram_chunks;
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Entity {
    #[serde(rename = "type")]
    kind: String,
    offset: usize,
    length: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct RichText {
    pub text: String,
    pub entities: Vec<Entity>,
}
fn entity(kind: &str, offset: usize) -> Entity {
    Entity {
        kind: kind.into(),
        offset,
        length: 0,
        url: None,
        language: None,
    }
}
fn newline(text: &mut String) {
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
}
fn safe_url(url: &str) -> bool {
    ["https://", "http://", "mailto:", "tg://"]
        .iter()
        .any(|prefix| url.to_ascii_lowercase().starts_with(prefix))
}
pub fn render(source: &str) -> RichText {
    let mut result = RichText {
        text: String::new(),
        entities: Vec::new(),
    };
    let mut stack: Vec<(TagEnd, Option<Entity>)> = Vec::new();
    let mut lists: Vec<Option<u64>> = Vec::new();
    let mut offset = 0;
    for event in Parser::new_ext(
        source,
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS,
    ) {
        let before = result.text.len();
        let event_offset = offset;
        match event {
            Event::Start(tag) => {
                if matches!(
                    tag,
                    Tag::Paragraph
                        | Tag::Heading { .. }
                        | Tag::CodeBlock(_)
                        | Tag::BlockQuote(_)
                        | Tag::Item
                ) {
                    newline(&mut result.text);
                }
                match &tag {
                    Tag::List(number) => lists.push(*number),
                    Tag::Item => {
                        let indent = "  ".repeat(lists.len().saturating_sub(1));
                        result.text.push_str(&indent);
                        if let Some(Some(number)) = lists.last_mut() {
                            result.text.push_str(&format!("{number}. "));
                            *number += 1;
                        } else {
                            result.text.push_str("• ");
                        }
                    }
                    _ => {}
                }
                offset = event_offset + result.text[before..].encode_utf16().count();
                let mark = match &tag {
                    Tag::Strong | Tag::Heading { .. } => Some(entity("bold", offset)),
                    Tag::Emphasis => Some(entity("italic", offset)),
                    Tag::Strikethrough => Some(entity("strikethrough", offset)),
                    Tag::BlockQuote(_)
                        if !stack
                            .iter()
                            .any(|(_, m)| m.as_ref().is_some_and(|m| m.kind == "blockquote")) =>
                    {
                        Some(entity("blockquote", offset))
                    }
                    Tag::CodeBlock(kind) => {
                        let mut mark = entity("pre", offset);
                        if let CodeBlockKind::Fenced(language) = kind {
                            let language = language.split_whitespace().next().unwrap_or("");
                            if !language.is_empty() {
                                mark.language = Some(language.into());
                            }
                        }
                        Some(mark)
                    }
                    Tag::Link { dest_url, .. } if safe_url(dest_url) => {
                        let mut mark = entity("text_link", offset);
                        mark.url = Some(dest_url.to_string());
                        Some(mark)
                    }
                    _ => None,
                };
                stack.push((tag.to_end(), mark));
            }
            Event::End(end) => {
                if let Some((_, Some(mut mark))) = stack.pop() {
                    mark.length = offset.saturating_sub(mark.offset);
                    if mark.length > 0 {
                        result.entities.push(mark);
                    }
                }
                if matches!(end, TagEnd::List(_)) {
                    lists.pop();
                }
                if matches!(
                    end,
                    TagEnd::Paragraph
                        | TagEnd::Heading(_)
                        | TagEnd::CodeBlock
                        | TagEnd::BlockQuote(_)
                        | TagEnd::Item
                ) {
                    newline(&mut result.text);
                }
            }
            Event::Text(text) | Event::Html(text) | Event::InlineHtml(text) => {
                result.text.push_str(&text)
            }
            Event::Code(text) => {
                let mut mark = entity("code", offset);
                mark.length = text.encode_utf16().count();
                result.text.push_str(&text);
                if mark.length > 0 {
                    result.entities.push(mark);
                }
            }
            Event::SoftBreak | Event::HardBreak => result.text.push('\n'),
            Event::Rule => {
                newline(&mut result.text);
                result.text.push_str("───\n");
            }
            Event::TaskListMarker(checked) => {
                result.text.push_str(if checked { "☑ " } else { "☐ " })
            }
            _ => {}
        }
        offset = event_offset + result.text[before..].encode_utf16().count();
    }
    // Keep source trailing newlines only when present, but avoid parser-added
    // trailing paragraph separators on otherwise plain text.
    if !source.ends_with('\n') {
        result
            .text
            .truncate(result.text.trim_end_matches('\n').len());
    }
    let size = result.text.encode_utf16().count();
    let protected: Vec<_> = result
        .entities
        .iter()
        .filter(|e| matches!(e.kind.as_str(), "pre" | "code"))
        .map(|e| (e.offset, e.offset + e.length))
        .collect();
    let mut entities = Vec::new();
    for mut mark in result.entities {
        mark.length = mark.length.min(size.saturating_sub(mark.offset));
        let mut ranges = vec![(mark.offset, mark.offset + mark.length)];
        if !matches!(mark.kind.as_str(), "pre" | "code") {
            for &(start, end) in &protected {
                ranges = ranges
                    .into_iter()
                    .flat_map(|(a, b)| {
                        if end <= a || start >= b {
                            vec![(a, b)]
                        } else {
                            [(a, start.min(b)), (end.max(a), b)]
                                .into_iter()
                                .filter(|(a, b)| a < b)
                                .collect()
                        }
                    })
                    .collect();
            }
        }
        for (start, end) in ranges {
            if start < end {
                let mut part = mark.clone();
                part.offset = start;
                part.length = end - start;
                entities.push(part);
            }
        }
    }
    entities.sort_by_key(|e| (e.offset, std::cmp::Reverse(e.length)));
    result.entities = entities;
    result
}
pub fn chunks(source: &str) -> Vec<RichText> {
    let rendered = render(source);
    let mut start = 0;
    telegram_chunks(&rendered.text, 3900)
        .into_iter()
        .map(|text| {
            let end = start + text.encode_utf16().count();
            let entities = rendered
                .entities
                .iter()
                .filter_map(|mark| {
                    let a = mark.offset.max(start);
                    let b = (mark.offset + mark.length).min(end);
                    if a >= b {
                        return None;
                    }
                    let mut part = mark.clone();
                    part.offset = a - start;
                    part.length = b - a;
                    Some(part)
                })
                .collect();
            start = end;
            RichText { text, entities }
        })
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn formats_commonmark_and_never_interprets_html_or_unsafe_links() {
        let text = render("# 标题\n\n😀 **粗 _斜_** ~~删~~ `x<y` [链接](https://example.com?q=a&b=c) [坏](javascript:alert)\n\n<script>evil</script>\n");
        assert!(text.text.contains("😀 粗 斜 删 x<y 链接 坏"));
        assert!(text.text.contains("<script>evil</script>"));
        assert!(text
            .entities
            .iter()
            .any(|e| e.kind == "bold" && e.offset == 0));
        assert!(text.entities.iter().any(|e| e.kind == "text_link"));
        assert!(!text.entities.iter().any(|e| e
            .url
            .as_deref()
            .is_some_and(|url| url.starts_with("javascript:"))));
        for e in &text.entities {
            assert!(e.offset + e.length <= text.text.encode_utf16().count());
        }
    }
    #[test]
    fn splits_long_code_and_emoji_without_losing_entities_or_content() {
        let code = "😀<>&\n".repeat(1800);
        let parts = chunks(&format!("```rs\n{code}```"));
        assert_eq!(
            parts.iter().map(|p| p.text.as_str()).collect::<String>(),
            code.trim_end_matches('\n')
        );
        for part in parts {
            assert!(part.text.encode_utf16().count() <= 3900);
            assert_eq!(part.entities[0].kind, "pre");
            assert_eq!(part.entities[0].offset, 0);
            assert_eq!(part.entities[0].length, part.text.encode_utf16().count());
        }
    }
    #[test]
    fn incomplete_streaming_markdown_is_safe_and_code_never_overlaps_bold() {
        assert!(render("**unfinished").text.contains("unfinished"));
        let text = render("**before `code` after**");
        let code = text.entities.iter().find(|e| e.kind == "code").unwrap();
        assert!(text
            .entities
            .iter()
            .filter(|e| e.kind == "bold")
            .all(|e| e.offset + e.length <= code.offset || e.offset >= code.offset + code.length));
    }
}
