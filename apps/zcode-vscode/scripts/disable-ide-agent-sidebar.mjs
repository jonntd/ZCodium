#!/usr/bin/env node
/**
 * disable-ide-agent-sidebar.mjs — 从内核根断 Antigravity IDE 的 agent 侧栏自动展开。
 *
 * 背景（2026-11-08 深度审查）：IDE 内核的 AntigravityCascadeService.openPanel() 是
 * agent 侧栏（Cascade 面板）打开的**唯一汇聚点**——所有触发源（webview 聚焦联动、
 * onboarding、login、explain/fix 动作、布局按钮 togglePanel、扩展 API Cascade.openPanel）
 * 最终都走 `openViewContainer("antigravity.agentViewContainerId")`。
 * gode 编辑器页签的 webview 一获得焦点，IDE 就自动展开该侧栏，扩展侧的延迟收栏
 * （chatEditorPanel 的多点 closeSidebar/closeAuxiliaryBar）存在竞争窗口，用户实测
 * 仍会闪现/滞留。本脚本直接改内核 bundle：openPanel 保留「已可见时调整宽度」，
 * 移除「打开容器 + 广播可见」——侧栏从根上失去打开能力（toggle 变为仅关闭）。
 *
 * 用法：
 *   node disable-ide-agent-sidebar.mjs            # 打补丁（幂等，首patch自动备份）
 *   node disable-ide-agent-sidebar.mjs --restore  # 从备份恢复原版
 *   node disable-ide-agent-sidebar.mjs --status   # 查看当前状态
 *
 * IDE 更新/重装后补丁会被覆盖，重跑本脚本即可。生效需 Reload Window（建议整退重启）。
 */
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const APP_DIR =
  process.env.IDE_APP_DIR ??
  "/Applications/Antigravity IDE.app/Contents/Resources/app";
const TARGET = join(APP_DIR, "out/vs/workbench/workbench.desktop.main.js");
const BACKUP = `${TARGET}.gode-orig.bak`;

/** 原版 openPanel（minified，唯一）。 */
const ORIGINAL =
  'openPanel(e){const{isVisible:i}=this.getFocusState();if(i){e!==void 0&&this._setPanelWidth(e);return}this.viewsService.openViewContainer(Vpe),this._onDidChangeCascadePanelVisible.fire(!0),e!==void 0&&this._setPanelWidth(e)}';
/** 补丁后：保留宽度调整，去掉打开容器与可见性广播。 */
const PATCHED =
  'openPanel(e){const{isVisible:i}=this.getFocusState();if(i){e!==void 0&&this._setPanelWidth(e);return}/* gode: agent sidebar auto-open disabled */e!==void 0&&this._setPanelWidth(e)}';

function status() {
  if (!existsSync(TARGET)) {
    console.error(`[ide-patch] 未找到内核文件：${TARGET}`);
    process.exit(1);
  }
  const data = readFileSync(TARGET, "utf8");
  if (data.includes(PATCHED)) return "patched";
  if (data.includes(ORIGINAL)) return "original";
  return "unknown";
}

const mode = process.argv[2] ?? "--patch";

if (mode === "--status") {
  console.log(`[ide-patch] 状态：${status()}（${TARGET}）`);
  process.exit(0);
}

if (mode === "--restore") {
  if (!existsSync(BACKUP)) {
    console.error(`[ide-patch] 无备份可恢复：${BACKUP}`);
    process.exit(1);
  }
  copyFileSync(BACKUP, TARGET);
  console.log(`[ide-patch] 已恢复原版 ← ${BACKUP}（Reload Window 生效）`);
  process.exit(0);
}

// ── 默认：打补丁 ──
const state = status();
if (state === "patched") {
  console.log("[ide-patch] 已是补丁状态，无需重复操作。");
  process.exit(0);
}
if (state !== "original") {
  console.error(
    "[ide-patch] 内核 bundle 与已知原版不匹配（IDE 版本更新？）。" +
      "请人工核对 AntigravityCascadeService.openPanel 后更新本脚本的 ORIGINAL/PATCHED 片段。",
  );
  process.exit(1);
}
if (!existsSync(BACKUP)) {
  copyFileSync(TARGET, BACKUP);
  const { size } = statSync(BACKUP);
  console.log(`[ide-patch] 已备份原版 → ${BACKUP}（${size} bytes）`);
} else {
  console.log("[ide-patch] 备份已存在，跳过备份。");
}
const data = readFileSync(TARGET, "utf8");
if (data.includes(ORIGINAL) === false) {
  console.error("[ide-patch] 意外：写入前复查失败（目标片段消失）");
  process.exit(1);
}
writeFileSync(TARGET, data.replace(ORIGINAL, PATCHED));
const after = readFileSync(TARGET, "utf8");
if (!after.includes(PATCHED)) {
  console.error("[ide-patch] 写入后校验失败（补丁片段缺失）");
  process.exit(1);
}
console.log(
  "[ide-patch] ✓ 内核 agent 侧栏自动展开已从根禁用（openPanel 只调宽度不打开容器）。",
);
console.log("[ide-patch] 生效：Reload Window（建议整退重启 IDE）。恢复：node scripts/disable-ide-agent-sidebar.mjs --restore");
