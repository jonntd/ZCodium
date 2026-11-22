import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Node, Project } from "ts-morph";
import { describe, expect, it } from "vitest";

interface Finding {
  file: string;
  line: number;
  message: string;
}

// 扫描面与路径展示都不依赖 process.cwd()：全量套件从仓库根跑、`pnpm --filter @zcode/ui`
// 单包跑时 cwd 不同——cwd 相对 glob 会让单包运行扫不到文件、守卫整体假绿（2026-11-22
// 实测）。改从本测试文件位置锚定：../../ = packages/ui，../../../ = 仓库根。
const UI_PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function createProject() {
  const project = new Project({
    compilerOptions: {
      allowJs: true,
      jsx: 4,
    },
  });
  project.addSourceFilesAtPaths([`${UI_PACKAGE_ROOT}src/**/*.tsx`]);
  return project;
}

function formatFinding(finding: Finding) {
  return `${finding.file}:${finding.line} ${finding.message}`;
}

function sourceLocation(sourceFile: ReturnType<Project["getSourceFiles"]>[number], node: Node) {
  const { line } = sourceFile.getLineAndColumnAtPos(node.getStart());
  return {
    file: relative(REPO_ROOT, sourceFile.getFilePath()).split("\\").join("/"),
    line,
  };
}

function getJsxTagRoot(tagName: string) {
  return tagName.split(".")[0] ?? tagName;
}

function getUnstableExpressionKind(expression: Node | undefined) {
  if (!expression) {
    return null;
  }
  if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
    return "function";
  }
  if (Node.isArrayLiteralExpression(expression)) {
    return "array";
  }
  if (Node.isObjectLiteralExpression(expression)) {
    return "object";
  }
  if (
    Node.isJsxElement(expression) ||
    Node.isJsxFragment(expression) ||
    Node.isJsxSelfClosingElement(expression)
  ) {
    return "jsx";
  }
  return null;
}

function collectMemoComponentNames(project: Project) {
  const memoComponentNames = new Set<string>();

  for (const sourceFile of project.getSourceFiles()) {
    sourceFile.forEachDescendant((node) => {
      if (!Node.isVariableDeclaration(node)) {
        return;
      }

      const initializer = node.getInitializer();
      if (
        !initializer ||
        !Node.isCallExpression(initializer) ||
        !["memo", "React.memo"].includes(initializer.getExpression().getText())
      ) {
        return;
      }

      const exportedName = node.getNameNode().getText();
      memoComponentNames.add(exportedName);

      const memoTarget = initializer.getArguments()[0];
      if (memoTarget && Node.isIdentifier(memoTarget)) {
        memoComponentNames.add(memoTarget.getText());
      }
    });
  }

  return memoComponentNames;
}

function collectInlinePropsForMemoComponents(project: Project) {
  const memoComponentNames = collectMemoComponentNames(project);
  const findings: Finding[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    sourceFile.forEachDescendant((node) => {
      if (!Node.isJsxOpeningElement(node) && !Node.isJsxSelfClosingElement(node)) {
        return;
      }

      const tagName = node.getTagNameNode().getText();
      if (!memoComponentNames.has(getJsxTagRoot(tagName))) {
        return;
      }

      for (const attribute of node.getAttributes()) {
        if (!Node.isJsxAttribute(attribute)) {
          continue;
        }

        const initializer = attribute.getInitializer();
        if (!initializer || !Node.isJsxExpression(initializer)) {
          continue;
        }

        const unstableKind = getUnstableExpressionKind(initializer.getExpression());
        if (!unstableKind) {
          continue;
        }

        const { file, line } = sourceLocation(sourceFile, attribute);
        findings.push({
          file,
          line,
          message: `<${tagName}> prop "${attribute.getNameNode().getText()}" uses inline ${unstableKind}`,
        });
      }
    });
  }

  return findings;
}

function collectMemoComponentsWithInlineDefaults(project: Project) {
  const memoComponentNames = collectMemoComponentNames(project);
  const findings: Finding[] = [];

  const inspectFunction = (name: string, fn: Node) => {
    if (!memoComponentNames.has(name)) {
      return;
    }

    if (
      !Node.isFunctionDeclaration(fn) &&
      !Node.isFunctionExpression(fn) &&
      !Node.isArrowFunction(fn)
    ) {
      return;
    }

    const firstParameter = fn.getParameters()[0];
    const nameNode = firstParameter?.getNameNode();
    if (!nameNode || !Node.isObjectBindingPattern(nameNode)) {
      return;
    }

    for (const element of nameNode.getElements()) {
      const unstableKind = getUnstableExpressionKind(element.getInitializer());
      if (!unstableKind) {
        continue;
      }

      const sourceFile = fn.getSourceFile();
      const { file, line } = sourceLocation(sourceFile, element);
      findings.push({
        file,
        line,
        message: `${name} default prop "${element.getNameNode().getText()}" creates inline ${unstableKind}`,
      });
    }
  };

  for (const sourceFile of project.getSourceFiles()) {
    sourceFile.forEachDescendant((node) => {
      if (Node.isFunctionDeclaration(node)) {
        const name = node.getNameNode()?.getText();
        if (name) {
          inspectFunction(name, node);
        }
        return;
      }

      if (!Node.isVariableDeclaration(node)) {
        return;
      }

      const initializer = node.getInitializer();
      if (!initializer) {
        return;
      }

      const name = node.getNameNode().getText();
      if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
        inspectFunction(name, initializer);
        return;
      }

      if (
        Node.isCallExpression(initializer) &&
        ["memo", "React.memo"].includes(initializer.getExpression().getText())
      ) {
        const memoTarget = initializer.getArguments()[0];
        if (
          memoTarget &&
          (Node.isArrowFunction(memoTarget) || Node.isFunctionExpression(memoTarget))
        ) {
          inspectFunction(name, memoTarget);
        }
      }
    });
  }

  return findings;
}

function collectInlineProviderValues(project: Project) {
  const findings: Finding[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    sourceFile.forEachDescendant((node) => {
      if (!Node.isJsxOpeningElement(node) && !Node.isJsxSelfClosingElement(node)) {
        return;
      }

      const tagName = node.getTagNameNode().getText();
      if (!tagName.endsWith(".Provider")) {
        return;
      }

      for (const attribute of node.getAttributes()) {
        if (!Node.isJsxAttribute(attribute) || attribute.getNameNode().getText() !== "value") {
          continue;
        }

        const initializer = attribute.getInitializer();
        const expression =
          initializer && Node.isJsxExpression(initializer)
            ? initializer.getExpression()
            : undefined;
        if (!expression || !Node.isObjectLiteralExpression(expression)) {
          continue;
        }

        const { file, line } = sourceLocation(sourceFile, attribute);
        findings.push({
          file,
          line,
          message: `<${tagName}> value uses inline object`,
        });
      }
    });
  }

  return findings;
}

describe("React stable reference boundaries", () => {
  it("does not pass inline non-primitive props into memoized components", () => {
    const findings = collectInlinePropsForMemoComponents(createProject());

    expect(findings.map(formatFinding)).toEqual([]);
  });

  it("does not create non-primitive defaults inside memoized component props", () => {
    const findings = collectMemoComponentsWithInlineDefaults(createProject());

    expect(findings.map(formatFinding)).toEqual([]);
  });

  it("does not create inline object context provider values", () => {
    const findings = collectInlineProviderValues(createProject());

    expect(findings.map(formatFinding)).toEqual([]);
  });
});
