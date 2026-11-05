/**
 * settings/SessionParamsPanel.tsx — 会话参数面板（T12，P1-16.1）。
 *
 * - 附加可访问目录（≤256）：plat getWorkspaceSettings 读 → plat
 *   updateAdditionalDirectories 写（host 归一化 + 写回 workspace settings；
 *   改动后需重建会话生效，应答 message 一字呈现）；
 * - 删除保护 + 批量删除审批阈值：services setting 频道既有字段
 *   （AppSettings.deleteProtectionEnabled / batchDeleteApprovalThreshold）。
 */

import { useCallback, useEffect, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import type { PlatPort } from "./McpSettingsPanel";
import { normalizeWorkspaceSettingsSnapshot } from "./mcpServersModel";
import {
  buildDeleteProtectionPatch,
  normalizeAdditionalDirectoriesInput,
  projectSessionParamsForm,
  type AdditionalDirectoriesWriteBack,
} from "./workspacePreferences";

export interface SessionParamsPanelProps {
  services: IServiceAccessor;
  plat: PlatPort;
  onClose?: () => void;
}

export function SessionParamsPanel({ services, plat, onClose }: SessionParamsPanelProps) {
  const [directoriesText, setDirectoriesText] = useState<string | null>(null);
  const [deleteProtectionEnabled, setDeleteProtectionEnabled] = useState<boolean | null>(null);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      plat.call("getWorkspaceSettings").then((raw) =>
        normalizeWorkspaceSettingsSnapshot(raw),
      ),
      services.settingService.get().then((settings) => projectSessionParamsForm(settings)),
    ])
      .then(([snapshot, params]) => {
        if (!active) return;
        setDirectoriesText(snapshot.additionalDirectories.join("\n"));
        setDeleteProtectionEnabled(params.deleteProtectionEnabled);
        setThreshold(params.batchDeleteApprovalThreshold);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [plat, services]);

  const handleSaveDirectories = useCallback(async () => {
    if (directoriesText === null) return;
    try {
      const directories = normalizeAdditionalDirectoriesInput(directoriesText.split("\n"));
      const result = (await plat.call(
        "updateAdditionalDirectories",
        directories,
      )) as AdditionalDirectoriesWriteBack;
      setDirectoriesText(result.directories.join("\n"));
      setMessage(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [directoriesText, plat]);

  const handleSaveDeleteProtection = useCallback(async () => {
    if (deleteProtectionEnabled === null || threshold === null) return;
    try {
      await services.settingService.update(
        buildDeleteProtectionPatch({
          deleteProtectionEnabled,
          batchDeleteApprovalThreshold: threshold,
        }),
      );
      setMessage("删除保护偏好已保存（随下次会话生效）");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [deleteProtectionEnabled, threshold, services]);

  return (
    <div
      data-testid="session-params-panel"
      className="border-t border-card-border bg-card px-2 py-1 text-ui-xs"
    >
      <div className="flex items-center gap-1">
        <span>会话参数</span>
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 enabled:cursor-pointer"
            onClick={onClose}
          >
            收起
          </Button>
        ) : null}
      </div>
      {error ? <div className="pb-1 text-foreground-subtle">{error}</div> : null}
      {message ? (
        <div className="pb-1 text-foreground-subtle" data-testid="session-params-message">
          {message}
        </div>
      ) : null}
      {directoriesText === null || deleteProtectionEnabled === null || threshold === null ? (
        <div className="pb-1 text-foreground-subtle">读取设置中…</div>
      ) : (
        <>
          <div className="text-foreground-subtle">
            附加可访问目录（每行一个，≤256 个；改动后需重建会话生效）
          </div>
          <textarea
            className="h-20 w-full rounded border border-card-border bg-background p-1 font-mono text-ui-xs"
            data-testid="additional-directories"
            value={directoriesText}
            onChange={(event) => setDirectoriesText(event.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 enabled:cursor-pointer"
            onClick={() => void handleSaveDirectories()}
          >
            保存附加目录
          </Button>
          <div className="mt-1 flex items-center gap-1 pb-2">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={deleteProtectionEnabled}
                onChange={(event) => setDeleteProtectionEnabled(event.target.checked)}
              />
              删除保护（rm/rmdir/unlink 移入废纸篓）
            </label>
            <span className="text-foreground-subtle">批量删除审批阈值</span>
            <Input
              type="number"
              min={1}
              className="h-6 w-16 text-ui-xs"
              value={threshold}
              onChange={(event) => setThreshold(Number(event.target.value))}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 enabled:cursor-pointer"
              onClick={() => void handleSaveDeleteProtection()}
            >
              保存
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
