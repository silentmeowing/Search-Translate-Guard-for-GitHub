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
});

test.describe("GitHub adapter", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript({ content: generatedSource });
    await page.route("https://github.com/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html>
          <html><body>
            <qbsearch-input data-scope="repo:silentmeowing/Search-Translate-Guard-for-GitHub">
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
