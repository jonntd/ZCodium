/**
 * settings/workspacePreferences.ts — 自定义指令/回复语言/会话参数的纯模型（T12，P1-13/P1-16.1）。
 *
 * 写面（优先复用 services setting 频道既有方法——ISettingService.get/update patch：
 * AppSettings.customSystemPrompt / customSystemSegments / language /
 * deleteProtectionEnabled / batchDeleteApprovalThreshold，改动随下次会话 spawn 生效）：
 * - 指令/语言：setting 频道读改写（无既有写穿面时不得自行扩 shared——本模块只消费
 *   既有 AppSettings 字段，零协议新增）；
 * - 分段提示词（P1-13.1）：AppSettings.customSystemSegments 读写；经 services
 *   既有写穿（workspace/updateSystemSegments）生效，本模块零协议新增；
 * - 附加目录：plat updateAdditionalDirectories（host 归一化 ≤256）+
 *   plat getWorkspaceSettings 读面；
 * - 「从 CLAUDE.md/GODE.md 一次性导入」：plat importWorkspaceInstructions 读文件 →
 *   一次性拷贝进 customSystemPrompt（幂等标记防重复导入）。
 * 纯函数模块：vitest 直测（test/workspacePreferences.test.ts）。
 */

import { canonicalizeSystemPromptSegments } from "@/settings/systemPromptDraft.js";
import type { CustomSystemSegments } from "@zcode/shared";

/** 指令面板表单形状。 */
export interface InstructionsForm {
  /** 自定义系统提示词（空串 = 恢复内置默认；非空时优先于分段配置生效）。 */
  customSystemPrompt: string;
  /** 回复语言（空串 = 跟随用户消息）。 */
  language: string;
  /** 分段提示词（P1-13.1；undefined = 从未使用过分段）。 */
  customSystemSegments?: CustomSystemSegments;
}

/** setting 频道 AppSettings 的面板读取面（只取本面板字段；分段值经 canonicalize 校验）。 */
export function projectInstructionsForm(settings: unknown): InstructionsForm {
  const record = typeof settings === "object" && settings !== null ? (settings as Record<string, unknown>) : {};
  let segments: CustomSystemSegments | undefined;
  try {
    segments = canonicalizeSystemPromptSegments(
      record.customSystemSegments as CustomSystemSegments | undefined,
    );
  } catch {
    segments = undefined;
  }
  return {
    customSystemPrompt: typeof record.customSystemPrompt === "string" ? record.customSystemPrompt : "",
    language: typeof record.language === "string" ? record.language : "",
    ...(segments !== undefined && Object.keys(segments).length > 0 ? { customSystemSegments: segments } : {}),
  };
}

/** 表单 → settingService.update patch 形状（只携带本面板字段；空串即恢复默认语义）。 */
export interface InstructionsPatch {
  customSystemPrompt: string;
  language: string;
  /** 分段提示词（P1-13.1；经 services 既有写穿生效）。 */
  customSystemSegments?: CustomSystemSegments;
}

/** 表单 → settingService.update patch（只携带本面板字段）。 */
export function buildInstructionsPatch(form: InstructionsForm): InstructionsPatch {
  return {
    customSystemPrompt: form.customSystemPrompt,
    language: form.language.trim(),
    ...(form.customSystemSegments !== undefined
      ? { customSystemSegments: form.customSystemSegments }
      : {}),
  };
}

/** 一次性导入的文件条目（container.ts importWorkspaceInstructions 返回面）。 */
export interface InstructionImportFile {
  folder: string;
  name: string;
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
}

/** 导入节段标记（幂等键：同 path 重复导入时跳过，不重复拼接）。 */
export function instructionImportMarker(file: InstructionImportFile): string {
  return `<!-- zcodium:imported-instruction:${file.path} -->`;
}

export interface InstructionImportOutcome {
  /** 一次性拷贝后的提示词草稿（调用方确认后经 buildInstructionsPatch 写回）。 */
  promptDraft: string;
  imported: string[];
  skipped: string[];
  warnings: string[];
}

/**
 * 一次性导入映射（P1-13.2：语义为一次性拷贝，非持续同步）：
 * - 幂等：既有提示词里已有同 path 标记 → 跳过（重复点击不重复拼接）；
 * - 截断文件给出 warning（512KB 上限，host 侧截断）；
 * - GODE.md 优先序由 host（每 folder 首个命中）保证，这里按返回序拼接。
 */
export function mapInstructionImport(
  files: readonly InstructionImportFile[],
  currentPrompt: string,
): InstructionImportOutcome {
  const imported: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  const sections: string[] = [];
  for (const file of files) {
    const marker = instructionImportMarker(file);
    if (currentPrompt.includes(marker)) {
      skipped.push(file.path);
      continue;
    }
    if (file.truncated) {
      warnings.push(`${file.path} 超过单文件上限，已截断到 ${Math.round(file.sizeBytes / 1024)}KB`);
    }
    sections.push(`${marker}\n<!-- 来源：${file.folder}/${file.name}（一次性导入） -->\n${file.content.trim()}`);
    imported.push(file.path);
  }
  if (sections.length === 0) {
    return { promptDraft: currentPrompt, imported, skipped, warnings };
  }
  const base = currentPrompt.trimEnd();
  const promptDraft = base
    ? `${base}\n\n${sections.join("\n\n")}`
    : sections.join("\n\n");
  return { promptDraft, imported, skipped, warnings };
}

/** 会话参数表单形状（P1-16.1）。 */
export interface SessionParamsForm {
  additionalDirectories: string[];
  /** 删除保护（AppSettings.deleteProtectionEnabled；true = 移入废纸篓）。 */
  deleteProtectionEnabled: boolean;
  /** 批量删除审批阈值（AppSettings.batchDeleteApprovalThreshold）。 */
  batchDeleteApprovalThreshold: number;
}

/** AppSettings（setting 频道读）→ 会话参数表单。 */
export function projectSessionParamsForm(settings: unknown): SessionParamsForm {
  const record = typeof settings === "object" && settings !== null ? (settings as Record<string, unknown>) : {};
  return {
    additionalDirectories: [],
    deleteProtectionEnabled: record.deleteProtectionEnabled !== false,
    batchDeleteApprovalThreshold:
      typeof record.batchDeleteApprovalThreshold === "number" &&
      Number.isFinite(record.batchDeleteApprovalThreshold) &&
      record.batchDeleteApprovalThreshold > 0
        ? Math.trunc(record.batchDeleteApprovalThreshold)
        : 50,
  };
}

/** 文本区行 → 附加目录（去空白/去空/去重，≤256 与 host normalizeAdditionalDirectories 同口径）。 */
export function normalizeAdditionalDirectoriesInput(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen].slice(0, 256);
}

/** 删除保护 → settingService.update patch。 */
export function buildDeleteProtectionPatch(form: {
  deleteProtectionEnabled: boolean;
  batchDeleteApprovalThreshold: number;
}): { deleteProtectionEnabled: boolean; batchDeleteApprovalThreshold: number } {
  return {
    deleteProtectionEnabled: form.deleteProtectionEnabled,
    batchDeleteApprovalThreshold: Math.max(1, Math.trunc(form.batchDeleteApprovalThreshold) || 50),
  };
}

/** 附加目录写回应答（container.ts updateAdditionalDirectories 返回面）。 */
export interface AdditionalDirectoriesWriteBack {
  directories: string[];
  requiresSessionRebuild: boolean;
  message: string;
}
