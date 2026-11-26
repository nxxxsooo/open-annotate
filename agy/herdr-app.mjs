import { execFile } from "node:child_process"
import path from "node:path"
import { setTimeout as wait } from "node:timers/promises"
import { promisify } from "node:util"
import { enqueueAnnotations } from "./inbox.mjs"
import { getActiveAgySessions } from "./session.mjs"

const execute = promisify(execFile)
const localAddress = /^t[0-9a-z]+$/
const peekAttempts = 30
const peekPause = 100

export function inHerdrApp(env) {
  // A local app terminal has a core address, not a name or a remote address.
  return localAddress.test(env.HC_TERMINAL_ID ?? "") && Boolean(env.HC_TERMINAL_SOCKET)
}

async function json(exec, bin, args, env, timeout = 350) {
  const { stdout } = await exec(bin, args, { env, timeout })
  return JSON.parse(stdout)
}

export async function appPlacement({ parent, env }, exec = execute) {
  const [{ spaces }, status] = await Promise.all([
    json(exec, "herdr-app", ["ls"], env),
    json(exec, "herdr-app", ["status"], env),
  ])
  if (!Array.isArray(status.overlays)) throw new Error("Herdr.app did not report its overlays.")
  const locations = spaces.filter(space => space.machine === null).flatMap(space =>
    space.tabs.flatMap(tab => tab.terminals.map(host => ({ space: space.id, tab: tab.id, host }))))
  const visited = new Set()
  for (let id = parent; localAddress.test(id ?? "") && !visited.has(id);) {
    visited.add(id)
    const location = locations.find(({ host }) => host.terminal === id) ??
      locations.find(({ host }) => host.pane && host.sub_agents?.includes(id))
    if (location) {
      const { space, tab, host } = location
      // A pane's own terminal keeps its pane-based focus rule. A child
      // shares that pane and must also be the agent shown in it.
      const focused = status.space === space && status.tab === tab &&
        Boolean(host.pane) && status.focused_pane === host.pane &&
        (host.terminal === parent || status.agent === parent) &&
        status.overlays.every(id => id === "toast")
      return { focused, space, tab, host: host.terminal }
    }
    // Herdr.app lists direct sub-agents only; follow hc ancestry for deeper children.
    const terminal = await readTerminal({ env }, id, exec)
    if (terminal.address !== id || terminal.state !== "live") break
    id = terminal.parent
  }
  throw new Error("Herdr.app does not know the calling terminal as a local pane or sub-agent.")
}

export function herdrAppOpener(env) {
  if (!inHerdrApp(env)) return null
  return { kind: "herdr-app", parent: env.HC_TERMINAL_ID, env }
}

export async function selectHerdrApp(env, exec = execute) {
  const opener = herdrAppOpener(env)
  return opener && appPlacement(opener, exec).then(() => opener, () => null)
}

async function readTerminal({ env }, terminal, exec) {
  return json(exec, "hc", ["get", terminal, "--json"], env)
}

async function tabLabels(opener, placement, exec) {
  const { labels } = await readTerminal(opener, placement.host, exec)
  if (labels?.["herdr.space"] !== placement.space || labels?.["herdr.tab"] !== placement.tab) {
    throw new Error(`Herdr.app and hc disagree on terminal ${placement.host}'s tab.`)
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
    const retryUntil = performance.now() + peekAttempts * peekPause
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
        if (!notReady || attempt + 1 === peekAttempts || performance.now() + peekPause >= retryUntil) throw err
        await pause(peekPause)
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
  const { parent, env } = opener
  const [terminal, { stdout }] = await Promise.all([
    readTerminal(opener, parent, exec),
    exec("ps", ["-A", "-o", "pid=,ppid=,comm="], { env, timeout: 350 }),
  ])
  const root = terminal.pid
  if (terminal.address !== parent || terminal.state !== "live" || !Number.isSafeInteger(root) || root <= 0) {
    throw new Error(`hc does not report a live process for terminal ${parent}`)
  }
  // The foreground can be a shell or PTY proxy. Use the terminal's own
  // process as the root and require an AGY presence lock within its tree.
  const agyPids = agyProcessesUnder(root, stdout)
  if (!agyPids.size) throw new Error(`no AGY process under hc terminal ${parent}`)
  const matches = sessions(undefined, { pids: agyPids }).filter(session => agyPids.has(session.pid))
  if (!matches.length) throw new Error(`no AGY session presence lock under hc terminal ${parent}`)
  if (matches.length > 1) throw new Error(`${matches.length} AGY sessions under hc terminal ${parent}`)
  const [match] = matches
  if (match.conversationId !== conversationId || (pid !== undefined && match.pid !== pid)) {
    throw new Error("AGY terminal no longer matches the captured conversation")
  }
  const status = terminal.status
  const state = ["agy", "antigravity"].includes(status?.app) ? status.state : undefined
  if (state === "blocked") throw new Error("AGY is blocked and needs input. Nothing was sent.")
  if (!["idle", "done", "working"].includes(state)) {
    throw new Error("AGY is not ready to receive feedback: hc could not determine its state. Nothing was sent.")
  }
  return { pid: match.pid, state }
}

function agyProcessesUnder(root, snapshot) {
  const children = new Map()
  const agyPids = new Set()
  for (const line of snapshot.trimEnd().split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    if (!row) continue
    const processId = Number(row[1])
    const parentId = Number(row[2])
    if (!children.has(parentId)) children.set(parentId, [])
    children.get(parentId).push(processId)
    if (path.basename(row[3]) === "agy") agyPids.add(processId)
  }
  // Set iteration visits newly added children and also covers direct launches.
  const tree = new Set([root])
  for (const processId of tree) {
    for (const child of children.get(processId) ?? []) tree.add(child)
  }
  return new Set([...agyPids].filter(processId => tree.has(processId)))
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
