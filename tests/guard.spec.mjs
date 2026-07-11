import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");
const coreSource = fs.readFileSync(path.join(root, "src/core.js"), "utf8");
const generatedSource = fs.readFileSync(
  path.join(root, "GitHub-Search-Translate-Guard.user.js"),
  "utf8"
);
const siteGeneratedSource = fs.readFileSync(
  path.join(root, "Site-Translate-Guard.content.js"),
  "utf8"
);
const riskDetectorSource = fs.readFileSync(path.join(root, "src/risk-detector.js"), "utf8");
const selectorToolsSource = fs.readFileSync(path.join(root, "src/selector-tools.js"), "utf8");
const pickerSource = fs.readFileSync(path.join(root, "src/picker.js"), "utf8");

const authenticatedGitHubFixture = `<!doctype html>
  <html><head><meta charset="utf-8"><style>
    .d-none { display: none; }
    #authenticated-compact-search-trigger { display: none; }
    @media (max-width: 700px) {
      #authenticated-search-trigger { display: none; }
      #authenticated-compact-search-trigger { display: inline-flex; }
    }
  </style></head><body>
    <header role="banner">
      <div data-testid="top-nav-center">
        <button
          id="authenticated-search-trigger"
          data-component="Button"
          type="button"
          aria-label="Search or jump to…"
          class="Search-module__searchButton__fixture"
        >
          <span data-component="buttonContent">
            <span id="authenticated-search-label">Type <kbd>/</kbd> to search</span>
          </span>
        </button>
        <button
          id="authenticated-compact-search-trigger"
          data-component="IconButton"
          type="button"
          aria-labelledby="authenticated-compact-search-label"
          class="Search-module__smallSearchButton__fixture"
        >
          <svg aria-hidden="true" class="octicon octicon-search" viewBox="0 0 16 16"></svg>
        </button>
        <span id="authenticated-compact-search-label" hidden>Search or jump to…</span>
        <div class="d-none">
          <qbsearch-input
            id="authenticated-template-search"
            data-scope="repo:silentmeowing/Search-Translate-Guard-for-GitHub"
            data-header-redesign-enabled="true"
            data-logged-in="true"
          >
            <input role="combobox" style="width: 240px; height: 32px">
          </qbsearch-input>
        </div>
        <div id="authenticated-live-container" class="d-none">
          <qbsearch-input
            id="authenticated-live-search"
            data-scope="repo:silentmeowing/Search-Translate-Guard-for-GitHub"
            data-header-redesign-enabled="true"
            data-logged-in="true"
          >
            <input role="combobox" style="width: 240px; height: 32px">
          </qbsearch-input>
        </div>
      </div>
    </header>
    <p id="outside-copy">Repository content remains translatable</p>
    <script>
      (() => {
        const trigger = document.querySelector("#authenticated-search-trigger");
        const compactTrigger = document.querySelector("#authenticated-compact-search-trigger");
        const label = document.querySelector("#authenticated-search-label");
        const originalText = label.firstChild;
        globalThis.githubFixtureError = null;
        globalThis.githubFixtureForceFailure = false;

        const activateSearch = (activeTrigger) => {
          if (globalThis.githubFixtureForceFailure) return;
          try {
            label.removeChild(originalText);
          } catch (error) {
            globalThis.githubFixtureError = String(error);
            if (activeTrigger === trigger) trigger.remove();
            return;
          }

          label.prepend("Search ");
          const container = document.querySelector("#authenticated-live-container");
          const search = document.querySelector("#authenticated-live-search");
          container.classList.remove("d-none");
          search.classList.add("expanded");
        };

        trigger.addEventListener("click", () => activateSearch(trigger));
        compactTrigger.addEventListener("click", () => activateSearch(compactTrigger));

        globalThis.applyTranslationMutation = () => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const textNodes = [];
          while (walker.nextNode()) textNodes.push(walker.currentNode);
          for (const node of textNodes) {
            const parent = node.parentElement;
            if (
              !parent ||
              !node.data.trim() ||
              parent.closest('script, style, [translate="no"], .notranslate')
            ) continue;
            const translated = document.createElement("font");
            translated.dataset.translated = "true";
            translated.textContent = "[translated] " + node.data.trim();
            node.parentNode.replaceChild(translated, node);
          }
        };
      })();
    <\/script>
  </body></html>`;

function fixtureUrl(name) {
  return pathToFileURL(path.join(root, "tests", "fixtures", name)).href;
}

function genericGuardSource(selector = ".fixture-root") {
  return `${coreSource}
(() => {
  const runtime = globalThis[Symbol.for("search-translate-guard.runtime")];
  runtime.registerAdapter({
    id: "fixture-adapter",
    matches: () => true,
    protection: {
      select: (root) => runtime.selectWithin(root, ${JSON.stringify(selector)})
    }
  });
  runtime.start();
})();`;
}

async function runMutationFixture(page, fixture, triggerSelector, expectedSuccessSelector) {
  await page.goto(fixtureUrl(fixture));
  await expect(page.locator(".fixture-root")).toHaveAttribute("translate", "no");
  await expect(page.locator(".fixture-root")).toHaveClass(/notranslate/);

  await page.evaluate(() => globalThis.applyTranslationMutation());
  await expect(page.locator("#outside-copy font[data-translated]")).toHaveCount(1);
  await expect(page.locator(".fixture-root font[data-translated]")).toHaveCount(0);

  await page.locator(triggerSelector).click();
  expect(await page.evaluate(() => globalThis.fixtureError)).toBeNull();
  await expect(page.locator(expectedSuccessSelector)).toHaveCount(1);
}

test.describe("generic guard core", () => {
  test("the unprotected React-style fixture reproduces a translation DOM mismatch", async ({ page }) => {
    await page.goto(fixtureUrl("react-next.html"));
    await page.evaluate(() => globalThis.applyTranslationMutation());
    await page.locator("#toggle").click();
    expect(await page.evaluate(() => globalThis.fixtureError)).toContain("NotFoundError");
  });

  test("protects a React/Next-style conditional text subtree", async ({ page }) => {
    await page.addInitScript({ content: genericGuardSource() });
    await runMutationFixture(page, "react-next.html", "#toggle", "#conditional-app > button");
  });

  test("the unprotected Radix-style fixture reproduces a translation DOM mismatch", async ({ page }) => {
    await page.goto(fixtureUrl("radix-select.html"));
    await page.evaluate(() => globalThis.applyTranslationMutation());
    await page.locator("#select-trigger").click();
    expect(await page.evaluate(() => globalThis.fixtureError)).toContain("NotFoundError");
  });

  test("protects a Radix-style select while leaving surrounding copy translatable", async ({ page }) => {
    await page.addInitScript({ content: genericGuardSource() });
    await runMutationFixture(
      page,
      "radix-select.html",
      "#select-trigger",
      "#select-options [role=option]"
    );
  });

  test("deduplicates recovery checks across repeated activation events", async ({ page }) => {
    const recoverySource = `${coreSource}
(() => {
  const runtime = globalThis[Symbol.for("search-translate-guard.runtime")];
  globalThis.recoveryCount = 0;
  runtime.registerAdapter({
    id: "recovery-fixture",
    matches: () => true,
    protection: { select: () => [] },
    recovery: {
      activationRules: [{ events: ["click"], selector: "#recover" }],
      delayMs: 50,
      isHealthy: () => false,
      recover: () => { globalThis.recoveryCount += 1; }
    }
  });
  runtime.start();
    })();`;
    await page.addInitScript({ content: recoverySource });
    await page.goto('data:text/html,<button id="recover" type="button">Recover</button>');
    await page.locator("#recover").click({ clickCount: 2, delay: 10 });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => globalThis.recoveryCount)).toBe(1);
  });

  test("activates an adapter registered after the core has started", async ({ page }) => {
    await page.addInitScript({ content: `${coreSource}\nglobalThis[Symbol.for("search-translate-guard.runtime")].start();` });
    await page.goto('data:text/html,<div class="late-target">Late component</div>');
    await page.evaluate(() => {
      const runtime = globalThis[Symbol.for("search-translate-guard.runtime")];
      runtime.registerAdapter({
        id: "late-adapter",
        matches: () => true,
        protection: {
          select: (root) => runtime.selectWithin(root, ".late-target")
        }
      });
    });
    await expect(page.locator(".late-target")).toHaveAttribute("translate", "no");
  });
});

test.describe("user-authorized site rules", () => {
  function siteGuardWithConfig(config, sendMessageBody = "callback?.({ ok: true, result: message.rule });") {
    return `
globalThis.__siteGuardListeners = [];
globalThis.__siteGuardStorageListeners = [];
globalThis.__siteGuardConfig = ${JSON.stringify(config)};
globalThis.chrome = {
  storage: {
    local: { get: async () => ({ siteGuardConfig: structuredClone(globalThis.__siteGuardConfig) }) },
    onChanged: { addListener: (listener) => globalThis.__siteGuardStorageListeners.push(listener) }
  },
  runtime: {
    lastError: null,
    sentMessages: [],
    sendMessage: (message, callback) => {
      globalThis.chrome.runtime.sentMessages.push(message);
      ${sendMessageBody}
    },
    onMessage: { addListener: (listener) => globalThis.__siteGuardListeners.push(listener) }
  }
};
globalThis.__deliverSiteGuardMessage = (message) => {
  for (const listener of globalThis.__siteGuardListeners) listener(message);
};
globalThis.__requestSiteGuardMessage = (message) => new Promise((resolve) => {
  for (const listener of globalThis.__siteGuardListeners) listener(message, {}, resolve);
});
globalThis.__setSiteGuardConfig = (nextConfig) => {
  const previous = globalThis.__siteGuardConfig;
  globalThis.__siteGuardConfig = structuredClone(nextConfig);
  for (const listener of globalThis.__siteGuardStorageListeners) {
    listener({ siteGuardConfig: { oldValue: previous, newValue: nextConfig } }, "local");
  }
};
${siteGeneratedSource}`;
  }

  test("applies stored rules to initial and dynamic components", async ({ page }) => {
    await page.addInitScript({
      content: siteGuardWithConfig({
        schemaVersion: 1,
        sites: {
          "file://": { enabled: true, rules: [{ selector: ".fixture-root" }] }
        }
      })
    });
    await page.goto(fixtureUrl("react-next.html"));
    await expect(page.locator(".fixture-root")).toHaveAttribute("translate", "no");

    await page.evaluate(() => {
      const dynamic = document.createElement("div");
      dynamic.className = "fixture-root";
      dynamic.id = "authorized-dynamic";
      document.body.append(dynamic);
    });
    await expect(page.locator("#authorized-dynamic")).toHaveAttribute("translate", "no");
  });

  test("updates and safely restores rules on the current page", async ({ page }) => {
    await page.addInitScript({
      content: siteGuardWithConfig({
        schemaVersion: 1,
        sites: { "file://": { enabled: true, rules: [] } }
      })
    });
    await page.goto(fixtureUrl("radix-select.html"));
    await page.evaluate(() => globalThis.__deliverSiteGuardMessage({
      type: "site-guard:rules-updated",
      origin: "file://",
      rules: [{ selector: ".fixture-root" }, { selector: "[invalid" }]
    }));
    await expect(page.locator(".fixture-root")).toHaveAttribute("translate", "no");
    await expect(page.locator(".fixture-root")).toHaveAttribute(
      "data-search-translate-guard-rule",
      "true"
    );

    await page.evaluate(() => globalThis.__deliverSiteGuardMessage({
      type: "site-guard:rules-updated",
      origin: "file://",
      rules: []
    }));
    await expect(page.locator(".fixture-root")).not.toHaveAttribute("translate", "no");
    await expect(page.locator(".fixture-root")).not.toHaveClass(/notranslate/);
    await expect(page.locator(".fixture-root")).not.toHaveAttribute(
      "data-search-translate-guard-rule",
      "true"
    );
  });

  test("reports rule health without exposing page text", async ({ page }) => {
    await page.addInitScript({
      content: siteGuardWithConfig({
        schemaVersion: 1,
        sites: {
          null: {
            enabled: true,
            rules: [
              {
                id: "healthy-rule",
                selector: "#healthy-search",
                fingerprint: { tag: "custom-search", role: "combobox", landmark: "main" }
              },
              {
                id: "ambiguous-rule",
                selector: "#old-dialog",
                fingerprint: { tag: "div", role: "dialog", landmark: "div" }
              },
              {
                id: "missing-rule",
                selector: "#old-menu",
                fingerprint: { tag: "custom-menu", role: "menu", landmark: "main" }
              },
              {
                id: "weak-rule",
                selector: "#old-button",
                fingerprint: { tag: "button", landmark: "main" }
              },
              { id: "invalid-rule", selector: "#", fingerprint: {} }
            ]
          }
        }
      })
    });
    await page.goto(`data:text/html,${encodeURIComponent(`
      <main>
        <custom-search id="healthy-search" role="combobox">Private search text</custom-search>
        <div id="dialog-one" role="dialog">Private dialog one</div>
        <div id="dialog-two" role="dialog">Private dialog two</div>
      </main>
    `)}`);

    await expect.poll(() => page.evaluate(() => (
      globalThis.__requestSiteGuardMessage({
        type: "site-guard:get-rule-health",
        origin: "null"
      })
    ))).toMatchObject({
      origin: "null",
      rules: [
        { id: "healthy-rule", state: "healthy" },
        { id: "ambiguous-rule", state: "ambiguous" },
        { id: "missing-rule", state: "missing" },
        { id: "weak-rule", state: "weak" },
        { id: "invalid-rule", state: "invalid" }
      ]
    });

    const snapshot = await page.evaluate(() => globalThis.__requestSiteGuardMessage({
      type: "site-guard:get-rule-health",
      origin: "null"
    }));
    expect(JSON.stringify(snapshot)).not.toContain("Private");
    expect(JSON.stringify(snapshot)).not.toContain("selector");
  });

  test("rebinds a stale selector only to one fingerprint match", async ({ page }) => {
    await page.addInitScript({
      content: siteGuardWithConfig({
        schemaVersion: 1,
        sites: {
          null: {
            enabled: true,
            rules: [{
              id: "drifted-rule",
              selector: "#old-search",
              fingerprint: { tag: "custom-search", role: "combobox", landmark: "main" }
            }]
          }
        }
      })
    });
    await page.goto(`data:text/html,${encodeURIComponent(`
      <button id="old-search" type="button">Wrong old target</button>
      <main><custom-search id="new-search" role="combobox"></custom-search></main>
    `)}`);

    await expect(page.locator("#new-search")).toHaveAttribute("translate", "no");
    await expect(page.locator("#old-search")).not.toHaveAttribute("translate", "no");
    const rebind = await page.evaluate(() => (
      globalThis.chrome.runtime.sentMessages.find((message) => message.type === "site-guard:rebind-rule")
    ));
    expect(rebind).toMatchObject({
      origin: "null",
      rule: {
        id: "drifted-rule",
        selector: "#new-search",
        fingerprint: { tag: "custom-search", role: "combobox", landmark: "main" }
      }
    });
  });

  test("refuses ambiguous or weak fingerprint rebinding", async ({ page }) => {
    await page.addInitScript({
      content: siteGuardWithConfig({
        schemaVersion: 1,
        sites: {
          null: {
            enabled: true,
            rules: [
              {
                id: "ambiguous-rule",
                selector: "#missing-dialog",
                fingerprint: { tag: "div", role: "dialog", landmark: "main" }
              },
              {
                id: "weak-rule",
                selector: "#missing-button",
                fingerprint: { tag: "button", landmark: "main" }
              }
            ]
          }
        }
      })
    });
    await page.goto(`data:text/html,${encodeURIComponent(`
      <main>
        <div id="dialog-one" role="dialog"></div>
        <div id="dialog-two" role="dialog"></div>
        <button id="possible-button" type="button">Possible</button>
      </main>
    `)}`);
    await page.waitForTimeout(150);

    await expect(page.locator("#dialog-one")).not.toHaveAttribute("translate", "no");
    await expect(page.locator("#dialog-two")).not.toHaveAttribute("translate", "no");
    await expect(page.locator("#possible-button")).not.toHaveAttribute("translate", "no");
    expect(await page.evaluate(() => globalThis.chrome.runtime.sentMessages)).toEqual([]);
  });

  test("waits for a drift candidate to remain unique before rebinding", async ({ page }) => {
    await page.addInitScript({
      content: siteGuardWithConfig({
        schemaVersion: 1,
        sites: {
          null: {
            enabled: true,
            rules: [{
              id: "late-duplicate-rule",
              selector: "#removed-dialog",
              fingerprint: { tag: "div", role: "dialog", landmark: "main" }
            }]
          }
        }
      })
    });
    await page.goto(`data:text/html,${encodeURIComponent(`
      <main><div id="early-dialog" role="dialog"></div></main>
    `)}`);
    await page.evaluate(() => {
      setTimeout(() => {
        const duplicate = document.createElement("div");
        duplicate.id = "late-dialog";
        duplicate.setAttribute("role", "dialog");
        document.querySelector("main").append(duplicate);
      }, 100);
    });
    await expect(page.locator("#late-dialog")).toHaveCount(1);
    await page.waitForTimeout(350);

    await expect(page.locator("#early-dialog")).not.toHaveAttribute("translate", "no");
    await expect(page.locator("#late-dialog")).not.toHaveAttribute("translate", "no");
    expect(await page.evaluate(() => globalThis.chrome.runtime.sentMessages)).toEqual([]);
  });

  test("restarts the stability window after transient ambiguity", async ({ page }) => {
    await page.addInitScript({
      content: siteGuardWithConfig({
        schemaVersion: 1,
        sites: {
          null: {
            enabled: true,
            rules: [{
              id: "interrupted-rule",
              selector: "#removed-menu",
              fingerprint: { tag: "custom-menu", role: "menu", landmark: "main" }
            }]
          }
        }
      })
    });
    await page.goto(`data:text/html,${encodeURIComponent(`
      <main><custom-menu id="stable-menu" role="menu"></custom-menu></main>
    `)}`);
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      const duplicate = document.createElement("custom-menu");
      duplicate.id = "temporary-menu";
      duplicate.setAttribute("role", "menu");
      document.querySelector("main").append(duplicate);
    });
    await page.waitForTimeout(50);
    await page.locator("#temporary-menu").evaluate((element) => element.remove());
    await page.waitForTimeout(180);

    await expect(page.locator("#stable-menu")).not.toHaveAttribute("translate", "no");
    expect(await page.evaluate(() => globalThis.chrome.runtime.sentMessages)).toEqual([]);

    await expect(page.locator("#stable-menu")).toHaveAttribute("translate", "no");
    await expect.poll(() => page.evaluate(() => (
      globalThis.chrome.runtime.sentMessages.some((message) => (
        message.type === "site-guard:rebind-rule" && message.rule.selector === "#stable-menu"
      ))
    ))).toBe(true);
  });

  test("rechecks a rule after attribute-only selector drift", async ({ page }) => {
    await page.addInitScript({
      content: siteGuardWithConfig({
        schemaVersion: 1,
        sites: {
          null: {
            enabled: true,
            rules: [{
              id: "renamed-rule",
              selector: "#original-control",
              fingerprint: { tag: "custom-search", role: "combobox", landmark: "main" }
            }]
          }
        }
      })
    });
    await page.goto(`data:text/html,${encodeURIComponent(`
      <main><custom-search id="original-control" role="combobox"></custom-search></main>
    `)}`);
    await expect(page.locator("#original-control")).toHaveAttribute("translate", "no");
    await page.locator("#original-control").evaluate((element) => {
      element.id = "renamed-control";
    });

    await expect.poll(() => page.evaluate(() => (
      globalThis.chrome.runtime.sentMessages.some((message) => (
        message.type === "site-guard:rebind-rule" && message.rule.selector === "#renamed-control"
      ))
    ))).toBe(true);
    await expect(page.locator("#renamed-control")).toHaveAttribute("translate", "no");
  });

  test("rechecks ambiguity after a duplicate is removed", async ({ page }) => {
    await page.addInitScript({
      content: siteGuardWithConfig({
        schemaVersion: 1,
        sites: {
          null: {
            enabled: true,
            rules: [{
              id: "removed-duplicate-rule",
              selector: "#missing-listbox",
              fingerprint: { tag: "div", role: "listbox", landmark: "main" }
            }]
          }
        }
      })
    });
    await page.goto(`data:text/html,${encodeURIComponent(`
      <main>
        <div id="remaining-listbox" role="listbox"></div>
        <div id="removed-listbox" role="listbox"></div>
      </main>
    `)}`);
    await page.waitForTimeout(350);
    expect(await page.evaluate(() => globalThis.chrome.runtime.sentMessages)).toEqual([]);
    await page.locator("#removed-listbox").evaluate((element) => element.remove());

    await expect(page.locator("#remaining-listbox")).toHaveAttribute("translate", "no");
    await expect.poll(() => page.evaluate(() => (
      globalThis.chrome.runtime.sentMessages.some((message) => (
        message.type === "site-guard:rebind-rule" &&
        message.rule.selector === "#remaining-listbox"
      ))
    ))).toBe(true);
  });

  test("rebinds a uniquely matching component inserted after load", async ({ page }) => {
    await page.addInitScript({
      content: siteGuardWithConfig({
        schemaVersion: 1,
        sites: {
          null: {
            enabled: true,
            rules: [{
              id: "dynamic-rule",
              selector: "#removed-select",
              fingerprint: { tag: "custom-select", role: "listbox", landmark: "main" }
            }]
          }
        }
      })
    });
    await page.goto(`data:text/html,${encodeURIComponent("<main id=app></main>")}`);
    await page.evaluate(() => {
      const element = document.createElement("custom-select");
      element.id = "replacement-select";
      element.setAttribute("role", "listbox");
      document.querySelector("#app").append(element);
    });

    await expect(page.locator("#replacement-select")).toHaveAttribute("translate", "no");
    await expect.poll(() => page.evaluate(() => (
      globalThis.chrome.runtime.sentMessages.some((message) => (
        message.type === "site-guard:rebind-rule" &&
        message.rule.selector === "#replacement-select"
      ))
    ))).toBe(true);
  });

  test("retries a transient selector rebind failure", async ({ page }) => {
    await page.addInitScript({
      content: siteGuardWithConfig({
        schemaVersion: 1,
        sites: {
          null: {
            enabled: true,
            rules: [{
              id: "retry-rule",
              selector: "#removed-search",
              fingerprint: { tag: "custom-search", role: "combobox", landmark: "main" }
            }]
          }
        }
      }, `
        globalThis.__rebindAttempts ||= 0;
        if (message.type === "site-guard:rebind-rule") globalThis.__rebindAttempts += 1;
        callback?.(globalThis.__rebindAttempts === 1
          ? { ok: false, error: "service worker restarted" }
          : { ok: true, result: message.rule });
      `)
    });
    await page.goto(`data:text/html,${encodeURIComponent(`
      <main><custom-search id="replacement-search" role="combobox"></custom-search></main>
    `)}`);

    await expect.poll(() => page.evaluate(() => globalThis.__rebindAttempts), {
      timeout: 3_000
    }).toBeGreaterThanOrEqual(2);
    await expect(page.locator("#replacement-search")).toHaveAttribute("translate", "no");
  });

  test("bounds repeated selector rebind failures", async ({ page }) => {
    await page.clock.install();
    await page.addInitScript({
      content: siteGuardWithConfig({
        schemaVersion: 1,
        sites: {
          null: {
            enabled: true,
            rules: [{
              id: "bounded-retry-rule",
              selector: "#removed-search",
              fingerprint: { tag: "custom-search", role: "combobox", landmark: "main" }
            }]
          }
        }
      }, `
        if (message.type === "site-guard:rebind-rule") {
          globalThis.__rebindAttempts = (globalThis.__rebindAttempts || 0) + 1;
        }
        callback?.({ ok: false, error: "service worker unavailable" });
      `)
    });
    await page.goto(`data:text/html,${encodeURIComponent(`
      <main><custom-search id="replacement-search" role="combobox"></custom-search></main>
    `)}`);

    await expect.poll(() => page.evaluate(() => (
      globalThis.__requestSiteGuardMessage({
        type: "site-guard:get-rule-health",
        origin: "null"
      }).then((snapshot) => snapshot.rules.length)
    ))).toBe(1);
    await page.clock.runFor(20_000);
    expect(await page.evaluate(() => globalThis.__rebindAttempts)).toBe(4);
    await page.clock.runFor(60_000);
    expect(await page.evaluate(() => globalThis.__rebindAttempts)).toBe(4);
  });

  test("ranks an observed interactive text rewrite without recording page text", async ({ page }) => {
    await page.addInitScript({
      content: siteGuardWithConfig({
        schemaVersion: 1,
        sites: { null: { enabled: true, rules: [] } }
      })
    });
    await page.goto(`data:text/html,${encodeURIComponent(`
      <main>
        <button id="observed-button" type="button">Private account action</button>
        <p id="passive-copy">Private article paragraph</p>
      </main>
    `)}`);
    await page.evaluate(() => {
      for (const selector of ["#passive-copy", "#observed-button"]) {
        const element = document.querySelector(selector);
        const original = element.firstChild;
        const wrapper = document.createElement("font");
        wrapper.append(original.cloneNode(true));
        element.removeChild(original);
        element.append(wrapper);
      }
    });

    await expect.poll(() => page.evaluate(() => (
      globalThis[Symbol.for("search-translate-guard.mutation-risk-observer")].count()
    ))).toBe(1);
    const observed = await page.evaluate(() => (
      globalThis[Symbol.for("search-translate-guard.mutation-risk-observer")]
        .candidates()
        .map(({ element, score, reasons, occurrences }) => ({
          id: element.id,
          score,
          reasons,
          occurrences
        }))
    ));
    expect(observed).toEqual([{
      id: "observed-button",
      score: expect.any(Number),
      reasons: expect.arrayContaining(["observed-text-rewrite"]),
      occurrences: 1
    }]);
    expect(JSON.stringify(observed)).not.toContain("Private");

    const health = await page.evaluate(() => globalThis.__requestSiteGuardMessage({
      type: "site-guard:get-rule-health",
      origin: "null"
    }));
    expect(health.observedRiskCount).toBe(1);
    expect(JSON.stringify(health)).not.toContain("Private");

    await page.addScriptTag({ content: pickerSource });
    const picker = page.locator("#search-translate-guard-picker");
    await expect(picker.locator(".status")).toContainText("Recent DOM text rewriting was observed");
    await expect(picker.locator(".selector")).toHaveText("#observed-button");
    await picker.locator("button.protect").click();
    const payload = await page.evaluate(() => globalThis.chrome.runtime.sentMessages.find(
      (message) => message.type === "site-guard:add-rule"
    ));
    expect(payload.rule.selector).toBe("#observed-button");
    expect(JSON.stringify(payload)).not.toContain("Private account action");

    await page.evaluate(() => globalThis.__setSiteGuardConfig({
      schemaVersion: 1,
      sites: { null: { enabled: false, rules: [] } }
    }));
    await expect.poll(() => page.evaluate(() => (
      globalThis[Symbol.for("search-translate-guard.mutation-risk-observer")].count()
    ))).toBe(0);
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.id = "after-disable";
      button.append("Private post-disable text");
      document.body.append(button);
      const original = button.firstChild;
      const wrapper = document.createElement("font");
      wrapper.append(original.cloneNode(true));
      button.replaceChild(wrapper, original);
    });
    await page.waitForTimeout(50);
    expect(await page.evaluate(() => (
      globalThis[Symbol.for("search-translate-guard.mutation-risk-observer")].count()
    ))).toBe(0);
  });

  test("bounds and expires observed risks while ignoring protected components", async ({ page }) => {
    await page.clock.install();
    await page.addInitScript({
      content: siteGuardWithConfig({
        schemaVersion: 1,
        sites: { null: { enabled: true, rules: [] } }
      })
    });
    const buttons = Array.from({ length: 30 }, (_, index) => (
      `<button id="risk-${index}" type="button">Private ${index}</button>`
    )).join("");
    await page.goto(`data:text/html,${encodeURIComponent(`
      <main>
        ${buttons}
        <button id="protected" translate="no">Protected private text</button>
      </main>
    `)}`);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll("button")) {
        const original = element.firstChild;
        const wrapper = document.createElement("span");
        wrapper.append(original.cloneNode(true));
        element.replaceChild(wrapper, original);
      }
    });

    const observerSymbol = "search-translate-guard.mutation-risk-observer";
    await expect.poll(() => page.evaluate((symbol) => (
      globalThis[Symbol.for(symbol)].count()
    ), observerSymbol)).toBe(24);
    const ids = await page.evaluate((symbol) => (
      globalThis[Symbol.for(symbol)].candidates().map(({ element }) => element.id)
    ), observerSymbol);
    expect(ids).not.toContain("protected");

    await page.clock.runFor((15 * 60 * 1_000) + 1);
    expect(await page.evaluate((symbol) => (
      globalThis[Symbol.for(symbol)].count()
    ), observerSymbol)).toBe(0);
  });
});

test.describe("risk detector", () => {
  test("ranks structural interaction signals without reading text or field values", async ({ page }) => {
    await page.goto(`data:text/html,${encodeURIComponent(`
      <p>Private article words</p>
      <custom-search id="risky-search" role="combobox" aria-expanded="false" aria-controls="results">
        <input value="private query">
      </custom-search>
      <relative-time id="passive-custom">2026-07-11</relative-time>
      <button id="plain-button" type="button">Ordinary action</button>
    `)}`);
    await page.addScriptTag({ content: riskDetectorSource });

    const result = await page.evaluate(() => {
      const detector = globalThis[Symbol.for("search-translate-guard.risk-detector")];
      return detector.detect(document).map(({ element, score, reasons }) => ({
        id: element.id,
        score,
        reasons
      }));
    });

    expect(result[0]).toMatchObject({
      id: "risky-search",
      reasons: expect.arrayContaining(["custom-element", "composite-role", "aria-expanded"])
    });
    expect(result.some((candidate) => candidate.id === "plain-button")).toBe(false);
    expect(result.some((candidate) => candidate.id === "passive-custom")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("Private article words");
    expect(JSON.stringify(result)).not.toContain("private query");
  });
});

test.describe("component picker", () => {
  test("captures a structural selector without activating the page or storing visible text", async ({ page }) => {
    await page.addInitScript({ content: `
globalThis.pickerMessages = [];
globalThis.chrome = {
  i18n: { getMessage: () => "" },
  runtime: {
    lastError: null,
    sendMessage: (message, callback) => {
      globalThis.pickerMessages.push(message);
      callback({ ok: true, result: { ruleCount: 1 } });
    }
  }
};` });
    await page.goto(`data:text/html,${encodeURIComponent(`
      <custom-search id="search-component" role="combobox">
        <button id="search-trigger" type="button">Private visible search words</button>
      </custom-search>
      <script>
        globalThis.pageClickCount = 0;
        document.querySelector("#search-trigger").addEventListener("click", () => {
          globalThis.pageClickCount += 1;
        });
      </script>
    `)}`);
    await page.addScriptTag({ content: riskDetectorSource });
    await page.addScriptTag({ content: selectorToolsSource });
    await page.addScriptTag({ content: pickerSource });

    await expect(page.locator("#search-translate-guard-picker button.manual")).toBeVisible();
    await page.locator("#search-translate-guard-picker button.manual").click();
    await page.locator("#search-trigger").hover();
    await page.locator("#search-trigger").click();
    await page.locator("#search-translate-guard-picker button.protect").click();

    await expect(page.locator("#search-component")).toHaveAttribute("translate", "no");
    expect(await page.evaluate(() => globalThis.pageClickCount)).toBe(0);
    const payload = await page.evaluate(() => globalThis.pickerMessages[0]);
    expect(payload).toMatchObject({
      type: "site-guard:add-rule",
      rule: {
        selector: "#search-component",
        fingerprint: { tag: "custom-search", role: "combobox" }
      }
    });
    expect(JSON.stringify(payload)).not.toContain("Private visible search words");
  });

  test("offers ranked high-risk boundaries while keeping confirmation local", async ({ page }) => {
    await page.addInitScript({ content: `
globalThis.pickerMessages = [];
globalThis.chrome = {
  i18n: { getMessage: () => "" },
  runtime: {
    lastError: null,
    sendMessage: (message, callback) => {
      globalThis.pickerMessages.push(message);
      callback({ ok: true, result: { ruleCount: 1 } });
    }
  }
};` });
    await page.goto(`data:text/html,${encodeURIComponent(`
      <main>
        <custom-select id="first-risk" role="combobox" aria-expanded="false" style="display:block;width:120px;height:36px"></custom-select>
        <div id="second-risk" role="dialog" style="width:120px;height:36px"></div>
        <p>Outside private copy</p>
      </main>
    `)}`);
    await page.addScriptTag({ content: riskDetectorSource });
    await page.addScriptTag({ content: selectorToolsSource });
    await page.addScriptTag({ content: pickerSource });

    const picker = page.locator("#search-translate-guard-picker");
    await expect(picker.locator(".status")).toContainText("Suggested high-risk component 1 of 2");
    await expect(picker.locator(".selector")).toContainText("#first-risk");
    await picker.locator("button.next").click();
    await expect(picker.locator(".selector")).toContainText("#second-risk");
    await picker.locator("button.protect").click();

    const payload = await page.evaluate(() => globalThis.pickerMessages[0]);
    expect(payload).toMatchObject({
      type: "site-guard:add-rule",
      rule: {
        selector: "#second-risk",
        fingerprint: { tag: "div", role: "dialog" }
      }
    });
    expect(JSON.stringify(payload)).not.toContain("Outside private copy");
  });

  test("explicitly replaces one unresolved rule without storing visible text", async ({ page }) => {
    await page.addInitScript({ content: `
globalThis.pickerMessages = [];
globalThis.chrome = {
  i18n: { getMessage: () => "" },
  runtime: {
    lastError: null,
    sendMessage: (message, callback) => {
      globalThis.pickerMessages.push(message);
      callback({ ok: true, result: message.rule });
    }
  }
};` });
    await page.goto(`data:text/html,${encodeURIComponent(`
      <custom-dialog id="replacement-dialog" role="dialog">
        Private account confirmation
      </custom-dialog>
    `)}`);
    await page.evaluate(() => {
      globalThis[Symbol.for("search-translate-guard.component-picker-request")] = {
        ruleId: "unresolved-rule"
      };
    });
    await page.addScriptTag({ content: riskDetectorSource });
    await page.addScriptTag({ content: selectorToolsSource });
    await page.addScriptTag({ content: pickerSource });

    const picker = page.locator("#search-translate-guard-picker");
    await expect(picker.locator("button.protect")).toHaveText("Repair component rule");
    await picker.locator("button.protect").click();

    const payload = await page.evaluate(() => globalThis.pickerMessages[0]);
    expect(payload).toMatchObject({
      type: "site-guard:replace-rule",
      rule: {
        id: "unresolved-rule",
        selector: "#replacement-dialog",
        fingerprint: { tag: "custom-dialog", role: "dialog" }
      }
    });
    expect(JSON.stringify(payload)).not.toContain("Private account confirmation");
  });
});

test.describe("GitHub authenticated header regression", () => {
  test("reproduces the translated React trigger disappearing without protection", async ({ page }) => {
    await page.route("https://github.com/**", (route) => route.fulfill({
      contentType: "text/html",
      body: authenticatedGitHubFixture
    }));
    await page.goto("https://github.com/example/authenticated");

    await page.evaluate(() => globalThis.applyTranslationMutation());
    await page.locator("#authenticated-search-trigger").click();

    expect(await page.evaluate(() => globalThis.githubFixtureError)).toContain("NotFoundError");
    await expect(page.locator("#authenticated-search-trigger")).toHaveCount(0);

    await page.setViewportSize({ width: 600, height: 800 });
    const compactTrigger = page.locator("#authenticated-compact-search-trigger");
    await expect(compactTrigger).toBeVisible();
    await page.evaluate(() => {
      globalThis.githubFixtureError = null;
    });
    await compactTrigger.click();

    expect(await page.evaluate(() => globalThis.githubFixtureError)).toContain("NotFoundError");
    await expect(compactTrigger).toBeVisible();
    await expect(page.locator("#authenticated-live-search")).not.toHaveClass(/expanded/);
  });
});

test.describe("GitHub adapter", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript({ content: generatedSource });
    await page.route("https://github.com/**", async (route) => {
      const requestUrl = new URL(route.request().url());
      await route.fulfill({
        contentType: "text/html",
        body: requestUrl.pathname.endsWith("/authenticated")
          ? authenticatedGitHubFixture
          : `<!doctype html>
          <html><body>
            <qbsearch-input
              data-scope="repo:silentmeowing/Search-Translate-Guard-for-GitHub"
              data-header-redesign-enabled="false"
              data-logged-in="false"
            >
              <button type="button" data-target="qbsearch-input.inputButton">Search</button>
              <input id="query-builder-test" role="combobox" style="width: 240px; height: 32px">
            </qbsearch-input>
            <textarea id="editor"></textarea>
          </body></html>`
      });
    });
  });

  test("protects initial, dynamic, and Turbo pre-render search roots", async ({ page }) => {
    await page.goto("https://github.com/example/repository");
    await expect(page.locator("qbsearch-input")).toHaveAttribute("translate", "no");

    await page.evaluate(() => {
      const dynamic = document.createElement("qbsearch-input");
      dynamic.id = "dynamic-search";
      document.body.append(dynamic);
    });
    await expect(page.locator("#dynamic-search")).toHaveAttribute("translate", "no");

    const protectedBeforeAttachment = await page.evaluate(() => {
      const nextBody = document.createElement("body");
      const search = document.createElement("qbsearch-input");
      nextBody.append(search);
      document.dispatchEvent(new CustomEvent("turbo:before-render", {
        detail: { newBody: nextBody }
      }));
      return search.getAttribute("translate");
    });
    expect(protectedBeforeAttachment).toBe("no");
  });

  test("protects the authenticated React trigger and keeps native search healthy", async ({ page }) => {
    await page.goto("https://github.com/example/authenticated");
    const trigger = page.locator("#authenticated-search-trigger");

    await expect(trigger).toHaveAttribute("translate", "no");
    await expect(trigger).toHaveClass(/notranslate/);
    await expect(page.locator("qbsearch-input")).toHaveCount(2);
    expect(await page.locator("qbsearch-input").evaluateAll((elements) => (
      elements.map((element) => element.getAttribute("translate"))
    ))).toEqual(["no", "no"]);

    await page.evaluate(() => globalThis.applyTranslationMutation());
    await expect(page.locator("#outside-copy font[data-translated]")).toHaveCount(1);
    await expect(trigger.locator("font[data-translated]")).toHaveCount(0);

    await trigger.click();
    expect(await page.evaluate(() => globalThis.githubFixtureError)).toBeNull();
    await expect(trigger).toHaveCount(1);
    await expect(page.locator("#authenticated-live-search")).toHaveClass(/expanded/);
    await page.waitForTimeout(650);
    await expect(page.locator("#github-search-translate-guard")).toHaveCount(0);
  });

  test("uses the compatibility search when the authenticated trigger remains unhealthy", async ({ page }) => {
    await page.goto("https://github.com/example/authenticated");
    await page.evaluate(() => {
      globalThis.githubFixtureForceFailure = true;
    });
    await page.locator("#authenticated-search-trigger").click();

    const fallback = page.locator("#github-search-translate-guard");
    await expect(fallback.locator("input")).toBeVisible({ timeout: 1_500 });
    await expect(fallback.locator("input")).toHaveValue(
      "repo:silentmeowing/Search-Translate-Guard-for-GitHub "
    );
  });

  test("protects the compact responsive trigger and recovers when it is inert", async ({ page }) => {
    await page.goto("https://github.com/example/authenticated");
    await page.setViewportSize({ width: 600, height: 800 });
    const compactTrigger = page.locator("#authenticated-compact-search-trigger");

    await expect(compactTrigger).toBeVisible();
    await expect(compactTrigger).toHaveAttribute("translate", "no");
    await expect(compactTrigger).toHaveClass(/notranslate/);

    await page.evaluate(() => {
      globalThis.applyTranslationMutation();
      globalThis.githubFixtureForceFailure = true;
    });
    await expect(page.locator("#outside-copy font[data-translated]")).toHaveCount(1);
    await compactTrigger.click();

    const fallback = page.locator("#github-search-translate-guard");
    await expect(fallback.locator("input")).toBeVisible({ timeout: 1_500 });
    await expect(fallback.locator("input")).toHaveValue(
      "repo:silentmeowing/Search-Translate-Guard-for-GitHub "
    );
  });

  test("keeps a healthy native search and ignores slash inside editable fields", async ({ page }) => {
    await page.goto("https://github.com/example/repository");
    await page.locator("qbsearch-input").evaluate((element) => element.classList.add("expanded"));
    await page.locator('[data-target="qbsearch-input.inputButton"]').click();
    await page.waitForTimeout(650);
    await expect(page.locator("#github-search-translate-guard")).toHaveCount(0);

    await page.locator("#editor").focus();
    await page.locator("#editor").press("/");
    await page.waitForTimeout(650);
    await expect(page.locator("#github-search-translate-guard")).toHaveCount(0);
  });

  test("opens the scoped fallback only when native search is unhealthy", async ({ page }) => {
    await page.goto("https://github.com/example/repository");
    await page.locator('[data-target="qbsearch-input.inputButton"]').click();

    const fallback = page.locator("#github-search-translate-guard");
    await expect(fallback.locator("input")).toBeVisible({ timeout: 1_500 });
    expect(await fallback.evaluate((element) => element.hidden)).toBe(false);
    await expect(fallback.locator("input")).toHaveValue(
      "repo:silentmeowing/Search-Translate-Guard-for-GitHub "
    );

    await fallback.locator("input").press("Escape");
    await expect(fallback).toBeHidden();
  });

  test("reapplies protection after a reload and in a second tab", async ({ page, context }) => {
    await page.goto("https://github.com/example/repository");
    await page.reload();
    await expect(page.locator("qbsearch-input")).toHaveAttribute("translate", "no");

    const secondPage = await context.newPage();
    await secondPage.addInitScript({ content: generatedSource });
    await secondPage.route("https://github.com/**", (route) => route.fulfill({
      contentType: "text/html",
      body: "<qbsearch-input id=second-tab></qbsearch-input>"
    }));
    await secondPage.goto("https://github.com/another/repository");
    await expect(secondPage.locator("#second-tab")).toHaveAttribute("translate", "no");
  });
});
