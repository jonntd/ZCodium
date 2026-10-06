/**
 * 官方远控数据面分派器（spec vps-relay-bridge.md §14.9）。
 *
 * 职责：接收 device 控制面交来的 data 信封，按 `zcode_type` 路由——
 * bootstrap / workspace-list / platform / view-state 直接回包；
 * workspace-bridge-open 建立到窗口 Host 的桥（与路线 A 同一 attach 机制：
 * MessageChannelMain 的 port2 交给 Host，port1 经 rpc-frame codec 与对端互转）。
 *
 * 与官方的已知偏差（fork v1，均记录在 spec §14.9）：不做饱和流控（背压由 WS
 * 承担）、tasks 恒为空、platform-request 一律「未实现」、workspace-bridge-error
 * 的 reason 不对齐官方枚举。
 */
import { randomUUID } from "node:crypto";

import { MessagePortProtocol, VSBuffer } from "@zcode/rpc";
import { HostMessageTypes } from "@zcode/shared";

import {
  wrapElectronPort,
  type RelayMessagePort,
} from "./remoteRelayClient.js";
import {
  createOfficialFrameCodec,
  type OfficialFrameCodec,
  type OfficialFrameIdentity,
} from "./remoteOfficialFrameCodec.js";

/** 与路线 A 的 RelayTargetWindow 同构；结构化类型避免对路线 A 模块的反向依赖。 */
export interface OfficialBridgeTarget {
  windowId: number;
  hostProcess: { postMessage(message: unknown, transfer?: unknown[]): void };
}

export interface OfficialWorkspaceInfo {
  workspacePath: string;
  workspaceIdentity?: string;
  kind?: string;
}

export interface OfficialDataPlaneDeps {
  logger?: {
    info(message: string, detail?: unknown): void;
    warn(message: string, detail?: unknown): void;
    debug?(message: string, detail?: unknown): void;
  };
  appVersion?: string;
  /** deviceSid（bootstrap result 的 windowControlSessionId）；未注册时为 null。 */
  getDeviceSid: () => string | null;
  /** 按 workspaceKey 选出可借出 Host 的窗口；null = 目标工作区不在任何窗口。 */
  resolveBridgeTarget: (workspaceKey: string) => OfficialBridgeTarget | null;
  /** 读出窗口当前工作区（bridge 元数据用）。 */
  resolveWindowWorkspace: (windowId: number) => OfficialWorkspaceInfo | null;
  /** 窗口内全部工作区（bootstrap / workspace-list 用）。 */
  listWorkspaces: () => OfficialWorkspaceInfo[];
  createChannel: () => { port1: RelayMessagePort; port2: RelayMessagePort };
  /** 数据面出口（device 控制面的 sendData）。 */
  sendData: (payload: Record<string, unknown>) => boolean;
}

export interface OfficialDataPlane {
  handlePayload(payload: Record<string, unknown>): void;
  /** 供测试/观测：当前 bridge 身份；无 bridge 时为 null。 */
  getBridgeIdentity(): OfficialFrameIdentity | null;
  dispose(): void;
}

/** workspaceIdentity 的统一 key 语义（spec「Workspace Identity」）。 */
function workspaceKeyOf(workspace: OfficialWorkspaceInfo): string {
  return workspace.workspaceIdentity?.trim() || workspace.workspacePath;
}

function identityFieldsOf(identity: OfficialFrameIdentity): Record<string, unknown> {
  return {
    bridgeSessionId: identity.bridgeSessionId,
    ...(identity.bridgeGeneration !== undefined
      ? { bridgeGeneration: identity.bridgeGeneration }
      : {}),
    ...(identity.recoveryId ? { recoveryId: identity.recoveryId } : {}),
  };
}

interface ActiveBridge {
  identity: OfficialFrameIdentity;
  codec: OfficialFrameCodec;
  hostProtocol: MessagePortProtocol;
  workspaceKey: string;
}

export function createOfficialDataPlane(deps: OfficialDataPlaneDeps): OfficialDataPlane {
  const logger = deps.logger;
  let activeBridge: ActiveBridge | null = null;
  // 稳定 attachmentId：数据面生命周期内复用——同一 id 的重复 attach 在 Host
  // registry 里就是原子替换（与路线 A 相同），新 bridge 顶替旧 bridge 无需显式 detach。
  const bridgeAttachmentId = `official-bridge-${randomUUID()}`;

  function reply(payload: Record<string, unknown>): void {
    if (!deps.sendData(payload)) {
      logger?.warn("数据面回包发送失败（控制面不可用）", { zcode_type: payload.zcode_type });
    }
  }

  function collectWorkspaces(): Array<Record<string, unknown>> {
    // 官方枚举窗口内全部工作区；fork 由接线方注入窗口-工作区映射。
    return deps.listWorkspaces().map((workspace) => ({
      workspaceKey: workspaceKeyOf(workspace),
      workspacePath: workspace.workspacePath,
      ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
      kind: workspace.kind ?? "local",
    }));
  }

  function handleBootstrap(payload: Record<string, unknown>): void {
    reply({
      zcode_type: "bootstrap-response",
      requestId: payload.requestId,
      success: true,
      result: {
        windowControlSessionId: deps.getDeviceSid(),
        desktopAppVersion: deps.appVersion,
        workspaces: collectWorkspaces(),
        tasks: [],
        initialViewState: null,
        mobileViewState: null,
      },
    });
  }

  function handleWorkspaceList(payload: Record<string, unknown>): void {
    const workspaces = collectWorkspaces();
    reply({
      zcode_type: "workspace-list-response",
      requestId: payload.requestId,
      success: true,
      result: {
        workspaces,
        tasks: [],
        activeWorkspaceKey: workspaces[0]?.workspaceKey ?? null,
        activeTaskId: null,
      },
    });
  }

  function disposeBridge(): void {
    if (!activeBridge) return;
    activeBridge.codec.dispose();
    try {
      activeBridge.hostProtocol.disconnect();
    } catch {
      /* Host 侧可能已关闭端口 */
    }
    activeBridge = null;
  }

  async function handleBridgeOpen(payload: Record<string, unknown>): Promise<void> {
    const requestId = payload.requestId;
    const bridgeSessionId = typeof payload.bridgeSessionId === "string" ? payload.bridgeSessionId : "";
    const bridgeGeneration =
      typeof payload.bridgeGeneration === "number" ? payload.bridgeGeneration : undefined;
    const recoveryId = typeof payload.recoveryId === "string" ? payload.recoveryId : undefined;
    const workspaceKey = typeof payload.workspaceKey === "string" ? payload.workspaceKey : "";
    const identity: OfficialFrameIdentity = {
      bridgeSessionId,
      ...(bridgeGeneration !== undefined ? { bridgeGeneration } : {}),
      ...(recoveryId ? { recoveryId } : {}),
    };
    const base = {
      requestId,
      ...identityFieldsOf(identity),
    };
    try {
      if (!bridgeSessionId || !workspaceKey) {
        throw new Error("workspace-bridge-open 缺少 bridgeSessionId / workspaceKey");
      }
      const target = deps.resolveBridgeTarget(workspaceKey);
      if (!target) {
        throw new Error("目标工作区不在当前桌面窗口中，无法建立 bridge");
      }
      const workspace = deps.resolveWindowWorkspace(target.windowId);
      if (!workspace) {
        throw new Error("窗口尚未连接工作区，无法建立 bridge");
      }

      disposeBridge();
      const channel = deps.createChannel();
      const hostProtocol = new MessagePortProtocol(wrapElectronPort(channel.port1));
      const codec = createOfficialFrameCodec({
        identity,
        sendEnvelope: (envelope) => deps.sendData(envelope),
        onMessage: (bytes) => hostProtocol.send(VSBuffer.wrap(bytes)),
        onDegrade: (reason, detail) => {
          logger?.warn("官方 bridge 通道降级", { reason, ...detail });
          reply({ zcode_type: "bridge-degraded", ...identityFieldsOf(identity), reason });
        },
        logger,
      });
      hostProtocol.onMessage((buffer: VSBuffer) => {
        codec.sendFrame(new Uint8Array(buffer.buffer));
      });
      activeBridge = { identity, codec, hostProtocol, workspaceKey };

      // 把 port2 交给窗口 Host（与路线 A 同一 attach 消息；Host 未 ready 时自行挂起）。
      target.hostProcess.postMessage(
        {
          type: HostMessageTypes.AttachServicePort,
          requestId: randomUUID(),
          attachmentId: bridgeAttachmentId,
          // 官方手机侧走 replayable 档；握手强校验 clientMode↔deliveryProfile。
          clientMode: "web-remote-replayable",
          scope: { kind: "local" },
        },
        [channel.port2],
      );

      reply({
        zcode_type: "workspace-bridge-ready",
        ...base,
        bridge: {
          bridgeSessionId,
          ...(bridgeGeneration !== undefined ? { bridgeGeneration } : {}),
          ...(recoveryId ? { recoveryId } : {}),
          attachmentId: bridgeAttachmentId,
          hostEntryId: bridgeAttachmentId,
          kind: workspace.kind ?? "local",
          workspaceKey,
          workspacePath: workspace.workspacePath,
          ...(workspace.workspaceIdentity
            ? { workspaceIdentity: workspace.workspaceIdentity }
            : {}),
          initialTaskId: typeof payload.taskId === "string" ? payload.taskId : "",
          readyAnnounced: true,
          degraded: false,
        },
      });
      codec.markReady();
      logger?.info(`官方 bridge 已建立 windowId=${target.windowId}`, {
        bridgeSessionSuffix: bridgeSessionId.slice(-6),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn(`官方 bridge 建立失败：${message}`);
      disposeBridge();
      reply({ zcode_type: "workspace-bridge-error", ...base, reason: "error", error: message });
    }
  }

  return {
    handlePayload(payload: Record<string, unknown>): void {
      switch (payload.zcode_type) {
        case "bootstrap-request":
          handleBootstrap(payload);
          return;
        case "workspace-list-request":
          handleWorkspaceList(payload);
          return;
        case "workspace-bridge-open":
          void handleBridgeOpen(payload);
          return;
        case "workspace-reconnect-request":
          // fork v1：断线重连由控制面重连 + codec 重放覆盖，这里直接确认成功。
          reply({
            zcode_type: "workspace-reconnect-response",
            requestId: payload.requestId,
            workspaceKey: payload.workspaceKey,
            success: true,
          });
          return;
        case "platform-request":
          reply({
            zcode_type: "platform-response",
            requestId: payload.requestId,
            method: payload.method,
            success: false,
            error: "fork 未实现该方法",
          });
          return;
        case "mobile-view-state-update":
          logger?.debug?.("收到 mobile-view-state-update（fork v1 仅记录）");
          return;
        case "rpc-frame":
        case "rpc-frame-ack":
          // raw transport：必须经当前 bridge 的 codec；无 bridge 说明对端状态异常。
          if (activeBridge) {
            activeBridge.codec.handleEnvelope(payload);
          } else {
            logger?.warn("无活动 bridge 却收到 rpc-frame，忽略");
          }
          return;
        default:
          logger?.debug?.("数据面信封未处理", { zcode_type: payload.zcode_type ?? null });
          return;
      }
    },
    getBridgeIdentity: () => (activeBridge ? { ...activeBridge.identity } : null),
    dispose: disposeBridge,
  };
}
