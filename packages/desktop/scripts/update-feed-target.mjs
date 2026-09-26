// 桌面更新源仓库坐标的唯一所有者。
// tsup（define 注入 __ZCODE_UPDATE_GITHUB_OWNER__/__ZCODE_UPDATE_GITHUB_REPO__）
// 与 electron-builder（publish 配置，生成 app-update.yml / latest*.yml）都必须从这里取值，
// 保证运行时 GitHub provider 与发布元数据指向同一个仓库；业务源码不得再硬编码 owner/repo。
const DEFAULT_UPDATE_FEED_TARGET = Object.freeze({
  owner: "jonntd",
  repo: "ZCodium",
});

export function resolveUpdateFeedTarget(env = process.env) {
  const owner = env.ZCODE_UPDATE_GITHUB_OWNER?.trim() || DEFAULT_UPDATE_FEED_TARGET.owner;
  const repo = env.ZCODE_UPDATE_GITHUB_REPO?.trim() || DEFAULT_UPDATE_FEED_TARGET.repo;
  return { owner, repo };
}
