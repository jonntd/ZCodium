/**
 * Mermaid 渲染的运行时开关（PRD §4.4.5 降级）：宿主把 `zcodium.mermaidRendering`
 * 设置随引导下发后由入口应用到这里；关闭时消息里的 mermaid 围栏不再拉起 mermaid
 * 引擎，退化为普通代码块（「点击在完整界面查看」由完整界面的独立预览承担）。
 * 模块级状态、默认开启：桌面全量 UI 不下发时行为不变。
 */
let mermaidRenderingEnabled = true;

export function setMermaidRenderingEnabled(enabled: boolean): void {
  mermaidRenderingEnabled = enabled;
}

export function isMermaidRenderingEnabled(): boolean {
  return mermaidRenderingEnabled;
}
