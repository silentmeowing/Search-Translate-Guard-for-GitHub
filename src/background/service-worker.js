"use strict";

const STORAGE_KEY = "siteGuardConfig";
const SCHEMA_VERSION = 1;
const SCRIPT_PREFIX = "site-guard-";
const CONTENT_SCRIPT_FILE = "Site-Translate-Guard.content.js";
const MAX_RULES_PER_SITE = 50;
const MAX_SELECTOR_LENGTH = 512;

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
    id: typeof rule.id === "string" && rule.id ? rule.id : crypto.randomUUID(),
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

async function notifyRulesUpdated(tabId, origin, rules) {
  if (!Number.isInteger(tabId)) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "site-guard:rules-updated",
      origin,
      rules
    });
  } catch {
    // The current page may not have the persistent content script yet.
  }
}

async function siteStatus(origin) {
  const normalizedOrigin = canonicalOrigin(origin);
  const config = await loadConfig();
  const site = config.sites[normalizedOrigin];
  const permissionGranted = await hasOriginPermission(normalizedOrigin);
  return {
    origin: normalizedOrigin,
    builtIn: normalizedOrigin === "https://github.com",
    permissionGranted,
    enabled: Boolean(site?.enabled && permissionGranted),
    ruleCount: Array.isArray(site?.rules) ? site.rules.length : 0
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
  await notifyRulesUpdated(tabId, normalizedOrigin, []);
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

  const sanitized = sanitizeRule(rule);
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
  return {
    id: storedRule.id,
    selector: storedRule.selector,
    fingerprint: storedRule.fingerprint,
    reboundAt: storedRule.reboundAt
  };
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
      return siteStatus(message.origin);
    case "site-guard:enable":
      return enableSite(message.origin);
    case "site-guard:disable":
      return disableSite(message.origin, message.tabId);
    case "site-guard:clear-rules":
      return clearRules(message.origin, message.tabId);
    case "site-guard:add-rule":
      return addRule(message.origin, message.rule, sender);
    case "site-guard:rebind-rule":
      return rebindRule(message.origin, message.rule, sender);
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

chrome.runtime.onInstalled.addListener(() => void reconcileRegistrations());
chrome.runtime.onStartup.addListener(() => void reconcileRegistrations());
chrome.permissions.onRemoved.addListener(() => void reconcileRegistrations());
