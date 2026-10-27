use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

/// Convert CommonMark to Telegram's supported HTML subset. Raw HTML is
/// always escaped, and only HTTP(S)/mailto links become clickable entities.
pub(super) fn to_telegram_html(input: &str) -> String {
    let normalized = expand_tables(input);
    let input = normalized.as_str();
    let mut output = String::with_capacity(input.len());
    let mut links = Vec::new();
    let mut lists: Vec<Option<u64>> = Vec::new();
    for event in Parser::new_ext(input, Options::ENABLE_STRIKETHROUGH) {
        match event {
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph) => output.push('\n'),
            Event::Start(Tag::Heading { .. }) => output.push_str("<b>"),
            Event::End(TagEnd::Heading(_)) => output.push_str("</b>\n"),
            Event::Start(Tag::Strong) => output.push_str("<b>"),
            Event::End(TagEnd::Strong) => output.push_str("</b>"),
            Event::Start(Tag::Emphasis) => output.push_str("<i>"),
            Event::End(TagEnd::Emphasis) => output.push_str("</i>"),
            Event::Start(Tag::Strikethrough) => output.push_str("<s>"),
            Event::End(TagEnd::Strikethrough) => output.push_str("</s>"),
            Event::Start(Tag::CodeBlock(_)) => output.push_str("<pre>"),
            Event::End(TagEnd::CodeBlock) => output.push_str("</pre>\n"),
            Event::Code(text) => {
                output.push_str("<code>");
                escape(&mut output, &text);
                output.push_str("</code>");
            }
            Event::Start(Tag::Link { dest_url, .. }) => {
                let allowed = reqwest::Url::parse(&dest_url)
                    .is_ok_and(|url| matches!(url.scheme(), "http" | "https" | "mailto"));
                links.push(allowed);
                if allowed {
                    output.push_str("<a href=\"");
                    escape(&mut output, &dest_url);
                    output.push_str("\">");
                }
            }
            Event::End(TagEnd::Link) => {
                if links.pop() == Some(true) {
                    output.push_str("</a>");
                }
            }
            Event::Text(text) => escape(&mut output, &text),
            Event::Html(text) | Event::InlineHtml(text) => escape(&mut output, &text),
            Event::SoftBreak | Event::HardBreak => output.push('\n'),
            Event::Rule => output.push_str("\n────────\n"),
            Event::TaskListMarker(checked) => {
                output.push_str(if checked { "☑ " } else { "☐ " })
            }
            Event::Start(Tag::List(start)) => lists.push(start),
            Event::End(TagEnd::List(_)) => {
                lists.pop();
            }
            Event::Start(Tag::Item) => {
                if !output.is_empty() && !output.ends_with('\n') {
                    output.push('\n');
                }
                match lists.last_mut() {
                    Some(Some(index)) => {
                        output.push_str(&format!("{index}. "));
                        *index = index.saturating_add(1);
                    }
                    _ => output.push_str("• "),
                }
            }
            Event::End(TagEnd::Item) => output.push('\n'),
            Event::Start(Tag::BlockQuote(_)) => output.push_str("❝ "),
            Event::End(TagEnd::BlockQuote(_)) => output.push('\n'),
            _ => {}
        }
    }
    output.trim_end().to_string()
}

fn expand_tables(input: &str) -> String {
    let lines: Vec<_> = input.lines().collect();
    let mut output = Vec::with_capacity(lines.len());
    let mut index = 0;
    while index < lines.len() {
        if index + 1 < lines.len() {
            let headers = table_cells(lines[index]);
            let separators = table_cells(lines[index + 1]);
            if !headers.is_empty()
                && headers.len() == separators.len()
                && separators.iter().all(|cell| {
                    let marker = cell.trim().trim_matches(':');
                    marker.len() >= 3 && marker.bytes().all(|byte| byte == b'-')
                })
            {
                index += 2;
                while index < lines.len() {
                    let cells = table_cells(lines[index]);
                    if cells.len() != headers.len() {
                        break;
                    }
                    let fields = headers
                        .iter()
                        .zip(cells.iter())
                        .filter(|(_, value)| !value.trim().is_empty())
                        .map(|(name, value)| format!("**{}**: {}", name.trim(), value.trim()))
                        .collect::<Vec<_>>();
                    output.push(if fields.is_empty() {
                        "•".into()
                    } else {
                        format!("• {}", fields.join("  |  "))
                    });
                    index += 1;
                }
                continue;
            }
        }
        output.push(lines[index].to_owned());
        index += 1;
    }
    output.join("\n")
}

fn table_cells(line: &str) -> Vec<String> {
    let line = line.trim();
    if !line.contains('|') {
        return Vec::new();
    }
    let mut cells = Vec::new();
    let mut cell = String::new();
    let mut escaped = false;
    let mut code_ticks = 0usize;
    let chars: Vec<char> = line.chars().collect();
    let mut index = usize::from(chars.first() == Some(&'|'));
    while index < chars.len() {
        let ch = chars[index];
        if escaped {
            cell.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
            cell.push(ch);
        } else if ch == '`' {
            code_ticks += 1;
            cell.push(ch);
        } else if ch == '|' && code_ticks.is_multiple_of(2) {
            cells.push(std::mem::take(&mut cell));
        } else {
            cell.push(ch);
        }
        index += 1;
    }
    cells.push(cell);
    if chars.last() == Some(&'|') {
        cells.pop();
    }
    cells
}

fn escape(output: &mut String, text: &str) {
    for ch in text.chars() {
        match ch {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' => output.push_str("&quot;"),
            _ => output.push(ch),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn code_lists_and_untrusted_links_do_not_produce_invalid_markup() {
        assert_eq!(
            to_telegram_html("```rust\nlet x = a < b && c;\n```"),
            "<pre>let x = a &lt; b &amp;&amp; c;\n</pre>"
        );
        assert_eq!(
            to_telegram_html("- first\n- **second**"),
            "• first\n• <b>second</b>"
        );
        assert_eq!(
            to_telegram_html("~~old~~ [unsafe](javascript:alert)"),
            "<s>old</s> unsafe"
        );
        assert_eq!(
            to_telegram_html("[safe](https://example.com/\"x)"),
            "<a href=\"https://example.com/&quot;x\">safe</a>"
        );
    }

    #[test]
    fn markdown_tables_become_readable_formatted_rows_instead_of_broken_pipe_text() {
        assert_eq!(
            to_telegram_html("| Name | Result |\n| --- | :---: |\n| **Ada** | `a|b` |\n| Lin | <safe> |"),
            "• <b>Name</b>: <b>Ada</b>  |  <b>Result</b>: <code>a|b</code>\n• <b>Name</b>: Lin  |  <b>Result</b>: &lt;safe&gt;"
        );
        assert_eq!(
            to_telegram_html("| A | B |\n| --- | --- |\n| left\\|right | yes |"),
            "• <b>A</b>: left|right  |  <b>B</b>: yes"
        );
    }

    #[test]
    fn commonmark_is_rendered_as_safe_telegram_html() {
        assert_eq!(
            to_telegram_html("# Hello\n\n**bold** *italic* `x < y` [link](https://example.com/?a=1&b=2)"),
            "<b>Hello</b>\n<b>bold</b> <i>italic</i> <code>x &lt; y</code> <a href=\"https://example.com/?a=1&amp;b=2\">link</a>"
        );
        assert_eq!(
            to_telegram_html("<b>not trusted</b>"),
            "&lt;b&gt;not trusted&lt;/b&gt;"
        );
    }
}
