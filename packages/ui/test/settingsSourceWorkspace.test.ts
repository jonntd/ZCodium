import { describe, expect, it } from "vitest";
import { buildSourceSettingsProjectionKey } from "@/settings/settingsSourceWorkspace.js";

describe("buildSourceSettingsProjectionKey", () => {
  it("authority 参与投影 key：两台设备同 home 路径互不串投影", () => {
    // Bug 回归：远端「用户」只有 home 路径没有 identity，裸路径比较会把 A 设备的插件投影
    // 匹配到 B 设备的同路径目标。authority（source-settings:<id>）必须参与 key。
    const deviceA = buildSourceSettingsProjectionKey("/root", undefined, "source-settings:dev-a");
    const deviceB = buildSourceSettingsProjectionKey("/root", undefined, "source-settings:dev-b");
    expect(deviceA).not.toBe(deviceB);
    expect(deviceA).toBe("source-settings:dev-a\0/root");
  });

  it("无 authority 时 identity 优先于 path，且与 getWorkspaceKey 同序", () => {
    expect(buildSourceSettingsProjectionKey("/repo", "remote:ssh:/repo", undefined)).toBe(
      "remote:ssh:/repo",
    );
    expect(buildSourceSettingsProjectionKey("/repo", undefined, undefined)).toBe("/repo");
    expect(buildSourceSettingsProjectionKey(undefined, undefined, undefined)).toBe("");
  });

  it("identity 与 authority 均按 trim 归一", () => {
    expect(buildSourceSettingsProjectionKey("/repo", "  ", " source-settings:a ")).toBe(
      "source-settings:a\0/repo",
    );
  });
});
