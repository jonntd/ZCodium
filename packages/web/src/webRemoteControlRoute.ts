/**
 * ⚠ 未接线（休眠代码，勿当活代码推理）——2026-10-17 复核，依据
 * `docs/spec/web-remote-ui-parity.md` §8.4/§8.5。
 *
 * 「路线 B（官方中继）」手机页的 `/remote/v4` 路由解析；fork 的 main.tsx 是
 * relay.mjs 入口（单页 SPA，无版本化 base），不调用本函数。
 * `test/webRemoteControlRoute.test.pending.ts` 断言 main.tsx 应含该调用——与 fork 刻意分道。
 */
import { resolveWebRemoteControlRoutePathFromBaseUrl } from "@zcode/shared";

interface WebRemoteControlRouteEnv {
  readonly VITE_WEB_REMOTE_CONTROL_ROUTE_PATH?: string;
  readonly BASE_URL: string;
}

/**
 * 页面路由与资源目录分离：OSS 多版本发布用 `/remote/v4/<version>/` 作为 Vite base，
 * 让每个子资源请求自带版本，但页面入口仍是 `/remote/v4`。构建时注入路由变量即可覆盖；
 * 未注入（Docker、v3、开发 `/remote`）时沿用 BASE_URL 推导，行为与历史一致。
 */
export function resolveWebRemoteControlRoutePath(env: WebRemoteControlRouteEnv): string {
  const explicitRoutePath = env.VITE_WEB_REMOTE_CONTROL_ROUTE_PATH?.trim();
  return resolveWebRemoteControlRoutePathFromBaseUrl(explicitRoutePath || env.BASE_URL);
}
