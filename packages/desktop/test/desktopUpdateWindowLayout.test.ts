import { readFile } from "node:fs/promises";
import ts from "typescript";
import { expect, it } from "vitest";
import type { UpdateStatePayload } from "@zcode/shared";

it("手动安装提示使用更高的独立窗口，不沿用 205px 裁剪操作按钮", async () => {
  const text = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("index.ts", text, ts.ScriptTarget.Latest, true);
  const constants: string[] = [];
  let body = "";
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      /^UPDATE_STATUS_WINDOW_.*HEIGHT$/.test(node.name.getText(source))
    ) {
      constants.push(`const ${node.getText(source)};`);
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === "resolveUpdateStatusWindowHeight") {
      body = node.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(body).not.toBe("");
  const executable = ts.transpileModule(
    `${constants.join("\n")}\n${body}\nreturn resolveUpdateStatusWindowHeight;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const height = new Function(executable)() as (state: UpdateStatePayload) => number;
  expect(
    height({ kind: "update-available", enabled: true, version: "2.0.0", manualInstall: true }),
  ).toBe(320);
  expect(height({ kind: "update-available", enabled: true, version: "2.0.0" })).toBe(205);
  expect(height({ kind: "download-progress", enabled: false, progress: "50%" })).toBe(224);
  expect(height({ kind: "update-downloaded", enabled: true, version: "2.0.0" })).toBe(170);
});
