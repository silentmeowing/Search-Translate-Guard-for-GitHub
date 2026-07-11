"use strict";

const elements = {
  origin: document.querySelector("#origin"),
  status: document.querySelector("#status"),
  builtIn: document.querySelector("#built-in"),
  summary: document.querySelector("#summary"),
  observed: document.querySelector("#observed"),
  error: document.querySelector("#error"),
  ruleHealth: document.querySelector("#rule-health"),
  healthSummary: document.querySelector("#health-summary"),
  ruleList: document.querySelector("#rule-list"),
  enable: document.querySelector("#enable"),
  select: document.querySelector("#select"),
  clear: document.querySelector("#clear"),
  disable: document.querySelector("#disable")
};

const message = (key, substitutions, fallback) => {
  const translated = chrome.i18n.getMessage(key, substitutions);
  return translated || fallback;
};

document.querySelectorAll("[data-i18n]").forEach((element) => {
  element.textContent = message(element.dataset.i18n, undefined, element.textContent);
});

let activeTab = null;
let origin = "";

function originPattern(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname}/*`;
}

function queryActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(tabs[0]);
    });
  });
}

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response?.ok) reject(new Error(response?.error || "Extension request failed"));
      else resolve(response.result);
    });
  });
}

function requestOriginPermission() {
  return new Promise((resolve, reject) => {
    chrome.permissions.request({ origins: [originPattern(origin)] }, (granted) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(granted);
    });
  });
}

function removeOriginPermission() {
  return new Promise((resolve, reject) => {
    chrome.permissions.remove({ origins: [originPattern(origin)] }, (removed) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(removed);
    });
  });
}

function executeFiles(files) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files
    }, (results) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(results);
    });
  });
}

function preparePickerRequest(ruleId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: (id) => {
        globalThis[Symbol.for("search-translate-guard.component-picker-request")] = id
          ? { ruleId: id }
          : {};
      },
      args: [ruleId]
    }, (results) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(results);
    });
  });
}

function showError(error) {
  elements.error.textContent = error.message || String(error);
  elements.error.hidden = false;
}

function healthMessage(state) {
  const messages = {
    healthy: ["siteGuardHealthHealthy", "Protected on this page."],
    recovering: ["siteGuardHealthRecovering", "Waiting for a stable replacement."],
    missing: ["siteGuardHealthMissing", "No matching component was found."],
    ambiguous: ["siteGuardHealthAmbiguous", "More than one matching component was found."],
    weak: ["siteGuardHealthWeak", "This older rule lacks enough identity data for automatic repair."],
    invalid: ["siteGuardHealthInvalid", "The saved selector is invalid."],
    unavailable: ["siteGuardHealthUnavailable", "Reload this page to inspect the rule."]
  };
  const [key, fallback] = messages[state] || messages.unavailable;
  return message(key, undefined, fallback);
}

function renderRuleHealth(rules) {
  elements.ruleList.replaceChildren();
  const items = Array.isArray(rules) ? rules : [];
  elements.ruleHealth.hidden = items.length === 0;
  if (!items.length) return;

  const issueCount = items.filter((rule) => rule.state !== "healthy").length;
  elements.healthSummary.textContent = issueCount
    ? message(
      "siteGuardHealthIssues",
      [String(issueCount)],
      `${issueCount} rule(s) need attention.`
    )
    : message("siteGuardHealthAllHealthy", undefined, "All component rules are active on this page.");

  for (const rule of items) {
    const item = document.createElement("li");
    item.className = "rule-item";

    const selector = document.createElement("code");
    selector.textContent = rule.selector || "?";
    selector.title = rule.selector || "";

    const state = document.createElement("p");
    state.className = "rule-state";
    state.dataset.state = rule.state;
    state.textContent = healthMessage(rule.state);

    const actions = document.createElement("div");
    actions.className = "rule-actions";
    if (rule.state !== "healthy") {
      const repair = document.createElement("button");
      repair.type = "button";
      repair.dataset.action = "repair";
      repair.dataset.ruleId = rule.id;
      repair.textContent = message("siteGuardRepair", undefined, "Repair");
      actions.append(repair);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.dataset.action = "remove";
    remove.dataset.ruleId = rule.id;
    remove.textContent = message("siteGuardRemoveRule", undefined, "Remove");
    actions.append(remove);

    item.append(selector, state, actions);
    elements.ruleList.append(item);
  }
}

async function openPicker(ruleId = "") {
  await preparePickerRequest(ruleId);
  await executeFiles([
    "src/composed-tree.js",
    "src/risk-detector.js",
    "src/selector-tools.js",
    "src/picker.js"
  ]);
  globalThis.close();
}

async function refresh() {
  const status = await sendMessage({
    type: "site-guard:get-status",
    origin,
    tabId: activeTab.id
  });
  elements.origin.textContent = status.origin;
  elements.builtIn.hidden = !status.builtIn;
  elements.status.textContent = status.enabled
    ? message("siteGuardEnabled", undefined, "User-selected protection is enabled.")
    : message("siteGuardDisabled", undefined, "User-selected protection is disabled.");
  elements.summary.textContent = message(
    "siteGuardRuleCount",
    [String(status.ruleCount)],
    `${status.ruleCount} protected component rule(s)`
  );
  const observedRiskCount = Number.isInteger(status.observedRiskCount)
    ? Math.max(0, status.observedRiskCount)
    : 0;
  elements.observed.hidden = !status.enabled || observedRiskCount === 0;
  elements.observed.textContent = observedRiskCount
    ? message(
      "siteGuardObservedRisks",
      [String(observedRiskCount)],
      `${observedRiskCount} recent risky DOM rewrite(s) were observed. Review suggested components.`
    )
    : "";
  elements.enable.hidden = status.enabled;
  elements.select.hidden = !status.enabled;
  elements.clear.hidden = !status.enabled || status.ruleCount === 0;
  elements.disable.hidden = !status.enabled;
  renderRuleHealth(status.enabled ? status.rules : []);
}

elements.enable.addEventListener("click", async () => {
  elements.error.hidden = true;
  elements.enable.disabled = true;
  try {
    const granted = await requestOriginPermission();
    if (!granted) throw new Error(message("siteGuardPermissionDenied", undefined, "Site access was not granted."));
    await sendMessage({ type: "site-guard:enable", origin });
    await executeFiles(["Site-Translate-Guard.content.js"]);
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    elements.enable.disabled = false;
  }
});

elements.select.addEventListener("click", async () => {
  elements.error.hidden = true;
  try {
    await openPicker();
  } catch (error) {
    showError(error);
  }
});

elements.ruleList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action][data-rule-id]");
  if (!button) return;
  elements.error.hidden = true;
  button.disabled = true;
  try {
    if (button.dataset.action === "repair") {
      await openPicker(button.dataset.ruleId);
      return;
    }
    if (!globalThis.confirm(message(
      "siteGuardRemoveConfirm",
      undefined,
      "Remove this component rule?"
    ))) return;
    await sendMessage({
      type: "site-guard:remove-rule",
      origin,
      ruleId: button.dataset.ruleId,
      tabId: activeTab.id
    });
    await refresh();
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
});

elements.clear.addEventListener("click", async () => {
  if (!globalThis.confirm(message("siteGuardClearConfirm", undefined, "Clear all component rules for this site?"))) return;
  elements.error.hidden = true;
  try {
    await sendMessage({ type: "site-guard:clear-rules", origin, tabId: activeTab.id });
    await refresh();
  } catch (error) {
    showError(error);
  }
});

elements.disable.addEventListener("click", async () => {
  elements.error.hidden = true;
  try {
    await sendMessage({ type: "site-guard:disable", origin, tabId: activeTab.id });
    await removeOriginPermission();
    await refresh();
  } catch (error) {
    showError(error);
  }
});

(async () => {
  try {
    activeTab = await queryActiveTab();
    const url = new URL(activeTab?.url || "");
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(message("siteGuardUnsupported", undefined, "This page cannot be protected."));
    }
    origin = url.origin;
    await refresh();
  } catch (error) {
    showError(error);
    for (const button of document.querySelectorAll("button")) button.disabled = true;
  }
})();
