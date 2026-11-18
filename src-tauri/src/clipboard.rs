//! Clipboard read for Kiln's own text context menu. Reading through the
//! webview (`navigator.clipboard.readText`) makes WebKit show its native
//! "Paste" callout, so the desktop app reads the system clipboard here.

#[tauri::command]
pub async fn clipboard_read_text() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        match cb.get_text() {
            Ok(t) => Ok(Some(t)),
            Err(arboard::Error::ContentNotAvailable) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
