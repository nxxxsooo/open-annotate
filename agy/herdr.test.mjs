import { test } from "node:test"
import assert from "node:assert/strict"
import { deliverHerdrReview, focusedPane, resolveHerdrConversation } from "./herdr.mjs"

const id = "605c8a34-bd80-4007-9164-345de6a351bd"
const other = "650229ca-30db-4a36-bb7c-b226a482c677"
const reference = { kind: "id", value: id }

test("action targets the focused pane from context, not the plugin process", () => {
  const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p9", HERDR_PLUGIN_CONTEXT_JSON: '{"focused_pane_id":"w1:p2"}' }
  assert.equal(focusedPane(env), "w1:p2")
  assert.throws(() => focusedPane({ ...env, HERDR_PLUGIN_CONTEXT_JSON: "{}" }), /Focus an agent pane/)
})

test("conversation routing prefers Herdr identity and refuses ambiguous foreground locks", () => {
  const exact = resolveHerdrConversation({ agent_session: reference })
  assert.deepEqual(exact, { conversationId: id, reported: true })
  const path = `/home/.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript.jsonl`
  assert.deepEqual(resolveHerdrConversation({ agent_session: { kind: "path", value: path } }), exact)
  assert.throws(() => resolveHerdrConversation({ agent_session: { kind: "id", value: "../unsafe" } }), /valid AGY/)
  const processes = [{ pid: 14 }]
  const session = { pid: 14, conversationId: id }
  assert.deepEqual(resolveHerdrConversation({}, processes, [session, { pid: 15, conversationId: other }]),
    { conversationId: id, reported: false, pid: 14 })
  for (const sessions of [[], [session, { ...session, conversationId: other }]]) {
    assert.throws(() => resolveHerdrConversation({}, processes, sessions), /Cannot identify one/)
  }
})

test("delivery chooses exactly one route and refuses an unavailable or changed destination", async () => {
  const captured = { bin: "herdr", pane: "w1:p2", terminalId: "term-a", conversationId: id, reported: true }
  const batch = { markdown: "Feedback" }
  const calls = []
  const send = (agent_status, overrides = {}, promptError) => deliverHerdrReview(captured, batch, {
    getAgent: async () => ({ agent: "agy", agent_status, terminal_id: "term-a", agent_session: reference, ...overrides }),
    getConversation: async (_bin, _pane, agent) => resolveHerdrConversation(agent),
    prompt: async (...args) => { calls.push(["prompt", ...args]); if (promptError) throw promptError },
    enqueue: async (...args) => { calls.push(["inbox", ...args]) },
  })
  for (const status of ["idle", "done"]) {
    assert.match(await send(status), /submitted/)
    assert.deepEqual(calls.splice(0), [["prompt", "herdr", "w1:p2", "Feedback"]])
  }
  assert.match(await send("working"), /queued/)
  assert.deepEqual(calls.splice(0), [["inbox", id, batch]])
  await assert.rejects(send("blocked"), /blocked/)
  await assert.rejects(send("unknown"), /not ready/)
  await assert.rejects(send("working", { terminal_id: "term-b" }), /no longer matches/)
  await assert.rejects(send("idle", { agent_session: { ...reference, value: other } }), /no longer matches/)
  await assert.rejects(send("idle", { agent: "shell" }), /no longer contains AGY/)
  assert.deepEqual(calls, [])
  await assert.rejects(send("idle", {}, new Error("timeout")), /timeout/)
  assert.deepEqual(calls, [["prompt", "herdr", "w1:p2", "Feedback"]])
})
