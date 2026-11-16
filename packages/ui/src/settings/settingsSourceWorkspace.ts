/**
 * 设置页投影 key：`authority\0(identity|path)`。
 *
 * Bug 原因：远端「用户」目标只有 home 路径与 authority、没有 workspace identity。
 * 裸路径/identity 比较时，两台设备 home 同串（如同为 /root）会把 A 设备的单例 store
 * 投影（插件、技能、命令分组）匹配到 B 设备的同路径目标。authority 必须参与 key，
 * 且格式与 pluginManagementStoreLoading.buildWorkspaceKey 保持同族（后者在无 authority
 * 时补 "workspace" 前缀；此处两侧比较对象同源拼接，无需前缀也能自洽）。
 */
export function buildSourceSettingsProjectionKey(
  workspacePath: string | null | undefined,
  workspaceIdentity?: string | null,
  authorityKey?: string | null,
): string {
  const targetKey = workspaceIdentity?.trim() || workspacePath || "";
  const authority = authorityKey?.trim();
  return authority ? `${authority}\0${targetKey}` : targetKey;
}
