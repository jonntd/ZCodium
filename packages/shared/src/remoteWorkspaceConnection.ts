/** 远程工作区连接的业务触发来源；保持跨版本请求字段和值兼容。 */
// fork 独有文件：类型本体已随上游收敛进 remoteUsageTelemetry，这里 re-export 保持 fork 消费方 import 路径不变。
export type { RemoteWorkspaceConnectTrigger } from "./remoteUsageTelemetry.js";
