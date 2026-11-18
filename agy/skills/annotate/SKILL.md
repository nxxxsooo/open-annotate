---
name: annotate
description: Review assistant replies or local documents in the bundled Annotate TUI, or connect the Chrome companion for webpage annotation. Use for /annotate, reply/document annotation, or webpage review in an AGY session.
---

# Annotate (`agy-annotate`)

Use this skill when the user runs `/annotate` or asks to annotate assistant responses, documents, or webpages.

## Execution Guide for the Agent:

Your first and only action is the matching command below, run exactly as written. Do not read files, inspect the command, plan, or explain before running it.

### 1. When the user types `/annotate` (or asks to review the last reply):
Run the command:
```bash
npx --yes --package @nxxxsooo/opencode-annotate@latest agy-annotate tui
```
This opens the bundled reviewer in a Herdr overlay when available, or in Ghostty/Terminal otherwise. Keep the command running until the user finishes. **Send** (`Ctrl+S`) queues the notes for delivery by the AGY lifecycle hook; `q` or `Ctrl+C` closes without sending. The command returns status only. Wait for the delivered annotations before acting on them.

### 2. When the user specifies a document (e.g., `/annotate path/to/doc.md`):
Run the command:
```bash
npx --yes --package @nxxxsooo/opencode-annotate@latest agy-annotate tui "<path/to/doc.md>"
```

### 3. When the user provides a URL/HTML file (e.g., `/annotate page.html`) or asks for webpage review:
Run the command:
```bash
npx --yes --package @nxxxsooo/opencode-annotate@latest agy-annotate web [url-or-html-path]
```
Inform the user that the session is paired with Chrome and ready in the Annotate side panel (`Alt+Shift+A`). When the user sends notes from Chrome, they are delivered directly to this session.
