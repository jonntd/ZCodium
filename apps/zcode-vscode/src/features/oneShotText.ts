/**
 * 一次性文本生成（M1 移植；PRD §7.20 单通道）。
 *
 * 服务调用统一走 `runWithServices`（容器按承载模式路由：full → 共享 server 的 WS
 * accessor；pane → 进程内 ServiceCollection 结构化子集）。能力同一权威：
 * `zcodeAgentService.generateWorkspaceText`（协议方法 `workspace/generateText`）——
 * 服务端按 workspaceKey 复用活动会话的 app：侧边栏有活动会话时热态只付模型耗时；
 * 没有会话时才会现装配（冷启 4–10s）。
 */

import { readModelSelection } from "./featureConfig";

/** 一次性文本生成的可选参数（Quick Edit / 生成提交信息共用）。 */
export interface OneShotTextOptions {
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
}

export function createGenerateText(
  runWithServices: <T>(run: (accessor: import("@zcode/services").IServiceAccessor) => Promise<T>) => Promise<T>,
  workspacePath: string,
): (prompt: string, options?: OneShotTextOptions) => Promise<string> {
  return async (prompt, options) => {
    const selection = readModelSelection();
    if (!selection) {
      throw new Error(
        "一次性文本生成需要指定模型。请在设置 `zcodium.model` 中填写 `providerId/modelId`（需要档位时写成 `providerId/modelId$档位`）。",
      );
    }
    const result = await runWithServices((accessor) =>
      accessor.zcodeAgentService.generateWorkspaceText({
        workspacePath,
        selection,
        prompt,
        querySource: "vscode-extension",
        signal: options?.signal,
        ...(options?.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
        // thinking 模型的长请求会超过协议 client 默认 3 分钟超时（且会被误判 stale
        // 杀进程）：自身 deadline + 取消缓冲透传给 requestTimeoutMs。
        requestTimeoutMs: 200_000,
      }),
    );
    return result.text ?? "";
  };
}
