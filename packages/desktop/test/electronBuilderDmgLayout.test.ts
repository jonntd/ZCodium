import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import desktopBuilderConfig from "../electron-builder.config.js";

// macOS DMG 布局契约：背景图上的说明文字、应用图标、Applications 链接和两个
// 解除拦截说明文件必须保持固定相对位置。2026-10 的上游同步（de5923d1）曾整体
// 覆盖 dmg.contents，把图标坐标退回 electron-builder 默认值并删掉说明文件，
// 导致 1.17.0 的 DMG 文字被图标遮挡、说明文件缺失，因此这里用测试锁定布局。
const desktopPackageRoot = fileURLToPath(new URL("..", import.meta.url));

interface DmgContent {
  x?: number;
  y?: number;
  type?: string;
  path?: string;
}

interface PngSize {
  width: number;
  height: number;
}

const dmg = desktopBuilderConfig.dmg as
  | {
      background?: string;
      contents?: DmgContent[];
    }
  | undefined;

const backgroundPath = join(desktopPackageRoot, dmg?.background ?? "");
const retinaBackgroundPath = backgroundPath.replace(/\.png$/i, "@2x.png");
const contents = dmg?.contents ?? [];
const visibleContents = contents.filter((item) => !item.path?.startsWith("."));
const appEntry = visibleContents.find((item) => item.type == null);
const applicationsEntry = visibleContents.find((item) => item.type === "link");
const guideEntries = visibleContents.filter((item) => item.type === "file");

function readPngSize(filePath: string): PngSize {
  const png = readFileSync(filePath);
  // PNG 签名 8 字节 + IHDR 长度/类型 8 字节后是宽高（大端 uint32）。
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe("macOS DMG 安装布局", () => {
  it("背景图事实源为 620x560，@2x 为 2 倍尺寸", () => {
    expect(dmg?.background).toBe("build/dmg_background.png");
    expect(existsSync(backgroundPath)).toBe(true);
    expect(existsSync(retinaBackgroundPath)).toBe(true);

    expect(readPngSize(backgroundPath)).toEqual({ width: 620, height: 560 });
    expect(readPngSize(retinaBackgroundPath)).toEqual({ width: 1240, height: 1120 });
  });

  it("应用图标与 Applications 链接位于说明文字上方，不回退到默认坐标", () => {
    // 背景从 y≈190 起绘制安装说明文字；图标中心必须在上方，否则会盖住文字。
    expect(appEntry).toMatchObject({ x: 150, y: 120 });
    expect(applicationsEntry).toMatchObject({ x: 470, y: 120, type: "link" });
    expect(applicationsEntry?.path).toBe("/Applications");

    // electron-builder 的默认布局正好落在背景文字上，显式禁止再次出现。
    expect(contents.some((item) => item.x === 130 && item.y === 220)).toBe(false);
    expect(contents.some((item) => item.x === 410 && item.y === 220)).toBe(false);
  });

  it("两个解除拦截说明文件随 DMG 分发，并落在背景箭头指向的位置", () => {
    const guides = guideEntries.map((item) => ({
      name: basename(item.path ?? ""),
      x: item.x,
      y: item.y,
      exists: Boolean(item.path && existsSync(item.path)),
    }));

    expect(guides).toEqual([
      { name: "解除拦截.txt", x: 170, y: 370, exists: true },
      { name: "Unblock.txt", x: 450, y: 370, exists: true },
    ]);
  });

  it("所有可见图标都在背景图下沿以内，打开 DMG 无需滚动", () => {
    const { height } = readPngSize(backgroundPath);
    for (const item of visibleContents) {
      expect(item.y).toBeDefined();
      expect(item.y ?? Number.POSITIVE_INFINITY).toBeLessThan(height - 80);
    }
  });

  it("说明文件包含绝对路径的解除命令", () => {
    for (const item of guideEntries) {
      const text = readFileSync(item.path ?? "", "utf8");
      expect(text).toContain("sudo /usr/bin/xattr -rd com.apple.quarantine");
      expect(text).toContain("/Applications/ZCodium.app");
    }
  });
});
