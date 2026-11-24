import { execFile } from "node:child_process"
import { appendFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { getActiveAgySessions } from "./session.mjs"
import { enqueueAnnotations } from "./inbox.mjs"

const execute = promisify(execFile)
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export function focusedPane(env) {
  if (env.HERDR_ENV !== "1") throw new Error("Run Annotate from a Herdr plugin action.")
  const context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON || "{}")
  if (!context.focused_pane_id) throw new Error("Focus an agent pane before opening Annotate.")
  return context.focused_pane_id
}

// Herdr notifications vanish; keep each popup outcome and declined slash
// interception so a lost review can be traced afterwards.
export async function recordHerdrOutcome(conversationId, status) {
  const log = path.join(os.homedir(), ".local/share/opencode-annotate/agy-review.log")
  const line = `${new Date().toISOString()}\t${conversationId ?? "-"}\t${String(status).replace(/\s+/g, " ")}\n`
  await mkdir(path.dirname(log), { recursive: true, mode: 0o700 })
    .then(() => appendFile(log, line, { mode: 0o600 })).catch(() => {})
}

export async function herdrCommand(bin, args, timeout = 5000) {
  const { stdout } = await execute(bin, args, { timeout })
  return JSON.parse(stdout).result
}

export async function readHerdrAgent(bin, pane, timeout) {
  const agent = (await herdrCommand(bin, ["agent", "get", pane], timeout)).agent
  if (!agent?.terminal_id) throw new Error("Herdr did not identify the focused agent terminal.")
  return agent
}

async function promptHerdrAgent(bin, pane, markdown) {
  try {
    await herdrCommand(bin, ["agent", "prompt", pane, markdown])
  } catch (err) {
    let code
    try { code = JSON.parse(err.stderr).error?.code } catch {}
    if (code === "agent_blocked") throw new Error("AGY is blocked and needs input. Nothing was sent.")
    if (code === "pane_not_found" || code === "agent_not_found" || code === "agent_not_ready") {
      throw new Error("The AGY pane is no longer ready. Nothing was sent.")
    }
    throw new Error("Herdr did not confirm submission. Check the AGY conversation before retrying.")
  }
}

export function resolveHerdrConversation(agent, processes = [], sessions = []) {
  const ref = agent.agent_session
  if (ref) {
    const id = ref.kind === "id" ? ref.value
      : ref.kind === "path" ? /(?:^|[/\\])brain[/\\]([^/\\]+)[/\\]\.system_generated[/\\]logs[/\\]transcript(?:_full)?\.jsonl$/.exec(ref.value)?.[1]
        : undefined
    if (!uuid.test(id ?? "")) throw new Error("Herdr did not report a valid AGY conversation ID.")
    return { conversationId: id, reported: true }
  }
  // A cwd can be shared by multiple AGY panes. Match the live presence lock
  // to the foreground AGY process instead of picking a directory match.
  const pids = new Set(processes.map(p => p.pid))
  const matches = sessions.filter(session => pids.has(session.pid))
  if (matches.length !== 1 || !uuid.test(matches[0].conversationId)) {
    throw new Error("Cannot identify one AGY conversation in this pane. Enable Herdr's Antigravity CLI session integration.")
  }
  return { conversationId: matches[0].conversationId, reported: false, pid: matches[0].pid }
}

export async function captureHerdrConversation(bin, pane, agent) {
  if (agent.agent_session) return resolveHerdrConversation(agent)
  const { process_info } = await herdrCommand(bin, ["pane", "process-info", "--pane", pane])
  return resolveHerdrConversation(agent, process_info.foreground_processes, getActiveAgySessions())
}

export function herdrDeliveryRoute(captured, agent, current) {
  if (agent.agent !== "agy" || agent.terminal_id !== captured.terminalId ||
      current.conversationId !== captured.conversationId ||
      (captured.reported && !current.reported) ||
      (!captured.reported && !current.reported && captured.pid !== current.pid)) {
    throw new Error("The pane no longer matches the captured AGY conversation. Nothing was sent.")
  }
  switch (agent.agent_status) {
    case "idle":
    case "done":
      return "prompt"
    case "working":
      return "inbox"
    case "blocked":
      throw new Error("AGY is blocked and needs input. Nothing was sent.")
    default:
      throw new Error("AGY is not ready to receive feedback: Herdr could not determine its state. Nothing was sent.")
  }
}

export async function deliverHerdrReview(captured, batch, {
  getAgent = readHerdrAgent, getConversation = captureHerdrConversation,
  prompt = promptHerdrAgent,
  enqueue = enqueueAnnotations,
} = {}) {
  const { bin, pane, conversationId } = captured
  const agent = await getAgent(bin, pane)
  if (agent.agent !== "agy") throw new Error("The pane no longer contains AGY. Nothing was sent.")
  const current = await getConversation(bin, pane, agent)
  if (herdrDeliveryRoute(captured, agent, current) === "inbox") {
    await enqueue(conversationId, batch)
    return "Annotations queued for the captured AGY conversation."
  }
  // Herdr blocks a prompt if the pane needs input. Never retry or enqueue
  // after an attempted prompt: a transport error may have followed admission.
  await prompt(bin, pane, batch.markdown)
  return "Annotations submitted to AGY."
}
