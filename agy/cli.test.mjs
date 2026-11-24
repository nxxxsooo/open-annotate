import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { finishTuiReview, getAdaptedThemeTokens, herdrTuiPlacement, selectTuiOpener } from "./cli.mjs"
import { handlePreInvocation, handleStop } from "./hooks.mjs"
import { enqueueAnnotations } from "./inbox.mjs"
import { bundledBinary, resolveTuiBinary } from "../tui/binary.mjs"
import { prepareTheme } from "../theme.mjs"

test("Herdr opens an overlay only via a reachable calling pane; other calls keep their opener", async () => {
  const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w5:p2", HERDR_BIN_PATH: "/fixture/herdr" }
  const pane = { pane_id: "w5:p2", workspace_id: "w5", tab_id: "w5:t2" }
  const exec = async (bin, args, options) => {
    assert.equal(bin, env.HERDR_BIN_PATH)
    assert.deepEqual(args, ["pane", "get", env.HERDR_PANE_ID])
    assert.equal(options.env, env)
    return { stdout: JSON.stringify({ result: { pane } }) }
  }
  assert.deepEqual(await selectTuiOpener({ env, exec, tty: false }), { kind: "herdr", bin: env.HERDR_BIN_PATH, pane })
  const unavailable = async () => { throw new Error("no server") }
  assert.deepEqual(await selectTuiOpener({ env, exec: unavailable, tty: false }), { kind: "window" })
  assert.deepEqual(await selectTuiOpener({ env: {}, tty: true }), { kind: "tty" })
  assert.deepEqual(await selectTuiOpener({ env: { AGENT_TOOL_CALL: "1" }, tty: true }), { kind: "window" })
})

test("a focused AGY pane gets an overlay; an unfocused one gets a split without stealing focus", () => {
  assert.deepEqual(herdrTuiPlacement({ pane_id: "w5:p2", focused: true }), ["--placement", "overlay", "--focus"])
  assert.deepEqual(herdrTuiPlacement({ pane_id: "w5:p2", focused: false }),
    ["--placement", "split", "--target-pane", "w5:p2", "--direction", "right", "--no-focus"])
})

test("only exact Send intent may export or enqueue; only one target hook gets the notes", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-finish-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const intentPath = path.join(root, "intent")
  const inboxRoot = path.join(root, "inbox")
  const conversationId = "captured"
  const note = "Private review content"
  let exports = 0
  const finish = () => finishTuiReview({
    intentPath, conversationId, header: "Review header",
    exportFeedback: async () => { exports++; return note },
    enqueue: (id, batch) => enqueueAnnotations(id, batch, inboxRoot),
  })
  assert.match(await finish(), /without sending/)
  await writeFile(intentPath, "cancel\n")
  assert.match(await finish(), /without sending/)
  assert.equal(exports, 0)
  await writeFile(intentPath, "send\n")
  const status = await finish()
  assert.match(status, /queued/)
  assert.ok(!status.includes(note))
  assert.equal(exports, 1)
  assert.deepEqual(await handleStop({ conversationId: "unrelated" }, { inboxRoot }), {})
  const outcomes = await Promise.all([
    handleStop({ conversationId }, { inboxRoot }),
    handlePreInvocation({ conversationId }, { inboxRoot }),
  ])
  assert.equal(JSON.stringify(outcomes).split(note).length - 1, 1)
  assert.deepEqual(await handleStop({ conversationId }, { inboxRoot }), {})
})

test("both adapters resolve the packaged reviewer or an explicit custom binary", () => {
  const custom = "/custom/bin/annotate-tui"
  assert.equal(resolveTuiBinary(custom), custom)
  assert.equal(resolveTuiBinary(), bundledBinary())
})

test("getAdaptedThemeTokens returns valid RGBA palette tokens", () => {
  const tokens = getAdaptedThemeTokens()
  assert.ok(tokens.text.base)
  assert.ok(tokens.background.base)
  assert.ok(tokens.markdown.heading)
  assert.equal(typeof tokens.text.base.r, "number")
  assert.equal(typeof tokens.text.base.g, "number")
  assert.equal(typeof tokens.text.base.b, "number")
  assert.equal(typeof tokens.text.base.a, "number")
})

test("AGY theme tokens work with the bundled reviewer", async () => {
  const binary = resolveTuiBinary()
  const tempDir = path.join(os.tmpdir(), `agy-cli-test-${Date.now()}`)
  await mkdir(tempDir, { recursive: true })
  try {
    const env = await prepareTheme({
      binary,
      theme: getAdaptedThemeTokens(),
      directory: tempDir,
      env: process.env,
    })
    assert.ok(env.PLANNOTATOR_TUI_CONFIG)
    assert.ok(env.PLANNOTATOR_TUI_CONFIG.endsWith("theme.toml"))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
