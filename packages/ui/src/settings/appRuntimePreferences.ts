import type { AppSettings, CustomSystemSegments } from "@zcode/shared";

/**
 * App 设置 → CLI 运行时偏好快照（docs/spec/custom-system-prompt.md 的「settings → preferences
 * 映射点」）。
 *
 * 这个快照有**多处**生产点（设置页保存后的热更与广播、Root 启动时的初始化同步），而 host 侧
 * 每次都会用它整体替换 `latestAppRuntimePreferences`，新注册的 CLI client 再重放这份快照。
 * 因此任何一处漏字段都会造成「改了设置、老会话生效、新会话不生效」——
 * 曾经 `customSystemPrompt` / `customSystemSegments` 就是这样在 Root 的初始化快照里缺席的。
 * 收敛成唯一构造点，杜绝再次漂移。
 */
export interface AppRuntimePreferenceSnapshot {
  askUserQuestionAutoResolutionEnabled: boolean;
  modelIoFullRetentionEnabled: boolean;
  deleteProtectionEnabled: boolean;
  batchDeleteApprovalThreshold: number;
  /** 空串 = 内置默认（"恢复默认"必须能显式穿越 RPC，undefined 会被丢弃）。 */
  customSystemPrompt: string;
  /** `{}` = 已全部恢复继承；缺席才是「从未使用」，UI 侧永远给出确定值。 */
  customSystemSegments: CustomSystemSegments;
  /** 回复语言（docs/spec/response-language.md）；空串 = 跟随用户消息。 */
  language: string;
}

export function buildAppRuntimePreferenceSnapshot(
  settings: AppSettings | null | undefined,
  patch?: Partial<AppSettings>,
): AppRuntimePreferenceSnapshot {
  return {
    askUserQuestionAutoResolutionEnabled:
      patch?.askUserQuestionAutoResolutionEnabled ??
      settings?.askUserQuestionAutoResolutionEnabled !== false,
    modelIoFullRetentionEnabled:
      patch?.modelIoFullRetentionEnabled ?? settings?.modelIoFullRetentionEnabled === true,
    deleteProtectionEnabled:
      patch?.deleteProtectionEnabled ?? settings?.deleteProtectionEnabled !== false,
    batchDeleteApprovalThreshold:
      patch?.batchDeleteApprovalThreshold ?? settings?.batchDeleteApprovalThreshold ?? 50,
    customSystemPrompt: patch?.customSystemPrompt ?? settings?.customSystemPrompt ?? "",
    customSystemSegments: patch?.customSystemSegments ?? settings?.customSystemSegments ?? {},
    language: patch?.language ?? settings?.language ?? "",
  };
}

/** patch 是否触及需要同步给 CLI 的偏好字段（其余设置项不必触发偏好同步）。 */
export function touchesAppRuntimePreferences(patch: Partial<AppSettings>): boolean {
  return (
    typeof patch.askUserQuestionAutoResolutionEnabled === "boolean" ||
    typeof patch.modelIoFullRetentionEnabled === "boolean" ||
    typeof patch.deleteProtectionEnabled === "boolean" ||
    typeof patch.batchDeleteApprovalThreshold === "number" ||
    typeof patch.customSystemPrompt === "string" ||
    patch.customSystemSegments !== undefined ||
    typeof patch.language === "string"
  );
}
