"use strict";

const STORAGE_KEY = "siteGuardConfig";
const SCHEMA_VERSION = 1;
const SCRIPT_PREFIX = "site-guard-";
const CONTENT_SCRIPT_FILE = "Site-Translate-Guard.content.js";
const MAX_RULES_PER_SITE = 50;
const MAX_SELECTOR_LENGTH = 512;
const MAX_SAME_ORIGIN_FRAMES = 64;
const FRAME_RESPONSE_WINDOW_MS = 150;
const PICKER_FILES = [
  "src/composed-tree.js",
  "src/risk-detector.js",
  "src/selector-tools.js",
  "src/picker.js"
];
const RULE_HEALTH_STATES = new Set([
  "healthy", "recovering", "missing", "ambiguous", "weak", "invalid"
]);
const RULE_HEALTH_PRIORITY = new Map([
  ["missing", 1],
  ["invalid", 2],
  ["weak", 3],
  ["recovering", 5],
  ["healthy", 6],
  ["ambiguous", 7]
]);
let mutationQueue = Promise.resolve();
const pendingFrameRequests = new Map();

function enqueueMutation(operation) {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.catch(() => undefined);
  return result;
}

function emptyConfig() {
  return { schemaVersion: SCHEMA_VERSION, sites: {} };
}

function canonicalOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS sites can be protected");
  }
  return url.origin;
}

function originPattern(origin) {
  const url = new URL(canonicalOrigin(origin));
  return `${url.protocol}//${url.hostname}/*`;
}

async function loadConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const candidate = stored[STORAGE_KEY];
  if (!candidate || typeof candidate !== "object" || typeof candidate.sites !== "object") {
    return emptyConfig();
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    sites: { ...candidate.sites }
  };
}

async function saveConfig(config) {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      schemaVersion: SCHEMA_VERSION,
      sites: config.sites
    }
  });
}

function getOrCreateSite(config, origin) {
  const current = config.sites[origin];
  if (current && typeof current === "object") {
    current.rules = Array.isArray(current.rules) ? current.rules : [];
    current.scriptId ||= `${SCRIPT_PREFIX}${crypto.randomUUID()}`;
    return current;
  }

  const site = {
    enabled: false,
    scriptId: `${SCRIPT_PREFIX}${crypto.randomUUID()}`,
    rules: []
  };
  config.sites[origin] = site;
  return site;
}

function sanitizeFingerprint(fingerprint) {
  if (!fingerprint || typeof fingerprint !== "object") return {};
  const sanitized = {};
  for (const key of ["tag", "role", "type", "name", "landmark"]) {
    const value = fingerprint[key];
    if (typeof value === "string" && value.length <= 120) sanitized[key] = value;
  }
  return sanitized;
}

function preservesFingerprintIdentity(previous, next) {
  if (!previous.tag) return false;
  return ["tag", "role", "type", "name", "landmark"].every((key) => (
    !previous[key] || previous[key] === next[key]
  ));
}

function normalizedFrameScope(value) {
  return value === "child" ? "child" : "top";
}

function frameScopeForSender(sender) {
  return Number.isInteger(sender?.frameId) && sender.frameId !== 0 ? "child" : "top";
}

function sanitizeRule(rule, frameScope = "top") {
  const selector = typeof rule?.selector === "string" ? rule.selector.trim() : "";
  if (!selector || selector.length > MAX_SELECTOR_LENGTH) {
    throw new Error("The component selector is missing or too long");
  }
  return {
    id: typeof rule.id === "string" && rule.id && rule.id.length <= 128
      ? rule.id
      : crypto.randomUUID(),
    selector,
    frameScope: normalizedFrameScope(frameScope),
    fingerprint: sanitizeFingerprint(rule.fingerprint),
    createdAt: new Date().toISOString()
  };
}

function assertSenderOrigin(normalizedOrigin, sender) {
  if (!sender?.url || canonicalOrigin(sender.url) !== normalizedOrigin) {
    throw new Error("The selected component does not belong to the requested site");
  }
}

async function assertTabOrigin(normalizedOrigin, tabId) {
  if (!Number.isInteger(tabId)) throw new Error("The current tab is unavailable");
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || canonicalOrigin(tab.url) !== normalizedOrigin) {
    throw new Error("The current tab does not belong to the requested site");
  }
}

async function hasOriginPermission(origin) {
  return chrome.permissions.contains({ origins: [originPattern(origin)] });
}

async function registerSiteScript(origin, site) {
  const registration = {
    id: site.scriptId,
    matches: [originPattern(origin)],
    js: [CONTENT_SCRIPT_FILE],
    allFrames: true,
    runAt: "document_start",
    persistAcrossSessions: true
  };
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [site.scriptId] });
  if (existing.length) await chrome.scripting.updateContentScripts([registration]);
  else await chrome.scripting.registerContentScripts([registration]);
}

async function unregisterSiteScript(scriptId) {
  if (!scriptId) return;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
}

function sendTabMessage(tabId, message, options = {}) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, options, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

async function notifyRulesUpdated(tabId, origin, rules, enabled = true) {
  const tabIds = new Set(Number.isInteger(tabId) ? [tabId] : []);
  try {
    const tabs = await chrome.tabs.query({ url: [originPattern(origin)] });
    for (const tab of tabs) {
      if (Number.isInteger(tab?.id)) tabIds.add(tab.id);
    }
  } catch {
    // The initiating tab can still be updated when tab enumeration is unavailable.
  }
  await Promise.allSettled([...tabIds].map((id) => sendTabMessage(id, {
    type: "site-guard:rules-updated",
    origin,
    enabled,
    rules
  })));
}

function collectFrameResponses(origin, tabId, kind, details = {}) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const responses = new Map();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pendingFrameRequests.delete(requestId);
      resolve([...responses.values()].sort((left, right) => left.frameId - right.frameId));
    };
    const timer = setTimeout(finish, FRAME_RESPONSE_WINDOW_MS);
    pendingFrameRequests.set(requestId, {
      finish,
      frameScope: details.frameScope || "",
      kind,
      origin,
      responses,
      tabId
    });
    void sendTabMessage(tabId, {
      type: kind === "health"
        ? "site-guard:collect-frame-health"
        : "site-guard:prepare-frame-picker",
      origin,
      requestId,
      frameScope: details.frameScope || "",
      ruleId: details.ruleId || ""
    }).catch(() => undefined);
  });
}

function acceptFrameResponse(message, sender) {
  const requestId = typeof message?.requestId === "string" ? message.requestId : "";
  const pending = pendingFrameRequests.get(requestId);
  if (!pending || message.kind !== pending.kind || message.origin !== pending.origin) {
    return { accepted: false };
  }
  if (
    sender?.tab?.id !== pending.tabId ||
    !Number.isInteger(sender.frameId) ||
    sender.frameId < 0
  ) {
    return { accepted: false };
  }
  try {
    if (canonicalOrigin(sender.url) !== pending.origin) return { accepted: false };
  } catch {
    return { accepted: false };
  }
  const senderScope = sender.frameId === 0 ? "top" : "child";
  if (pending.frameScope && senderScope !== pending.frameScope) {
    return { accepted: false };
  }
  if (!pending.responses.has(sender.frameId) && pending.responses.size < MAX_SAME_ORIGIN_FRAMES) {
    pending.responses.set(sender.frameId, {
      frameId: sender.frameId,
      frameScope: senderScope,
      snapshot: message.snapshot
    });
  }
  if (pending.responses.size >= MAX_SAME_ORIGIN_FRAMES) pending.finish();
  return { accepted: true };
}

async function readRuntimeRuleHealth(origin, tabId) {
  const unavailable = () => ({
    states: new Map(),
    observedRiskCount: 0,
    sameOriginFrameCount: 0
  });
  if (!Number.isInteger(tabId)) return unavailable();
  try {
    await assertTabOrigin(origin, tabId);
    const responses = await collectFrameResponses(origin, tabId, "health");
    const states = new Map();
    let observedRiskCount = 0;
    let sameOriginFrameCount = 0;
    for (const response of responses) {
      const snapshot = response.snapshot;
      if (snapshot?.origin !== origin || !Array.isArray(snapshot.rules)) continue;
      sameOriginFrameCount += 1;
      if (Number.isInteger(snapshot.observedRiskCount)) {
        observedRiskCount = Math.min(24, observedRiskCount + Math.max(0, snapshot.observedRiskCount));
      }
      for (const entry of snapshot.rules.slice(0, MAX_RULES_PER_SITE)) {
        const id = typeof entry?.id === "string" ? entry.id : "";
        if (!id || id.length > 128 || !RULE_HEALTH_STATES.has(entry.state)) continue;
        const previous = states.get(id);
        if (!previous || RULE_HEALTH_PRIORITY.get(entry.state) > RULE_HEALTH_PRIORITY.get(previous)) {
          states.set(id, entry.state);
        }
      }
    }
    return { states, observedRiskCount, sameOriginFrameCount };
  } catch {
    return unavailable();
  }
}

async function siteStatus(origin, tabId) {
  const normalizedOrigin = canonicalOrigin(origin);
  const config = await loadConfig();
  const site = config.sites[normalizedOrigin];
  const permissionGranted = await hasOriginPermission(normalizedOrigin);
  const storedRules = Array.isArray(site?.rules) ? site.rules : [];
  const runtimeHealth = site?.enabled && permissionGranted
    ? await readRuntimeRuleHealth(normalizedOrigin, tabId)
    : { states: new Map(), observedRiskCount: 0, sameOriginFrameCount: 0 };
  return {
    origin: normalizedOrigin,
    builtIn: normalizedOrigin === "https://github.com",
    permissionGranted,
    enabled: Boolean(site?.enabled && permissionGranted),
    ruleCount: storedRules.length,
    observedRiskCount: runtimeHealth.observedRiskCount,
    sameOriginFrameCount: runtimeHealth.sameOriginFrameCount,
    rules: storedRules.map((rule) => ({
      id: rule.id,
      selector: rule.selector,
      frameScope: normalizedFrameScope(rule.frameScope),
      state: runtimeHealth.states.get(rule.id) || "unavailable"
    }))
  };
}

async function enableSite(origin) {
  const normalizedOrigin = canonicalOrigin(origin);
  if (!await hasOriginPermission(normalizedOrigin)) {
    throw new Error("Site access must be granted before protection is enabled");
  }

  const config = await loadConfig();
  const site = getOrCreateSite(config, normalizedOrigin);
  site.enabled = true;
  await saveConfig(config);
  try {
    await registerSiteScript(normalizedOrigin, site);
  } catch (error) {
    site.enabled = false;
    await saveConfig(config);
    throw error;
  }
  return siteStatus(normalizedOrigin);
}

async function disableSite(origin, tabId) {
  const normalizedOrigin = canonicalOrigin(origin);
  const config = await loadConfig();
  const site = getOrCreateSite(config, normalizedOrigin);
  site.enabled = false;
  await saveConfig(config);
  await unregisterSiteScript(site.scriptId);
  await notifyRulesUpdated(tabId, normalizedOrigin, [], false);
  return siteStatus(normalizedOrigin);
}

async function clearRules(origin, tabId) {
  const normalizedOrigin = canonicalOrigin(origin);
  const config = await loadConfig();
  const site = getOrCreateSite(config, normalizedOrigin);
  site.rules = [];
  await saveConfig(config);
  await notifyRulesUpdated(tabId, normalizedOrigin, []);
  return siteStatus(normalizedOrigin);
}

async function addRule(origin, rule, sender) {
  const normalizedOrigin = canonicalOrigin(origin);
  assertSenderOrigin(normalizedOrigin, sender);
  if (!await hasOriginPermission(normalizedOrigin)) {
    throw new Error("Site access is no longer granted");
  }

  const config = await loadConfig();
  const site = getOrCreateSite(config, normalizedOrigin);
  if (!site.enabled) throw new Error("Protection is not enabled for this site");

  const frameScope = frameScopeForSender(sender);
  const sanitized = sanitizeRule({ ...rule, id: "" }, frameScope);
  const duplicate = site.rules.find((candidate) => (
    candidate.selector === sanitized.selector &&
    normalizedFrameScope(candidate.frameScope) === frameScope
  ));
  if (!duplicate) {
    if (site.rules.length >= MAX_RULES_PER_SITE) {
      throw new Error("This site already has the maximum number of component rules");
    }
    site.rules.push(sanitized);
    await saveConfig(config);
  }
  await notifyRulesUpdated(sender?.tab?.id, normalizedOrigin, site.rules);
  return siteStatus(normalizedOrigin);
}

async function rebindRule(origin, rule, sender) {
  const normalizedOrigin = canonicalOrigin(origin);
  assertSenderOrigin(normalizedOrigin, sender);
  if (!await hasOriginPermission(normalizedOrigin)) {
    throw new Error("Site access is no longer granted");
  }

  const id = typeof rule?.id === "string" ? rule.id.trim() : "";
  const selector = typeof rule?.selector === "string" ? rule.selector.trim() : "";
  if (!id || id.length > 128) throw new Error("The component rule id is invalid");
  if (!selector || selector.length > MAX_SELECTOR_LENGTH) {
    throw new Error("The component selector is missing or too long");
  }

  const config = await loadConfig();
  const site = getOrCreateSite(config, normalizedOrigin);
  if (!site.enabled) throw new Error("Protection is not enabled for this site");
  const storedRule = site.rules.find((candidate) => candidate?.id === id);
  if (!storedRule) throw new Error("The component rule no longer exists");
  const storedFrameScope = normalizedFrameScope(storedRule.frameScope);
  if (storedFrameScope !== "top" || frameScopeForSender(sender) !== "top") {
    throw new Error("Automatic selector repair is limited to top-document rules");
  }
  if (site.rules.some((candidate) => (
    candidate !== storedRule && candidate?.selector === selector &&
    normalizedFrameScope(candidate?.frameScope) === storedFrameScope
  ))) {
    throw new Error("Another component rule already uses this selector");
  }

  const previousFingerprint = sanitizeFingerprint(storedRule.fingerprint);
  const nextFingerprint = sanitizeFingerprint(rule.fingerprint);
  if (!preservesFingerprintIdentity(previousFingerprint, nextFingerprint)) {
    throw new Error("The rebound component fingerprint does not match the stored rule");
  }

  storedRule.selector = selector;
  storedRule.fingerprint = nextFingerprint;
  storedRule.reboundAt = new Date().toISOString();
  await saveConfig(config);
  await notifyRulesUpdated(sender?.tab?.id, normalizedOrigin, site.rules);
  return {
    id: storedRule.id,
    selector: storedRule.selector,
    fingerprint: storedRule.fingerprint,
    reboundAt: storedRule.reboundAt
  };
}

async function replaceRule(origin, rule, sender) {
  const normalizedOrigin = canonicalOrigin(origin);
  assertSenderOrigin(normalizedOrigin, sender);
  if (!await hasOriginPermission(normalizedOrigin)) {
    throw new Error("Site access is no longer granted");
  }

  const id = typeof rule?.id === "string" ? rule.id.trim() : "";
  if (!id || id.length > 128) throw new Error("The component rule id is invalid");
  const config = await loadConfig();
  const site = getOrCreateSite(config, normalizedOrigin);
  if (!site.enabled) throw new Error("Protection is not enabled for this site");
  const storedRule = site.rules.find((candidate) => candidate?.id === id);
  if (!storedRule) throw new Error("The component rule no longer exists");
  const storedFrameScope = normalizedFrameScope(storedRule.frameScope);
  if (frameScopeForSender(sender) !== storedFrameScope) {
    throw new Error("The replacement component does not belong to the rule's frame scope");
  }
  const replacement = sanitizeRule({ ...rule, id: "" }, storedFrameScope);
  if (!replacement.fingerprint.tag) {
    throw new Error("The replacement component fingerprint is invalid");
  }
  if (site.rules.some((candidate) => (
    candidate !== storedRule && candidate?.selector === replacement.selector &&
    normalizedFrameScope(candidate?.frameScope) === storedFrameScope
  ))) {
    throw new Error("Another component rule already uses this selector");
  }

  storedRule.selector = replacement.selector;
  storedRule.fingerprint = replacement.fingerprint;
  storedRule.repairedAt = new Date().toISOString();
  await saveConfig(config);
  await notifyRulesUpdated(sender?.tab?.id, normalizedOrigin, site.rules);
  return {
    id: storedRule.id,
    selector: storedRule.selector,
    fingerprint: storedRule.fingerprint,
    repairedAt: storedRule.repairedAt
  };
}

async function removeRule(origin, ruleId, tabId) {
  const normalizedOrigin = canonicalOrigin(origin);
  await assertTabOrigin(normalizedOrigin, tabId);
  const id = typeof ruleId === "string" ? ruleId.trim() : "";
  if (!id || id.length > 128) throw new Error("The component rule id is invalid");

  const config = await loadConfig();
  const site = getOrCreateSite(config, normalizedOrigin);
  if (!site.rules.some((rule) => rule?.id === id)) {
    throw new Error("The component rule no longer exists");
  }
  site.rules = site.rules.filter((rule) => rule?.id !== id);
  await saveConfig(config);
  await notifyRulesUpdated(tabId, normalizedOrigin, site.rules);
  return siteStatus(normalizedOrigin, tabId);
}

async function openPicker(origin, tabId, ruleId) {
  const normalizedOrigin = canonicalOrigin(origin);
  await assertTabOrigin(normalizedOrigin, tabId);
  if (!await hasOriginPermission(normalizedOrigin)) {
    throw new Error("Site access is no longer granted");
  }

  const config = await loadConfig();
  const site = getOrCreateSite(config, normalizedOrigin);
  if (!site.enabled) throw new Error("Protection is not enabled for this site");

  const id = typeof ruleId === "string" ? ruleId.trim() : "";
  if (id.length > 128) throw new Error("The component rule id is invalid");
  const storedRule = id ? site.rules.find((candidate) => candidate?.id === id) : null;
  if (id && !storedRule) throw new Error("The component rule no longer exists");
  const frameScope = storedRule ? normalizedFrameScope(storedRule.frameScope) : "";
  const frames = await collectFrameResponses(normalizedOrigin, tabId, "picker", {
    frameScope,
    ruleId: id
  });
  if (!frames.length) {
    throw new Error("Reload the page before selecting a component in this frame");
  }

  const injections = await Promise.allSettled(frames.map(({ frameId }) => (
    chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: PICKER_FILES
    })
  )));
  const frameCount = injections.filter((result) => result.status === "fulfilled").length;
  if (!frameCount) throw new Error("The component picker could not be opened");
  return { origin: normalizedOrigin, frameCount, frameScope: frameScope || "any" };
}

async function cancelPicker(origin, sender) {
  const normalizedOrigin = canonicalOrigin(origin);
  assertSenderOrigin(normalizedOrigin, sender);
  if (!Number.isInteger(sender?.tab?.id)) throw new Error("The current tab is unavailable");
  try {
    await sendTabMessage(sender.tab.id, {
      type: "site-guard:cancel-picker",
      origin: normalizedOrigin
    });
  } catch {
    // The initiating frame may already have closed; cancellation remains best effort.
  }
  return { origin: normalizedOrigin };
}

async function reconcileRegistrations() {
  const config = await loadConfig();
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const managed = registered.filter((script) => script.id.startsWith(SCRIPT_PREFIX));
  const desiredIds = new Set();
  let changed = false;

  for (const [rawOrigin, rawSite] of Object.entries(config.sites)) {
    let origin;
    try {
      origin = canonicalOrigin(rawOrigin);
    } catch {
      continue;
    }
    const site = getOrCreateSite(config, origin);
    if (!site.enabled) continue;
    if (!await hasOriginPermission(origin)) {
      site.enabled = false;
      changed = true;
      continue;
    }
    desiredIds.add(site.scriptId);
    await registerSiteScript(origin, site);
  }

  const staleIds = managed
    .map((script) => script.id)
    .filter((id) => !desiredIds.has(id));
  if (staleIds.length) await chrome.scripting.unregisterContentScripts({ ids: staleIds });
  if (changed) await saveConfig(config);
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "site-guard:get-status":
      return siteStatus(message.origin, message.tabId);
    case "site-guard:enable":
      return enqueueMutation(() => enableSite(message.origin));
    case "site-guard:disable":
      return enqueueMutation(() => disableSite(message.origin, message.tabId));
    case "site-guard:clear-rules":
      return enqueueMutation(() => clearRules(message.origin, message.tabId));
    case "site-guard:add-rule":
      return enqueueMutation(() => addRule(message.origin, message.rule, sender));
    case "site-guard:rebind-rule":
      return enqueueMutation(() => rebindRule(message.origin, message.rule, sender));
    case "site-guard:replace-rule":
      return enqueueMutation(() => replaceRule(message.origin, message.rule, sender));
    case "site-guard:remove-rule":
      return enqueueMutation(() => removeRule(message.origin, message.ruleId, message.tabId));
    case "site-guard:open-picker":
      return openPicker(message.origin, message.tabId, message.ruleId);
    case "site-guard:cancel-picker":
      return cancelPicker(message.origin, sender);
    case "site-guard:frame-response":
      return acceptFrameResponse(message, sender);
    default:
      throw new Error("Unknown site guard message");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => void enqueueMutation(reconcileRegistrations));
chrome.runtime.onStartup.addListener(() => void enqueueMutation(reconcileRegistrations));
chrome.permissions.onRemoved.addListener(() => void enqueueMutation(reconcileRegistrations));
