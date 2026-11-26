import { readFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { annotateSlash } from "./slash.mjs"

export const defaultBrainDir = (conversationId, baseDir = path.join(os.homedir(), ".gemini/antigravity-cli/brain")) =>
  path.join(baseDir, conversationId)

export function parseTranscriptLine(raw) {
  if (!raw || !raw.trim()) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function cleanModelContent(content) {
  if (!content) return ""
  // Strip transient system injections or tags that shouldn't be the subject of review
  return content.replace(/<hindsight_[^>]*>[\s\S]*?<\/hindsight_[^>]*>/g, "").trim()
}

export async function readFullStep(brainDir, stepIndex) {
  const fullLog = path.join(brainDir, ".system_generated/logs/transcript_full.jsonl")
  try {
    const text = await readFile(fullLog, "utf8")
    const lines = text.split("\n")
    for (const line of lines) {
      const parsed = parseTranscriptLine(line)
      if (parsed && parsed.step_index === stepIndex) return parsed
    }
  } catch {
    // Fall back if full transcript is absent
  }
  return null
}

async function stepContent(brainDir, step) {
  if (step.truncated_fields?.includes("content")) {
    const full = await readFullStep(brainDir, step.step_index)
    if (full?.content) return full.content
  }
  return step.content || ""
}

async function isAnnotateTurn(brainDir, input) {
  const content = (await stepContent(brainDir, input)).trim()
  const request = /^<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content)?.[1]
  return annotateSlash((request ?? content).trim()) !== undefined
}

async function renderReply(brainDir, step, latestOnly) {
  const hasToolCalls = Boolean(step.tool_calls?.length)
  const cleaned = cleanModelContent(await stepContent(brainDir, step))
  if (!cleaned && (hasToolCalls || latestOnly)) return null
  return {
    id: String(step.step_index),
    text: cleaned,
    progress: hasToolCalls,
    created: Date.parse(step.created_at) || Date.now(),
    toolCalls: step.tool_calls?.map(t => t.name) || [],
  }
}

export async function extractAgyReplies(brainDir, { signal, latestOnly = false } = {}) {
  const logPath = path.join(brainDir, ".system_generated/logs/transcript.jsonl")
  let text
  try {
    text = await readFile(logPath, "utf8", { signal })
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }

  const lines = text.split("\n")
  const replies = []
  const candidates = []

  // Walking backward, a turn's replies come before the input that started it.
  // Flush at the start of the file as well, for logs with no preceding input.
  for (let i = lines.length - 1; i >= -1; i--) {
    signal?.throwIfAborted()
    const step = parseTranscriptLine(lines[i])
    if (i === -1 || step?.type === "USER_INPUT") {
      if (candidates.length && (!step || !await isAnnotateTurn(brainDir, step))) {
        for (const candidate of candidates) {
          signal?.throwIfAborted()
          const reply = await renderReply(brainDir, candidate, latestOnly)
          if (!reply) continue
          replies.push(reply)
          if (latestOnly) return replies
        }
      }
      candidates.length = 0
    } else if (step?.source === "MODEL" && step.type === "PLANNER_RESPONSE" && step.status === "DONE") {
      if (!latestOnly || !step.tool_calls?.length) candidates.push(step)
    }
  }

  return replies
}

export function latestCompletedReply(replies) {
  return replies.find(r => !r.progress && r.text.trim()) || null
}
