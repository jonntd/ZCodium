import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
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
// A2（保持移除遥测，但允许 v3.18.2 上游空桥）：fork 经 763c3e33/d430d8d0 有意把
// reportTelemetryEvent / reportArmsCustomEvent 收成 IPlatformService 的“空桥”契约
// （web/src/main.tsx 空实现、data-sync 退化为直通回调，宿主侧不采集），因此这两个符号
// 不再是违规；本守卫继续拦的是“真实采集/上报入口”——runUserAction / startUserAction /
// ConversationTelemetrySupervisor / reportAppTelemetryEvent / 直接 import 的 /telemetry/ 模块。
test("UI and platform adapters have no telemetry collection or reporting entrypoints", async () => {
  for (const dir of ["packages/ui/src", "packages/web/src", "packages/desktop/src/renderer"]) {
    for (const file of await sources(root + dir)) {
      assert.doesNotMatch(
        await readFile(file, "utf8"),
        /reportAppTelemetryEvent|runUserAction|startUserAction|ConversationTelemetrySupervisor|\/telemetry\//,
        file,
      );
    }
  }
});
// platform.ts 允许保留上面那组“空桥”方法（不产生 egress），但不得引入真实采集/上报入口。
test("platform and server do not expose or initialize reporting", async () => {
  assert.doesNotMatch(
    await readFile(root + "packages/shared/src/platform.ts", "utf8"),
    /reportAppTelemetryEvent|runUserAction|startUserAction|ConversationTelemetrySupervisor|\/telemetry\//,
  );
  for (const dir of ["packages/server/src", "packages/zcode-server-cli/src"]) {
    for (const file of await sources(root + dir))
      assert.doesNotMatch(await readFile(file, "utf8"), /processResourceTelemetry\s*:/, file);
  }
});

// 原先还有一条“购买 WebView 不注入追踪上下文”的用例，它动态读取并执行
// packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts。
// 该模块（连同 createCodingPlanAuthInjectionScript / createCodingPlanCredentialClearScript）
// 已在 4772e77「删除购买弹窗组件」中随 CodingPlanEmbeddedWebviewDialog 一并移除；
// main 侧 #79 把这条历史改写为下方的防回归用例（断言模块保持删除、官方账号开关不复活）。
test("upstream UI parity never restores the removed purchase WebView or official account switches", async () => {
  // #79：购买 WebView 已随账号能力移除，旧测试不能要求恢复已删除的模块。
  await assert.rejects(
    access(root + "packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts"),
    { code: "ENOENT" },
  );
  const policy = await readFile(root + "packages/shared/src/officialPlatformPolicy.ts", "utf8");
  assert.match(policy, /export type OfficialServiceKey = "marketplace" \| "clientConfig"/);
  assert.match(policy, /function isConversationShareAvailable\(\): boolean\s*\{\s*return false/u);
  for (const file of await sources(root + "packages/ui/src")) {
    assert.doesNotMatch(
      await readFile(file, "utf8"),
      /createCodingPlanAuthInjectionScript|__zcodeReportContext__/,
      file,
    );
  }
});
