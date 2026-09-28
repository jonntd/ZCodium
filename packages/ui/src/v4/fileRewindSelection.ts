// 按文件撤销（docs/spec/per-file-rewind.md）的纯选择规则：
// 弹窗勾选初始化只依赖预检结果与入口意图，便于在组件外测试。

/**
 * 计算撤销弹窗的初始勾选集合。
 * - 整轮入口（initialSelectedPath 缺省）：缺省全选 safe 文件，保持「一键整轮撤销」习惯。
 * - 单文件入口：只勾选该文件；若该文件预检后不在 safe 列表（如被外部修改），
 *   保持空选 —— 确认按钮禁用，由 unsafe 区说明原因，绝不静默扩大撤销范围。
 */
export function resolveInitialRewindSelection(
  safePaths: readonly string[],
  initialSelectedPath?: string | null,
): Set<string> {
  if (initialSelectedPath) {
    return new Set(safePaths.filter((path) => path === initialSelectedPath));
  }
  return new Set(safePaths);
}

/** 勾选集合 → 命令 paths 参数（保持勾选顺序无关、去重）。 */
export function toRewindCommandPaths(selected: ReadonlySet<string>): string[] {
  return [...selected];
}
