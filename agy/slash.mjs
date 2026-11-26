import { spawn } from "node:child_process"
import { mkdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { herdrCommand, readHerdrAgent, recordHerdrOutcome, resolveHerdrConversation } from "./herdr.mjs"
import { herdrAppOpener, selectHerdrApp, verifyHerdrAppConversation } from "./herdr-app.mjs"
import { defaultInboxRoot } from "./inbox.mjs"

const conversationIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export function annotateSlash(text) {
  if (typeof text !== "string" || /[\r\n\0]/.test(text)) return undefined
  const match = /^\/annotate(?:[ \t]+(.+))?$/.exec(text.trim())
  if (!match) return undefined
  let argument = match[1]
  if (!argument) return null
  const quote = argument[0]
  if (quote === '"' || quote === "'") {
    if (argument.length < 3 || !argument.endsWith(quote)) return undefined
    argument = argument.slice(1, -1)
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(argument) || /\.html?$/i.test(argument)) return undefined
  return argument
}

function start({ pane, conversationId, document, binary, env, pid }) {
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url))
  const isApp = pid !== undefined
  const args = isApp
    ? [cli, "herdr-app-slash", conversationId, String(pid)]
    : [cli, "herdr-slash", pane, conversationId, binary ?? ""]
  if (document) args.push(document)
  const stdio = isApp ? ["ignore", "ignore", "ignore", "ipc"] : "ignore"
  const child = spawn(process.execPath, args, { detached: true, stdio, env })
  if (isApp) return waitForAppLaunch(child)
  return new Promise(resolve => {
    child.once("error", () => resolve(false))
    child.once("spawn", () => { child.unref(); resolve(true) })
  })
}

function waitForAppLaunch(child) {
  return new Promise((resolve, reject) => {
    // Leave time for the hook to report an error before AGY's 15s deadline.
    const timeout = setTimeout(() => {
      if (child.connected) child.disconnect()
      reject(new Error("timed out waiting for the Herdr.app reviewer to open"))
    }, 10_000)
    const fail = err => { clearTimeout(timeout); reject(err) }
    child.once("error", fail)
    child.once("disconnect", () => fail(new Error("reviewer launcher exited before opening")))
    child.once("message", message => {
      clearTimeout(timeout)
      if (message.opened === true) resolve(true)
      else reject(new Error(message.error))
    })
    child.unref()
  })
}

async function claimTurn(inboxRoot, conversationId, count) {
  const inbox = path.join(inboxRoot, conversationId)
  await mkdir(inbox, { recursive: true, mode: 0o700 })
  // AGY can replay invocation zero after a custom termination. The step
  // count stays fixed on replay and advances on a newly submitted command.
  const claim = path.join(inbox, `.slash-${count}`)
  try {
    await mkdir(claim, { mode: 0o700 })
    return () => rm(claim, { force: true, recursive: true })
  } catch (err) {
    if (err.code !== "EEXIST") throw err
    return null
  }
}

export async function interceptAnnotateSlash(payload, {
  env = process.env, readAgent = readHerdrAgent, command = herdrCommand, launch = start,
  inboxRoot = defaultInboxRoot(), record = recordHerdrOutcome,
  selectApp = selectHerdrApp, verifyApp = verifyHerdrAppConversation,
} = {}) {
  const argument = annotateSlash(payload.lastUserInput)
  if (argument === undefined) return false
  const decline = async reason => {
    await record(payload.conversationId, `slash not intercepted: ${reason}`)
    return false
  }
  const { HERDR_ENV, HERDR_PANE_ID: pane, HERDR_SOCKET_PATH: socket, HERDR_BIN_PATH: bin = "herdr" } = env
  if (payload.invocationNum !== 0 || !Number.isSafeInteger(payload.initialNumSteps) ||
      payload.initialNumSteps < 1 || !payload.conversationId) {
    return decline(`payload invocationNum=${payload.invocationNum} initialNumSteps=${payload.initialNumSteps}`)
  }
  const inHerdrPane = HERDR_ENV === "1" && pane && socket
  const opener = !inHerdrPane && herdrAppOpener(env)
  if (opener) {
    const { conversationId, initialNumSteps, cwd } = payload
    if (!conversationIdPattern.test(conversationId)) return decline("invalid AGY conversation ID")
    try {
      if (!await claimTurn(inboxRoot, conversationId, initialNumSteps)) {
        await record(conversationId, "Herdr.app slash replay ignored")
        return "replayed"
      }
      const [selection, verification, file] = await Promise.allSettled([
        selectApp(env),
        verifyApp(opener, conversationId),
        slashDocument(argument, cwd),
      ])
      if (selection.status === "rejected") throw selection.reason
      if (!selection.value) throw new Error("Herdr.app unavailable or does not know the calling terminal")
      if (verification.status === "rejected") throw verification.reason
      if (file.status === "rejected") throw file.reason
      if (!await launch({ conversationId, document: file.value, env, pid: verification.value.pid })) {
        throw new Error("popup launcher failed to start")
      }
      await record(conversationId, "Herdr.app slash reviewer launch claimed")
      return "opened"
    } catch (err) {
      const reason = err?.message || String(err)
      await record(conversationId, `Herdr.app slash error: ${reason}`)
      return { reason }
    }
  }
  if (!inHerdrPane) return decline("not in a Herdr pane")

  try {
    const [agent, pluginList] = await Promise.all([
      readAgent(bin, pane, 200),
      command(bin, ["plugin", "list", "--json"], 200),
    ])
    if (agent.agent !== "agy") return decline(`pane agent is ${agent.agent}`)
    if (!agent.focused) return decline("AGY pane not focused")
    if (!agent.agent_session) return decline("Herdr reports no AGY session")
    if (resolveHerdrConversation(agent).conversationId !== payload.conversationId) {
      return decline("Herdr session does not match the conversation")
    }
    const plugin = pluginList?.plugins?.find(plugin => plugin.plugin_id === "annotate" && plugin.enabled)
    const popup = plugin?.panes?.find(pane => pane.id === "agy-popup" && pane.placement === "popup")
    if (!popup) return decline("annotate plugin has no agy-popup entrypoint")
    const [executable, namespace, entrypoint] = popup.command ?? []
    const binary = namespace === "herdr" && entrypoint === "hosted-pane" && path.isAbsolute(executable)
      ? executable : undefined
    const document = await slashDocument(argument, payload.cwd)
    return await launchOnce({ pane, conversationId: payload.conversationId, document, binary, env }, payload, {
      inboxRoot, launch, decline,
    })
  } catch (err) {
    return decline(err.message)
  }
}

async function slashDocument(argument, cwd) {
  if (argument === null) return undefined
  if (!path.isAbsolute(cwd ?? "")) throw new Error("relative cwd")
  const document = path.resolve(cwd, argument)
  if (!(await stat(document)).isFile()) throw new Error("document is not a file")
  return document
}

async function launchOnce(review, payload, { inboxRoot, launch, decline }) {
  const release = await claimTurn(inboxRoot, payload.conversationId, payload.initialNumSteps)
  if (!release) return "replayed"
  let launched = false
  try {
    launched = await launch(review)
    if (!launched) return decline("popup launcher failed to start")
    return "opened"
  } finally {
    if (!launched) await release()
  }
}
