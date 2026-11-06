/**
 * 完整界面 server 子进程 env 的确定性组装（纯函数，零 vscode/node:child_process 依赖）。
 *
 * 独立成模块的原因：serverHost.ts 经 features/logger 间接依赖 vscode 运行时模块，
 * 无法被 headless vitest 导入（src/CONTRACT.md「门面零 vscode 运行时依赖」口径）；
 * 数据根注入口径需要单测锁定（docs/architecture.md §7.9），故把纯逻辑拆到这里。
 *
 * 数据根口径（docs/architecture.md §7.9，最终口径 = 共享 $HOME/.zcodium）：
 * 生产装配不传 dataBaseDir → 不注入 ZCODE_DATA_BASE_DIR，server 与侧边栏服务栈
 * 同回落 services 默认数据根；该选项仅供 dev/测试隔离显式注入。
 */

export interface ServerEnvOverridesInput {
  /** server 监听端口（findFreePort 产物）。 */
  readonly port: number;
  /** 前端产物目录（ZCODE_WEB_STATIC_ROOT）。 */
  readonly staticRoot: string;
  /** 数据基目录；缺省不注入（共享 services 默认根 $HOME/.zcodium）。 */
  readonly dataBaseDir?: string;
  /** Agent 命令（缺省不注入；安装态 server 自己的 CLI 定位链会全部落空）。 */
  readonly agentCommand?: string;
  /** 与 agentCommand 配套的参数（JSON 序列化为 ZCODE_AGENT_SERVER_ARGS_JSON）。 */
  readonly agentArgs?: readonly string[];
}

/**
 * 组装 server 子进程 env 的覆盖段；调用方以 `{ ...process.env, ...buildServerEnvOverrides(...) }`
 * 合成最终 env（不在此处展开 process.env，保持本函数输出确定性、可断言）。
 */
export function buildServerEnvOverrides(
  input: ServerEnvOverridesInput,
): Record<string, string> {
  return {
    // nodePath 在扩展宿主内是 Electron 二进制：以 Node 模式运行 server 入口。
    ELECTRON_RUN_AS_NODE: "1",
    // 只监听回环，且不设 authToken：webview/浏览器与插件同机，走本地信任。
    HOST: "127.0.0.1",
    ZCODE_SERVER_HOST: "127.0.0.1",
    PORT: String(input.port),
    ZCODE_WEB_STATIC_ROOT: input.staticRoot,
    // 数据根与侧边栏同源：缺省不注入 ZCODE_DATA_BASE_DIR，server 与进程内服务栈
    // 同回落 services 默认根 $HOME/.zcodium（docs/architecture.md §7.9）。
    ...(input.dataBaseDir ? { ZCODE_DATA_BASE_DIR: input.dataBaseDir } : {}),
    // 显式告诉 server 用哪个 CLI：否则安装态下它找不到（serverHost 的 agentCommand 注释）。
    ...(input.agentCommand
      ? {
          ZCODE_AGENT_SERVER_COMMAND: input.agentCommand,
          ...(input.agentArgs
            ? { ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify(input.agentArgs) }
            : {}),
        }
      : {}),
  };
}
