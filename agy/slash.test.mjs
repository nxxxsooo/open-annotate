import { test } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { annotateSlash, interceptAnnotateSlash } from "./slash.mjs"
import { handlePreInvocation, handleStop } from "./hooks.mjs"
import { enqueueAnnotations } from "./inbox.mjs"
import { deliverHerdrAppReview, verifyHerdrAppConversation } from "./herdr-app.mjs"

const conversationId = "605c8a34-bd80-4007-9164-345de6a351bd"
const pane = "w1:p1"
const env = { HERDR_ENV: "1", HERDR_PANE_ID: pane, HERDR_SOCKET_PATH: "/fixture/socket" }
const plugin = { plugin_id: "annotate", enabled: true, panes: [{ id: "agy-popup", placement: "popup" }] }
const agent = { agent: "agy", focused: true, agent_session: { kind: "id", value: conversationId } }
const payload = { conversationId, invocationNum: 0, initialNumSteps: 1, lastUserInput: "/annotate" }
const appEnv = { HC_TERMINAL_ID: "t14w", HC_TERMINAL_SOCKET: "/fixture/hc.sock" }
const appOpener = { kind: "herdr-app", parent: "t14w", env: appEnv }
const terminal = { address: "t14w", state: "live", foreground: { name: "agy", pid: 123 }, status: { app: "antigravity", state: "working" } }
const presence = [{ conversationId, pid: 123 }]
const verify = (opener, id, { snapshot = terminal, sessions = () => presence, pid } = {}) => verifyHerdrAppConversation(opener, id, {
  exec: async (bin, args) => {
    assert.equal(bin, "hc")
    assert.deepEqual(args, ["get", "t14w", "--json"])
    return { stdout: JSON.stringify(snapshot) }
  },
  sessions,
  pid,
})

test("recognizes standalone text and local document commands, not web or mixed input", () => {
  assert.equal(annotateSlash("/annotate"), null)
  assert.equal(annotateSlash('/annotate "file name.md"'), "file name.md")
  for (const text of ["look at /annotate", "/annotated", "/annotate\nthen run it", "/annotate https://example.com", "/annotate note.html", '/annotate "unterminated']) {
    assert.equal(annotateSlash(text), undefined)
  }
})

test("only terminates the initial invocation after handing off the verified pane and conversation", async t => {
  const inboxRoot = await mkdtemp(path.join(os.tmpdir(), "annotate-slash-test-"))
  t.after(() => rm(inboxRoot, { force: true, recursive: true }))
  const calls = []
  const declined = []
  const options = { env, inboxRoot, readAgent: async () => agent, command: async () => ({ plugins: [plugin] }),
    launch: async captured => { calls.push(captured); return true },
    record: async (_, reason) => { declined.push(reason) } }
  const intercept = p => interceptAnnotateSlash(p, options)
  const opened = await handlePreInvocation(payload, { intercept })
  assert.equal(opened.terminationBehavior, "terminate")
  assert.equal(opened.injectSteps.length, 1, "AGY needs a step after the input to leave Working…")
  assert.equal(opened.injectSteps[0].systemMessage.systemMessage, "", "the model never reads the UI step")
  assert.match(opened.injectSteps[0].systemMessage.metadata.user_markdown, /Annotate opened/)
  assert.deepEqual(calls.shift(), { pane, conversationId, document: undefined, binary: undefined, env })
  assert.equal(await intercept(payload), "replayed")
  assert.deepEqual(await handlePreInvocation(payload, { intercept }), { terminationBehavior: "terminate" },
    "a replayed invocation adds no second UI step")
  assert.deepEqual(calls, [], "a repeated hook must not open the same turn again")
  const cwd = fileURLToPath(new URL("../", import.meta.url))
  assert.equal(await intercept({ ...payload, initialNumSteps: 2, cwd, lastUserInput: '/annotate "README.md"' }), "opened")
  assert.equal(calls.shift().document, fileURLToPath(new URL("../README.md", import.meta.url)))
  assert.equal(await intercept({ ...payload, invocationNum: 1 }), false)
  assert.equal(await intercept({ ...payload, cwd, lastUserInput: "/annotate missing.md" }), false)
  assert.equal(await interceptAnnotateSlash(payload, { ...options, env: {} }), false)
  assert.equal(await interceptAnnotateSlash(payload, { ...options, readAgent: async () => ({ ...agent, focused: false }) }), false)
  assert.equal(await interceptAnnotateSlash({ ...payload, conversationId: "different" }, options), false)
  assert.equal(await interceptAnnotateSlash(payload, { ...options, command: async () => ({ plugins: [] }) }), false)
  assert.deepEqual(calls, [])
  assert.ok(declined.includes("slash not intercepted: AGY pane not focused"), "a declined slash records why")
  assert.equal(declined.length, 6)
  const failed = { ...payload, initialNumSteps: 3 }
  assert.equal(await interceptAnnotateSlash(failed, { ...options, launch: async () => false }), false)
  assert.equal(await intercept(failed), "opened", "failed spawn releases the claim")
})

test("a terminated local slash turn does not restart the model or consume queued notes", async t => {
  const inboxRoot = await mkdtemp(path.join(os.tmpdir(), "annotate-slash-test-"))
  t.after(() => rm(inboxRoot, { force: true, recursive: true }))
  const note = "Previously queued note"
  await enqueueAnnotations(conversationId, { batchID: "kept-note", markdown: note }, inboxRoot)
  const intercepted = { ...payload, terminationReason: "TERMINAL_CUSTOM_HOOK" }
  assert.deepEqual(await handleStop(intercepted, { env, inboxRoot }), {})
  assert.deepEqual(await handleStop(intercepted, { env: appEnv, inboxRoot }), {})
  const next = await handlePreInvocation({ ...payload, lastUserInput: "Continue" }, { env, inboxRoot })
  assert.match(next.injectSteps[0].userMessage, /Previously queued note/)
  assert.deepEqual(await handleStop({ conversationId }, { env, inboxRoot }), {})
})

test("Herdr.app slash verifies a foreground AGY conversation and claims the review once", async t => {
  const inboxRoot = await mkdtemp(path.join(os.tmpdir(), "annotate-hc-slash-test-"))
  t.after(() => rm(inboxRoot, { force: true, recursive: true }))
  const launches = []
  const records = []
  const options = {
    env: appEnv, inboxRoot, selectApp: async () => appOpener, verifyApp: verify,
    launch: async request => { launches.push(request); return true },
    record: async (_, reason) => { records.push(reason) },
  }
  assert.deepEqual(await Promise.all([
    interceptAnnotateSlash(payload, options), interceptAnnotateSlash(payload, options),
  ]).then(outcomes => outcomes.sort()), ["opened", "replayed"])
  assert.deepEqual(launches, [{ conversationId, document: undefined, env: appEnv, pid: 123 }])
  assert.equal(await interceptAnnotateSlash(payload, { ...options, selectApp: async () => null }), "replayed",
    "a claimed turn does not fall back to the skill when the app has disappeared")
  assert.ok(records.includes("Herdr.app slash reviewer launch claimed"))
  assert.ok(records.includes("Herdr.app slash replay ignored"))
  const document = fileURLToPath(new URL("../README.md", import.meta.url))
  const fileTurn = { ...payload, initialNumSteps: 2, cwd: path.dirname(document), lastUserInput: "/annotate README.md" }
  assert.equal(await interceptAnnotateSlash(fileTurn, options), "opened")
  assert.equal(launches.at(-1).document, document)

  const next = { ...payload, initialNumSteps: 3 }
  const declines = [
    [{ selectApp: async () => null }, /does not know the calling terminal/],
    [{ verifyApp: (opener, id) => verify(opener, id, { snapshot: { ...terminal, foreground: { name: "node", pid: 123 } } }) }, /no.*live foreground AGY/],
    [{ verifyApp: (opener, id) => verify(opener, id, { sessions: () => [] }) }, /no unique conversation presence lock/],
    [{ verifyApp: (opener, id) => verify(opener, id, { sessions: () => [{ pid: 123, conversationId: "different" }] }) }, /no longer matches/],
    [{ verifyApp: (opener, id) => verify(opener, id, { snapshot: { ...terminal, status: null } }) }, /could not determine its state/],
  ]
  for (const [overrides, reason] of declines) {
    assert.equal(await interceptAnnotateSlash(next, { ...options, ...overrides }), false)
    assert.match(records.at(-1), /^slash not intercepted:/)
    assert.match(records.at(-1), reason)
  }
  assert.equal(launches.length, 2)
})

test("Herdr.app slash sends to idle or done AGY, queues while working, and refuses unsafe targets", async () => {
  const batch = { batchID: "batch", markdown: "Review notes\n\n- Keep this line." }
  const commands = []
  const queued = []
  const deliver = config => deliverHerdrAppReview(appOpener, conversationId, 123, batch, {
    verify: (opener, id, options) => verify(opener, id, { ...config, ...options }),
    exec: async (bin, args, { env }) => {
      assert.equal(env, appEnv)
      commands.push([bin, ...args])
    },
    enqueue: async (...args) => { queued.push(args) },
  })
  const snapshot = state => ({ ...terminal, status: { app: "antigravity", state } })
  await assert.rejects(deliver({ snapshot: snapshot("blocked") }), /AGY is blocked and needs input. Nothing was sent./)
  for (const status of [null, { app: "antigravity", state: "unknown" }, { app: "not-agy", state: "idle" }]) {
    await assert.rejects(deliver({ snapshot: { ...terminal, status } }), /could not determine its state/)
  }
  await assert.rejects(deliver({ sessions: () => [{ pid: 123, conversationId: "different" }] }), /no longer matches/)
  await assert.rejects(deliver({
    snapshot: { ...terminal, foreground: { name: "agy", pid: 999 } },
    sessions: () => [{ conversationId, pid: 999 }],
  }), /no longer matches/)
  assert.deepEqual(queued, [])
  assert.deepEqual(commands, [])
  assert.match(await deliver({ snapshot: snapshot("idle") }), /submitted/)
  assert.match(await deliver({ snapshot: snapshot("done") }), /submitted/)
  assert.deepEqual(queued, [])
  assert.match(await deliver({ snapshot: snapshot("working") }), /queued/)
  assert.deepEqual(queued, [[conversationId, batch]])
  assert.deepEqual(commands, [
    ["hc", "send", "--if", "idle", appOpener.parent, batch.markdown],
    ["hc", "send", appOpener.parent, batch.markdown],
  ])
})

test("a failed Herdr.app send is never retried or queued", async () => {
  const batch = { batchID: "batch", markdown: "Review notes" }
  for (const [kind, message] of [
    ["blocked", "AGY is blocked and needs input. Nothing was sent."],
    ["not_found", "The AGY pane is no longer ready. Nothing was sent."],
    ["finished", "The AGY pane is no longer ready. Nothing was sent."],
    ["status_mismatch", "The AGY pane is no longer ready. Nothing was sent."],
    [undefined, "Herdr did not confirm submission. Check the AGY conversation before retrying."],
  ]) {
    let attempts = 0
    await assert.rejects(deliverHerdrAppReview(appOpener, conversationId, 123, batch, {
      verify: async () => ({ pid: 123, state: "idle" }),
      exec: async () => {
        attempts++
        const err = new Error("send failed")
        if (kind) err.stderr = JSON.stringify({ error: { kind } })
        throw err
      },
      enqueue: async () => assert.fail("attempted send must not enqueue"),
    }), { message })
    assert.equal(attempts, 1)
  }
})
