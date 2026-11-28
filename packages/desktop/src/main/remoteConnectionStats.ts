/** 远控会话连接统计的纯类型（fork：从 ARMS 遥测模块拆出，遥测上报面按 no-telemetry spec 移除，
 *  数据形状仍被 desktopRemoteSessions / webRemoteControlManager 的连接管理消费）。 */

export interface RemoteConnectionStats {
  activeSessionCount: number;
  activeTargetCount: number;
}

export type RemoteGaugeTransition =
  | "connected"
  | "connection-closed"
  | "disposed"
  | "window-closed"
  | "host-exit"
  | "app-shutdown"
  | "none";

export type RemoteDisconnectReason = Exclude<
  RemoteGaugeTransition,
  "connected" | "none"
>;
