/**
 * 请求头模拟面板（1:1 移植自 zcode-patcher --modelhub 的 __mhHeaders）。
 *
 * 两个官方客户端指纹预设（Claude claude-cli / Codex codex_cli_rs）：勾选=生效、
 * 取消勾选=从渠道移除；session_id 为 auto 键（启用时生成 uuid，可「换一个」）。
 * 应用语义与补丁一致：写入当前预设勾选的键，移除当前预设未勾选的键，并清除
 * 其它预设的独有键（切换预设即替换模拟指纹；两预设共享键保留）。
 * 「清除全部模拟」移除所有预设键，渠道自定义的其它请求头不受影响。
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  MODELHUB_HEADER_PRESETS,
  generateHeaderUuid,
  sharedPresetKeys,
} from "./modelhubHeaderPresets.js";

type PresetTab = keyof typeof MODELHUB_HEADER_PRESETS;

interface HeaderRowState {
  key: string;
  auto?: "uuid";
  checked: boolean;
  value: string;
}

/** 按补丁 loadTab 语义初始化某预设的行状态（shared 键不取渠道现值）。 */
function buildRows(
  tab: PresetTab,
  current: Record<string, string>,
  shared: Set<string>,
): HeaderRowState[] {
  return MODELHUB_HEADER_PRESETS[tab].map((preset) => {
    const inChannel = current[preset.key] !== undefined;
    const value = shared.has(preset.key)
      ? preset.auto === "uuid"
        ? generateHeaderUuid()
        : preset.value
      : inChannel
        ? current[preset.key]!
        : preset.auto === "uuid"
          ? generateHeaderUuid()
          : preset.value;
    return {
      key: preset.key,
      ...(preset.auto ? { auto: preset.auto } : {}),
      checked: inChannel,
      value,
    };
  });
}

export function ModelhubHeadersDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentHeaders: Record<string, string>;
  onApply: (headers: Record<string, string>) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? <ModelhubHeadersDialogContent {...props} /> : null}
    </Dialog>
  );
}

function ModelhubHeadersDialogContent({
  onOpenChange,
  currentHeaders,
  onApply,
}: {
  onOpenChange: (open: boolean) => void;
  currentHeaders: Record<string, string>;
  onApply: (headers: Record<string, string>) => void;
}) {
  const { intl } = useZCodeIntl();
  const shared = useMemo(() => sharedPresetKeys(), []);
  const [tab, setTab] = useState<PresetTab>("claude");
  const [rows, setRows] = useState<HeaderRowState[]>(() =>
    buildRows("claude", currentHeaders, shared),
  );

  const loadTab = (next: PresetTab) => {
    setTab(next);
    setRows(buildRows(next, currentHeaders, shared));
  };

  const apply = () => {
    const out: Record<string, string> = { ...currentHeaders };
    // 其它预设的独有键从渠道里清除（切换预设即替换模拟指纹；shared 键保留）。
    for (const [presetTab, presetRows] of Object.entries(MODELHUB_HEADER_PRESETS)) {
      if (presetTab === tab) continue;
      for (const preset of presetRows) {
        if (shared.has(preset.key)) continue;
        if (out[preset.key] !== undefined) delete out[preset.key];
      }
    }
    for (const row of rows) {
      if (row.checked) out[row.key] = row.value;
      else if (out[row.key] !== undefined) delete out[row.key];
    }
    onApply(out);
    onOpenChange(false);
  };

  const clearAll = () => {
    const out: Record<string, string> = { ...currentHeaders };
    for (const presetRows of Object.values(MODELHUB_HEADER_PRESETS)) {
      for (const preset of presetRows) delete out[preset.key];
    }
    onApply(out);
    onOpenChange(false);
  };

  const checkedCount = rows.filter((row) => row.checked).length;

  return (
    <DialogContent className="flex max-h-[76vh] flex-col overflow-hidden sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{intl.formatMessage({ id: "settings.modelhub.headers.title" })}</DialogTitle>
        <DialogDescription>
          {intl.formatMessage({ id: "settings.modelhub.headers.hint" })}
        </DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-2 border-b border-border pb-3">
        {(Object.keys(MODELHUB_HEADER_PRESETS) as PresetTab[]).map((presetTab) => (
          <Button
            key={presetTab}
            type="button"
            variant={tab === presetTab ? "secondary" : "outline"}
            size="sm"
            data-active={tab === presetTab || undefined}
            onClick={() => loadTab(presetTab)}
          >
            {intl.formatMessage({ id: `settings.modelhub.headers.tab.${presetTab}` })}
          </Button>
        ))}
        <span className="ml-auto text-ui-sm text-foreground-subtle tabular-nums">
          {intl.formatMessage(
            { id: "settings.modelhub.headers.count" },
            { checked: checkedCount, total: rows.length },
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto py-2">
        {rows.map((row, index) => (
          <div key={row.key} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <Checkbox
              checked={row.checked}
              onCheckedChange={(value) => {
                setRows((current) =>
                  current.map((item, i) =>
                    i === index
                      ? {
                          ...item,
                          checked: value === true,
                          ...(item.auto && value === true && !item.value
                            ? { value: generateHeaderUuid() }
                            : {}),
                        }
                      : item,
                  ),
                );
              }}
            />
            <span
              className="w-56 shrink-0 truncate font-mono text-ui-sm text-foreground"
              title={row.key}
            >
              {row.key}
            </span>
            <Input
              value={row.value}
              onChange={(event) => {
                const value = event.target.value;
                setRows((current) =>
                  current.map((item, i) => (i === index ? { ...item, value } : item)),
                );
              }}
              className="h-8 min-w-0 flex-1 font-mono text-ui-sm"
            />
            {row.auto ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setRows((current) =>
                    current.map((item, i) =>
                      i === index ? { ...item, value: generateHeaderUuid() } : item,
                    ),
                  );
                }}
              >
                {intl.formatMessage({ id: "settings.modelhub.headers.regenerate" })}
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={clearAll}>
          {intl.formatMessage({ id: "settings.modelhub.headers.clearAll" })}
        </Button>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
        <Button type="button" onClick={apply} data-testid="v4-modelhub-headers-apply">
          {intl.formatMessage({ id: "settings.modelhub.headers.apply" })}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
