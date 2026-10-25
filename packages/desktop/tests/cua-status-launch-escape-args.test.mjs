// 设置页 standalone 启动链的 peer escape argv 守卫（docs/spec/cua-runtime-builtin.md §D 第 5 层）。
//
// 背景：helper 的 broker peer 三道门对 same-uid 对端的唯一放行口是显式 argv
// `--allow-external-broker-client-local-dev` 且 SEA 内嵌 dev policy 允许；fork 随包
// helper 是 patch+adhoc 变体（内嵌门已翻真），但打包态 host bundle 的
// isCuaLocalDevelopmentRuntime 编译期折叠恒 false——launchStandaloneCuaHelperForStatus
// 若按 dev 门传参，这条链就成为全链路唯一漏传点：helper 正常启动监听但拒绝自家 host
// 的每个连接（exit log 连篇 "peer verification failed"，90s 后 startup-claim-timeout
// 自杀），getStatus 永不可用，设置页冷启动无缓存时永久停在「正在验证… + 未知」。
// （2026-10-25 打包态真机实锤：/tmp/zcode-cua-zcodium-<uid>/broker.sock.settings.exit.log）
//
// 这里防守三层：vendor argv 合同（标志确实是放行口）、fork 纯函数无条件携带成对标志、
// node.ts 不得回退成 dev 门控。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCuaStatusLaunchOpenArgs } from "../../../packages/services/src/cua-permission-broker/cuaHelperInstaller.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const vendor = await import(
  new URL("../../../runtimes/zcode-cua/vendor/dist-index.js", import.meta.url).href
);

const BASE_SPEC = {
  appPath: "/Applications/ZCodium.app/Contents/Resources/cua-helper/ZCodium Computer Use.app",
  socketPath: "/tmp/zcode-cua-zcodium-501/broker.sock",
  exitLogPath: "/tmp/zcode-cua-zcodium-501/broker.sock.settings.exit.log",
};

const UNSIGNED_LAUNCHER_ARG = "--allow-unsigned-launcher-local-dev";
const EXTERNAL_BROKER_CLIENT_ARG = "--allow-external-broker-client-local-dev";

test("vendor buildHelperOpenArgs：一对 escape 标志原样落 argv（helper peer 门的唯一放行口）", () => {
  const withEscape = vendor.buildHelperOpenArgs({
    ...BASE_SPEC,
    allowUnsignedLauncherLocalDev: true,
    allowExternalBrokerClientLocalDev: true,
  });
  assert.ok(withEscape.includes(UNSIGNED_LAUNCHER_ARG), "argv 缺 --allow-unsigned-launcher-local-dev");
  assert.ok(
    withEscape.includes(EXTERNAL_BROKER_CLIENT_ARG),
    "argv 缺 --allow-external-broker-client-local-dev（peer 三道门会拒所有 same-uid 对端）",
  );

  // 不带标志时不得出现（证明放行口确实由 argv 门控，而非 env/编译态单独决定）。
  const withoutEscape = vendor.buildHelperOpenArgs({ ...BASE_SPEC });
  assert.ok(!withoutEscape.includes(UNSIGNED_LAUNCHER_ARG));
  assert.ok(!withoutEscape.includes(EXTERNAL_BROKER_CLIENT_ARG));
});

test("buildCuaStatusLaunchOpenArgs 无条件携带一对 escape（不随 dev 判定开关）", () => {
  const specs = [];
  const argv = buildCuaStatusLaunchOpenArgs({
    ...BASE_SPEC,
    buildOpenArgs: (spec) => {
      specs.push(spec);
      return [];
    },
  });
  assert.deepEqual(argv, []);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].appPath, BASE_SPEC.appPath);
  assert.equal(specs[0].socketPath, BASE_SPEC.socketPath);
  assert.equal(specs[0].exitLogPath, BASE_SPEC.exitLogPath);
  assert.equal(specs[0].allowUnsignedLauncherLocalDev, true);
  assert.equal(specs[0].allowExternalBrokerClientLocalDev, true);
});

test("node.ts 设置页启动链使用 buildCuaStatusLaunchOpenArgs，且不得回退成 dev 门控", () => {
  const nodeTs = readFileSync(
    resolve(repoRoot, "packages/services/src/node.ts"),
    "utf8",
  );
  assert.ok(
    nodeTs.includes("buildCuaStatusLaunchOpenArgs({"),
    "launchStandaloneCuaHelperForStatus 必须经 buildCuaStatusLaunchOpenArgs 构造启动 argv",
  );
  assert.ok(
    !nodeTs.includes("isCuaLocalDevelopmentRuntime(process.env)"),
    "设置页启动链不得按 isCuaLocalDevelopmentRuntime 门控 escape：打包态该常量恒 false，" +
      "漏传标志会让 patched helper 的 peer 三道门拒掉自家 host（2026-10-25 事故）",
  );
});
