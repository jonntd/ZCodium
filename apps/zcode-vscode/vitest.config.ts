import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // ui 包内部 `@/...` 别名（conversationTransportFactory 等装配代码经 ui 源码直连）。
      "@": resolve(__dirname, "../../packages/ui/src"),
    },
  },
  test: {
    // 桥/装配/平台服务单测与 P0 等价回归位于 test/，模块契约测试位于 src/contract.test.ts。
    include: ["test/**/*.test.ts", "src/contract.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
