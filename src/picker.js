(() => {
  "use strict";

  const pickerSymbol = Symbol.for("search-translate-guard.component-picker");
  const requestSymbol = Symbol.for("search-translate-guard.component-picker-request");
  const detectorSymbol = Symbol.for("search-translate-guard.risk-detector");
  const mutationObserverSymbol = Symbol.for("search-translate-guard.mutation-risk-observer");
  const detector = globalThis[detectorSymbol];
  const selectorTools = globalThis[Symbol.for("search-translate-guard.selector-tools")];
  if (!selectorTools || !detector?.boundaryFor) {
    throw new Error("Risk detector and selector tools must load before the component picker");
  }
  globalThis[pickerSymbol]?.cancel();
  const request = globalThis[requestSymbol];
  delete globalThis[requestSymbol];
  const repairRuleId = typeof request?.ruleId === "string" && request.ruleId.length <= 128
    ? request.ruleId
    : "";

  const message = (key, fallback, substitutions) => {
    try {
      return chrome.i18n.getMessage(key, substitutions) || fallback;
    } catch {
      return fallback;
    }
  };

  const text = {
    instruction: repairRuleId
      ? message("pickerRepairInstruction", "Select the replacement boundary for this unresolved rule.")
      : message("pickerInstruction", "Hover a component, then click it to select its protection boundary."),
    selected: message("pickerSelected", "Component selected. Confirm it or choose its parent."),
    protect: repairRuleId
      ? message("pickerRepair", "Repair component rule")
      : message("pickerProtect", "Protect component"),
    parent: message("pickerParent", "Choose parent"),
    next: message("pickerNextSuggestion", "Next suggestion"),
    manual: message("pickerChooseManually", "Choose manually"),
    cancel: message("pickerCancel", "Cancel"),
    saved: repairRuleId
      ? message("pickerRepaired", "Component rule repaired.")
      : message("pickerSaved", "Protection saved. Reload after enabling page translation."),
    error: message("pickerError", "The component rule could not be saved.")
  };

  const host = document.createElement("div");
  host.id = "search-translate-guard-picker";
  host.setAttribute("translate", "no");
  host.classList.add("notranslate");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
      .highlight { position: fixed; box-sizing: border-box; border: 3px solid #0969da; border-radius: 6px; background: rgba(9, 105, 218, .12); box-shadow: 0 0 0 2px #fff; pointer-events: none; }
      .panel { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); width: min(560px, calc(100vw - 32px)); box-sizing: border-box; padding: 14px; border: 1px solid #d0d7de; border-radius: 10px; color: #1f2328; background: #fff; box-shadow: 0 12px 36px rgba(1, 4, 9, .3); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; pointer-events: auto; }
      .status { margin: 0; }
      .selector { margin: 8px 0 0; padding: 7px; border-radius: 6px; color: #57606a; background: #f6f8fa; font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
      .actions { display: none; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
      button { min-height: 34px; border: 1px solid #d0d7de; border-radius: 6px; padding: 0 12px; cursor: pointer; color: #24292f; background: #f6f8fa; font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      button.primary { color: #fff; border-color: rgba(31, 35, 40, .15); background: #1f883d; }
      button:disabled { cursor: not-allowed; opacity: .55; }
      @media (prefers-color-scheme: dark) {
        .panel { color: #f0f6fc; background: #0d1117; border-color: #30363d; }
        .selector { color: #8b949e; background: #161b22; }
        button { color: #f0f6fc; background: #21262d; border-color: #30363d; }
      }
    </style>
    <div class="highlight" hidden></div>
    <section class="panel" role="dialog" aria-live="polite">
      <p class="status"></p>
      <div class="selector" hidden></div>
      <div class="actions">
        <button class="primary protect" type="button"></button>
        <button class="parent" type="button"></button>
        <button class="next" type="button"></button>
        <button class="manual" type="button"></button>
        <button class="cancel" type="button"></button>
      </div>
    </section>`;

  const highlight = shadow.querySelector(".highlight");
  const status = shadow.querySelector(".status");
  const selectorDisplay = shadow.querySelector(".selector");
  const actions = shadow.querySelector(".actions");
  const protectButton = shadow.querySelector(".protect");
  const parentButton = shadow.querySelector(".parent");
  const nextButton = shadow.querySelector(".next");
  const manualButton = shadow.querySelector(".manual");
  const cancelButton = shadow.querySelector(".cancel");
  protectButton.textContent = text.protect;
  parentButton.textContent = text.parent;
  nextButton.textContent = text.next;
  manualButton.textContent = text.manual;
  cancelButton.textContent = text.cancel;
  status.textContent = text.instruction;

  let hovered = null;
  let selected = null;
  let selector = "";
  let suggestions = [];
  let suggestionIndex = -1;
  let finished = false;

  function chooseBoundary(target) {
    return detector.boundaryFor(target);
  }

  function positionHighlight(element) {
    if (!element?.isConnected) {
      highlight.hidden = true;
      return;
    }
    const rect = element.getBoundingClientRect();
    Object.assign(highlight.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`
    });
    highlight.hidden = false;
  }

  function suggestedStatus(index, total, suggestion) {
    if (suggestion.observed) {
      return message(
        "pickerObservedSuggestion",
        `Recent DOM text rewriting was observed in component ${index} of ${total} (score ${suggestion.score}). Confirm it or inspect another candidate.`,
        [String(index), String(total), String(suggestion.score)]
      );
    }
    return message(
      "pickerSuggested",
      `Suggested high-risk component ${index} of ${total} (score ${suggestion.score}). Confirm it or inspect another candidate.`,
      [String(index), String(total), String(suggestion.score)]
    );
  }

  function showSelection(element, suggestion = null) {
    selected = element;
    selector = selectorTools.selectorFor(element);
    status.textContent = suggestion
      ? suggestedStatus(suggestionIndex + 1, suggestions.length, suggestion)
      : text.selected;
    selectorDisplay.textContent = selector;
    selectorDisplay.hidden = false;
    actions.style.display = "flex";
    parentButton.disabled = !element.parentElement || [document.body, document.documentElement].includes(element.parentElement);
    nextButton.hidden = !suggestion || suggestions.length < 2;
    manualButton.hidden = !suggestion;
    positionHighlight(element);
  }

  function showSuggestion(index) {
    if (!suggestions.length) return false;
    for (let offset = 0; offset < suggestions.length; offset += 1) {
      const candidateIndex = (index + offset + suggestions.length) % suggestions.length;
      const suggestion = suggestions[candidateIndex];
      if (!suggestion.element.isConnected) continue;
      suggestionIndex = candidateIndex;
      showSelection(suggestion.element, suggestion);
      return true;
    }
    return false;
  }

  function loadSuggestions() {
    if (!detector?.detect || !detector?.score) return;

    const byBoundary = new Map();
    const include = (detected, observed = false) => {
      const boundary = chooseBoundary(detected.element);
      if (!boundary || boundary === host) return;
      const boundaryRisk = detector.score(boundary);
      const score = Math.max(detected.score, boundaryRisk.score);
      const previous = byBoundary.get(boundary);
      const reasons = [...new Set([
        ...(previous?.reasons || []),
        ...detected.reasons,
        ...boundaryRisk.reasons
      ])];
      byBoundary.set(boundary, {
        element: boundary,
        score: Math.max(previous?.score || 0, score),
        reasons,
        observed: Boolean(previous?.observed || observed)
      });
    };

    for (const detected of detector.detect(document)) {
      include(detected);
    }
    const mutationRisks = globalThis[mutationObserverSymbol];
    for (const observed of mutationRisks?.candidates?.() || []) {
      include(observed, true);
    }

    suggestions = [...byBoundary.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, 12);
    showSuggestion(0);
  }

  function beginManualSelection() {
    selected = null;
    hovered = null;
    selector = "";
    suggestionIndex = -1;
    status.textContent = text.instruction;
    selectorDisplay.hidden = true;
    actions.style.display = "none";
    highlight.hidden = true;
  }

  function onPointerMove(event) {
    if (selected || event.composedPath().includes(host)) return;
    hovered = chooseBoundary(event.target);
    positionHighlight(hovered);
  }

  function onPageClick(event) {
    if (event.composedPath().includes(host)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const boundary = hovered || chooseBoundary(event.target);
    if (!selected && boundary) showSelection(boundary);
  }

  function onPagePointerDown(event) {
    if (event.composedPath().includes(host)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function sendMessage(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!response?.ok) reject(new Error(response?.error || text.error));
        else resolve(response.result);
      });
    });
  }

  function cleanup() {
    if (finished) return;
    finished = true;
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerdown", onPagePointerDown, true);
    document.removeEventListener("click", onPageClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    globalThis.removeEventListener("scroll", onViewportChange, true);
    globalThis.removeEventListener("resize", onViewportChange, true);
    host.remove();
    delete globalThis[pickerSymbol];
  }

  function onKeyDown(event) {
    if (event.key === "Escape") cleanup();
  }

  function onViewportChange() {
    positionHighlight(selected || hovered);
  }

  protectButton.addEventListener("click", async () => {
    if (!selected || !selector) return;
    protectButton.disabled = true;
    try {
      await sendMessage({
        type: repairRuleId ? "site-guard:replace-rule" : "site-guard:add-rule",
        origin: location.origin,
        rule: {
          ...(repairRuleId ? { id: repairRuleId } : {}),
          selector,
          fingerprint: selectorTools.fingerprintFor(selected)
        }
      });
      selected.setAttribute("translate", "no");
      selected.classList.add("notranslate");
      status.textContent = text.saved;
      selectorDisplay.hidden = true;
      actions.style.display = "none";
      setTimeout(cleanup, 1_800);
    } catch (error) {
      status.textContent = error.message || text.error;
      protectButton.disabled = false;
    }
  });

  parentButton.addEventListener("click", () => {
    if (selected?.parentElement) showSelection(selected.parentElement);
  });
  nextButton.addEventListener("click", () => showSuggestion(suggestionIndex + 1));
  manualButton.addEventListener("click", beginManualSelection);
  cancelButton.addEventListener("click", cleanup);

  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerdown", onPagePointerDown, true);
  document.addEventListener("click", onPageClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  globalThis.addEventListener("scroll", onViewportChange, true);
  globalThis.addEventListener("resize", onViewportChange, true);
  (document.body || document.documentElement).append(host);

  Object.defineProperty(globalThis, pickerSymbol, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: Object.freeze({ cancel: cleanup })
  });

  loadSuggestions();
})();
