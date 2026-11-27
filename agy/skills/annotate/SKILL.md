---
name: annotate
description: Review assistant replies or local documents in the bundled Annotate TUI, or connect the Chrome companion for webpage annotation. Use for /annotate, reply/document annotation, or webpage review in an AGY session.
---

# Annotate (`agy-annotate`)

Use this skill when the user runs `/annotate` or asks to annotate assistant responses, documents, or webpages.

In a configured Herdr AGY pane, the PreInvocation hook can handle `/annotate` and `/annotate <local-document>` before the model runs. In Herdr.app this requires hc to report a verifiable AGY process and state. The Herdr TUI shortcut `prefix+a` opens the latest reply.

## Execution Guide for the Agent

If the request reaches this skill, run the matching command immediately. Use `agy-annotate` from the same installation as the AGY hooks. For a linked skill with no `agy-annotate` on PATH, run `node` with the absolute `agy/cli.mjs` path from that installation (`cli.mjs` is two directories above the linked skill's real directory).

### 1. When the user types `/annotate` (or asks to review the last reply):
Run the command:
```bash
agy-annotate tui
```
This opens the bundled reviewer in Herdr, as a peek in the focused AGY tab in Herdr.app (or in the background AGY tab), or in Ghostty/Terminal outside Herdr. Keep the command running until the user finishes. **Send** (`Ctrl+S` or the Send button) delivers feedback to the captured conversation. `q` sends pending notes and closes; with no notes it just closes. `Ctrl+C` closes without sending. The command returns status only. Wait for delivered annotations before acting on them.

### 2. When the user specifies a document (e.g., `/annotate path/to/doc.md`):
Run the command:
```bash
agy-annotate tui "<path/to/doc.md>"
```

### 3. When the user provides a URL/HTML file (e.g., `/annotate page.html`) or asks for webpage review:
Run the command:
```bash
agy-annotate web [url-or-html-path]
```
Inform the user that the session is paired with Chrome and ready in the Annotate side panel (`Alt+Shift+A`). When the user sends notes from Chrome, they are delivered directly to this session.
