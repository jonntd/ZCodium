/**
 * Gode 扩展 webview 产物运行时冒烟测试（Node + jsdom，无 UI 依赖）。
 *
 * 目标：从【部署目录】动态 import main.js（相对 chunk 引用即解析部署面真实文件），
 * 模拟 webview 环境（acquireVsCodeApi + jsdom DOM），验证：
 *  1) ESM 模块图完整可加载（缺 chunk / 语法错误会直接抛异常）；
 *  2) bootstrap() 跑通：ctx 帧发出、__debug-webview-ready 探针发出；
 *  3) React 装配树在 #app 实际挂载（childElementCount > 0）。
 *
 * 用法：node scripts/webview-smoke.mjs <webview-dist-dir>
 */
import { JSDOM } from "jsdom";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/webview-smoke.mjs <webview-dist-dir>");
  process.exit(2);
}

const dom = new JSDOM("<!DOCTYPE html><html><body><div id=\"app\"></div></body></html>", {
  url: "https://webview.test/",
  pretendToBeVisual: true,
});

const { window } = dom;
const posted = [];
let capturedError = null;

// ---- webview 环境桩 ----
window.acquireVsCodeApi = () => ({
  postMessage: (msg) => { posted.push(msg); },
  getState: () => ({}),
  setState: () => {},
});
// jsdom 缺失的浏览器 API（React/组件库常见依赖）。
window.matchMedia = window.matchMedia || ((q) => ({
  matches: false, media: q, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
}));
window.ResizeObserver = window.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
window.IntersectionObserver = window.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
window.scrollTo = window.scrollTo || (() => {});
window.addEventListener("error", (e) => { capturedError = e.error ?? e.message; });

for (const k of ["window", "document", "navigator", "location", "history", "HTMLElement", "Element", "Node", "customElements", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent", "Blob", "File", "FileReader", "DOMParser", "XMLHttpRequest", "fetch"]) {
  if (window[k] !== undefined && globalThis[k] === undefined) {
    try { globalThis[k] = window[k]; } catch { /* 只读属性跳过 */ }
  }
}
globalThis.acquireVsCodeApi = window.acquireVsCodeApi;
globalThis.isSecureContext = true;
globalThis.self = window;

// ---- 加载部署产物 ----
// Node 按 package.json type 解析 .js；部署目录是 CJS 语义。复制到临时目录并标记 module。
import { cpSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "zcode-smoke-"));
cpSync(target, join(tmpRoot, "webview"), { recursive: true });
writeFileSync(join(tmpRoot, "package.json"), JSON.stringify({ type: "module" }));

const entry = new URL(`file://${join(tmpRoot, "webview", "main.js")}`).href;
try {
  await import(entry);
} catch (err) {
  console.error("[smoke] FAIL — main.js 模块图加载失败：", err?.message ?? err);
  if (err?.code) console.error("  code:", err.code);
  process.exit(1);
}

// ---- 等待 React 渲染若干宏任务 ----
await new Promise((r) => setTimeout(r, 1200));
await new Promise((r) => setTimeout(r, 800));

const app = window.document.getElementById("app");
const mounted = app && app.childElementCount > 0;
const readyProbe = posted.some(
  (m) => m && m.t === "plat-evt" && m.event === "__debug-webview-ready",
);
const ctxSent = posted.some((m) => m && typeof m === "object" && m.t !== undefined);
// 会话标签栏（Claude「Untitled」同款）只在多会话时渲染：单会话时与外层 IDE
// 编辑器标签视觉重复，隐藏是预期。断言「标签数 ↔ 标签栏可见性」自洽。
const tabBar = window.document.querySelector('[data-testid="session-tab-bar"]');
const tabCount = window.document.querySelectorAll("[data-tab-id]").length;
const tabConsistent = tabBar ? tabCount > 1 : tabCount <= 1;

console.log("[smoke] posted frames:", posted.length,
  "first:", JSON.stringify(posted[0])?.slice(0, 160));
console.log("[smoke] __debug-webview-ready:", readyProbe ? "SENT" : "NOT SENT");
console.log("[smoke] React mounted into #app:", mounted ? "YES" : "NO",
  `(children=${app?.childElementCount ?? 0})`);
console.log("[smoke] 会话标签栏:", tabBar ? `YES（${tabCount} 个标签）` : `隐藏（${tabCount} 个标签，单会话预期）`);
if (capturedError) console.log("[smoke] window error:", String(capturedError).slice(0, 300));

if (!readyProbe || !mounted || capturedError || !tabConsistent) {
  console.error("[smoke] FAIL — webview 产物未完成启动序列",
    !readyProbe ? "｜缺就绪探针" : "",
    !mounted ? "｜React 未挂载" : "",
    !tabConsistent ? "｜会话标签数与标签栏可见性不一致" : "",
    capturedError ? "｜运行时错误" : "");
  if (capturedError && capturedError.stack) console.error(capturedError.stack.split("\n").slice(0, 6).join("\n"));
  process.exit(1);
}
console.log("[smoke] PASS — 部署面 webview 产物加载、探针与 React 挂载全部通过");
