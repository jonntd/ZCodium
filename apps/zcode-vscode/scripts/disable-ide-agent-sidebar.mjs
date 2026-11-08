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
 *   - 参数白名单：未知参数直接报错退出（旧实现会把 --dry-run 当"打补丁"执行）。
 *
 * IDE 更新/重装后补丁会被覆盖，重跑本脚本即可。生效需 Reload Window（建议整退重启）。
 */
import { createHash } from "node:crypto";
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
 * 原子写入：同目录临时文件 → 校验字节数 → rename。
 *
 * 直接 writeFileSync(27MB) 是**非原子**的：写入途中 Ctrl-C / 磁盘满 / 权限抖动都会
 * 留下截断的 bundle，IDE 直接起不来（备份虽在，但用户多半不知道可以 --restore）。
 * rename 在同文件系统内是原子替换：要么旧文件完好，要么新文件完整。
 */
function writeAtomic(file, contents) {
  const dir = dirname(file);
  const tmp = join(dir, `.${basename(file)}.gode-tmp-${process.pid}`);
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
    console.log(`[ide-patch] ${patch.name}：${state}`);
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

  writeAtomic(TARGET, backup);
  rmSync(META, { force: true });
  console.log(`[ide-patch] 已恢复原版 ← ${source}（Reload Window 生效）`);
}

function patch({ dryRun }) {
  let data = readTargetOrFail();
  const states = PATCHES.map((patch) => [patch, patchState(data, patch)]);
  const alreadyPatched = states.some(([, state]) => state === "patched");

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
    if (state !== "original") {
      fail(
        `内核 bundle 与「${entry.name}」的已知原版不匹配（IDE 版本更新？）。\n` +
          "请人工核对后更新本脚本的 ORIGINAL/PATCHED 片段；本次未写入任何文件。",
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
    console.log(`[ide-patch] ✓ 已打补丁：${entry.name}`);
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

  writeAtomic(TARGET, data);
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
