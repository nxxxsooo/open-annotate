import { execFile } from "node:child_process"
import { setTimeout as wait } from "node:timers/promises"
import { promisify } from "node:util"
import { enqueueAnnotations } from "./inbox.mjs"
import { getActiveAgySessions } from "./session.mjs"

const execute = promisify(execFile)
const localAddress = /^t[0-9a-z]+$/

export function inHerdrApp(env) {
  // A local app terminal has a core address, not a name or a remote address.
  return localAddress.test(env.HC_TERMINAL_ID ?? "") && Boolean(env.HC_TERMINAL_SOCKET)
}

async function json(exec, bin, args, env, timeout = 350) {
  const { stdout } = await exec(bin, args, { env, timeout })
  return JSON.parse(stdout)
}

async function appPlacement({ parent, env }, exec) {
  const { spaces } = await json(exec, "herdr-app", ["ls"], env)
  const status = await json(exec, "herdr-app", ["status"], env)
  if (!Array.isArray(status.overlays)) throw new Error("Herdr.app did not report its overlays.")
  for (const space of spaces) {
    if (space.machine !== null) continue
    for (const tab of space.tabs) {
      const terminal = tab.terminals.find(item => item.terminal === parent)
      if (terminal) {
        // status.agent can name a different agent from the focused pane.
        // Toasts leave the pane's keyboard focus alone.
        const focused = status.space === space.id && status.tab === tab.id &&
          Boolean(terminal.pane) && status.focused_pane === terminal.pane &&
          status.overlays.every(id => id === "toast")
        return { focused, space: space.id, tab: tab.id }
      }
    }
  }
  throw new Error("Herdr.app does not know the calling terminal as a local pane.")
}

export async function selectHerdrApp(env, exec = execute) {
  if (!inHerdrApp(env)) return null
  const opener = { kind: "herdr-app", parent: env.HC_TERMINAL_ID, env }
  return appPlacement(opener, exec).then(() => opener, () => null)
}

async function readTerminal({ env }, terminal, exec) {
  return json(exec, "hc", ["get", terminal, "--json"], env)
}

async function tabLabels(opener, placement, exec) {
  const { labels } = await readTerminal(opener, opener.parent, exec)
  if (labels?.["herdr.space"] !== placement.space || labels?.["herdr.tab"] !== placement.tab) {
    throw new Error("Herdr.app and hc disagree on the calling terminal's tab.")
  }
  return [`herdr.space=${placement.space}`, `herdr.tab=${placement.tab}`]
}

function commandError(err) {
  try { return JSON.parse(err.stderr || err.stdout).error } catch { return undefined }
}

export async function openHerdrAppTui(opener, directory, argv, { exec = execute, pause = wait } = {}) {
  const { parent, env } = opener
  let id
  try {
    const placement = await appPlacement(opener, exec)
    const labels = placement.focused ? [] : await tabLabels(opener, placement, exec)
    const terminal = await json(exec, "hc", [
      "run", "--bg", "--json", "--parent", parent, "--no-notify", "--rm", "--cwd", directory,
      ...labels.flatMap(label => ["--label", label]),
      "--", ...argv,
    ], env, 5000)
    if (!localAddress.test(terminal.address ?? "")) throw new Error("hc did not return a local terminal ID.")
    id = terminal.address
    if (labels.length) return { ...opener, id, peek: false }

    // A newly spawned child may take a few frames to appear in the app.
    for (let attempt = 0; ; attempt++) {
      const current = await appPlacement(opener, exec)
      if (!current.focused) {
        const labels = await tabLabels(opener, current, exec)
        await exec("hc", ["label", id, ...labels], { env, timeout: 350 })
        return { ...opener, id, peek: false }
      }
      try {
        const result = await json(exec, "herdr-app", ["do", "terminal.peek", "--terminal", id], env)
        if (result.ok !== true) throw new Error(result.error ?? "Herdr.app did not confirm the peek.")
        return { ...opener, id, peek: true }
      } catch (err) {
        const detail = commandError(err) ?? err.message
        const notReady = detail === `no running terminal "${id}"` || detail === "no running terminal"
        if (attempt === 4 || !notReady) throw err
        await pause(80)
      }
    }
  } catch (err) {
    const detail = commandError(err)
    const message = detail?.message ?? detail ?? err.message
    if (id) {
      try {
        await exec("hc", ["kill", id], { env, timeout: 350 })
      } catch (cleanup) {
        if (commandError(cleanup)?.kind !== "not_found" && commandError(cleanup)?.kind !== "finished") {
          throw new Error(`Failed to open the Herdr.app review: ${message}. Could not stop reviewer terminal ${id}: ${cleanup.message}`)
        }
      }
    }
    throw new Error(`Failed to open the Herdr.app review: ${message}`, { cause: err })
  }
}

export async function herdrAppTerminalGone(opener, exec = execute) {
  try {
    const terminal = await readTerminal(opener, opener.id, exec)
    if (terminal.state === "live") return false
    if (terminal.state === "finished") return true
    throw new Error(`hc did not report a live or finished state for terminal ${opener.id}.`)
  } catch (err) {
    const kind = commandError(err)?.kind
    if (kind === "not_found" || kind === "finished") return true
    throw err
  }
}

export async function verifyHerdrAppConversation(opener, conversationId, {
  exec = execute, sessions = getActiveAgySessions, pid,
} = {}) {
  const terminal = await readTerminal(opener, opener.parent, exec)
  const foreground = terminal.foreground
  if (terminal.address !== opener.parent || terminal.state !== "live" ||
      foreground?.name !== "agy" || !Number.isSafeInteger(foreground.pid)) {
    throw new Error("hc does not report a live foreground AGY process")
  }
  // Core status can be absent and its records can include more than one
  // session. Match the foreground process to AGY's live presence lock.
  const matches = sessions().filter(session => session.pid === foreground.pid)
  if (matches.length !== 1) throw new Error("AGY foreground PID has no unique conversation presence lock")
  if (matches[0].conversationId !== conversationId || (pid !== undefined && foreground.pid !== pid)) {
    throw new Error("AGY terminal no longer matches the captured conversation")
  }
  const status = terminal.status
  const state = ["agy", "antigravity"].includes(status?.app) ? status.state : undefined
  if (state === "blocked") throw new Error("AGY is blocked and needs input. Nothing was sent.")
  if (!["idle", "done", "working"].includes(state)) {
    throw new Error("AGY is not ready to receive feedback: hc could not determine its state. Nothing was sent.")
  }
  return { pid: foreground.pid, state }
}

export async function deliverHerdrAppReview(opener, conversationId, pid, batch, {
  verify = verifyHerdrAppConversation, enqueue = enqueueAnnotations, exec = execute,
} = {}) {
  const { state } = await verify(opener, conversationId, { pid })
  if (state === "working") {
    await enqueue(conversationId, batch)
    return "Annotations queued for the captured AGY conversation. The lifecycle hook will deliver them."
  }
  const guard = state === "idle" ? ["--if", "idle"] : []
  try {
    // hc may wait up to a minute for a person's unfinished draft. Never
    // retry or queue after an attempt: the text may already have gone in.
    await exec("hc", ["send", ...guard, opener.parent, batch.markdown], { env: opener.env, timeout: 75_000 })
  } catch (err) {
    const kind = commandError(err)?.kind
    if (kind === "blocked") throw new Error("AGY is blocked and needs input. Nothing was sent.")
    if (["not_found", "finished", "status_mismatch"].includes(kind)) {
      throw new Error("The AGY pane is no longer ready. Nothing was sent.")
    }
    throw new Error("Herdr did not confirm submission. Check the AGY conversation before retrying.")
  }
  return "Annotations submitted to AGY."
}
