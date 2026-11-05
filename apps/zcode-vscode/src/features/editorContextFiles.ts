import * as vscode from "vscode";
import type { PendingContext } from "./contextCollector";

const MAX_FILE_LINES = 400;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_DIRECTORY_ENTRIES = 200;

function fenced(languageId: string, content: string): string {
  return `\`\`\`${languageId}\n${content}\n\`\`\``;
}

/** 读一个文件作为上下文，超出上限就截断 —— 宁可少给，也不要把上下文一次打满。 */
export async function readFileContext(uri: vscode.Uri): Promise<PendingContext | undefined> {
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > MAX_FILE_BYTES) {
    const label = vscode.workspace.asRelativePath(uri);
    return {
      chip: { id: `file-${uri.toString()}`, label: `${label}（过大，仅路径）` },
      text: `<file path="${label}" note="文件过大，未附带内容" />`,
    };
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = new TextDecoder("utf-8").decode(bytes);
  const lines = text.split("\n");
  const clipped = lines.length > MAX_FILE_LINES ? lines.slice(0, MAX_FILE_LINES) : lines;
  const suffix = lines.length > MAX_FILE_LINES ? "\n…（文件过长，已截断）" : "";
  const label = vscode.workspace.asRelativePath(uri);
  const languageId = guessLanguageId(label);

  return {
    chip: { id: `file-${uri.toString()}`, label },
    text: `<file path="${label}">\n${fenced(languageId, clipped.join("\n") + suffix)}\n</file>`,
  };
}

/** 目录只给结构，不给内容：这是「让模型知道有什么」，不是索引。 */
export async function readDirectoryContext(
  uri: vscode.Uri,
): Promise<PendingContext | undefined> {
  const entries = await vscode.workspace.fs.readDirectory(uri);
  const label = vscode.workspace.asRelativePath(uri) || ".";
  const lines = entries
    .slice(0, MAX_DIRECTORY_ENTRIES)
    .map(([name, type]) => `${type === vscode.FileType.Directory ? "dir " : "file"} ${name}`)
    .sort();
  const suffix = entries.length > MAX_DIRECTORY_ENTRIES ? "\n…（条目过多，已截断）" : "";

  return {
    chip: { id: `dir-${uri.toString()}`, label: `${label}/` },
    text: `<directory path="${label}">\n${lines.join("\n")}${suffix}\n</directory>`,
  };
}

export async function contextFromUri(uri: vscode.Uri): Promise<PendingContext | undefined> {
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type === vscode.FileType.Directory) return readDirectoryContext(uri);
  return readFileContext(uri);
}

function guessLanguageId(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1);
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    py: "python",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    hpp: "cpp",
    sh: "bash",
    zsh: "bash",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    css: "css",
    html: "html",
    sql: "sql",
  };
  return map[extension] ?? "text";
}
