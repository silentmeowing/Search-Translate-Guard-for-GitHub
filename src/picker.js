(() => {
  "use strict";

  const pickerSymbol = Symbol.for("search-translate-guard.component-picker");
  globalThis[pickerSymbol]?.cancel();

  const message = (key, fallback) => {
    try {
      return chrome.i18n.getMessage(key) || fallback;
    } catch {
      return fallback;
    }
  };

  const text = {
    instruction: message("pickerInstruction", "Hover a component, then click it to select its protection boundary."),
    selected: message("pickerSelected", "Component selected. Confirm it or choose its parent."),
    protect: message("pickerProtect", "Protect component"),
    parent: message("pickerParent", "Choose parent"),
    cancel: message("pickerCancel", "Cancel"),
    saved: message("pickerSaved", "Protection saved. Reload after enabling page translation."),
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
        <button class="cancel" type="button"></button>
      </div>
    </section>`;

  const highlight = shadow.querySelector(".highlight");
  const status = shadow.querySelector(".status");
  const selectorDisplay = shadow.querySelector(".selector");
  const actions = shadow.querySelector(".actions");
  const protectButton = shadow.querySelector(".protect");
  const parentButton = shadow.querySelector(".parent");
  const cancelButton = shadow.querySelector(".cancel");
  protectButton.textContent = text.protect;
  parentButton.textContent = text.parent;
  cancelButton.textContent = text.cancel;
  status.textContent = text.instruction;

  let hovered = null;
  let selected = null;
  let selector = "";
  let finished = false;

  function escapeIdentifier(value) {
    return globalThis.CSS?.escape
      ? CSS.escape(value)
      : value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
  }

  function escapeAttribute(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function isUnique(candidate) {
    try {
      return document.querySelectorAll(candidate).length === 1;
    } catch {
      return false;
    }
  }

  function stableSegment(element) {
    const tag = element.localName;
    if (element.id) {
      const candidate = `#${escapeIdentifier(element.id)}`;
      if (isUnique(candidate)) return { value: candidate, unique: true };
    }

    for (const name of ["data-testid", "data-test", "data-target", "data-component"]) {
      const value = element.getAttribute(name);
      if (!value || value.length > 120) continue;
      const candidate = `${tag}[${name}="${escapeAttribute(value)}"]`;
      if (isUnique(candidate)) return { value: candidate, unique: true };
    }

    let value = tag;
    for (const name of ["role", "name", "type"]) {
      const attribute = element.getAttribute(name);
      if (attribute && attribute.length <= 80) {
        value += `[${name}="${escapeAttribute(attribute)}"]`;
      }
    }

    const stableClasses = [...element.classList]
      .filter((name) => /^[a-zA-Z][\w-]{0,40}$/.test(name))
      .filter((name) => !/^(active|current|focus|hover|open|selected|disabled)$/i.test(name))
      .slice(0, 2);
    if (stableClasses.length) value += stableClasses.map((name) => `.${escapeIdentifier(name)}`).join("");

    const siblings = element.parentElement
      ? [...element.parentElement.children].filter((candidate) => candidate.localName === tag)
      : [];
    if (siblings.length > 1) value += `:nth-of-type(${siblings.indexOf(element) + 1})`;
    return { value, unique: isUnique(value) };
  }

  function selectorFor(element) {
    const parts = [];
    let current = element;
    for (let depth = 0; current && current !== document.documentElement && depth < 6; depth += 1) {
      const segment = stableSegment(current);
      parts.unshift(segment.value);
      const candidate = parts.join(" > ");
      if (segment.unique || isUnique(candidate)) return candidate;
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  function chooseBoundary(target) {
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

  function fingerprintFor(element) {
    const landmark = element.closest("header, nav, main, form, [role=dialog], [role=main], [role=navigation]");
    return {
      tag: element.localName,
      role: element.getAttribute("role") || "",
      type: element.getAttribute("type") || "",
      name: element.getAttribute("name") || "",
      landmark: landmark ? landmark.localName : ""
    };
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

  function showSelection(element) {
    selected = element;
    selector = selectorFor(element);
    status.textContent = text.selected;
    selectorDisplay.textContent = selector;
    selectorDisplay.hidden = false;
    actions.style.display = "flex";
    parentButton.disabled = !element.parentElement || [document.body, document.documentElement].includes(element.parentElement);
    positionHighlight(element);
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
        type: "site-guard:add-rule",
        origin: location.origin,
        rule: { selector, fingerprint: fingerprintFor(selected) }
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
})();
