import { readFile } from "node:fs/promises";
import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/main/databaseStartupRelay.js", () => ({
  getDatabaseStartupPortPayload: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { setBadgeCount: vi.fn(), dock: undefined },
  BrowserWindow: { fromId: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
}));
vi.mock("../src/main/desktopWindowChrome.js", () => ({ createBrowserWindow: vi.fn() }));
vi.mock("../src/main/armsBrowserPerfLoadNudge.js", () => ({
  scheduleArmsBrowserPerfLoadNudge: vi.fn(),
}));

import { handleDesktopWindowCloseRequest } from "../src/main/desktopWindowLifecycle.js";

type Harness = {
  close: (win: { hide: () => void }, label: string) => boolean;
  capability: () => Promise<{ supported: boolean; gnomeLikeWithoutTray: boolean }>;
  initializeTray: () => void;
};

// 不 import 整个 Main（会启动 Electron）；抽取并执行实际 AST 中的创建/置位、关窗回调
// 和 IPC 回调，避免仅检查字符串却漏掉 Linux 半接线或错误的能力来源（#77 / #92）。
describe("desktop close-to-tray wiring", () => {
  let executable: string;
  beforeAll(async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    const file = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
    const nodes: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      nodes.push(node);
      ts.forEachChild(node, visit);
    };
    visit(file);
    const single = (matches: ts.Node[]) => {
      expect(matches).toHaveLength(1);
      return matches[0]!.getText(file);
    };
    const variable = (name: string) =>
      single(nodes.filter((n) => ts.isVariableDeclaration(n) && n.name.getText(file) === name));
    const property = (call: string, name: string) => {
      const calls = nodes.filter(
        (n): n is ts.CallExpression =>
          ts.isCallExpression(n) && n.expression.getText(file) === call,
      );
      expect(calls).toHaveLength(1);
      const options = calls[0]!.arguments[0]!;
      if (!ts.isObjectLiteralExpression(options)) throw new Error("Missing Main options object");
      const props = options.properties.filter(
        (n): n is ts.PropertyAssignment =>
          ts.isPropertyAssignment(n) && n.name.getText(file) === name,
      );
      expect(props).toHaveLength(1);
      return props[0]!.initializer.getText(file);
    };
    const capability = single(
      nodes.filter(
        (n) => ts.isFunctionDeclaration(n) && n.name?.text === "getCloseToTrayCapability",
      ),
    );
    const readyAssignment = single(
      nodes.filter(
        (n) =>
          ts.isExpressionStatement(n) &&
          ts.isBinaryExpression(n.expression) &&
          n.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          n.expression.left.getText(file) === "desktopTrayReady",
      ),
    );
    executable = ts.transpileModule(
      `let ${variable("desktopTrayReady")};
       ${capability}
       return {
         close: ${property("createWindow", "handleBeforeClose")},
         capability: ${property("registerPlatformIpcHandlers", "refreshCloseToTrayCapability")},
         initializeTray() { const ${variable("desktopTray")}; ${readyAssignment} }
       };`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
  });

  const setup = (platform: string, trayReady: boolean, setting = true, quit = "none") => {
    const hide = vi.fn();
    const appQuit = vi.fn();
    const confirm = vi.fn(() => true);
    const handleClose = vi.fn(handleDesktopWindowCloseRequest);
    const bindings = {
      process: { platform },
      createDesktopTray: vi.fn(() => (trayReady ? {} : null)),
      handleDesktopWindowCloseRequest: handleClose,
      closeToTrayOnWindows: setting,
      forceQuitRef: { current: quit === "force" },
      explicitQuitRef: { current: quit === "explicit" },
      getMainApplicationWindows: () => [{}],
      shouldConfirmAppQuit: () => true,
      confirmAppQuit: confirm,
      markForceQuit: vi.fn(),
      app: { quit: appQuit },
      logger: { info: vi.fn() },
      executeDesktopCommandForApp: vi.fn(),
    };
    const harness = new Function(...Object.keys(bindings), executable)(
      ...Object.values(bindings),
    ) as Harness;
    return { harness, hide, appQuit, confirm, handleClose };
  };

  it("ready 前 Windows 关窗与 IPC 都不可隐藏", async () => {
    const { harness, hide, handleClose } = setup("win32", true);
    expect((await harness.capability()).supported).toBe(false);
    harness.close({ hide }, "test");
    expect(handleClose.mock.calls[0]![0].closeToTraySupported).toBe(false);
    expect(hide).not.toHaveBeenCalled();
  });

  it.each([
    ["win32", true, true, "none", true],
    ["win32", false, true, "none", false],
    ["win32", true, false, "none", false],
    ["win32", true, true, "explicit", false],
    ["win32", true, true, "force", false],
    ["linux", true, true, "none", false],
    ["linux", false, true, "none", false],
    ["darwin", true, true, "none", false],
  ])("%s tray=%s setting=%s quit=%s hides=%s", async (platform, tray, setting, quit, hides) => {
    const { harness, hide, handleClose, confirm, appQuit } = setup(platform, tray, setting, quit);
    harness.initializeTray();
    const capability = await harness.capability();
    expect(capability).toEqual({
      supported: platform === "win32" && tray,
      gnomeLikeWithoutTray: false,
    });
    harness.close({ hide }, "test");
    const options = handleClose.mock.calls[0]![0];
    expect(options.closeToTray).toBe(setting);
    expect(options).not.toHaveProperty("closeToTrayOnWindows");
    expect(options.closeToTraySupported).toBe(capability.supported);
    expect(hide).toHaveBeenCalledTimes(hides ? 1 : 0);
    const shouldQuit = !hides && platform !== "darwin" && quit !== "force";
    expect(confirm).toHaveBeenCalledTimes(shouldQuit ? 1 : 0);
    expect(appQuit).toHaveBeenCalledTimes(shouldQuit ? 1 : 0);
  });
});
