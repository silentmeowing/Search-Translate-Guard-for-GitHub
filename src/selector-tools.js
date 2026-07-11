(() => {
  "use strict";

  const toolsSymbol = Symbol.for("search-translate-guard.selector-tools");
  if (globalThis[toolsSymbol]) return;

  const fingerprintKeys = ["tag", "role", "type", "name", "landmark"];

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
    if (stableClasses.length) {
      value += stableClasses.map((name) => `.${escapeIdentifier(name)}`).join("");
    }

    const siblings = element.parentElement
      ? [...element.parentElement.children].filter((candidate) => candidate.localName === tag)
      : [];
    if (siblings.length > 1) value += `:nth-of-type(${siblings.indexOf(element) + 1})`;
    return { value, unique: isUnique(value) };
  }

  function selectorFor(element) {
    if (!(element instanceof Element)) return "";
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

  function landmarkFor(element) {
    const landmark = element.closest(
      "header, nav, main, form, [role=dialog], [role=main], [role=navigation]"
    );
    return landmark ? landmark.localName : "";
  }

  function fingerprintFor(element) {
    return {
      tag: element.localName,
      role: element.getAttribute("role") || "",
      type: element.getAttribute("type") || "",
      name: element.getAttribute("name") || "",
      landmark: landmarkFor(element)
    };
  }

  function normalizedFingerprint(value) {
    const fingerprint = {};
    if (!value || typeof value !== "object") return fingerprint;
    for (const key of fingerprintKeys) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate.length <= 120) {
        fingerprint[key] = candidate;
      }
    }
    return fingerprint;
  }

  function isRebindableFingerprint(value) {
    const fingerprint = normalizedFingerprint(value);
    if (!/^[a-z][a-z0-9-]*$/.test(fingerprint.tag || "")) return false;
    let strength = fingerprint.tag.includes("-") ? 2 : 0;
    if (fingerprint.role) strength += 3;
    if (fingerprint.type) strength += 1;
    if (fingerprint.name) strength += 2;
    if (fingerprint.landmark) strength += 1;
    return strength >= 3;
  }

  function matchesFingerprint(element, value) {
    if (!(element instanceof Element)) return false;
    const fingerprint = normalizedFingerprint(value);
    if (fingerprint.tag && element.localName !== fingerprint.tag) return false;
    if (fingerprint.role && element.getAttribute("role") !== fingerprint.role) return false;
    if (fingerprint.type && element.getAttribute("type") !== fingerprint.type) return false;
    if (fingerprint.name && element.getAttribute("name") !== fingerprint.name) return false;
    if (fingerprint.landmark && landmarkFor(element) !== fingerprint.landmark) return false;
    return Boolean(Object.values(fingerprint).some(Boolean));
  }

  function candidateSelector(value) {
    const fingerprint = normalizedFingerprint(value);
    if (!/^[a-z][a-z0-9-]*$/.test(fingerprint.tag || "")) return "";
    let selector = fingerprint.tag;
    for (const name of ["role", "type", "name"]) {
      const attribute = fingerprint[name];
      if (attribute) selector += `[${name}="${escapeAttribute(attribute)}"]`;
    }
    return selector;
  }

  function fingerprintMatches(root, fingerprint, limit = Number.POSITIVE_INFINITY) {
    if (!isRebindableFingerprint(fingerprint)) return [];
    const selector = candidateSelector(fingerprint);
    if (!selector || !root?.querySelectorAll) return [];
    const matches = [];
    for (const element of root.querySelectorAll(selector)) {
      if (!matchesFingerprint(element, fingerprint)) continue;
      matches.push(element);
      if (matches.length >= limit) break;
    }
    return matches;
  }

  function uniqueFingerprintMatch(root, fingerprint) {
    const matches = fingerprintMatches(root, fingerprint, 2);
    return matches.length === 1 ? matches[0] : null;
  }

  Object.defineProperty(globalThis, toolsSymbol, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      fingerprintFor,
      fingerprintMatches,
      isRebindableFingerprint,
      matchesFingerprint,
      normalizedFingerprint,
      selectorFor,
      uniqueFingerprintMatch
    })
  });
})();
