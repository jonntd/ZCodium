/**
 * 系统提示词分段编辑器的纯决策逻辑（docs/spec/custom-system-prompt.md v2）。
 *
 * 从 SystemPromptSection 里抽出，便于单测钉住几条容易写反的规则：
 * - 草稿 → 落盘值的序列化（继承不落盘；空白文本的覆盖/追加等同「什么都没写」）；
 * - dirty 判定（两侧都先走同一条 canonicalize，避免 trim/键序差异造成假 dirty）；
 * - v1 整段字段 → main.identity 覆盖的一次性迁移。
 */

import {
  SYSTEM_PROMPT_SEGMENT_IDS,
  SYSTEM_PROMPT_SEGMENT_TEXT_MAX_LENGTH,
  SYSTEM_PROMPT_SURFACE_IDS,
  countCustomizedSystemSegments,
  normalizeCustomSystemSegments,
  type CustomSystemSegments,
  type SystemPromptSegmentId,
  type SystemPromptSegmentMode,
  type SystemPromptSurfaceId,
} from "@zcode/shared";

/** 与 shared 的单段上限同一常量（提交前拦截，避免整份设置被 schema 拒绝）。 */
export const MAX_SYSTEM_PROMPT_SEGMENT_LENGTH = SYSTEM_PROMPT_SEGMENT_TEXT_MAX_LENGTH;

/** 编辑态模式比落盘多一个 `inherit`（继承 = 条目缺席，不落盘）。 */
export type SystemPromptDraftMode = SystemPromptSegmentMode | "inherit";

export interface SystemPromptSegmentDraft {
  mode: SystemPromptDraftMode;
  text: string;
}

export type SystemPromptSurfaceDraft = Record<SystemPromptSegmentId, SystemPromptSegmentDraft>;
export type SystemPromptDraft = Record<SystemPromptSurfaceId, SystemPromptSurfaceDraft>;

function createInheritSurfaceDraft(): SystemPromptSurfaceDraft {
  return {
    cliPrefix: { mode: "inherit", text: "" },
    identity: { mode: "inherit", text: "" },
    desktop: { mode: "inherit", text: "" },
  };
}

/** 全继承草稿（默认状态）。 */
export function createEmptySystemPromptDraft(): SystemPromptDraft {
  return {
    main: createInheritSurfaceDraft(),
    workflowSubagent: createInheritSurfaceDraft(),
  };
}

/** 已保存值 → 编辑草稿：缺席的条目在草稿里显式化为 `inherit`。 */
export function createSystemPromptDraftFromSaved(
  segments: CustomSystemSegments | undefined,
): SystemPromptDraft {
  const draft = createEmptySystemPromptDraft();
  if (!segments) return draft;
  for (const surface of SYSTEM_PROMPT_SURFACE_IDS) {
    const map = segments[surface];
    if (!map) continue;
    for (const segmentId of SYSTEM_PROMPT_SEGMENT_IDS) {
      const entry = map[segmentId];
      if (!entry) continue;
      draft[surface][segmentId] = { mode: entry.mode, text: entry.text };
    }
  }
  return draft;
}

/**
 * 落盘值的规范形：归一化（剥离空文本 override/append、clear 去 text），键序固定为
 * `SYSTEM_PROMPT_SURFACE_IDS` / `SYSTEM_PROMPT_SEGMENT_IDS` 的顺序。规范化后的对象可以
 * 直接用 JSON 串比较（dirty 判定）。
 *
 * **不做 trim**：内置「Agent 身份」原文以空行开头（core 的既有拼装行为），trim 会让
 * 「以内置原文为起点」预填的值与内置原文不再逐字一致。空白只按 shared 的归一化规则
 * 处理（纯空白文本的 override/append 视为「什么都没写」）。
 */
export function canonicalizeSystemPromptSegments(
  segments: CustomSystemSegments | undefined,
): CustomSystemSegments {
  const normalized = normalizeCustomSystemSegments(segments ?? {});
  const result: CustomSystemSegments = {};
  for (const surface of SYSTEM_PROMPT_SURFACE_IDS) {
    const map = normalized[surface];
    if (!map) continue;
    for (const segmentId of SYSTEM_PROMPT_SEGMENT_IDS) {
      const entry = map[segmentId];
      if (!entry) continue;
      result[surface] = {
        ...result[surface],
        [segmentId]: entry.mode === "clear" ? { mode: "clear", text: "" } : entry,
      };
    }
  }
  return result;
}

/** 草稿 → 落盘值（继承条目缺席；空白文本的覆盖/追加被剥离，不会被当成清空）。 */
export function serializeSystemPromptDraft(draft: SystemPromptDraft): CustomSystemSegments {
  const raw: CustomSystemSegments = {};
  for (const surface of SYSTEM_PROMPT_SURFACE_IDS) {
    for (const segmentId of SYSTEM_PROMPT_SEGMENT_IDS) {
      const entry = draft[surface][segmentId];
      if (entry.mode === "inherit") continue;
      raw[surface] = {
        ...raw[surface],
        [segmentId]: { mode: entry.mode, text: entry.text },
      };
    }
  }
  return canonicalizeSystemPromptSegments(raw);
}

/** 草稿与已保存值是否有未提交差异。 */
export function isSystemPromptDraftDirty(
  draft: SystemPromptDraft,
  saved: CustomSystemSegments | undefined,
): boolean {
  return (
    JSON.stringify(serializeSystemPromptDraft(draft)) !==
    JSON.stringify(canonicalizeSystemPromptSegments(saved))
  );
}

/** 草稿里是否存在超限的单段文本（提交前拦截）。 */
export function hasOverLimitSystemPromptSegment(draft: SystemPromptDraft): boolean {
  return SYSTEM_PROMPT_SURFACE_IDS.some((surface) =>
    SYSTEM_PROMPT_SEGMENT_IDS.some(
      (segmentId) => draft[surface][segmentId].text.length > MAX_SYSTEM_PROMPT_SEGMENT_LENGTH,
    ),
  );
}

/** 徽标计数：按**已保存值**统计非继承条目（草稿未提交前不改徽标）。 */
export function countSavedSystemPromptSegments(saved: CustomSystemSegments | undefined): number {
  return countCustomizedSystemSegments(canonicalizeSystemPromptSegments(saved));
}

/**
 * 成功提示语取决于落盘后的值：
 * - 全部继承 → 「已恢复默认」；
 * - 至少一段非继承 → 「已保存」。
 */
export function resolveSystemPromptSaveMessageId(segments: CustomSystemSegments): string {
  return countCustomizedSystemSegments(segments) === 0
    ? "settings.systemPromptRestored"
    : "settings.systemPromptSaved";
}

export interface LegacySystemPromptMigration {
  customSystemSegments: CustomSystemSegments;
  customSystemPrompt: "";
}

/**
 * v1 整段字段 → v2 分段的一次性迁移：旧值当作「Agent 身份」的覆盖值，并清空旧字段。
 *
 * 幂等：迁移后旧字段为空串，本函数恒返回 null。两字段同在（仅手工改 setting.json 能造出）
 * 时保留已有分段条目，只补上 main.identity——不静默丢掉用户已配置的段。
 */
export function resolveLegacySystemPromptMigration(
  legacyPrompt: string | undefined,
  savedSegments: CustomSystemSegments | undefined,
): LegacySystemPromptMigration | null {
  const legacy = typeof legacyPrompt === "string" ? legacyPrompt.trim() : "";
  if (legacy === "") return null;
  const migrated = canonicalizeSystemPromptSegments(savedSegments);
  return {
    customSystemSegments: {
      ...migrated,
      main: { ...migrated.main, identity: { mode: "override", text: legacy } },
    },
    customSystemPrompt: "",
  };
}

/** 「全部改为自定义」：两作用域全部段切「覆盖」并预填内置原文（等待显式保存）。 */
export function createAllOverrideSystemPromptDraft(
  builtinTexts: Record<SystemPromptSegmentId, string>,
): SystemPromptDraft {
  const draft = createEmptySystemPromptDraft();
  for (const surface of SYSTEM_PROMPT_SURFACE_IDS) {
    for (const segmentId of SYSTEM_PROMPT_SEGMENT_IDS) {
      draft[surface][segmentId] = { mode: "override", text: builtinTexts[segmentId] };
    }
  }
  return draft;
}
