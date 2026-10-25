import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import forkRegistry from "./fork-customizations.json";

// fork 定制守护：登记表（scripts/fork-customizations.json）里的每个标记都必须在
// HEAD 处于期望状态。上游同步/再基线/重构冲掉定制时这里直接红——不再等打包后由
// 用户发现（v3.15.1 的 DMG 布局、审计文案就是这样丢的，见 docs/merge-main-impact-check.md）。
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function readMarkerFile(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("fork customization registry", () => {
  it("登记表结构完整：id/title/markers 齐备且 id 不重复", () => {
    const ids = new Set();
    for (const entry of forkRegistry.customizations) {
      expect(entry.id, `定制点缺少 id: ${JSON.stringify(entry)}`).toBeTruthy();
      expect(ids.has(entry.id), `定制点 id 重复: ${entry.id}`).toBe(false);
      ids.add(entry.id);
      expect(entry.title, `定制点 ${entry.id} 缺少 title`).toBeTruthy();
      expect(
        Array.isArray(entry.markers) && entry.markers.length > 0,
        `定制点 ${entry.id} 缺少 markers`,
      ).toBe(true);
      for (const marker of entry.markers) {
        expect(
          typeof marker.file === "string" && typeof marker.contains === "string",
          `定制点 ${entry.id} 的 marker 需要 file + contains`,
        ).toBe(true);
      }
    }
  });

  for (const entry of forkRegistry.customizations) {
    // pending 条目（如等 PR 合并的 fork-app-identity）先跳过，但保留在清单里可见。
    const run = entry.pending ? it.skip : it;
    run(`定制点存活: ${entry.id} — ${entry.title}`, () => {
      for (const marker of entry.markers) {
        const content = readMarkerFile(marker.file);
        const found = content.includes(marker.contains);
        if (marker.absent) {
          expect(
            found,
            `定制点 ${entry.id} 被冲掉：${marker.file} 不应再包含「${marker.contains}」` +
              `（上游实现回流）。对照 ${entry.spec ?? "登记表 spec"} 恢复 fork 定制。`,
          ).toBe(false);
        } else {
          expect(
            found,
            `定制点 ${entry.id} 丢失：${marker.file} 找不到「${marker.contains}」，` +
              `多半被上游同步/再基线覆盖。用 git log -S'${marker.contains}' 找 fork 历史版本，` +
              `对照 ${entry.spec ?? "登记表 spec"} 恢复。`,
          ).toBe(true);
        }
      }
    });
  }
});
