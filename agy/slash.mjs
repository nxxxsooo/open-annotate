import { spawn } from "node:child_process"
import { mkdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { herdrCommand, readHerdrAgent, resolveHerdrConversation } from "./herdr.mjs"
import { defaultInboxRoot } from "./inbox.mjs"

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

function start({ pane, conversationId, document, binary, env }) {
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url))
  const args = [cli, "herdr-slash", pane, conversationId, binary ?? ""]
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

export async function interceptAnnotateSlash(payload, {
  env = process.env, readAgent = readHerdrAgent, command = herdrCommand, launch = start,
  inboxRoot = defaultInboxRoot(),
} = {}) {
  const argument = annotateSlash(payload.lastUserInput)
  const { HERDR_ENV, HERDR_PANE_ID: pane, HERDR_SOCKET_PATH: socket, HERDR_BIN_PATH: bin = "herdr" } = env
  if (argument === undefined || payload.invocationNum !== 0 || !Number.isSafeInteger(payload.initialNumSteps) ||
      payload.initialNumSteps < 1 || !payload.conversationId ||
      HERDR_ENV !== "1" || !pane || !socket) return false

  try {
    const [agent, pluginList] = await Promise.all([
      readAgent(bin, pane, 200),
      command(bin, ["plugin", "list", "--json"], 200),
    ])
    if (agent.agent !== "agy" || !agent.focused || !agent.agent_session ||
        resolveHerdrConversation(agent).conversationId !== payload.conversationId) return false
    const plugin = pluginList?.plugins?.find(plugin => plugin.plugin_id === "annotate" && plugin.enabled)
    const popup = plugin?.panes?.find(pane => pane.id === "agy-popup" && pane.placement === "popup")
    if (!popup) return false
    const [executable, namespace, entrypoint] = popup.command ?? []
    const binary = namespace === "herdr" && entrypoint === "hosted-pane" && path.isAbsolute(executable)
      ? executable : undefined
    let document
    if (argument !== null) {
      if (!path.isAbsolute(payload.cwd ?? "")) return false
      document = path.resolve(payload.cwd, argument)
      if (!(await stat(document)).isFile()) return false
    }
    const release = await claimTurn(inboxRoot, payload.conversationId, payload.initialNumSteps)
    if (!release) return true
    let launched = false
    try {
      launched = await launch({ pane, conversationId: payload.conversationId, document, binary, env })
      return launched
    } finally {
      if (!launched) await release()
    }
  } catch {
    return false
  }
}
