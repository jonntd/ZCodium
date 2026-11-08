/**
 * 内置 CLI bundle（cli-bundle/zcode.cjs）接线测试：
 * - CliLocator 三级探测优先级（cliPath 设置 → PATH → 内置 bundle）与 nodeScript 标记；
 * - resolveZcodeAgentSpawnCommand 的 nodeScript 分支（宿主 Node + ELECTRON_RUN_AS_NODE，
 *   桌面端 bundled resolver 同款形态）与既有可执行形态回归。
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliLocator } from "../src/cli/cliLocator";
import {
  ZCODE_AGENT_SERVER_BASE_ARGS,
  resolveZcodeAgentSpawnCommand,
} from "../src/host/hostSettingsBridge";

const tempDirs: string[] = [];

function tempCliFile(name: string, body = "// fake cli entry"): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-cli-bundle-"));
  tempDirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

afterEach(() => {
  tempDirs.length = 0;
});

describe("CliLocator：内置 bundle 三级兜底", () => {
  it("PATH 与 cliPath 均未命中时回退内置 bundle，nodeScript=true", async () => {
    const bundled = tempCliFile("zcode.cjs");
    const locator = new CliLocator("", bundled);
    const info = await locator.locate();
    expect(info?.path).toBe(bundled);
    expect(info?.nodeScript).toBe(true);
  });

  it("cliPath 设置命中时优先于内置 bundle（nodeScript 缺省）", async () => {
    const bundled = tempCliFile("zcode.cjs");
    const explicit = tempCliFile("zcodium-explicit");
    const locator = new CliLocator("", bundled);
    const info = await locator.locate(explicit);
    expect(info?.path).toBe(explicit);
    expect(info?.nodeScript).toBeUndefined();
  });

  it("PATH 命中时优先于内置 bundle", async () => {
    const bundled = tempCliFile("zcode.cjs");
    const onPath = tempCliFile("zcodium");
    const pathDir = onPath.slice(0, onPath.lastIndexOf("/"));
    const locator = new CliLocator(pathDir, bundled);
    const info = await locator.locate();
    expect(info?.path).toBe(onPath);
    expect(info?.nodeScript).toBeUndefined();
  });

  it("内置 bundle 文件缺失 → locate 返回 null（维持 CLI 未找到引导链路）", async () => {
    const locator = new CliLocator("", join(tmpdir(), "zcode-cli-bundle-missing", "zcode.cjs"));
    await expect(locator.locate()).resolves.toBeNull();
  });
});

describe("resolveZcodeAgentSpawnCommand：nodeScript 分支", () => {
  // 回归锁定（2026-11-07 真机事故）：spawn argv 只允许协议服务参数；
  // --allowed-tools/--disallowed-tools 是 TUI 旗标，app-server 入口不识别，
  // 注入会导致「打印 CLI help → exit 1」的每秒 spawn 崩溃风暴。
  const FORBIDDEN_FLAGS = ["--allowed-tools", "--disallowed-tools"];

  it("nodeScript=true：经宿主 Node 运行 bundle，ELECTRON_RUN_AS_NODE=1", () => {
    const spawn = resolveZcodeAgentSpawnCommand("/ext/cli-bundle/zcode.cjs", {
      nodeScript: true,
    });
    expect(spawn.command).toBe(process.execPath);
    expect(spawn.args).toEqual(["/ext/cli-bundle/zcode.cjs", ...ZCODE_AGENT_SERVER_BASE_ARGS]);
    expect(spawn.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("nodeScript 缺省：保持独立可执行形态（回归锁定）", () => {
    const spawn = resolveZcodeAgentSpawnCommand("/usr/local/bin/zcodium");
    expect(spawn.command).toBe("/usr/local/bin/zcodium");
    expect(spawn.args).toEqual([...ZCODE_AGENT_SERVER_BASE_ARGS]);
    expect(spawn.env).toBeUndefined();
  });

  it("回归锁：spawn argv 永不包含 TUI 专属的工具面旗标", () => {
    for (const options of [undefined, { nodeScript: true as const }]) {
      const spawn = resolveZcodeAgentSpawnCommand("/ext/cli-bundle/zcode.cjs", options);
      for (const flag of FORBIDDEN_FLAGS) {
        expect(spawn.args).not.toContain(flag);
      }
    }
  });
});
