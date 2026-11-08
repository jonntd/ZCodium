/** 校验 mock fixture 能否被真实 ProviderConfigService 解析出 provider。 */
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
// ProviderConfigService 从 @zcode/provider 导出
import { ProviderConfigService } from "@zcode/provider";

const FIXTURES = "/Users/jonntd/Gode/apps/zcode-vscode/e2e/fixtures";
const dir = mkdtempSync(join(tmpdir(), "zcode-fixture-test-"));
const personalFile = join(dir, "provider_config.json");
copyFileSync(join(FIXTURES, "mock-provider-config.json"), personalFile);

const repo = new NodePersonalProviderConfigRepository({ filePath: personalFile });
const service = new ProviderConfigService({
  personalRepository: repo,
  zcodeBuiltinSource: {
    read: async () => ({ schemaVersion: 1, revision: 0, config: { providerConfigRules: { templateRules: [] } } }),
  },
});
const snapshot = await service.read();
const providers = snapshot?.providers ?? snapshot?.effectiveProviders ?? [];
console.log("keys:", Object.keys(snapshot ?? {}));
console.log("provider 数:", Array.isArray(providers) ? providers.length : JSON.stringify(providers).slice(0, 200));
console.log(JSON.stringify(snapshot, null, 1).slice(0, 1200));
