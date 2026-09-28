import type { PromptEnhanceDraftRequest, PromptEnhanceDraftResult } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IPromptAssistService {
  /**
   * 提示词增强（composer 草稿改写）。跟随会话当前模型走统一执行链路，
   * 模板组装、标记提取、回显检测与结果清洗全部由服务层负责，UI 只做草稿替换。
   */
  enhancePromptDraft(params: PromptEnhanceDraftRequest): Promise<PromptEnhanceDraftResult>;
}

export const IPromptAssistService = createServiceDescriptor<IPromptAssistService>(
  ServiceChannels.PromptAssist,
);
