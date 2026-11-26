import { spawn } from "node:child_process"
import { mkdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { herdrCommand, readHerdrAgent, recordHerdrOutcome, resolveHerdrConversation } from "./herdr.mjs"
import { inHerdrApp, selectHerdrApp, verifyHerdrAppConversation } from "./herdr-app.mjs"
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
  const args = pid === undefined
    ? [cli, "herdr-slash", pane, conversationId, binary ?? ""]
    : [cli, "herdr-app-slash", conversationId, String(pid)]
  if (document) args.push(document)
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env })
  return new Promise(resolve => {
    child.once("error", () => resolve(false))
    child.once("spawn", () => { child.unref(); resolve(true) })
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

async function wasClaimed(inboxRoot, conversationId, count) {
  return stat(path.join(inboxRoot, conversationId, `.slash-${count}`)).then(
    () => true,
    err => { if (err.code === "ENOENT") return false; throw err },
  )
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
  const useHerdrApp = !(HERDR_ENV === "1" && pane && socket) && inHerdrApp(env)
  if (!useHerdrApp && (HERDR_ENV !== "1" || !pane || !socket)) return decline("not in a Herdr pane")

  try {
    if (useHerdrApp) {
      if (!conversationIdPattern.test(payload.conversationId)) return decline("invalid AGY conversation ID")
      if (await wasClaimed(inboxRoot, payload.conversationId, payload.initialNumSteps)) {
        await record(payload.conversationId, "Herdr.app slash replay ignored")
        return "replayed"
      }
      const opener = await selectApp(env)
      if (!opener) return decline("Herdr.app unavailable or does not know the calling terminal")
      const { pid } = await verifyApp(opener, payload.conversationId)
      const document = await slashDocument(argument, payload.cwd)
      return await launchOnce({ conversationId: payload.conversationId, document, env, pid }, payload, {
        inboxRoot, launch, decline, record,
      })
    }
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

async function launchOnce(review, payload, { inboxRoot, launch, decline, record }) {
  const release = await claimTurn(inboxRoot, payload.conversationId, payload.initialNumSteps)
  if (!release) {
    await record?.(payload.conversationId, "Herdr.app slash replay ignored")
    return "replayed"
  }
  let launched = false
  try {
    launched = await launch(review)
    if (!launched) return decline("popup launcher failed to start")
    await record?.(payload.conversationId, "Herdr.app slash reviewer launch claimed")
    return "opened"
  } finally {
    if (!launched) await release()
  }
}
