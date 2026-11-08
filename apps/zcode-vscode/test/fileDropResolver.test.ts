import { describe, expect, it, vi } from "vitest";
import {
  resolveFileDropUris,
  type FileDropResolverIo,
} from "../src/host/fileDropResolver";

function createIo(
  paths: Record<string, { isFile: boolean; sizeBytes: number } | null>,
  options: {
    uriToPath?: (uri: string) => string | null;
    statErrorPaths?: string[];
  } = {},
): FileDropResolverIo & { statCalls: string[] } {
  const statCalls: string[] = [];
  return {
    statCalls,
    uriToPath:
      options.uriToPath ?? ((uri) => uri.replace("file://", "") || null),
    statFile: vi.fn(async (path: string) => {
      statCalls.push(path);
      if (options.statErrorPaths?.includes(path)) {
        throw new Error(`EACCES ${path}`);
      }
      return paths[path] ?? null;
    }),
  };
}

describe("resolveFileDropUris（spec: composer-explorer-file-drop）", () => {
  it("收集存在的普通文件并回填 sizeBytes", async () => {
    const io = createIo({
      "/w/a.md": { isFile: true, sizeBytes: 100 },
      "/w/b.txt": { isFile: true, sizeBytes: 7 },
    });
    await expect(
      resolveFileDropUris(["file:///w/a.md", "file:///w/b.txt"], io),
    ).resolves.toEqual([
      { path: "/w/a.md", sizeBytes: 100 },
      { path: "/w/b.txt", sizeBytes: 7 },
    ]);
    expect(io.statCalls).toEqual(["/w/a.md", "/w/b.txt"]);
  });

  it("过滤目录（isFile=false）与缺失路径（stat null）", async () => {
    const io = createIo({
      "/w/dir": { isFile: false, sizeBytes: 0 },
    });
    await expect(
      resolveFileDropUris(["file:///w/dir/", "file:///w/missing.md"], io),
    ).resolves.toEqual([]);
  });

  it("过滤非 file URI（uriToPath → null，如 http 链接）", async () => {
    const io = createIo(
      { "/w/a.md": { isFile: true, sizeBytes: 1 } },
      {
        uriToPath: (uri) =>
          uri.startsWith("file://") ? uri.slice("file://".length) : null,
      },
    );
    await expect(
      resolveFileDropUris(["https://example.com/x", "file:///w/a.md"], io),
    ).resolves.toEqual([{ path: "/w/a.md", sizeBytes: 1 }]);
  });

  it("URI 去重，且不同 URI 形态映射同一路径时按路径去重", async () => {
    const io = createIo(
      { "/w/a.md": { isFile: true, sizeBytes: 1 } },
      {
        uriToPath: (uri) => {
          // file:///w/a.md 与 file://machine/w/a.md 都解析为 /w/a.md（模拟 Uri.fsPath 收敛）。
          if (uri === "file:///w/a.md" || uri === "file://machine/w/a.md")
            return "/w/a.md";
          return null;
        },
      },
    );
    await expect(
      resolveFileDropUris(
        ["file:///w/a.md", "file:///w/a.md", "file://machine/w/a.md"],
        io,
      ),
    ).resolves.toEqual([{ path: "/w/a.md", sizeBytes: 1 }]);
    expect(io.statCalls).toEqual(["/w/a.md"]);
  });

  it("单条 stat 抛错按缺失处理，不中断其余条目", async () => {
    const io = createIo(
      { "/w/a.md": { isFile: true, sizeBytes: 5 } },
      { statErrorPaths: ["/w/broken.md"] },
    );
    await expect(
      resolveFileDropUris(["file:///w/broken.md", "file:///w/a.md"], io),
    ).resolves.toEqual([{ path: "/w/a.md", sizeBytes: 5 }]);
  });

  it("空与非字符串条目被忽略", async () => {
    const io = createIo({ "/w/a.md": { isFile: true, sizeBytes: 1 } });
    const badInput = ["", "file:///w/a.md"] as unknown as readonly string[];
    await expect(resolveFileDropUris(badInput, io)).resolves.toEqual([
      { path: "/w/a.md", sizeBytes: 1 },
    ]);
    await expect(resolveFileDropUris([], io)).resolves.toEqual([]);
  });
});
