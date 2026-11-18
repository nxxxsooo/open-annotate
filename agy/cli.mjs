#!/usr/bin/env node
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, mkdir, rename, rm, readFile, writeFile } from "node:fs/promises"
import { setTimeout as wait } from "node:timers/promises"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { randomUUID, createHash } from "node:crypto"
import { findSessionForDirectory, getActiveAgySessions } from "./session.mjs"
import { extractAgyReplies, defaultBrainDir } from "./transcript.mjs"
import { enqueueAnnotations, listPendingBatches } from "./inbox.mjs"
import { prepareTheme } from "../theme.mjs"
import { createInputSource } from "../input-source.mjs"
import { resolveTuiBinary } from "../tui/binary.mjs"
import { captureHerdrConversation, deliverHerdrReview, focusedPane, herdrCommand, readHerdrAgent } from "./herdr.mjs"

const execute = promisify(execFile)

export function getAdaptedThemeTokens() {
  const rgba = (r, g, b, a = 1) => ({ r: r / 255, g: g / 255, b: b / 255, a })
  const text = rgba(248, 248, 242), bg = rgba(40, 42, 54), accent = rgba(189, 147, 249)
  return {
    text: { base: text, muted: rgba(98, 114, 164), action: { primary: { selected: accent, focused: bg } },
      feedback: { warning: { base: rgba(241, 250, 140) }, success: { base: rgba(80, 250, 123) }, error: { base: rgba(255, 85, 85) } } },
    background: { base: bg, raised: { base: rgba(33, 34, 44), high: rgba(68, 71, 90) },
      action: { primary: { base: rgba(98, 114, 164), focused: accent } },
      feedback: { success: { base: rgba(80, 250, 123) }, warning: { base: rgba(241, 250, 140) } } },
    border: { base: rgba(68, 71, 90) },
    markdown: { heading: accent, code: rgba(80, 250, 123), link: rgba(139, 233, 253), blockQuote: rgba(98, 114, 164),
      strong: rgba(255, 184, 108), emphasis: rgba(241, 250, 140), listItem: rgba(139, 233, 253),
      linkText: rgba(255, 121, 198), listEnumeration: rgba(80, 250, 123), horizontalRule: rgba(68, 71, 90) },
    diff: { background: { added: rgba(26, 58, 26) } },
  }
}

function usage() {
  console.log(`Usage: agy-annotate <command> [options]

Commands:
  status               Show active AGY sessions and annotation pairing state
  web [target]         Pair browser companion with current AGY session (or open URL/HTML)
  tui [path]           Review latest AGY reply or markdown document in Annotate TUI
  queue                List pending annotations queued for current AGY session

Options:
  --session <id>       Explicit AGY conversation ID (defaults to cwd-matched active session)
  --binary <path>      Override the bundled Annotate TUI executable
  --browser <name>     Browser review: Chrome (default) or Safari (copy only)
`)
}

async function resolveSession(targetId) {
  if (targetId) {
    const sessions = getActiveAgySessions()
    const found = sessions.find(s => s.conversationId === targetId || s.conversationId.startsWith(targetId))
    if (!found) throw new Error(`No active AGY session found with ID "${targetId}"`)
    return found
  }

  const current = findSessionForDirectory(process.cwd())
  if (!current) {
    const active = getActiveAgySessions()
    if (active.length === 0) throw new Error("No active AGY sessions found. Launch 'agy' first.")
    if (active.length === 1) return active[0]
    throw new Error(`Multiple active AGY sessions found (${active.length}). Specify --session <id>.`)
  }
  return current
}

async function cmdStatus() {
  const { listTargets } = await import("../bridge/receiver.mjs")
  const sessions = getActiveAgySessions()
  const targets = await listTargets()

  if (sessions.length === 0) {
    console.log("No active AGY sessions currently running.")
    return
  }

  console.log(`Active AGY Sessions (${sessions.length}):\n`)
  for (const session of sessions) {
    const paired = targets.find(t => t.sessionID === session.conversationId)
    const inbox = await listPendingBatches(session.conversationId)
    const pairedStatus = paired ? `paired (target ${paired.id.slice(0, 8)})` : "not paired"
    const inboxStatus = inbox.length ? `[${inbox.length} pending annotations]` : "[inbox clear]"

    console.log(`  • [${session.conversationId.slice(0, 8)}] ${session.title}`)
    console.log(`    PID: ${session.pid} | Directory: ${session.directory}`)
    console.log(`    Status: ${pairedStatus} | ${inboxStatus}\n`)
  }
}

async function cmdWeb(targetArg, options) {
  const { listTargets } = await import("../bridge/receiver.mjs")
  const session = await resolveSession(options.session)
  const targets = await listTargets()
  let paired = targets.find(t => t.sessionID === session.conversationId)

  if (!paired) {
    const daemonScript = path.join(path.dirname(new URL(import.meta.url).pathname), "daemon.mjs")
    const args = ["--session", session.conversationId, "--dir", session.directory, "--title", session.title]
    if (session.pid) args.push("--pid", String(session.pid))

    const child = spawn(process.execPath, [daemonScript, ...args], {
      detached: true,
      stdio: "ignore",
    })
    child.unref()

    // Wait briefly for socket registration
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 50))
      const fresh = await listTargets()
      paired = fresh.find(t => t.sessionID === session.conversationId)
      if (paired) break
    }
  }

  console.log(`✓ Session paired for browser review: "${session.title}" (${session.conversationId.slice(0, 8)})`)
  console.log(`  Open the "Annotate" extension and choose this session (Safari copies notes locally).`)

  if (targetArg && targetArg.trim()) {
    const { browserTarget } = await import("../targets.mjs")
    const target = await browserTarget(targetArg, session.directory)
    if (target?.url) {
      console.log(`  Opening target: ${target.url}`)
      if (process.platform === "darwin") {
        const { openInBrowser } = await import("../scripts/browser-target.mjs")
        await openInBrowser(target.url, options)
      }
    }
  }
}

async function cmdQueue(options) {
  const session = await resolveSession(options.session)
  const batches = await listPendingBatches(session.conversationId)

  if (batches.length === 0) {
    console.log(`Inbox is clear for session "${session.title}".`)
    return
  }

  console.log(`Queued Annotations for "${session.title}" (${batches.length} batches):\n`)
  for (const [index, batch] of batches.entries()) {
    console.log(`Batch ${index + 1} (${batch.batchID}) - Created ${batch.createdAt}:`)
    console.log(batch.markdown)
    console.log("\n--------------------------------------------------\n")
  }
}

export async function selectTuiOpener({ env, tty, exec = execute }) {
  if (env.HERDR_ENV === "1" && env.HERDR_PANE_ID) {
    const bin = env.HERDR_BIN_PATH || "herdr"
    const response = await exec(bin, ["pane", "get", env.HERDR_PANE_ID], { env, timeout: 2000 }).catch(() => null)
    if (response) {
      const { result } = JSON.parse(response.stdout)
      if (result?.pane?.pane_id && result.pane.tab_id) return { kind: "herdr", bin, pane: result.pane }
    }
  }
  const calledByAgent = Boolean(env.ANTIGRAVITY_CONVERSATION_ID || env.ANTIGRAVITY_AGENT || env.AGENT_TOOL_CALL)
  return { kind: tty && !calledByAgent ? "tty" : "window" }
}

async function openTuiWindow(directory, title) {
  const launcher = path.join(directory, "launch.sh")
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  const windowTitle = `Annotate: ${title}`.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
  const command = [process.execPath, fileURLToPath(import.meta.url), "tui-pane", directory].map(quote).join(" ")
  await writeFile(launcher, `#!/bin/sh\nprintf '\\033]0;%s\\007' ${quote(windowTitle)}\nexec ${command}\n`, { mode: 0o700 })
  try {
    await execute("open", ["-na", "Ghostty", "--args", "--window-width=172", "--window-height=48", `--title=${windowTitle}`, "-e", launcher])
  } catch {
    try {
      await execute("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(quote(launcher))}`, "-e", 'tell application "Terminal" to activate'])
    } catch (err) {
      throw new Error(`Failed to spawn interactive review window: ${err.message}`)
    }
  }
}

async function openHerdrTui({ bin, pane }, directory) {
  // Herdr overlays belong to the active pane; --target-pane is split-only.
  if (!pane.focused) throw new Error("Focus the AGY pane in Herdr and retry /annotate.")
  try {
    const { stdout } = await execute(bin, [
      "plugin", "pane", "open", "--plugin", "annotate", "--entrypoint", "agy",
      "--placement", "overlay",
      "--focus", "--cwd", directory, "--env", `ANNOTATE_AGY_REVIEW_DIR=${directory}`,
    ], { timeout: 5000 })
    const opened = JSON.parse(stdout).result?.plugin_pane?.pane
    if (!opened?.pane_id) throw new Error("Herdr did not return the opened pane ID.")
    if (opened.tab_id !== pane.tab_id) {
      await execute(bin, ["pane", "close", opened.pane_id], { timeout: 2000 })
      throw new Error("Herdr placed the overlay outside the AGY tab. Focus the AGY tab and try again.")
    }
    return opened.pane_id
  } catch (err) {
    throw new Error(`Failed to open the Herdr review overlay. Check that the annotate plugin has the agy pane entrypoint.\n${err.message}`)
  }
}

function runReviewer({ binary, snapshotFile, env }, directory) {
  const child = spawn(binary, [snapshotFile], {
    cwd: directory,
    env: { ...process.env, ...env },
    stdio: "inherit",
  })
  return new Promise((resolve, reject) => {
    child.on("exit", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Reviewer exited with ${signal || code}.`))
    })
    child.on("error", reject)
  })
}

async function runTuiPane(directory) {
  if (!directory || !path.isAbsolute(directory)) throw new Error("Missing AGY review directory.")
  let result = "closed"
  try {
    const request = JSON.parse(await readFile(path.join(directory, "request.json"), "utf8"))
    if (request.sourcePane && focusedPane(process.env) !== request.sourcePane) {
      throw new Error("Herdr focus changed before the popup opened. Open Annotate again from the AGY pane.")
    }
    await runReviewer(request, directory)
  } catch (err) {
    result = err.message
  }
  await writeFile(path.join(directory, "done.tmp"), result, { mode: 0o600 })
  await rename(path.join(directory, "done.tmp"), path.join(directory, "done"))
}

async function readOptional(file) {
  return readFile(file, "utf8").catch(err => {
    if (err.code !== "ENOENT") throw err
    return null
  })
}

async function waitForTuiPane(directory, herdrPane) {
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    const result = await readOptional(path.join(directory, "done"))
    if (result === "closed") return true
    if (result !== null) throw new Error(result)
    if (herdrPane) {
      const { bin, id } = herdrPane
      const missing = await execute(bin, ["pane", "get", id], { timeout: 2000 }).then(() => false, err => {
        try { return JSON.parse(err.stderr).error?.code === "pane_not_found" } catch { return false }
      })
      if (missing && await readOptional(path.join(directory, "done")) === null) return false
    }
    await wait(500)
  }
  throw new Error("Timed out waiting for Annotate.")
}

// The hook is the only feedback channel. Neither the pane nor the waiting tool
// returns the Markdown, and no other pending batch can finish this review.
export async function finishTuiReview({ intentPath, conversationId, header, exportFeedback, enqueue = enqueueAnnotations, deliver }) {
  if (await readOptional(intentPath) !== "send\n") return "Review closed without sending annotations."
  const feedback = (await exportFeedback()).trim()
  if (!feedback || feedback === "No annotations.") return "No annotations to send."
  const batch = {
    batchID: `tui-${randomUUID()}`,
    markdown: `${header}\n\n${feedback}`,
    promptID: `msg_${randomUUID()}`,
  }
  if (deliver) return deliver(batch)
  await enqueue(conversationId, batch)
  return "Annotations queued for this AGY conversation. The lifecycle hook will deliver them."
}

async function cmdTui(targetPath, options) {
  const session = await resolveSession(options.session || process.env.ANTIGRAVITY_CONVERSATION_ID)
  const binary = path.resolve(resolveTuiBinary(options.binary))
  const opener = await selectTuiOpener({ env: process.env, tty: process.stdin.isTTY })
  await reviewTui(targetPath, { session, binary, opener })
}

async function cmdHerdrReview(options) {
  const bin = process.env.HERDR_BIN_PATH || "herdr"
  const binary = path.resolve(resolveTuiBinary(options.binary))
  try {
    const pane = focusedPane(process.env)
    const agent = await readHerdrAgent(bin, pane)
    if (["claude", "codex", "pi", "opencode"].includes(agent.agent)) {
      const { stdout } = await execute(binary, ["herdr", "last", "--newest", "--deliver-to", pane], { timeout: 5000 })
      console.log(stdout.trim())
      return
    }
    if (agent.agent !== "agy") throw new Error("This action supports AGY, Claude, Codex, Pi, and OpenCode panes.")
    const captured = { ...await captureHerdrConversation(bin, pane, agent), bin, pane, terminalId: agent.terminal_id }
    const session = { conversationId: captured.conversationId, title: `AGY ${captured.conversationId.slice(0, 8)}` }
    const status = await reviewTui(null, { session, binary, opener: { kind: "popup" }, captured })
    if (status) await herdrCommand(bin, ["notification", "show", "Annotate", "--body", status]).catch(() => {})
  } catch (err) {
    await herdrCommand(bin, ["notification", "show", "Annotate", "--body", err.message]).catch(() => {})
    throw err
  }
}

async function reviewTui(targetPath, { session, binary, opener, captured }) {
  let sourceText = ""
  let snapshotName = "last-reply.md"
  let filePath = null
  let sourceHash = null

  if (targetPath) {
    const resolvedPath = path.resolve(session.directory, targetPath)
    sourceText = await readFile(resolvedPath, "utf8")
    filePath = resolvedPath
    snapshotName = path.basename(resolvedPath)
    sourceHash = createHash("sha256").update(Buffer.from(sourceText)).digest("hex")
  } else {
    const [latest] = await extractAgyReplies(defaultBrainDir(session.conversationId), { latestOnly: true })
    if (!latest || !latest.text.trim()) {
      throw new Error(`No completed assistant replies found in session "${session.title}".`)
    }
    sourceText = latest.text
    snapshotName = `reply-${latest.id}.md`
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agy-annotate-"))
  const snapshotFile = path.join(tempDir, snapshotName)
  const dataDir = path.join(tempDir, "data")
  const intentPath = path.join(tempDir, "send-intent")

  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await writeFile(snapshotFile, sourceText, { mode: 0o600 })

  const inputSource = createInputSource()
  let textSource
  let complete = false

  try {
    // Keep ASCII active before the first usable frame. Run the switch alongside
    // theme setup, but wait for it even if the theme fails so it can be restored.
    const [themedResult] = await Promise.allSettled([
      prepareTheme({ binary, theme: getAdaptedThemeTokens(), directory: tempDir, env: process.env }),
      inputSource.ascii().then(previous => { textSource = previous }),
    ])
    if (themedResult.status === "rejected") throw themedResult.reason
    const themed = themedResult.value
    const env = {
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_FEEDBACK_HISTORY: "0",
      PLANNOTATOR_TUI_SEND_INTENT: intentPath,
      PLANNOTATOR_TUI_EXPLICIT_SEND: "1",
    }
    if (themed.PLANNOTATOR_TUI_CONFIG) env.PLANNOTATOR_TUI_CONFIG = themed.PLANNOTATOR_TUI_CONFIG

    if (inputSource.command && textSource) {
      env.PLANNOTATOR_TUI_INPUT_SOURCE = inputSource.command
      env.PLANNOTATOR_TUI_TEXT_INPUT_SOURCE = textSource
    }
    const request = { binary, snapshotFile, env, sourcePane: captured?.pane }
    if (opener.kind === "tty") {
      await runReviewer(request, tempDir)
    } else {
      await writeFile(path.join(tempDir, "request.json"), JSON.stringify(request), { mode: 0o600 })
      let herdrPane
      if (captured) {
        const { bin } = captured
        const popupEnv = {
          ...env,
          PLANNOTATOR_TUI_FILE: snapshotFile,
          ANNOTATE_AGY_REVIEW_DIR: tempDir,
          ANNOTATE_AGY_SOURCE_PANE: captured.pane,
        }
        const result = await herdrCommand(bin, [
          "plugin", "pane", "open", "--plugin", process.env.HERDR_PLUGIN_ID || "annotate",
          "--entrypoint", "agy-popup", "--cwd", tempDir,
          ...Object.entries(popupEnv).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        ])
        if (result?.type !== "ok") throw new Error("The agy-popup entrypoint must declare placement = \"popup\".")
      } else if (opener.kind === "herdr") herdrPane = { bin: opener.bin, id: await openHerdrTui(opener, tempDir) }
      else await openTuiWindow(tempDir, session.title)
      console.log(`Opened Annotate ${opener.kind === "herdr" ? "overlay" : opener.kind}. Waiting for Send or quit…`)
      if (!await waitForTuiPane(tempDir, herdrPane)) {
        console.log(`Review pane closed without sending. Review files retained at ${tempDir}`)
        return
      }
    }

    const status = await finishTuiReview({
      intentPath,
      conversationId: session.conversationId,
      deliver: captured && (batch => deliverHerdrReview(captured, batch)),
      header: filePath
        ? `Annotations on document \`${filePath}\` (SHA-256: ${sourceHash}):`
        : `Annotations on latest assistant response in session "${session.title}":`,
      exportFeedback: async () => {
        const { stdout } = await execute(binary, ["--export", snapshotFile], {
          cwd: tempDir, env: { ...process.env, ...env }, timeout: 15000,
        })
        await writeFile(path.join(tempDir, "feedback.md"), stdout, { mode: 0o600 })
        return stdout
      },
    })
    complete = true
    console.log(status)
    return status
  } catch (err) {
    throw new Error(`${err.message} Review files retained at ${tempDir}`, { cause: err })
  } finally {
    await inputSource.select(textSource)
    if (complete) await rm(tempDir, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    usage()
    return
  }

  const command = args[0]
  if (command === "tui-pane") {
    await runTuiPane(args[1] || process.env.ANNOTATE_AGY_REVIEW_DIR)
    return
  }
  const options = {}
  let posArg = null

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--session") {
      options.session = args[++i]
    } else if (args[i] === "--binary") {
      options.binary = args[++i]
    } else if (args[i] === "--browser") {
      options.browser = args[++i]
    } else if (!args[i].startsWith("-") && !posArg) {
      posArg = args[i]
    }
  }

  switch (command) {
    case "status":
      await cmdStatus()
      break
    case "web":
      await cmdWeb(posArg, options)
      break
    case "tui":
      await cmdTui(posArg, options)
      break
    case "herdr-review":
      await cmdHerdrReview(options)
      break
    case "queue":
      await cmdQueue(options)
      break
    default:
      console.error(`Unknown command: "${command}"`)
      usage()
      process.exit(1)
  }
}

const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isDirectExecution) {
  main().catch(err => {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  })
}
