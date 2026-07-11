(() => {
  "use strict";

  const treeSymbol = Symbol.for("search-translate-guard.composed-tree");
  if (globalThis[treeSymbol]) return;

  const deepSeparator = " >>> ";
  const maxShadowDepth = 8;
  const maxQueryResults = 5_000;
  const observedRoots = new WeakMap();
  const observerRegistrations = new Map();

  function isQueryableRoot(value) {
    return value instanceof Document ||
      value instanceof DocumentFragment ||
      value instanceof Element;
  }

  function parentElement(element) {
    if (!(element instanceof Element)) return null;
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }

  function closest(element, selector, limit = 32) {
    let current = element instanceof Element ? element : null;
    for (let depth = 0; current && depth < limit; depth += 1) {
      if (current.matches(selector)) return current;
      current = parentElement(current);
    }
    return null;
  }

  function startingElements(root) {
    if (root instanceof Element) return [root];
    if (root instanceof Document) return root.documentElement ? [root.documentElement] : [];
    return [...root.children];
  }

  function pushChildren(stack, element) {
    const lightChildren = [...element.children];
    for (let index = lightChildren.length - 1; index >= 0; index -= 1) {
      stack.push(lightChildren[index]);
    }
    const shadowChildren = element.shadowRoot ? [...element.shadowRoot.children] : [];
    for (let index = shadowChildren.length - 1; index >= 0; index -= 1) {
      stack.push(shadowChildren[index]);
    }
  }

  function scopes(root = document, maxElements = 5_000) {
    if (!isQueryableRoot(root)) return [];
    const acceptedLimit = Math.max(1, Math.min(Number(maxElements) || 5_000, 10_000));
    const result = [root];
    const seen = new WeakSet([root]);
    const stack = startingElements(root).reverse();
    let visited = 0;

    while (stack.length && visited < acceptedLimit) {
      const element = stack.pop();
      visited += 1;
      const shadowRoot = element.shadowRoot;
      if (shadowRoot instanceof ShadowRoot && !seen.has(shadowRoot)) {
        seen.add(shadowRoot);
        result.push(shadowRoot);
      }
      pushChildren(stack, element);
    }
    return result;
  }

  function elements(root = document, limit = 5_000) {
    const acceptedLimit = Math.max(1, Math.min(Number(limit) || 5_000, 10_000));
    const result = [];
    if (!isQueryableRoot(root)) return result;
    const stack = startingElements(root).reverse();
    while (stack.length && result.length < acceptedLimit) {
      const element = stack.pop();
      result.push(element);
      pushChildren(stack, element);
    }
    return result;
  }

  function selectorSegments(selector) {
    if (typeof selector !== "string") throw new TypeError("Selector must be a string");
    const segments = [];
    let start = 0;
    let quote = "";
    let escaped = false;
    let bracketDepth = 0;
    let parenthesisDepth = 0;
    for (let index = 0; index < selector.length; index += 1) {
      const character = selector[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "[") bracketDepth += 1;
      else if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      else if (character === "(") parenthesisDepth += 1;
      else if (character === ")") parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      else if (
        character === ">" && selector.slice(index, index + 3) === ">>>" &&
        bracketDepth === 0 && parenthesisDepth === 0
      ) {
        segments.push(selector.slice(start, index).trim());
        start = index + 3;
        index += 2;
      }
    }
    segments.push(selector.slice(start).trim());
    if (!segments.length || segments.length > maxShadowDepth || segments.some((segment) => !segment)) {
      throw new SyntaxError("Invalid open shadow selector path");
    }
    const probe = document.createDocumentFragment();
    for (const segment of segments) probe.querySelector(segment);
    return segments;
  }

  function matchesWithin(root, selector) {
    const matches = [];
    if (root instanceof Element && root.matches(selector)) matches.push(root);
    root.querySelectorAll(selector).forEach((element) => matches.push(element));
    return matches;
  }

  function queryAll(root, selector, limit = Number.POSITIVE_INFINITY) {
    if (!isQueryableRoot(root)) return [];
    const segments = selectorSegments(selector);
    const acceptedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(Number(limit) || 1, maxQueryResults))
      : maxQueryResults;
    let searchRoots = [root];

    for (let index = 0; index < segments.length; index += 1) {
      const matches = [];
      for (const searchRoot of searchRoots) {
        for (const element of matchesWithin(searchRoot, segments[index])) {
          matches.push(element);
          if (index === segments.length - 1 && matches.length >= acceptedLimit) return matches;
          if (matches.length >= maxQueryResults) break;
        }
        if (matches.length >= maxQueryResults) break;
      }
      if (index === segments.length - 1) return matches;
      searchRoots = matches
        .map((element) => element.shadowRoot)
        .filter((shadowRoot) => shadowRoot instanceof ShadowRoot);
      if (!searchRoots.length) return [];
    }
    return [];
  }

  function queryAllOpen(root, selector, limit = Number.POSITIVE_INFINITY) {
    if (!isQueryableRoot(root)) return [];
    const segments = selectorSegments(selector);
    if (segments.length > 1) return queryAll(root, selector, limit);
    const acceptedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(Number(limit) || 1, maxQueryResults))
      : maxQueryResults;
    const matches = [];
    for (const scope of scopes(root)) {
      for (const element of matchesWithin(scope, selector)) {
        matches.push(element);
        if (matches.length >= acceptedLimit) return matches;
      }
    }
    return matches;
  }

  function observe(observer, root, options, maxElements = 5_000) {
    if (!(observer instanceof MutationObserver) || !isQueryableRoot(root)) return;
    const previous = observerRegistrations.get(observer);
    observerRegistrations.set(observer, {
      options,
      maxElements: Math.max(previous?.maxElements || 0, maxElements)
    });
    let seen = observedRoots.get(observer);
    if (!seen) {
      seen = new WeakSet();
      observedRoots.set(observer, seen);
    }
    for (const scope of scopes(root, maxElements)) {
      if (scope instanceof Element || seen.has(scope)) continue;
      observer.observe(scope, options);
      seen.add(scope);
    }
  }

  function refresh(root = document) {
    for (const [observer, registration] of observerRegistrations) {
      observe(observer, root, registration.options, registration.maxElements);
    }
  }

  function disconnect(observer) {
    observer?.disconnect?.();
    if (observer) {
      observedRoots.delete(observer);
      observerRegistrations.delete(observer);
    }
  }

  Object.defineProperty(globalThis, treeSymbol, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      closest,
      deepSeparator,
      disconnect,
      elements,
      observe,
      parentElement,
      queryAll,
      queryAllOpen,
      refresh,
      selectorSegments
    })
  });
})();
