/**
 * zcode-vscode UI 契约出口（vscode 层）。
 *
 * 与 contract.ts（内核门面，无 vscode 运行时依赖、可被 headless 测试加载）分离：
 * 本文件 re-export 平台 UI 类，仅在 VS Code 扩展上下文消费。
 */

export { StatusBar } from "./ui/statusBar";
export type { ZcodiumUiState } from "./ui/statusBar";
export { DiffViewer } from "./ui/diffViewer";
export { Diagnostics } from "./ui/diagnostics";
