import * as vscode from "vscode";
import { log } from "./logger";

interface SessionQuickPickItem extends vscode.QuickPickItem {
  readonly sessionId: string;
}

/** `zcodeAgentService.listSessions` 返回的本插件关心的字段（strict schema 的子集）。 */
export interface SessionSummary {
  readonly sessionId: string;
  readonly title?: string;
  readonly mode?: string;
  readonly updatedAt?: number;
}

/**
 * 读取会话列表的超时上限。
 *
 * `listSessions` 底层走 `getOrStartReadOnlyClient`：需要先拉起/复用 CLI runtime
 * 并完成协议握手。CLI 未就绪、路径失效或握手挂起时这个 Promise 可能永不 settle，
 * 旧实现只有状态栏一个转圈进度，用户看到的就是「按钮点了没反应」。超时把它
 * 变成一条明确的错误提示（并写进 Output 通道），至少让故障可定位。
 */
const LIST_SESSIONS_TIMEOUT_MS = 15_000;

/**
 * 历史会话选择器（M2-6c）。
 *
 * 会话由 CLI 持久化（`session/list`），插件不另存一份 —— 所以桌面端聊过的会话
 * 在这里也能看到并接续，这正是「还原 Gode 全部能力」的一部分。
 *
 * 交互口径（2026-11-09 修「点历史会话按钮没反应」）：**点击瞬间就 show 一个
 * QuickPick 面板**，先以 busy + 占位项呈现，数据到了再替换 items。旧实现是先
 * `withProgress` 等 `listSessions` 返回、再 `showQuickPick`，于是：
 *  - CLI 握手慢/挂起 → 界面上只有一个几乎看不见的状态栏转圈；
 *  - 会话列表为空 → 只丢一个右下角 `showInformationMessage`，用户盯着工具栏
 *    根本注意不到。两种情况的观感都是「按钮点了没反应」。
 * 现在无论数据多慢、有没有会话，点击后立刻有可见面板；失败/空列表也在面板
 * 或错误消息里明确呈现。
 */
export async function pickSession(
  listSessions: () => Promise<readonly SessionSummary[]>,
): Promise<string | undefined> {
  const picker = vscode.window.createQuickPick<SessionQuickPickItem>();
  picker.title = "Gode 历史会话";
  picker.placeholder = "选择要接续的会话";
  picker.matchOnDescription = true;
  picker.busy = true;
  picker.items = [
    {
      label: "正在读取历史会话…",
      description: "首次读取可能需要启动 Agent",
      sessionId: "",
    },
  ];
  // 关键：在 await 任何东西之前就显示，保证「点击 → 可见反馈」零延迟。
  picker.show();

  // 修复（2026-11-10 审查）：accept/hide 监听必须在任何 await 之前挂上。
  // busy 阶段（最长 15 秒，CLI 冷启常见）按 ESC 时 picker 已经 hide，若监听等到
  // 列表返回后才注册就永远收不到 onDidHide——Promise 不 settle、picker 不 dispose，
  // 表现为命令处理器挂死 + QuickPick 泄漏。
  let resolveSelection: (value: string | undefined) => void = () => {};
  const selection = new Promise<string | undefined>((resolve) => {
    resolveSelection = resolve;
  });
  let done = false;
  const finish = (value: string | undefined): void => {
    if (done) return;
    done = true;
    picker.hide();
    picker.dispose();
    resolveSelection(value);
  };
  picker.onDidAccept(() => {
    const picked = picker.selectedItems[0];
    if (!picked?.sessionId) {
      log.info("history", "历史会话选择器：无有效选择（空态 / 用户取消）");
      finish(undefined);
      return;
    }
    log.info("history", `历史会话选择器：选中 ${picked.sessionId}`);
    finish(picked.sessionId);
  });
  // ESC / 点击外部关闭 = 取消；hide() 也会触发本事件，由 done 保证幂等。
  picker.onDidHide(() => finish(undefined));

  let sessions: readonly SessionSummary[];
  try {
    log.info("history", "读取历史会话…");
    sessions = await withTimeout(
      Promise.resolve().then(listSessions),
      LIST_SESSIONS_TIMEOUT_MS,
      "连接 Agent 超时（15 秒）；CLI 可能未启动或未就绪",
    );
    // 服务层异常返回（undefined / 非数组）也要有反馈，不能让 .length 抛到
    // 命令处理器里变成又一次「静默无反应」。
    if (!Array.isArray(sessions)) {
      throw new Error("会话列表返回格式异常（非数组）");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("history", `读取历史会话失败：${message}`);
    finish(undefined);
    void vscode.window.showErrorMessage(`读取历史会话失败：${message}`);
    return undefined;
  }

  log.info("history", `读取历史会话：${sessions.length} 条`);
  picker.busy = false;
  if (sessions.length === 0) {
    // 空态也留在面板里，不再用一个容易被忽略的右下角通知打发用户。
    picker.items = [
      {
        label: "暂无历史会话",
        description: "在对话里发一条消息后，会话会自动保存到这里",
        sessionId: "",
      },
    ];
  } else {
    picker.items = sessions.map((session) => ({
      label: session.title?.trim() || "未命名会话",
      description: formatRelativeTime(session.updatedAt),
      detail: session.mode,
      sessionId: session.sessionId,
    }));
  }

  // accept/hide 均已在上方注册：用户选择 → onDidAccept 结算；ESC/外部关闭 →
  // onDidHide 结算（含 busy 阶段）。此处只等待，不再注册任何监听。
  return selection;
}

/** 给 Promise 加超时；超时后底层任务仍会继续，但结果不再被采纳（不重复弹窗）。 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return "";
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return "刚刚";
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)} 分钟前`;
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)} 小时前`;
  return `${Math.floor(deltaMs / 86_400_000)} 天前`;
}
