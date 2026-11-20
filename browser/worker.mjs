import { HOST, PROTOCOL, orderedNotes, pageTitle, safeUrl, validateAnchor, validateReview } from "./protocol.mjs"
import { openPanel, reconnectHint, resolveTargetTab, sameExtensionURL, sessionDelivery } from "./env.mjs"

const DELIVERY = sessionDelivery()
const pageKey = async url => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)))].map(v => v.toString(16).padStart(2, "0")).join("")
let writes = Promise.resolve(), connectionGeneration = 0
const serial = fn => { const next = writes.then(fn); writes = next.catch(() => {}); return next }
const RECONNECT = reconnectHint()
// Safari's app extension is sandboxed and cannot reach the local bridge, so the only
// delivery path there is copying the round out.
const native = message => {
  if (!DELIVERY) throw new Error("Session delivery is off in Safari. Copy the round instead.")
  return chrome.runtime.sendNativeMessage(HOST, message)
}
const KEPT_ROUNDS = 10
// Inherited-origin blank/srcdoc documents have no HTTP URL to sanitize.
const frameLocator = frame => frame ? JSON.stringify({ selectors: frame.selectors, url: ["about:blank", "about:srcdoc"].includes(frame.url) ? frame.url : safeUrl(frame.url) }) : undefined
async function inject(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["inspector.js", "capture.js"] }) }
  catch (error) { throw new Error(String(error.message).includes("HTML") ? error.message : RECONNECT) }
  const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => {
    try { return { frame: globalThis.AnnotateInspector.frame() } } catch { return null }
  } })
  return frames.filter(item => item.result).map(item => ({ frameId: item.frameId, frame: frameLocator(item.result.frame) }))
}
async function pickFrames(tabId, mode, frames = undefined) {
  frames ??= await inject(tabId)
  await Promise.all(frames.map(({ frameId }) => chrome.tabs.sendMessage(tabId, { action: "pick", mode }, { frameId })))
  return { mode }
}
async function anchorMessage(tabId, message, frames = undefined) {
  frames ??= await inject(tabId)
  const frame = frames.find(item => item.frame === message.anchor?.frame)
  if (!frame) return { ok: false, error: "This frame is missing or has navigated. Your feedback is kept." }
  return chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId })
}
async function activate(tab) {
  if (!tab?.id || !/^(https?|file):/.test(tab.url || "")) throw new Error("Open an ordinary webpage or authorized local HTML")
  await inject(tab.id)
  await chrome.storage.session.set({ [`tab:${tab.id}`]: { page: { url: safeUrl(tab.url), title: pageTitle(tab.title || "") }, anchor: null } })
}
async function waitLoaded(tabID) {
  await new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(updated); error ? reject(error) : resolve() }
    const updated = (id, change) => { if (id === tabID && change.status === "complete") finish() }
    const timer = setTimeout(() => finish(new Error("Page did not finish loading; try again")), 15000)
    chrome.tabs.onUpdated.addListener(updated)
    chrome.tabs.get(tabID).then(tab => { if (tab.status === "complete") finish() }, finish)
  })
}
const delivered = note => !note.deleted && note.sentRevision === note.revision
const pendingNotes = storage => orderedNotes(Object.entries(storage).filter(([key, note]) =>
  key.startsWith("note:") && !note.deleted && !delivered(note)).map(([, note]) => note))
async function paintMarkers(tabID, frames, notes, page, view) {
  await Promise.all(frames.map(({ frameId, frame }) => chrome.tabs.sendMessage(tabID, {
    action: "markers",
    notes: notes.map(note => note.page.url === page.url && note.anchor.frame === frame
      ? { id: note.id, revision: note.revision, anchor: note.anchor } : { anchor: null }),
    draft: view?.draft && view.draft.anchor.frame === frame ? view.draft : undefined,
    focus: view?.focus,
  }, { frameId })))
}
async function syncMarkers(tabID, frames = undefined) {
  frames ??= await inject(tabID)
  const keys = [`tab:${tabID}`, `area:${tabID}`]
  const [session, storage] = await Promise.all([readSession(keys), chrome.storage.local.get(null)])
  const page = session[keys[0]]?.page, view = session[keys[1]]
  if (page) await paintMarkers(tabID, frames, pendingNotes(storage), page, view?.url === page.url ? view : null)
}
async function readSession(keys) {
  return Object.assign({}, ...await Promise.all(keys.map(key => chrome.storage.session.get(key))))
}
async function updateMarkers() {
  const session = await chrome.storage.session.get(null)
  await Promise.all((await chrome.tabs.query({})).map(async tab => {
    if (!session[`tab:${tab.id}`]?.page) return
    try { await syncMarkers(tab.id) } catch { /* Closed or navigated tabs are refreshed when reopened. */ }
  }))
}
async function closeRound(annotations, details) {
  const storage = await chrome.storage.local.get(null), sentAt = new Date().toISOString(), updates = {}
  for (const sent of annotations) {
    const key = `note:${await pageKey(sent.page.url)}:${sent.id}`, note = storage[key]
    if (note && !note.deleted && note.revision === sent.revision) updates[key] = { ...note, sentRevision: sent.revision, sentAt, ...details }
  }
  await chrome.storage.local.set(updates)
  const rounds = new Map()
  for (const [key, note] of Object.entries({ ...storage, ...updates })) {
    if (!key.startsWith("note:") || !delivered(note)) continue
    const id = note.sentRound || "legacy"
    if (!rounds.has(id)) rounds.set(id, { at: note.sentAt || "", keys: [] })
    rounds.get(id).keys.push(key)
  }
  const expired = [...rounds.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(KEPT_ROUNDS).flatMap(round => round.keys)
  if (expired.length) await chrome.storage.local.remove(expired)
  await updateMarkers()
  return Object.keys(updates).length
}
function lastRound(entries) {
  const rounds = new Map()
  for (const note of entries) {
    if (!delivered(note) || !note.sentRound) continue
    const round = rounds.get(note.sentRound) || { id: note.sentRound, count: 0, at: note.sentAt, via: note.sentVia, to: note.sentTo }
    round.count++; rounds.set(note.sentRound, round)
  }
  return [...rounds.values()].sort((a, b) => b.at.localeCompare(a.at))[0] || null
}
chrome.action.onClicked.addListener(tab => {
  // open() must retain the browser's action user gesture, before asynchronous injection.
  openPanel(tab).catch(console.error)
  activate(tab).catch(async error => { await chrome.storage.session.set({ [`tab:${tab.id}`]: { error: error.message } }) })
})
async function current(message) {
  const tab = await resolveTargetTab(message)
  const keys = [`tab:${tab.id}`, `area:${tab.id}`], session = await readSession(keys)
  const state = session[keys[0]], view = session[keys[1]]
  if (!state?.page) throw new Error(state?.error || "Click the extension icon on this page to grant access")
  const hash = await pageKey(state.page.url)
  const storage = await chrome.storage.local.get(null)
  const entries = Object.entries(storage).filter(([key]) => key.startsWith("note:")).map(([, value]) => value)
  // Delivered notes leave the working list; the latest rounds stay restorable.
  const notes = pendingNotes(storage)
  const draft = storage[`draft:${hash}`] || { revision: 0, value: null }
  const outbox = storage.outbox
  const localNotes = notes.filter(note => note.page.url === state.page.url)
  let anchorStates = notes.map(note => note.page.url === state.page.url ? "unavailable" : "elsewhere"), draftAnchorState = draft.value ? "unavailable" : undefined, detached = null
  try {
    const anchors = localNotes.map(note => note.anchor).concat(draft.value ? [draft.value.anchor] : [])
    const frames = await inject(tab.id)
    const latest = (await chrome.storage.session.get(`tab:${tab.id}`))[`tab:${tab.id}`]
    await pickFrames(tab.id, latest?.mode ?? null, frames)
    await syncMarkers(tab.id, frames)
    const states = await Promise.all(anchors.map(async anchor => {
      const result = await anchorMessage(tab.id, { action: "locate", anchor, anchors: [anchor] }, frames)
      return result.states?.[0] || "missing frame"
    }))
    let index = 0
    anchorStates = notes.map(note => note.page.url === state.page.url ? states[index++] : "elsewhere")
    if (draft.value) draftAnchorState = states[localNotes.length]
  } catch (error) { if (error.message === RECONNECT) detached = RECONNECT /* otherwise visibly unavailable while navigating */ }
  return { protocol: PROTOCOL, tabID: tab.id, ...state, areaEvent: view?.url === state.page.url ? view.event : undefined,
    notes, anchorStates, hash, draft, draftAnchorState, detached, lastRound: lastRound(entries),
    outbox: outbox ? { batchID: outbox.batchID, targetID: outbox.targetID, count: outbox.review.annotations.length } : null }
}
function draftConflict(draft) {
  return Object.assign(new Error("This draft changed in another panel. Choose which version to keep."), { code: "draft-conflict", draft })
}
function validateDraft(page, draft) {
  if (draft === null) return
  if (!draft || typeof draft.comment !== "string" || draft.comment.length > 8000 || !["comment", "ask"].includes(draft.kind)) throw new Error("Invalid draft")
  validateReview({ version: 2, annotations: [{ page, id: "draft", revision: 1, createdAt: new Date().toISOString(),
    kind: draft.kind, comment: draft.comment.trim() || "Draft", anchor: draft.anchor }] })
  if (draft.editing) validateReview({ version: 2, annotations: [draft.editing] })
  consumedCaptures({}, draft.captures)
}
function consumedCaptures(previous, captures) {
  const result = { ...previous }
  if (!captures) return result
  if (typeof captures !== "object" || Array.isArray(captures)) throw new Error("Invalid capture acknowledgement")
  for (const [tab, id] of Object.entries(captures)) {
    if (!Number.isSafeInteger(Number(tab)) || Number(tab) < 0 || String(Number(tab)) !== tab || typeof id !== "string" || !id) throw new Error("Invalid capture acknowledgement")
    result[tab] = id
  }
  return result
}
async function pageSource(message, sender) {
  if (!sender.tab || !sender.url || new URL(message.page.url).origin !== new URL(sender.url).origin) throw new Error("Invalid page source")
  const tab = await chrome.tabs.get(sender.tab.id)
  if ((sender.origin || new URL(sender.url).origin) !== new URL(tab.url).origin) throw new Error("Invalid frame source")
  const frame = sender.frameId ? frameLocator(message.frame) : undefined
  if (sender.frameId && !frame) throw new Error("Missing frame locator")
  return { tab, frame, page: { url: safeUrl(tab.url), title: pageTitle(tab.title || "") } }
}
async function areaGesture(message, sender) {
  const { tab, frame, page } = await pageSource(message, sender)
  const key = `area:${tab.id}`, tabKey = `tab:${tab.id}`
  const session = await readSession([key, tabKey])
  if (session[tabKey]?.page.url !== page.url || (!frame && safeUrl(message.page.url) !== page.url)) throw new Error("The page changed")
  const view = session[key]?.url === page.url ? session[key] : { url: page.url }
  const { id } = message
  if (typeof id !== "string" || !id) throw new Error("Invalid area marker")
  const event = { token: crypto.randomUUID(), id, draft: id === view.draft?.id }
  const adjust = message.action === "area-adjust"
  if (adjust) {
    validateAnchor(message.anchor)
    if (message.anchor.type !== "area") throw new Error("Invalid area marker")
    event.anchor = { ...message.anchor, frame }
  }
  if (event.draft) {
    if (view.draft.anchor.frame !== frame) throw new Error("The area draft changed")
    if (adjust) {
      if (JSON.stringify(view.draft.anchor.rect) !== JSON.stringify(message.baseRect)) throw new Error("The area draft changed")
      view.draft = { ...view.draft, anchor: event.anchor }
    }
  } else {
    const storage = await chrome.storage.local.get(null)
    const noteKey = `note:${await pageKey(page.url)}:${id}`, old = storage[noteKey]
    if (!old || old.deleted || delivered(old) || old.anchor.type !== "area" || old.anchor.frame !== frame) throw new Error("This area note is no longer adjustable")
    if (adjust) {
      if (old.revision !== message.revision) throw new Error("The area note changed; try again")
      const note = { ...old, anchor: event.anchor, revision: old.revision + 1, updatedAt: new Date().toISOString() }
      validateReview({ version: 2, annotations: pendingNotes({ ...storage, [noteKey]: note }) })
      await chrome.storage.local.set({ [noteKey]: note })
      event.revision = note.revision
    }
  }
  await chrome.storage.session.set({ [key]: { ...view, focus: event.draft ? null : id, event } })
  await syncMarkers(tab.id)
  return {}
}
const sameSession = (a, b) => a?.sessionID && b?.sessionID && a.sessionID === b.sessionID && (a.provider || "opencode") === (b.provider || "opencode")
// Called within serial(): receiver IDs may change, but retries belong to a session.
async function rememberTarget(target, storage = undefined) {
  storage ??= await chrome.storage.local.get(null)
  const paired = storage.paired, updates = { paired: target, disconnected: false }
  if (paired?.id !== target.id && sameSession(paired, target)) {
    updates.retiredTargetIDs = [...new Set([...(storage.retiredTargetIDs || []), paired.id])].slice(-50)
    for (const [key, batch] of Object.entries(storage)) {
      if (key === "outbox" && batch.targetID === paired.id) updates[key] = { ...batch, targetID: target.id }
    }
  }
  await chrome.storage.local.set(updates)
  return target
}
async function liveTarget(paired, targets, current) {
  if (!paired) return targets.length === 1 && targets[0].connected !== false ? targets[0] : null
  const { retiredTargetIDs = [] } = await chrome.storage.local.get("retiredTargetIDs")
  const viable = targets.filter(target => target.connected !== false && !retiredTargetIDs.includes(target.id))
  const exact = viable.find(target => target.id === paired.id)
  if (exact) {
    // Backfill the stable identity on older pairings before their receiver restarts.
    if (!paired.sessionID) await chrome.storage.local.set({ paired: exact })
    return exact
  }
  const candidate = viable.find(target => sameSession(paired, target))
  if (!candidate || !current()) return null
  // A discovery response can be stale after a receiver restart; confirm the replacement now.
  const probe = await native({ action: "info", targetID: candidate.id })
  if (!probe.ok || !sameSession(paired, probe.target) || !current()) return null
  const replacement = probe.target
  return serial(async () => {
    const storage = await chrome.storage.local.get(null)
    // Another panel or a newer discovery may have changed the destination in flight.
    if (!current()) return viable.find(target => target.id === storage.paired?.id) || null
    if (storage.paired?.id !== paired.id) return viable.find(target => target.id === storage.paired?.id) || null
    return rememberTarget(replacement, storage)
  })
}
async function handle(message, sender) {
  if (message.action === "frames-changed") {
    if (!sender.tab) throw new Error("Invalid page source")
    const state = (await chrome.storage.session.get(`tab:${sender.tab.id}`))[`tab:${sender.tab.id}`]
    if (state?.page) {
      const frames = await inject(sender.tab.id)
      await pickFrames(sender.tab.id, state.mode ?? null, frames)
      await syncMarkers(sender.tab.id, frames)
    }
    return {}
  }
  if (["area-focus", "area-adjust"].includes(message.action)) return serial(() => areaGesture(message, sender))
  if (message.action === "capture") {
    const { tab, frame, page } = await pageSource(message, sender)
    const key = `tab:${tab.id}`
    const previous = (await chrome.storage.session.get(key))[key] || {}
    const captured = !message.modeOnly
    if (captured && message.anchor) validateAnchor(message.anchor)
    const changedPage = previous.page?.url !== page.url
    const mode = changedPage || captured || !message.ready && !message.error ? null : previous.mode ?? null
    await chrome.storage.session.set({ [key]: { ...previous, page, mode,
      ...(captured ? { anchor: message.anchor ? { ...message.anchor, ...(frame ? { frame } : {}) } : null, error: message.error, captureID: crypto.randomUUID() } : changedPage ? { anchor: null, error: null } : message.error ? { error: message.error } : {}) } })
    if (message.ready) await chrome.tabs.sendMessage(sender.tab.id, { action: "pick", mode }, { frameId: sender.frameId || 0 })
    if (!mode && previous.mode) await pickFrames(sender.tab.id, null)
    if (message.ready) await syncMarkers(tab.id, [{ frameId: sender.frameId || 0, frame }])
    else if (changedPage) await syncMarkers(tab.id)
    return {}
  }
  if (sender.url && !sameExtensionURL(sender.url)) throw new Error("Only the extension panel can manage feedback")
  if (message.action === "current") return current(message)
  if (message.action === "area-view") return serial(async () => {
    const { tabID, url, focus, draft, eventID } = message
    if (!Number.isInteger(tabID) || (focus !== null && typeof focus !== "string")) throw new Error("Invalid marker view")
    if (draft) {
      validateAnchor(draft.anchor)
      if (draft.anchor.type !== "area" || typeof draft.id !== "string" || !draft.id.startsWith("draft:")) throw new Error("Invalid area draft")
    }
    const key = `area:${tabID}`, tabKey = `tab:${tabID}`, session = await readSession([key, tabKey])
    if (session[tabKey]?.page.url !== url) return {}
    const view = session[key]?.url === url ? session[key] : null
    if (view?.event?.token !== eventID) return {}
    await chrome.storage.session.set({ [key]: { url, focus, draft, event: view?.event } })
    await syncMarkers(tabID)
    return {}
  })
  if (message.action === "draft") return serial(async () => {
    // A route change must still be able to persist the previous page's draft.
    if (!message.page || safeUrl(message.page.url) !== message.page.url || typeof message.page.title !== "string" ||
        typeof message.writerID !== "string" || !message.writerID || !Number.isSafeInteger(message.sequence) || message.sequence < 1 ||
        !Number.isSafeInteger(message.baseRevision) || message.baseRevision < 0) throw new Error("Invalid draft update")
    validateDraft(message.page, message.value)
    const key = `draft:${await pageKey(message.page.url)}`
    const old = (await chrome.storage.local.get(key))[key] || { revision: 0, value: null }
    if (old.writerID === message.writerID && old.sequence >= message.sequence) return { draft: old }
    if (old.revision !== message.baseRevision && old.writerID !== message.writerID) throw draftConflict(old)
    const draft = { revision: old.revision + 1, value: message.value, writerID: message.writerID,
      consumedCaptures: consumedCaptures(old.consumedCaptures, message.value === null ? message.captures : null),
      sequence: message.sequence, updatedAt: new Date().toISOString() }
    await chrome.storage.local.set({ [key]: draft })
    return { draft }
  })
  if (message.action === "targets") return native({ action: "targets" })
  if (message.action === "connection") {
    const generation = ++connectionGeneration
    const current = () => generation === connectionGeneration
    if (!DELIVERY) return { targets: [], workspaces: [], target: null, destination: null, disconnected: false, stale: false, delivery: false }
    const { paired, disconnected } = await chrome.storage.local.get(["paired", "disconnected"])
    let result
    try {
      result = await native({ action: "targets" })
      if (!result.ok) throw new Error(result.error)
    } catch (error) {
      return { targets: [], workspaces: [], target: null, destination: paired || null, disconnected: !!disconnected, stale: !!paired, delivery: true, error: error.message }
    }
    const targets = result.targets.filter(target => target.kind !== "workspace")
    const workspaces = result.targets.filter(target => target.kind === "workspace" && target.canCreate)
    const target = disconnected ? null : await liveTarget(paired, targets, current)
    return { targets, workspaces, target: target || null, destination: target || paired || null, disconnected: !!disconnected, stale: !!paired && !target, delivery: true }
  }
  if (message.action === "pair") return serial(async () => {
    connectionGeneration++
    const result = await native({ action: "connect", targetID: message.target.id })
    if (!result.ok) throw new Error(result.error)
    return { target: await rememberTarget(result.target) }
  })
  if (message.action === "pairing") return { target: (await chrome.storage.local.get("paired")).paired || null }
  if (message.action === "disconnect") return serial(async () => {
    connectionGeneration++
    const { paired } = await chrome.storage.local.get("paired")
    if (paired && paired.id !== message.targetID) throw new Error("The destination changed in another panel; choose it again")
    const result = await native({ action: "disconnect", targetID: message.targetID })
    if (!result.ok) throw new Error(result.error)
    await chrome.storage.local.set({ paired: result.target, disconnected: true })
    return { target: result.target }
  })
  if (message.action === "create-session") return serial(async () => {
    connectionGeneration++
    let { pendingCreation } = await chrome.storage.local.get("pendingCreation")
    if (!pendingCreation || pendingCreation.targetID !== message.targetID) {
      pendingCreation = { action: "create-session", targetID: message.targetID, requestID: crypto.randomUUID() }
      await chrome.storage.local.set({ pendingCreation })
    }
    const result = await native(pendingCreation)
    if (!result.ok) throw new Error(result.error)
    await rememberTarget(result.target)
    await chrome.storage.local.remove("pendingCreation")
    return { target: result.target }
  })
  const state = await current(message)
  if (["save", "pick"].includes(message.action) && message.url && message.url !== state.page.url) throw new Error("The active page changed; retry on the original page")
  if (message.action === "pick") {
    if (![null, "element", "area"].includes(message.mode)) throw new Error("Invalid capture mode")
    const key = `tab:${state.tabID}`, previous = (await chrome.storage.session.get(key))[key]
    await chrome.storage.session.set({ [key]: { ...previous, mode: message.mode } })
    return pickFrames(state.tabID, message.mode)
  }
  if (message.action === "reveal") {
    const note = state.notes.find(note => note.id === message.noteID)
    if (!note) throw new Error("This note is no longer on the page")
    let tabID = state.tabID
    if (note.page.url !== state.page.url) {
      const tabs = (await chrome.tabs.query({})).filter(tab => tab.url === note.page.url || tab.pendingUrl === note.page.url)
      const currentTab = await chrome.tabs.get(state.tabID)
      const existing = tabs.find(tab => tab.windowId === currentTab.windowId) || tabs[0]
      if (existing) {
        tabID = existing.id
        await chrome.tabs.update(tabID, { active: true })
        await chrome.windows.update(existing.windowId, { focused: true })
        await waitLoaded(tabID)
      } else {
        await new Promise((resolve, reject) => {
          const done = (id, change) => { if (id === tabID && change.status === "complete") { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(done); resolve() } }
          const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); reject(new Error("Page did not finish loading; try again")) }, 15000)
          chrome.tabs.onUpdated.addListener(done)
          chrome.tabs.update(tabID, { url: note.page.url }).catch(error => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(done); reject(error) })
        })
      }
      try { await activate(await chrome.tabs.get(tabID)) }
      catch { throw new Error(RECONNECT) }
    }
    const key = `tab:${tabID}`, previous = (await chrome.storage.session.get(key))[key]
    await chrome.storage.session.set({ [key]: { ...previous, mode: null } })
    await pickFrames(tabID, null)
    const result = await anchorMessage(tabID, { action: "reveal", anchor: note.anchor })
    if (!result.ok) throw new Error(result.error)
    return result
  }
  if (["clear", "restore-notes"].includes(message.action)) return serial(async () => {
    if (!Array.isArray(message.notes) || !message.notes.length) throw new Error("No notes to change")
    const storage = await chrome.storage.local.get(null), updates = {}, restoring = message.action === "restore-notes"
    for (const ref of message.notes) {
      const key = `note:${await pageKey(safeUrl(ref.url))}:${ref.id}`, old = storage[key]
      if (!old || old.revision !== ref.revision || !!old.deleted !== restoring || delivered(old))
        throw Object.assign(new Error("A note changed in another tab. Refresh and try again."), { code: "note-conflict", note: old || null })
      if (updates[key]) throw new Error("Duplicate note")
      updates[key] = { ...old, revision: old.revision + 1, deleted: !restoring }
    }
    if (restoring) {
      const round = Object.entries(storage).filter(([key, note]) => key.startsWith("note:") && !note.deleted && !delivered(note)).map(([, note]) => note)
      if (round.length + Object.keys(updates).length > 200) throw new Error("This round would exceed 200 notes; send or remove some first")
      validateReview({ version: 2, annotations: [...round, ...Object.values(updates)] })
    }
    const notes = Object.values(updates)
    if (!restoring && message.wholeRound && storage.outbox) {
      if (message.dropBatchID !== storage.outbox.batchID) throw new Error("A pending retry batch will be dropped. Confirm Clear again.")
      updates.outbox = null
    }
    await chrome.storage.local.set(updates)
    await updateMarkers()
    return { notes }
  })
  if (["save", "delete", "restore"].includes(message.action)) return serial(async () => {
    const page = message.note.page || state.page
    const key = `note:${await pageKey(page.url)}:${message.note.id}`
    const old = (await chrome.storage.local.get(key))[key]
    if ((old?.revision || 0) !== message.baseRevision) throw Object.assign(new Error("This note changed in another tab. Choose which version to keep."), { code: "note-conflict", note: old || null })
    if (message.action !== "save" && !old) throw new Error("This note no longer exists")
    if (message.action === "restore" && !old.deleted) throw new Error("This note has already been restored")
    if (old && delivered(old)) throw new Error("This note was already delivered; restore its round first")
    const note = { ...(message.action === "save" ? message.note : old), page: old?.page || page,
      revision: (old?.revision || 0) + 1, deleted: message.action === "delete" }
    if (message.action === "save") note.sentRevision = old?.sentRevision
    validateReview({ version: 2, annotations: [note] })
    const round = (await current(message)).notes.filter(item => item.id !== note.id)
    if (!note.deleted) {
      if (round.length >= 200) throw new Error("This round has 200 notes; send or remove some first")
      validateReview({ version: 2, annotations: [...round, note] })
    }
    const updates = { [key]: note }
    let draft
    if (message.draftRevision !== undefined) {
      const draftKey = `draft:${state.hash}`
      const previous = (await chrome.storage.local.get(draftKey))[draftKey] || { revision: 0, value: null }
      if (previous.revision !== message.draftRevision) throw draftConflict(previous)
      draft = { ...previous, revision: previous.revision + 1, value: null,
        consumedCaptures: consumedCaptures(previous.consumedCaptures, message.captures), updatedAt: new Date().toISOString() }
      updates[draftKey] = draft
    }
    await chrome.storage.local.set(updates)
    await updateMarkers()
    return { note, draft }
  })
  if (message.action === "markers") {
    await syncMarkers(state.tabID)
    return {}
  }
  if (message.action === "copied") return serial(async () => {
    if (!Array.isArray(message.notes) || !message.notes.length) throw new Error("No copied feedback to record")
    const count = await closeRound(message.notes, { sentRound: crypto.randomUUID(), sentVia: "clipboard", sentTo: null })
    // Copied feedback supersedes a batch that could not reach its session.
    await chrome.storage.local.remove("outbox")
    return { count }
  })
  if (message.action === "restore-round") return serial(async () => {
    const storage = await chrome.storage.local.get(null), updates = {}
    const latest = await current(message)
    for (const [key, note] of Object.entries(storage)) {
      if (!key.startsWith("note:") || !delivered(note) || note.sentRound !== message.roundID) continue
      const { sentRevision, sentRound, sentAt, sentVia, sentTo, ...rest } = note
      updates[key] = { ...rest, revision: note.revision + 1 }
    }
    if (!Object.keys(updates).length) throw new Error("This round is no longer available")
    if (latest.notes.length + Object.keys(updates).length > 200) throw new Error("This round would exceed 200 notes; send or remove some first")
    validateReview({ version: 2, annotations: [...latest.notes, ...Object.values(updates)] })
    await chrome.storage.local.set(updates)
    await updateMarkers()
    return { count: Object.keys(updates).length }
  })
  if (message.action === "send") return serial(async () => {
    const latest = await current(message)
    if (typeof message.targetID !== "string" || !message.targetID) throw new Error("Choose a destination session before sending")
    let { paired, disconnected } = await chrome.storage.local.get(["paired", "disconnected"])
    if (disconnected) throw new Error("Session disconnected; select it in Annotate to reconnect")
    if (paired && paired.id !== message.targetID) throw new Error("The destination changed in another panel; choose it again")
    if (!paired) {
      // A sole target is only preselected. The user's Send click authorizes this binding.
      const result = await native({ action: "info", targetID: message.targetID })
      if (!result.ok) throw new Error(result.error)
      paired = result.target
      await chrome.storage.local.set({ paired })
    }
    const outboxKey = "outbox"
    let batch = (await chrome.storage.local.get(outboxKey))[outboxKey]
    if (batch && batch.targetID !== paired.id) throw new Error("An unsent batch belongs to the previous pairing; restore that pairing or export your notes")
    if (!batch) {
      const pending = latest.notes.filter(note => note.sentRevision !== note.revision)
      if (!pending.length) throw new Error("No new feedback to send")
      const review = validateReview({ version: 2, annotations: pending })
      batch = { action: "send", batchID: crypto.randomUUID(), targetID: paired.id, review }
      await chrome.storage.local.set({ [outboxKey]: batch })
    }
    const response = await native(batch)
    if (!response.ok) throw new Error(response.error)
    const count = await closeRound(batch.review.annotations, { sentRound: batch.batchID, sentVia: "session", sentTo: paired.title })
    await chrome.storage.local.remove(outboxKey)
    return { ...response, count }
  })
  throw new Error("Unknown annotation action")
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error.message, code: error.code, draft: error.draft, note: error.note }))
  return true
})
