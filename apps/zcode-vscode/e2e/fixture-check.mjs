/** 校验 mock fixture 能否被真实 ProviderConfigService 解析出 provider。 */
import { mkdtempSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
// ProviderConfigService 从 @zcode/provider 导出
import { ProviderConfigService } from "@zcode/provider";

// fixtures 目录随脚本位置派生（检出路径无关）；ZCODE_REPO_ROOT 可覆盖仓库根。
const FIXTURES = process.env.ZCODE_REPO_ROOT?.trim()
  ? join(process.env.ZCODE_REPO_ROOT, "apps/zcode-vscode/e2e/fixtures")
  : fileURLToPath(new URL("./fixtures", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "zcode-fixture-test-"));
const personalFile = join(dir, "provider_config.json");
copyFileSync(join(FIXTURES, "mock-provider-config.json"), personalFile);

const repo = new NodePersonalProviderConfigRepository({ filePath: personalFile });
const service = new ProviderConfigService({
  personalRepository: repo,
  zcodeBuiltinSource: {
    read: async () => ({ schemaVersion: 1, revision: 0, config: { providerConfigRules: { templateRules: [] } } }),
    // 服务契约要求变更订阅（返回退订函数）；一次性校验用静态桩。
    onDidChange: () => () => {},
  },
});
const snapshot = await service.read();
// 当前快照形状：个人 provider 在 personalProviders（旧字段 providers/effectiveProviders 已不存在）。
const providers = snapshot?.personalProviders ?? snapshot?.providers ?? [];
console.log("keys:", Object.keys(snapshot ?? {}));
console.log("provider 数:", Array.isArray(providers) ? providers.length : JSON.stringify(providers).slice(0, 200));
console.log(JSON.stringify(snapshot, null, 1).slice(0, 1200));
