// 旧 npm 包的许可字段缺失或使用非 SPDX 拼写，不能因此给所有版本或未知包放行。
// 原作者补充的同版 metadata 和发布包证据见 third-party/README.md。
const reviewed = new Set(["buffers@0.1.1", "chainsaw@0.1.0"]);

export function legacyLicenseIdentifier(pkg) {
  return pkg.name === "buffers" && pkg.version === "0.1.1" ? "MIT/X11" : undefined;
}

export function isReviewedLegacyLicense(pkg) {
  return reviewed.has(`${pkg.name}@${pkg.version}`) && pkg.license === "MIT/X11";
}

// 构建期专有二进制工具的逐项复核：name@version 精确锁定（版本升级重新阻断，
// 需按新分发物重新核对许可文本后更新）。微软官方 VSIX 签名工具（@vscode/vsce
// 的平台二进制，license 字段为 "SEE LICENSE IN LICENSE.txt" 即 MS Software
// License Terms）：仅在打包/发布扩展时使用，产物为扩展文件本身、该二进制不随
// 产品分发。人工复核 2026-11-14。
const reviewedBuildBinaries = new Set([
  "@vscode/vsce-sign@2.1.0",
  "@vscode/vsce-sign-darwin-arm64@2.0.6",
  "@vscode/vsce-sign-darwin-x64@2.0.6",
  "@vscode/vsce-sign-linux-arm64@2.0.6",
  "@vscode/vsce-sign-linux-x64@2.0.6",
  "@vscode/vsce-sign-win32-arm64@2.0.6",
  "@vscode/vsce-sign-win32-x64@2.0.6",
]);

export function isReviewedBuildBinaryLicense(pkg) {
  return reviewedBuildBinaries.has(`${pkg.name}@${pkg.version}`);
}

// 文档查看器原样分发字体分片并附完整许可；通用分类未收录 OFL 导致导出误阻断。
// 仅接受已核验的精确依赖，不将所有 OFL 字体放行；材料与分发方式见 third-party/README.md。
export function isReviewedBundledFontLicense(pkg) {
  return (
    pkg.name === "@fontsource/noto-sans-sc" && pkg.version === "5.3.1" && pkg.license === "OFL-1.1"
  );
}
