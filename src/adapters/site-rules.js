(() => {
  "use strict";

  const runtime = globalThis[Symbol.for("search-translate-guard.runtime")];
  const composedTree = globalThis[Symbol.for("search-translate-guard.composed-tree")];
  const selectorTools = globalThis[Symbol.for("search-translate-guard.selector-tools")];
  const mutationRisks = globalThis[Symbol.for("search-translate-guard.mutation-risk-observer")];
  if (!runtime || !composedTree?.observe || !composedTree?.refresh || !selectorTools) {
    throw new Error("Search Translate Guard core, composed tree, and selector tools must load before site rules");
  }

  const storageKey = "siteGuardConfig";
  const origin = location.origin;
  const frameScope = globalThis.top === globalThis ? "top" : "child";
  const allowAutomaticRebind = frameScope === "top";
  const pickerRequestSymbol = Symbol.for("search-translate-guard.component-picker-request");
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
  const rebindRetryCounts = new Map();
  const rebindStabilityMs = 250;
  const maxRebindRetries = 3;

  function normalizedRules(value) {
    const accepted = [];
    const ids = new Set();
    for (const rawRule of Array.isArray(value) ? value : []) {
      const selector = typeof rawRule?.selector === "string" ? rawRule.selector.trim() : "";
      if (!selector || selector.length > 512) continue;
      const id = typeof rawRule.id === "string" && rawRule.id
        ? rawRule.id
        : `legacy:${selector}`;
      const ruleFrameScope = rawRule.frameScope === "child" ? "child" : "top";
      if (ruleFrameScope !== frameScope) continue;
      if (ids.has(id)) continue;
      ids.add(id);
      accepted.push({
        id,
        selector,
        frameScope: ruleFrameScope,
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
    selectorTools.querySelectorAllOpen(
      document,
      '[data-search-translate-guard-rule="true"]'
    ).forEach((element) => {
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
      return selectorTools.querySelectorAll(document, rule.selector);
    } catch {
      return [];
    }
  }

  function isSelectorValid(rule) {
    try {
      selectorTools.querySelectorAll(document, rule.selector, 1);
      return true;
    } catch {
      return false;
    }
  }

  function matchingRuleElements(rule) {
    const elements = queryRule(rule);
    if (!selectorTools.isRebindableFingerprint(rule.fingerprint)) return elements;
    return elements.filter((element) => selectorTools.matchesFingerprint(element, rule.fingerprint));
  }

  function stableSelectorForRebind(rule, element) {
    if ((rebindRetryCounts.get(rule.id) || 0) > maxRebindRetries) return "";
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
        if (chrome.runtime.lastError || !response?.ok) {
          handleRebindFailure(rule.id);
          return;
        }
        rule.selector = selector;
        rule.fingerprint = selectorTools.normalizedFingerprint(
          response.result?.fingerprint || rule.fingerprint
        );
        rebindNotifications.delete(rule.id);
        rebindRetryCounts.delete(rule.id);
      });
    } catch {
      // Extension shutdown or a disconnected service worker must not affect the page.
      handleRebindFailure(rule.id);
    }
  }

  function handleRebindFailure(ruleId) {
    rebindNotifications.delete(ruleId);
    const failures = (rebindRetryCounts.get(ruleId) || 0) + 1;
    rebindRetryCounts.set(ruleId, failures);
    if (failures <= maxRebindRetries) {
      scheduleReconcile(1_000 * (2 ** (failures - 1)));
    }
  }

  function ruleHealth(rule) {
    if (!isSelectorValid(rule)) return "invalid";
    const selected = queryRule(rule);
    if (!selectorTools.isRebindableFingerprint(rule.fingerprint)) {
      return selected.length ? "healthy" : "weak";
    }

    const directMatches = selected.filter((element) => (
      selectorTools.matchesFingerprint(element, rule.fingerprint)
    ));
    if (directMatches.length === 1 && selected.length === 1) return "healthy";
    if (directMatches.length > 1) return "ambiguous";

    const candidates = selectorTools.fingerprintMatches(document, rule.fingerprint, 2);
    if (candidates.length > 1) return "ambiguous";
    if (candidates.length === 1 && allowAutomaticRebind) return "recovering";
    return "missing";
  }

  function healthSnapshot() {
    applyCurrentRules();
    const observedRiskCount = Number(mutationRisks?.count?.()) || 0;
    return {
      origin,
      observedRiskCount: Math.max(0, Math.min(observedRiskCount, 24)),
      rules: rules.map((rule) => ({ id: rule.id, state: ruleHealth(rule) }))
    };
  }

  function sendFrameResponse(request, kind, snapshot) {
    const requestId = typeof request?.requestId === "string" ? request.requestId : "";
    if (!requestId || requestId.length > 128) return;
    try {
      const response = {
        type: "site-guard:frame-response",
        origin,
        requestId,
        kind
      };
      if (snapshot !== undefined) response.snapshot = snapshot;
      chrome.runtime.sendMessage(response, () => void chrome.runtime.lastError);
    } catch {
      // Extension shutdown must not affect the protected page.
    }
  }

  function reconcileRules() {
    reconcileTimer = null;
    if (document.readyState === "loading") {
      scheduleReconcile();
      return;
    }
    composedTree.refresh(document);
    if (!allowAutomaticRebind) return;

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
      const fingerprinted = selectorTools.isRebindableFingerprint(rule.fingerprint);
      let localMatches;
      try {
        const queryRoot = selectorTools.isDeepSelector(rule.selector) ? document : root;
        localMatches = selectorTools.querySelectorAll(queryRoot, rule.selector);
      } catch {
        continue;
      }
      if (!fingerprinted) {
        for (const element of localMatches) targets.push(remember(element));
        continue;
      }

      if (localMatches.length) {
        const globalMatches = matchingRuleElements(rule);
        if (globalMatches.length === 1) targets.push(remember(globalMatches[0]));
      }
    }
    if (
      allowAutomaticRebind &&
      rules.some((rule) => selectorTools.isRebindableFingerprint(rule.fingerprint))
    ) {
      scheduleReconcile();
    }
    return [...new Set(targets)];
  }

  function applyCurrentRules() {
    composedTree.refresh(document);
    for (const element of selectTargets(document)) runtime.protect(element);
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
    rebindRetryCounts.clear();
    applyCurrentRules();
  }

  function updateSite(enabled, value) {
    mutationRisks?.setEnabled?.(Boolean(enabled));
    updateRules(enabled ? value : []);
  }

  async function reload() {
    const stored = await chrome.storage.local.get(storageKey);
    const site = stored[storageKey]?.sites?.[origin];
    updateSite(Boolean(site?.enabled), site?.rules);
  }

  const state = Object.freeze({ healthSnapshot, reload, updateRules, updateSite });
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

  const driftObserverOptions = {
    attributes: true,
    attributeFilter: [
      "id", "class", "role", "type", "name",
      "data-testid", "data-test", "data-target", "data-component"
    ],
    childList: true,
    subtree: true
  };
  const driftObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes || []) {
        composedTree.observe(driftObserver, node, driftObserverOptions, 1_000);
      }
    }
    if (
      !allowAutomaticRebind ||
      !rules.some((rule) => selectorTools.isRebindableFingerprint(rule.fingerprint))
    ) return;
    if (records.some((record) => (
      record.type === "attributes" || record.removedNodes.length > 0
    ))) {
      scheduleReconcile();
    }
  });
  composedTree.observe(driftObserver, document, driftObserverOptions);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyCurrentRules, {
      once: true
    });
  } else {
    applyCurrentRules();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "site-guard:rules-updated" && message.origin === origin) {
      updateSite(message.enabled !== false, message.rules);
      return false;
    }
    if (message?.type === "site-guard:get-rule-health" && message.origin === origin) {
      sendResponse(healthSnapshot());
      return false;
    }
    if (message?.type === "site-guard:collect-frame-health" && message.origin === origin) {
      sendFrameResponse(message, "health", healthSnapshot());
      return false;
    }
    if (message?.type === "site-guard:prepare-frame-picker" && message.origin === origin) {
      const requestedScope = message.frameScope === "child" ? "child"
        : message.frameScope === "top" ? "top" : "";
      if (requestedScope && requestedScope !== frameScope) return false;
      const ruleId = typeof message.ruleId === "string" && message.ruleId.length <= 128
        ? message.ruleId
        : "";
      globalThis[pickerRequestSymbol] = ruleId ? { ruleId } : {};
      sendFrameResponse(message, "picker");
      return false;
    }
    return false;
  });

  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName === "local" && changes?.[storageKey]) void reload();
  });

  void reload();
})();
