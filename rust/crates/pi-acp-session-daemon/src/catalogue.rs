//! Same policy as src/catalogue.ts: omission preserves known values; empty
//! catalogues are ignored only during cold handshakes, not live updates.
use serde_json::Value;

pub trait Catalogue {
    fn is_empty_catalogue(&self) -> bool;
}
impl<T> Catalogue for Vec<T> {
    fn is_empty_catalogue(&self) -> bool {
        self.is_empty()
    }
}
impl Catalogue for Value {
    fn is_empty_catalogue(&self) -> bool {
        match self {
            Value::Array(items) => items.is_empty(),
            Value::Object(items) => items.is_empty(),
            _ => false,
        }
    }
}

pub fn merge_catalogue<T: Catalogue>(
    previous: Option<T>,
    next: Option<T>,
    cold: bool,
) -> Option<T> {
    next.filter(|value| !cold || !value.is_empty_catalogue())
        .or(previous)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn omission_preserves_and_live_empty_clears() {
        for cold in [false, true] {
            assert_eq!(merge_catalogue(Some(vec![1]), None, cold), Some(vec![1]));
            assert_eq!(
                merge_catalogue(Some(vec![1]), Some(vec![2]), cold),
                Some(vec![2])
            );
            assert_eq!(merge_catalogue::<Vec<i32>>(None, None, cold), None);
        }
        assert_eq!(
            merge_catalogue(Some(vec![1]), Some(vec![]), false),
            Some(vec![])
        );
        assert_eq!(
            merge_catalogue(Some(vec![1]), Some(vec![]), true),
            Some(vec![1])
        );
        assert_eq!(merge_catalogue::<Vec<i32>>(None, Some(vec![]), true), None);
    }

    #[test]
    fn empty_mode_objects_follow_the_same_policy() {
        let previous = json!({"currentModeId":"high","availableModes":[]});
        assert_eq!(
            merge_catalogue(Some(previous.clone()), Some(json!({})), true),
            Some(previous)
        );
        assert_eq!(
            merge_catalogue(
                Some(json!({"currentModeId":"high"})),
                Some(json!({})),
                false
            ),
            Some(json!({}))
        );
    }
}
