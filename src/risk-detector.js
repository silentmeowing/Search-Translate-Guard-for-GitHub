(() => {
  "use strict";

  const detectorSymbol = Symbol.for("search-translate-guard.risk-detector");
  if (globalThis[detectorSymbol]) return;

  const compositeRoles = new Set([
    "combobox", "listbox", "menu", "tree", "grid", "tablist"
  ]);
  const frameworkPrefixes = [
    "data-radix-", "data-headlessui-", "data-reach-", "data-floating-ui-"
  ];
  const ignoredTags = new Set([
    "html", "head", "body", "script", "style", "link", "meta", "svg", "path"
  ]);

  function addSignal(result, name, weight) {
    if (result.reasons.includes(name)) return;
    result.reasons.push(name);
    result.score += weight;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  /**
   * Find a bounded interactive component boundary without reading text.
   * @param {Element} target
   * @returns {Element | null}
   */
  function boundaryFor(target) {
    if (!(target instanceof Element)) return null;
    if ([document.body, document.documentElement].includes(target)) return null;
    const semantic = target.closest([
      "input", "textarea", "select", "button", "[contenteditable=true]",
      "[role=combobox]", "[role=listbox]", "[role=dialog]", "[role=menu]",
      "[role=tree]", "[role=grid]", "[role=tablist]", "[role=textbox]"
    ].join(",")) || target;

    let candidate = semantic;
    let ancestor = semantic.parentElement;
    for (let depth = 0; ancestor && depth < 3; depth += 1, ancestor = ancestor.parentElement) {
      if (
        ancestor.localName.includes("-") ||
        ancestor.matches("[role=combobox], [role=listbox], [role=dialog], [role=menu], [role=tree], [role=grid], [role=tablist]")
      ) {
        candidate = ancestor;
        break;
      }
    }
    return [document.body, document.documentElement].includes(candidate) ? null : candidate;
  }

  /**
   * Score structural interaction signals only. Visible text, field values, and
   * application data are deliberately excluded.
   * @param {Element} element
   * @returns {{ score: number, reasons: string[] }}
   */
  function score(element) {
    const result = { score: 0, reasons: [] };
    if (!(element instanceof Element) || ignoredTags.has(element.localName)) return result;

    const tag = element.localName;
    const role = element.getAttribute("role")?.toLowerCase() || "";
    if (tag.includes("-")) {
      addSignal(result, "custom-element", 2);
      if (element.querySelector([
        "input", "textarea", "select", "button", "[contenteditable]",
        "[role=combobox]", "[role=listbox]", "[role=dialog]", "[role=menu]"
      ].join(","))) {
        addSignal(result, "interactive-descendant", 2);
      }
    }
    if (tag === "dialog" || role === "dialog" || role === "alertdialog") {
      addSignal(result, "dialog", 5);
    }
    if (compositeRoles.has(role)) addSignal(result, "composite-role", 5);
    if (tag === "select") addSignal(result, "select-control", 4);
    if (
      tag === "textarea" ||
      role === "textbox" ||
      (tag === "input" && !["hidden", "checkbox", "radio", "submit", "button"].includes(
        element.getAttribute("type")?.toLowerCase() || "text"
      ))
    ) {
      addSignal(result, "editable-control", 2);
    }
    if (element.matches('[contenteditable="true"], [contenteditable="plaintext-only"]')) {
      addSignal(result, "editable-control", 2);
    }
    if (element.hasAttribute("aria-controls")) addSignal(result, "aria-controls", 2);
    if (element.hasAttribute("aria-expanded")) addSignal(result, "aria-expanded", 2);
    if (element.hasAttribute("aria-haspopup")) addSignal(result, "aria-popup", 2);
    if (element.hasAttribute("popover")) addSignal(result, "popover", 3);
    if (element.hasAttribute("data-state")) addSignal(result, "framework-state", 2);

    for (const attribute of element.attributes) {
      if (frameworkPrefixes.some((prefix) => attribute.name.startsWith(prefix))) {
        addSignal(result, "framework-state", 2);
        break;
      }
    }

    return result;
  }

  /**
   * @param {Document | Element} [root]
   * @param {{ maxElements?: number, maxSuggestions?: number, minimumScore?: number }} [options]
   * @returns {{ element: Element, score: number, reasons: string[] }[]}
   */
  function detect(root = document, options = {}) {
    const maxElements = Math.max(1, Math.min(Number(options.maxElements) || 3000, 5000));
    const maxSuggestions = Math.max(1, Math.min(Number(options.maxSuggestions) || 24, 50));
    const minimumScore = Math.max(1, Math.min(Number(options.minimumScore) || 4, 20));
    const ownerDocument = root instanceof Document ? root : root.ownerDocument || document;
    const walker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const suggestions = [];
    let visited = 0;

    while (walker.nextNode() && visited < maxElements) {
      visited += 1;
      const element = walker.currentNode;
      if (!(element instanceof Element) || !isVisible(element)) continue;
      const result = score(element);
      if (result.score < minimumScore) continue;
      suggestions.push({ element, score: result.score, reasons: result.reasons });
    }

    return suggestions
      .sort((left, right) => right.score - left.score)
      .slice(0, maxSuggestions);
  }

  Object.defineProperty(globalThis, detectorSymbol, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ boundaryFor, detect, isVisible, score })
  });
})();
