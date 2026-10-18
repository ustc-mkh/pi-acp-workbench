//! The raw JSON-RPC boundary. Domain and actor code must not inspect these values.
use serde::{de::Error, Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[cfg(test)]
#[path = "codec_tests.rs"]
mod tests;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub enum JsonRpcVersion {
    #[serde(rename = "2.0")]
    V2,
}
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq, Hash)]
#[serde(untagged)]
pub enum RequestId {
    Number(i64),
    String(String),
    Null,
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum JsonRpcMessage {
    Request(JsonRpcRequest),
    Response(JsonRpcResponse),
    Notification(JsonRpcNotification),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: JsonRpcVersion,
    pub id: RequestId,
    pub method: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub params: Value,
}
impl JsonRpcRequest {
    pub fn new(
        id: RequestId,
        method: impl Into<String>,
        params: impl Serialize,
    ) -> Result<Self, serde_json::Error> {
        Ok(Self {
            jsonrpc: JsonRpcVersion::V2,
            id,
            method: method.into(),
            params: serde_json::to_value(params)?,
        })
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: JsonRpcVersion,
    pub id: RequestId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}
impl JsonRpcResponse {
    pub fn success(id: RequestId, result: impl Serialize) -> Result<Self, serde_json::Error> {
        Ok(Self {
            jsonrpc: JsonRpcVersion::V2,
            id,
            result: Some(serde_json::to_value(result)?),
            error: None,
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: JsonRpcVersion,
    pub method: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub params: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
}

impl<'de> Deserialize<'de> for JsonRpcMessage {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Value::deserialize(deserializer)?;
        let object = raw
            .as_object()
            .ok_or_else(|| D::Error::custom("JSON-RPC message must be an object"))?;
        if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err(D::Error::custom("JSON-RPC version must be 2.0"));
        }
        if object.contains_key("method") {
            if object.contains_key("result") || object.contains_key("error") {
                return Err(D::Error::custom("request cannot contain result or error"));
            }
            if object
                .get("params")
                .is_some_and(|params| !params.is_object() && !params.is_array())
            {
                return Err(D::Error::custom("JSON-RPC params must be object or array"));
            }
            if object.contains_key("id") {
                let request: JsonRpcRequest =
                    serde_json::from_value(raw).map_err(D::Error::custom)?;
                if matches!(request.id, RequestId::Null) {
                    return Err(D::Error::custom("request ID cannot be null"));
                }
                Ok(Self::Request(request))
            } else {
                serde_json::from_value(raw)
                    .map(Self::Notification)
                    .map_err(D::Error::custom)
            }
        } else {
            let id = object
                .get("id")
                .ok_or_else(|| D::Error::custom("response ID missing"))?;
            let id = serde_json::from_value(id.clone()).map_err(D::Error::custom)?;
            let has_result = object.contains_key("result");
            let has_error = object.contains_key("error");
            if has_result == has_error {
                return Err(D::Error::custom(
                    "response must contain exactly one of result/error",
                ));
            }
            let result = object.get("result").cloned();
            let error = object
                .get("error")
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()
                .map_err(D::Error::custom)?;
            Ok(Self::Response(JsonRpcResponse {
                jsonrpc: JsonRpcVersion::V2,
                id,
                result,
                error,
            }))
        }
    }
}
