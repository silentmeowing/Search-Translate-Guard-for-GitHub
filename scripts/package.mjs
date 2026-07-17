import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const outputName = `Search-Translate-Guard-for-GitHub-extension-v${manifest.version}.zip`;
const outputPath = path.join(root, "dist", outputName);
const ZIP_VERSION = 20;
const UTF8_FLAG = 0x0800;
const DEFLATE_METHOD = 8;
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 33; // 1980-01-01, the earliest date supported by ZIP.

const localeFiles = fs.readdirSync(path.join(root, "_locales"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `_locales/${entry.name}/messages.json`);

const extensionFiles = [...new Set([
  "manifest.json",
  ...Object.values(manifest.icons ?? {}),
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...(manifest.content_scripts ?? []).flatMap((script) => [
    ...(script.js ?? []),
    ...(script.css ?? [])
  ]),
  ...localeFiles,
  "Site-Translate-Guard.content.js",
  "popup/popup.css",
  "popup/popup.js",
  "src/composed-tree.js",
  "src/risk-detector.js",
  "src/selector-tools.js",
  "src/picker.js"
].filter(Boolean))].sort();

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  crcTable[index] = value >>> 0;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function assertSafeEntryName(name) {
  const segments = name.split("/");
  if (
    !name ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[a-z]:/i.test(name) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`unsafe ZIP entry name: ${name}`);
  }
}

function sourceFile(name) {
  assertSafeEntryName(name);
  const resolved = path.resolve(root, ...name.split("/"));
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`package file escapes the repository: ${name}`);
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`package entry must be a regular file: ${name}`);
  }
  const content = fs.readFileSync(resolved);
  if (path.posix.extname(name) === ".png") return content;
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content)) {
    throw new Error(`package text file is not valid UTF-8: ${name}`);
  }
  return Buffer.from(text.replace(/\r\n?/g, "\n"), "utf8");
}

function createZip(entries) {
  if (!entries.length || entries.length > 0xffff) throw new Error("invalid ZIP entry count");
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    assertSafeEntryName(entry.name);
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content);
    const compressed = zlib.deflateRawSync(content, { level: 9 });
    const checksum = crc32(content);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(ZIP_VERSION, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(DEFLATE_METHOD, 8);
    localHeader.writeUInt16LE(FIXED_DOS_TIME, 10);
    localHeader.writeUInt16LE(FIXED_DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | ZIP_VERSION, 4);
    centralHeader.writeUInt16LE(ZIP_VERSION, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(DEFLATE_METHOD, 10);
    centralHeader.writeUInt16LE(FIXED_DOS_TIME, 12);
    centralHeader.writeUInt16LE(FIXED_DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);

    localOffset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end-of-central-directory record is missing");
}

function inspectZip(buffer) {
  const endOffset = findEndOfCentralDirectory(buffer);
  const commentLength = buffer.readUInt16LE(endOffset + 20);
  if (endOffset + 22 + commentLength !== buffer.length) {
    throw new Error("ZIP contains trailing or malformed data");
  }
  if (buffer.readUInt16LE(endOffset + 4) || buffer.readUInt16LE(endOffset + 6)) {
    throw new Error("multi-disk ZIP packages are not supported");
  }

  const diskEntryCount = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (diskEntryCount !== entryCount || centralOffset + centralSize !== endOffset) {
    throw new Error("ZIP central directory is inconsistent");
  }

  const entries = new Map();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("ZIP central-directory entry is malformed");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const entryCommentLength = buffer.readUInt16LE(offset + 32);
    const diskNumber = buffer.readUInt16LE(offset + 34);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + entryCommentLength > endOffset) {
      throw new Error("ZIP entry metadata exceeds the central directory");
    }
    const nameBytes = buffer.subarray(nameStart, nameEnd);
    const name = nameBytes.toString("utf8");
    if (!(flags & UTF8_FLAG) || !Buffer.from(name, "utf8").equals(nameBytes)) {
      throw new Error("ZIP entry names must be valid UTF-8");
    }
    assertSafeEntryName(name);
    if (entries.has(name)) throw new Error(`duplicate ZIP entry: ${name}`);
    if (diskNumber !== 0 || (flags & 0x0009) || method !== DEFLATE_METHOD) {
      throw new Error(`unsupported ZIP entry encoding: ${name}`);
    }

    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`missing local ZIP header: ${name}`);
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localChecksum = buffer.readUInt32LE(localOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const dataStart = localNameEnd + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (
      dataEnd > centralOffset ||
      localFlags !== flags ||
      localMethod !== method ||
      localChecksum !== checksum ||
      localCompressedSize !== compressedSize ||
      localUncompressedSize !== uncompressedSize ||
      !buffer.subarray(localNameStart, localNameEnd).equals(nameBytes)
    ) {
      throw new Error(`local and central ZIP metadata differ: ${name}`);
    }

    const content = zlib.inflateRawSync(buffer.subarray(dataStart, dataEnd));
    if (content.length !== uncompressedSize || crc32(content) !== checksum) {
      throw new Error(`ZIP entry failed size or CRC verification: ${name}`);
    }
    entries.set(name, content);
    offset = nameEnd + extraLength + entryCommentLength;
  }
  if (offset !== endOffset) throw new Error("ZIP central-directory length is incorrect");
  return entries;
}

function buildExtensionPackage() {
  return createZip(extensionFiles.map((name) => ({ name, content: sourceFile(name) })));
}

function verifyExtensionPackage(buffer) {
  const entries = inspectZip(buffer);
  if (!entries.has("manifest.json")) {
    throw new Error("manifest.json must be at the ZIP root; wrapper directories are not installable");
  }
  if (entries.size !== extensionFiles.length) {
    throw new Error(`ZIP contains ${entries.size} files; expected ${extensionFiles.length}`);
  }
  for (const name of extensionFiles) {
    const content = entries.get(name);
    if (!content) throw new Error(`ZIP is missing extension file: ${name}`);
    if (!content.equals(sourceFile(name))) throw new Error(`ZIP file differs from source: ${name}`);
  }
  const packagedManifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
  if (packagedManifest.version !== manifest.version) {
    throw new Error("packaged manifest version differs from the repository manifest");
  }
  return entries;
}

function main() {
  const archive = buildExtensionPackage();
  const entries = verifyExtensionPackage(archive);
  if (process.argv.includes("--check")) {
    console.log(`Installable ZIP check passed: manifest.json is at the root with ${entries.size} files`);
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, archive);
  verifyExtensionPackage(fs.readFileSync(outputPath));
  const digest = crypto.createHash("sha256").update(archive).digest("hex");
  console.log(`Created ${path.relative(root, outputPath)} (${entries.size} files)`);
  console.log(`SHA-256: ${digest}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

export {
  buildExtensionPackage,
  createZip,
  extensionFiles,
  inspectZip,
  outputName,
  verifyExtensionPackage
};
