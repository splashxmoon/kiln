//! Local MCP server (Streamable HTTP transport, JSON responses only).
//!
//! Binds to 127.0.0.1 only. `Origin` and `Host` are checked on every request
//! to block DNS-rebinding attacks from web pages.

use std::sync::atomic::Ordering;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use crate::agent::{is_initialize, rpc_error, SharedHub};

pub const PORTS: std::ops::RangeInclusive<u16> = 7457..=7460;
const SESSION_HEADER: &str = "mcp-session-id";

fn host_part(authority: &str) -> &str {
    if authority.starts_with('[') {
        authority.split_inclusive(']').next().unwrap_or(authority)
    } else {
        authority.split(':').next().unwrap_or(authority)
    }
}

fn is_local_host(host: &str) -> bool {
    matches!(host.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "[::1]")
}

/// Allows only loopback origins (plus the Tauri webview's own origins).
pub fn origin_allowed(origin: &str) -> bool {
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or("");
    if authority.contains('@') {
        return false;
    }
    let host = host_part(authority).to_ascii_lowercase();
    match scheme {
        "http" | "https" => is_local_host(&host) || host == "tauri.localhost",
        "tauri" => host == "localhost",
        _ => false,
    }
}

async fn guard(req: Request, next: Next) -> Response {
    let headers = req.headers();
    if let Some(origin) = headers.get(header::ORIGIN) {
        if !origin.to_str().is_ok_and(origin_allowed) {
            return (StatusCode::FORBIDDEN, "Forbidden origin").into_response();
        }
    }
    if let Some(host) = headers.get(header::HOST) {
        if !host.to_str().is_ok_and(|h| is_local_host(host_part(h))) {
            return (StatusCode::FORBIDDEN, "Forbidden host").into_response();
        }
    }
    next.run(req).await
}

fn json_response(status: StatusCode, body: &Value) -> Response {
    let mut res = Response::new(Body::from(body.to_string()));
    *res.status_mut() = status;
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    res
}

async fn post_mcp(State(hub): State<SharedHub>, headers: HeaderMap, body: Bytes) -> Response {
    let msg: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                &rpc_error(Value::Null, -32700, &format!("Parse error: {e}")),
            )
        }
    };

    let mut session = None;
    if is_initialize(&msg) {
        session = Some(hub.new_session());
    } else if let Some(id) = headers.get(SESSION_HEADER).and_then(|v| v.to_str().ok()) {
        hub.touch_session(id);
    }

    let mut res = match hub.handle_body(&msg).await {
        Some(reply) => json_response(StatusCode::OK, &reply),
        None => StatusCode::ACCEPTED.into_response(),
    };
    if let Some(id) = session.and_then(|s| HeaderValue::from_str(&s).ok()) {
        res.headers_mut().insert(SESSION_HEADER, id);
    }
    res
}

async fn get_mcp() -> Response {
    // No server-initiated SSE stream.
    let mut res = (StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed").into_response();
    res.headers_mut().insert(header::ALLOW, HeaderValue::from_static("POST, DELETE"));
    res
}

async fn delete_mcp(State(hub): State<SharedHub>, headers: HeaderMap) -> StatusCode {
    match headers.get(SESSION_HEADER).and_then(|v| v.to_str().ok()) {
        Some(id) => {
            hub.end_session(id);
            StatusCode::OK
        }
        None => StatusCode::BAD_REQUEST,
    }
}

async fn health(State(hub): State<SharedHub>) -> Response {
    let s = hub.status();
    json_response(
        StatusCode::OK,
        &json!({
            "ok": true,
            "name": "kiln",
            "version": env!("CARGO_PKG_VERSION"),
            "running": s.running,
            "port": s.port,
            "url": s.url,
            "clients": s.clients,
            "documentOpen": hub.has_document(),
        }),
    )
}

pub fn router(hub: SharedHub) -> Router {
    Router::new()
        .route("/mcp", post(post_mcp).get(get_mcp).delete(delete_mcp))
        .route("/health", get(health))
        .layer(middleware::from_fn(guard))
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(hub)
}

/// Binds the first free port in [`PORTS`] on 127.0.0.1 and serves until the app exits.
pub async fn serve(hub: SharedHub) {
    let mut bound = None;
    for port in PORTS {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => {
                bound = Some((l, port));
                break;
            }
            Err(e) => eprintln!("[kiln] MCP port {port} unavailable: {e}"),
        }
    }
    let Some((listener, port)) = bound else {
        eprintln!("[kiln] MCP server not started: ports {PORTS:?} are all busy");
        return;
    };
    hub.port.store(port, Ordering::Relaxed);
    hub.running.store(true, Ordering::Relaxed);
    eprintln!("[kiln] MCP server listening on http://127.0.0.1:{port}/mcp");
    if let Err(e) = axum::serve(listener, router(hub.clone())).await {
        eprintln!("[kiln] MCP server stopped: {e}");
    }
    hub.running.store(false, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::AgentHub;
    use std::future::IntoFuture;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn origins() {
        for ok in [
            "http://localhost:5173",
            "http://127.0.0.1",
            "https://localhost",
            "http://[::1]:7457",
            "tauri://localhost",
            "http://tauri.localhost",
        ] {
            assert!(origin_allowed(ok), "{ok} should be allowed");
        }
        for bad in [
            "null",
            "http://evil.com",
            "http://localhost.evil.com",
            "http://127.0.0.1.nip.io",
            "file://",
            "http://evil.com:80@localhost",
            "http://localhost:80@evil.com",
        ] {
            assert!(!origin_allowed(bad), "{bad} should be rejected");
        }
    }

    async fn http(port: u16, raw: String) -> String {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(raw.as_bytes()).await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    }

    fn post(port: u16, extra: &str, body: &str) -> String {
        format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n\
             Accept: application/json, text/event-stream\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[tokio::test]
    async fn http_transport() {
        let hub = Arc::new(AgentHub::default());
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(axum::serve(listener, router(hub.clone())).into_future());

        let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}"#;
        let r = http(port, post(port, "", init)).await;
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
        assert!(r.to_ascii_lowercase().contains("mcp-session-id: kiln-"), "{r}");
        assert!(r.contains("content-type: application/json"), "{r}");

        let note = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        let r = http(port, post(port, "Mcp-Session-Id: abc\r\n", note)).await;
        assert!(r.starts_with("HTTP/1.1 202"), "{r}");
        assert_eq!(hub.client_count(), 2);

        let r = http(port, post(port, "Origin: http://evil.com\r\n", init)).await;
        assert!(r.starts_with("HTTP/1.1 403"), "{r}");
        let r = http(port, post(port, "Origin: http://localhost:5173\r\n", init)).await;
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");

        let r = http(port, post(port, "", "{not json")).await;
        assert!(r.starts_with("HTTP/1.1 400") && r.contains("-32700"), "{r}");

        let r = http(port, format!("GET /mcp HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n")).await;
        assert!(r.starts_with("HTTP/1.1 405"), "{r}");

        let r = http(port, format!("GET /health HTTP/1.1\r\nHost: evil.com\r\nConnection: close\r\n\r\n")).await;
        assert!(r.starts_with("HTTP/1.1 403"), "{r}");
        let r = http(port, format!("GET /health HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n")).await;
        assert!(r.starts_with("HTTP/1.1 200") && r.contains("\"documentOpen\":false"), "{r}");
    }
}
