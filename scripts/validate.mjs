import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const readJson = (relativePath) => JSON.parse(
  fs.readFileSync(path.join(root, relativePath), "utf8")
);
const fail = (message) => {
  console.error(`ERROR: ${message}`);
  process.exitCode = 1;
};

const manifest = readJson("manifest.json");

if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) fail("invalid extension version");
if (!manifest.default_locale) fail("default_locale is required for localized metadata");
if (manifest.permissions?.length) fail("unexpected browser API permissions");
if (manifest.host_permissions?.length) fail("unexpected host_permissions");
if (manifest.update_url) fail("store package must not define update_url");
if (manifest.key) fail("store package must not include a development key");

const defaultMessages = readJson(`_locales/${manifest.default_locale}/messages.json`);
const resolveMessage = (value) => {
  const match = /^__MSG_(.+)__$/.exec(value);
  return match ? defaultMessages[match[1]]?.message : value;
};
const name = resolveMessage(manifest.name);
const description = resolveMessage(manifest.description);

if (!name || [...name].length > 75) fail("resolved name is missing or exceeds 75 characters");
if (!description || [...description].length > 132) fail("resolved description is missing or exceeds 132 characters");

const requiredFiles = new Set(["manifest.json"]);
for (const script of manifest.content_scripts ?? []) {
  for (const file of script.js ?? []) requiredFiles.add(file);
}
for (const file of Object.values(manifest.icons ?? {})) requiredFiles.add(file);
for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) fail(`missing referenced file: ${file}`);
}

for (const locale of ["en", "zh_CN"]) {
  const messages = readJson(`_locales/${locale}/messages.json`);
  for (const key of ["extensionName", "extensionDescription", "fallbackTitle", "fallbackNotice", "fallbackInputLabel", "searchButton", "fallbackHint"]) {
    if (!messages[key]?.message) fail(`missing ${key} in locale ${locale}`);
  }
}

const scriptPath = manifest.content_scripts?.[0]?.js?.[0];
if (scriptPath) {
  const source = fs.readFileSync(path.join(root, scriptPath), "utf8");
  const forbidden = [
    /\beval\s*\(/,
    /new\s+Function\b/,
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /import\s*\(/
  ];
  for (const pattern of forbidden) {
    if (pattern.test(source)) fail(`forbidden remote/dynamic code pattern: ${pattern}`);
  }
}

if (!process.exitCode) {
  console.log(`Validated ${name} v${manifest.version}`);
  console.log(`Default locale: ${manifest.default_locale}; site scope: ${manifest.content_scripts[0].matches.join(", ")}`);
}
