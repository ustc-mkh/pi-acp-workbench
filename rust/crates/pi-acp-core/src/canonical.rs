//! Canonical JSON + request fingerprints (docs/data-formats.md §6).
//! Keys sort by UTF-16 code-unit order (JavaScript string comparison), NOT UTF-8
//! byte order — BTreeMap::cmp on &str is byte order and must not be used here.
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::util::utf16_cmp;

/// JSON.stringify-equivalent escaping: only `"`, `\`, and control characters
/// are escaped; non-ASCII stays raw (UTF-8). Lone surrogates cannot appear in
/// Rust strings and therefore never occur here.
pub fn js_escape_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Deterministic serialization: object keys sorted by UTF-16 order, compact
/// separators, JSON.stringify string escapes. Numbers render as stored (the
/// fingerprint only covers parsed request params, which are i64/u64/f64).
pub fn canonical_json_string(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        // JS numbers are f64: Number::toString rules — -0→"0", non-finite→"null",
        // exponential only when |n|>=1e21 or <1e-6, exponent signed "e+21"/"e-7".
        // serde_json preserves 9007199254740993 as u64; as_f64 rounds it like JS.
        Value::Number(n) => out.push_str(&js_number_string(n)),
        Value::String(s) => js_escape_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| utf16_cmp(a, b));
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                js_escape_string(out, key);
                out.push(':');
                write_value(out, &map[*key]);
            }
            out.push('}');
        }
    }
}

/// ECMAScript Number::toString(10) for JSON.stringify-compatible output.
pub fn js_number_string(n: &serde_json::Number) -> String {
    let f = n.as_f64().unwrap_or_default();
    if !f.is_finite() {
        return "null".into(); // JSON.stringify(NaN/Infinity) → null
    }
    if f == 0.0 {
        return "0".into(); // covers -0
    }
    let abs = f.abs();
    if abs >= 1e21 || abs < 1e-6 {
        // Rust {:e} is shortest-round-trip with bare exponent; JS signs "+".
        let s = format!("{f:e}");
        match s.find('e') {
            Some(i) if s.as_bytes()[i + 1] != b'-' => format!("{}e+{}", &s[..i], &s[i + 1..]),
            _ => s,
        }
    } else {
        // Display: shortest round-trip decimal, no exponent — matches JS here.
        format!("{f}")
    }
}

/// requestFingerprint(method, params) — sha256 hex of canonical {method, params}.
pub fn request_fingerprint(method: &str, params: &Value) -> String {
    let body = canonical_json_string(&serde_json::json!({ "method": method, "params": params }));
    hex_of(&Sha256::digest(body.as_bytes()))
}

pub fn sha256_hex(text: &str) -> String {
    hex_of(&Sha256::digest(text.as_bytes()))
}

fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    //! Expected fingerprints computed once under Node with the exact
    //! requestFingerprint() from src/request-journal.ts, then frozen here.
    //! The {𐀀, ＀, ！} case is the discriminator for UTF-16 ordering: in
    //! UTF-16 code units the lead surrogate 0xD800 (𐀀, U+10000) sorts BEFORE
    //! ＀/！(U+FF00/U+FF01), while UTF-8 byte order (= code point order) sorts
    //! it AFTER them. A byte-order implementation produces
    //! {"！":1,"＀":3,"𐀀":2} and fails this test.
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_orders_keys_by_utf16_code_unit() {
        // UTF-16: a(0x61) < z(0x7A) < 中(0x4E2D) < 𐀀(0xD800 0xDC00) — here
        // identical to UTF-8 order because every key is single-byte or BMP.
        assert_eq!(
            canonical_json_string(&json!({"中": 1, "z": 2, "𐀀": 3, "a": 4})),
            "{\"a\":4,\"z\":2,\"中\":1,\"𐀀\":3}"
        );
        // UTF-16: 𐀀(0xD800…) < ＀(0xFF00) < ！(0xFF01); UTF-8 would put 𐀀 last.
        assert_eq!(
            canonical_json_string(&json!({"！": 1, "𐀀": 2, "＀": 3})),
            "{\"𐀀\":2,\"＀\":3,\"！\":1}"
        );
    }

    #[test]
    fn request_fingerprint_matches_ts() {
        let cases: [(&str, Value, &str); 7] = [
            (
                "session/prompt",
                json!({"prompt": "hello", "sessionId": "s1"}),
                "5bcd472e2a90c35d4552604bc7c72ca50feca2b106d76e9c5e4332ea9f67ac6c",
            ),
            (
                "session/prompt",
                json!({"nested": {"b": 1, "a": [3, 2, {"y": null, "x": true}]}, "arr": [{"k": "v"}, []]}),
                "1f2b647c75dfcd4fd2eccc9ce9b750203ca3256416294bc9d1164df781394f4c",
            ),
            (
                "session/prompt",
                json!({"中": 1, "z": 2, "𐀀": 3, "a": 4}),
                "c6c35ee4196abaefbc2ef4a739bf5e6025388584fc34fc6d936130f9989f90e3",
            ),
            (
                "session/create",
                json!({"cwd": "/tmp/项目", "unicode": "héllo 世界 🎉"}),
                "14dd3c66255f1299562e633406dcc335b98e7b00a591f7bc587a0482f14d1654",
            ),
            (
                "session/cancel",
                json!({}),
                "504858961674dd9fb432edaa98a27752a459b192082963aa1388e2a6296ba171",
            ),
            (
                "session/prompt",
                json!({"nested": {"中": {"z": [1, "two", false]}, "z": {"中": null}}}),
                "da889be54a4a240a4fe2f5e2466053c15fa422abce71232df80f6b0060d4339a",
            ),
            // Surrogate-pair keys — the only case where UTF-16 and UTF-8
            // orderings actually disagree.
            (
                "session/prompt",
                json!({"！": 1, "𐀀": 2, "＀": 3}),
                "f0a8d5d5e7386ba7d1177fa13b27753ce452a0a2146da56a309b91d1917be6cc",
            ),
        ];
        for (method, params, expected) in cases {
            assert_eq!(
                request_fingerprint(method, &params),
                expected,
                "params={params}"
            );
        }
    }

    /// JS Number::toString parity — values frozen from `JSON.stringify` under
    /// Node: 1e+21 / 1e-7 / 0.1 / 9007199254740992 / 1.5 / -0.5 /
    /// 123456789.123 / 1e20→digits / -0→0 / 5e-324 / 1e-6→0.000001.
    #[test]
    fn js_number_formatting_matches_node() {
        let cases: [(f64, &str); 11] = [
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (0.1, "0.1"),
            (9007199254740993.0, "9007199254740992"),
            (1.5, "1.5"),
            (-0.5, "-0.5"),
            (123456789.123, "123456789.123"),
            (1e20, "100000000000000000000"),
            (5e-324, "5e-324"),
            (1e-6, "0.000001"),
            (123456789012345680000.0, "123456789012345680000"),
        ];
        for (v, expected) in cases {
            assert_eq!(canonical_json_string(&json!(v)), expected, "v={v}");
        }
        assert_eq!(canonical_json_string(&json!(-0.0)), "0");
        // serde parses this literal as u64 → as_f64 rounds like JS.
        let big: Value = serde_json::from_str("9007199254740993").unwrap();
        assert_eq!(canonical_json_string(&big), "9007199254740992");
        // Canonical object with float params — expected from Node stringify.
        assert_eq!(
            canonical_json_string(
                &json!({"m":"x","p":{"a":1.5,"b":1e21,"c":1e-7,"d":9007199254740993.0}})
            ),
            "{\"m\":\"x\",\"p\":{\"a\":1.5,\"b\":1e+21,\"c\":1e-7,\"d\":9007199254740992}}"
        );
    }
}
