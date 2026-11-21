import { describe, expect, it } from "vitest";
import {
  isPathInsideWorkspace,
  normalizeFsPath,
} from "../src/host/pathContainment";

describe("normalizeFsPath", () => {
  it("POSIX：折叠重复分隔符、. / .. 段、尾分隔符", () => {
    expect(normalizeFsPath("/a/b/c")).toBe("/a/b/c");
    expect(normalizeFsPath("/a//b///c/")).toBe("/a/b/c");
    expect(normalizeFsPath("/a/./b/../c")).toBe("/a/c");
    expect(normalizeFsPath("/..")).toBe("/");
    expect(normalizeFsPath("/a/../../b")).toBe("/b");
  });

  it("Windows：盘符小写归一、反斜杠统一、跨盘 .. 不越界（路径大小写保留，比较时统一）", () => {
    expect(normalizeFsPath("C:\\Users\\a\\..\\b")).toBe("c:/Users/b");
    expect(normalizeFsPath("c:/x/./y/")).toBe("c:/x/y");
    expect(normalizeFsPath("C:\\..")).toBe("c:/");
  });

  it("UNC 路径按段归一（近似 POSIX 语义，含前缀判定可用）", () => {
    expect(normalizeFsPath("\\\\server\\share\\a")).toBe("/server/share/a");
  });
});

describe("isPathInsideWorkspace（安全审查 S1：文件读面 fail-closed 收敛）", () => {
  const folders = ["/home/u/proj", "/home/u/other"];

  it("workspace 内路径（含 folder 本体、子目录、深路径）放行", () => {
    expect(isPathInsideWorkspace("/home/u/proj", folders)).toBe(true);
    expect(isPathInsideWorkspace("/home/u/proj/a.md", folders)).toBe(true);
    expect(isPathInsideWorkspace("/home/u/proj/src/deep/b.ts", folders)).toBe(true);
    expect(isPathInsideWorkspace("/home/u/other/x", folders)).toBe(true);
  });

  it("前缀相似但非包含：逐段判定不误放行", () => {
    expect(isPathInsideWorkspace("/home/u/proj-other/a.md", folders)).toBe(false);
    expect(isPathInsideWorkspace("/home/u/project/a.md", folders)).toBe(false);
  });

  it("workspace 外 / 穿越到外 / 空路径拒绝", () => {
    expect(isPathInsideWorkspace("/etc/passwd", folders)).toBe(false);
    expect(isPathInsideWorkspace("/home/u/proj/../../etc/passwd", folders)).toBe(false);
    expect(isPathInsideWorkspace("", folders)).toBe(false);
  });

  it("无 workspace（空 folders）fail-closed 一律拒绝", () => {
    expect(isPathInsideWorkspace("/home/u/proj/a.md", [])).toBe(false);
  });

  it("Windows：盘符大小写不敏感、包含判定跨分隔符成立", () => {
    const winFolders = ["C:\\Users\\u\\proj"];
    expect(isPathInsideWorkspace("c:/users/u/proj/a.md", winFolders)).toBe(true);
    expect(isPathInsideWorkspace("C:\\USERS\\u\\proj2\\a.md", winFolders)).toBe(false);
  });

  // 回归（安全修复）：`\` 只有 Windows 形路径才作分隔符。此前 POSIX 路径也按 [\\/]+ 折叠，
  // 文件名含 `\` 时 `/a/b\x`（在 /a 下）被误判进 `/a/b`（fail-open 越界放行）。
  it("POSIX 文件名含反斜杠：不当分隔符，包含判定不失真", () => {
    expect(isPathInsideWorkspace("/home/u/proj/b\\x", folders)).toBe(true);
    expect(isPathInsideWorkspace("/home/u/proj-other\\x", folders)).toBe(false);
    const projFolders = ["/a/b"];
    expect(isPathInsideWorkspace("/a/b\\x", projFolders)).toBe(false);
    expect(isPathInsideWorkspace("/a/b\\c/d", projFolders)).toBe(false);
    expect(isPathInsideWorkspace("/a/b/c", projFolders)).toBe(true);
  });

  // 回归：UNC 路径大小写不敏感（底层文件系统大小写不敏感），此前只归一盘符路径。
  it("UNC：大小写不敏感、逐段前缀判定", () => {
    const uncFolders = ["\\\\server\\share"];
    expect(isPathInsideWorkspace("\\\\SERVER\\share\\f", uncFolders)).toBe(true);
    expect(isPathInsideWorkspace("\\\\server\\share2\\f", uncFolders)).toBe(false);
    expect(isPathInsideWorkspace("\\\\server\\other\\f", uncFolders)).toBe(false);
  });

  // 回归：folder 为根（POSIX `/` / 盘符根 `c:/`）时 `${folderKey}/` 拼出 `//`/`c://` 永不匹配，
  // 除根本体外全部合法子路径被误拒（fail-closed 误伤所有读面）。
  it("workspace folder 为根：子路径放行，根外路径仍拒绝", () => {
    expect(isPathInsideWorkspace("/foo", ["/"])).toBe(true);
    expect(isPathInsideWorkspace("/foo/bar", ["/"])).toBe(true);
    expect(isPathInsideWorkspace("C:/foo", ["C:/"])).toBe(true);
  });
});
