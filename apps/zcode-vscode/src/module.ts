/**
 * zcode-vscode 模块清单：深度绑定内部模块的 VS Code 宿主。
 * 依赖声明与 architecture-policy.yaml 保持一致（requires 声明 shared / services / client / ui / rpc）：
 * 协议契约唯一所有者回归 @zcode/shared；传输/Agent 服务复用 @zcode/services；
 * Webview 连接复用 @zcode/client；UI 复用 @zcode/ui；桥 rpc 帧直通 @zcode/rpc 栈。
 */
export const zcodeVscodeModule = {
  id: "gode",
  requires: ["shared", "services", "client", "ui", "rpc"],
  provides: ["gode-vscode-extension"],
  publicEntrypoints: ["extension.ts"],
} as const;
