import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// 发布契约：CI 预发布用 ZCODE_APP_VERSION 注入完整审计版本，构建元数据必须优先采用它。
// 修复原因：2026-10 上游同步（06e0b728）删掉了注入，预发布产物仍写 package.json 版本，
// release 校验器报 "Metadata version mismatch" 并拒绝上传。
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function collectAppVersion() {
  const { collectBuildMetadata } = await import("../scripts/build-metadata.mjs");
  return collectBuildMetadata().appVersion;
}

describe("构建元数据版本", () => {
  it("优先采用 CI 注入的完整审计版本", async () => {
    vi.stubEnv("ZCODE_APP_VERSION", "1.17.1-audit.20261026");

    await expect(collectAppVersion()).resolves.toBe("1.17.1-audit.20261026");
  });

  it("本地构建回退到 package.json 版本", async () => {
    vi.stubEnv("ZCODE_APP_VERSION", "   ");
    const rootPackage = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    await expect(collectAppVersion()).resolves.toBe(rootPackage.version);
  });
});
