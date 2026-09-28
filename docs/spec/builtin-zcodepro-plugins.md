# ZcodePro 插件内置化（Builtin Plugins）

状态：已实现（一期）｜日期：2026-09-29｜范围：desktop 打包链 + dev 链 + bootstrap seed 定义

## 动机

仓库根目录已合入 luxi233/ZcodePro 插件市场（见 [[zcodepro-plugin-marketplace-merge]]，合并提交 9c6c7a1），
`plugins/` 下 12 个插件包正是 `official-plugin-definitions.ts` 中 12 个官方 definition 的包源——
官方体系里它们经官方 CDN/SEA 分发，本 fork 审计策略默认断连官方服务（`officialPlatformPolicy` 全关），
definition 的 `rootCandidates` 指向的 `apps/zcode-cli/packages/<name>-plugin` 又不存在，
导致这 12 个内置插件在 fork 中 seed 落空、商店公开分段永远缺失。

本 spec 把「随包分发 + 启动播种」的路径接上：构建期把根目录 `plugins/*-plugin` stage 进
`bundled-agents/<key>/glm/packages/<name>-plugin`，运行期 bootstrap 的 filesystem seed（`entrypointDir()`
首候选）自动命中，插件进入 `zcode-plugins-official` 市场 bundled 分片。纯本地、无网络。

## 数据流与所有者

```
仓库根 plugins/*-plugin            （vendor 源，唯一定义：packages/desktop/scripts/stage-vendored-official-plugins.mjs 的表）
        │  stage（打包链 prepare-agent-node-bundle.mjs ／ dev 链 build-desktop-agent-cli.mjs，
        │  两链共用同一模块；必须发生在 stageAgentBundle 清空 glmDir 之后）
        ▼
packages/desktop/bundled-agents/<key>/glm/packages/<name>-plugin
        │  electron-builder extraResources：bundled-agents/<key>/glm → 资源 glm/（打包态）
        ▼
bootstrap bundled-plugins.ts resolveFilesystemPluginRoot
        （candidateBaseDirs = [entrypointDir()=glm, __dirname, cwd] × definition.rootCandidates）
        ▼
Agent storage：<storage>/cli/plugins/marketplaces/zcode-plugins-official/bundled-marketplace.json
             + cache/zcode-plugins-official/<name>/<version>/
        ▼
商店「公开」分段（Public Segment）展示与安装；defaultEnabled 决定首启启用集合
```

状态所有者：
- staging 内容 → 本 spec 的 staging 模块（唯一 vendor 表，含 MCP 依赖内联处理）；
- definition（name/version/rootCandidates/requiredSeedPaths/defaultEnabled/listing）→
  `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`；
- 默认启用集合 → 上述文件派生（`DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`），shared 的
  `plugin-marketplaces.ts` 手写副本必须与之机械一致（有对照测试）。

## 插件清单与默认开关

| definition name | vendored 包 | version | defaultEnabled |
|---|---|---|---|
| documents / pdf / presentations / spreadsheets | `*-plugin` | 0.1.7 | true |
| image-search | image-search-plugin | 0.1.1 | true |
| skill-creator / plugin-creator | `*-plugin` | 0.1.0 / 0.1.1 | true |
| zcode-guide | zcode-guide-plugin | 0.3.0 | true |
| restore-legacy-sessions | restore-legacy-sessions-plugin | 0.1.0 | false |
| android-emulator / ios-simulator | `*-plugin` | 0.1.0 | false |
| computer-use | zcode-cua-plugin | 0.6.3 | false |

（browser-use、node-repl-host 两个原生包不在本 spec 范围，维持既有 staging。）

## 关键处理

1. **seed 顶层白名单**：vendored 包的顶层路径全部命中现有白名单（agents/commands/dist/docs/hooks/
   package.json/README/scripts/skills/templates/.mcp.json/.zcode-plugin），无需扩展；
   插件内 `node_modules` 被有意排除（seed 与 staging 同样跳过，避免 40MB+ 依赖入库产物）。
2. **MCP 依赖内联**：android-emulator 与 ios-simulator 的 `dist/mcp/server.js` 是 bundle，但上游
   esbuild 把 `ajv`/`ajv-formats` 留作 external；seed 缓存无 node_modules，运行时必然解析失败。
   staging 时检测 bare import 并用 esbuild（`nodePaths` 指向仓库根 node_modules）重新内联，
   `node:*` 保持 external。其余 10 个插件无此问题（无 dist/mcp/server.js 或内容纯 markdown）。
3. **zcode-guide 0.3.0 形态**：上游 0.3.0 删除了 `commands/`（/workflow 命令）与
   `skills/dynamic-workflows/`，definition 的 requiredSeedPaths 同步改为六个诊断/配置 SKILL.md；
   dynamic-workflows 技能仍由 bundled-skills 包（glm/packages/bundled-skills）提供，不丢失。
4. **image-search 依赖官方 API**：其 MCP 为 http 指向 `${ZCODE_BASE_URL}`（zcode_official jwt 鉴权），
   审计 fork 默认断连下该 MCP 连接失败属预期降级，不在本 spec 处理。
5. **computer-use 一期边界**：包照常 stage（文档/技能/客户端脚本可 seed），但 CUA 运行时
   （runtimes/zcode-cua → resources/tools/zcode-cua、签名 helper app、workspace stub 替换）不随包，
   插件保持默认关闭；运行时内置化为二期。

## 验收场景

1. 干净跑 `pnpm --filter @zcode/desktop prepare:agent-bundle`（或 bundle:desktop）后，
   `bundled-agents/<key>/glm/packages/` 含 12 个 `*-plugin`，且两处 `dist/mcp/server.js` 内无
   bare import（node: 前缀除外）。
2. dev：`pnpm dev:desktop` 后同目录同样有 12 个包；商店公开分段出现 12 个插件；
   默认启用的 10 个开箱可用（`/doctor`、文档技能等）。
3. 安装默认关闭的 android-emulator：skills/commands/hooks/templates 完整、MCP server 可启动。
4. `tsx --test` 对照测试通过：definition version == vendored manifest version；staging 表覆盖
   definitions 全部 12 个；requiredSeedPaths 存在；shared 与 bootstrap 默认启用集合一致。
5. 卸载某内置插件 → 重启不回植（Restorable Builtin 抑制语义不变）。

## 明确不做（二期）
- CUA 运行时内置（extraResources + helper 签名/下载 + stub 替换 + `patch-cua-runtime.cjs` 退役）。
- 官方 CDN 市场与 `officialPlatformPolicy` 开关语义不变。
- 根目录 `marketplace.json`（zcode-plugins 个人市场身份）与内置链路互不干扰，维持原样。
