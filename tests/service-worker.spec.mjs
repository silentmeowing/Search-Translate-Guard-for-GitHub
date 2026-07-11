import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { chromium, expect, test } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");
const workerSource = fs.readFileSync(
  path.join(root, "src", "background", "service-worker.js"),
  "utf8"
);

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

function createWorkerHarness() {
  const storage = {};
  const registrations = [];
  const scriptExecutions = [];
  const tabMessages = [];
  const frameResponseFrameIds = [];
  const acceptedFrameIds = [];
  const tabUrls = new Map([
    [7, "https://attacker.example/page"],
    [42, "https://example.com/app"],
    [43, "https://example.com/other"]
  ]);
  const runtimeHealth = {
    origin: "https://example.com",
    observedRiskCount: 0,
    rules: []
  };
  const runtimeHealthByFrame = new Map();
  const frameOrigins = new Map([
    [0, "https://example.com"],
    [4, "https://example.com"],
    [9, "https://embedded.example"]
  ]);
  const grantedOrigins = new Set(["https://example.com/*"]);
  const onMessage = createEvent();
  const chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: storage[key] };
        },
        async set(values) {
          Object.assign(storage, structuredClone(values));
        }
      }
    },
    permissions: {
      async contains({ origins }) {
        return origins.every((origin) => grantedOrigins.has(origin));
      },
      onRemoved: createEvent()
    },
    scripting: {
      async getRegisteredContentScripts(filter = {}) {
        const ids = filter.ids ? new Set(filter.ids) : null;
        return registrations
          .filter((registration) => !ids || ids.has(registration.id))
          .map((registration) => structuredClone(registration));
      },
      async registerContentScripts(scripts) {
        registrations.push(...structuredClone(scripts));
      },
      async updateContentScripts(scripts) {
        for (const script of scripts) {
          const index = registrations.findIndex((candidate) => candidate.id === script.id);
          if (index >= 0) registrations[index] = structuredClone(script);
        }
      },
      async unregisterContentScripts({ ids }) {
        for (const id of ids) {
          const index = registrations.findIndex((candidate) => candidate.id === id);
          if (index >= 0) registrations.splice(index, 1);
        }
      },
      async executeScript(options) {
        scriptExecutions.push(structuredClone(options));
        return (options.target?.frameIds || []).map((frameId) => ({ frameId }));
      }
    },
    tabs: {
      async query({ url }) {
        const patterns = Array.isArray(url) ? url : [url];
        return [...tabUrls.entries()]
          .filter(([, tabUrl]) => patterns.some((pattern) => {
            const prefix = pattern.replace(/\*$/, "");
            return tabUrl.startsWith(prefix);
          }))
          .map(([id, tabUrl]) => ({ id, url: tabUrl }));
      },
      async get(tabId) {
        const url = tabUrls.get(tabId);
        return url ? { id: tabId, url } : null;
      },
      async sendMessage(tabId, message, options = {}, callback) {
        tabMessages.push({
          tabId,
          message: structuredClone(message),
          options: structuredClone(options)
        });
        if (message.type === "site-guard:get-rule-health") {
          const response = structuredClone(runtimeHealthByFrame.get(options.frameId) || runtimeHealth);
          callback?.(response);
          return response;
        }
        if (
          message.type === "site-guard:collect-frame-health" ||
          message.type === "site-guard:prepare-frame-picker"
        ) {
          const kind = message.type === "site-guard:collect-frame-health" ? "health" : "picker";
          for (const [frameId, frameOrigin] of frameOrigins) {
            if (frameOrigin !== message.origin) continue;
            const scope = frameId === 0 ? "top" : "child";
            if (message.frameScope && message.frameScope !== scope) continue;
            frameResponseFrameIds.push(frameId);
            const snapshot = kind === "health"
              ? structuredClone(runtimeHealthByFrame.get(frameId) || runtimeHealth)
              : undefined;
            const response = await send({
              type: "site-guard:frame-response",
              origin: message.origin,
              requestId: message.requestId,
              kind,
              snapshot
            }, {
              url: `${frameOrigin}/frame`,
              tab: { id: tabId },
              frameId
            });
            if (response.result?.accepted) acceptedFrameIds.push(frameId);
          }
          callback?.();
          return undefined;
        }
        callback?.();
      }
    },
    runtime: {
      onMessage,
      onInstalled: createEvent(),
      onStartup: createEvent()
    }
  };

  vm.runInNewContext(workerSource, {
    chrome,
    console,
    crypto: { randomUUID: crypto.randomUUID },
    clearTimeout,
    setTimeout,
    structuredClone,
    URL
  });

  async function send(message, sender = {}) {
    return new Promise((resolve) => {
      const keepChannelOpen = onMessage.listeners[0](message, sender, resolve);
      expect(keepChannelOpen).toBe(true);
    });
  }

  return {
    acceptedFrameIds,
    frameOrigins,
    frameResponseFrameIds,
    grantedOrigins,
    registrations,
    runtimeHealth,
    runtimeHealthByFrame,
    scriptExecutions,
    send,
    storage,
    tabMessages,
    tabUrls
  };
}

test.describe("site guard service worker", () => {
  test("loads the complete unpacked Manifest V3 extension", async ({}, testInfo) => {
    const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${root}`,
        `--load-extension=${root}`
      ]
    });
    try {
      const workers = context.serviceWorkers();
      const worker = workers[0] || await context.waitForEvent("serviceworker");
      const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
      expect(manifest).toMatchObject({
        manifest_version: 3,
        version: "2.8.0",
        permissions: ["activeTab", "scripting", "storage"],
        optional_host_permissions: ["http://*/*", "https://*/*"]
      });
    } finally {
      await context.close();
    }
  });

  test("enables one origin and registers a persistent document-start script", async () => {
    const harness = createWorkerHarness();
    const response = await harness.send({
      type: "site-guard:enable",
      origin: "https://example.com/path"
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      origin: "https://example.com",
      enabled: true,
      permissionGranted: true,
      ruleCount: 0
    });
    expect(harness.registrations).toHaveLength(1);
    expect(harness.registrations[0]).toMatchObject({
      matches: ["https://example.com/*"],
      js: ["Site-Translate-Guard.content.js"],
      allFrames: true,
      runAt: "document_start",
      persistAcrossSessions: true
    });
  });

  test("stores only a sanitized structural rule and not visible text", async () => {
    const harness = createWorkerHarness();
    await harness.send({ type: "site-guard:enable", origin: "https://example.com" });
    const response = await harness.send({
      type: "site-guard:add-rule",
      origin: "https://example.com",
      rule: {
        selector: "main > custom-shell >>> custom-search[role=combobox]",
        fingerprint: {
          tag: "custom-search",
          role: "combobox",
          text: "private visible page text"
        }
      }
    }, {
      url: "https://example.com/private/page",
      tab: { id: 42 }
    });

    expect(response.ok).toBe(true);
    expect(response.result.ruleCount).toBe(1);
    const storedRule = harness.storage.siteGuardConfig.sites["https://example.com"].rules[0];
    expect(storedRule.selector).toBe("main > custom-shell >>> custom-search[role=combobox]");
    expect(storedRule.frameScope).toBe("top");
    expect(storedRule.fingerprint).toEqual({ tag: "custom-search", role: "combobox" });
    expect(JSON.stringify(storedRule)).not.toContain("private visible page text");
    expect(harness.tabMessages.find(({ tabId }) => tabId === 42)).toMatchObject({
      tabId: 42,
      message: { type: "site-guard:rules-updated", origin: "https://example.com" }
    });
    expect(harness.tabMessages.find(({ tabId }) => tabId === 43)).toMatchObject({
      tabId: 43,
      message: { type: "site-guard:rules-updated", origin: "https://example.com" }
    });
  });

  test("serializes concurrent rule writes without losing either component", async () => {
    const harness = createWorkerHarness();
    await harness.send({ type: "site-guard:enable", origin: "https://example.com" });
    const sender = { url: "https://example.com/app", tab: { id: 42 } };

    const responses = await Promise.all([
      harness.send({
        type: "site-guard:add-rule",
        origin: "https://example.com",
        rule: { selector: "#search", fingerprint: { tag: "custom-search", role: "combobox" } }
      }, sender),
      harness.send({
        type: "site-guard:add-rule",
        origin: "https://example.com",
        rule: { selector: "#menu", fingerprint: { tag: "custom-menu", role: "menu" } }
      }, sender)
    ]);

    expect(responses.every((response) => response.ok)).toBe(true);
    expect(harness.storage.siteGuardConfig.sites["https://example.com"].rules)
      .toHaveLength(2);
    expect(harness.storage.siteGuardConfig.sites["https://example.com"].rules.map(
      (rule) => rule.selector
    )).toEqual(["#search", "#menu"]);
  });

  test("persists a same-origin selector rebind and rejects forged updates", async () => {
    const harness = createWorkerHarness();
    await harness.send({ type: "site-guard:enable", origin: "https://example.com" });
    await harness.send({
      type: "site-guard:add-rule",
      origin: "https://example.com",
      rule: {
        selector: "#old-search",
        fingerprint: { tag: "custom-search", role: "combobox", landmark: "main" }
      }
    }, {
      url: "https://example.com/app",
      tab: { id: 42 }
    });
    const storedRule = harness.storage.siteGuardConfig.sites["https://example.com"].rules[0];

    const rebound = await harness.send({
      type: "site-guard:rebind-rule",
      origin: "https://example.com",
      rule: {
        id: storedRule.id,
        selector: "#new-search",
        fingerprint: {
          tag: "custom-search",
          role: "combobox",
          landmark: "main",
          text: "private translated copy"
        }
      }
    }, {
      url: "https://example.com/new-route",
      tab: { id: 42 }
    });

    expect(rebound.ok).toBe(true);
    expect(rebound.result).toMatchObject({
      id: storedRule.id,
      selector: "#new-search",
      fingerprint: { tag: "custom-search", role: "combobox", landmark: "main" }
    });
    expect(rebound.result.reboundAt).toEqual(expect.any(String));
    expect(JSON.stringify(rebound.result)).not.toContain("private translated copy");

    const changedIdentity = await harness.send({
      type: "site-guard:rebind-rule",
      origin: "https://example.com",
      rule: {
        id: storedRule.id,
        selector: "#different-component",
        fingerprint: { tag: "custom-search", role: "listbox", landmark: "main" }
      }
    }, {
      url: "https://example.com/new-route",
      tab: { id: 42 }
    });
    expect(changedIdentity.ok).toBe(false);
    expect(changedIdentity.error).toContain("does not match");

    const forged = await harness.send({
      type: "site-guard:rebind-rule",
      origin: "https://example.com",
      rule: { id: storedRule.id, selector: "#attacker-target" }
    }, {
      url: "https://attacker.example/page",
      tab: { id: 7 }
    });
    expect(forged.ok).toBe(false);
    expect(forged.error).toContain("does not belong");
    expect(
      harness.storage.siteGuardConfig.sites["https://example.com"].rules[0].selector
    ).toBe("#new-search");
  });

  test("reports ephemeral rule health without persisting page diagnostics", async () => {
    const harness = createWorkerHarness();
    await harness.send({ type: "site-guard:enable", origin: "https://example.com" });
    for (const [selector, role] of [["#search", "combobox"], ["#menu", "menu"]]) {
      await harness.send({
        type: "site-guard:add-rule",
        origin: "https://example.com",
        rule: { selector, fingerprint: { tag: "div", role } }
      }, {
        url: "https://example.com/app",
        tab: { id: 42 }
      });
    }
    const storedRules = harness.storage.siteGuardConfig.sites["https://example.com"].rules;
    harness.runtimeHealth.rules = [
      { id: storedRules[0].id, state: "healthy", text: "private page copy" },
      { id: storedRules[1].id, state: "ambiguous" },
      { id: "forged", state: "arbitrary" }
    ];
    harness.runtimeHealth.observedRiskCount = 500;

    const response = await harness.send({
      type: "site-guard:get-status",
      origin: "https://example.com",
      tabId: 42
    });

    expect(response.ok).toBe(true);
    expect(response.result.rules).toEqual([
      { id: storedRules[0].id, selector: "#search", frameScope: "top", state: "healthy" },
      { id: storedRules[1].id, selector: "#menu", frameScope: "top", state: "ambiguous" }
    ]);
    expect(response.result.observedRiskCount).toBe(24);
    expect(response.result.sameOriginFrameCount).toBe(2);
    expect(JSON.stringify(harness.storage)).not.toContain("private page copy");
  });

  test("aggregates rule health only from responding same-origin frames", async () => {
    const harness = createWorkerHarness();
    await harness.send({ type: "site-guard:enable", origin: "https://example.com" });
    await harness.send({
      type: "site-guard:add-rule",
      origin: "https://example.com",
      rule: {
        selector: "#embedded-search",
        fingerprint: { tag: "custom-search", role: "combobox" }
      }
    }, {
      url: "https://example.com/app",
      tab: { id: 42 },
      frameId: 4
    });
    const storedRule = harness.storage.siteGuardConfig.sites["https://example.com"].rules[0];
    expect(storedRule.frameScope).toBe("child");
    harness.runtimeHealth.observedRiskCount = 1;
    harness.runtimeHealth.rules = [];
    harness.runtimeHealthByFrame.set(4, {
      origin: "https://example.com",
      observedRiskCount: 2,
      rules: [{ id: storedRule.id, state: "healthy", text: "private iframe copy" }]
    });
    harness.runtimeHealthByFrame.set(9, {
      origin: "https://embedded.example",
      observedRiskCount: 24,
      rules: [{ id: storedRule.id, state: "healthy" }]
    });

    const response = await harness.send({
      type: "site-guard:get-status",
      origin: "https://example.com",
      tabId: 42
    });

    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({
      sameOriginFrameCount: 2,
      observedRiskCount: 3,
      rules: [{ id: storedRule.id, frameScope: "child", state: "healthy" }]
    });
    expect(JSON.stringify(response.result)).not.toContain("private iframe copy");
    const healthFrameIds = [...harness.acceptedFrameIds]
      .sort((left, right) => left - right);
    expect(healthFrameIds).toEqual([0, 4]);
  });

  test("keeps top and child rules separate and opens repair only in the stored scope", async () => {
    const harness = createWorkerHarness();
    await harness.send({ type: "site-guard:enable", origin: "https://example.com" });
    const rule = {
      selector: "#shared-search",
      fingerprint: { tag: "custom-search", role: "combobox" }
    };
    await harness.send({
      type: "site-guard:add-rule",
      origin: "https://example.com",
      rule
    }, {
      url: "https://example.com/app",
      tab: { id: 42 },
      frameId: 0
    });
    await harness.send({
      type: "site-guard:add-rule",
      origin: "https://example.com",
      rule
    }, {
      url: "https://example.com/frame",
      tab: { id: 42 },
      frameId: 4
    });

    const storedRules = harness.storage.siteGuardConfig.sites["https://example.com"].rules;
    expect(storedRules.map(({ frameScope }) => frameScope)).toEqual(["top", "child"]);
    const childRule = storedRules[1];

    const opened = await harness.send({
      type: "site-guard:open-picker",
      origin: "https://example.com",
      tabId: 42,
      ruleId: childRule.id
    });
    expect(opened).toEqual({
      ok: true,
      result: { origin: "https://example.com", frameCount: 1, frameScope: "child" }
    });
    expect(harness.scriptExecutions).toEqual([{
      target: { tabId: 42, frameIds: [4] },
      files: [
        "src/composed-tree.js",
        "src/risk-detector.js",
        "src/selector-tools.js",
        "src/picker.js"
      ]
    }]);

    const automaticChildRepair = await harness.send({
      type: "site-guard:rebind-rule",
      origin: "https://example.com",
      rule: { ...childRule, selector: "#automatic-child-search" }
    }, {
      url: "https://example.com/frame",
      tab: { id: 42 },
      frameId: 4
    });
    expect(automaticChildRepair.ok).toBe(false);
    expect(automaticChildRepair.error).toContain("top-document");

    const wrongScopeRepair = await harness.send({
      type: "site-guard:replace-rule",
      origin: "https://example.com",
      rule: { ...childRule, selector: "#wrong-scope-search" }
    }, {
      url: "https://example.com/app",
      tab: { id: 42 },
      frameId: 0
    });
    expect(wrongScopeRepair.ok).toBe(false);
    expect(wrongScopeRepair.error).toContain("frame scope");

    const repaired = await harness.send({
      type: "site-guard:replace-rule",
      origin: "https://example.com",
      rule: { ...childRule, selector: "#explicit-child-search" }
    }, {
      url: "https://example.com/frame",
      tab: { id: 42 },
      frameId: 4
    });
    expect(repaired.ok).toBe(true);
    expect(storedRules[1]).toMatchObject({
      selector: "#explicit-child-search",
      frameScope: "child"
    });
  });

  test("bounds same-origin frame health inspection", async () => {
    const harness = createWorkerHarness();
    harness.frameOrigins.clear();
    for (let frameId = 0; frameId < 80; frameId += 1) {
      harness.frameOrigins.set(frameId, "https://example.com");
    }
    await harness.send({ type: "site-guard:enable", origin: "https://example.com" });

    const response = await harness.send({
      type: "site-guard:get-status",
      origin: "https://example.com",
      tabId: 42
    });

    expect(response.ok).toBe(true);
    expect(response.result.sameOriginFrameCount).toBe(64);
    expect(harness.acceptedFrameIds).toHaveLength(64);
    expect(harness.acceptedFrameIds.at(-1)).toBe(63);
    expect(harness.scriptExecutions).toEqual([]);
  });

  test("cancels pickers across the tab only for the sender origin", async () => {
    const harness = createWorkerHarness();
    const accepted = await harness.send({
      type: "site-guard:cancel-picker",
      origin: "https://example.com"
    }, {
      url: "https://example.com/frame",
      tab: { id: 42 }
    });
    expect(accepted).toEqual({ ok: true, result: { origin: "https://example.com" } });
    expect(harness.tabMessages.at(-1)).toMatchObject({
      tabId: 42,
      message: { type: "site-guard:cancel-picker", origin: "https://example.com" }
    });

    const rejected = await harness.send({
      type: "site-guard:cancel-picker",
      origin: "https://example.com"
    }, {
      url: "https://attacker.example/frame",
      tab: { id: 7 }
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("does not belong");
  });

  test("explicitly repairs and removes one rule while rejecting cross-origin actions", async () => {
    const harness = createWorkerHarness();
    await harness.send({ type: "site-guard:enable", origin: "https://example.com" });
    await harness.send({
      type: "site-guard:add-rule",
      origin: "https://example.com",
      rule: {
        selector: "#old-search",
        fingerprint: { tag: "custom-search", role: "combobox" }
      }
    }, {
      url: "https://example.com/app",
      tab: { id: 42 }
    });
    const storedRule = harness.storage.siteGuardConfig.sites["https://example.com"].rules[0];

    const repaired = await harness.send({
      type: "site-guard:replace-rule",
      origin: "https://example.com",
      rule: {
        id: storedRule.id,
        selector: "#replacement-dialog",
        fingerprint: { tag: "div", role: "dialog", text: "private dialog title" }
      }
    }, {
      url: "https://example.com/route",
      tab: { id: 42 }
    });
    expect(repaired.ok).toBe(true);
    expect(repaired.result).toMatchObject({
      id: storedRule.id,
      selector: "#replacement-dialog",
      fingerprint: { tag: "div", role: "dialog" }
    });
    expect(repaired.result.repairedAt).toEqual(expect.any(String));
    expect(JSON.stringify(repaired.result)).not.toContain("private dialog title");

    const forgedRepair = await harness.send({
      type: "site-guard:replace-rule",
      origin: "https://example.com",
      rule: { id: storedRule.id, selector: "#attacker", fingerprint: { tag: "div" } }
    }, {
      url: "https://attacker.example/page",
      tab: { id: 7 }
    });
    expect(forgedRepair.ok).toBe(false);
    expect(forgedRepair.error).toContain("does not belong");

    const forgedRemoval = await harness.send({
      type: "site-guard:remove-rule",
      origin: "https://example.com",
      ruleId: storedRule.id,
      tabId: 7
    });
    expect(forgedRemoval.ok).toBe(false);
    expect(forgedRemoval.error).toContain("current tab");

    const removed = await harness.send({
      type: "site-guard:remove-rule",
      origin: "https://example.com",
      ruleId: storedRule.id,
      tabId: 42
    });
    expect(removed.ok).toBe(true);
    expect(removed.result.ruleCount).toBe(0);
    expect(harness.storage.siteGuardConfig.sites["https://example.com"].rules).toEqual([]);
  });

  test("rejects cross-origin rule messages and unregisters disabled sites", async () => {
    const harness = createWorkerHarness();
    await harness.send({ type: "site-guard:enable", origin: "https://example.com" });
    const rejected = await harness.send({
      type: "site-guard:add-rule",
      origin: "https://example.com",
      rule: { selector: "#search" }
    }, {
      url: "https://attacker.example/page",
      tab: { id: 7 }
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("does not belong");

    const disabled = await harness.send({
      type: "site-guard:disable",
      origin: "https://example.com",
      tabId: 42
    });
    expect(disabled.ok).toBe(true);
    expect(disabled.result.enabled).toBe(false);
    expect(harness.registrations).toHaveLength(0);
    expect(harness.tabMessages.filter(({ message }) => (
      message.type === "site-guard:rules-updated" && message.enabled === false
    )).map(({ tabId }) => tabId).sort()).toEqual([42, 43]);
  });
});
