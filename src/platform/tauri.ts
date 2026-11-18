/**
 * Desktop (Tauri) bridge. Everything here is safe to import in the web build:
 * `@tauri-apps/api` is only loaded through dynamic imports, and every wrapper
 * throws a clear error if called outside the desktop app.
 */

export const isTauri: boolean = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export { isMac, isWindows, isLinux, os } from './os'

/** MCP tool definition, registered by the frontend and served by the desktop MCP server. */
export interface McpTool {
  name: string
  title?: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown }
  annotations?: Record<string, unknown>
}

/** MCP content item returned from a tool call. */
export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface DesktopFileMeta {
  id: string
  name: string
  updatedAt: number
  thumbnail?: string | null
  /** The project folder it is in, or null for Drafts (top level). */
  projectId?: string | null
}

export interface DesktopProjectMeta {
  id: string
  name: string
  color: string
  createdAt: number
  updatedAt: number
  fileCount: number
}

export interface DesktopTrashItem {
  trashId: string
  id: string
  name: string
  deletedAt: number
  thumbnail?: string | null
  projectId?: string | null
}

export interface AgentStatus {
  running: boolean
  port: number
  url: string
  clients: number
}

export interface AgentActivity {
  phase: 'start' | 'end'
  callId: string
  name: string
}

export interface ExportFile {
  /** relative path inside the chosen folder, e.g. `index.html` or `assets/site.css` */
  path: string
  contents: string
  /** `contents` is base64 (PNG / JPG exports): written to disk as the decoded bytes */
  base64?: boolean
}

interface AgentCallPayload {
  callId: string
  name: string
  arguments: Record<string, unknown> | null
}

export const AGENT_CALL_EVENT = 'kiln://agent-call'
export const AGENT_ACTIVITY_EVENT = 'kiln://agent-activity'

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new Error(`"${cmd}" is only available in the Kiln desktop app`)
  const core = await import('@tauri-apps/api/core')
  return core.invoke<T>(cmd, args)
}

async function listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (!isTauri) return () => {}
  const ev = await import('@tauri-apps/api/event')
  return ev.listen<T>(event, (e) => cb(e.payload))
}

// ---- files ---------------------------------------------------------------

export const desktopListFiles = (): Promise<DesktopFileMeta[]> => invoke('list_files')

/** Returns the raw parsed document, or null if the file does not exist. */
export const desktopLoadFile = (id: string): Promise<unknown> => invoke('load_file', { id })

/**
 * Atomically writes `<id>.kiln` where the file already lives; a new file goes into the
 * project's folder, or `<Documents>/Kiln/` (Drafts) when projectId is null.
 */
export const desktopSaveFile = (doc: { id: string }, projectId: string | null = null): Promise<void> =>
  invoke('save_file', { doc, projectId })

/** Moves the file to `<Documents>/Kiln/.trash`, remembering its project. */
export const desktopDeleteFile = (id: string): Promise<void> => invoke('delete_file', { id })

// ---- projects (subfolders of <Documents>/Kiln with a project.json) ----------

export const desktopListProjects = (): Promise<DesktopProjectMeta[]> => invoke('list_projects')

export const desktopCreateProject = (name: string, color: string | null = null): Promise<DesktopProjectMeta> =>
  invoke('create_project', { name, color })

/** A new name renames the project's folder too. */
export const desktopUpdateProject = (id: string, patch: { name?: string; color?: string }): Promise<DesktopProjectMeta> =>
  invoke('update_project', { id, name: patch.name ?? null, color: patch.color ?? null })

export const desktopRemoveProject = (id: string, mode: 'keep-files' | 'trash-files'): Promise<void> =>
  invoke('remove_project', { id, mode })

/** Moves a file into a project's folder, or to the top level (Drafts) with null. */
export const desktopMoveFile = (id: string, projectId: string | null): Promise<void> => invoke('move_file', { id, projectId })

// ---- trash (<Documents>/Kiln/.trash) ----------------------------------------

export const desktopListTrash = (): Promise<DesktopTrashItem[]> => invoke('list_trash')

export const desktopRestoreTrash = (trashId: string): Promise<void> => invoke('restore_trash', { trashId })

/** Deletes one trash entry for good, or all of them when trashId is null. */
export const desktopPurgeTrash = (trashId: string | null = null): Promise<void> => invoke('purge_trash', { trashId })

export const desktopRevealFolder = (): Promise<void> => invoke('reveal_files_folder')

/** Asks for a folder and writes the files into it. Resolves to the folder path, or null if cancelled. */
export const desktopExport = (files: ExportFile[]): Promise<string | null> => invoke('export_to_folder', { files })

export const desktopAgentStatus = (): Promise<AgentStatus> => invoke('agent_status')

// ---- agent bridge ----------------------------------------------------------

/**
 * Serves `tools` to MCP clients and answers their calls with `handler`.
 * Call again with a new tool list whenever the available tools change.
 * The returned function stops listening and unregisters the tools.
 */
export async function startAgentBridge(
  tools: McpTool[],
  handler: (name: string, args: Record<string, unknown>) => Promise<McpContent[]>,
): Promise<() => void> {
  if (!isTauri) return () => {}

  const unlisten = await listen<AgentCallPayload>(AGENT_CALL_EVENT, (call) => {
    void (async () => {
      let content: McpContent[]
      let isError = false
      try {
        content = await handler(call.name, call.arguments ?? {})
      } catch (err) {
        isError = true
        content = [{ type: 'text', text: err instanceof Error ? err.message : String(err) }]
      }
      try {
        await invoke<boolean>('agent_respond', { callId: call.callId, isError, content })
      } catch (err) {
        console.error('[kiln] agent_respond failed', err)
      }
    })()
  })

  try {
    await invoke<number>('agent_register_tools', { tools })
  } catch (err) {
    unlisten()
    throw err
  }

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    unlisten()
    invoke('agent_register_tools', { tools: [] }).catch(() => {})
  }
}

/** Fires when an MCP client starts or finishes a tool call (e.g. to show "Claude is editing…"). */
export function onAgentActivity(cb: (activity: AgentActivity) => void): Promise<() => void> {
  return listen<AgentActivity>(AGENT_ACTIVITY_EVENT, cb)
}

/** System clipboard text (desktop), bypassing WebKit's native paste callout. */
export const desktopReadClipboard = (): Promise<string | null> => invoke('clipboard_read_text')

const NO_DRAG = 'button, input, textarea, select, a, [role="button"], [role="menu"], [role="listbox"], [data-no-drag], .k-pop'

/**
 * Makes a whole bar drag the desktop window: any press that doesn't land on
 * a control moves the window, and a double-click zooms it (like a title bar).
 * Tauri's `data-tauri-drag-region` only reacts to presses on the element
 * itself, not its children, which left most of the header dead.
 */
export function onWindowDragMouseDown(e: { button: number; detail: number; target: EventTarget | null; preventDefault: () => void }) {
  if (!isTauri || e.button !== 0) return
  const t = e.target as Element | null
  if (!t || t.closest(NO_DRAG)) return
  e.preventDefault()
  void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    const w = getCurrentWindow()
    return e.detail === 2 ? w.toggleMaximize() : w.startDragging()
  })
}
