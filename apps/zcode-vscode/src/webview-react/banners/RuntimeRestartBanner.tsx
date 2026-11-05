/**
 * RuntimeRestartBanner — 进程换代横幅 webview 半（T07；P1-6）。
 *
 * 数据源 = host restart 帧（RuntimeController.onRuntimeRestart → pushHostFrame("restart")，
 * 载荷形状唯一定义处 src/host/hostFrameKinds.ts 的 RestartHostFramePayload）。
 * - 全部恢复成功 → info「Agent 已重启，会话已恢复」；
 * - 有恢复失败 → warn + 失败明细（P1-6.2 降级：提示从列表重新进入）+ 重试入口
 *   （重试 = 把失败会话重新绑定到对话面，走既有 resume 路径）。
 *
 * 投影纯函数（projectRestartBanner）vitest 直测；组件只负责呈现。
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import type { RestartHostFramePayload } from "../../host/hostFrameKinds";

/** HostFrameBus 的最小结构面（只认 restart 帧）。 */
export interface RestartFrameSource {
  on(kind: "restart", handler: (payload: unknown) => void): () => void;
  lastPayload(kind: "restart"): unknown;
}

/** 横幅呈现投影（P1-6：换代→横幅→自动恢复→失败降级）。 */
export interface RestartBannerState {
  visible: boolean;
  tone: "info" | "warn";
  message: string;
  /** 自动恢复成功的会话。 */
  restored: string[];
  /** 恢复失败明细（重试入口逐条绑定）。 */
  failures: Array<{ folder: string; sessionId: string; error: string }>;
}

export const RESTART_RESTORED_MESSAGE = "Agent 已重启，会话已恢复";
export const RESTART_PARTIAL_MESSAGE = "Agent 已重启，部分会话恢复失败，可从列表重新进入";

export function projectRestartBanner(
  payload: RestartHostFramePayload | null | undefined,
): RestartBannerState {
  if (!payload) {
    return { visible: false, tone: "info", message: "", restored: [], failures: [] };
  }
  const restored = Array.isArray(payload.restored) ? payload.restored : [];
  const failures = Array.isArray(payload.failures) ? payload.failures : [];
  if (failures.length === 0) {
    return { visible: true, tone: "info", message: RESTART_RESTORED_MESSAGE, restored, failures };
  }
  return { visible: true, tone: "warn", message: RESTART_PARTIAL_MESSAGE, restored, failures };
}

/** 订阅 restart 帧（App.tsx 消费；重订阅立即以最近一帧同步一次）。 */
export function useRestartFramePayload(
  source: RestartFrameSource | null | undefined,
): RestartHostFramePayload | null {
  const [payload, setPayload] = useState<RestartHostFramePayload | null>(
    () => (source?.lastPayload("restart") as RestartHostFramePayload | undefined) ?? null,
  );
  useEffect(() => {
    if (!source) return;
    return source.on("restart", (next: unknown) => {
      setPayload((next as RestartHostFramePayload | null) ?? null);
    });
  }, [source]);
  return payload;
}

export interface RuntimeRestartBannerProps {
  /** restart 帧源（App 注入 hostFrames；缺省 null 不呈现）。 */
  frameSource: RestartFrameSource | null | undefined;
  /** 重试入口：把失败会话重新绑定到对话面（走既有 resume 路径）。 */
  onRetry?: (failure: { folder: string; sessionId: string; error: string }) => void;
  /** 用户手动关闭横幅。 */
  onDismiss?: () => void;
}

export function RuntimeRestartBanner({ frameSource, onRetry, onDismiss }: RuntimeRestartBannerProps) {
  const payload = useRestartFramePayload(frameSource);
  const state = projectRestartBanner(payload);
  if (!state.visible) return null;
  return (
    <div
      role="status"
      data-tone={state.tone}
      className="flex shrink-0 items-center gap-2 border-b border-card-border bg-card px-3 py-1.5 text-ui-xs"
    >
      <span className={state.tone === "warn" ? "text-warning" : "text-foreground-subtle"}>
        {state.message}
      </span>
      {state.failures.map((failure) => (
        <Button
          key={`${failure.folder}:${failure.sessionId}`}
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 enabled:cursor-pointer"
          title={`重试恢复 ${failure.sessionId}（${failure.error}）`}
          onClick={() => onRetry?.(failure)}
        >
          重试 {failure.sessionId}
        </Button>
      ))}
      {onDismiss ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-2 enabled:cursor-pointer"
          onClick={onDismiss}
        >
          关闭
        </Button>
      ) : null}
    </div>
  );
}
