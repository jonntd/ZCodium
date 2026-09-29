import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
async function sources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) =>
      e.isDirectory()
        ? sources(`${dir}/${e.name}`)
        : /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")
          ? [`${dir}/${e.name}`]
          : [],
    ),
  );
  return nested.flat();
}
test("UI and platform adapters have no telemetry collection or reporting entrypoints", async () => {
  for (const dir of ["packages/ui/src", "packages/web/src", "packages/desktop/src/renderer"]) {
    for (const file of await sources(root + dir)) {
      assert.doesNotMatch(
        await readFile(file, "utf8"),
        /reportTelemetryEvent|reportArmsCustomEvent|reportAppTelemetryEvent|runUserAction|startUserAction|ConversationTelemetrySupervisor|\/telemetry\//,
        file,
      );
    }
  }
});
test("platform and server do not expose or initialize reporting", async () => {
  assert.doesNotMatch(
    await readFile(root + "packages/shared/src/platform.ts", "utf8"),
    /reportTelemetryEvent|reportArmsCustomEvent|RendererActionTrace/,
  );
  for (const dir of ["packages/server/src", "packages/zcode-server-cli/src"]) {
    for (const file of await sources(root + dir))
      assert.doesNotMatch(await readFile(file, "utf8"), /processResourceTelemetry\s*:/, file);
  }
});

// 原先还有一条“购买 WebView 不注入追踪上下文”的用例，它动态读取并执行
// packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts。
// 该模块（连同 createCodingPlanAuthInjectionScript / createCodingPlanCredentialClearScript）
// 已在 4772e77「删除购买弹窗组件」中随 CodingPlanEmbeddedWebviewDialog 一并移除，
// 全仓库再无实现，用例必然 ENOENT 失败，故随模块一并删除。
