/**
 * 扩展贡献点一致性回归（真机教训 2026-11-07 / 11-08）。
 *
 * 两组契约：
 * 1) 「文件改动历史」TreeView 及其命令族已按产品决策整体移除，不得在清单或
 *    装配里留下半截引用（历史上改名前 view/title 残留 "view == code.chat"
 *    导致标题栏 5 个按钮全部消失）；
 * 2) 聊天卡片里的「审查 / 打开」是保留功能，其宿主 RPC 白名单与实现必须存在。
 *
 * 纯 headless（fs + JSON + 源码正则），不需要 vscode 运行时。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");

interface ContributedView {
  id: string;
}
interface ContributedCommand {
  command: string;
  icon?: string;
}
interface MenuEntry {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}
interface Manifest {
  contributes: {
    viewsContainers?: { activitybar?: Array<{ id: string }> };
    views?: Record<string, ContributedView[]>;
    commands?: ContributedCommand[];
    menus?: Record<string, MenuEntry[]>;
  };
}

const manifest = JSON.parse(
  readFileSync(resolve(ROOT, "package.json"), "utf8"),
) as Manifest;
const contributes = manifest.contributes;
const viewIds = new Set(
  Object.values(contributes.views ?? {}).flatMap((views) => views.map((view) => view.id)),
);
const declaredCommands = new Set((contributes.commands ?? []).map((entry) => entry.command));
const menuEntries = Object.values(contributes.menus ?? {}).flat();
const manifestText = JSON.stringify(contributes, null, 2);

const readSource = (relativePath: string): string =>
  readFileSync(resolve(ROOT, relativePath), "utf8");

describe("「文件改动历史」已整体移除", () => {
  it("视图只剩 gode.chat", () => {
    expect([...viewIds]).toEqual(["gode.chat"]);
    expect(manifestText).not.toContain("gode.changesHistory");
  });

  it("容器 ID 已更换，旧布局缓存键 workbench.view.extension.gode.* 不再被复用", () => {
    const containerId = manifest.contributes.viewsContainers?.activitybar?.[0]?.id;
    expect(containerId).toBeTruthy();
    expect(containerId).not.toBe("gode");
    expect(Object.keys(manifest.contributes.views ?? {})).toEqual([containerId]);
  });

  it("清单无 gode.changes.* 命令、无 pendingFile / changesHistory 菜单", () => {
    expect([...declaredCommands].filter((command) => command.startsWith("gode.changes."))).toEqual(
      [],
    );
    expect(manifestText).not.toContain("gode.pendingFile");
    expect(manifestText).not.toContain("gode.changes.");
  });

  it("宿主装配不再创建 TreeView，也不再注册 changes 命令族", () => {
    const container = readSource("src/container.ts");
    expect(container).not.toContain("createTreeView");
    expect(container).not.toContain("gode.changes.refresh");
    expect(container).not.toContain("wirePendingChanges");
  });
});

describe("贡献点一致性", () => {
  it("所有 view == 的 when 引用都指向真实注册的视图", () => {
    const referenced = menuEntries.flatMap((entry) =>
      typeof entry.when === "string"
        ? [...entry.when.matchAll(/\bview\s*==\s*([A-Za-z0-9_.-]+)/g)].map((match) => match[1]!)
        : [],
    );
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((id) => !viewIds.has(id))).toEqual([]);
  });

  it("对话视图 ID 源码常量与清单一致（改名不再留下 when 残留）", () => {
    const match = readSource("src/ui/chatPanel.ts").match(/CHAT_VIEW_ID\s*=\s*"([^"]+)"/);
    expect(match?.[1]).toBeDefined();
    expect(viewIds.has(match![1]!)).toBe(true);
    const newSessionMenus = (contributes.menus?.["view/title"] ?? []).filter(
      (entry) => entry.command === "gode.newSession",
    );
    expect(newSessionMenus).toHaveLength(1);
    expect(newSessionMenus[0]!.when).toContain(`view == ${match![1]}`);
  });

  it("菜单引用的命令都已声明（或为宿主内置命令）", () => {
    const builtinPrefix = /^(vscode|workbench|editor|explorer|setContext|notebook|git|testing)\./;
    const referenced = menuEntries
      .filter((entry) => typeof entry.command === "string")
      .map((entry) => entry.command!);
    expect(referenced.length).toBeGreaterThan(0);
    expect(
      referenced.filter(
        (command) => !declaredCommands.has(command) && !builtinPrefix.test(command),
      ),
    ).toEqual([]);
  });
});

describe("聊天卡片「审查 / 打开」保留能力", () => {
  it("RPC 白名单放行两个宿主编辑器直开方法", () => {
    const handler = readSource("src/host/platformRpcHandler.ts");
    expect(handler).toContain('"openFileInEditor"');
    expect(handler).toContain('"openPatchDiffInEditor"');
  });

  it("容器仍实现两方法，审查复用 ChangesDiffOpener 原生双栏 diff", () => {
    const container = readSource("src/container.ts");
    expect(container).toContain("openFileInEditor:");
    expect(container).toContain("openPatchDiffInEditor:");
    expect(container).toContain("new ChangesDiffOpener()");
    expect(container).toContain("opener.openPendingDiff(");
    expect(container).toContain('executeCommand("vscode.open"');
    // 安全审查 S1：文件内容读面收敛到 workspace 内（fail-closed），不做任意读。
    expect(container).toContain("isPathInsideWorkspace(resolvedPath, folders)");
    expect(container).toContain(
      '"openPatchDiffInEditor: resolvedPath 不在 workspace 内，已拒绝"',
    );
    // 安全审查 S4：patches 形状宽松解析（RPC 面不做 as 断言）。
    expect(container).toContain("parsePatchHunks(request.patches)");
    // 性能审查 P3：diff 内容缓存 LRU 有界（8 条），不做无界 Map。
    const diffOpener = readSource("src/host/pendingChanges/diffOpener.ts");
    expect(diffOpener).toContain("MAX_DIFF_CACHE_ENTRIES = 8");
    expect(diffOpener).toContain("cacheSet(");
    expect(diffOpener).not.toContain("Date.now().toString(36)");
  });

  it("安全加固：webview CSP nonce 密码学随机 + fileDrop 附件大小上限", () => {
    // 安全审查 S3：Math.random 可预测，nonce 是 CSP 唯一脚本信凭。
    const chatPanel = readSource("src/ui/chatPanel.ts");
    expect(chatPanel).toContain("randomBytes(16).toString(\"hex\")");
    expect(chatPanel).not.toContain("Math.random().toString(36)");
    // 性能审查 P4：fileDrop 超 20MB 静默过滤，边界值放行。
    const resolver = readSource("src/host/fileDropResolver.ts");
    expect(resolver).toContain("MAX_FILE_DROP_BYTES = 20 * 1024 * 1024");
    expect(resolver).toContain("stat.sizeBytes > maxFileBytes");
    // 纯层校验器存在且有单测（S1 的可测核心）。
    const containment = readSource("src/host/pathContainment.ts");
    expect(containment).toContain("export function isPathInsideWorkspace");
    expect(existsSync(resolve(ROOT, "test/pathContainment.test.ts"))).toBe(true);
    // S2：resolveChangePath 逃逸 fail-closed（返回 null，脏数据不入账）。
    const tracker = readSource("src/host/pendingChanges/changesTracker.ts");
    expect(tracker).toContain("isPathInsideWorkspace(resolved, [workspaceRoot])");
    expect(tracker).toContain("string | null");
  });

  it("性能加固：持久化合批 + 历史重建跳过 + 导入裁剪（P1/P2）", () => {
    // P1：tracker.onChange 不再直连 persist——经 DebouncedPersister 合批，
    // dispose flush 尾笔；窗口可注入（测试 0ms 同步直写）。
    const service = readSource("src/host/pendingChanges/changesService.ts");
    expect(service).toContain("new DebouncedPersister(");
    expect(service).toContain("options.persistDebounceMs ?? 250");
    expect(service).toContain("this.persister.dispose();");
    expect(existsSync(resolve(ROOT, "test/debouncedPersister.test.ts"))).toBe(true);
    // P2：superseded 标记先命中判定再重建（不无差别全量 set）；导入后统一裁剪。
    const tracker = readSource("src/host/pendingChanges/changesTracker.ts");
    expect(tracker).toContain("const hit = turn.files.some(");
    expect(tracker).toContain("this.history.size > HISTORY_TURN_LIMIT");
    expect(tracker).toContain("compareHistoryAsc");
  });
});

describe("VS Code 宿主：去掉与 IDE 原生能力重复的 UI", () => {
  const UI_ROOT = resolve(ROOT, "../../packages/ui/src");
  const readUi = (relativePath: string): string =>
    readFileSync(resolve(UI_ROOT, relativePath), "utf8");

  it("平台声明 nativeTerminalHost，且 IPlatformService 有对应可选能力位", () => {
    expect(
      readSource("src/webview-react/platform/vscodePlatformService.ts"),
    ).toContain("readonly nativeTerminalHost = true");
    expect(
      readFileSync(resolve(ROOT, "../../packages/shared/src/platform.ts"), "utf8"),
    ).toContain("readonly nativeTerminalHost?: boolean");
  });

  it("顶栏在原生宿主里隐藏帮助菜单与终端切换按钮", () => {
    const header = readUi("WorkspaceHeaderSections/WorkspaceHeaderActionSection.tsx");
    expect(header).toContain("useOptionalPlatform()?.nativeTerminalHost");
    expect(header).toContain("!simplifyForNarrowRemote && !nativeTerminalHost");
  });

  it("布局不再挂载自绘终端面板（node-pty 在插件运行时不可用）", () => {
    const layout = readUi("app-shell/WorkspaceShellLayout.tsx");
    expect(layout).toContain("useOptionalPlatform()?.nativeTerminalHost");
    expect(layout).toContain("!nativeTerminalHost &&");
    expect(layout.indexOf("!nativeTerminalHost &&")).toBeLessThan(
      layout.indexOf("<AnimatedTerminalPanel"),
    );
  });

  it("历史布局里残留的 side pane terminal tab 也不再挂载 PTY 面板", () => {
    const sidePane = readUi("app-shell/AnimatedSidePanePanel.tsx");
    expect(sidePane).toContain("useOptionalPlatform()?.nativeTerminalHost");
    expect(sidePane).toContain("nativeTerminalHost ? null : (");
  });

  it("插件宿主移除「在 IDE 中打开」入口，selectedEditor 无效状态链已清空", () => {
    const action = readUi("WorkspaceHeaderSections/WorkspaceHeaderActionSection.tsx");
    expect(action).toContain('variant === "task" && !nativeTerminalHost');
    const header = readUi("WorkspaceHeader.tsx");
    expect(header).not.toContain("selectedEditor");
    expect(header).not.toContain("onSelectedEditorChange");
    // 顶栏压成紧凑单行，与原生标题栏对齐、不换行、不重叠。
    expect(header).toContain('"h-9 min-w-0 flex-nowrap overflow-hidden"');
    const sections = readUi("WorkspaceHeaderSections.tsx");
    expect(sections).not.toContain("selectedEditor");
    const shared = readUi("WorkspaceHeaderSections/shared.ts");
    expect(shared).not.toContain("selectedEditor");
    expect(shared).not.toContain("onSelectedEditorChange");
    expect(shared).not.toContain("EditorInfo");
  });

  it("能力投影不再生成链路降级提示横幅", () => {
    const capabilities = readSource("src/webview-react/capabilities.ts");
    expect(capabilities).not.toContain("binaryFrameHint");
    expect(capabilities).not.toContain("CAPABILITY_BINARY_FRAME_HINT");
    expect(capabilities).not.toContain("当前链路不支持二进制帧");
    // 仍在用：能力面整体缺失的 warning 提示及其 store 通道。
    expect(capabilities).toContain("CAPABILITY_UNSUPPORTED_HINT");
    expect(capabilities).toContain('tone: "warning"');
  });
});

describe("webview 内会话标签栏（已按用户反馈移除 UI）", () => {
  it("App 不再渲染 SessionTabBar 与空态「历史会话」CTA（与 IDE 原生编辑器标签视觉重复）", () => {
    const app = readSource("src/webview-react/App.tsx");
    expect(app).not.toContain("<SessionTabBar");
    // CTA 特有标识（注释里的「历史会话」字样合法保留，只锁 UI/链路面）。
    expect(app).not.toContain("isDraftActive");
    expect(app).not.toContain("requestSessionPicker");
    expect(app).not.toContain("<Button");
    // 底层标签状态机保留：会话绑定 / 本地持久化 / 跨页共享仍由它驱动。
    expect(app).toContain("SESSION_TAB_STORAGE_KEY");
    expect(app).toContain("bindActiveSession(");
  });

  it("SessionTabBar 组件文件已删除", () => {
    const { existsSync } = require("node:fs");
    const { join } = require("node:path");
    expect(
      existsSync(join(__dirname, "..", "src", "webview-react", "SessionTabBar.tsx")),
    ).toBe(false);
  });

  it("状态机纯函数覆盖重排/锁定/关闭", () => {
    const logic = readSource("src/webview-react/sessionTabs.ts");
    expect(logic).toContain("export function reorderSessionTabs");
    expect(logic).toContain("export function toggleSessionTabPinned");
    expect(logic).toContain("export function canCloseSessionTab");
    expect(logic).toContain("export function closeSessionTab");
  });

  it("标签标题/忙态上行与多页签共享接线（Claude 同款体验）", () => {
    const app = readSource("src/webview-react/App.tsx");
    // 编辑器标签标题 = 活动会话任务标题 + 忙态；经 plat-evt 上行（fire-and-forget）。
    expect(app).toContain("notifyEditorTabUi?.(");
    // 忙态口径与任务列表一致：streaming/creating/restoring。
    for (const busyStatus of ['"streaming"', '"creating"', '"restoring"']) {
      expect(app).toContain(busyStatus);
    }
    // 多页签共享：全集上行 + session-tabs 帧应用（JSON 快照比对抑制回声环）。
    expect(app).toContain("syncSessionTabs?.(");
    expect(app).toContain('frameBus.on<SessionTabsHostFramePayload>("session-tabs"');
    expect(app).toContain("lastSyncedTabsJsonRef");
    // composer 聚焦：webview 激活/窗口聚焦时把焦点交给输入框（store 聚焦链路）。
    expect(app).toContain("requestComposerFocus(workspacePath)");
    expect(app).toContain('window.addEventListener("focus", focusComposer)');
    // 选中标签本地持久化（各编辑器页签独立选会话，不跨页中继）。
    expect(app).toContain("SESSION_TAB_ACTIVE_STORAGE_KEY");
  });
});

describe("可拖动的编辑器标签页形态", () => {
  it("清单声明命令并在对话视图标题栏提供入口", () => {
    expect(declaredCommands.has("gode.openChatInEditor")).toBe(true);
    const entry = (contributes.menus?.["view/title"] ?? []).find(
      (item) => item.command === "gode.openChatInEditor",
    );
    expect(entry?.when).toBe("view == gode.chat");
    // 「打开对话」默认即编辑器标签形态（与 Claude Code tab 同款），不再聚焦侧栏。
    expect(declaredCommands.has("gode.openChat")).toBe(true);
  });

  it("编辑器标签行只保留新建/历史会话两个按钮（纯导航入口；重启/切工作区/停止等命令按钮已清理）", () => {
    const editorTitle = contributes.menus?.["editor/title"] ?? [];
    // 锁定组不放自定义按钮：IDE 原生锁定 UI 更完整（tab 右键锁定 + 锁定后原生锁
    // 指示器点击解锁），自定义 $(lock) 按钮会与原生指示器重复显示两个锁。
    expect(editorTitle.map((item) => item.command)).toEqual([
      "gode.newSession",
      "gode.pickSession",
      "gode.toggleChatFullscreen",
    ]);
    // when 值带点号必须加引号，否则 when 解析器按 key 路径比较，按钮永不显示。
    for (const item of editorTitle) {
      expect(item.when).toContain("activeWebviewPanelId == 'gode.chatEditor'");
      expect(item.group).toMatch(/^navigation@\d$/);
    }
    // 最大化按钮必须与 IDE 原生按钮互斥：内核 workbench.action.toggleMaximizeEditorGroup
    // 自带 editor/title 按钮（order -1e4、icon screenFull、when editorPartMaximizedEditorGroup），
    // 已最大化时会出现在最左侧并高亮。我们只在「未最大化」时显示，最大化后交给原生还原，
    // 否则两个一模一样的 $(screen-full) 会并排（用户实测反馈）。
    const fullscreen = editorTitle.find((item) => item.command === "gode.toggleChatFullscreen");
    expect(fullscreen?.when).toBe(
      "activeWebviewPanelId == 'gode.chatEditor' && !editorPartMaximizedEditorGroup",
    );
    // 全屏按钮：转发 IDE 原生 toggleMaximizeEditorGroup（只重排编辑器组，不动侧栏）。
    expect(contributes.commands?.find((c) => c.command === "gode.toggleChatFullscreen")?.icon).toBe(
      "$(screen-full)",
    );
    expect(readSource("src/commands/hostCommands.ts")).toContain(
      "workbench.action.toggleMaximizeEditorGroup",
    );
    const editorTitleCtx = contributes.menus?.["editor/title/context"] ?? [];
    // 仅保留原有的加入上下文入口。
    expect(editorTitleCtx.map((item) => item.command)).toEqual(["gode.addFileToContext"]);
  });

  it("实现用 WebviewPanel 且复用侧栏同一份 HTML/服务桥", () => {
    const editorPanel = readSource("src/ui/chatEditorPanel.ts");
    expect(editorPanel).toContain("createWebviewPanel(");
    expect(editorPanel).toContain("ViewColumn.Beside");
    expect(editorPanel).toContain("retainContextWhenHidden: true");
    expect(editorPanel).toContain("buildChatWebviewHtml(");
    // 多页签：每个面板按独立 bridge id 连接（首个沿用常量，后续递增后缀）。
    expect(editorPanel).toContain("attachWebview(bridgeId");
    expect(editorPanel).toContain("detachWebview(bridgeId");
    const chatPanel = readSource("src/ui/chatPanel.ts");
    expect(chatPanel).toContain("export function buildChatWebviewHtml(");
    expect(chatPanel).toContain("attachWebview(CHAT_VIEW_ID");
    // 增量审查 X3：resolveWebviewView 可能被多次调用（webview 重建/重解析），
    // 监听必须挂在本轮 subscriptions 上并在重复 resolve/dispose 时先清，
    // 否则 onDidReceiveMessage 叠加 → 一条 webview 消息被重复处理（RPC 重复执行）。
    expect(chatPanel).toContain("resolveSubscriptions");
    expect(chatPanel).toContain("for (const disposable of this.resolveSubscriptions) disposable.dispose();");
    // host 侧对称防御：同 id 重复 attach 先拆旧连接 + dispose 回调身份校验。
    const hostRuntime = readSource("src/host/hostRuntime.ts");
    expect(hostRuntime).toContain("if (this.connections.has(id)) this.detachWebview(id);");
    expect(hostRuntime).toContain("current.sender === sender");
  });

  it("容器装配、命令注册与释放链完整", () => {
    const container = readSource("src/container.ts");
    expect(container).toContain("new ChatEditorPanel(");
    expect(container).toContain("chatEditorPanel: container.chatEditorPanel");
    expect(container).toContain("chatEditorPanel.dispose()");
    // 侧栏跳板：视图可见 → 聚焦编辑器标签（收栏逻辑内聚在 ChatEditorPanel.reveal）。
    expect(container).toContain("chatEditorPanel.reveal();");
    expect(container).toContain("new ChatPanel(");
    // 编辑器标签 UI 上行接线 + 会话标签共享持久化（workspaceState 适配）。
    expect(container).toContain("onEditorTabUi: (connectionId, payload)");
    expect(container).toContain("sessionTabsPersistence:");
    expect(container).toContain('SESSION_TABS_HOST_KEY = "gode.sessionTabs.host"');
    // 空态「历史会话」上行链已随 CTA 移除；历史入口 = 编辑器 title 按钮 + gode.pickSession。
    expect(container).not.toContain("onRequestSessionPicker");
    expect(container).not.toContain("requestSessionPicker");
    // 一次性上手卡：首次打开对话自动呈现（globalState 标记持久化）。
    expect(container).toContain("presentOnboardingOnce(): void");
    expect(container).toContain('"gode.onboarding.autoPresented"');
    expect(container).toContain("firstOpen: () => container.presentOnboardingOnce()");
    const hostCommands = readSource("src/commands/hostCommands.ts");
    expect(hostCommands).toContain('registerCommand("gode.openChatInEditor"');
    // openChat 与全部推帧命令（诊断/新会话/切工作区）聚焦编辑器标签而非侧栏。
    // openChat/openChatInEditor 共用 openChat 处理器（含首次打开的一次性上手卡钩子）。
    expect(hostCommands).toContain("const openChat = () => {");
    expect(hostCommands).toContain('registerCommand("gode.openChat", openChat)');
    // 首次打开对话自动呈现上手卡（一次性，globalState 标记在容器侧）。
    expect(hostCommands).toContain("deps.firstOpen?.()");
    // 新会话帧**定向**给最近活动页（回草稿是当前页 UI 动作，广播会拉回其他页签）。
    expect(hostCommands).toContain(
      'deps.hostRuntime.pushToActiveHostFrame("workspace", payload)',
    );
    expect(hostCommands).not.toContain("deps.chatPanel.reveal");
    expect(hostCommands).not.toContain("chatPanel: { reveal(): void }");
    // 收起被 IDE 自动展开的侧栏：延迟多点重试（IDE 展开时点不固定——布局动画/
    // 视图恢复后都可能再展开一次，单次延迟可能输掉竞争；幂等收栏无误伤）。
    const editorPanel = readSource("src/ui/chatEditorPanel.ts");
    expect(editorPanel).toContain("workbench.action.closeAuxiliaryBar");
    expect(editorPanel).toContain("workbench.action.closeSidebar");
    // 收栏窗口 [350, 800, 1500, 3000]：多点重试覆盖 IDE 展开时点不固定的竞争；
    // 窗口锚定在聚焦事件上（见下），加长尾重试不会误伤用户手动展开的侧栏。
    expect(editorPanel).toContain("const delays = [350, 800, 1_500, 3_000];");
    // X1：单飞去重（一轮窗口重复调用不叠加 timer）+ dispose 取消在途调度。
    expect(editorPanel).toContain("if (sidePanelsCollapseTimers.length > 0) return;");
    expect(editorPanel).toContain("cancelSidePanelsCollapse();");
    // reveal 入口统一调度收栏（命令与侧栏跳板共用同一份逻辑）。
    expect(editorPanel).toContain("scheduleSidePanelsCollapse();");
    // 收栏锚点跟随真实聚焦：渲染器首帧上行 + 页签变为可见——IDE 对 agent webview
    // 的聚焦自动展开可迟到数秒（渲染器加载完才持焦点），仅锚按钮点击会输掉竞争
    // （用户实测：点 + 后侧栏在收栏窗口关闭后才被 IDE 展开、开着不走）。
    expect(editorPanel).toContain("armedOnFirstFrame");
    expect(editorPanel).toContain("onDidChangeViewState");
    // 已可见面板优先聚焦（不做冗余 focus——editor/title 的 + 按钮 when 门控保证
    // 点击时面板已激活，冗余 focus 会触发 IDE agent 侧栏联动「点新建会话侧栏被打开」）。
    expect(editorPanel).toContain("find((panel) => panel.visible)");
    // 多页签上限：每个页签是完整 webview 实例，openNew 达上限退化为聚焦。
    expect(editorPanel).toContain("MAX_CHAT_EDITOR_TABS = 4");
    expect(editorPanel).toContain("if (this.panels.size >= MAX_CHAT_EDITOR_TABS)");
    // 编辑器标签标题跟随（Claude 同款）：webview 上行标签 UI（会话标题/忙态）
    // → host 回写 panel.title；仅消费编辑器形态连接（前缀过滤）。
    expect(editorPanel).toContain("handleEditorTabUi(connectionId");
    expect(editorPanel).toContain("composeEditorTabTitle(");
    expect(editorPanel).toContain('startsWith(CHAT_EDITOR_BRIDGE_ID)');
  });

  it("侧栏视图内置可见跳板（webview view 无法拖进编辑器标签行的补偿）", () => {
    const chatPanel = readSource("src/ui/chatPanel.ts");
    expect(chatPanel).toContain("private readonly onVisible?: () => void");
    expect(chatPanel).toContain("if (view.visible) this.onVisible?.()");
  });

  it("X4：无界内存面收敛（审批登记与 quick-edit 快照均有上限）", () => {
    // ApprovalService.requests 只增不减：input 可携带整文件内容，长会话无界增长。
    // resolved 按插入序淘汰，pending/pendingRestore 永不驱逐（幂等与重放语义不受影响）。
    const approval = readSource("src/approvals/approvalService.ts");
    expect(approval).toContain("DEFAULT_MAX_RETAINED_REQUESTS = 200");
    expect(approval).toContain("pruneResolvedRequests");
    expect(approval).toContain('if (request.state === "resolved") this.requests.delete(requestId);');
    // QuickEditContentProvider.contents：每次 Cmd+K 存 before/after 两份快照且从不清理。
    const quickEdit = readSource("src/features/quickEdit.ts");
    expect(quickEdit).toContain("MAX_QUICK_EDIT_SNAPSHOTS = 16");
    expect(quickEdit).toContain("while (this.contents.size > MAX_QUICK_EDIT_SNAPSHOTS)");
  });

  it("X5：平台方法写/拉面收敛（saveFile scheme 白名单 + 文本附件上限）", () => {
    const container = readSource("src/container.ts");
    // sourceUrl 走宿主侧 fetch：scheme 白名单与 openExternal 同口径，杜绝任意 scheme。
    expect(container).toContain("SAVE_FILE_SOURCE_SCHEMES = [\"http\", \"https\", \"data\"]");
    expect(container).toContain("if (!SAVE_FILE_SOURCE_SCHEMES.includes(sourceScheme))");
    // createTempTextAttachment：text 必须 string 且有字节上限（磁盘耗尽面）。
    expect(container).toContain("TEMP_TEXT_ATTACHMENT_LIMIT_BYTES = 2 * 1024 * 1024");
    expect(container).toContain("createTempTextAttachment: text 必须为字符串");
  });

  it("X7：注册 Disposable 全量入 subscriptions（provider + 14 条宿主命令）", () => {
    // 此前 commands.registerCommand / registerWebviewViewProvider 的返回值被丢弃
    // （扩展宿主回收会兜底，但不依赖隐式行为——对齐 VS Code 官方订阅生命周期口径）。
    const extension = readSource("src/extension.ts");
    expect(extension).toContain("context.subscriptions.push(");
    expect(extension).toContain("window.registerWebviewViewProvider(");
    expect(extension).toContain("...registerCommands(container)");
    const hostCommands = readSource("src/commands/hostCommands.ts");
    expect(hostCommands).toContain("export function registerHostCommands(deps: HostCommandDeps): Disposable[]");
    expect(hostCommands).toContain("return disposables;");
    expect(hostCommands).not.toContain("void commands.registerCommand(");
    const container = readSource("src/container.ts");
    expect(container).toContain("export function registerCommands(container: Container): Disposable[]");
  });

  it("宿主代码不聚焦 Gode 视图容器（workbench.view.extension.* 会自动展开侧栏，与主形态冲突）", () => {
    // 状态栏待审按钮曾指向已删除的旧容器 gode（死命令）；且任何 workbench.view.extension
    // 引用都会展开侧栏视图——编辑器标签是唯一主形态，宿主侧一律走 gode.openChat。
    expect(readSource("src/ui/statusBar.ts")).not.toContain("workbench.view.extension");
    expect(readSource("src/ui/statusBar.ts")).toContain('command: "gode.openChat"');
    // 底部「新建页签」按钮：绑定 gode.newChatTab（总是新建一个对话编辑器标签），
    // 且必须在状态栏右侧（与 Claude Code 等扩展状态项同侧——用户参考图红圈位置）。
    const statusBar = readSource("src/ui/statusBar.ts");
    expect(statusBar).toContain('command: "gode.newChatTab"');
    expect(statusBar).toContain(
      "window.createStatusBarItem(StatusBarAlignment.Right, 100)",
    );
    expect(readSource("src/commands/hostCommands.ts")).toContain(
      'registerCommand("gode.newChatTab"',
    );
    // 多页签：ChatEditorPanel 支持并存多面板（Map 管理 + openNew 总是新建）。
    const editorPanel = readSource("src/ui/chatEditorPanel.ts");
    expect(editorPanel).toContain("openNew(): ChatEditorOpenResult");
    expect(editorPanel).toContain("private readonly panels = new Map<string, WebviewPanel>()");
    // 新页签 = 新草稿会话（Claude 同款）：openNew 面板 bootstrap 回草稿态，
    // 已有会话经共享标签栏切换；reveal 路径仍恢复最近会话。
    expect(editorPanel).toContain('this.create("draft")');
    expect(editorPanel).toContain('mode === "draft" ? () => null : this.resolveInitialSessionId');
  });

  it("纯 UI 帧定向到最近活动页，不广播（跨页状态污染修复）", () => {
    const runtime = readSource("src/host/hostRuntime.ts");
    expect(runtime).toContain("pushToActiveHostFrame(");
    expect(runtime).toContain("lastActiveConnectionId");
    // composer-insert（composer 预填）与 open-panel / diagnostics（面板/诊断面）
    // 只允许定向；广播仅保留全局语义帧（theme/locale/workspace/restart/session-switch）。
    const container = readSource("src/container.ts");
    expect(container).toContain('if (kind === "composer-insert") {');
    expect(container).toContain('pushToActiveHostFrame("open-panel"');
    const hostCommands = readSource("src/commands/hostCommands.ts");
    expect(hostCommands).toContain('pushToActiveHostFrame("open-panel"');
    expect(hostCommands).toContain('pushToActiveHostFrame("diagnostics"');
    // 广播面不再出现纯 UI 帧（visibility 已停发，composer-insert/open-panel/diagnostics 定向）。
    expect(hostCommands).not.toContain('deps.hostRuntime.pushHostFrame("diagnostics"');
    expect(hostCommands).not.toContain('deps.hostRuntime.pushHostFrame("open-panel"');
    expect(container).not.toContain('pushHostFrame("open-panel"');
    const chatPanel = readSource("src/ui/chatPanel.ts");
    expect(chatPanel).not.toContain('pushHostFrame("visibility"');
  });
});

describe("IDE 内核 agent 侧栏自动展开根断（用户反馈：聚焦即弹侧栏）", () => {
  it("根断脚本存在且补丁语义完整（备份/恢复/幂等）", () => {
    const script = readSource("scripts/disable-ide-agent-sidebar.mjs");
    // 补丁目标：内核 CascadeService.openPanel 是侧栏打开的唯一汇聚点。
    expect(script).toContain("AntigravityCascadeService.openPanel()");
    // 移除的是 openViewContainer + 可见性广播，保留已可见时的宽度调整。
    expect(script).toContain("gode: agent sidebar auto-open disabled");
    expect(script).toContain("openViewContainer(Vpe)");
    // 三态：--restore 恢复备份、--status 查询、默认幂等打补丁。
    expect(script).toContain('"--restore"');
    expect(script).toContain('"--status"');
    expect(script).toContain('gode-orig.bak');
    // 补丁 2：布局初始化每次启动都无条件强制辅助栏可见并恢复 agent 容器，
    // 该路径绕过 openPanel（补丁 1 拦不住）——必须翻转为默认隐藏。
    expect(script).toContain("启动布局强制恢复 agent 辅助栏 → 默认隐藏");
    expect(script).toContain("AUXILIARYBAR_HIDDEN,!0");
    expect(script).toContain("auxiliaryBar=void 0");
    expect(script).toContain("gode: agent sidebar startup restore disabled");
  });

  it("deploy.sh 部署后自动重打补丁（IDE 更新覆盖内核后保持默认关）", () => {
    const deploy = readSource("scripts/deploy.sh");
    expect(deploy).toContain("node scripts/disable-ide-agent-sidebar.mjs || true");
  });
});
