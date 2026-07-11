(() => {
  "use strict";

  const observerSymbol = Symbol.for("search-translate-guard.mutation-risk-observer");
  if (globalThis[observerSymbol]) return;

  const composedTree = globalThis[Symbol.for("search-translate-guard.composed-tree")];
  const detector = globalThis[Symbol.for("search-translate-guard.risk-detector")];
  if (
    !composedTree?.disconnect || !composedTree?.observe ||
    !detector?.boundaryFor || !detector?.isVisible || !detector?.score
  ) {
    throw new Error("Composed tree support and risk detection must load before mutation observation");
  }

  const maxCandidates = 24;
  const candidateTtlMs = 15 * 60 * 1_000;
  const observations = new Map();
  const observerOptions = { childList: true, subtree: true };
  let enabled = false;

  function containsTextNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return true;
    if (!(node instanceof Element)) return false;
    const walker = document.createTreeWalker(
      node,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
    );
    for (let visited = 0; visited < 200 && walker.nextNode(); visited += 1) {
      if (walker.currentNode.nodeType === Node.TEXT_NODE) return true;
    }
    return false;
  }

  function someNode(nodes, predicate) {
    const limit = Math.min(nodes.length, 100);
    for (let index = 0; index < limit; index += 1) {
      if (predicate(nodes[index])) return true;
    }
    return false;
  }

  function rewriteEvidence(record) {
    return {
      removedText: someNode(
        record.removedNodes,
        (node) => node.nodeType === Node.TEXT_NODE
      ),
      addedWrapper: someNode(record.addedNodes, (node) => (
        node instanceof Element && containsTextNode(node)
      ))
    };
  }

  function isInteractiveBoundary(element) {
    return element.localName.includes("-") || element.matches([
      "button", "input", "textarea", "select", "dialog", "[contenteditable]",
      "[role=combobox]", "[role=listbox]", "[role=dialog]", "[role=menu]",
      "[role=tree]", "[role=grid]", "[role=tablist]", "[role=textbox]", "[popover]"
    ].join(","));
  }

  function prune(now = Date.now()) {
    for (const [element, observation] of observations) {
      if (!element.isConnected || now - observation.observedAt > candidateTtlMs) {
        observations.delete(element);
      }
    }
  }

  function remember(element) {
    if (
      !(element instanceof Element) ||
      !isInteractiveBoundary(element) ||
      !detector.isVisible(element)
    ) return;
    if (element.closest('[translate="no"], .notranslate')) return;

    const structural = detector.score(element);
    const previous = observations.get(element);
    const observation = {
      element,
      score: Math.min(20, Math.max(8, structural.score + 6) + Math.min(previous?.occurrences || 0, 3)),
      reasons: [...new Set(["observed-text-rewrite", ...structural.reasons])],
      observedAt: Date.now(),
      occurrences: Math.min((previous?.occurrences || 0) + 1, 4)
    };
    observations.set(element, observation);
    prune(observation.observedAt);

    if (observations.size > maxCandidates) {
      const oldest = [...observations.values()]
        .sort((left, right) => left.observedAt - right.observedAt)[0];
      if (oldest) observations.delete(oldest.element);
    }
  }

  function process(records) {
    if (document.visibilityState === "hidden") return;
    const byTarget = new Map();
    for (const record of records.slice(0, 200)) {
      if (record.type !== "childList") continue;
      for (const node of [...record.addedNodes].slice(0, 100)) {
        composedTree.observe(observer, node, observerOptions, 1_000);
      }
      const evidence = rewriteEvidence(record);
      if (!evidence.removedText && !evidence.addedWrapper) continue;
      const previous = byTarget.get(record.target) || {
        removedText: false,
        addedWrapper: false
      };
      previous.removedText ||= evidence.removedText;
      previous.addedWrapper ||= evidence.addedWrapper;
      byTarget.set(record.target, previous);
    }
    for (const [mutationTarget, evidence] of byTarget) {
      if (!evidence.removedText || !evidence.addedWrapper) continue;
      const target = mutationTarget instanceof Element
        ? mutationTarget
        : mutationTarget instanceof ShadowRoot
          ? mutationTarget.host
          : mutationTarget.parentElement;
      const boundary = detector.boundaryFor(target);
      if (boundary) remember(boundary);
    }
  }

  function candidates() {
    if (!enabled) return [];
    composedTree.refresh(document);
    prune();
    return [...observations.values()]
      .sort((left, right) => right.score - left.score || right.observedAt - left.observedAt)
      .map(({ element, score, reasons, observedAt, occurrences }) => ({
        element,
        score,
        reasons: [...reasons],
        observedAt,
        occurrences
      }));
  }

  const observer = new MutationObserver(process);

  function setEnabled(value) {
    const next = Boolean(value);
    if (enabled === next) return;
    enabled = next;
    if (enabled) {
      composedTree.observe(observer, document, observerOptions);
    } else {
      composedTree.disconnect(observer);
      observations.clear();
    }
  }

  Object.defineProperty(globalThis, observerSymbol, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      candidates,
      count: () => candidates().length,
      setEnabled
    })
  });
})();
