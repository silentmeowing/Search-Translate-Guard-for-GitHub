(() => {
  "use strict";

  const runtime = globalThis[Symbol.for("search-translate-guard.runtime")];
  const selectorTools = globalThis[Symbol.for("search-translate-guard.selector-tools")];
  if (!runtime || !selectorTools) {
    throw new Error("Search Translate Guard core and selector tools must load before site rules");
  }

  const storageKey = "siteGuardConfig";
  const origin = location.origin;
  const stateSymbol = Symbol.for(`search-translate-guard.site-rules:${origin}`);
  const existingState = globalThis[stateSymbol];
  if (existingState) {
    void existingState.reload();
    return;
  }

  let previousState = new WeakMap();
  let rules = [];
  let reconcileTimer = null;
  let waitsForDomReady = false;
  const rebindCandidates = new Map();
  const rebindNotifications = new Map();
  const rebindStabilityMs = 250;

  function normalizedRules(value) {
    const accepted = [];
    const ids = new Set();
    for (const rawRule of Array.isArray(value) ? value : []) {
      const selector = typeof rawRule?.selector === "string" ? rawRule.selector.trim() : "";
      if (!selector || selector.length > 512) continue;
      try {
        document.querySelector(selector);
      } catch {
        continue;
      }
      const id = typeof rawRule.id === "string" && rawRule.id
        ? rawRule.id
        : `legacy:${selector}`;
      if (ids.has(id)) continue;
      ids.add(id);
      accepted.push({
        id,
        selector,
        fingerprint: selectorTools.normalizedFingerprint(rawRule.fingerprint)
      });
    }
    return accepted;
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

  function queryRule(rule) {
    try {
      return [...document.querySelectorAll(rule.selector)];
    } catch {
      return [];
    }
  }

  function matchingRuleElements(rule) {
    const elements = queryRule(rule);
    if (!selectorTools.isRebindableFingerprint(rule.fingerprint)) return elements;
    return elements.filter((element) => selectorTools.matchesFingerprint(element, rule.fingerprint));
  }

  function stableSelectorForRebind(rule, element) {
    const selector = selectorTools.selectorFor(element);
    if (!selector || selector.length > 512 || selector === rule.selector) return "";
    const now = Date.now();
    const pending = rebindCandidates.get(rule.id);
    if (!pending || pending.selector !== selector || pending.element !== element) {
      rebindCandidates.set(rule.id, { element, selector, firstSeenAt: now });
      scheduleReconcile(rebindStabilityMs);
      return "";
    }
    const elapsed = now - pending.firstSeenAt;
    if (elapsed < rebindStabilityMs) {
      scheduleReconcile(rebindStabilityMs - elapsed);
      return "";
    }
    rebindCandidates.delete(rule.id);
    return selector;
  }

  function sendRebind(rule, element, selector) {
    if (!selector || rebindNotifications.get(rule.id) === selector) return;
    rebindNotifications.set(rule.id, selector);

    try {
      chrome.runtime.sendMessage({
        type: "site-guard:rebind-rule",
        origin,
        rule: {
          id: rule.id,
          selector,
          fingerprint: selectorTools.fingerprintFor(element)
        }
      }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) return;
        rule.selector = selector;
        rule.fingerprint = selectorTools.normalizedFingerprint(
          response.result?.fingerprint || rule.fingerprint
        );
      });
    } catch {
      // Extension shutdown or a disconnected service worker must not affect the page.
    }
  }

  function reconcileRules() {
    reconcileTimer = null;
    if (document.readyState === "loading") {
      scheduleReconcile();
      return;
    }

    for (const rule of rules) {
      if (!selectorTools.isRebindableFingerprint(rule.fingerprint)) continue;
      const directMatches = matchingRuleElements(rule);
      if (directMatches.length === 1) {
        const element = directMatches[0];
        runtime.protect(remember(element));
        if (queryRule(rule).length !== 1) {
          const selector = stableSelectorForRebind(rule, element);
          if (selector) sendRebind(rule, element, selector);
        }
        continue;
      }
      if (directMatches.length > 1) {
        rebindCandidates.delete(rule.id);
        continue;
      }

      const rebound = selectorTools.uniqueFingerprintMatch(document, rule.fingerprint);
      if (!rebound) {
        rebindCandidates.delete(rule.id);
        continue;
      }
      const selector = stableSelectorForRebind(rule, rebound);
      if (!selector) continue;
      runtime.protect(remember(rebound));
      sendRebind(rule, rebound, selector);
    }
  }

  function scheduleReconcile(delayMs = 50) {
    if (document.readyState === "loading") {
      if (waitsForDomReady) return;
      waitsForDomReady = true;
      document.addEventListener("DOMContentLoaded", () => {
        waitsForDomReady = false;
        scheduleReconcile();
      }, { once: true });
      return;
    }
    if (reconcileTimer !== null) return;
    reconcileTimer = setTimeout(reconcileRules, Math.max(0, delayMs));
  }

  function selectTargets(root) {
    if (root instanceof Element && rebindCandidates.size) {
      rebindCandidates.clear();
    }
    const targets = [];
    for (const rule of rules) {
      const rebindable = selectorTools.isRebindableFingerprint(rule.fingerprint);
      const localMatches = runtime.selectWithin(root, rule.selector);
      if (!rebindable) {
        for (const element of localMatches) targets.push(remember(element));
        continue;
      }

      if (localMatches.length) {
        const globalMatches = matchingRuleElements(rule);
        if (globalMatches.length === 1) targets.push(remember(globalMatches[0]));
      }
    }
    if (rules.some((rule) => selectorTools.isRebindableFingerprint(rule.fingerprint))) {
      scheduleReconcile();
    }
    return [...new Set(targets)];
  }

  function updateRules(value) {
    if (reconcileTimer !== null) {
      clearTimeout(reconcileTimer);
      reconcileTimer = null;
    }
    restoreProtectedElements();
    rules = normalizedRules(value);
    rebindCandidates.clear();
    rebindNotifications.clear();
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

  new MutationObserver((records) => {
    if (!rules.some((rule) => selectorTools.isRebindableFingerprint(rule.fingerprint))) return;
    if (records.some((record) => (
      record.type === "attributes" || record.removedNodes.length > 0
    ))) {
      scheduleReconcile();
    }
  }).observe(document, {
    attributes: true,
    attributeFilter: [
      "id", "class", "role", "type", "name",
      "data-testid", "data-test", "data-target", "data-component"
    ],
    childList: true,
    subtree: true
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "site-guard:rules-updated" && message.origin === origin) {
      updateRules(message.rules);
    }
  });

  void reload();
})();
