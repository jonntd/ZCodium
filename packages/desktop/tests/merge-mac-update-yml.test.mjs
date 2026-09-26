import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mergeMacUpdateYmlDocs,
  parseElectronBuilderUpdateYml,
  serializeElectronBuilderUpdateYml,
} from "../scripts/merge-mac-update-yml.mjs";

// 样例结构与 electron-builder 实际生成的 latest-mac.yml 保持一致（含单引号 releaseDate）。
function macYml(arch) {
  return [
    `version: 3.14.3`,
    "files:",
    `  - url: ZCodium-3.14.3-mac-${arch}.zip`,
    "    sha512: zip-checksum",
    "    size: 177618609",
    `  - url: ZCodium-3.14.3-mac-${arch}.dmg`,
    "    sha512: dmg-checksum",
    "    size: 185066505",
    `path: ZCodium-3.14.3-mac-${arch}.zip`,
    "sha512: zip-checksum",
    `releaseDate: '2026-09-26T0${arch === "arm64" ? 7 : 8}:00:00.000Z'`,
    "",
  ].join("\n");
}

test("merged mac metadata contains both architectures", () => {
  const arm64 = parseElectronBuilderUpdateYml(macYml("arm64"));
  const x64 = parseElectronBuilderUpdateYml(macYml("x64"));
  const merged = mergeMacUpdateYmlDocs([arm64, x64]);
  assert.equal(merged.scalars.version, "3.14.3");
  const urls = merged.files.map((entry) => entry.url);
  assert.deepEqual(urls, [
    "ZCodium-3.14.3-mac-arm64.zip",
    "ZCodium-3.14.3-mac-arm64.dmg",
    "ZCodium-3.14.3-mac-x64.zip",
    "ZCodium-3.14.3-mac-x64.dmg",
  ]);
  // MacUpdater 按 URL 是否含 arm64 过滤；两个 zip 条目必须同时存在。
  assert.equal(urls.filter((url) => url.endsWith(".zip")).length, 2);
  // releaseDate 取最晚时间。
  assert.equal(merged.scalars.releaseDate, "'2026-09-26T08:00:00.000Z'");
  // 顶层 path/sha512 沿用首个输入，且必须仍指向真实存在的产物。
  assert.equal(merged.scalars.path, "ZCodium-3.14.3-mac-arm64.zip");
  const serialized = serializeElectronBuilderUpdateYml(merged);
  assert.match(serialized, /^version: 3\.14\.3\nfiles:\n/);
  assert.match(serialized, /  - url: ZCodium-3\.14\.3-mac-arm64\.zip\n    sha512: zip-checksum\n/);
});

test("merge rejects version mismatch and missing zip entries", () => {
  const arm64 = parseElectronBuilderUpdateYml(macYml("arm64"));
  const otherVersion = parseElectronBuilderUpdateYml(macYml("x64").replace("3.14.3", "3.14.4"));
  assert.throws(() => mergeMacUpdateYmlDocs([arm64, otherVersion]), /version mismatch/);
  const noZip = parseElectronBuilderUpdateYml(
    macYml("x64").replaceAll("-mac-x64.zip", "-mac-x64.pkg"),
  );
  assert.throws(() => mergeMacUpdateYmlDocs([noZip]), /no \.zip entry/);
});

test("single-architecture input passes through unchanged", () => {
  const arm64 = parseElectronBuilderUpdateYml(macYml("arm64"));
  const merged = mergeMacUpdateYmlDocs([arm64]);
  assert.equal(merged.files.length, 2);
  assert.equal(merged.scalars.releaseDate, arm64.scalars.releaseDate);
});

test("parser rejects malformed metadata", () => {
  assert.throws(
    () => parseElectronBuilderUpdateYml("files:\n  - url: app.zip\n", "bad.yml"),
    /missing version/,
  );
  assert.throws(
    () => parseElectronBuilderUpdateYml("version: 1.0.0\n", "bad.yml"),
    /missing files/,
  );
  assert.throws(
    () => parseElectronBuilderUpdateYml("version: 1.0.0\nnot a key: [unclosed", "bad.yml"),
    /unsupported line/,
  );
});

test("cli merges two files end to end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "merge-mac-yml-"));
  const arm64Path = join(dir, "latest-mac-arm64.yml");
  const x64Path = join(dir, "latest-mac-x64.yml");
  const outPath = join(dir, "latest-mac.yml");
  await writeFile(arm64Path, macYml("arm64"), "utf8");
  await writeFile(x64Path, macYml("x64"), "utf8");
  const script = fileURLToPath(new URL("../scripts/merge-mac-update-yml.mjs", import.meta.url));
  const { status } = spawnSync(process.execPath, [script, "--out", outPath, arm64Path, x64Path]);
  assert.equal(status, 0);
  const output = await readFile(outPath, "utf8");
  assert.match(output, /url: ZCodium-3\.14\.3-mac-arm64\.zip/);
  assert.match(output, /url: ZCodium-3\.14\.3-mac-x64\.zip/);
});
