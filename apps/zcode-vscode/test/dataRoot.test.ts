/**
 * 数据根口径锁定（docs/architecture.md §7.9「数据根」）：
 *
 * 最终口径 = 共享 $HOME/.zcodium（不隔离到插件 globalStorage）。生产装配两侧都不设
 * 重定向：createPluginServices 不传 dataRootDir（不触发 setDataRootPathOverride）、
 * new ServerHost 不传 dataBaseDir（server env 不注入 ZCODE_DATA_BASE_DIR），server 与
 * 侧边栏服务栈同回落 services 默认数据根。
 *
 * 背景：container/serverHost/openFullUi/serviceAssembly 四处注释与契约曾描述
 * 「隔离到 <globalStorage>/.zcodium」，与实际解析（paths.ts 回落 $HOME/.zcodium）
 * 矛盾；M2 起隔离口径已退役（container.ts 服务装配历史注释），本测试把装配面、
 * env 注入面与 services 解析面一起锁死，防止口径漂移。
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
import { buildServerEnvOverrides } from "../src/fullui/serverEnv";

const containerSource = readFileSync(
  new URL("../src/container.ts", import.meta.url),
  "utf8",
);

afterEach(() => {
  // getZCodeDataRootDir/getDataBaseDir 是模块级进程状态：本文件不设置任何 override，
  // 这里仅防御性复位（幂等 no-op），避免意外残留影响同 worker 内后续断言。
  setDataRootPathOverride(null);
});

describe("container 装配面：数据根两侧均不重定向（docs/architecture.md §7.9）", () => {
  it("createPluginServices 调用不含 dataRootDir（services 栈回落默认根 $HOME/.zcodium）", () => {
    const call = containerSource.match(
      /const services = createPluginServices\(\{([\s\S]*?)\n  \}\);/,
    );
    expect(call).not.toBeNull();
    expect(call![1]).not.toMatch(/\bdataRootDir\b/);
  });

  it("new ServerHost 构造不含 dataBaseDir（server env 不注入 ZCODE_DATA_BASE_DIR）", () => {
    const call = containerSource.match(
      /const fullUiServer = new ServerHost\(\{([\s\S]*?)\n  \}\);/,
    );
    expect(call).not.toBeNull();
    expect(call![1]).not.toMatch(/\bdataBaseDir\b/);
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

describe("buildServerEnvOverrides：server 子进程 env 注入口径", () => {
  it("生产口径：不传 dataBaseDir → 不注入 ZCODE_DATA_BASE_DIR（与侧边栏同回落默认根）", () => {
    const env = buildServerEnvOverrides({
      port: 34567,
      staticRoot: "/repo/packages/web/dist",
    });
    expect(env["ZCODE_DATA_BASE_DIR"]).toBeUndefined();
    expect(env["PORT"]).toBe("34567");
    expect(env["ZCODE_WEB_STATIC_ROOT"]).toBe("/repo/packages/web/dist");
    expect(env["ELECTRON_RUN_AS_NODE"]).toBe("1");
    expect(env["HOST"]).toBe("127.0.0.1");
    expect(env["ZCODE_SERVER_HOST"]).toBe("127.0.0.1");
    expect(env["ZCODE_AGENT_SERVER_COMMAND"]).toBeUndefined();
    expect(env["ZCODE_AGENT_SERVER_ARGS_JSON"]).toBeUndefined();
  });

  it("dev/测试隔离出口：显式传 dataBaseDir → 等值注入 ZCODE_DATA_BASE_DIR", () => {
    const env = buildServerEnvOverrides({
      port: 1,
      staticRoot: "s",
      dataBaseDir: "/tmp/zcodium-isolated",
    });
    expect(env["ZCODE_DATA_BASE_DIR"]).toBe("/tmp/zcodium-isolated");
  });

  it("Agent 注入口径：agentCommand + agentArgs → COMMAND/ARGS_JSON（JSON 序列化）", () => {
    const env = buildServerEnvOverrides({
      port: 2,
      staticRoot: "s",
      agentCommand: "/usr/local/bin/node",
      agentArgs: ["/ext/cli-bundle/zcode.cjs", "app-server", "--stdio"],
    });
    expect(env["ZCODE_AGENT_SERVER_COMMAND"]).toBe("/usr/local/bin/node");
    // 缺失时 parse 一个非 JSON 文本立即抛错（不静默通过）。
    expect(
      JSON.parse(env["ZCODE_AGENT_SERVER_ARGS_JSON"] ?? "ARGS_JSON-missing"),
    ).toEqual(["/ext/cli-bundle/zcode.cjs", "app-server", "--stdio"]);
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
