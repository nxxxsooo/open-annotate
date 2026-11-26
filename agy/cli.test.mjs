import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { finishTuiReview, getAdaptedThemeTokens, herdrTuiPlacement, selectTuiOpener, waitForTuiPane } from "./cli.mjs"
import { appPlacement, openHerdrAppTui } from "./herdr-app.mjs"
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

const appEnv = { HC_TERMINAL_ID: "t14w", HC_TERMINAL_SOCKET: "/fixture/terminal.sock" }
const appOpener = { kind: "herdr-app", parent: "t14w", env: appEnv }
const appStatus = { space: "sp1", tab: "tb1", focused_pane: "p1", agent: "t145", overlays: ["toast"] }
const appLayout = { spaces: [{ id: "sp1", machine: null, tabs: [{ id: "tb1", terminals: [{ terminal: "t14w", pane: "p1" }] }] }] }
const json = value => ({ stdout: JSON.stringify(value) })
const commandError = (error, stream = "stderr") => Object.assign(new Error("command failed"), { [stream]: JSON.stringify({ error }) })

test("reachable Herdr TUI takes precedence over Herdr.app, which takes precedence over tty/window", async () => {
  const pane = { pane_id: "w5:p2", tab_id: "w5:t2" }
  const both = { ...appEnv, HERDR_ENV: "1", HERDR_PANE_ID: pane.pane_id }
  const exec = async (bin, args, { timeout }) => {
    if (bin === "herdr") return json({ result: { pane } })
    assert.equal(bin, "herdr-app")
    assert.ok(timeout < 1000)
    return json(args[0] === "ls" ? appLayout : appStatus)
  }
  assert.deepEqual(await selectTuiOpener({ env: both, tty: true, exec }), { kind: "herdr", bin: "herdr", pane })
  assert.deepEqual(await selectTuiOpener({ env: appEnv, tty: true, exec }), appOpener)
  const noHerdr = async (bin, ...rest) => {
    if (bin === "herdr") throw new Error("unreachable")
    return exec(bin, ...rest)
  }
  assert.deepEqual(await selectTuiOpener({ env: both, tty: false, exec: noHerdr }), { ...appOpener, env: both })
  assert.deepEqual(await selectTuiOpener({ env: { ...appEnv, HC_TERMINAL_ID: "t15" }, tty: true, exec }), { kind: "tty" })
  const offline = async (bin, args) => {
    if (args[0] === "status") throw new Error("app not running")
    return exec(bin, args, { timeout: 350 })
  }
  assert.deepEqual(await selectTuiOpener({ env: appEnv, tty: false, exec: offline }), { kind: "window" })
})

test("Herdr.app matches the focused pane, starts a silent child, and retries only app discovery", async () => {
  const run = ["run", "--bg", "--json", "--parent", "t14w", "--no-notify", "--rm", "--cwd", "/review"]
  const argv = ["/bin/node", "/pkg/agy/cli.mjs", "tui-pane", "/review"]
  const labels = ["herdr.space=sp1", "herdr.tab=tb1"]
  for (const mode of ["focused", "unfocused", "changed", "failure", "never discovered"]) {
    const commands = []
    const delays = []
    let peeks = 0
    let statuses = 0
    const exec = async (bin, args, { env }) => {
      assert.equal(env, appEnv)
      commands.push([bin, ...args])
      switch (args[0]) {
        case "ls": return json(appLayout)
        case "status": {
          statuses++
          const changed = mode === "unfocused" || (mode === "changed" && statuses >= 2)
          return json(changed ? { ...appStatus, focused_pane: "p2", agent: "t14w" } : appStatus)
        }
        case "get": return json({ labels: { "herdr.space": "sp1", "herdr.tab": "tb1" } })
        case "run": return json({ address: "t14x" })
        case "label":
        case "kill": return json({ ok: true })
        case "do":
          assert.deepEqual(args, ["do", "terminal.peek", "--terminal", "t14x"])
          if (mode === "failure") throw commandError("command unavailable", "stdout")
          if (++peeks === 1 || mode === "never discovered") throw commandError('no running terminal "t14x"', "stdout")
          return json({ ok: true })
        default: assert.fail(`Unexpected ${bin} ${args.join(" ")}`)
      }
    }
    const open = openHerdrAppTui(appOpener, "/review", argv, { exec, pause: async ms => { delays.push(ms) } })
    if (mode === "failure") {
      await assert.rejects(open, /command unavailable/)
      assert.deepEqual(commands.at(-1), ["hc", "kill", "t14x"])
      assert.deepEqual(delays, [])
      continue
    }
    if (mode === "never discovered") {
      await assert.rejects(open, /no running terminal "t14x"/)
      assert.deepEqual(commands.at(-1), ["hc", "kill", "t14x"])
      assert.equal(peeks, 30)
      assert.deepEqual(delays, Array(29).fill(100))
      continue
    }
    assert.deepEqual(await open, { ...appOpener, id: "t14x", peek: mode === "focused" })
    const placement = mode === "unfocused" ? labels.flatMap(label => ["--label", label]) : []
    assert.deepEqual(commands.find(([, action]) => action === "run"), ["hc", ...run, ...placement, "--", ...argv])
    assert.equal(peeks, mode === "focused" ? 2 : 0)
    assert.deepEqual(delays, mode === "focused" ? [100] : [])
    if (mode === "changed") assert.deepEqual(commands.at(-1), ["hc", "label", "t14x", ...labels])
  }
})

test("Herdr.app uses the shown sub-agent and its host pane to determine focus", async () => {
  const child = "t145"
  const grandchild = "t146"
  const layout = structuredClone(appLayout)
  layout.spaces[0].tabs[0].terminals[0].sub_agents = [child]
  const exec = status => async (bin, args) => {
    if (bin === "hc") {
      assert.deepEqual(args, ["get", grandchild, "--json"])
      return json({ address: grandchild, state: "live", parent: child })
    }
    return json(args[0] === "ls" ? layout : status)
  }
  const placement = { host: appOpener.parent, space: "sp1", tab: "tb1" }
  const locate = (parent, status) => appPlacement({ ...appOpener, parent }, exec(status))
  assert.deepEqual(await locate(child, appStatus), { ...placement, focused: true })
  assert.deepEqual(await locate(grandchild, { ...appStatus, agent: grandchild }), { ...placement, focused: true })
  for (const diff of [
    { agent: appOpener.parent }, { focused_pane: "p2" }, { space: "sp2" }, { tab: "tb2" }, { overlays: ["peek"] },
  ]) {
    assert.deepEqual(await locate(child, { ...appStatus, ...diff }), { ...placement, focused: false })
  }
})

test("an unfocused Herdr.app sub-agent verifies its host's labels and opens in the host's tab", async () => {
  const env = { ...appEnv, HC_TERMINAL_ID: "t145" }
  const opener = { kind: "herdr-app", parent: env.HC_TERMINAL_ID, env }
  const layout = structuredClone(appLayout)
  layout.spaces[0].tabs[0].terminals[0].sub_agents = [opener.parent]
  const argv = ["/bin/node", "/pkg/agy/cli.mjs", "tui-pane", "/review"]
  const open = labels => openHerdrAppTui(opener, "/review", argv, {
    exec: async (bin, args) => {
      if (bin === "herdr-app") {
        assert.ok(["ls", "status"].includes(args[0]), "opening in a background tab must not change focus")
        return json(args[0] === "ls" ? layout : { ...appStatus, agent: appOpener.parent })
      }
      if (args[0] === "get") {
        assert.deepEqual(args, ["get", appOpener.parent, "--json"])
        return json({ labels })
      }
      assert.deepEqual(args, [
        "run", "--bg", "--json", "--parent", opener.parent, "--no-notify", "--rm", "--cwd", "/review",
        "--label", "herdr.space=sp1", "--label", "herdr.tab=tb1", "--", ...argv,
      ])
      return json({ address: "t147" })
    },
  })
  assert.deepEqual(await open({ "herdr.space": "sp1", "herdr.tab": "tb1" }), { ...opener, id: "t147", peek: false })
  await assert.rejects(open({ "herdr.space": "sp1", "herdr.tab": "tb2" }), /disagree on terminal t14w's tab/)
})

test("waiting for Herdr.app treats a finished or removed terminal as closed without Send", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-hc-wait-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const opener = { ...appOpener, id: "t14x" }
  const wait = exec => waitForTuiPane(directory, opener, { exec })
  assert.equal(await wait(async (bin, args) => {
    assert.equal(bin, "hc")
    assert.deepEqual(args, ["get", "t14x", "--json"])
    return json({ state: "finished" })
  }), false)
  assert.equal(await wait(async () => { throw commandError({ kind: "not_found" }) }), false)
  await assert.rejects(wait(async () => { throw new Error("transport failed") }), /transport failed/)
  await writeFile(path.join(directory, "done"), "closed")
  assert.equal(await wait(async () => assert.fail("done file wins over hc")), true)
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
