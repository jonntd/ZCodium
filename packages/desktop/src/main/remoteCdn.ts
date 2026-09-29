import { isOfficialServiceEnabled, ZCODE_VERSION, type ZCodeEnv } from "@zcode/shared";

declare const __ZCODE_CDN_BASE_URL__: string | undefined;
declare const __ZCODIUM_REMOTE_ASSET_CDN_BASE_URL__: string | undefined;
const DEFAULT_CDN_BASE_URL = "";

export interface ResolveRemoteCdnOptions {
  env?: ZCodeEnv;
  locale?: string;
  timeZone?: string;
  overrideBaseUrl?: string;
  /** 构建内置的自有发布源；测试可显式注入，生产从编译期 define 读取。 */
  bundledBaseUrl?: string;
  version?: string;
  now?: Date;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("CDN URL must use http or https");
  return value.replace(/\/+$/, "");
}

function readBundledRemoteAssetBaseUrl(): string {
  // 发布构建注入本仓库该 tag 的 GitHub Release 资产地址；dev/本地构建为空串。
  return typeof __ZCODIUM_REMOTE_ASSET_CDN_BASE_URL__ === "undefined"
    ? ""
    : __ZCODIUM_REMOTE_ASSET_CDN_BASE_URL__.trim();
}

export function resolveRemoteCdnBaseUrls(options: ResolveRemoteCdnOptions = {}): string[] {
  // 1) 用户显式覆盖：自有源，不受官方服务开关影响。
  // 放在第一位，避免默认关闭的 marketplace 把自建源一起拦掉
  //（表现为“连 WSL/SSH 需要先打开插件市场开关”）。
  const override = options.overrideBaseUrl?.trim();
  if (override) return [normalizeBaseUrl(override)];

  // 2) 发布构建内置的自有源（本仓库 GitHub Release 资产）：同样不是官方平台，
  //    不受开关影响，安装后的客户端开箱即可连接 WSL/SSH，无需用户配置环境变量。
  const bundled = options.bundledBaseUrl?.trim() || readBundledRemoteAssetBaseUrl();
  if (bundled) return [normalizeBaseUrl(bundled)];

  // 3) 默认（或构建注入）的官方 CDN 仍由 marketplace 开关把关：审计版不自动连接官方 CDN。
  if (!isOfficialServiceEnabled("marketplace")) return [];
  const baseUrl =
    process.env.ZCODE_CDN_BASE_URL?.trim() ||
    (typeof __ZCODE_CDN_BASE_URL__ === "undefined" ? "" : __ZCODE_CDN_BASE_URL__) ||
    DEFAULT_CDN_BASE_URL;
  return [
    `${normalizeBaseUrl(baseUrl)}/zcode/electron/releases/${options.version ?? ZCODE_VERSION}`,
  ];
}
