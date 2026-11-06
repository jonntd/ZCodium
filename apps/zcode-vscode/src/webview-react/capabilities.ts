/**
 * 能力声明 → UI 显隐投影（T07；P1-10.3「当前 CLI 版本不支持」标注）。
 *
 * 数据源 = host capabilities 帧（container 在 agent 就绪时探测 hello.capabilities 下发，
 * 载荷形状唯一定义处 src/host/hostFrameKinds.ts；架构 architecture-p1.md T07「接线后行为」）。
 * 能力面缺失（旧 CLI / 握手未达）整体降级为不可用 + 汇总提示，不做部分猜测。
 * 纯投影：vitest 直测，App 按投影布尔值显隐入口与渲染降级提示。
 */

import { isCapabilityMissingError } from "../errors";
import type { IZCodeAgentService } from "@zcode/services";
import type {
  CapabilitiesHostFramePayload,
  RuntimeCapabilityFlags,
} from "../host/hostFrameKinds";

export type { CapabilitiesHostFramePayload, RuntimeCapabilityFlags };

export interface CapabilityUiProjection {
  /** 终端入口显隐。 */
  showTerminalEntry: boolean;
  /** 原生对话框入口显隐。 */
  showNativeDialogEntry: boolean;
  /** 二进制帧缺失时的链路降级提示（null = 无需提示）。 */
  binaryFrameHint: string | null;
  /** 能力面整体缺失（hello 未达/旧 CLI）的降级提示（P1-10.3）。 */
  unsupportedHint: string | null;
}

export const CAPABILITY_UNSUPPORTED_HINT = "当前 CLI 版本不支持";
export const CAPABILITY_BINARY_FRAME_HINT =
  "当前链路不支持二进制帧，传输已退化为 base64 文本帧";

/**
 * hello.capabilities → UI 显隐投影。
 * - capabilities 缺失（null/undefined）：全部入口隐藏 + unsupportedHint（不做部分猜测）；
 * - flags 在场：按位投影；binaryFrames=false 给出链路降级提示。
 */
export function projectCapabilities(
  capabilities: RuntimeCapabilityFlags | null | undefined,
): CapabilityUiProjection {
  if (!capabilities) {
    return {
      showTerminalEntry: false,
      showNativeDialogEntry: false,
      binaryFrameHint: null,
      unsupportedHint: CAPABILITY_UNSUPPORTED_HINT,
    };
  }
  return {
    showTerminalEntry: capabilities.localTerminal === true,
    showNativeDialogEntry: capabilities.nativeDialogs === true,
    binaryFrameHint:
      capabilities.binaryFrames === true ? null : CAPABILITY_BINARY_FRAME_HINT,
    unsupportedHint: null,
  };
}

/**
 * 从 v4 hello 载荷收敛投影面（handshake 侧调用；形状不合法按整体缺失降级，不抛错）。
 */
export function capabilitiesFromHello(
  hello: unknown,
): RuntimeCapabilityFlags | null {
  if (typeof hello !== "object" || hello === null) return null;
  const capabilities = (hello as { capabilities?: unknown }).capabilities;
  if (typeof capabilities !== "object" || capabilities === null) return null;
  const record = capabilities as Record<string, unknown>;
  if (
    typeof record["nativeDialogs"] !== "boolean" ||
    typeof record["localTerminal"] !== "boolean"
  ) {
    return null;
  }
  return {
    nativeDialogs: record["nativeDialogs"],
    localTerminal: record["localTerminal"],
    binaryFrames: record["binaryFrames"] === true,
    compression:
      typeof record["compression"] === "string"
        ? record["compression"]
        : "none",
  };
}

// ── host 探测结果的帧收敛（container 装配调用；App 消费，均可 vitest 直测） ──

/**
 * host 一次能力探测的结果：hello 成功携带载荷，或失败（含 runtime/capabilities 的
 * FR-A13 复核错误，仅 hello 失败且非 method-not-found 时产生）。
 */
export type CapabilitiesProbeOutcome =
  | { ok: true; hello: unknown }
  | { ok: false; error: unknown; runtimeProbeError?: unknown };

/**
 * host 探测结果 → capabilities 帧载荷（纯收敛，container 生产前最后一步）。
 * - hello 成功：capabilitiesFromHello 收敛；capabilities 面缺失/形状非法 = 整体降级
 *   （P1-10.3 不做部分猜测）→ {null, capabilityMissing:true}；
 * - hello 失败：-32601 / "Method not found" 直接判能力缺失；否则看 runtime/capabilities
 *   复核错误（FR-A13），仍无法判 → {null, false}（暂时不可得，UI 静默不诬告）。
 */
export function capabilitiesFrameFromProbe(
  outcome: CapabilitiesProbeOutcome,
): CapabilitiesHostFramePayload {
  if (!outcome.ok) {
    if (isCapabilityMissingError(outcome.error)) {
      return { capabilities: null, capabilityMissing: true };
    }
    if (
      outcome.runtimeProbeError !== undefined &&
      isCapabilityMissingError(outcome.runtimeProbeError)
    ) {
      return { capabilities: null, capabilityMissing: true };
    }
    return { capabilities: null, capabilityMissing: false };
  }
  const capabilities = capabilitiesFromHello(outcome.hello);
  if (capabilities) return { capabilities, capabilityMissing: false };
  return { capabilities: null, capabilityMissing: true };
}

// ── host 探测编排（container 装配调用；依赖注入，vitest 用 fake agent service 直测） ──

/** 探测所需的最小 agent 服务面（IZCodeAgentService 的控制面子集）。 */
export type CapabilitiesProbeAgentService = Pick<
  IZCodeAgentService,
  "helloConversationV4" | "runtimeCapabilities"
>;

export interface CapabilitiesProbeDeps {
  agentService: CapabilitiesProbeAgentService;
  /** runtime/capabilities 复核的 workspace 定位（仅 hello 失败时使用）。 */
  workspaceTarget: { workspacePath: string; workspaceIdentity?: string };
  /** 非 -32601 的探测失败诊断出口（不改变帧载荷语义）。 */
  log?: (message: string) => void;
}

/**
 * 探测一次能力面并收敛为 capabilities 帧载荷（T07「接线后行为」第 2 条）：
 * helloConversationV4 成功 → 直接收敛；失败且非 method-not-found → 以
 * runtime/capabilities 复核（FR-A13：控制面常量应答，zcodeAgent.ts:655-668），
 * 复核再遇 -32601/"Method not found" 才判能力缺失，否则按暂时不可得静默。
 * hello 与 runtime/capabilities 都不落盘、不建会话，不改变 agent spawn 语义。
 */
export async function probeCapabilitiesFrame(
  deps: CapabilitiesProbeDeps,
): Promise<CapabilitiesHostFramePayload> {
  try {
    const hello = await deps.agentService.helloConversationV4();
    return capabilitiesFrameFromProbe({ ok: true, hello });
  } catch (helloError) {
    if (!isCapabilityMissingError(helloError)) {
      try {
        await deps.agentService.runtimeCapabilities?.({
          ...deps.workspaceTarget,
        });
        deps.log?.(
          "[capabilities] hello 探测失败（runtime/capabilities 可达，暂不判能力缺失）",
        );
      } catch (runtimeProbeError) {
        deps.log?.(
          `[capabilities] hello 与 runtime/capabilities 均失败：` +
            `${runtimeProbeError instanceof Error ? runtimeProbeError.message : String(runtimeProbeError)}`,
        );
        return capabilitiesFrameFromProbe({
          ok: false,
          error: helloError,
          runtimeProbeError,
        });
      }
    }
    return capabilitiesFrameFromProbe({ ok: false, error: helloError });
  }
}

/**
 * capabilities 帧载荷 → App 投影（App 消费入口）。
 * 静默规则（T07「接线后行为」第 4 条）：帧未到（undefined）或暂时不可得
 * （{null,false}）→ null，App 不渲染任何「不支持」提示；仅明确能力缺失才降级标注。
 */
export function projectCapabilitiesPayload(
  payload: CapabilitiesHostFramePayload | undefined,
): CapabilityUiProjection | null {
  if (!payload) return null;
  if (payload.capabilities) return projectCapabilities(payload.capabilities);
  return payload.capabilityMissing ? projectCapabilities(null) : null;
}

/** App 传给 V4ChatPane 的能力门控回调面（按需扩展；现以终端入口为真实消费面）。 */
export interface CapabilityGatedPaneCallbacks {
  /** 本机终端（background bash）入口回调；ui 侧按回调缺席隐藏入口（ConversationStatusPanel）。 */
  onOpenBackgroundBash?: () => void;
}

/**
 * 投影 → pane 回调门控（纯函数）：能力缺失的入口回调置空——ui 侧按「回调缺席」隐藏
 * 入口（ConversationStatusPanel.tsx 的条件渲染），从而 showTerminalEntry 驱动真实 UI 显隐。
 * 投影未就绪（null，帧未到/暂时不可得）时不门控：维持现状回调，入口不因未知能力被误藏。
 */
export function gatePaneCallbacksByCapability<
  C extends CapabilityGatedPaneCallbacks,
>(callbacks: C, projection: CapabilityUiProjection | null): C {
  if (!projection) return callbacks;
  if (projection.showTerminalEntry) return callbacks;
  return { ...callbacks, onOpenBackgroundBash: undefined };
}
