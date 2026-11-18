/**
 * Bring-your-own-agent bridge: runs the user's own agent CLIs (Claude Code,
 * Codex, Gemini CLI, Cursor Agent, OpenCode) against Kiln's local MCP server.
 * Kiln never handles the user's tokens; each CLI uses its own login.
 *
 * Safe to import in the web build: `@tauri-apps/api` is only loaded through
 * dynamic imports, and commands throw a clear error outside the desktop app.
 */

import { isTauri } from './tauri'

export type AgentCliId = 'claude' | 'codex' | 'gemini' | 'cursor-agent' | 'opencode'

export interface CliInfo {
  id: AgentCliId
  name: string
  installed: boolean
  /** absolute path of the executable that will be run */
  path: string | null
  /** first line of `<cli> --version` */
  version: string | null
  /** set when the CLI is installed but `--version` failed (e.g. a broken install) */
  error: string | null
}

/** One line of a running CLI's output (stream-json lines for claude/codex/cursor-agent/gemini). */
export interface CliOutput {
  runId: string
  stream: 'stdout' | 'stderr'
  line: string
}

/** Emitted exactly once per run, after all of its output. */
export interface CliExit {
  runId: string
  /** null when the process was killed by a signal */
  code: number | null
  /** e.g. "cancelled", "timed out after 20 minutes", "terminated by signal 9" */
  error: string | null
}

export interface AgentConnectSnippet {
  /** claude | codex | gemini | cursor | vscode | zed | windsurf | opencode */
  cli: string
  title: string
  /** shell command or JSON to paste */
  command: string
}

export interface RunAgentCliOptions {
  /** caller-chosen unique id, used to match output/exit events and to cancel */
  runId: string
  cli: AgentCliId
  prompt: string
  model?: string
  /** reasoning / effort level, from the CLI's own list (claude and codex only) */
  effort?: string
  /** session id to resume (claude and cursor-agent only; ignored by the others) */
  resume?: string
  /** images attached to the prompt: the desktop side writes them to files the CLI can read */
  images?: CliImage[]
}

export interface CliImage {
  name: string
  mediaType: string
  /** base64, without the data: prefix */
  data: string
}

export const CLI_OUTPUT_EVENT = 'kiln://cli-output'
export const CLI_EXIT_EVENT = 'kiln://cli-exit'

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

/** Finds the known CLIs using the user's login-shell PATH. Takes a few seconds the first time. */
export const detectAgentClis = (): Promise<CliInfo[]> => invoke('agent_cli_detect')

/** A model an installed CLI says this account can use. */
export interface CliModel {
  id: string
  label: string
  /** the CLI marks it as its current / default model */
  current?: boolean
}

/**
 * Asks the installed CLI for its models (Cursor Agent: `cursor-agent models`; OpenCode:
 * `opencode models`). Empty for CLIs without a listing command or not installed; rejects with
 * a readable message (e.g. "not signed in"). Cached per app session unless `refresh`.
 */
export const listCliModels = (cli: AgentCliId, refresh = false): Promise<CliModel[]> => invoke('agent_cli_models', { cli, refresh })

/**
 * Starts a run. Resolves once the process has spawned; output and the exit
 * arrive as events, so subscribe with `onCliOutput`/`onCliExit` first.
 */
export const runAgentCli = ({ runId, cli, prompt, model, effort, resume, images }: RunAgentCliOptions): Promise<void> =>
  invoke('agent_cli_run', { runId, cli, prompt, model: model ?? null, effort: effort ?? null, resume: resume ?? null, images: images ?? [] })

/** Stops a run and its subprocesses. Resolves to false if the run is not active. */
export const cancelAgentCli = (runId: string): Promise<boolean> => invoke('agent_cli_cancel', { runId })

/**
 * Registers Kiln's MCP server in the CLI's own user config, so the user's
 * terminal sessions can use it too. Resolves to the CLI's output.
 * Rejects for OpenCode, with the JSON to add manually.
 */
export const connectAgentCli = (cli: AgentCliId): Promise<string> => invoke('agent_cli_connect', { cli })

/** Copy-paste setup text for other MCP clients, using the live server URL. */
export const agentConnectSnippets = (): Promise<AgentConnectSnippet[]> => invoke('agent_cli_connect_snippets')

export function onCliOutput(cb: (output: CliOutput) => void): Promise<() => void> {
  return listen<CliOutput>(CLI_OUTPUT_EVENT, cb)
}

export function onCliExit(cb: (exit: CliExit) => void): Promise<() => void> {
  return listen<CliExit>(CLI_EXIT_EVENT, cb)
}
