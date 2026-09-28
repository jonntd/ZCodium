import type { IPromptAssistService } from "./promptAssist.js";
import type { PromptEnhanceGenerator } from "./promptEnhanceGenerator.js";

export function createPromptAssistService(options?: {
  promptEnhanceGenerator?: PromptEnhanceGenerator;
}): IPromptAssistService {
  return {
    async enhancePromptDraft(params) {
      if (!options?.promptEnhanceGenerator) {
        throw new Error("Prompt enhancement is not available.");
      }
      return await options.promptEnhanceGenerator.generate(params);
    },
  };
}
