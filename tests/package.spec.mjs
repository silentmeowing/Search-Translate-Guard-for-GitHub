import fs from "node:fs";
import path from "node:path";
import { chromium, expect, test } from "@playwright/test";
import {
  buildExtensionPackage,
  createZip,
  extensionFiles,
  inspectZip,
  verifyExtensionPackage
} from "../scripts/package.mjs";

test("installable ZIP exposes manifest.json at its root", () => {
  const archive = buildExtensionPackage();
  const entries = verifyExtensionPackage(archive);

  expect(entries.has("manifest.json")).toBe(true);
  expect([...entries.keys()].sort()).toEqual(extensionFiles);
});

test("installable ZIP output is deterministic", () => {
  expect(buildExtensionPackage()).toEqual(buildExtensionPackage());
});

test("wrapped repository archives are rejected as extension packages", () => {
  const wrapped = createZip([
    { name: "Search-Translate-Guard-for-GitHub/manifest.json", content: "{}" }
  ]);

  expect(() => verifyExtensionPackage(wrapped)).toThrow(
    "manifest.json must be at the ZIP root"
  );
  expect(inspectZip(wrapped).has("Search-Translate-Guard-for-GitHub/manifest.json")).toBe(true);
});

test("installable ZIP loads as a complete Manifest V3 extension", async ({}, testInfo) => {
  const entries = verifyExtensionPackage(buildExtensionPackage());
  const packagedManifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
  const unpacked = testInfo.outputPath("unpacked-extension");
  for (const [name, content] of entries) {
    const destination = path.join(unpacked, ...name.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }

  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${unpacked}`,
      `--load-extension=${unpacked}`
    ]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const loadedManifest = await worker.evaluate(() => chrome.runtime.getManifest());
    expect(loadedManifest).toMatchObject({
      manifest_version: 3,
      version: packagedManifest.version
    });
  } finally {
    await context.close();
  }
});
