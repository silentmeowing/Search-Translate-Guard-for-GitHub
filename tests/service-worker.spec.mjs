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
  const tabMessages = [];
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
      }
    },
    tabs: {
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, message: structuredClone(message) });
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
    structuredClone,
    URL
  });

  async function send(message, sender = {}) {
    return new Promise((resolve) => {
      const keepChannelOpen = onMessage.listeners[0](message, sender, resolve);
      expect(keepChannelOpen).toBe(true);
    });
  }

  return { grantedOrigins, registrations, send, storage, tabMessages };
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
        version: "2.2.1",
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
        selector: "main > custom-search[role=combobox]",
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
    expect(storedRule.selector).toBe("main > custom-search[role=combobox]");
    expect(storedRule.fingerprint).toEqual({ tag: "custom-search", role: "combobox" });
    expect(JSON.stringify(storedRule)).not.toContain("private visible page text");
    expect(harness.tabMessages.at(-1)).toMatchObject({
      tabId: 42,
      message: { type: "site-guard:rules-updated", origin: "https://example.com" }
    });
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
      tabId: 7
    });
    expect(disabled.ok).toBe(true);
    expect(disabled.result.enabled).toBe(false);
    expect(harness.registrations).toHaveLength(0);
  });
});
