#!/usr/bin/env node
/*
 * patch-cua-runtime.cjs — enable the Computer Use runtime in packaged ZCode
 * builds that shipped with the @zcode/zcode-cua surface stubbed out.
 *
 * What it does:
 *   1. Copies the bundled runtime (runtimes/zcode-cua) into
 *      <install>/resources/tools/zcode-cua.
 *   2. Rewrites the stubbed vite chunks inside resources/app.asar into thin
 *      bridge modules that re-export the real implementation.
 *   3. Replaces the stubbed createComputerUseRuntime inside the seeded
 *      node-repl-host MCP server bundle(s) with a lazy delegating loader.
 *
 * Everything is detected, not assumed: chunks are located by their stub
 * signature ("Computer Use is not available in this build." + named export
 * annotations), so vite chunk hashes may differ between builds. Already
 * patched installs are skipped. A backup of app.asar is written next to the
 * original on first patch.
 *
 * Usage:
 *   node tools/patch-cua-runtime.cjs [--install-dir <dir>] [--repo-dir <dir>]
 *                                    [--check] [--dry-run]
 *   :: under Electron (no node required):
 *   set ELECTRON_RUN_AS_NODE=1 && ZCode.exe tools\patch-cua-runtime.cjs ...
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

// Under ELECTRON_RUN_AS_NODE the embedded Electron runtime virtualizes every
// path containing ".asar", so the archive file itself becomes unreadable
// through fs. Shelling out to the platform shell performs the same IO on the
// real filesystem.
const ASAR_VIRTUALIZED = !!process.versions.electron;

function shellQuote(p) {
  return process.platform === "win32" ? `"${p}"` : `'${p.replace(/'/g, "'\\''")}'`;
}

function shellCopy(src, dst) {
  if (process.platform === "win32") {
    execFileSync("cmd.exe", ["/c", "copy", "/y", src, dst], { stdio: "pipe" });
  } else {
    execFileSync("/bin/sh", ["-c", `cp -f ${shellQuote(src)} ${shellQuote(dst)}`]);
  }
}

function shellMove(src, dst) {
  if (process.platform === "win32") {
    execFileSync("cmd.exe", ["/c", "move", "/y", src, dst], { stdio: "pipe" });
  } else {
    execFileSync("/bin/sh", ["-c", `mv -f ${shellQuote(src)} ${shellQuote(dst)}`]);
  }
}

function shellExists(p) {
  if (process.platform === "win32") {
    try {
      execFileSync("cmd.exe", ["/c", "if", "exist", p, "exit", "/b", "0"], { stdio: "pipe" });
      // `if exist` falls through to exit code of the last command; probe via dir
      execFileSync("cmd.exe", ["/c", "dir", "/b", p], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }
  try {
    execFileSync("/bin/sh", ["-c", `test -f ${shellQuote(p)}`]);
    return true;
  } catch {
    return false;
  }
}

// Read an .asar file's raw bytes, dodging Electron's virtualized fs.
function readArchive(p) {
  if (!ASAR_VIRTUALIZED) return fs.readFileSync(p);
  const probe = p + ".work-read";
  try {
    shellCopy(p, probe);
    return fs.readFileSync(probe);
  } finally {
    try {
      fs.unlinkSync(probe);
    } catch {}
  }
}

function archiveExists(p) {
  return ASAR_VIRTUALIZED ? shellExists(p) : fs.existsSync(p);
}

const STUB_MARKER = "Computer Use is not available in this build.";
const PATCH_MARKER = "zcode-plugin:cua-runtime-bridge";

// ---------------------------------------------------------------------------
// args / install detection
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function opt(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const DRY_RUN = args.includes("--dry-run");
const CHECK_ONLY = args.includes("--check");

function findInstallDir() {
  const explicit = opt("--install-dir") || process.env.ZCODE_INSTALL_DIR;
  const candidates = [];
  if (explicit) candidates.push(explicit);
  const local = process.env.LOCALAPPDATA;
  if (local) candidates.push(path.join(local, "Programs", "ZCode"));
  const pf = process.env["ProgramFiles"];
  if (pf) candidates.push(path.join(pf, "ZCode"));
  const pfx = process.env["ProgramFiles(x86)"];
  if (pfx) candidates.push(path.join(pfx, "ZCode"));
  candidates.push("D:\\ZCode", "C:\\ZCode", "/Applications/ZCode.app/Contents");
  for (const dir of candidates) {
    if (
      dir &&
      fs.existsSync(path.join(dir, "resources", "app.asar")) &&
      fs.existsSync(path.join(dir, "resources", "glm"))
    ) {
      return path.resolve(dir);
    }
  }
  return null;
}

const repoDir = path.resolve(opt("--repo-dir") || path.join(__dirname, ".."));
const runtimeSrc = path.join(repoDir, "runtimes", "zcode-cua");

// ---------------------------------------------------------------------------
// step 1: runtime copy
// ---------------------------------------------------------------------------

function copyDirSync(src, dst, dryRun) {
  let copied = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copied += copyDirSync(s, d, dryRun);
    } else {
      let same = false;
      try {
        same =
          fs.statSync(d).size === fs.statSync(s).size &&
          fs.readFileSync(d).equals(fs.readFileSync(s));
      } catch {}
      if (!same) {
        copied++;
        if (!dryRun) {
          fs.mkdirSync(path.dirname(d), { recursive: true });
          fs.copyFileSync(s, d);
        }
      }
    }
  }
  return copied;
}

// ---------------------------------------------------------------------------
// step 2: asar patch
// ---------------------------------------------------------------------------

const SEMANTIC_IMPORTS = {
  // annotation name / literal value -> export name in broker.js
  callBrokerMethod: "callBrokerMethod",
  probeHelperHealth: "probeHelperHealth",
  mintBrokerSocketPath: "mintBrokerSocketPath",
  resolveBrokerSocketPath: "resolveBrokerSocketPath",
  isCuaHelperError: "isCuaHelperError",
  CuaHelperError: "CuaHelperError",
  BrokerError: "BrokerError",
  "ZCODE_CUA_PERMISSION_BROKER_SOCKET": "BROKER_SOCKET_ENV",
  "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE": "BROKER_UNAVAILABLE_ENV",
};
const CUA_STUB_ANNOTATIONS = new Set([
  "callBrokerMethod",
  "probeHelperHealth",
  "mintBrokerSocketPath",
  "resolveBrokerSocketPath",
  "isCuaHelperError",
]);

function esc(re) {
  return re.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Find the semantic name annotation for a variable in a minified chunk:
//   o(v,"name") / i(v,"name")          (esbuild __name calls)
//   var v=class extends Error{static{h(this,"name")}   (error classes)
//   var v="LITERAL"  or  ,v="LITERAL"  (string constants)
function semanticNameOf(body, varName) {
  const v = esc(varName);
  let m = body.match(new RegExp(`\\w+\\(${v},"([^"]+)"\\)`));
  if (m) return m[1];
  m = body.match(
    new RegExp(`(?:var\\s+|,)${v}=class\\s+extends\\s+Error\\{static\\{\\w+\\(this,"([^"]+)"\\)`),
  );
  if (m) return m[1];
  m = body.match(new RegExp(`(?:var\\s+|,)${v}="(ZCODE_[^"]*)"`));
  if (m) return m[1];
  return null;
}

// Position of the statement that declares `varName` (var/let/const/function).
function declPos(body, varName) {
  const v = esc(varName);
  const patterns = [
    new RegExp(`(?:^|[;}\\n])\\s*var\\s+(?=[^;]*\\b${v}\\b)`),
    new RegExp(`(?:^|[;}\\n])\\s*(?:async\\s+)?function\\s+${v}\\b`),
    new RegExp(`(?:^|[;}\\n])\\s*(?:let|const)\\s+${v}\\b`),
  ];
  let best = -1;
  for (const re of patterns) {
    const m = body.match(re);
    if (m) {
      // position of the decl keyword inside the match
      const idx = m.index + m[0].search(/var|let|const|async|function/);
      if (best < 0 || idx < best) best = idx;
    }
  }
  return best;
}

// Rewrite one stub chunk into a bridge module. Returns null when the chunk
// is not a recognizable CUA stub.
function bridgeChunk(body, asarPath) {
  if (!body.includes(STUB_MARKER)) return null;
  if (body.includes(PATCH_MARKER)) return "already";

  const expMatch = body.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
  if (!expMatch) return null;
  const exportStmt = expMatch[0].trim();
  const pairs = [];
  for (const part of expMatch[1].split(",")) {
    const m = part.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
    if (!m) return null;
    pairs.push({ local: m[1], exported: m[2] || m[1] });
  }

  // map each exported local var to a semantic name
  const semantics = new Map();
  let cuaExports = 0;
  for (const { local } of pairs) {
    const sem = semanticNameOf(body, local);
    semantics.set(local, sem);
    if (sem && SEMANTIC_IMPORTS[sem]) cuaExports++;
  }
  if (cuaExports === 0) return null;

  // collect the full stub family: annotated vars, error classes, ZCODE_*
  // literals, and vars initialized by calling a stub-family var.
  const family = new Set();
  const annRe = /\w+\(([\w$]+),"([\w$]+)"\)/g;
  let m;
  while ((m = annRe.exec(body))) {
    if (CUA_STUB_ANNOTATIONS.has(m[2]) || m[2] === "brokerErrorFactory") family.add(m[1]);
  }
  const clsRe = /(?:var\s+|,)([\w$]+)=class\s+extends\s+Error/g;
  while ((m = clsRe.exec(body))) family.add(m[1]);
  const litRe = /(?:var\s+|,)([\w$]+)="(ZCODE_[^"]*)"/g;
  while ((m = litRe.exec(body))) family.add(m[1]);
  for (const { local } of pairs) if (semantics.get(local)) family.add(local);
  // propagate: var x = <familyVar>(...)
  let grew = true;
  while (grew) {
    grew = false;
    const initRe = /(?:var\s+|,)([\w$]+)=([\w$]+)\(/g;
    while ((m = initRe.exec(body))) {
      if (family.has(m[2]) && !family.has(m[1])) {
        family.add(m[1]);
        grew = true;
      }
    }
  }

  // cut position: earliest stub-family declaration; everything before stays.
  let cut = -1;
  for (const v of family) {
    const pos = declPos(body, v);
    if (pos >= 0 && (cut < 0 || pos < cut)) cut = pos;
  }
  if (cut < 0) return null;

  // every exported var must be either bridgeable or defined above the cut
  const importBindings = [];
  for (const { local } of pairs) {
    const sem = semantics.get(local);
    if (sem && SEMANTIC_IMPORTS[sem]) {
      importBindings.push([SEMANTIC_IMPORTS[sem], local]);
    } else {
      const pos = declPos(body, local);
      if (pos < 0 || pos >= cut) return null; // can't preserve -> bail
    }
  }
  if (importBindings.length === 0) return null;

  // relative path from the chunk to resources/tools/zcode-cua/broker.js
  const dirDepth = asarPath.split("/").filter(Boolean).length - 1;
  const rel = "../".repeat(dirDepth + 1) + "tools/zcode-cua/broker.js";

  const header = `// ${PATCH_MARKER}\n// This build shipped the Computer Use runtime surface as stubs.\n// Re-export the real implementation from resources/tools/zcode-cua.\n`;
  const imports = importBindings
    .map(([real, local]) => `import { ${real} as ${local} } from "${rel}";`)
    .join("\n");
  return `${header}${body.slice(0, cut).trimEnd()}\n${imports}\n${exportStmt}\n`;
}

function walkAsarFiles(node, prefix, out) {
  for (const [name, v] of Object.entries(node.files || {})) {
    const p = prefix + "/" + name;
    if (v.files) walkAsarFiles(v, p, out);
    else out.push([p, v]);
  }
}

function integrityOf(buf) {
  const blockSize = 4194304;
  const blocks = [];
  for (let i = 0; i < buf.length; i += blockSize) {
    blocks.push(crypto.createHash("sha256").update(buf.subarray(i, i + blockSize)).digest("hex"));
  }
  const hash =
    blocks.length === 1
      ? blocks[0]
      : crypto.createHash("sha256").update(blocks.join("")).digest("hex");
  return { algorithm: "SHA256", hash, blockSize, blocks };
}

function patchAsar(asarPath, dryRun) {
  const data = readArchive(asarPath);
  const J = data.readUInt32LE(12);
  const header = JSON.parse(data.subarray(16, 16 + J).toString("utf8"));
  const base = 16 + J;

  const entries = [];
  walkAsarFiles(header, "", entries);

  const patched = [];
  const skipped = [];
  const bodies = new Map();
  for (const [p, v] of entries) {
    if (v.unpacked || v.link !== undefined) continue;
    const off = Number(v.offset || "0");
    const body = data.subarray(base + off, base + off + v.size);
    bodies.set(p, { v, body });
    if (!p.endsWith(".js") || v.size > 8 * 1024 * 1024) continue;
    const res = bridgeChunk(body.toString("utf8"), p);
    if (res === "already") skipped.push(p);
    else if (res) {
      patched.push(p);
      bodies.set(p, { v, body: Buffer.from(res, "utf8") });
    }
  }

  if (patched.length === 0) {
    return { patched, skipped, wrote: false };
  }
  if (dryRun) return { patched, skipped, wrote: false };

  // rebuild archive
  let offset = 0;
  const order = [];
  for (const [p, { v, body }] of bodies) {
    if (patched.includes(p)) {
      v.size = body.length;
      v.integrity = integrityOf(body);
    }
    v.offset = String(offset);
    offset += body.length;
    order.push(p);
  }
  const json = JSON.stringify(header);
  const Jn = Buffer.byteLength(json);
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(Jn + 10, 4);
  head.writeUInt32LE(Jn + 6, 8);
  head.writeUInt32LE(Jn, 12);
  const parts = [head, Buffer.from(json, "utf8")];
  for (const p of order) parts.push(bodies.get(p).body);
  const out = Buffer.concat(parts);

  const backup = asarPath + ".zcode-plugin.bak";
  if (!archiveExists(backup)) {
    if (ASAR_VIRTUALIZED) shellCopy(asarPath, backup);
    else fs.copyFileSync(asarPath, backup);
  }
  let deferredMove = false;
  if (ASAR_VIRTUALIZED) {
    // This process itself holds app.asar open (ELECTRON_RUN_AS_NODE), so the
    // final swap must run after we exit. Stage the archive and hand the move
    // to a detached shell with a short delay.
    const staged = path.join(path.dirname(asarPath), "app.work-staged");
    fs.writeFileSync(staged, out);
    const { spawn } = require("node:child_process");
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "ping", "-n", "3", "127.0.0.1", ">nul", "&", "move", "/y", staged, asarPath], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      spawn("/bin/sh", ["-c", `sleep 2 && mv -f ${shellQuote(staged)} ${shellQuote(asarPath)}`], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }
    deferredMove = true;
  } else {
    fs.writeFileSync(asarPath, out);
  }
  return { patched, skipped, wrote: true, deferredMove, backup };
}

// ---------------------------------------------------------------------------
// step 3: node-repl-host server.js
// ---------------------------------------------------------------------------

const SERVER_STUB_RE =
  /var UNAVAILABLE_TEXT = "Computer Use is not available in this build\.";\s*\nfunction createComputerUseRuntime\(_options\) \{[\s\S]*?\n\}\n/;

const SERVER_IMPL = `var UNAVAILABLE_TEXT = "Computer Use is not available in this build.";
// ${PATCH_MARKER}: delegate to the real @zcode/zcode-cua package under
// resources/tools/zcode-cua (lazily, so sessions that never use Computer Use
// pay no startup cost).
function createComputerUseRuntime(_options) {
  let realPromise = null;
  const loadReal = () => {
    if (!realPromise) {
      realPromise = (async () => {
        const { join, dirname } = await import("node:path");
        const { pathToFileURL } = await import("node:url");
        const override = (process.env.ZCODE_CUA_PACKAGE_ENTRY || "").trim();
        const candidates = [];
        if (override) candidates.push(override);
        candidates.push(join(dirname(process.execPath), "resources", "tools", "zcode-cua", "index.js"));
        try {
          const { fileURLToPath } = await import("node:url");
          const here = dirname(fileURLToPath(import.meta.url));
          candidates.push(join(here, "..", "..", "..", "..", "..", "tools", "zcode-cua", "index.js"));
        } catch {}
        let lastError;
        for (const entry of candidates) {
          try {
            const mod = await import(pathToFileURL(entry).href);
            return mod.createComputerUseRuntime(_options);
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError;
      })();
    }
    return realPromise;
  };
  return {
    async execute(input) {
      return (await loadReal()).execute(input);
    },
    async closeSession(context) {
      const rt = await loadReal();
      if (typeof rt.closeSession === "function") return await rt.closeSession(context);
    },
    async dispose() {
      const rt = await loadReal();
      if (typeof rt.dispose === "function") return await rt.dispose();
    }
  };
}
`;

function patchServerBundle(file, dryRun) {
  let src;
  try {
    src = fs.readFileSync(file, "utf8");
  } catch {
    return "missing";
  }
  if (src.includes(PATCH_MARKER)) return "already";
  if (!src.includes(STUB_MARKER)) return "no-stub";
  if (!SERVER_STUB_RE.test(src)) return "unrecognized-shape";
  if (!dryRun) {
    fs.writeFileSync(file, src.replace(SERVER_STUB_RE, SERVER_IMPL));
  }
  return "patched";
}

function findServerBundles(installDir) {
  const files = [path.join(installDir, "resources", "glm", "packages", "node-repl-host", "dist", "mcp", "server.js")];
  const cacheRoot = path.join(
    process.env.USERPROFILE || process.env.HOME || "",
    ".zcode", "cli", "plugins", "cache",
  );
  try {
    for (const marketplace of fs.readdirSync(cacheRoot)) {
      const nh = path.join(cacheRoot, marketplace, "node-repl-host");
      if (!fs.existsSync(nh)) continue;
      for (const ver of fs.readdirSync(nh)) {
        files.push(path.join(nh, ver, "dist", "mcp", "server.js"));
      }
    }
  } catch {}
  return files;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const installDir = findInstallDir();
  if (!installDir) {
    console.error("Could not locate a ZCode installation. Pass --install-dir <path>.");
    process.exit(2);
  }
  console.log(`[cua-patch] install dir: ${installDir}`);
  console.log(`[cua-patch] runtime source: ${runtimeSrc}`);
  if (!fs.existsSync(path.join(runtimeSrc, "index.js"))) {
    console.error(`Runtime package not found at ${runtimeSrc}`);
    process.exit(2);
  }

  // 1. runtime
  const runtimeDst = path.join(installDir, "resources", "tools", "zcode-cua");
  const copied = copyDirSync(runtimeSrc, runtimeDst, DRY_RUN || CHECK_ONLY);
  console.log(`[cua-patch] runtime -> ${runtimeDst} (${copied} file(s) ${copied ? "updated" : "already up to date"})`);

  // 2. asar
  const asar = path.join(installDir, "resources", "app.asar");
  try {
    const r = patchAsar(asar, DRY_RUN || CHECK_ONLY);
    if (r.patched.length) {
      console.log(`[cua-patch] app.asar: bridged ${r.patched.length} stub chunk(s):`);
      for (const p of r.patched) console.log(`            ${p}`);
      if (r.wrote) console.log(`            backup: ${r.backup}`);
      if (r.deferredMove) console.log("            (archive swap runs when this process exits)");
    } else if (skippedNonEmpty(r)) {
      console.log("[cua-patch] app.asar: already patched");
    } else {
      console.log("[cua-patch] app.asar: no stub chunks found (nothing to do)");
    }
  } catch (error) {
    console.error(`[cua-patch] app.asar patch failed: ${error.message}`);
    console.error("            (is ZCode still running? close it completely and retry)");
    process.exitCode = 1;
  }

  // 3. server bundles
  for (const file of findServerBundles(installDir)) {
    const res = patchServerBundle(file, DRY_RUN || CHECK_ONLY);
    if (res === "patched" || res === "unrecognized-shape" || res === "already") {
      console.log(`[cua-patch] server.js ${res}: ${file}`);
    }
  }

  console.log(CHECK_ONLY ? "[cua-patch] check complete." : "[cua-patch] done. Restart ZCode to apply.");
}

function skippedNonEmpty(r) {
  return r.skipped && r.skipped.length > 0;
}

main();
