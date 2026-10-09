use serde_json::Value;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// JavaScript truthiness for JSON values (arrays and objects are truthy).
pub fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

pub fn js_optional_number_string(value: Option<f64>) -> String {
    match value {
        None => "undefined".into(),
        Some(v) if v.is_nan() => "NaN".into(),
        Some(v) if v.is_infinite() => if v > 0.0 { "Infinity" } else { "-Infinity" }.into(),
        Some(v) => serde_json::Number::from_f64(v)
            .map(|n| crate::canonical::js_number_string(&n))
            .unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn truthiness_and_number_display() {
        for v in [json!(null), json!(false), json!(0), json!("")] {
            assert!(!js_truthy(&v));
        }
        for v in [json!([]), json!({}), json!(-1), json!("0")] {
            assert!(js_truthy(&v));
        }
        assert_eq!(js_optional_number_string(Some(-0.0)), "0");
        assert_eq!(js_optional_number_string(None), "undefined");
    }
}
