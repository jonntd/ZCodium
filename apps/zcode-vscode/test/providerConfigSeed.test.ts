/**
 * 内置 Provider 配置种子文件守护（container 激活期 write-once 的内容面）：
 *
 * services 未传 zcodeBuiltinActiveFilePath 时，`<globalStorage>/provider/builtin.json`
 * 同时充当 Bundled 与 Active，读取方按 provider-node releaseSchema 严格解码后回落
 * Bundled——历史上曾以追加模式写 "{}"，首次读取即解码失败并阻断 Agent spawn。
 * 这里用真实解码器锁定种子 JSON 的形状，防止漂移。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// 直接经 provider-node 源码复用其严格解码器（该包不在本 app 的运行时依赖内，仅测试对打；
// 源码不在本 app tsconfig 工程内，tsc 无法解析其内部 .js 后缀导入——运行时由 vitest 解析）。
// @ts-expect-error — 见上：跨工程源码引用，vitest/esbuild 可解析，tsc 不可。
import { decodeZCodeBuiltinRelease } from "../../packages/provider-node/src/zcode-builtin-release";
import { EMPTY_ZCODE_BUILTIN_RELEASE_JSON } from "../src/host/serviceAssembly";

describe("EMPTY_ZCODE_BUILTIN_RELEASE_JSON（provider 配置种子）", () => {
  it("符合 provider-node releaseSchema 严格解码（schemaVersion/revision/config 全在）", () => {
    const release = decodeZCodeBuiltinRelease(JSON.parse(EMPTY_ZCODE_BUILTIN_RELEASE_JSON));
    expect(release.schemaVersion).toBe(1);
    expect(release.revision).toBe(0);
    expect(Object.keys(release.config)).toEqual([
      "providers",
      "providerTemplates",
      "modelConfigRules",
    ]);
  });

  it('拒绝空对象 "{}"（历史追加写入损坏形状，防回归）', () => {
    expect(() => decodeZCodeBuiltinRelease(JSON.parse("{}"))).toThrow();
  });

  it("与仓库源码常量一字不差（磁盘种子即该内容，write-once 不再触碰）", () => {
    const source = readFileSync(new URL("../src/host/serviceAssembly.ts", import.meta.url), "utf8");
    expect(source).toContain("EMPTY_ZCODE_BUILTIN_RELEASE_JSON");
    expect(JSON.parse(EMPTY_ZCODE_BUILTIN_RELEASE_JSON)).toEqual({
      schemaVersion: 1,
      revision: 0,
      config: {
        providerConfigRules: { templateRules: [], providerRules: [] },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    });
  });
});
