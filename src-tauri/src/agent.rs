//! Agent bridge: MCP JSON-RPC handling and the round trip to the frontend.
//!
//! The frontend owns the canvas, so it registers the MCP tool definitions and
//! executes tool calls. Rust only routes: `tools/call` → `kiln://agent-call`
//! event → frontend → `agent_respond` command → oneshot → HTTP response.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;

pub const EVENT_CALL: &str = "kiln://agent-call";
pub const EVENT_ACTIVITY: &str = "kiln://agent-activity";
pub const SUPPORTED_PROTOCOLS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
pub const DEFAULT_PROTOCOL: &str = "2025-06-18";
pub const STATUS_TOOL: &str = "kiln_status";
pub const NO_DOC_MESSAGE: &str = "No Kiln document is open. Ask the user to open a file in Kiln.";
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// Sessions that have not been seen for this long no longer count as clients.
const SESSION_TTL: Duration = Duration::from_secs(30 * 60);

const INSTRUCTIONS: &str = "Kiln is a design canvas whose layers are real HTML/CSS. \
Every node (frame, rect, ellipse, path, text, image, shader) maps 1:1 to a DOM element (a path is an inline SVG) styled with real CSS: \
frames can use flex layout (direction, gap, padding, align, justify) and children are ordered back-to-front like DOM order. \
These tools act on the document currently open in the Kiln desktop app, and the user sees your edits live. \
Inspect the document before editing, prefer the document's design tokens over raw values, and keep layer names meaningful. \
If only `kiln_status` is available, no document is open: ask the user to open a file in Kiln.";

/// Emits `(event, payload)` to the webview. Set once the Tauri app exists.
pub type Emitter = Box<dyn Fn(&str, Value) -> Result<(), String> + Send + Sync>;

#[derive(Debug, Clone, Serialize)]
pub struct CallResult {
    pub content: Vec<Value>,
    #[serde(rename = "isError")]
    pub is_error: bool,
}

impl CallResult {
    fn text(text: impl Into<String>, is_error: bool) -> Self {
        Self { content: vec![json!({ "type": "text", "text": text.into() })], is_error }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentStatus {
    pub running: bool,
    pub port: u16,
    pub url: String,
    pub clients: u32,
}

pub struct AgentHub {
    tools: RwLock<Vec<Value>>,
    pending: Mutex<HashMap<String, oneshot::Sender<CallResult>>>,
    sessions: Mutex<HashMap<String, Instant>>,
    emitter: OnceLock<Emitter>,
    counter: AtomicU64,
    pub port: AtomicU16,
    pub running: AtomicBool,
    timeout: Duration,
}

impl Default for AgentHub {
    fn default() -> Self {
        Self::with_timeout(CALL_TIMEOUT)
    }
}

impl AgentHub {
    pub fn with_timeout(timeout: Duration) -> Self {
        Self {
            tools: RwLock::new(Vec::new()),
            pending: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            emitter: OnceLock::new(),
            counter: AtomicU64::new(0),
            port: AtomicU16::new(0),
            running: AtomicBool::new(false),
            timeout,
        }
    }

    pub fn set_emitter(&self, emitter: Emitter) {
        let _ = self.emitter.set(emitter);
    }

    fn emit(&self, event: &str, payload: Value) -> Result<(), String> {
        match self.emitter.get() {
            Some(emit) => emit(event, payload),
            None => Err("Kiln window is not ready".into()),
        }
    }

    fn next_id(&self, prefix: &str) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        format!("{prefix}{t:x}{n:x}")
    }

    // ---- tools ------------------------------------------------------------

    /// Replaces the registered tools. Entries without a string `name` are dropped.
    pub fn register_tools(&self, tools: Vec<Value>) -> usize {
        let valid: Vec<Value> = tools
            .into_iter()
            .filter(|t| t.get("name").and_then(Value::as_str).is_some_and(|n| !n.is_empty()))
            .collect();
        let n = valid.len();
        *self.tools.write().unwrap() = valid;
        n
    }

    pub fn has_document(&self) -> bool {
        !self.tools.read().unwrap().is_empty()
    }

    pub fn tool_list(&self) -> Vec<Value> {
        let tools = self.tools.read().unwrap();
        if tools.is_empty() {
            vec![json!({
                "name": STATUS_TOOL,
                "description": "Reports whether a Kiln document is open. Only available while no document is open.",
                "inputSchema": { "type": "object", "properties": {} }
            })]
        } else {
            tools.clone()
        }
    }

    fn is_registered(&self, name: &str) -> bool {
        self.tools
            .read()
            .unwrap()
            .iter()
            .any(|t| t.get("name").and_then(Value::as_str) == Some(name))
    }

    // ---- sessions ---------------------------------------------------------

    pub fn new_session(&self) -> String {
        let id = self.next_id("kiln-");
        self.sessions.lock().unwrap().insert(id.clone(), Instant::now());
        id
    }

    /// Marks a session as seen. Unknown ids are adopted, so clients keep
    /// working across an app restart without re-initializing.
    pub fn touch_session(&self, id: &str) {
        if id.is_empty() || id.len() > 128 {
            return;
        }
        self.sessions.lock().unwrap().insert(id.to_string(), Instant::now());
    }

    pub fn end_session(&self, id: &str) {
        self.sessions.lock().unwrap().remove(id);
    }

    pub fn client_count(&self) -> u32 {
        let mut s = self.sessions.lock().unwrap();
        s.retain(|_, seen| seen.elapsed() < SESSION_TTL);
        s.len() as u32
    }

    pub fn status(&self) -> AgentStatus {
        let port = self.port.load(Ordering::Relaxed);
        AgentStatus {
            running: self.running.load(Ordering::Relaxed),
            port,
            url: format!("http://127.0.0.1:{port}/mcp"),
            clients: self.client_count(),
        }
    }

    // ---- calls ------------------------------------------------------------

    /// Delivers the frontend's answer. Returns false if the call is unknown (e.g. timed out).
    pub fn respond(&self, call_id: &str, result: CallResult) -> bool {
        match self.pending.lock().unwrap().remove(call_id) {
            Some(tx) => tx.send(result).is_ok(),
            None => false,
        }
    }

    async fn call_frontend(&self, name: &str, arguments: Value) -> CallResult {
        let call_id = self.next_id("call-");
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(call_id.clone(), tx);

        let _ = self.emit(EVENT_ACTIVITY, json!({ "phase": "start", "callId": call_id, "name": name }));
        let sent = self.emit(EVENT_CALL, json!({ "callId": call_id, "name": name, "arguments": arguments }));

        let result = match sent {
            Err(e) => CallResult::text(format!("Could not reach the Kiln window: {e}"), true),
            Ok(()) => match tokio::time::timeout(self.timeout, rx).await {
                Ok(Ok(r)) => r,
                Ok(Err(_)) => CallResult::text("The Kiln window dropped the call.", true),
                Err(_) => CallResult::text(
                    format!("Kiln did not answer `{name}` within {}s.", self.timeout.as_secs()),
                    true,
                ),
            },
        };
        self.pending.lock().unwrap().remove(&call_id);
        let _ = self.emit(EVENT_ACTIVITY, json!({ "phase": "end", "callId": call_id, "name": name }));
        result
    }

    // ---- JSON-RPC -----------------------------------------------------------

    /// Handles one JSON-RPC message. Returns `None` for notifications and responses.
    pub async fn handle_message(&self, msg: &Value) -> Option<Value> {
        let Some(obj) = msg.as_object() else {
            return Some(rpc_error(Value::Null, -32600, "Invalid Request"));
        };
        let id = obj.get("id").cloned();
        let Some(method) = obj.get("method").and_then(Value::as_str) else {
            // A response from the client (we never send requests) or garbage.
            return match id {
                Some(id) if !obj.contains_key("result") && !obj.contains_key("error") => {
                    Some(rpc_error(id, -32600, "Invalid Request"))
                }
                _ => None,
            };
        };
        let Some(id) = id else {
            // Notifications (notifications/initialized, notifications/cancelled, ...) need no reply.
            return None;
        };
        if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Some(rpc_error(id, -32600, "Invalid Request: jsonrpc must be \"2.0\""));
        }
        let params = obj.get("params").cloned().unwrap_or(Value::Null);

        let result = match method {
            "initialize" => {
                let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
                let version = if SUPPORTED_PROTOCOLS.contains(&requested) { requested } else { DEFAULT_PROTOCOL };
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": true } },
                    "serverInfo": { "name": "kiln", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": INSTRUCTIONS,
                })
            }
            "ping" => json!({}),
            "tools/list" => json!({ "tools": self.tool_list() }),
            "tools/call" => {
                let Some(name) = params.get("name").and_then(Value::as_str) else {
                    return Some(rpc_error(id, -32602, "Invalid params: missing tool name"));
                };
                let arguments = match params.get("arguments") {
                    None | Some(Value::Null) => json!({}),
                    Some(a) => a.clone(),
                };
                let result = if self.is_registered(name) {
                    self.call_frontend(name, arguments).await
                } else if !self.has_document() {
                    CallResult::text(NO_DOC_MESSAGE, name != STATUS_TOOL)
                } else if name == STATUS_TOOL {
                    CallResult::text("A Kiln document is open. Call tools/list to see the canvas tools.", false)
                } else {
                    return Some(rpc_error(id, -32602, &format!("Unknown tool: {name}")));
                };
                serde_json::to_value(result).unwrap_or(Value::Null)
            }
            _ => return Some(rpc_error(id, -32601, &format!("Method not found: {method}"))),
        };
        Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }

    /// Handles a POST body, which may be a single message or a batch.
    pub async fn handle_body(&self, body: &Value) -> Option<Value> {
        match body {
            Value::Array(items) if items.is_empty() => Some(rpc_error(Value::Null, -32600, "Invalid Request: empty batch")),
            Value::Array(items) => {
                let mut out = Vec::new();
                for item in items {
                    if let Some(r) = self.handle_message(item).await {
                        out.push(r);
                    }
                }
                (!out.is_empty()).then_some(Value::Array(out))
            }
            single => self.handle_message(single).await,
        }
    }
}

pub fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// True if the body contains an `initialize` request.
pub fn is_initialize(body: &Value) -> bool {
    let is_init = |v: &Value| v.get("method").and_then(Value::as_str) == Some("initialize");
    match body {
        Value::Array(items) => items.iter().any(is_init),
        v => is_init(v),
    }
}

pub type SharedHub = Arc<AgentHub>;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn agent_register_tools(hub: tauri::State<'_, SharedHub>, tools: Vec<Value>) -> Result<usize, String> {
    Ok(hub.register_tools(tools))
}

#[tauri::command]
pub async fn agent_respond(
    hub: tauri::State<'_, SharedHub>,
    call_id: String,
    is_error: bool,
    content: Vec<Value>,
) -> Result<bool, String> {
    Ok(hub.respond(&call_id, CallResult { content, is_error }))
}

#[tauri::command]
pub async fn agent_status(hub: tauri::State<'_, SharedHub>) -> Result<AgentStatus, String> {
    Ok(hub.status())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(id: i64, method: &str, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    }

    #[tokio::test]
    async fn initialize_negotiates_protocol() {
        let hub = AgentHub::default();
        let r = hub
            .handle_message(&req(1, "initialize", json!({ "protocolVersion": "2025-03-26", "capabilities": {} })))
            .await
            .unwrap();
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(r["result"]["serverInfo"]["name"], "kiln");
        assert_eq!(r["result"]["capabilities"]["tools"]["listChanged"], true);
        assert!(r["result"]["instructions"].as_str().unwrap().contains("HTML/CSS"));

        let r = hub.handle_message(&req(2, "initialize", json!({ "protocolVersion": "1999-01-01" }))).await.unwrap();
        assert_eq!(r["result"]["protocolVersion"], DEFAULT_PROTOCOL);
        assert!(is_initialize(&req(2, "initialize", json!({}))));
    }

    #[tokio::test]
    async fn notifications_and_ping() {
        let hub = AgentHub::default();
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(hub.handle_message(&note).await.is_none());
        assert!(hub.handle_body(&json!([note])).await.is_none());
        let r = hub.handle_message(&req(3, "ping", Value::Null)).await.unwrap();
        assert_eq!(r["result"], json!({}));
    }

    #[tokio::test]
    async fn tools_list_falls_back_to_status_tool() {
        let hub = AgentHub::default();
        let r = hub.handle_message(&req(1, "tools/list", json!({}))).await.unwrap();
        let tools = r["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], STATUS_TOOL);

        let r = hub.handle_message(&req(2, "tools/call", json!({ "name": STATUS_TOOL }))).await.unwrap();
        assert_eq!(r["result"]["isError"], false);
        assert_eq!(r["result"]["content"][0]["text"], NO_DOC_MESSAGE);

        // Registering tools replaces the fallback; invalid entries are dropped.
        let n = hub.register_tools(vec![
            json!({ "name": "get_document", "description": "d", "inputSchema": { "type": "object" } }),
            json!({ "description": "no name" }),
        ]);
        assert_eq!(n, 1);
        let r = hub.handle_message(&req(3, "tools/list", json!({}))).await.unwrap();
        assert_eq!(r["result"]["tools"][0]["name"], "get_document");

        let r = hub.handle_message(&req(4, "tools/call", json!({ "name": "nope" }))).await.unwrap();
        assert_eq!(r["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn unknown_method_and_invalid_requests() {
        let hub = AgentHub::default();
        let r = hub.handle_message(&req(9, "resources/list", json!({}))).await.unwrap();
        assert_eq!(r["id"], 9);
        assert_eq!(r["error"]["code"], -32601);

        let r = hub.handle_message(&json!({ "id": 1, "method": "ping" })).await.unwrap();
        assert_eq!(r["error"]["code"], -32600);
        let r = hub.handle_message(&json!("hello")).await.unwrap();
        assert_eq!(r["error"]["code"], -32600);
    }

    #[tokio::test]
    async fn tools_call_round_trip_through_frontend() {
        let hub = Arc::new(AgentHub::with_timeout(Duration::from_secs(5)));
        hub.register_tools(vec![json!({ "name": "add_rect", "inputSchema": { "type": "object" } })]);

        // Fake frontend: answer every agent-call event from another task.
        let events = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let (hub2, events2) = (hub.clone(), events.clone());
        hub.set_emitter(Box::new(move |event, payload| {
            events2.lock().unwrap().push((event.to_string(), payload.clone()));
            if event == EVENT_CALL {
                let hub3 = hub2.clone();
                let call_id = payload["callId"].as_str().unwrap().to_string();
                tokio::spawn(async move {
                    hub3.respond(&call_id, CallResult::text("made rect", false));
                });
            }
            Ok(())
        }));

        let r = hub
            .handle_message(&req(5, "tools/call", json!({ "name": "add_rect", "arguments": { "w": 10 } })))
            .await
            .unwrap();
        assert_eq!(r["result"]["isError"], false);
        assert_eq!(r["result"]["content"][0]["text"], "made rect");

        let ev = events.lock().unwrap();
        let names: Vec<_> = ev.iter().map(|(e, p)| (e.as_str(), p.get("phase").cloned())).collect();
        assert_eq!(names[0], (EVENT_ACTIVITY, Some(json!("start"))));
        assert_eq!(names[1].0, EVENT_CALL);
        assert_eq!(names[2], (EVENT_ACTIVITY, Some(json!("end"))));
        assert_eq!(ev[1].1["arguments"]["w"], 10);
    }

    #[tokio::test]
    async fn tools_call_times_out() {
        let hub = AgentHub::with_timeout(Duration::from_millis(50));
        hub.register_tools(vec![json!({ "name": "slow" })]);
        hub.set_emitter(Box::new(|_, _| Ok(())));
        let r = hub.handle_message(&req(6, "tools/call", json!({ "name": "slow" }))).await.unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert!(hub.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn sessions_count_as_clients() {
        let hub = AgentHub::default();
        let a = hub.new_session();
        hub.new_session();
        hub.touch_session(&a);
        assert_eq!(hub.client_count(), 2);
        hub.end_session(&a);
        assert_eq!(hub.status().clients, 1);
    }
}
