"use strict";

const STORAGE_KEY = "siteGuardConfig";
const SCHEMA_VERSION = 1;
const SCRIPT_PREFIX = "site-guard-";
const CONTENT_SCRIPT_FILE = "Site-Translate-Guard.content.js";
const MAX_RULES_PER_SITE = 50;
const MAX_SELECTOR_LENGTH = 512;
const RULE_HEALTH_STATES = new Set([
  "healthy", "recovering", "missing", "ambiguous", "weak", "invalid"
]);
let mutationQueue = Promise.resolve();

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

function sanitizeRule(rule) {
  const selector = typeof rule?.selector === "string" ? rule.selector.trim() : "";
  if (!selector || selector.length > MAX_SELECTOR_LENGTH) {
    throw new Error("The component selector is missing or too long");
  }
  return {
    id: typeof rule.id === "string" && rule.id && rule.id.length <= 128
      ? rule.id
      : crypto.randomUUID(),
    selector,
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
  await Promise.allSettled([...tabIds].map((id) => chrome.tabs.sendMessage(id, {
    type: "site-guard:rules-updated",
    origin,
    enabled,
    rules
  })));
}

async function readRuntimeRuleHealth(origin, tabId) {
  const unavailable = () => ({ states: new Map(), observedRiskCount: 0 });
  if (!Number.isInteger(tabId)) return unavailable();
  try {
    await assertTabOrigin(origin, tabId);
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "site-guard:get-rule-health",
      origin
    });
    if (response?.origin !== origin || !Array.isArray(response.rules)) return unavailable();
    const states = new Map();
    for (const entry of response.rules.slice(0, MAX_RULES_PER_SITE)) {
      const id = typeof entry?.id === "string" ? entry.id : "";
      if (id && id.length <= 128 && RULE_HEALTH_STATES.has(entry.state)) {
        states.set(id, entry.state);
      }
    }
    const observedRiskCount = Number.isInteger(response.observedRiskCount)
      ? Math.max(0, Math.min(response.observedRiskCount, 24))
      : 0;
    return { states, observedRiskCount };
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
    : { states: new Map(), observedRiskCount: 0 };
  return {
    origin: normalizedOrigin,
    builtIn: normalizedOrigin === "https://github.com",
    permissionGranted,
    enabled: Boolean(site?.enabled && permissionGranted),
    ruleCount: storedRules.length,
    observedRiskCount: runtimeHealth.observedRiskCount,
    rules: storedRules.map((rule) => ({
      id: rule.id,
      selector: rule.selector,
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

  const sanitized = sanitizeRule({ ...rule, id: "" });
  const duplicate = site.rules.find((candidate) => candidate.selector === sanitized.selector);
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
  if (site.rules.some((candidate) => candidate !== storedRule && candidate?.selector === selector)) {
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
  const replacement = sanitizeRule({ ...rule, id: "" });
  if (!replacement.fingerprint.tag) {
    throw new Error("The replacement component fingerprint is invalid");
  }

  const config = await loadConfig();
  const site = getOrCreateSite(config, normalizedOrigin);
  if (!site.enabled) throw new Error("Protection is not enabled for this site");
  const storedRule = site.rules.find((candidate) => candidate?.id === id);
  if (!storedRule) throw new Error("The component rule no longer exists");
  if (site.rules.some((candidate) => candidate !== storedRule && candidate?.selector === replacement.selector)) {
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
