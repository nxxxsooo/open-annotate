import { test } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { annotateSlash, interceptAnnotateSlash } from "./slash.mjs"
import { handlePreInvocation, handleStop } from "./hooks.mjs"
import { enqueueAnnotations } from "./inbox.mjs"

const conversationId = "605c8a34-bd80-4007-9164-345de6a351bd"
const pane = "w1:p1"
const env = { HERDR_ENV: "1", HERDR_PANE_ID: pane, HERDR_SOCKET_PATH: "/fixture/socket" }
const plugin = { plugin_id: "annotate", enabled: true, panes: [{ id: "agy-popup", placement: "popup" }] }
const agent = { agent: "agy", focused: true, agent_session: { kind: "id", value: conversationId } }
const payload = { conversationId, invocationNum: 0, initialNumSteps: 1, lastUserInput: "/annotate" }

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
  const options = { env, inboxRoot, readAgent: async () => agent, command: async () => ({ plugins: [plugin] }),
    launch: async captured => { calls.push(captured); return true } }
  const intercept = p => interceptAnnotateSlash(p, options)
  assert.deepEqual(await handlePreInvocation(payload, { intercept }), { terminationBehavior: "terminate" })
  assert.deepEqual(calls.shift(), { pane, conversationId, document: undefined, binary: undefined, env })
  assert.equal(await intercept(payload), true)
  assert.deepEqual(calls, [], "a repeated hook must not open the same turn again")
  const cwd = fileURLToPath(new URL("../", import.meta.url))
  assert.equal(await intercept({ ...payload, initialNumSteps: 2, cwd, lastUserInput: '/annotate "README.md"' }), true)
  assert.equal(calls.shift().document, fileURLToPath(new URL("../README.md", import.meta.url)))
  assert.equal(await intercept({ ...payload, invocationNum: 1 }), false)
  assert.equal(await intercept({ ...payload, cwd, lastUserInput: "/annotate missing.md" }), false)
  assert.equal(await interceptAnnotateSlash(payload, { ...options, env: {} }), false)
  assert.equal(await interceptAnnotateSlash(payload, { ...options, readAgent: async () => ({ ...agent, focused: false }) }), false)
  assert.equal(await interceptAnnotateSlash({ ...payload, conversationId: "different" }, options), false)
  assert.equal(await interceptAnnotateSlash(payload, { ...options, command: async () => ({ plugins: [] }) }), false)
  assert.deepEqual(calls, [])
  const failed = { ...payload, initialNumSteps: 3 }
  assert.equal(await interceptAnnotateSlash(failed, { ...options, launch: async () => false }), false)
  assert.equal(await intercept(failed), true, "failed spawn releases the claim")
})

test("a terminated local slash turn does not restart the model or consume queued notes", async t => {
  const inboxRoot = await mkdtemp(path.join(os.tmpdir(), "annotate-slash-test-"))
  t.after(() => rm(inboxRoot, { force: true, recursive: true }))
  const note = "Previously queued note"
  await enqueueAnnotations(conversationId, { batchID: "kept-note", markdown: note }, inboxRoot)
  const intercepted = { ...payload, terminationReason: "TERMINAL_CUSTOM_HOOK" }
  assert.deepEqual(await handleStop(intercepted, { env, inboxRoot }), {})
  const next = await handlePreInvocation({ ...payload, lastUserInput: "Continue" }, { env, inboxRoot })
  assert.match(next.injectSteps[0].userMessage, /Previously queued note/)
  assert.deepEqual(await handleStop({ conversationId }, { env, inboxRoot }), {})
})
