(() => {
  if (globalThis.__opencodeAnnotate === true) throw new Error("Refresh this page once to update annotation tools. Saved notes will remain.")
  if (globalThis.__opencodeAnnotate?.version === 10) return
  globalThis.__opencodeAnnotate?.dispose()
  if (!["text/html", "application/xhtml+xml"].includes(document.contentType)) throw new Error("Only HTML pages are supported")
  const listeners = new AbortController()
  const on = (target, event, handler, options = {}) => target.addEventListener(event, handler, { ...options, signal: listeners.signal })
  const host = document.createElement("div")
  host.setAttribute("data-opencode-annotate", "")
  // A manual popover puts the pointer-transparent viewport overlay in the top
  // layer without moving it under transformed/clipping dialog ancestors.
  host.setAttribute("popover", "manual")
  host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important"
  const root = host.attachShadow({ mode: "closed" })
  const style = document.createElement("style")
  style.textContent = `
    .box{position:fixed;pointer-events:none;border:2px solid #c96442;background:#c9644210}
    .area{box-sizing:border-box}
    .pin{position:fixed;display:grid;place-items:center;background:#c96442;color:#fff;border:2px solid #fff;border-radius:50%;font:600 12px/1 system-ui;width:26px;height:26px;pointer-events:none}
    .area-mark{border-style:dashed}
    .area-mark.is-active{border-style:solid;z-index:1}
    .area-mark .pin,.edge,.handle{position:absolute;touch-action:none}
    .area-mark .pin{left:-12px;top:-12px}
    .edge[data-side="n"],.edge[data-side="s"]{left:0;right:0;height:4px}
    .edge[data-side="w"],.edge[data-side="e"]{top:0;bottom:0;width:4px}
    .edge[data-side="n"]{top:-3px}.edge[data-side="s"]{bottom:-3px}
    .edge[data-side="w"]{left:-3px}.edge[data-side="e"]{right:-3px}
    .handle{width:8px;height:8px;border:1px solid #c96442;background:#fff;transform:translate(-50%,-50%)}
    .area-layer:not(.passive) .area-mark.is-active,.area-layer:not(.passive) :is(.edge,.pin,.handle){pointer-events:auto;cursor:move;touch-action:none}
  `
  root.append(style); document.documentElement.append(host)
  const areaLayer = document.createElement("div"); areaLayer.className = "area-layer"; root.append(areaLayer)
  const box = document.createElement("div"); box.className = "box"
  const highlight = document.createElement("div"); highlight.className = "box"
  const shield = document.createElement("div")
  shield.style.cssText = "position:fixed;inset:0;pointer-events:auto;cursor:crosshair;touch-action:none"
  let highlighted, highlightTimer
  const MIN_AREA = 5
  let mode = null, areaEvents, drag, areaDrag, url = location.href, timer, markers = [], active = true
  let draftMarker, markerFocus, markerKey
  let modals = []
  function syncLayer(force = false) {
    const next = [...document.querySelectorAll("dialog:modal")]
    const changed = force || next.length !== modals.length || next.some((node, index) => node !== modals[index])
    if (changed) box.remove()
    if (changed && host.matches(":popover-open")) host.hidePopover()
    if (!host.matches(":popover-open")) host.showPopover()
    modals = next
  }
  syncLayer()
  function send(anchor = null, error = null, modeOnly = false, ready = false) {
    if (!active) return
    try {
      chrome.runtime.sendMessage({ action: "capture", page: { url: location.href, title: document.title }, frame: AnnotateInspector.frame(), anchor, error, mode, modeOnly, ready }).catch(dispose)
    } catch { dispose() }
  }
  function setMode(value, notify = true) {
    if (mode === value) return
    areaEvents?.abort(); areaEvents = null
    clearDrag(); shield.remove(); box.remove()
    cancelAdjust()
    mode = value
    areaLayer.classList.toggle("passive", !!mode)
    box.classList.toggle("area", mode === "area")
    if (mode === "area") startArea()
    if (notify) send(null, null, true)
  }
  const point = event => ({ x: event.clientX, y: event.clientY })
  function documentRect() {
    const x = drag.end.x + scrollX, y = drag.end.y + scrollY
    return { x: Math.round(Math.min(drag.start.x, x)), y: Math.round(Math.min(drag.start.y, y)),
      width: Math.round(Math.abs(drag.start.x - x)), height: Math.round(Math.abs(drag.start.y - y)) }
  }
  const areaRect = ({ rect }) => new DOMRect(rect.x - scrollX, rect.y - scrollY, rect.width, rect.height)
  function paint(node, rect) {
    node.style.cssText = `left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px`
  }
  function clearDrag() {
    if (!drag) return
    const { target, id } = drag
    drag = null
    if (target.hasPointerCapture(id)) target.releasePointerCapture(id)
    box.remove()
  }
  function startArea() {
    areaEvents = new AbortController()
    const listen = (event, handler) => window.addEventListener(event, handler, { capture: true, signal: areaEvents.signal })
    const block = event => { event.preventDefault(); event.stopImmediatePropagation() }
    root.prepend(shield)
    listen("pointerdown", event => {
      block(event)
      if (event.button !== 0 || drag) return
      const target = event.target === host ? shield : event.target
      drag = { id: event.pointerId, target, start: { x: event.clientX + scrollX, y: event.clientY + scrollY }, end: point(event) }
      target.setPointerCapture(drag.id)
    })
    listen("pointermove", event => {
      if (drag?.id !== event.pointerId) return
      block(event)
      drag.end = point(event); drawArea()
    })
    let finishTimer, completed
    const finish = () => {
      clearTimeout(finishTimer)
      if (!completed) return
      const rect = completed; completed = null
      setMode(null, false)
      try { send(AnnotateInspector.captureArea(rect)) } catch (error) { send(null, error.message) }
    }
    listen("pointerup", event => {
      block(event)
      if (drag?.id !== event.pointerId) return
      drag.end = point(event)
      const rect = documentRect()
      clearDrag()
      if (rect.width < MIN_AREA || rect.height < MIN_AREA) return
      completed = rect; finishTimer = setTimeout(finish, 0)
    })
    listen("click", event => { block(event); finish() })
    const cancelDrag = event => { if (drag?.id === event.pointerId) clearDrag() }
    listen("pointercancel", cancelDrag)
    listen("lostpointercapture", cancelDrag)
    listen("keydown", event => { if (event.key === "Escape") { block(event); setMode(null) } })
    areaEvents.signal.addEventListener("abort", () => clearTimeout(finishTimer), { once: true })
  }
  function drawArea() {
    if (!drag) return
    root.append(box)
    paint(box, areaRect({ rect: documentRect() }))
  }
  const directions = ["n", "ne", "e", "se", "s", "sw", "w", "nw"]
  const block = event => { event.preventDefault(); event.stopImmediatePropagation() }
  const docPoint = event => ({ x: event.clientX + scrollX, y: event.clientY + scrollY })
  function adjustRect({ marker, side, start, end }) {
    const { x, y, width, height } = marker.anchor.rect
    const dx = Math.round(end.x + scrollX - start.x), dy = Math.round(end.y + scrollY - start.y)
    if (!side) return { x: x + dx, y: y + dy, width, height }
    const left = side.includes("w") ? Math.min(x + dx, x + width - MIN_AREA) : x
    const right = side.includes("e") ? Math.max(left + MIN_AREA, x + width + dx) : x + width
    const top = side.includes("n") ? Math.min(y + dy, y + height - MIN_AREA) : y
    const bottom = side.includes("s") ? Math.max(top + MIN_AREA, y + height + dy) : y + height
    return { x: left, y: top, width: right - left, height: bottom - top }
  }
  function cancelAdjust(repaint = true) {
    if (!areaDrag) return
    const { id } = areaDrag
    areaDrag = null
    if (areaLayer.hasPointerCapture(id)) areaLayer.releasePointerCapture(id)
    if (repaint) drawAreaMarkers()
  }
  async function areaGesture(action, marker, anchor) {
    try {
      const result = await chrome.runtime.sendMessage({ action, page: { url: location.href }, frame: AnnotateInspector.frame(),
        id: marker.id, revision: marker.revision, baseRect: marker.anchor.rect, anchor })
      if (!result.ok) throw new Error(result.error)
    } catch (error) {
      send(null, error.message, true)
    }
  }
  on(areaLayer, "pointerdown", event => {
    const id = event.target.closest(".area-mark")?.dataset.markerId
    if (mode || !id) return
    block(event)
    if (event.button !== 0 || areaDrag) return
    const marker = id === draftMarker?.id ? draftMarker : markers.find(note => note.id === id)
    if (!marker) return
    const adjustable = event.target.closest(".area-mark").classList.contains("is-active")
    areaDrag = { id: event.pointerId, marker, adjustable, side: event.target.dataset.handle,
      start: docPoint(event), end: point(event) }
    areaLayer.setPointerCapture(event.pointerId)
  })
  on(window, "pointermove", event => {
    if (!areaDrag || areaDrag.id !== event.pointerId) return
    block(event)
    areaDrag.end = point(event)
    if (areaDrag.adjustable) drawAreaMarkers()
  }, { capture: true })
  on(window, "pointerup", event => {
    if (!areaDrag || areaDrag.id !== event.pointerId) return
    block(event)
    const { adjustable, marker } = areaDrag
    areaDrag.end = point(event)
    const rect = adjustRect(areaDrag)
    cancelAdjust()
    if (adjustable && Object.keys(rect).some(key => rect[key] !== marker.anchor.rect[key])) {
      try { void areaGesture("area-adjust", marker, AnnotateInspector.captureArea(rect)) }
      catch (error) { send(null, error.message, true) }
    } else void areaGesture("area-focus", marker)
  }, { capture: true })
  on(window, "click", event => { if (event.target === host && !mode) block(event) }, { capture: true })
  on(window, "keydown", event => {
    if (event.key === "Escape" && areaDrag) { block(event); cancelAdjust() }
  }, { capture: true })
  for (const name of ["pointercancel", "lostpointercapture"]) on(window, name, event => {
    if (areaDrag?.id === event.pointerId) cancelAdjust()
  }, { capture: true })
  function selection() {
    if (mode || !active) return
    const selected = getSelection()
    if (!selected?.rangeCount || selected.isCollapsed || selected.anchorNode?.getRootNode() !== document) return
    const range = selected.getRangeAt(0).cloneRange()
    let element = range.commonAncestorContainer
    if (element.nodeType !== 1) element = element.parentElement
    try { send(AnnotateInspector.capture(element, range)) } catch (error) { send(null, error.message) }
  }
  on(document, "selectionchange", () => { clearTimeout(timer); timer = setTimeout(selection, 160) })
  on(document, "pointerup", selection)
  const hover = event => {
    if (mode !== "element") return
    syncLayer()
    if (["iframe", "frame", "frameset"].includes(event.target.localName)) {
      box.remove()
      if (event.target.localName !== "frameset") {
        try { if (!event.target.contentDocument) throw new Error() }
        catch { send(null, "This frame is from another site; Annotate can't read it", true) }
      }
      return
    }
    root.append(box)
    const rect = event.target.getBoundingClientRect()
    paint(box, rect)
  }
  on(document, "mousemove", hover, { capture: true })
  on(document, "pointerover", hover, { capture: true })
  on(document, "pointerdown", event => { if (mode === "element") { event.preventDefault(); event.stopImmediatePropagation() } }, { capture: true })
  on(document, "click", event => {
    if (mode !== "element") return
    if (event.target.localName === "frameset") return
    if (["iframe", "frame"].includes(event.target.localName)) {
      try { if (event.target.contentDocument) { box.remove(); return } } catch { /* inaccessible frame: explain below */ }
    }
    event.preventDefault(); event.stopImmediatePropagation()
    // A failed pick must never leave the page trapped in interception mode.
    setMode(null, false)
    try { send(AnnotateInspector.capture(event.target)) } catch (error) { send(null, error.message) }
  }, { capture: true })
  on(document, "keydown", event => { if (mode === "element" && event.key === "Escape") setMode(null) })
  const onMessage = (message, _sender, respond) => {
    if (message.action === "annotate-ping") { respond({ ok: true }); return }
    if (message.action === "pick") { setMode(message.mode, false); respond({ ok: true, mode }) }
    if (message.action === "markers") {
      const key = JSON.stringify([message.notes, message.draft, message.focus])
      if (key !== markerKey) {
        markerKey = key; markers = message.notes || []; draftMarker = message.draft; markerFocus = message.focus
        draw()
      }
      respond({ ok: true })
    }
    if (message.action === "locate") respond({ states: message.anchors.map(locate) })
    if (message.action === "reveal") {
      const state = locate(message.anchor)
      if (state !== "located") {
        respond({ ok: false, error: `This target is ${state}. Your feedback is kept.` })
        return
      }
      setMode(null, false)
      const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"
      if (message.anchor.type === "area") {
        const { x, y, width, height } = message.anchor.rect
        window.scrollTo({ left: x + (width - innerWidth) / 2, top: y + (height - innerHeight) / 2, behavior })
        respond({ ok: true }); return
      } else {
        highlighted = document.querySelector(message.anchor.selector)
        highlighted.scrollIntoView({ block: "center", inline: "nearest", behavior })
      }
      root.append(highlight); draw()
      clearTimeout(highlightTimer)
      highlightTimer = setTimeout(() => { highlighted = null; highlight.remove() }, 1600)
      respond({ ok: true })
    }
  }
  chrome.runtime.onMessage.addListener(onMessage)
  function locate(anchor) {
    if (anchor.type === "area") return "located"
    try {
      const matches = document.querySelectorAll(anchor.selector)
      if (matches.length !== 1) return matches.length ? "ambiguous" : "missing"
      const text = AnnotateInspector.text(matches[0])
      if (!text.includes(anchor.quote)) return "changed"
      if (anchor.type === "text" && text.split(anchor.quote).length > 2) {
        if (!text.includes(`${anchor.prefix || ""}${anchor.quote}${anchor.suffix || ""}`)) return "ambiguous"
      }
      return "located"
    } catch { return "invalid selector" }
  }
  function drawAreaMarkers() {
    const draws = []
    for (const [index, marker] of [...markers, ...(draftMarker ? [draftMarker] : [])].entries()) {
      if (marker.anchor?.type !== "area") continue
      const isDraft = marker === draftMarker
      const selected = marker.id && (markerFocus ? marker.id === markerFocus : isDraft)
      const rect = areaDrag?.adjustable && areaDrag.marker.id === marker.id ? adjustRect(areaDrag) : marker.anchor.rect
      const mark = document.createElement("div")
      mark.className = `box area area-mark${selected ? " is-active" : ""}`
      if (marker.id) mark.dataset.markerId = marker.id
      paint(mark, areaRect({ rect }))
      if (selected) {
        for (const side of directions) {
          const handle = document.createElement("span"); handle.className = "handle"; handle.dataset.handle = side
          handle.style.cssText = `left:${side.includes("w") ? "0" : side.includes("e") ? "100%" : "50%"};top:${side.includes("n") ? "0" : side.includes("s") ? "100%" : "50%"};cursor:${side}-resize`
          mark.append(handle)
        }
      } else if (marker.id) {
        for (const side of ["n", "e", "s", "w"]) {
          const edge = document.createElement("span"); edge.className = "edge"; edge.dataset.side = side; mark.append(edge)
        }
      }
      if (!isDraft) {
        const pin = document.createElement("span"); pin.className = "pin"; pin.textContent = String(marker.number ?? index + 1)
        mark.append(pin)
      }
      draws.push(mark)
    }
    areaLayer.replaceChildren(...draws)
  }
  function draw() {
    syncLayer()
    drawArea()
    drawAreaMarkers()
    if (highlighted?.isConnected) paint(highlight, highlighted.getBoundingClientRect())
    else highlight.remove()
    for (const child of [...root.children]) if (child.classList.contains("pin")) child.remove()
    for (const [index, note] of markers.entries()) {
      if (!note.anchor || note.anchor.type === "area") continue
      let matches
      try { matches = document.querySelectorAll(note.anchor.selector) } catch { continue }
      if (matches.length !== 1 || !AnnotateInspector.text(matches[0]).includes(note.anchor.quote)) continue
      const rect = matches[0].getBoundingClientRect()
      const pin = document.createElement("span"); pin.className = "pin"; pin.textContent = String(note.number ?? index + 1)
      pin.style.cssText = `left:${rect.left - 10}px;top:${rect.top - 10}px`; root.append(pin)
    }
  }
  on(document, "scroll", draw, { capture: true, passive: true }); on(window, "resize", draw)
  const observer = new MutationObserver(records => {
    // showModal/close mutate `open`; observe it as well as removed dialogs.
    // Force a raise even if a dialog closes and reopens in one mutation batch.
    syncLayer(records.some(record => record.type === "attributes" && record.target.localName === "dialog"))
    clearTimeout(timer); timer = setTimeout(draw, 160)
  })
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["open"] })
  on(document, "load", event => {
    if (["iframe", "frame"].includes(event.target.localName)) chrome.runtime.sendMessage({ action: "frames-changed" }).catch(() => {})
  }, { capture: true })
  const routeTimer = setInterval(() => {
    if (!active) { observer.disconnect(); return }
    if (url !== location.href) {
      url = location.href; setMode(null, false); cancelAdjust(false); markers = []; draftMarker = markerFocus = markerKey = null; draw(); send()
    }
  }, 700)
  function dispose() {
    if (!active) return
    active = false; setMode(null, false); cancelAdjust(false); listeners.abort(); clearInterval(routeTimer); clearTimeout(timer); clearTimeout(highlightTimer); observer.disconnect(); host.remove()
    try { chrome.runtime.onMessage.removeListener(onMessage) } catch { /* previous extension context may already be invalidated */ }
    delete globalThis.__opencodeAnnotate
  }
  globalThis.__opencodeAnnotate = { dispose, version: 10 }
  send(null, null, true, true)
})();
