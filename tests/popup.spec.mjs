import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");
const popupUrl = pathToFileURL(path.join(root, "popup", "popup.html")).href;

test.describe("site guard popup", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      globalThis.__popupMessages = [];
      globalThis.__scriptExecutions = [];
      globalThis.__popupStatus = {
        origin: "https://example.com",
        builtIn: false,
        permissionGranted: true,
        enabled: true,
        ruleCount: 2,
        observedRiskCount: 2,
        rules: [
          { id: "healthy-rule", selector: "#search", state: "healthy" },
          { id: "missing-rule", selector: "main > custom-menu", state: "missing" }
        ]
      };
      globalThis.confirm = () => true;
      globalThis.chrome = {
        i18n: { getMessage: () => "" },
        tabs: {
          query(_query, callback) {
            callback([{ id: 42, url: "https://example.com/app" }]);
          }
        },
        runtime: {
          lastError: null,
          sendMessage(message, callback) {
            globalThis.__popupMessages.push(structuredClone(message));
            if (message.type === "site-guard:remove-rule") {
              globalThis.__popupStatus.rules = globalThis.__popupStatus.rules.filter(
                (rule) => rule.id !== message.ruleId
              );
              globalThis.__popupStatus.ruleCount = globalThis.__popupStatus.rules.length;
            }
            callback({ ok: true, result: structuredClone(globalThis.__popupStatus) });
          }
        },
        scripting: {
          executeScript(options, callback) {
            globalThis.__scriptExecutions.push({
              args: options.args || [],
              files: options.files || [],
              hasFunction: typeof options.func === "function"
            });
            callback([]);
          }
        },
        permissions: {
          request(_request, callback) { callback(true); },
          remove(_request, callback) { callback(true); }
        }
      };
    });
    await page.goto(popupUrl);
  });

  test("renders local rule health and removes only the selected rule", async ({ page }) => {
    await expect(page.locator("#observed")).toHaveText(
      "2 recent risky DOM rewrite(s) were observed. Review suggested components."
    );
    await expect(page.locator("#health-summary")).toHaveText("1 rule(s) need attention.");
    await expect(page.locator(".rule-item")).toHaveCount(2);
    await expect(page.locator(".rule-state[data-state=missing]")).toHaveText(
      "No matching component was found."
    );

    await page.locator('button[data-action="remove"][data-rule-id="missing-rule"]').click();
    await expect(page.locator(".rule-item")).toHaveCount(1);
    await expect(page.locator("#health-summary")).toHaveText(
      "All component rules are active on this page."
    );

    const removal = await page.evaluate(() => globalThis.__popupMessages.find(
      (message) => message.type === "site-guard:remove-rule"
    ));
    expect(removal).toEqual({
      type: "site-guard:remove-rule",
      origin: "https://example.com",
      ruleId: "missing-rule",
      tabId: 42
    });
  });

  test("starts a targeted repair picker for the selected rule", async ({ page }) => {
    await page.locator('button[data-action="repair"][data-rule-id="missing-rule"]').click();
    await expect.poll(() => page.evaluate(() => globalThis.__scriptExecutions.length)).toBe(2);
    const executions = await page.evaluate(() => globalThis.__scriptExecutions);
    expect(executions).toEqual([
      { args: ["missing-rule"], files: [], hasFunction: true },
      {
        args: [],
        files: ["src/risk-detector.js", "src/selector-tools.js", "src/picker.js"],
        hasFunction: false
      }
    ]);
  });
});
