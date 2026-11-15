import type { IZCodeSessionService } from "@zcode/services";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

interface DeferredDraftRuntimeChangeParams {
  logScope: string;
  reason: string;
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
  /** fork 增强：传入了就关闭预热草稿会话（legacy 路径）；V4 草稿 draftSessionId 为 null，自然跳过。 */
  zcodeSessionService?: Pick<IZCodeSessionService, "closeSession">;
}

export async function invalidateDeferredDraftSessionForRuntimeChange(
  params: DeferredDraftRuntimeChangeParams,
): Promise<void> {
  if (!params.workspacePath) {
    return;
  }

  const workspaceIdentity = params.workspaceIdentity?.trim() || undefined;
  const store = useZCodeSessionStore.getState();
  const draftSessionId = store.getWorkspaceState(
    params.workspacePath,
    workspaceIdentity,
  ).draftSessionId;
  // protocol-v4 的草稿 session 由 pane 本地预热，draftSessionId 会保持 null。
  // 无论 legacy session 是否存在，都要先发布 workspace 隔离的运行时失效版本。
  store.invalidateDraftRuntime(params.workspacePath, workspaceIdentity);
  if (!draftSessionId || !params.zcodeSessionService) {
    return;
  }

  try {
    await params.zcodeSessionService.closeSession({
      workspacePath: params.workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      sessionId: draftSessionId,
    });
    logger.info(
      `[${params.logScope}] invalidated deferred draft session after runtime change`,
      {
        draftSessionId,
        reason: params.reason,
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      },
    );
  } catch (error) {
    logger.warn(
      `[${params.logScope}] close deferred draft session after runtime change failed`,
      {
        draftSessionId,
        reason: params.reason,
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export async function invalidateDeferredDraftSessionForSkillChange(
  params: Omit<DeferredDraftRuntimeChangeParams, "logScope">,
): Promise<void> {
  await invalidateDeferredDraftSessionForRuntimeChange({
    ...params,
    logScope: "skills",
  });
}
