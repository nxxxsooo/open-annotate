import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { extractAgyReplies, latestCompletedReply } from "./transcript.mjs"

async function makeFixture(t) {
  const base = path.join(os.homedir(), ".cache")
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(path.join(base, "agy-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const logDir = path.join(root, ".system_generated/logs")
  await mkdir(logDir, { recursive: true })
  return { root, logDir }
}

test("extractAgyReplies extracts completed and in-progress replies, handling truncated fields", async t => {
  const { root, logDir } = await makeFixture(t)
  const logPath = path.join(logDir, "transcript.jsonl")
  const fullLogPath = path.join(logDir, "transcript_full.jsonl")

  const step0 = { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Build a feature" }
  const step1 = {
    step_index: 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-10-28T10:00:00Z",
    content: "Checking the codebase...",
    tool_calls: [{ name: "run_command" }],
  }
  const step2 = {
    step_index: 2,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-10-28T10:01:00Z",
    content: "Truncated preview...",
    truncated_fields: ["content"],
    tool_calls: [],
  }
  const step2Full = {
    step_index: 2,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-10-28T10:01:00Z",
    content: "Full complete response with <hindsight_knowledge_refresh>tags to strip</hindsight_knowledge_refresh> and actual advice.",
    tool_calls: [],
  }

  await writeFile(logPath, [JSON.stringify(step0), JSON.stringify(step1), JSON.stringify(step2)].join("\n"))
  await writeFile(fullLogPath, JSON.stringify(step2Full))

  const replies = await extractAgyReplies(root)
  assert.equal(replies.length, 2)

  // Newest first
  assert.equal(replies[0].id, "2")
  assert.equal(replies[0].progress, false)
  assert.equal(replies[0].text, "Full complete response with  and actual advice.")

  assert.equal(replies[1].id, "1")
  assert.equal(replies[1].progress, true)
  assert.equal(replies[1].text, "Checking the codebase...")

  const latest = latestCompletedReply(replies)
  assert.ok(latest)
  assert.equal(latest.id, "2")
  assert.deepEqual(await extractAgyReplies(root, { latestOnly: true }), [latest])
})

test("extractAgyReplies returns empty array when transcript does not exist", async () => {
  const replies = await extractAgyReplies("/non/existent/path")
  assert.deepEqual(replies, [])
})

const userInput = (step_index, request) => ({
  step_index, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE",
  content: `<USER_REQUEST>\n${request}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>fixture</ADDITIONAL_METADATA>`,
})
const modelReply = (step_index, content, tool_calls = []) => ({
  step_index, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content, tool_calls,
})
const writeLog = (logDir, steps, name = "transcript.jsonl") =>
  writeFile(path.join(logDir, name), steps.map(step => JSON.stringify(step)).join("\n"))

test("repeated /annotate turns are excluded from both reply views (steps 212–248)", async t => {
  const { root, logDir } = await makeFixture(t)
  const steps = [userInput(210, "What changed?"), modelReply(212, "The actual answer.")]
  for (const [input, progress, reply] of [[213, 216, 224], [225, 228, 236], [237, 239, 248]]) {
    steps.push(
      userInput(input, "/annotate"),
      modelReply(progress, "Starting the reviewer.", [{ name: "run_command" }]),
      modelReply(reply, "Annotate opened; use Send when done."),
    )
  }
  await writeLog(logDir, steps)
  assert.deepEqual((await extractAgyReplies(root)).map(reply => reply.id), ["212"])
  assert.deepEqual((await extractAgyReplies(root, { latestOnly: true })).map(reply => reply.id), ["212"])
})

test("a normal reply after /annotate notes.md is the latest reply even without trailing input", async t => {
  const { root, logDir } = await makeFixture(t)
  const steps = [
    userInput(1, "First question"),
    modelReply(2, "First answer"),
    userInput(3, "/annotate notes.md"),
    modelReply(4, "The document reviewer opened."),
  ]
  await writeLog(logDir, steps)
  assert.deepEqual((await extractAgyReplies(root, { latestOnly: true })).map(reply => reply.id), ["2"])
  steps.push(userInput(5, "Follow-up question"), modelReply(6, "Follow-up answer"))
  await writeLog(logDir, steps)
  assert.deepEqual((await extractAgyReplies(root, { latestOnly: true })).map(reply => reply.id), ["6"])
  assert.deepEqual((await extractAgyReplies(root)).map(reply => reply.id), ["6", "2"])
})

test("truncated USER_INPUT is restored before filtering; accepted replies keep their full content", async t => {
  const { root, logDir } = await makeFixture(t)
  const truncated = { truncated_fields: ["content"] }
  const actual = modelReply(2, "This is the complete answer.")
  const review = userInput(3, "/annotate notes.md")
  await writeLog(logDir, [
    { ...actual, ...truncated, content: "This is…" },
    { ...review, ...truncated, content: "<USER_REQUEST>\n/ann…" },
    modelReply(4, "The reviewer opened."),
  ])
  await writeLog(logDir, [actual, review], "transcript_full.jsonl")
  for (const latestOnly of [true, false]) {
    const replies = await extractAgyReplies(root, { latestOnly })
    assert.deepEqual(replies.map(({ id, text }) => [id, text]), [["2", actual.content]])
  }
})
