/**
 * 中继前端产物「新鲜度」判定（docs/spec/web-remote-ui-parity.md §7）。
 *
 * 背景：中继托管的是**手动部署的静态产物** `packages/web/dist`。桌面 App 更新（或本地
 * 重新构建）之后，手机打开的还是旧 bundle —— 症状是「同一个设置页两侧长得不一样」，
 * 且极易被误判成 UI bug。2026-10-09 的「提示词页面不一致」就是这么来的：手机缺
 * 「当前作用域」徽标 / 「常用段落」小节 / 「推荐模板」入口 / 「回复语言」字段，
 * 模式按钮还停在旧文案「追加」。
 *
 * 本模块只做**纯判定**：拿到「bundle 自己的版本/提交」与「桌面 Host 上报的版本/提交」
 * 后决定要不要提示。**fail-open** —— 任一侧缺信息就不提示，宁可不提示也不要误报。
 */

export interface RelayBundleStamp {
  version?: string | null;
  commit?: string | null;
}

export type RelayBundleFreshnessNotice =
  | { kind: "commit-mismatch"; bundleCommit: string; hostCommit: string }
  | { kind: "version-mismatch"; bundleVersion: string; hostVersion: string };

/**
 * 占位值不算「知道」：
 * - `unknown` 是 `@zcode/shared/version.ts` 在无 define 时的 fallback，也是 web 构建取不到 git 时的值；
 * - `0.0.0-dev` 是非构建环境的版本 fallback；
 * - `relay` 是中继在桌面从未上报过 appVersion 时给 `/api/server-info` 的兜底字符串
 *   （`deploy/vps-relay/relay.mjs` 的 `buildServerInfo()`），不是真版本号。
 */
const COMMIT_PLACEHOLDERS = ["unknown"];
const VERSION_PLACEHOLDERS = ["unknown", "0.0.0-dev", "relay"];

function isKnown(value: string | null | undefined, placeholders: string[]): value is string {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 && !placeholders.includes(trimmed);
}

/** git 短 SHA 的约定最小长度：`git rev-parse --short` 至少给 7 位。 */
const MIN_COMMIT_PREFIX_LENGTH = 7;

/**
 * commit 戳是否指向同一次提交。
 *
 * **不能直接 `===`**：两侧的戳来自不同来源，长度可能不同 ——
 * 桌面是 `git rev-parse --short=8 HEAD`（8 位，见 build-metadata.mjs），
 * web 构建可能是 CI 注入的完整 40 位 SHA，也可能是短 SHA。
 * 因此按"一方是另一方的前缀，且较短一方 ≥7 位"判定：git 保证 7 位在仓库内唯一，
 * 所以这个宽松度不会把两次不同的提交判成相同。
 */
function isSameCommit(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= MIN_COMMIT_PREFIX_LENGTH && longer.startsWith(shorter);
}

/**
 * 判定顺序：**先比 commit，再比 version**。
 *
 * commit 一致就直接返回 null —— 同一提交构建出来的产物，版本号必然相同，
 * 没必要再比一遍（也避免"版本号相同但产物不同"这种噪声）。
 * commit 任一侧不知道时才退到版本号：这条只在「桌面发版更新、中继产物没跟着重发」
 * 时有效（本地开发两边版本号都是 package.json 的同一个值，比不出差异）。
 */
export function resolveRelayBundleFreshnessNotice(
  bundle: RelayBundleStamp | null | undefined,
  host: RelayBundleStamp | null | undefined,
): RelayBundleFreshnessNotice | null {
  const bundleCommit = bundle?.commit;
  const hostCommit = host?.commit;
  if (isKnown(bundleCommit, COMMIT_PLACEHOLDERS) && isKnown(hostCommit, COMMIT_PLACEHOLDERS)) {
    if (isSameCommit(bundleCommit, hostCommit)) return null;
    return { kind: "commit-mismatch", bundleCommit, hostCommit };
  }

  const bundleVersion = bundle?.version;
  const hostVersion = host?.version;
  if (
    isKnown(bundleVersion, VERSION_PLACEHOLDERS) &&
    isKnown(hostVersion, VERSION_PLACEHOLDERS) &&
    bundleVersion !== hostVersion
  ) {
    return {
      kind: "version-mismatch",
      bundleVersion,
      hostVersion,
    };
  }

  return null;
}

/** 提示语的去重/关闭键：换一次不一致就是新的一条，同一组不一致只提示一次。 */
export function relayBundleFreshnessNoticeKey(notice: RelayBundleFreshnessNotice): string {
  return notice.kind === "commit-mismatch"
    ? `commit:${notice.bundleCommit}->${notice.hostCommit}`
    : `version:${notice.bundleVersion}->${notice.hostVersion}`;
}
