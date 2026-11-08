/**
 * 数据根口径锁定（docs/architecture.md §7.9「数据根」）：
 *
 * 最终口径 = 共享 $HOME/.zcodium（不隔离到插件 globalStorage）。生产装配不设
 * 重定向：createPluginServices 不传 dataRootDir（不触发 setDataRootPathOverride），
 * 侧边栏服务栈回落 services 默认数据根，与桌面端同根共享。
 *
 * 背景：container/serviceAssembly 注释与契约曾描述「隔离到 <globalStorage>/.zcodium」，
 * 与实际解析（paths.ts 回落 $HOME/.zcodium）矛盾；M2 起隔离口径已退役，本测试把
 * 装配面与 services 解析面一起锁死，防止口径漂移。
 *
 * 装配面断言沿用 providerConfigSeed.test.ts 的源码读取模式：container.ts 依赖
 * vscode API，无法在 headless vitest 中直接装配。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZCODE_DATA_ROOT_DIR_NAME } from "@zcode/shared";
import {
  getDataBaseDir,
  getZCodeDataRootDir,
  setDataRootPathOverride,
} from "@zcode/services/node";

const containerSource = readFileSync(
  new URL("../src/container.ts", import.meta.url),
  "utf8",
);

afterEach(() => {
  // getZCodeDataRootDir/getDataBaseDir 是模块级进程状态：本文件不设置任何 override，
  // 这里仅防御性复位（幂等 no-op），避免意外残留影响同 worker 内后续断言。
  setDataRootPathOverride(null);
});

describe("container 装配面：数据根不重定向（docs/architecture.md §7.9）", () => {
  it("createPluginServices 只在显式 ZCODE_DATA_ROOT 时重定向，默认回落 $HOME/.zcodium", () => {
    const call = containerSource.match(
      /const services = createPluginServices\(\{([\s\S]*?)\n  \}\);/,
    );
    expect(call).not.toBeNull();
    // 2026-11-08：真机冒烟把临时工作区注册进真实数据根（用户侧栏堆出「ws (43)…(47)」
    // 空工程），因此开放 ZCODE_DATA_ROOT 给测试隔离——但必须由 env 守卫，生产默认不重定向。
    expect(call![1]).toMatch(/process\.env\.ZCODE_DATA_ROOT/);
    expect(call![1]).toMatch(
      /process\.env\.ZCODE_DATA_ROOT \? \{ dataRootDir: process\.env\.ZCODE_DATA_ROOT \} : \{\}/,
    );
  });

  it("真机冒烟脚本给扩展隔离数据根（不污染用户 ~/.zcodium）", () => {
    const smoke = readFileSync(
      new URL("../scripts/run-extension-host-smoke.sh", import.meta.url),
      "utf8",
    );
    expect(smoke).toContain('ZCODE_DATA_ROOT="$TMP/data"');
  });

  it("spec 与实现同源：docs/architecture.md 保留「数据根口径」条目（口径变更须先改 spec）", () => {
    const spec = readFileSync(
      new URL("../docs/architecture.md", import.meta.url),
      "utf8",
    );
    expect(spec).toContain("数据根口径（最终口径：共享 `$HOME/.zcodium`");
    expect(spec).toContain("test/dataRoot.test.ts");
  });
});

describe("services 数据根解析面：root = join(base, .zcodium)（shared 常量）", () => {
  it("无 override 时 getZCodeDataRootDir 回落 getDataBaseDir() + .zcodium（两侧同根的解析形状）", () => {
    expect(getZCodeDataRootDir()).toBe(
      join(getDataBaseDir(), ZCODE_DATA_ROOT_DIR_NAME),
    );
    // getDataBaseDir() 优先级（packages/services/src/paths.ts:53-58）：setDataBaseDir() >
    // env ZCODE_DATA_BASE_DIR > 默认 home（ZCODE_DESKTOP_HOME_DIR || HOME，paths.ts:19-20）。
    // 本测试不调用 setDataBaseDir；dev 隔离环境（zcode-switch）可能带 env，两分支均合法。
    const envBase = process.env["ZCODE_DATA_BASE_DIR"]?.trim();
    if (envBase) {
      expect(getDataBaseDir()).toBe(envBase);
    } else {
      const defaultHome =
        process.env["ZCODE_DESKTOP_HOME_DIR"]?.trim() ||
        process.env["HOME"]?.trim() ||
        homedir();
      expect(getDataBaseDir()).toBe(defaultHome);
    }
  });
});
