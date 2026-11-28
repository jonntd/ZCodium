/** fork no-telemetry 审计版垫片：UI 性能 ARMS 遥测移除后保留零上报入口。 */
export function reportUiPerfEvent(_event: Record<string, unknown>): void {}
