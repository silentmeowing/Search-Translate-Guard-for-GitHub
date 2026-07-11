"use strict";

const elements = {
  origin: document.querySelector("#origin"),
  status: document.querySelector("#status"),
  builtIn: document.querySelector("#built-in"),
  summary: document.querySelector("#summary"),
  error: document.querySelector("#error"),
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

function showError(error) {
  elements.error.textContent = error.message || String(error);
  elements.error.hidden = false;
}

async function refresh() {
  const status = await sendMessage({ type: "site-guard:get-status", origin });
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
  elements.enable.hidden = status.enabled;
  elements.select.hidden = !status.enabled;
  elements.clear.hidden = !status.enabled || status.ruleCount === 0;
  elements.disable.hidden = !status.enabled;
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
    await executeFiles(["src/risk-detector.js", "src/selector-tools.js", "src/picker.js"]);
    globalThis.close();
  } catch (error) {
    showError(error);
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
