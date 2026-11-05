/**
 * header/modelSelect.tsx — 模型/思考档位/协作模式切换 + 压缩上下文入口（T10，P1-11/P1-14）。
 *
 * - 当前值来自共享 projection 的 snapshot.config（provider/model/thought/mode），
 *   目录来自 model-selection 频道（IModelSelectionService.getView，桥白名单频道）；
 * - switchModelConfig{provider,model,thought} 与
 *   switchCollaborationMode{mode:build|edit|plan|yolo|guarded} 都是 CAS 命令，
 *   经 useSessionCommandDispatcher 自动携带 baseRevision（P1-11.1 即时生效，
 *   失败回滚以投影为准）；"auto" 非用户可切，不进命令面（协议注释口径）；
 * - 压缩上下文（P1-14）：compact{} 非 CAS，经 header/compactAction.ts 发送。
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { ModelSelectionView } from "@zcode/services";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useServices } from "@/hooks/useServices.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { buildCompactEnvelope, interpretCompactAck, isCompactAllowed } from "./compactAction";
import {
  SessionCommandScope,
  useSessionCommandDispatcher,
  useSessionSnapshot,
} from "./sessionCommandPort";

/** switchCollaborationMode 值域（command.ts:266-268；auto 非用户可切，不进命令面）。 */
export const COLLABORATION_MODES = ["build", "edit", "plan", "yolo", "guarded"] as const;

export interface ModelSelectPanelProps {
  workspacePath: string;
  sessionId: string | null;
}

export function ModelSelectPanel(props: ModelSelectPanelProps): ReactNode {
  return (
    <SessionCommandScope workspacePath={props.workspacePath}>
      <ModelSelectInner {...props} />
    </SessionCommandScope>
  );
}

function ModelSelectInner({ sessionId }: ModelSelectPanelProps) {
  const { modelSelectionService } = useServices();
  const selection = useModelSelectionServiceView(modelSelectionService);
  const catalog: ModelSelectionView | null =
    selection.state.status === "ready" ? selection.state.view : null;
  const snapshot = useSessionSnapshot(sessionId);
  const dispatch = useSessionCommandDispatcher(sessionId);
  const [error, setError] = useState<string | null>(null);

  const modelOptions = useMemo(() => buildModelOptions(catalog), [catalog]);
  const config = snapshot?.config ?? null;

  const handleModelChange = useCallback(
    async (value: string) => {
      const { provider, model } = splitModelPickerValue(value);
      if (!provider || !model) return;
      setError(null);
      const result = await dispatch("switchModelConfig", {
        provider,
        model,
        // thought 原样沿用当前档位（跨模型档位由 CLI 校验/回落）。
        thought: config?.thought ?? "",
      });
      if (!result.ok) setError(result.message);
    },
    [dispatch, config],
  );

  const handleThoughtChange = useCallback(
    async (value: string) => {
      if (!config) return;
      setError(null);
      const result = await dispatch("switchModelConfig", {
        provider: config.provider,
        model: config.model,
        thought: value,
      });
      if (!result.ok) setError(result.message);
    },
    [dispatch, config],
  );

  const handleModeChange = useCallback(
    async (value: string) => {
      setError(null);
      const result = await dispatch("switchCollaborationMode", { mode: value });
      if (!result.ok) setError(result.message);
    },
    [dispatch],
  );

  return (
    <div
      data-testid="model-select-panel"
      className="flex flex-wrap items-center gap-1 border-t border-card-border px-2 py-1 text-ui-xs"
    >
      <Select
        value={config ? `${config.provider}/${config.model}` : ""}
        onValueChange={(value) => void handleModelChange(value)}
        disabled={!sessionId || modelOptions.length === 0}
      >
        <SelectTrigger className="h-6 w-40 text-ui-xs" data-testid="model-select-trigger">
          <SelectValue placeholder="模型" />
        </SelectTrigger>
        <SelectContent>
          {modelOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={config?.thought ?? ""}
        onValueChange={(value) => void handleThoughtChange(value)}
        disabled={!sessionId || !config || config.thoughtLevels.length === 0}
      >
        <SelectTrigger className="h-6 w-24 text-ui-xs" data-testid="thought-select-trigger">
          <SelectValue placeholder="思考档位" />
        </SelectTrigger>
        <SelectContent>
          {(config?.thoughtLevels ?? []).map((level) => (
            <SelectItem key={level} value={level}>
              {level}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={config?.mode ?? ""}
        onValueChange={(value) => void handleModeChange(value)}
        disabled={!sessionId}
      >
        <SelectTrigger className="h-6 w-20 text-ui-xs" data-testid="mode-select-trigger">
          <SelectValue placeholder="模式" />
        </SelectTrigger>
        <SelectContent>
          {COLLABORATION_MODES.map((mode) => (
            <SelectItem key={mode} value={mode}>
              {mode}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <CompactActionButton sessionId={sessionId} snapshot={snapshot} />
      {error ? (
        <span className="text-foreground-subtle" data-testid="model-select-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** 压缩上下文按钮（busy 入队语义见 compactAction.ts；P1-14）。 */
function CompactActionButton(params: {
  sessionId: string | null;
  snapshot: ConversationSnapshot | null;
}) {
  const { sendCommand } = useV4Conversation();
  const [message, setMessage] = useState<string | null>(null);
  const allowed = isCompactAllowed(params.snapshot);
  const handleClick = useCallback(async () => {
    if (!params.sessionId) return;
    const ack = await sendCommand(buildCompactEnvelope(params.sessionId), { projectId: null });
    setMessage(interpretCompactAck(ack).message);
  }, [params.sessionId, sendCommand]);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 enabled:cursor-pointer"
        title="压缩上下文（compact：空闲立即执行，执行中排队）"
        data-testid="compact-action"
        disabled={!params.sessionId || !allowed}
        onClick={() => void handleClick()}
      >
        压缩
      </Button>
      {message ? <span className="text-foreground-subtle">{message}</span> : null}
    </>
  );
}

export interface ModelOption {
  value: string;
  label: string;
}

/** 目录 → `provider/model` 选项（多 provider 扁平；自定义模型由 provider-settings 面承担）。 */
export function buildModelOptions(view: ModelSelectionView | null): ModelOption[] {
  if (!view) return [];
  const options: ModelOption[] = [];
  for (const provider of view.providers ?? []) {
    for (const model of provider.models ?? []) {
      options.push({
        value: `${provider.providerId}/${model.modelId}`,
        label: `${provider.providerName ?? provider.providerId} · ${model.modelId}`,
      });
    }
  }
  return options;
}

/** 解析 `providerId/modelId`（modelId 允许包含 "/"；与 parseModelSelection 同口径取首段）。 */
export function splitModelPickerValue(value: string): { provider: string; model: string } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return { provider: "", model: "" };
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}
