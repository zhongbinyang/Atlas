//! Builtin REST API client steps (`kind=rest`).

use serde_json::{Map, Value};
use std::time::{Duration, Instant};

pub const KIND_REST: &str = "rest";
pub const REST_VI_PATH: &str = "__builtin__/rest";

pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;
pub const DEFAULT_EXPECT_STATUS: u16 = 200;

#[derive(Debug, Clone, PartialEq)]
pub struct RestRequest {
    pub method: String,
    pub url: String,
    pub headers: Map<String, Value>,
    pub body: String,
    pub timeout_ms: u64,
    pub expect_status: u16,
}

pub fn is_rest_template(kind: Option<&str>, vi_path: &str) -> bool {
    kind == Some(KIND_REST) || vi_path == REST_VI_PATH
}

fn input_value<'a>(inputs: &'a Value, name: &str) -> Option<&'a Value> {
    if let Some(obj) = inputs.as_object() {
        return obj.get(name);
    }
    inputs.as_array()?.iter().find_map(|item| {
        if item.get("name").and_then(|n| n.as_str()) == Some(name) {
            item.get("value")
        } else {
            None
        }
    })
}

fn value_as_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn body_to_request_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn headers_from_value(v: &Value) -> Result<Map<String, Value>, String> {
    match v {
        Value::Null => Ok(Map::new()),
        Value::Object(map) => Ok(map.clone()),
        Value::String(s) => parse_headers_object(s),
        _ => Err("headers must be a JSON object or object string".into()),
    }
}

fn value_as_u64(v: &Value, field: &str) -> Result<u64, String> {
    if let Some(n) = v.as_u64() {
        return Ok(n);
    }
    if let Some(n) = v.as_i64() {
        if n < 0 {
            return Err(format!("{field} must be >= 0"));
        }
        return Ok(n as u64);
    }
    if let Some(n) = v.as_f64() {
        if n < 0.0 || !n.is_finite() {
            return Err(format!("{field} must be a non-negative number"));
        }
        return Ok(n.round() as u64);
    }
    if let Some(s) = v.as_str() {
        return s
            .trim()
            .parse::<u64>()
            .map_err(|_| format!("{field} must be a number"));
    }
    Err(format!("{field} must be a number"))
}

fn normalize_method(raw: &str) -> Result<String, String> {
    let m = raw.trim().to_uppercase();
    match m.as_str() {
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" => Ok(m),
        _ => Err(format!("unsupported method `{raw}`")),
    }
}

fn parse_headers_object(raw: &str) -> Result<Map<String, Value>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Map::new());
    }
    let value: Value =
        serde_json::from_str(trimmed).map_err(|e| format!("headers must be JSON object: {e}"))?;
    match value {
        Value::Object(map) => Ok(map),
        _ => Err("headers must be a JSON object".into()),
    }
}

fn method_requires_json_body(method: &str) -> bool {
    matches!(method, "POST" | "PUT" | "PATCH")
}

/// Validate body for methods that send JSON. Empty body is allowed.
pub fn validate_json_body(method: &str, body: &str) -> Result<(), String> {
    if !method_requires_json_body(method) {
        return Ok(());
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    serde_json::from_str::<Value>(trimmed).map_err(|e| format!("body must be valid JSON: {e}"))?;
    Ok(())
}

pub fn rest_request_from_inputs(inputs: &Value) -> Result<RestRequest, String> {
    if !inputs.is_object() && !inputs.is_array() {
        return Err("rest inputs must be an object or array".into());
    }

    let method_raw = input_value(inputs, "method")
        .map(value_as_string)
        .unwrap_or_else(|| "POST".into());
    let method = normalize_method(&method_raw)?;

    let url = input_value(inputs, "url")
        .map(value_as_string)
        .unwrap_or_default()
        .trim()
        .to_string();
    if url.is_empty() {
        return Err("url is required".into());
    }

    let headers = match input_value(inputs, "headers") {
        Some(v) => headers_from_value(v)?,
        None => Map::new(),
    };

    let body = input_value(inputs, "body")
        .map(body_to_request_string)
        .unwrap_or_default();
    validate_json_body(&method, &body)?;

    let timeout_ms = match input_value(inputs, "timeout_ms") {
        Some(v) => value_as_u64(v, "timeout_ms")?,
        None => DEFAULT_TIMEOUT_MS,
    };
    if timeout_ms == 0 {
        return Err("timeout_ms must be > 0".into());
    }

    let expect_status = match input_value(inputs, "expect_status") {
        Some(v) => {
            let n = value_as_u64(v, "expect_status")?;
            if n > u16::MAX as u64 {
                return Err("expect_status out of range".into());
            }
            n as u16
        }
        None => DEFAULT_EXPECT_STATUS,
    };

    Ok(RestRequest {
        method,
        url,
        headers,
        body,
        timeout_ms,
        expect_status,
    })
}

/// Native REST inputs JSON (not LabVIEW VI param array).
/// `headers` is an object; `body` is a JSON value when parseable, otherwise a string.
pub fn rest_inputs(
    method: &str,
    url: &str,
    headers: &str,
    body: &str,
    timeout_ms: u64,
    expect_status: u16,
) -> Value {
    let method = normalize_method(method).unwrap_or_else(|_| method.trim().to_uppercase());
    let headers_val = parse_headers_object(headers)
        .map(Value::Object)
        .unwrap_or_else(|_| Value::Object(Map::new()));
    let body_trimmed = body.trim();
    let body_val = if body_trimmed.is_empty() {
        Value::Null
    } else {
        serde_json::from_str::<Value>(body_trimmed).unwrap_or_else(|_| Value::String(body.to_string()))
    };
    serde_json::json!({
        "method": method,
        "url": url,
        "headers": headers_val,
        "body": body_val,
        "timeout_ms": timeout_ms,
        "expect_status": expect_status
    })
}

fn header_has_content_type(headers: &Map<String, Value>) -> bool {
    headers.keys().any(|k| k.eq_ignore_ascii_case("content-type"))
}

fn apply_default_json_content_type(headers: &mut Map<String, Value>, method: &str, body: &str) {
    if !method_requires_json_body(method) {
        return;
    }
    if body.trim().is_empty() {
        return;
    }
    if header_has_content_type(headers) {
        return;
    }
    headers.insert(
        "Content-Type".into(),
        Value::String("application/json".into()),
    );
}

pub async fn run_request(req: &RestRequest) -> Result<Value, String> {
    let mut headers = req.headers.clone();
    apply_default_json_content_type(&mut headers, &req.method, &req.body);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(req.timeout_ms))
        .connect_timeout(Duration::from_millis(req.timeout_ms.min(10_000)))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let method = req
        .method
        .parse::<reqwest::Method>()
        .map_err(|e| format!("invalid method: {e}"))?;

    let mut builder = client.request(method, &req.url);
    for (key, value) in &headers {
        let header_val = match value {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        builder = builder.header(key, header_val);
    }

    if !req.body.trim().is_empty() {
        builder = builder.body(req.body.clone());
    }

    let started = Instant::now();
    let response = builder
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let status = response.status().as_u16();

    let mut resp_headers = Map::new();
    for (name, value) in response.headers().iter() {
        resp_headers.insert(
            name.as_str().to_string(),
            Value::String(value.to_str().unwrap_or("").to_string()),
        );
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("read body: {e}"))?;
    let body_text = String::from_utf8_lossy(&bytes).into_owned();

    let ok = status == req.expect_status;
    let mut result = Map::new();
    result.insert("ok".into(), Value::Bool(ok));
    result.insert("kind".into(), Value::String(KIND_REST.into()));
    result.insert("status".into(), Value::from(status));
    result.insert("elapsed_ms".into(), Value::from(elapsed_ms));
    result.insert("headers".into(), Value::String(Value::Object(resp_headers).to_string()));
    result.insert("body".into(), Value::String(body_text.clone()));

    if let Ok(parsed) = serde_json::from_str::<Value>(&body_text) {
        result.insert("body_json".into(), parsed);
    }

    if !ok {
        result.insert(
            "error".into(),
            Value::String(format!(
                "expected status {}, got {}",
                req.expect_status, status
            )),
        );
    }

    Ok(Value::Object(result))
}

pub async fn run_request_from_inputs(inputs: &Value) -> Result<Value, String> {
    let req = rest_request_from_inputs(inputs)?;
    run_request(&req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn parses_rest_inputs_object_and_legacy_array() {
        let inputs = rest_inputs(
            "post",
            "https://example.com/api",
            r#"{"Authorization":"Bearer x"}"#,
            r#"{"a":1}"#,
            5000,
            201,
        );
        assert!(inputs.is_object());
        assert!(inputs.get("body").unwrap().is_object());
        let req = rest_request_from_inputs(&inputs).unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.url, "https://example.com/api");
        assert_eq!(req.timeout_ms, 5000);
        assert_eq!(req.expect_status, 201);
        assert_eq!(
            req.headers.get("Authorization").and_then(|v| v.as_str()),
            Some("Bearer x")
        );
        assert_eq!(req.body, r#"{"a":1}"#);

        let legacy = serde_json::json!([
            { "name": "method", "className": "String", "value": "GET" },
            { "name": "url", "className": "String", "value": "https://example.com/x" },
            { "name": "headers", "className": "String", "value": "{}" },
            { "name": "body", "className": "String", "value": "" },
            { "name": "timeout_ms", "className": "Digital", "value": 3000 },
            { "name": "expect_status", "className": "Digital", "value": 200 }
        ]);
        let legacy_req = rest_request_from_inputs(&legacy).unwrap();
        assert_eq!(legacy_req.method, "GET");
        assert_eq!(legacy_req.url, "https://example.com/x");
    }

    #[test]
    fn rejects_invalid_json_body_for_post() {
        let inputs = rest_inputs("POST", "https://example.com", "{}", "{bad", 1000, 200);
        let err = rest_request_from_inputs(&inputs).unwrap_err();
        assert!(err.contains("body must be valid JSON"), "{err}");
    }

    #[test]
    fn allows_empty_post_body() {
        let inputs = rest_inputs("POST", "https://example.com", "{}", "", 1000, 200);
        assert!(rest_request_from_inputs(&inputs).is_ok());
    }

    #[test]
    fn requires_url() {
        let inputs = rest_inputs("GET", "  ", "{}", "", 1000, 200);
        assert_eq!(rest_request_from_inputs(&inputs).unwrap_err(), "url is required");
    }

    #[tokio::test]
    async fn run_request_posts_json_and_returns_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/ping"))
            .and(header("content-type", "application/json"))
            .and(body_json(serde_json::json!({"sn": "A1"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "power": -2.5,
                "code": 0
            })))
            .mount(&server)
            .await;

        let req = RestRequest {
            method: "POST".into(),
            url: format!("{}/v1/ping", server.uri()),
            headers: Map::new(),
            body: r#"{"sn":"A1"}"#.into(),
            timeout_ms: 3000,
            expect_status: 200,
        };
        let result = run_request(&req).await.unwrap();
        assert_eq!(result.get("ok"), Some(&Value::Bool(true)));
        assert_eq!(result.get("status").and_then(|v| v.as_u64()), Some(200));
        assert!(result.get("power").is_none());
        assert!(result.get("code").is_none());
        assert_eq!(
            result.get("body_json"),
            Some(&serde_json::json!({"power": -2.5, "code": 0}))
        );
    }

    #[tokio::test]
    async fn run_request_marks_ok_false_on_status_mismatch() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/missing"))
            .respond_with(ResponseTemplate::new(404).set_body_string("nope"))
            .mount(&server)
            .await;

        let req = RestRequest {
            method: "GET".into(),
            url: format!("{}/missing", server.uri()),
            headers: Map::new(),
            body: String::new(),
            timeout_ms: 3000,
            expect_status: 200,
        };
        let result = run_request(&req).await.unwrap();
        assert_eq!(result.get("ok"), Some(&Value::Bool(false)));
        assert_eq!(result.get("status").and_then(|v| v.as_u64()), Some(404));
        assert!(result.get("error").is_some());
    }

    #[test]
    fn is_rest_detects_kind_and_path() {
        assert!(is_rest_template(Some("rest"), ""));
        assert!(is_rest_template(None, REST_VI_PATH));
        assert!(!is_rest_template(Some("delay"), ""));
    }
}
