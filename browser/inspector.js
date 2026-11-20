// Derived from AsimSayed/annotate-html 1.0.0, MIT. Original bytes and license in upstream/.
(() => {
  function identifyElement(target, text) {
    const tag = target.tagName.toLowerCase()
    if (target.dataset?.element) return target.dataset.element
    if (["path", "circle", "rect", "line", "g", "svg"].includes(tag)) return "graphic element"
    const label = target.getAttribute("aria-label") || target.getAttribute("alt") || text || ""
    if (tag === "input") return `input "${target.getAttribute("placeholder") || target.getAttribute("type") || "text"}"`
    return label ? `${tag} "${label.slice(0, 60)}"` : tag
  }
  function getComputedSnapshot(el) {
    var s = window.getComputedStyle(el)
    var parts = []
    if (s.color && s.color !== "rgb(0, 0, 0)") parts.push("color: " + s.color)
    var bg = s.backgroundColor
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") parts.push("bg: " + bg)
    if (s.fontSize) parts.push("font: " + s.fontSize)
    if (s.fontWeight && s.fontWeight !== "400" && s.fontWeight !== "normal") parts.push("weight: " + s.fontWeight)
    if (s.padding && s.padding !== "0px") parts.push("padding: " + s.padding)
    if (s.margin && s.margin !== "0px") parts.push("margin: " + s.margin)
    var d = s.display
    if (d && d !== "block" && d !== "inline") parts.push("display: " + d)
    if (s.position && s.position !== "static") parts.push("position: " + s.position)
    if (s.borderRadius && s.borderRadius !== "0px") parts.push("radius: " + s.borderRadius)
    return parts.join(", ")
  }
  function getA11yInfo(el) {
    var parts = []
    var role = el.getAttribute("role")
    var ariaLabel = el.getAttribute("aria-label")
    var tabIndex = el.getAttribute("tabindex")
    var ariaHidden = el.getAttribute("aria-hidden")
    if (role) parts.push('role="' + role + '"')
    if (ariaLabel) parts.push('aria-label="' + ariaLabel + '"')
    if (tabIndex) parts.push("tabindex=" + tabIndex)
    if (ariaHidden === "true") parts.push("aria-hidden")
    if (el.matches("a, button, input, select, textarea, [tabindex]")) parts.push("focusable")
    return parts.join(", ")
  }
  function selector(element) {
    const document = element.ownerDocument
    const parts = []
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) { parts.unshift(`#${CSS.escape(node.id)}`); break }
      const siblings = node.parentElement ? [...node.parentElement.children].filter(x => x.localName === node.localName) : [node]
      parts.unshift(`${CSS.escape(node.localName)}:nth-of-type(${siblings.indexOf(node) + 1})`)
    }
    const result = parts.join(" > ")
    if (document.querySelectorAll(result).length !== 1) throw new Error("Element cannot be uniquely located")
    return result
  }
  const editable = 'input,textarea,select,[contenteditable]:not([contenteditable="false"])'
  const excluded = `${editable},script,style,noscript,template,[hidden],[aria-hidden="true"]`
  function textFilter() {
    const cache = new WeakMap()
    return function omitted(element) {
      if (!element) return false
      if (cache.has(element)) return cache.get(element)
      const style = getComputedStyle(element)
      const hidden = element.matches(excluded) || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0" || omitted(element.parentElement)
      cache.set(element, hidden)
      return hidden
    }
  }
  function safeText(range, omitted) {
    const root = range.commonAncestorContainer
    const nodes = []
    if (root.nodeType === Node.TEXT_NODE) nodes.push(root)
    else {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) nodes.push(node)
    }
    const pieces = []
    for (const node of nodes) {
      if (!range.intersectsNode(node) || omitted(node.parentElement)) continue
      const start = node === range.startContainer ? range.startOffset : 0
      const end = node === range.endContainer ? range.endOffset : node.length
      pieces.push(node.data.slice(start, end))
    }
    return pieces.join("")
  }
  function elementText(element, omitted = textFilter()) {
    const control = element.closest(editable)
    if (control) return control.getAttribute("aria-label") || control.getAttribute("placeholder") || `${control.getAttribute("type") || control.localName} control`
    const contents = document.createRange(); contents.selectNodeContents(element)
    return safeText(contents, omitted).trim() || element.getAttribute("aria-label") || element.getAttribute("alt") || element.localName
  }
  function capture(element, range) {
    if (!element || element.getRootNode() !== document) throw new Error("Select content in the main page")
    // Decorative SVGs commonly carry aria-hidden. Point to their visible control instead.
    if (!range && element.closest("[aria-hidden=true]")) element = element.closest('button,a,[role="button"]') || element.parentElement
    if (!element) throw new Error("Choose a visible page element")
    const style = getComputedStyle(element)
    if (element.closest("[hidden],script,style,noscript,template") || style.display === "none" || style.visibility === "hidden") throw new Error("Choose a visible page element")
    if (["iframe", "frame"].includes(element.localName)) throw new Error("This frame is from another site; Annotate can't read it")
    if (["canvas", "embed", "object"].includes(element.localName)) throw new Error("This content type is unsupported")
    const omitted = textFilter()
    const contents = document.createRange(); contents.selectNodeContents(element)
    const visibleText = safeText(contents, omitted).trim()
    const container = element.closest("p,li,blockquote,pre,td,th,section,article,main") || element
    let quote = "", prefix = "", suffix = ""
    if (range) {
      quote = safeText(range, omitted)
      if (!quote.trim()) throw new Error("Editable values are private. Use Pick an element to annotate the control itself.")
      const before = document.createRange(); before.selectNodeContents(container); before.setEnd(range.startContainer, range.startOffset)
      const after = document.createRange(); after.selectNodeContents(container); after.setStart(range.endContainer, range.endOffset)
      prefix = [...safeText(before, omitted)].slice(-160).join(""); suffix = [...safeText(after, omitted)].slice(0, 160).join("")
    } else {
      element = element.closest(editable) || element
      quote = elementText(element, omitted)
      for (const [sibling, side] of [[element.previousElementSibling, "before"], [element.nextElementSibling, "after"]]) {
        if (!sibling) continue
        const siblingRange = document.createRange(); siblingRange.selectNodeContents(sibling)
        const text = safeText(siblingRange, omitted)
        if (side === "before") prefix = [...text].slice(-160).join(""); else suffix = [...text].slice(0, 160).join("")
      }
    }
    if (quote.length > 4000) throw new Error("Choose at most 4000 characters")
    const rect = (range || element).getBoundingClientRect()
    return { type: range ? "text" : "element", quote, prefix, suffix, selector: selector(element), fullPath: selector(element),
      element: identifyElement(element, visibleText), styles: getComputedSnapshot(element), accessibility: getA11yInfo(element),
      rect: Object.fromEntries(["x", "y", "width", "height"].map(key => [key, Math.round(rect[key])])),
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY } }
  }
  const intersection = (a, b) => {
    const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top)
    const right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom)
    return right > left && bottom > top ? { left, top, right, bottom } : null
  }
  const size = rect => (rect.right - rect.left) * (rect.bottom - rect.top)
  const contains = (outer, inner) => outer.left <= inner.left && outer.top <= inner.top && outer.right >= inner.right && outer.bottom >= inner.bottom
  function captureArea(rect) {
    const viewport = { width: innerWidth, height: innerHeight, scrollX, scrollY }
    const region = intersection(new DOMRect(rect.x - scrollX, rect.y - scrollY, rect.width, rect.height), new DOMRect(0, 0, innerWidth, innerHeight))
    const container = [...document.querySelectorAll("dialog:modal")].at(-1) || document.body
    if (!region || !container) return { type: "area", rect, viewport, quote: "", selectors: [] }
    const omitted = textFilter(), clips = new WeakMap(), range = document.createRange(), candidates = []
    function clip(element) {
      if (!element) return region
      if (clips.has(element)) return clips.get(element)
      let bounds = clip(element.parentElement)
      const style = getComputedStyle(element)
      if (bounds && element.clientWidth && element.clientHeight && (style.overflowX !== "visible" || style.overflowY !== "visible")) {
        const box = element.getBoundingClientRect()
        bounds = intersection(bounds, {
          left: style.overflowX === "visible" ? bounds.left : box.left,
          right: style.overflowX === "visible" ? bounds.right : box.right,
          top: style.overflowY === "visible" ? bounds.top : box.top,
          bottom: style.overflowY === "visible" ? bounds.bottom : box.bottom,
        })
      }
      clips.set(element, bounds)
      return bounds
    }
    function textIn(node, bounds, start, end) {
      range.setStart(node, start); range.setEnd(node, end)
      const boxes = [...range.getClientRects()].filter(box => size(box) > 0)
      if (!boxes.some(box => intersection(bounds, box))) return ""
      if (end - start <= 1 || boxes.every(box => contains(bounds, box))) return node.data.slice(start, end)
      const middle = Math.floor((start + end) / 2)
      return textIn(node, bounds, start, middle) + textIn(node, bounds, middle, end)
    }
    let quote = ""
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
    for (let node; (node = walker.nextNode());) {
      const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node
      if (omitted(element)) continue
      const bounds = clip(element.parentElement)
      if (!bounds) continue
      if (node === element) {
        const box = element.getBoundingClientRect()
        const overlap = intersection(bounds, box)
        if (overlap) candidates.push({ element, score: size(overlap) / (size(region) + size(box) - size(overlap)) })
      } else if (quote.length < 4000 && node.data.trim()) {
        const clipped = clip(element)
        if (!clipped) continue
        const text = textIn(node, clipped, 0, node.length).replace(/\s+/g, " ").trim()
        if (text) quote = `${quote}${quote ? " " : ""}${text}`.slice(0, 4000)
      }
    }
    const selectors = []
    for (const { element } of candidates.sort((a, b) => b.score - a.score)) {
      try {
        const hint = selector(element)
        if (hint.length <= 1000) selectors.push(hint)
      } catch { /* A selector is evidence, not the area anchor. */ }
      if (selectors.length === 5) break
    }
    return { type: "area", rect, viewport, quote, selectors }
  }
  function frame() {
    const selectors = []
    for (let current = window; current !== current.top; current = current.parent) {
      // Access is deliberately limited to same-origin ancestors.
      selectors.unshift(selector(current.frameElement))
    }
    return selectors.length ? { selectors, url: location.href } : null
  }
  globalThis.AnnotateInspector = { capture, captureArea, text: elementText, frame }
})();
