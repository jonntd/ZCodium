// 中继前端产物「新鲜度」判定的测试（docs/spec/web-remote-ui-parity.md §7）。
//
// 钉住的规则：**先比 commit，commit 不知道才退到 version；任一侧缺信息就不提示（fail-open）**。
// 这条直接决定用户会不会看到「中继前端产物已过期」的提示 —— 2026-10-09 的
// 「提示词页面不一致」就是产物过期造成的，而它当时被误判成 UI bug。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  relayBundleFreshnessNoticeKey,
  resolveRelayBundleFreshnessNotice,
} from "../src/relayBundleFreshness.ts";

test("commit 一致：不提示（同一次构建）", () => {
  assert.equal(
    resolveRelayBundleFreshnessNotice(
      { version: "3.14.7", commit: "0901a15" },
      { version: "3.14.7", commit: "0901a15" },
    ),
    null,
  );
});

test("commit 不一致：提示 commit-mismatch", () => {
  const notice = resolveRelayBundleFreshnessNotice(
    { version: "3.14.7", commit: "0901a15" },
    { version: "3.14.7", commit: "deadbee" },
  );
  assert.deepEqual(notice, {
    kind: "commit-mismatch",
    bundleCommit: "0901a15",
    hostCommit: "deadbee",
  });
});

test("commit 长度不同但指向同一次提交：不提示（短 SHA vs 全 SHA / 7 位 vs 8 位）", () => {
  // 桌面是 `git rev-parse --short=8 HEAD`（8 位），web 可能是 CI 注入的全 SHA。
  // 直接 === 会把这些判成"不一致"从而每次都误报。
  const full = "0901a1581234567890abcdef1234567890abcdef";
  assert.equal(resolveRelayBundleFreshnessNotice({ commit: "0901a158" }, { commit: full }), null);
  assert.equal(
    resolveRelayBundleFreshnessNotice({ commit: "0901a15" }, { commit: "0901a158" }),
    null,
  );
  // 大小写/空白差异同理
  assert.equal(
    resolveRelayBundleFreshnessNotice({ commit: "0901A158" }, { commit: " 0901a158 " }),
    null,
  );
});

test("前缀宽松有下界：短于 7 位的前缀不算同一次提交", () => {
  const notice = resolveRelayBundleFreshnessNotice({ commit: "0901a" }, { commit: "0901a158" });
  assert.deepEqual(notice, {
    kind: "commit-mismatch",
    bundleCommit: "0901a",
    hostCommit: "0901a158",
  });
});

test("commit 一致时不再看 version（版本号相同是常态，比它没有意义）", () => {
  assert.equal(
    resolveRelayBundleFreshnessNotice(
      { version: "3.14.7", commit: "0901a15" },
      { version: "9.9.9", commit: "0901a15" },
    ),
    null,
  );
});

test("任一侧 commit 不知道：退到 version 比较", () => {
  // bundle 无 commit（源码包 / 无 .git），host 有 → 比版本号
  assert.deepEqual(
    resolveRelayBundleFreshnessNotice(
      { version: "3.14.7", commit: "unknown" },
      { version: "3.15.0", commit: "deadbee" },
    ),
    { kind: "version-mismatch", bundleVersion: "3.14.7", hostVersion: "3.15.0" },
  );
  // host 没上报 commit（非 E2EE 路径：中继只回 version）
  assert.deepEqual(
    resolveRelayBundleFreshnessNotice(
      { version: "3.14.7", commit: "0901a15" },
      { version: "3.15.0" },
    ),
    { kind: "version-mismatch", bundleVersion: "3.14.7", hostVersion: "3.15.0" },
  );
});

test("version 一致：不提示", () => {
  assert.equal(
    resolveRelayBundleFreshnessNotice(
      { version: "3.14.7", commit: "unknown" },
      { version: "3.14.7" },
    ),
    null,
  );
});

test("fail-open：缺信息一律不提示，绝不误报", () => {
  assert.equal(resolveRelayBundleFreshnessNotice({}, {}), null);
  assert.equal(resolveRelayBundleFreshnessNotice({ version: "3.14.7" }, {}), null);
  assert.equal(resolveRelayBundleFreshnessNotice({}, { version: "3.15.0" }), null);
  // 整个入参缺席（网络 JSON 字段缺失）也不能抛
  assert.equal(resolveRelayBundleFreshnessNotice(undefined, undefined), null);
  assert.equal(resolveRelayBundleFreshnessNotice(null, null), null);
  assert.equal(resolveRelayBundleFreshnessNotice(undefined, { commit: "aaa" }), null);
});

test("占位值不算「知道」：unknown / 0.0.0-dev / relay", () => {
  // 两侧都是占位 commit → 退到 version；version 也是占位 → 不提示
  assert.equal(
    resolveRelayBundleFreshnessNotice(
      { version: "0.0.0-dev", commit: "unknown" },
      { version: "relay", commit: "unknown" },
    ),
    null,
  );
  // 中继在桌面从未上报 appVersion 时给的是 "relay"，不能当成真版本号去比
  assert.equal(
    resolveRelayBundleFreshnessNotice({ version: "3.14.7" }, { version: "relay" }),
    null,
  );
  // 空串 / 纯空白同样不算知道
  assert.equal(
    resolveRelayBundleFreshnessNotice({ version: "   ", commit: "  " }, { version: "3.15.0" }),
    null,
  );
});

test("提示去重键：换一组不一致就是新的一条", () => {
  const a = resolveRelayBundleFreshnessNotice({ commit: "aaa" }, { commit: "bbb" });
  const b = resolveRelayBundleFreshnessNotice({ commit: "aaa" }, { commit: "ccc" });
  const c = resolveRelayBundleFreshnessNotice({ version: "1.0.0" }, { version: "2.0.0" });
  assert.ok(a && b && c);
  assert.notEqual(relayBundleFreshnessNoticeKey(a), relayBundleFreshnessNoticeKey(b));
  assert.notEqual(relayBundleFreshnessNoticeKey(a), relayBundleFreshnessNoticeKey(c));
  assert.equal(relayBundleFreshnessNoticeKey(a), relayBundleFreshnessNoticeKey(a));
});
