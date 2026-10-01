// 交付后断线「提示策略」的测试（契约见 docs/spec/web-bootstrap-delivery-point.md §2.2）。
//
// 这里钉住的是一条会退化成灾难的规则：被其他页面顶替（4004）时**不得**给重连按钮。
// 一旦退化成「一律给重连」，两个标签会互相顶替、各自刷新，形成刷新拉锯。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WEB_CLIENT_REPLACED_CLOSE_CODE,
  resolveConnectionLostAction,
  resolveConnectionLostNoticePolicy,
} from "../src/connectionLostNotice.ts";

test("被其他页面顶替（4004）：只提示，不给重连按钮", () => {
  assert.deepEqual(resolveConnectionLostNoticePolicy(WEB_CLIENT_REPLACED_CLOSE_CODE), {
    kind: "replaced",
    showReconnect: false,
  });
});

test("桌面离线/网络断开：提示 + 重连按钮", () => {
  // 4002 host-offline、4003 client-offline、1006 异常断开、1000 正常关闭都归这一类。
  for (const code of [4002, 4003, 1006, 1000]) {
    assert.deepEqual(
      resolveConnectionLostNoticePolicy(code),
      { kind: "lost", showReconnect: true },
      `close code ${code} 应为「桌面离线」提示并允许重连`,
    );
  }
});

test("默认（未 opt-in autoReconnect）：一律只提示，绝不自动重载", () => {
  for (const closeCode of [4002, 4003, 1006, WEB_CLIENT_REPLACED_CLOSE_CODE]) {
    assert.equal(
      resolveConnectionLostAction({ closeCode, autoReconnect: false, reloadAllowed: true }),
      "notice",
      `close code ${closeCode} 在默认配置下必须只提示`,
    );
  }
});

test("opt-in autoReconnect：桌面离线时自动整页重载", () => {
  assert.equal(
    resolveConnectionLostAction({ closeCode: 4002, autoReconnect: true, reloadAllowed: true }),
    "reload",
  );
});

test("opt-in autoReconnect + 限流未放行：退回提示（防刷新循环）", () => {
  assert.equal(
    resolveConnectionLostAction({ closeCode: 4002, autoReconnect: true, reloadAllowed: false }),
    "notice",
  );
});

test("opt-in autoReconnect：被其他页面顶替（4004）仍只提示（防多标签刷新拉锯）", () => {
  assert.equal(
    resolveConnectionLostAction({
      closeCode: WEB_CLIENT_REPLACED_CLOSE_CODE,
      autoReconnect: true,
      reloadAllowed: true,
    }),
    "notice",
  );
});
