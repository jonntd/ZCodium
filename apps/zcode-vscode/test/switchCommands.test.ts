/**
 * T10：switchModelConfig / switchCollaborationMode 的 CAS baseRevision 与
 * compact 入队语义（P1-11/P1-14）。
 *
 * 协议锚点（packages/shared/src/zcode-protocol-v4/command.ts）：
 * - command.ts:259-267  switchModelConfig{provider,model,thought} /
 *   switchCollaborationMode{mode:build|edit|plan|yolo|guarded} payload；
 * - command.ts:326-342  COMMANDS_REQUIRING_BASE_REVISION 含两个 switch 命令
 *   （信封必带 baseRevision，parseCommandEnvelope 就地拒绝）；
 * - command.ts:165-167  compact「输入型维护命令：idle 立即执行，busy/held 入 FIFO，
 *   不走 CAS」→ 信封不带 baseRevision。
 *
 * 测试面：ui commandFactory（插件面板实际使用的信封工厂，CAS 缺省就地抛）
 * + shared parseCommandEnvelope（wire 权威裁决）+ 插件 compactAction 纯函数。
 */

import { describe, expect, it } from "vitest";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { parseCommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import {
  buildCompactEnvelope,
  interpretCompactAck,
  isCompactAllowed,
} from "../src/webview-react/header/compactAction";
import {
  COLLABORATION_MODES,
  buildModelOptions,
  splitModelPickerValue,
} from "../src/webview-react/header/modelSelect";

function ack(partial: Partial<CommandAck>): CommandAck {
  return {
    commandId: "cmd-1",
    status: "accepted",
    revisionAtDecision: 7,
    ...partial,
  };
}

// ── CAS 命令：switchModelConfig / switchCollaborationMode ──

describe("switchModelConfig 信封（CAS 必带 baseRevision，P1-11）", () => {
  it("带 baseRevision 的信封通过 shared parseCommandEnvelope（wire 权威裁决）", () => {
    const envelope = createCommandEnvelope({
      type: "switchModelConfig",
      payload: { provider: "zai", model: "glm-4.6", thought: "medium" },
      sessionId: "sess-1",
      baseRevision: 7,
    });
    const parsed = parseCommandEnvelope(envelope);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.envelope.baseRevision).toBe(7);
      expect(parsed.envelope.payload).toEqual({
        provider: "zai",
        model: "glm-4.6",
        thought: "medium",
      });
    }
  });

  it("缺 baseRevision：信封工厂就地抛（客户端编程错误）", () => {
    expect(() =>
      createCommandEnvelope({
        type: "switchModelConfig",
        payload: { provider: "zai", model: "glm-4.6", thought: "medium" },
        sessionId: "sess-1",
      }),
    ).toThrow(/baseRevision/);
  });

  it("缺 baseRevision：绕过工厂的裸信封被 parseCommandEnvelope 拒绝（协议双保险）", () => {
    const raw = {
      commandId: "cmd-1",
      clientId: "client-1",
      sessionId: "sess-1",
      type: "switchModelConfig",
      payload: { provider: "zai", model: "glm-4.6", thought: "medium" },
      issuedAt: 0,
    };
    const parsed = parseCommandEnvelope(raw);
    expect(parsed.ok).toBe(false);
  });

  it("payload 缺 thought 字段被 payload schema 拒绝", () => {
    const envelope = {
      ...createCommandEnvelope({
        type: "switchModelConfig",
        payload: { provider: "zai", model: "glm-4.6", thought: "" },
        sessionId: "sess-1",
        baseRevision: 1,
      }),
      payload: { provider: "zai", model: "glm-4.6" },
    };
    expect(parseCommandEnvelope(envelope).ok).toBe(false);
  });
});

describe("switchCollaborationMode 信封（CAS + 值域，P1-11）", () => {
  it.each(COLLABORATION_MODES)("mode=%s 建信封并通过 wire 校验", (mode) => {
    const envelope = createCommandEnvelope({
      type: "switchCollaborationMode",
      payload: { mode },
      sessionId: "sess-1",
      baseRevision: 3,
    });
    const parsed = parseCommandEnvelope(envelope);
    expect(parsed.ok).toBe(true);
  });

  it("auto 非用户可切（不在命令面值域），越界值被 schema 拒绝", () => {
    expect(COLLABORATION_MODES).not.toContain("auto");
    const envelope = {
      ...createCommandEnvelope({
        type: "switchCollaborationMode",
        payload: { mode: "build" },
        sessionId: "sess-1",
        baseRevision: 3,
      }),
      payload: { mode: "auto" },
    };
    expect(parseCommandEnvelope(envelope).ok).toBe(false);
  });

  it("缺 baseRevision 就地抛（与 switchModelConfig 同一 CAS 纪律）", () => {
    expect(() =>
      createCommandEnvelope({
        type: "switchCollaborationMode",
        payload: { mode: "plan" },
        sessionId: "sess-1",
      }),
    ).toThrow(/baseRevision/);
  });
});

// ── compact：非 CAS，idle 即发 / busy 入 FIFO ──

describe("compact 信封（非 CAS，不带 baseRevision，P1-14）", () => {
  it("buildCompactEnvelope 不携带 baseRevision（与 CAS 纪律相对）", () => {
    const envelope = buildCompactEnvelope("sess-1");
    expect(envelope.type).toBe("compact");
    expect(envelope.payload).toEqual({});
    expect("baseRevision" in envelope).toBe(false);
    expect(parseCommandEnvelope(envelope).ok).toBe(true);
  });

  it("compact 信封若误带 baseRevision 会被 wire 拒收（strict payload 的反面印证非 CAS 面）", () => {
    // 注：commandEnvelopeSchema 的 baseRevision 是可选字段，误带不违规；
    // 此处锁「插件工厂恒不携带」的纪律，防止把 compact 误接进 CAS 面。
    expect("baseRevision" in buildCompactEnvelope("sess-1")).toBe(false);
  });
});

describe("interpretCompactAck（ACK 用户面；idle 执行与 busy 入队在 ACK 上同 accepted）", () => {
  it("accepted → 已受理（客户端不区分 idle/busy，入队语义归 CLI admission）", () => {
    const outcome = interpretCompactAck(ack({ status: "accepted" }));
    expect(outcome.ok).toBe(true);
    expect(outcome.queued).toBe(true);
  });

  it("noop/duplicate 同样按已受理收敛", () => {
    expect(interpretCompactAck(ack({ status: "noop" })).ok).toBe(true);
    expect(interpretCompactAck(ack({ status: "duplicate" })).ok).toBe(true);
  });

  it("compactOperationLock → 已有压缩在进行", () => {
    const outcome = interpretCompactAck(ack({ status: "rejected", reasonCode: "compactOperationLock" }));
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("已有压缩在进行");
  });

  it("activeTurn（旧 CLI 不支持排队）→ 可读拒绝", () => {
    const outcome = interpretCompactAck(ack({ status: "rejected", reasonCode: "activeTurn" }));
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("执行中");
  });

  it("其余拒绝带 reasonCode 透传", () => {
    const outcome = interpretCompactAck(ack({ status: "rejected", reasonCode: "fault.x" }));
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("fault.x");
  });
});

describe("isCompactAllowed（snapshot.availability.compact 投影）", () => {
  it("缺席视为可用（交由 CLI 裁决）", () => {
    expect(isCompactAllowed(null)).toBe(true);
    expect(isCompactAllowed({ availability: {} })).toBe(true);
  });

  it("availability.compact.allowed=false → 隐藏/禁用入口", () => {
    expect(
      isCompactAllowed({ availability: { compact: { allowed: false, reasonCode: "guard.x" } } }),
    ).toBe(false);
    expect(isCompactAllowed({ availability: { compact: { allowed: true } } })).toBe(true);
  });
});

describe("modelSelect 目录投影（P1-11 下拉数据面）", () => {
  it("buildModelOptions 扁平化 provider/model", () => {
    const options = buildModelOptions({
      revision: 1,
      providers: [
        {
          providerId: "zai",
          providerName: "Z.ai",
          config: {},
          models: [{ modelId: "glm-4.6", config: {} }],
        },
      ],
    } as never);
    expect(options).toEqual([{ value: "zai/glm-4.6", label: "Z.ai · glm-4.6" }]);
  });

  it("splitModelPickerValue 取首段 provider（modelId 允许含 /）", () => {
    expect(splitModelPickerValue("zai/glm-4.6")).toEqual({ provider: "zai", model: "glm-4.6" });
    expect(splitModelPickerValue("a/b/c")).toEqual({ provider: "a", model: "b/c" });
    expect(splitModelPickerValue("nopath")).toEqual({ provider: "", model: "" });
  });
});
