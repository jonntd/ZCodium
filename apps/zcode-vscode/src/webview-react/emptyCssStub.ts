/**
 * 空 CSS 桩（webview 构建面专用）。
 *
 * esbuild.mjs 把装配闭包内 JS 侧的 css side-effect 导入重定向到本模块：
 * 组件级样式统一收口在 tailwind 入口 src/webview-react/styles.css（chatPanel 只服务
 * main.js + styles.css 两个产物，JS 打包面不应再产出孤儿 main.css）。
 */
export {};
