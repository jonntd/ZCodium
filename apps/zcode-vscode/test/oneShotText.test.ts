/**
 * createGenerateText（一次性文本生成，PRD §7.20 单通道）单测。
 *
 * 锁定的口径：
 * 1. 未配置模型 → 明确报错（指引 gode.model 设置），**绝不发起服务调用**；
 * 2. 参数面：workspacePath/selection/prompt/querySource/requestTimeoutMs=200_000
 *    固定透传；maxOutputTokens 仅在提供时携带；
 * 3. result.text 缺省收敛为 ""。
 *
 * featureConfig（依赖 vscode 设置面）整模块 mock。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { readModelSelection } = vi.hoisted(() => ({
  readModelSelection: vi.fn<() => string | null>(),
}));

vi.mock("../src/features/featureConfig", () => ({ readModelSelection }));

import { createGenerateText } from "../src/features/oneShotText";

describe("createGenerateText：一次性文本生成", () => {
  beforeEach(() => {
    readModelSelection.mockReset();
  });

  it("未配置模型：明确报错并指引 gode.model，不发起服务调用", async () => {
    readModelSelection.mockReturnValue(null);
    const runWithServices = vi.fn();

    await expect(
      createGenerateText(runWithServices as never, "/w")("解释一下"),
    ).rejects.toThrow(/gode\.model/);

    expect(runWithServices).not.toHaveBeenCalled();
  });

  it("参数面：固定字段透传 + requestTimeoutMs=200_000（thinking 长请求保护）", async () => {
    readModelSelection.mockReturnValue("prov/model$high");
    const generateWorkspaceText = vi.fn().mockResolvedValue({ text: "生成结果" });
    const runWithServices = vi.fn((run: (accessor: unknown) => Promise<unknown>) =>
      run({ zcodeAgentService: { generateWorkspaceText } } as never),
    );

    const text = await createGenerateText(runWithServices as never, "/w/space")(
      "写一句提交信息",
    );

    expect(text).toBe("生成结果");
    expect(generateWorkspaceText).toHaveBeenCalledWith({
      workspacePath: "/w/space",
      selection: "prov/model$high",
      prompt: "写一句提交信息",
      querySource: "vscode-extension",
      signal: undefined,
      requestTimeoutMs: 200_000,
    });
  });

  it("maxOutputTokens 仅在提供时携带（缺省不污染协议参数）", async () => {
    readModelSelection.mockReturnValue("prov/model");
    const generateWorkspaceText = vi.fn().mockResolvedValue({ text: "" });
    const runWithServices = vi.fn((run: (accessor: unknown) => Promise<unknown>) =>
      run({ zcodeAgentService: { generateWorkspaceText } } as never),
    );
    const generate = createGenerateText(runWithServices as never, "/w");

    await generate("a", { maxOutputTokens: 512, signal: new AbortController().signal });

    expect(generateWorkspaceText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 512 }),
    );

    await generate("b");
    const second = generateWorkspaceText.mock.calls[1]![0] as Record<string, unknown>;
    expect("maxOutputTokens" in second).toBe(false);
  });

  it("result.text 缺省收敛为空串（服务异常返回不外抛 undefined）", async () => {
    readModelSelection.mockReturnValue("prov/model");
    const generateWorkspaceText = vi.fn().mockResolvedValue({});
    const runWithServices = vi.fn((run: (accessor: unknown) => Promise<unknown>) =>
      run({ zcodeAgentService: { generateWorkspaceText } } as never),
    );

    const text = await createGenerateText(runWithServices as never, "/w")("x");
    expect(text).toBe("");
  });
});
