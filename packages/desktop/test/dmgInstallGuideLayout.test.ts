import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 直接评估 electron-builder 配置本体，保证断言的是打包真实消费的值，
// 而不是又一份会被再基线覆盖的副本。v3.15.1 的 dmg.contents 被上游简化版
// 覆盖（图标压字、说明文件丢失、隐藏资源被钉到窗口外）后没有任何测试报警。
interface DmgContentsEntry {
  x: number;
  y: number;
  type?: string;
  path?: string;
}

const builderConfig = (await import("../electron-builder.config.js")).default as {
  dmg: {
    background: string;
    icon: string;
    contents: DmgContentsEntry[];
  };
};

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));

function pngSize(buffer: Buffer) {
  // PNG 固定 8 字节签名 + 4 字节长度 + "IHDR"，宽高位于 16/20 偏移。
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe("dmg install guide layout", () => {
  it("背景与安装盘图标指向 spec 的事实源", () => {
    expect(builderConfig.dmg.background).toBe("build/dmg_background.png");
    expect(builderConfig.dmg.icon).toBe("build/icon_installer.icns");
  });

  it("contents 布局与 specs/macos-dmg-installation.md 的坐标契约一致", () => {
    const { contents } = builderConfig.dmg;

    // 图标视图可见区只有窗口顶部：app 图标与 Applications 链接必须在 y=120，
    // 下移会压住背景中部的解除拦截说明文字（v3.15.1 回归）。
    expect(contents).toContainEqual({ x: 150, y: 120 });
    expect(contents).toContainEqual({ x: 470, y: 120, type: "link", path: "/Applications" });

    // 背景的两个箭头指向中英双语说明文件的落点（y=370），两个名字都必须在。
    const guideEntries = contents.filter(
      (entry) => typeof entry.path === "string" && entry.path.includes("/build/dmg/"),
    );
    expect(guideEntries).toHaveLength(2);
    const zhEntry = guideEntries.find((entry) => entry.path?.endsWith("解除拦截.txt"));
    const enEntry = guideEntries.find((entry) => entry.path?.endsWith("Unblock.txt"));
    expect(zhEntry?.x).toBe(170);
    expect(zhEntry?.y).toBe(370);
    expect(zhEntry?.type).toBe("file");
    expect(zhEntry?.path && isAbsolute(zhEntry.path)).toBe(true);
    expect(enEntry?.x).toBe(450);
    expect(enEntry?.y).toBe(370);
    expect(enEntry?.type).toBe("file");
    expect(enEntry?.path && isAbsolute(enEntry.path)).toBe(true);

    // .background.tiff / .VolumeIcon.icns 由 dmg-builder 依据 background/icon 自动生成并隐藏；
    // 写进 contents 会把隐藏文件钉进窗口（v3.15.1 曾钉到右缘外导致挂载后露出半截图标）。
    const dotfileEntries = contents.filter((entry) => entry.path?.startsWith("."));
    expect(dotfileEntries).toEqual([]);
  });

  it("背景图尺寸与窗口契约一致（窗口尺寸由 1x 背景决定）", async () => {
    const oneX = pngSize(await readFile(resolve(desktopRoot, "build/dmg_background.png")));
    expect(oneX).toEqual({ width: 620, height: 560 });
    const twoX = pngSize(await readFile(resolve(desktopRoot, "build/dmg_background@2x.png")));
    expect(twoX).toEqual({ width: 1240, height: 1120 });
  });

  it("两个说明文件存在且包含可整行复制的解除命令", async () => {
    for (const name of ["解除拦截.txt", "Unblock.txt"]) {
      const text = await readFile(resolve(desktopRoot, "build/dmg", name), "utf8");
      // 必须使用 /usr/bin/xattr 绝对路径：用户 PATH 中的同名工具会报 option -r not recognized。
      expect(text).toContain(
        'sudo /usr/bin/xattr -rd com.apple.quarantine "/Applications/ZCodium.app" && open -a "ZCodium"',
      );
    }
  });
});
