/**
 * 临时工作区判定回归（用户反馈 2026-11-08：任务列表「无限创建」ws (43)…(47)）。
 *
 * 那次污染来自真机冒烟：临时 IDE 的工作区是 `mktemp -d` 的 /tmp/zc-ext-host-smoke.*，
 * 扩展把它当普通工程写进了真实数据根。本测试锁死「临时路径一律不登记」。
 */
import { describe, expect, it } from "vitest";

import { isTransientWorkspacePath } from "../src/features/transientWorkspacePath";

describe("临时工作区判定：不登记为工程", () => {
  it("冒烟脚本的临时工作区被判为临时（复现原始污染路径）", () => {
    expect(isTransientWorkspacePath("/tmp/zc-ext-host-smoke.6rGUDC/ws")).toBe(true);
  });

  it("macOS 软链形态与系统临时目录同样判为临时", () => {
    expect(isTransientWorkspacePath("/private/tmp/zc-ext-host-smoke.ULuVxN/ws")).toBe(
      true,
    );
    expect(isTransientWorkspacePath("/tmp")).toBe(true);
    expect(
      isTransientWorkspacePath(
        "/var/folders/kk/yn05rsp547g98rn_ndpt03kh0000gn/T/some-ws",
      ),
    ).toBe(true);
  });

  it("真实工程路径不受影响", () => {
    expect(isTransientWorkspacePath("/Users/jonntd/ZCodium")).toBe(false);
    expect(isTransientWorkspacePath("/Users/jonntd/ZCodium/apps/zcode-vscode")).toBe(
      false,
    );
    // 形似但不相邻的兄弟路径不能误伤（前缀必须是目录边界）。
    expect(isTransientWorkspacePath("/tmpfoo/ws")).toBe(false);
  });
});
