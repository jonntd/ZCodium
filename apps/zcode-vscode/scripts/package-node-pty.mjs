#!/usr/bin/env node
// 把 node-pty 整包拷进扩展产物（打包 vsix 前跑）：node-pty 含平台原生二进制
// （build/Release/pty.node + darwin spawn-helper），esbuild 无法内联——terminal
// 频道的 PTY 在插件 host 进程内创建，运行时 require("node-pty") 必须能从扩展
// 目录解析到真实文件。strategy：优先仓库根 pnpm 装好的那份（prebuild 已按本机
// 平台就位），缺文件再整包复制。
//
//   node scripts/package-node-pty.mjs
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, "..");
const repoRoot = resolve(extRoot, "../..");
const dest = join(extRoot, "node_modules", "node-pty");

let source;
try {
  const require = createRequire(join(repoRoot, "node_modules", "_probe.js"));
  source = dirname(require.resolve("node-pty/package.json"));
} catch {
  console.error("[node-pty] 仓库根找不到 node-pty：先 pnpm install");
  process.exit(1);
}

const REQUIRED = [
  "package.json",
  "lib",
  `build/Release`,
  `prebuilds/${process.platform}-${process.arch}`,
];
for (const rel of REQUIRED) {
  const p = join(source, rel);
  if (!existsSync(p)) {
    console.error(`[node-pty] 源缺 ${rel}（prebuild 未按本机平台就位）：${p}`);
    process.exit(1);
  }
}

// darwin 的 spawn-helper 在 node-pty 根/scripts 或 build/Release，一并带上 scripts。
mkdirSync(dirname(dest), { recursive: true });
cpSync(source, dest, {
  recursive: true,
  force: true,
  filter: (srcPath) => {
    const rel = srcPath.slice(source.length);
    // 只带运行时必需面，减小 vsix：lib、build、prebuilds（本机平台）、scripts、
    // package.json；排除源码/文档/其他平台 prebuild。
    if (rel === "" || rel === "/") return true;
    const top = rel.split("/")[1] ?? "";
    if (["package.json", "lib", "build", "scripts"].includes(top)) return true;
    if (top === "prebuilds") return rel.startsWith(`/prebuilds/${process.platform}-${process.arch}`);
    return false;
  },
});

const size = (p) => {
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
};
const native = join(dest, "build", "Release");
console.log(
  `[node-pty] 已就位 ${dest}\n  原生二进制: ${readdirSync(native).join(", ")}\n` +
    `  pty.node: ${size(join(native, "pty.node"))} bytes`,
);
