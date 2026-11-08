#!/usr/bin/env node
/**
 * disable-ide-agent-sidebar.mjs — 从内核根断 Antigravity IDE 的 agent 侧栏自动展开。
 *
 * 背景（2026-11-08 深度审查，两处根因）：
 *
 * 【补丁 1】AntigravityCascadeService.openPanel() 是 agent 侧栏运行期打开的唯一汇聚点
 * ——所有触发源（webview 聚焦联动、onboarding、login、explain/fix 动作、布局按钮
 * togglePanel、扩展 API Cascade.openPanel）最终都走
 * `openViewContainer("antigravity.agentViewContainerId")`。
 * gode 编辑器页签的 webview 一获得焦点，IDE 就自动展开该侧栏。本补丁保留
 * 「已可见时调整宽度」，移除「打开容器 + 广播可见」——运行期侧栏失去打开能力。
 *
 * 【补丁 2】工作台布局初始化（workbench.desktop.main.js 的 layout init）每次启动
 * 都无条件执行：
 *   setRuntimeValue(AUXILIARYBAR_HIDDEN, !1)               // 强制辅助栏可见
 *   containerToRestore.auxiliaryBar = agentViewContainerId // 强制恢复 agent 容器
 * 这条路径完全绕过 openPanel，补丁 1 拦不住（用户实测重启后侧栏仍然自动出现）。
 * 本补丁将其翻转为默认隐藏：HIDDEN,!1 → HIDDEN,!0 且恢复容器置 void 0。
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

/**
 * 原版 openPanel（minified，唯一）。
 * 补丁后：保留宽度调整，去掉打开容器与可见性广播。
 */
const PATCHES = [
  {
    name: "openPanel 运行期打开根断",
    ORIGINAL:
      'openPanel(e){const{isVisible:i}=this.getFocusState();if(i){e!==void 0&&this._setPanelWidth(e);return}this.viewsService.openViewContainer(Vpe),this._onDidChangeCascadePanelVisible.fire(!0),e!==void 0&&this._setPanelWidth(e)}',
    PATCHED:
      'openPanel(e){const{isVisible:i}=this.getFocusState();if(i){e!==void 0&&this._setPanelWidth(e);return}/* gode: agent sidebar auto-open disabled */e!==void 0&&this._setPanelWidth(e)}',
  },
  {
    name: "启动布局强制恢复 agent 辅助栏 → 默认隐藏",
    ORIGINAL:
      'this.stateModel.setRuntimeValue(dr.AUXILIARYBAR_HIDDEN,!1),this.state.initialization.views.containerToRestore.auxiliaryBar=Vpe,this.updateWindowBorder(!0)',
    PATCHED:
      'this.stateModel.setRuntimeValue(dr.AUXILIARYBAR_HIDDEN,!0),this.state.initialization.views.containerToRestore.auxiliaryBar=void 0,this.updateWindowBorder(!0)/* gode: agent sidebar startup restore disabled */',
  },
];

function patchState(data, patch) {
  if (data.includes(patch.PATCHED)) return "patched";
  if (data.includes(patch.ORIGINAL)) return "original";
  return "unknown";
}

function status() {
  if (!existsSync(TARGET)) {
    console.error(`[ide-patch] 未找到内核文件：${TARGET}`);
    process.exit(1);
  }
  return readFileSync(TARGET, "utf8");
}

const mode = process.argv[2] ?? "--patch";

if (mode === "--status") {
  const data = status();
  for (const patch of PATCHES) {
    console.log(`[ide-patch] ${patch.name}：${patchState(data, patch)}`);
  }
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

// ── 默认：打补丁（逐条独立，幂等，支持部分已打状态） ──
let data = status();
if (!existsSync(BACKUP)) {
  copyFileSync(TARGET, BACKUP);
  const { size } = statSync(BACKUP);
  console.log(`[ide-patch] 已备份原版 → ${BACKUP}（${size} bytes）`);
} else {
  console.log("[ide-patch] 备份已存在，跳过备份。");
}

for (const patch of PATCHES) {
  const state = patchState(data, patch);
  if (state === "patched") {
    console.log(`[ide-patch] ✓ 已是补丁状态，跳过：${patch.name}`);
    continue;
  }
  if (state !== "original") {
    console.error(
      `[ide-patch] 内核 bundle 与「${patch.name}」的已知原版不匹配（IDE 版本更新？）。` +
        "请人工核对后更新本脚本的 ORIGINAL/PATCHED 片段。",
    );
    process.exit(1);
  }
  data = data.replace(patch.ORIGINAL, patch.PATCHED);
  if (!data.includes(patch.PATCHED)) {
    console.error(`[ide-patch] 写入后校验失败（补丁片段缺失）：${patch.name}`);
    process.exit(1);
  }
  console.log(`[ide-patch] ✓ 已打补丁：${patch.name}`);
}

writeFileSync(TARGET, data);
const after = readFileSync(TARGET, "utf8");
for (const patch of PATCHES) {
  if (!after.includes(patch.PATCHED)) {
    console.error(`[ide-patch] 终验失败：${patch.name}`);
    process.exit(1);
  }
}
console.log(
  "[ide-patch] ✓ 内核 agent 侧栏已从根禁用自动展开（运行期 openPanel + 启动布局强制恢复双根断）。",
);
console.log("[ide-patch] 生效：Reload Window（建议整退重启 IDE）。恢复：node scripts/disable-ide-agent-sidebar.mjs --restore");
