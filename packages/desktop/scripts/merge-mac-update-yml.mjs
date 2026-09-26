// 合并 electron-builder 在两个 mac 架构 job 里各自生成的 latest-mac.yml。
// 背景：MacUpdater 在 macOS 上只请求 latest-mac.yml（无架构后缀文件），并按文件 URL
// 是否含 "arm64" 过滤条目；如果两个 CI job 用 --clobber 互相覆盖，最终只会留下一个
// 架构的条目——另一架构要么更新失败（ERR_UPDATER_ZIP_FILE_NOT_FOUND），要么被装上
// Rosetta 跑错误架构的包。这里把双架构条目合并进同一个 latest-mac.yml。
// 只解析 electron-builder 生成的固定 schema（顶层标量 + files 列表），不做通用 YAML。
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function parseScalarOrThrow(line, context) {
  const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
  if (!match) {
    throw new Error(`merge-mac-update-yml: unsupported line in ${context}: ${line}`);
  }
  return { key: match[1], value: match[2] };
}

export function parseElectronBuilderUpdateYml(text, context = "<input>") {
  const doc = { scalars: {}, files: [] };
  let currentEntry = null;
  let inFiles = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") {
      continue;
    }
    if (!line.startsWith(" ") && !line.startsWith("-")) {
      inFiles = line.trim() === "files:";
      if (inFiles) {
        continue;
      }
      const { key, value } = parseScalarOrThrow(line.trim(), context);
      doc.scalars[key] = value;
      currentEntry = null;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      const { key, value } = parseScalarOrThrow(trimmed.slice(2), context);
      currentEntry = { [key]: value };
      doc.files.push(currentEntry);
      continue;
    }
    if (!currentEntry) {
      throw new Error(`merge-mac-update-yml: list item outside files in ${context}: ${line}`);
    }
    const { key, value } = parseScalarOrThrow(trimmed, context);
    currentEntry[key] = value;
  }
  if (!doc.scalars.version) {
    throw new Error(`merge-mac-update-yml: missing version in ${context}`);
  }
  if (doc.files.length === 0) {
    throw new Error(`merge-mac-update-yml: missing files list in ${context}`);
  }
  return doc;
}

export function serializeElectronBuilderUpdateYml(doc) {
  const lines = [`version: ${doc.scalars.version}`, "files:"];
  for (const entry of doc.files) {
    const keys = Object.keys(entry);
    keys.forEach((key, index) => {
      lines.push(index === 0 ? `  - ${key}: ${entry[key]}` : `    ${key}: ${entry[key]}`);
    });
  }
  for (const [key, value] of Object.entries(doc.scalars)) {
    if (key !== "version") {
      lines.push(`${key}: ${value}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function mergeMacUpdateYmlDocs(docs) {
  if (docs.length === 0) {
    throw new Error("merge-mac-update-yml: no inputs");
  }
  const version = docs[0].scalars.version;
  for (const doc of docs) {
    if (doc.scalars.version !== version) {
      throw new Error(
        `merge-mac-update-yml: version mismatch (${version} vs ${doc.scalars.version})`,
      );
    }
  }
  // 双架构条目按输入顺序合并；同一 URL 重复出现时保留首个，避免重复上传同一文件描述。
  const seenUrls = new Set();
  const files = [];
  let hasZipEntry = false;
  for (const doc of docs) {
    for (const entry of doc.files) {
      if (typeof entry.url !== "string" || entry.url === "") {
        throw new Error("merge-mac-update-yml: file entry missing url");
      }
      hasZipEntry = hasZipEntry || entry.url.endsWith(".zip");
      if (seenUrls.has(entry.url)) {
        continue;
      }
      seenUrls.add(entry.url);
      files.push(entry);
    }
  }
  if (!hasZipEntry) {
    // macOS 自动更新只消费 zip；合并结果里没有 zip 说明输入不是 mac 元数据。
    throw new Error("merge-mac-update-yml: merged metadata has no .zip entry");
  }
  const merged = { scalars: { ...docs[0].scalars }, files };
  // releaseDate 取各输入中最晚的 ISO 时间，表示双架构产物均已就绪的时间点。
  let latestDateMs = -Infinity;
  let latestDateRaw = docs[0].scalars.releaseDate;
  for (const doc of docs) {
    const raw = doc.scalars.releaseDate;
    if (typeof raw !== "string") {
      continue;
    }
    const ms = Date.parse(unquote(raw));
    if (Number.isFinite(ms) && ms > latestDateMs) {
      latestDateMs = ms;
      latestDateRaw = raw;
    }
  }
  merged.scalars.releaseDate = latestDateRaw;
  return merged;
}

export async function mergeMacUpdateYmlFiles(inputs, output) {
  const docs = await Promise.all(
    inputs.map(async (input) =>
      parseElectronBuilderUpdateYml(await readFile(input, "utf8"), input),
    ),
  );
  await writeFile(output, serializeElectronBuilderUpdateYml(mergeMacUpdateYmlDocs(docs)), "utf8");
}

function parseCliArgs(argv) {
  const inputs = [];
  let output;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      output = argv[index + 1];
      index += 1;
      continue;
    }
    inputs.push(arg);
  }
  if (!output || inputs.length === 0) {
    console.error(
      "usage: node merge-mac-update-yml.mjs --out <output.yml> <input1.yml> [input2.yml ...]",
    );
    process.exit(2);
  }
  return { inputs, output };
}

export async function main(argv) {
  const { inputs, output } = parseCliArgs(argv);
  await mergeMacUpdateYmlFiles(inputs, output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
