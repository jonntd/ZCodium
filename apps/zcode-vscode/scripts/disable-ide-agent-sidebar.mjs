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
 * 【补丁 3】「最大化辅助侧栏」原版语义是**独占窗口**：setAuxiliaryBarMaximized(true)
 * 记下四块区域的可见性后，把资源管理器（sidebar）、面板（panel）、编辑器（editor）
 * 全部隐藏，辅助栏吃掉整块窗口 —— 用户点一下最大化，正在写的标签页和文件树一起消失，
 * 再点回来虽然会恢复，但过程中编辑器被卸载重建、滚动位置/焦点丢失。
 * 本补丁只改「进入最大化」这一支：**不再隐藏任何区域**，改为把辅助栏横向撑到可用宽度的
 * 约 60%（可用宽 = grid 总宽 − 资源管理器 − 活动栏；编辑器至少保留 min(420px, 35%)），
 * 资源管理器宽度原样不动；「退出最大化」分支保持原版（把辅助栏宽度还原成
 * AUXILIARYBAR_LAST_NON_MAXIMIZED_SIZE）。
 *
 * 2026-11-09 修「点了最大化几乎没变宽」：旧式 `Math.max(当前宽, 目标)` 在目标小于当前宽
 * 时直接把拉宽变成 no-op；现改为「至少比进入前宽 80px，正常情况取 60%」，并在 setAuxiliary-
 * BarMaximized 返回后再重设一次（setTimeout 0），防止内核后续布局把 resize 覆盖回去。
 * 2026-11-10 resize 失败不再静默吞（catch 内 console.error）：内核改名/结构变化导致
 * 抛错时至少留一条可定位日志，而不是退回「最大化没反应」且零痕迹。
 * 2026-11-17 修「历史补丁变体把部署链路锁死」：2026-11-09 23:11(+0800) 实机部署用的是
 * 4f7af632 提交之前的工作区版补丁（catch 空块、无 no-op 留痕），而本脚本只认 ORIGINAL /
 * 当前 PATCHED 两种精确匹配态 → 该变体被判 unknown：--patch 拒绝执行（exit 1）、
 * --status 退出码 2、deploy.sh 尾部整条部署命令非零退出，4f7af632 的日志改动也永远
 * 部署不上。现给 maximize-keeps-editor 登记 LEGACY_PATCHED 已知历史变体（b86011ef 初版 /
 * 空块部署版 / 4f7af632 版）：--status 报 patched(legacy) 不再计 unknown（退出码 0），
 * --patch 就地迁移到当前 PATCHED（split/join，替换前后唯一性断言，写盘仍走原子替换 +
 * node --check）。迁移同时带入三处行为增强：编辑器区域隐藏时 M=0，不再空占 420px 保留
 * 宽（T 上限被不可见区域无谓压低）；目标宽 ≤ 当前宽（窄窗口/已拉满）时跳过 resizeView
 * 并 console.warn 留痕，不再静默 no-op——此前状态翻转、视觉无变化，用户感知「点了没
 * 反应」；setTimeout(0) 重设之外追加 requestAnimationFrame 再重设一次，压缩内核后续
 * 布局覆盖补丁宽度的时间窗。
 * 2026-11-19 收尾两个补丁未覆盖路径（补丁 4/5，行为见各自条目注释）：
 * 【补丁 4】setAuxiliaryBarMaximized(false) 退出分支按「进入时刻快照」重放
 * setEditorHidden/setPanelHidden/setSideBarHidden。补丁 3 之后进入最大化已不隐藏
 * 任何区域，退出却仍强设可见性 → 用户在最大化期间打开/关闭的面板、资源管理器、
 * 编辑器在还原时被强行回滚（最大化前面板隐藏、期间手动打开，还原后面板被吞）。
 * 补丁后退出分支只还原宽度、可见性一律不动。旧版「最大化残留隐藏态」自愈路径
 * （setXHidden(false)）随快照回放一并移除：进入最大化不再制造隐藏态，自愈对象
 * 不复存在，启动态归补丁 2 管辖。
 * 【补丁 5】applyAuxiliaryBarMaximizedOverride（workbench.secondarySideBar.
 * defaultVisibility= maximized/maximizedInWorkspace 的启动路径）原样把
 * SIDEBAR/PANEL/EDITOR_HIDDEN 全部置真，独占语义完全绕过补丁 3。补丁后该路径只
 * 显示辅助栏并置最大化标志，不再隐藏任何区域；拉宽不在此做（grid 未建，无法安全
 * resize）。AUXILIARYBAR_HIDDEN,!1 保留 → auditShowSites 仍按已知点登记。
 * 另核实（不改代码，撤案）：此前报告的「最大化后窗口 resize 比例失效」不成立——
 * resize 由 grid 等比重分配承接，比例天然保持；退出 IDE 时 onWillSaveState 把当前
 * 宽度写回 AUXILIARYBAR_SIZE，重启不回缩。
 * 也就是说：最大化 = 「把对话栏拉宽」，而不是「把别的都收起来」。
 *
 * 用法：
 *   node disable-ide-agent-sidebar.mjs              # 打补丁（幂等，首次自动备份）
 *   node disable-ide-agent-sidebar.mjs --dry-run    # 只报告将要做什么，不写任何文件
 *   node disable-ide-agent-sidebar.mjs --restore    # 从备份恢复原版
 *   node disable-ide-agent-sidebar.mjs --restore --force  # 内核已升级时强制回退（危险）
 *   node disable-ide-agent-sidebar.mjs --status     # 查看当前状态（未知态退出码 2）
 *
 * 安全约束（2026-11-08 审核修复）：
 *   - 写入走「同目录临时文件 + rename」原子替换：中途断掉不会留下截断的 27MB bundle；
 *   - 备份落到 ~/.gode/backup/（不再放在 app bundle 内）：IDE 更新整目录替换后备份
 *     仍在，同时不破坏 code signature 之外的可写面；
 *   - 备份旁存指纹（sha256 / size / IDE 版本 / 打补丁后的 hash）：--restore 前比对当前
 *     bundle，不一致（= IDE 已升级）就拒绝，避免把旧内核盖回新 IDE；
 *   - 参数白名单：未知参数直接报错退出（旧实现会把 --dry-run 当"打补丁"执行）；
 *   - 写盘前 `node --check` 语法自检：单行 bundle 上少一个逗号就是白屏，自检不过
 *     就不替换（原文件未动）。
 *
 * IDE 更新/重装后补丁会被覆盖，重跑本脚本即可。生效需 Reload Window（建议整退重启）。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const APP_DIR =
  process.env.IDE_APP_DIR ??
  "/Applications/Antigravity IDE.app/Contents/Resources/app";
const TARGET = join(APP_DIR, "out/vs/workbench/workbench.desktop.main.js");
const PRODUCT_JSON = join(APP_DIR, "product.json");

/**
 * 备份落点：**不在 app bundle 内**。
 * 旧版把 .bak 写在 bundle 旁边，IDE 自动更新会整目录替换 → 备份连带消失，
 * `--restore` 报"无备份"且用户无从恢复；同时往签名过的 bundle 里塞文件本身也不干净。
 */
const BACKUP_DIR =
  process.env.GODE_BACKUP_DIR ?? join(homedir(), ".gode", "backup");
const BACKUP = join(BACKUP_DIR, `${basename(TARGET)}.gode-orig.bak`);
const META = `${BACKUP}.json`;
/** 旧版备份位置（只用于一次性迁移读取，不再写入）。 */
const LEGACY_BACKUP = `${TARGET}.gode-orig.bak`;

/**
 * 最大化补丁当前版（行为增强见文件头 2026-11-17 条目）：
 *  - M（编辑器最小保留宽）按编辑器区域可见性取值：编辑器本就隐藏时取 0，
 *    不再让 T 的上限 `U-M` 被 420px 空占；
 *  - 目标宽 T ≤ 当前宽 i（窄窗口/辅助栏已拉满）时跳过 resizeView 并 console.warn
 *    留痕——此前状态照常翻转（按钮变「还原」）但布局分毫不动，静默 no-op；
 *  - setTimeout(0) 重设之外追加 requestAnimationFrame 再重设一次，压缩内核后续
 *    布局覆盖补丁宽度的时间窗。
 */
const MAXIMIZE_PATCHED =
  '(()=>{const G=this.workbenchGrid,A=G.getViewSize().width,S=this.isVisible("workbench.parts.sidebar")?G.getViewSize(this.sideBarPartView).width:0,B=this.isVisible("workbench.parts.activitybar")?G.getViewSize(this.activityBarPartView).width:0,U=Math.max(0,A-S-B),M=this.isVisible("workbench.parts.editor")?Math.min(420,Math.round(U*.35)):0,T=Math.max(i,Math.min(U-M,Math.max(i+80,Math.round(U*.6)))),F=()=>{try{G.resizeView(this.auxiliaryBarPartView,{width:T,height:G.getViewSize(this.auxiliaryBarPartView).height}),S>0&&G.getViewSize(this.sideBarPartView).width!==S&&G.resizeView(this.sideBarPartView,{width:S,height:G.getViewSize(this.sideBarPartView).height})}catch(_){console.error("[gode] maximize resize failed",_)}};T<=i?console.warn("[gode] maximize: target<=current, skip resize"):(F(),setTimeout(F,0),requestAnimationFrame(F))})(),/* gode: maximize keeps editor + sidebar visible */this.stateModel.setRuntimeValue(dr.AUXILIARYBAR_LAST_NON_MAXIMIZED_VISIBILITY,e)';

/**
 * 4f7af632 版（2026-11-14 入仓）形态：当前版去掉上述三处增强。
 * 从 MAXIMIZE_PATCHED 派生而非手抄，杜绝多份 800 字节串之间的抄写漂移。
 */
const MAXIMIZE_LEGACY_4F7AF632 = MAXIMIZE_PATCHED.replace(
  'M=this.isVisible("workbench.parts.editor")?Math.min(420,Math.round(U*.35)):0',
  "M=Math.min(420,Math.round(U*.35))",
).replace(
  'T<=i?console.warn("[gode] maximize: target<=current, skip resize"):(F(),setTimeout(F,0),requestAnimationFrame(F))',
  "F(),setTimeout(F,0)",
);

/**
 * maximize-keeps-editor 的已知历史部署变体（LEGACY_PATCHED）。同一 bundle 至多含其一，
 * --patch 对命中的变体做唯一性断言后整段替换为 MAXIMIZE_PATCHED（= 自动升级）。
 * 详见文件头 2026-11-17 条目。
 */
const MAXIMIZE_LEGACY_PATCHED = [
  // 2026-11-09 23:11(+0800) 实机部署版（先于 4f7af632 提交的工作区版）：= 4f7af632 版但
  // catch 空块。不登记则本机永远 unknown，--patch 拒绝执行、deploy.sh 尾部退出 1。
  MAXIMIZE_LEGACY_4F7AF632.replace(
    'catch(_){console.error("[gode] maximize resize failed",_)}',
    "catch(_){}",
  ),
  // 4f7af632 版：曾入仓，但当时 bundle 已是上一行变体（unknown），从未实际部署成功。
  MAXIMIZE_LEGACY_4F7AF632,
  // b86011ef 初版（2026-11-09 00:27 入仓）：无 +80 下限与重设，Math.max(当前,目标) 有
  // 「目标更小即 no-op」缺陷。显式登记（结构不同无法派生），让最老的部署机自动升级。
  '(()=>{const t=this.workbenchGrid.getViewSize().width,n=this.isVisible("workbench.parts.sidebar")?this.workbenchGrid.getViewSize(this.sideBarPartView).width:0,r=this.isVisible("workbench.parts.activitybar")?this.workbenchGrid.getViewSize(this.activityBarPartView).width:0,s=Math.max(0,t-n-r),o=Math.max(i,Math.min(Math.round(s*.6),s-Math.max(420,Math.round(s*.4))));this.workbenchGrid.resizeView(this.auxiliaryBarPartView,{width:o,height:this.workbenchGrid.getViewSize(this.auxiliaryBarPartView).height}),n>0&&this.workbenchGrid.getViewSize(this.sideBarPartView).width!==n&&this.workbenchGrid.resizeView(this.sideBarPartView,{width:n,height:this.workbenchGrid.getViewSize(this.sideBarPartView).height})})(),/* gode: maximize keeps editor + sidebar visible */this.stateModel.setRuntimeValue(dr.AUXILIARYBAR_LAST_NON_MAXIMIZED_VISIBILITY,e)',
];

/**
 * 原版 openPanel（minified，唯一）。
 * 补丁后：保留宽度调整，去掉打开容器与可见性广播。
 */
const PATCHES = [
  {
    id: "openPanel",
    name: "openPanel 运行期打开根断",
    ORIGINAL:
      'openPanel(e){const{isVisible:i}=this.getFocusState();if(i){e!==void 0&&this._setPanelWidth(e);return}this.viewsService.openViewContainer(Vpe),this._onDidChangeCascadePanelVisible.fire(!0),e!==void 0&&this._setPanelWidth(e)}',
    PATCHED:
      'openPanel(e){const{isVisible:i}=this.getFocusState();if(i){e!==void 0&&this._setPanelWidth(e);return}/* gode: agent sidebar auto-open disabled */e!==void 0&&this._setPanelWidth(e)}',
  },
  {
    id: "startup-restore",
    name: "启动布局强制恢复 agent 辅助栏 → 默认隐藏",
    ORIGINAL:
      'this.stateModel.setRuntimeValue(dr.AUXILIARYBAR_HIDDEN,!1),this.state.initialization.views.containerToRestore.auxiliaryBar=Vpe,this.updateWindowBorder(!0)',
    PATCHED:
      'this.stateModel.setRuntimeValue(dr.AUXILIARYBAR_HIDDEN,!0),this.state.initialization.views.containerToRestore.auxiliaryBar=void 0,this.updateWindowBorder(!0)/* gode: agent sidebar startup restore disabled */',
  },
  {
    id: "maximize-keeps-editor",
    name: "最大化辅助栏不再隐藏编辑器/资源管理器（改为拉宽）",
    ORIGINAL:
      'e.sideBarVisible&&this.setSideBarHidden(!0),e.panelVisible&&this.setPanelHidden(!0),e.editorVisible&&this.setEditorHidden(!0),this.stateModel.setRuntimeValue(dr.AUXILIARYBAR_LAST_NON_MAXIMIZED_VISIBILITY,e)',
    PATCHED: MAXIMIZE_PATCHED,
    LEGACY_PATCHED: MAXIMIZE_LEGACY_PATCHED,
  },
  {
    id: "maximize-exit-width-only",
    name: "最大化退出只还原宽度，不回放可见性快照",
    // 依据（2026-11-19）：补丁 3 之后进入最大化不再隐藏任何区域，退出却仍按「进入
    // 时刻快照」重放 setXHidden——最大化期间用户打开的面板被吞、关掉的编辑器被
    // 重开（修复对象 F）。宽度化语义下「快照回放」只剩害处；旧版自愈路径对象
    // （最大化制造的隐藏态）已不存在，启动态归补丁 2 管辖。三连调用在 bundle 中
    // 唯一（已断言），不会误伤面板最大化等其他路径。
    ORIGINAL:
      'this.setEditorHidden(!e?.editorVisible),this.setPanelHidden(!e?.panelVisible),this.setSideBarHidden(!e?.sideBarVisible)',
    PATCHED:
      '/* gode: maximize exit restores width only; visibility changes made while maximized are kept */',
  },
  {
    id: "startup-override-no-exclusive",
    name: "启动最大化 override 不再独占（只显示辅助栏）",
    // 依据（2026-11-19）：workbench.secondarySideBar.defaultVisibility= maximized /
    // maximizedInWorkspace 时 applyOverrides 调 applyAuxiliaryBarMaximizedOverride，
    // 原样把 SIDEBAR/PANEL/EDITOR_HIDDEN 全部置真——独占语义完全绕过补丁 3（修复
    // 对象 G，潜伏）。补丁后：保留快照记录与 WAS_LAST_MAXIMIZED 标志（按钮态一致），
    // 不再隐藏任何区域；LAST_NON_MAXIMIZED_SIZE 仍取初始化值（此时 grid 未建，无法
    // 安全拉宽）。AUXILIARYBAR_HIDDEN,!1 保留 → auditShowSites 仍按已知点登记。
    ORIGINAL:
      'applyAuxiliaryBarMaximizedOverride(){this.setRuntimeValue(dr.AUXILIARYBAR_LAST_NON_MAXIMIZED_VISIBILITY,{sideBarVisible:!this.getRuntimeValue(dr.SIDEBAR_HIDDEN),panelVisible:!this.getRuntimeValue(dr.PANEL_HIDDEN),editorVisible:!this.getRuntimeValue(dr.EDITOR_HIDDEN),auxiliaryBarVisible:!this.getRuntimeValue(dr.AUXILIARYBAR_HIDDEN)}),this.setRuntimeValue(dr.SIDEBAR_HIDDEN,!0),this.setRuntimeValue(dr.PANEL_HIDDEN,!0),this.setRuntimeValue(dr.EDITOR_HIDDEN,!0),this.setRuntimeValue(dr.AUXILIARYBAR_HIDDEN,!1),this.setRuntimeValue(dr.AUXILIARYBAR_LAST_NON_MAXIMIZED_SIZE,this.getInitializationValue(dr.AUXILIARYBAR_SIZE)),this.setRuntimeValue(dr.AUXILIARYBAR_WAS_LAST_MAXIMIZED,!0)}',
    PATCHED:
      'applyAuxiliaryBarMaximizedOverride(){this.setRuntimeValue(dr.AUXILIARYBAR_LAST_NON_MAXIMIZED_VISIBILITY,{sideBarVisible:!0,panelVisible:!0,editorVisible:!0,auxiliaryBarVisible:!this.getRuntimeValue(dr.AUXILIARYBAR_HIDDEN)}),/* gode: startup override shows aux bar without hiding editor/sidebar/panel */this.setRuntimeValue(dr.AUXILIARYBAR_HIDDEN,!1),this.setRuntimeValue(dr.AUXILIARYBAR_LAST_NON_MAXIMIZED_SIZE,this.getInitializationValue(dr.AUXILIARYBAR_SIZE)),this.setRuntimeValue(dr.AUXILIARYBAR_WAS_LAST_MAXIMIZED,!0)}',
  },
];

/**
 * 补丁之后仍然出现 `AUXILIARYBAR_HIDDEN,!1` 的**已知合法**调用点。
 *
 * 不能盲目把所有 `,!1` 都翻成 `,!0`：辅助栏「最大化 / Zen 模式」时必须可见，
 * 否则 runtime 会陷入 MAXIMIZED=true 且 HIDDEN=true 的自相矛盾状态。
 * 这里登记已知合法点，其余任何新出现的强制显示点都会被判为"未知调用点"告警——
 * IDE 升级后若多出一条新的强制显示路径，本脚本会主动报出来，而不是静默失效。
 */
const KNOWN_SHOW_SITES = [
  {
    marker: "AUXILIARYBAR_LAST_NON_MAXIMIZED_SIZE",
    note: "applyAuxiliaryBarMaximizedOverride（辅助栏最大化/Zen）：最大化必须可见，刻意不改",
  },
];

const KNOWN_FLAGS = new Set([
  "--patch",
  "--restore",
  "--status",
  "--dry-run",
  "--force",
  "--help",
  "-h",
]);

// ── 基础工具 ──────────────────────────────────────────────────────────

function fail(message) {
  console.error(`[ide-patch] ${message}`);
  process.exit(1);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** IDE 版本（product.json 的 version / commit）；读不到返回 null。 */
function ideVersion() {
  try {
    const product = JSON.parse(readFileSync(PRODUCT_JSON, "utf8"));
    const version = typeof product.version === "string" ? product.version : null;
    const commit = typeof product.commit === "string" ? product.commit.slice(0, 12) : null;
    if (!version && !commit) return null;
    return [version, commit].filter(Boolean).join("+");
  } catch {
    return null;
  }
}

/**
 * 语法自检：补丁是对 27MB 的**单行** bundle 做字符串替换，少一个逗号/多一个括号，
 * 结果都是 IDE 白屏起不来，而且没有任何可读报错（Renderer 直接 SyntaxError 挂掉）。
 * `node --check` 对 27MB 约 0.3s，完全付得起；不通过就放弃替换，原文件分毫未动。
 */
function syntaxError(file) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status === 0) return null;
  const lines = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n");
  return lines.slice(0, 6).join("\n");
}

/**
 * 原子写入：同目录临时文件 → 校验字节数 → rename。
 *
 * 直接 writeFileSync(27MB) 是**非原子**的：写入途中 Ctrl-C / 磁盘满 / 权限抖动都会
 * 留下截断的 bundle，IDE 直接起不来（备份虽在，但用户多半不知道可以 --restore）。
 * rename 在同文件系统内是原子替换：要么旧文件完好，要么新文件完整。
 */
function writeAtomic(file, contents, { validateSyntax = false } = {}) {
  const dir = dirname(file);
  // 做语法自检时临时文件名必须以 .js 结尾：`node --check` 按扩展名判定模块类型，
  // 无扩展名会直接抛 ERR_UNKNOWN_FILE_EXTENSION，把"校验不了"误报成"语法错误"。
  const tmp = join(
    dir,
    `.${basename(file)}.gode-tmp-${process.pid}${validateSyntax ? ".js" : ""}`,
  );
  // 权限位必须沿用原文件：临时文件按 umask 新建（通常 644），若原 bundle 是 640/660
  // 或带 setgid，rename 之后权限就被悄悄改了——IDE 排查这类问题极其费时。
  let mode = 0o644;
  try {
    if (existsSync(file)) mode = statSync(file).mode & 0o7777;
  } catch {
    /* 取不到就按默认 */
  }
  let fd;
  try {
    fd = openSync(tmp, "w", mode);
    writeSync(fd, contents, null, "utf8");
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    rmSync(tmp, { force: true });
    fail(`写入临时文件失败（原文件未改动）：${error instanceof Error ? error.message : error}`);
  }
  closeSync(fd);
  const expected = Buffer.byteLength(contents, "utf8");
  const { size } = statSync(tmp);
  if (size !== expected) {
    rmSync(tmp, { force: true });
    fail(`临时文件字节数不符（期望 ${expected}，实际 ${size}），已放弃替换。`);
  }
  if (validateSyntax) {
    const problem = syntaxError(tmp);
    if (problem) {
      rmSync(tmp, { force: true });
      fail(`临时文件语法校验未通过（原文件未改动）：\n${problem}`);
    }
  }
  renameSync(tmp, file);
  // 目录项也要落盘：rename 只保证"要么旧要么新"，断电后目录项未同步仍可能回到旧名。
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    /* 某些文件系统不支持对目录 fsync：退化为"至少 rename 已成功" */
  }
}

function readMeta() {
  if (!existsSync(META)) return null;
  try {
    return JSON.parse(readFileSync(META, "utf8"));
  } catch {
    return null;
  }
}

function writeMeta(meta) {
  writeAtomic(META, `${JSON.stringify(meta, null, 2)}\n`);
}

// ── 补丁状态 ──────────────────────────────────────────────────────────

/** 片段在 bundle 中出现的次数（用于断言"唯一"，replace 语义只吃第一处会假成功）。 */
function countOccurrences(data, needle) {
  let index = 0;
  let total = 0;
  while ((index = data.indexOf(needle, index)) !== -1) {
    total += 1;
    index += needle.length;
  }
  return total;
}

function patchState(data, patch) {
  if (data.includes(patch.PATCHED)) return "patched";
  // legacy = 已登记的历史部署变体（如 2026-11-09 的空 catch 版）：逻辑等价、可迁移，
  // 不算 unknown——否则该变体会把 --patch/deploy.sh 永久锁死（2026-11-17 实测）。
  if (patch.LEGACY_PATCHED?.some((variant) => data.includes(variant))) return "legacy";
  if (data.includes(patch.ORIGINAL)) return "original";
  return "unknown";
}

/**
 * 审计仍然存在的「强制显示辅助栏」调用点。
 * 返回 { known, unknown }，unknown 非空即说明有新路径（IDE 升级引入）。
 */
function auditShowSites(data) {
  const NEEDLE = "AUXILIARYBAR_HIDDEN,!1";
  const known = [];
  const unknown = [];
  let index = 0;
  while ((index = data.indexOf(NEEDLE, index)) !== -1) {
    // 前后都取：调用点的函数名特征可能在语句之前（如 `applyXxx(){...}`），
    // 协同常量可能在语句之后（`),setRuntimeValue(LAST_NON_MAXIMIZED_SIZE,...)`）。
    const context = data.slice(Math.max(0, index - 300), index + 300);
    const hit = KNOWN_SHOW_SITES.find((site) => context.includes(site.marker));
    const record = { offset: index, note: hit?.note ?? null };
    (hit ? known : unknown).push(record);
    index += NEEDLE.length;
  }
  return { known, unknown };
}

function readTargetOrFail() {
  if (!existsSync(TARGET)) fail(`未找到内核文件：${TARGET}`);
  return readFileSync(TARGET, "utf8");
}

// ── 子命令 ────────────────────────────────────────────────────────────

function status() {
  const data = readTargetOrFail();
  let unknownCount = 0;
  for (const patch of PATCHES) {
    const state = patchState(data, patch);
    if (state === "unknown") unknownCount += 1;
    // legacy 是已知历史部署变体：不算 unknown（退出码 0），提示重跑一次即可迁移。
    const label = state === "legacy" ? "patched(legacy，重跑本脚本可迁移)" : state;
    console.log(`[ide-patch] ${patch.name}：${label}`);
  }
  const { known, unknown } = auditShowSites(data);
  console.log(
    `[ide-patch] 残留强制显示点：已知合法 ${known.length} 处，未知 ${unknown.length} 处`,
  );
  for (const site of unknown) {
    console.log(`[ide-patch]   ⚠ 未知调用点 @${site.offset}（需人工核对是否要一起禁用）`);
  }
  const meta = readMeta();
  if (meta) {
    console.log(
      `[ide-patch] 备份指纹：IDE=${meta.ideVersion ?? "?"} original=${meta.originalHash?.slice(0, 12) ?? "?"} patched=${meta.patchedHash?.slice(0, 12) ?? "(未打过)"}`,
    );
  } else {
    console.log("[ide-patch] 备份指纹：无（备份缺失或为旧版布局）");
  }
  // 未知态退出码 2：自动化需要区分「未匹配」与「已打补丁」，旧版恒 0 无法判定。
  process.exit(unknownCount > 0 || unknown.length > 0 ? 2 : 0);
}

function restore({ force }) {
  const source = existsSync(BACKUP) ? BACKUP : existsSync(LEGACY_BACKUP) ? LEGACY_BACKUP : null;
  if (!source) {
    fail(
      `无备份可恢复。已查找：\n  1) ${BACKUP}\n  2) ${LEGACY_BACKUP}\n` +
        "如备份随 IDE 更新丢失，请重新安装 IDE（或从 Time Machine 取回 bundle）。",
    );
  }
  const backup = readFileSync(source);
  const current = readFileSync(TARGET);
  const meta = readMeta();

  // 指纹校验：备份是「打补丁那一刻」的内核。IDE 自动升级后 bundle 已换新，
  // 用旧备份整文件覆盖 = 内核回退到旧版本（工作台 JS 与 product.json / 扩展 API
  // 版本错配 → 随机崩溃或功能缺失，极难归因）。
  if (meta) {
    const currentHash = sha256(current);
    const allowed = new Set([meta.patchedHash, meta.originalHash].filter(Boolean));
    if (allowed.size > 0 && !allowed.has(currentHash)) {
      const detail =
        `当前内核 hash=${currentHash.slice(0, 12)} 与备份记录的 ` +
        `patched=${meta.patchedHash?.slice(0, 12) ?? "-"} / original=${meta.originalHash?.slice(0, 12) ?? "-"} 不一致。` +
        `\n  备份时 IDE 版本：${meta.ideVersion ?? "?"}；当前 IDE 版本：${ideVersion() ?? "?"}`;
      if (!force) {
        console.error(`[ide-patch] 拒绝恢复：${detail}`);
        console.error(
          "[ide-patch] 这通常意味着 IDE 已升级，旧备份会覆盖掉新内核。" +
            "请直接删除备份目录后再重装/更新 IDE；如确认要冒险回退，加 --force。",
        );
        process.exit(1);
      }
      console.error(`[ide-patch] ⚠ --force：忽略指纹不一致强行恢复（可能导致 IDE 无法启动）`);
    }
  } else if (!force) {
    console.error(
      "[ide-patch] 备份缺少指纹文件（旧版脚本产生），无法判断 IDE 是否已升级。" +
        `\n  IDE 当前版本：${ideVersion() ?? "?"}` +
        "\n  如确认 IDE 未升级，加 --force 覆盖恢复。",
    );
    process.exit(1);
  }

  writeAtomic(TARGET, backup, { validateSyntax: true });
  rmSync(META, { force: true });
  console.log(`[ide-patch] 已恢复原版 ← ${source}（Reload Window 生效）`);
}

function patch({ dryRun }) {
  let data = readTargetOrFail();
  const states = PATCHES.map((patch) => [patch, patchState(data, patch)]);
  // legacy 也是「补丁态」（只是旧变体）：备份守卫同样不能把它当原版建基线。
  const alreadyPatched = states.some(
    ([, state]) => state === "patched" || state === "legacy",
  );

  // 备份：首补丁时创建。若 bundle 已经是补丁态而备份缺失，**不能**把当前文件
  // 当原版备份（那是补丁版，恢复回去等于没恢复）——必须让人重装。
  if (!existsSync(BACKUP)) {
    if (alreadyPatched && !existsSync(LEGACY_BACKUP)) {
      fail(
        "内核已是补丁状态，但找不到原版备份，无法建立可回退基线。\n" +
          "请重新安装/更新 IDE 后重跑本脚本（不会改动内核）。",
      );
    }
    const source = existsSync(LEGACY_BACKUP) ? LEGACY_BACKUP : TARGET;
    if (dryRun) {
      console.log(`[ide-patch] (dry-run) 将备份原版 → ${BACKUP}（源：${source}）`);
    } else {
      mkdirSync(BACKUP_DIR, { recursive: true });
      copyFileSync(source, BACKUP);
      const backupBytes = readFileSync(BACKUP);
      writeMeta({
        createdAt: new Date().toISOString(),
        ideVersion: ideVersion(),
        source,
        size: backupBytes.length,
        originalHash: sha256(backupBytes),
        patchedHash: alreadyPatched ? sha256(readFileSync(TARGET)) : null,
      });
      console.log(`[ide-patch] 已备份原版 → ${BACKUP}（${backupBytes.length} bytes）`);
    }
  } else {
    console.log(`[ide-patch] 备份已存在，跳过备份：${BACKUP}`);
  }

  for (const [entry, state] of states) {
    if (state === "patched") {
      console.log(`[ide-patch] ✓ 已是补丁状态，跳过：${entry.name}`);
      continue;
    }
    if (state === "legacy") {
      // 已知历史部署变体 → 当前 PATCHED：整段替换（语义等价 + 补回增强），与原版路径
      // 共用同一套写盘安全检查（唯一性断言 / 原子替换 / node --check / 终验）。
      const variants = entry.LEGACY_PATCHED.filter((variant) => data.includes(variant));
      for (const variant of variants) {
        const hits = countOccurrences(data, variant);
        if (hits !== 1) {
          fail(
            `历史补丁变体在 bundle 中出现 ${hits} 处（期望恰好 1 处）：${entry.name}。` +
              "已中止，未写入。",
          );
        }
        data = data.split(variant).join(entry.PATCHED);
      }
      if (!data.includes(entry.PATCHED)) {
        fail(`写入前自检失败（补丁片段缺失）：${entry.name}`);
      }
      console.log(
        `[ide-patch] ✓ ${dryRun ? "(dry-run) 将迁移" : "已迁移"}历史补丁变体 → 当前版：${entry.name}`,
      );
      continue;
    }
    if (state !== "original") {
      fail(
        `内核 bundle 与「${entry.name}」的已知原版/历史变体均不匹配（IDE 版本更新，或出现未登记的补丁变体？）。\n` +
          "请人工核对后更新本脚本的 ORIGINAL/PATCHED/LEGACY_PATCHED 片段；本次未写入任何文件。",
      );
    }
    const hits = countOccurrences(data, entry.ORIGINAL);
    if (hits !== 1) {
      fail(
        `原版片段在 bundle 中出现 ${hits} 处（期望恰好 1 处）：${entry.name}。` +
          "字符串替换只改第一处，静默漏补丁会造成「以为已修好」。已中止，未写入。",
      );
    }
    // split/join 而不是 String.replace：replace 的替换串会对 `$&`/`$1` 做展开，
    // PATCHED 将来含 `$` 时会被改写（隐蔽的数据损坏）。
    data = data.split(entry.ORIGINAL).join(entry.PATCHED);
    if (!data.includes(entry.PATCHED)) {
      fail(`写入前自检失败（补丁片段缺失）：${entry.name}`);
    }
    console.log(`[ide-patch] ✓ ${dryRun ? "(dry-run) 将打补丁" : "已打补丁"}：${entry.name}`);
  }

  const audit = auditShowSites(data);
  for (const site of audit.unknown) {
    console.warn(
      `[ide-patch] ⚠ 未知的「强制显示辅助栏」调用点 @${site.offset}：` +
        "IDE 可能新增了绕过补丁的路径，请人工核对。",
    );
  }

  if (dryRun) {
    console.log("[ide-patch] (dry-run) 未写入内核文件。");
    return;
  }

  writeAtomic(TARGET, data, { validateSyntax: true });
  const after = readFileSync(TARGET);
  for (const [entry] of states) {
    if (!after.includes(entry.PATCHED)) fail(`终验失败：${entry.name}`);
  }
  // 指纹：已有则更新 patchedHash；缺失（旧版脚本遗留的裸备份）则从备份文件反推
  // originalHash 补齐——否则日后的 --restore 永远只能靠 --force 冒险。
  const existingMeta = readMeta();
  const patchedHash = sha256(after);
  if (existingMeta) {
    writeMeta({ ...existingMeta, patchedHash, patchedAt: new Date().toISOString() });
  } else if (existsSync(BACKUP)) {
    writeMeta({
      createdAt: new Date().toISOString(),
      ideVersion: ideVersion(),
      source: "legacy-backup",
      size: statSync(BACKUP).size,
      originalHash: sha256(readFileSync(BACKUP)),
      patchedHash,
      patchedAt: new Date().toISOString(),
    });
    console.log("[ide-patch] 已为遗留备份补齐指纹（此后 --restore 会校验 IDE 是否升级）");
  }
  console.log(
    "[ide-patch] ✓ 内核 agent 侧栏已从根禁用自动展开（运行期 openPanel + 启动布局强制恢复双根断）。",
  );
  console.log(
    "[ide-patch] ✓ 辅助栏「最大化」改为只拉宽自身：编辑器标签页与资源管理器保持可见。",
  );
  console.log(
    "[ide-patch] 生效：Reload Window（建议整退重启 IDE）。恢复：node scripts/disable-ide-agent-sidebar.mjs --restore",
  );
}

// ── 入口 ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const unknownFlags = argv.filter((arg) => !KNOWN_FLAGS.has(arg));
if (unknownFlags.length > 0) {
  // 旧实现把任意未知参数当"打补丁"执行：`--dry-run`/`-h` 会真的改内核。
  fail(`未知参数：${unknownFlags.join(" ")}（可用：${[...KNOWN_FLAGS].join(" ")}）`);
}
const flags = new Set(argv);
const dryRun = flags.has("--dry-run");
const force = flags.has("--force");

if (flags.has("--help") || flags.has("-h")) {
  console.log(
    [
      "用法：node scripts/disable-ide-agent-sidebar.mjs [选项]",
      "  （无选项）        打补丁（幂等，首次自动备份到 ~/.gode/backup）",
      "  --dry-run         只报告，不写任何文件",
      "  --status          查看补丁状态（未知态退出码 2）",
      "  --restore         从备份恢复原版（指纹不一致会拒绝）",
      "  --restore --force 忽略指纹校验强制恢复（危险）",
      "  --help, -h        本帮助",
    ].join("\n"),
  );
  process.exit(0);
}

if (flags.has("--status")) status();
else if (flags.has("--restore")) restore({ force });
else patch({ dryRun });
