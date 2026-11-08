/**
 * 临时工作区判定（纯函数，无 vscode 依赖，便于 headless 单测）。
 *
 * 起因（用户反馈 2026-11-08：任务列表「无限创建」ws (43)…(47)）：真机冒烟脚本用
 * `mktemp -d` 起隔离 IDE（/tmp/zc-ext-host-smoke.XXXX/ws），扩展把临时目录当普通
 * 工程永久写进真实数据根（~/.zcodium），每跑一次测试就多一个「ws (N)」空工程。
 * 临时目录天然不是用户长期工程，一律不登记（数据根隔离见 container 的
 * ZCODE_DATA_ROOT，这里是第二道闸：任何临时路径都进不了工程表）。
 */
import { tmpdir } from "node:os";
import { normalize, resolve } from "node:path";

/** macOS 上 /tmp 是 /private/tmp 的软链，两侧都要覆盖。 */
const TRANSIENT_ROOTS = [
  "/tmp",
  "/private/tmp",
  "/var/folders",
  "/private/var/folders",
];

export function isTransientWorkspacePath(folder: string): boolean {
  const target = resolve(normalize(folder));
  const roots = [...TRANSIENT_ROOTS, resolve(tmpdir())];
  return roots.some((root) => target === root || target.startsWith(`${root}/`));
}
