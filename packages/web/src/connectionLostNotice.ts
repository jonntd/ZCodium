/**
 * 交付（已收到 `Initialize`）之后传输断开的提示策略。
 *
 * 抽成纯函数是为了钉住一条容易退化的规则：**被其他页面顶替（4004）时不得引导重连**。
 * 若这条规则丢失，两个标签会互相顶替、各自刷新，形成刷新拉锯。
 * 文案与语言不在这里（组件按 `navigator.language` 决定），因此本函数可单测。
 */
export type ConnectionLostNoticeKind = "replaced" | "lost";

export interface ConnectionLostNoticePolicy {
  kind: ConnectionLostNoticeKind;
  showReconnect: boolean;
}

/** 4004 = relay 告知「本连接被新的手机端连接顶替」。 */
export const WEB_CLIENT_REPLACED_CLOSE_CODE = 4_004;

export function resolveConnectionLostNoticePolicy(closeCode: number): ConnectionLostNoticePolicy {
  if (closeCode === WEB_CLIENT_REPLACED_CLOSE_CODE) {
    return { kind: "replaced", showReconnect: false };
  }
  return { kind: "lost", showReconnect: true };
}

/**
 * 断线后**做什么**：弹提示（默认）还是自动整页重载（需显式 opt-in）。
 *
 * 为什么默认只弹提示：整页重载会丢弃仅存在于渲染器内存的状态（未发送输入、
 * elicitation 草稿、待审批交互），而 v4 composer 是刻意不做本地持久化的
 * （见 `docs/spec/web-bootstrap-delivery-point.md` §2.3 的决策记录）。
 * 因此免点击恢复必须是**用户显式选择**：配对链接带上 `autoReconnect=1`。
 */
export type ConnectionLostAction = "reload" | "notice";

export interface ConnectionLostActionInput {
  closeCode: number;
  /** 配对链接是否带 `autoReconnect=1`。 */
  autoReconnect: boolean;
  /** 自动重载限流是否放行（由调用方按 sessionStorage 时间窗计算，纯函数不读时钟）。 */
  reloadAllowed: boolean;
}

export function resolveConnectionLostAction(input: ConnectionLostActionInput): ConnectionLostAction {
  if (!input.autoReconnect) return "notice";
  // 被别的页面顶替时永不自动重载：否则两个标签会互相顶替、各自刷新，形成刷新拉锯。
  if (resolveConnectionLostNoticePolicy(input.closeCode).kind === "replaced") return "notice";
  return input.reloadAllowed ? "reload" : "notice";
}
