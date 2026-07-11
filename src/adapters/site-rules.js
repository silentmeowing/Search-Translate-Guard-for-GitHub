(() => {
  "use strict";

  const runtime = globalThis[Symbol.for("search-translate-guard.runtime")];
  if (!runtime) throw new Error("Search Translate Guard core must load before adapters");

  const storageKey = "siteGuardConfig";
  const origin = location.origin;
  const stateSymbol = Symbol.for(`search-translate-guard.site-rules:${origin}`);
  const existingState = globalThis[stateSymbol];
  if (existingState) {
    void existingState.reload();
    return;
  }

  let previousState = new WeakMap();
  let selectors = [];

  function validSelectors(rules) {
    const accepted = [];
    for (const rule of Array.isArray(rules) ? rules : []) {
      const selector = typeof rule?.selector === "string" ? rule.selector.trim() : "";
      if (!selector || selector.length > 512) continue;
      try {
        document.querySelector(selector);
        accepted.push(selector);
      } catch {
        // Ignore stale or invalid local rules without breaking the page.
      }
    }
    return [...new Set(accepted)];
  }

  function remember(element) {
    if (!previousState.has(element)) {
      previousState.set(element, {
        translate: element.getAttribute("translate"),
        hadNoTranslateClass: element.classList.contains("notranslate"),
        marker: element.getAttribute("data-search-translate-guard-rule")
      });
    }
    element.setAttribute("data-search-translate-guard-rule", "true");
    return element;
  }

  function restoreProtectedElements() {
    document.querySelectorAll('[data-search-translate-guard-rule="true"]').forEach((element) => {
      const previous = previousState.get(element);
      if (!previous) return;

      if (element.getAttribute("translate") === "no") {
        if (previous.translate === null) element.removeAttribute("translate");
        else element.setAttribute("translate", previous.translate);
      }
      if (!previous.hadNoTranslateClass) element.classList.remove("notranslate");
      if (previous.marker === null) element.removeAttribute("data-search-translate-guard-rule");
      else element.setAttribute("data-search-translate-guard-rule", previous.marker);
    });
    previousState = new WeakMap();
  }

  function selectTargets(root) {
    const targets = [];
    for (const selector of selectors) {
      for (const element of runtime.selectWithin(root, selector)) targets.push(remember(element));
    }
    return [...new Set(targets)];
  }

  function updateRules(rules) {
    restoreProtectedElements();
    selectors = validSelectors(rules);
    for (const element of selectTargets(document)) runtime.protect(element);
  }

  async function reload() {
    const stored = await chrome.storage.local.get(storageKey);
    const site = stored[storageKey]?.sites?.[origin];
    updateRules(site?.enabled ? site.rules : []);
  }

  const state = Object.freeze({ reload, updateRules });
  Object.defineProperty(globalThis, stateSymbol, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: state
  });

  runtime.registerAdapter({
    id: `site-rules:${origin}`,
    matches: (url) => url.origin === origin,
    protection: { select: selectTargets }
  });
  runtime.start();

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "site-guard:rules-updated" && message.origin === origin) {
      updateRules(message.rules);
    }
  });

  void reload();
})();
