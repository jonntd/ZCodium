/**
 * 拉取模型选择器（zcode-patcher --modelhub 原生版，对应补丁的 __mhPick 面板）。
 *
 * 展示 main 进程从自定义渠道端点拉回的模型列表：搜索、全选/全不选、视觉探测
 * （1x1 图片实测，4 并发；无探测结果时回落到模型名猜测并可手动翻转）、已在列表
 * 中的模型禁选。确认后由父组件走与「添加模型」一致的 onAddModel 通路落库。
 *
 * 全部勾选/探测状态都在内层组件持有：每次打开弹窗重新挂载，状态自然复位，
 * 不依赖父组件手工清理。
 */
import { useMemo, useState } from "react";
import { Loader2Icon } from "lucide-react";
import type { ModelhubModelSummary } from "@zcode/shared";
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

const PROBE_CONCURRENCY = 4;

export interface ModelhubPickerSelection {
  id: string;
  vision: boolean;
}

export function ModelhubModelPickerDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: ModelhubModelSummary[];
  existingIds: readonly string[];
  /** 删除墓碑命中的模型：显示「已删除」并禁选，防止拉取复活已删模型。 */
  deletedIds?: readonly string[];
  /** 逐个视觉探测；返回 null 表示探测失败（保持猜测值）。缺省时只能手动标记。 */
  onProbeVision?: (modelId: string) => Promise<boolean | null>;
  onConfirm: (selected: ModelhubPickerSelection[]) => void;
}) {
  const { open, onOpenChange } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <ModelhubModelPickerDialogContent {...props} /> : null}
    </Dialog>
  );
}

function ModelhubModelPickerDialogContent({
  onOpenChange,
  models,
  existingIds,
  deletedIds,
  onProbeVision,
  onConfirm,
}: {
  onOpenChange: (open: boolean) => void;
  models: ModelhubModelSummary[];
  existingIds: readonly string[];
  deletedIds?: readonly string[];
  onProbeVision?: (modelId: string) => Promise<boolean | null>;
  onConfirm: (selected: ModelhubPickerSelection[]) => void;
}) {
  const { intl } = useZCodeIntl();
  const existingSet = useMemo(
    () => new Set(existingIds.map((id) => id.trim().toLowerCase())),
    [existingIds],
  );
  const deletedSet = useMemo(
    () => new Set((deletedIds ?? []).map((id) => id.trim().toLowerCase())),
    [deletedIds],
  );
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      models.map((model) => [model.id, !existingSet.has(model.id.trim().toLowerCase())]),
    ),
  );
  const [vision, setVision] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(models.map((model) => [model.id, model.visionGuess])),
  );
  const [probing, setProbing] = useState<Record<string, boolean>>({});
  const [probeDone, setProbeDone] = useState(0);
  const [probeTotal, setProbeTotal] = useState(0);

  const usable = models.filter(
    (model) =>
      !existingSet.has(model.id.trim().toLowerCase()) &&
      !deletedSet.has(model.id.trim().toLowerCase()),
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visibleModels = models.filter(
    (model) => !normalizedQuery || model.id.toLowerCase().includes(normalizedQuery),
  );
  const selectedCount = usable.filter((model) => checked[model.id]).length;

  const runProbe = async (targets: ModelhubModelSummary[]) => {
    if (!onProbeVision || targets.length === 0) return;
    const queue = targets.slice();
    setProbeTotal(targets.length);
    setProbeDone(0);
    const worker = async () => {
      while (queue.length > 0) {
        const target = queue.shift();
        if (!target) return;
        setProbing((current) => ({ ...current, [target.id]: true }));
        let result: boolean | null = null;
        try {
          result = await onProbeVision(target.id);
        } catch {
          result = null;
        }
        if (result != null) {
          setVision((current) => ({ ...current, [target.id]: result }));
        }
        setProbing((current) => ({ ...current, [target.id]: false }));
        setProbeDone((count) => count + 1);
      }
    };
    await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, () => worker()));
  };

  const confirm = () => {
    const selected = usable
      .filter((model) => checked[model.id])
      .map((model) => ({ id: model.id, vision: vision[model.id] ?? model.visionGuess }));
    if (selected.length === 0) return;
    onConfirm(selected);
    onOpenChange(false);
  };

  return (
    <DialogContent className="flex max-h-[76vh] flex-col overflow-hidden sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{intl.formatMessage({ id: "settings.modelhub.pick.title" })}</DialogTitle>
        <DialogDescription>
          {intl.formatMessage(
            { id: "settings.modelhub.pick.summary" },
            { selected: selectedCount, total: usable.length },
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={intl.formatMessage({ id: "settings.modelhub.pick.search" })}
          className="h-9 min-w-36 flex-1"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setChecked((current) => ({
              ...current,
              ...Object.fromEntries(
                visibleModels.map((model) => [
                  model.id,
                  existingSet.has(model.id.trim().toLowerCase()) ||
                  deletedSet.has(model.id.trim().toLowerCase())
                    ? (current[model.id] ?? false)
                    : true,
                ]),
              ),
            }));
          }}
        >
          {intl.formatMessage({ id: "settings.modelhub.pick.selectAll" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setChecked((current) => ({
              ...current,
              ...Object.fromEntries(models.map((model) => [model.id, false])),
            }));
          }}
        >
          {intl.formatMessage({ id: "settings.modelhub.pick.selectNone" })}
        </Button>
        {onProbeVision ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                void runProbe(usable.filter((model) => checked[model.id] && !probing[model.id]))
              }
            >
              {intl.formatMessage({ id: "settings.modelhub.pick.probeChecked" })}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setChecked((current) => ({
                  ...current,
                  ...Object.fromEntries(usable.map((model) => [model.id, true])),
                }));
                void runProbe(usable.filter((model) => !probing[model.id]));
              }}
            >
              {intl.formatMessage({ id: "settings.modelhub.pick.probeAll" })}
            </Button>
          </>
        ) : null}
        {probeTotal > 0 ? (
          <span className="text-ui-sm text-foreground-subtle tabular-nums">
            {probeDone}/{probeTotal}
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto py-2">
        {visibleModels.length === 0 ? (
          <div className="py-6 text-center text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: "settings.modelhub.pick.empty" })}
          </div>
        ) : (
          visibleModels.map((model) => {
            const isExisting = existingSet.has(model.id.trim().toLowerCase());
            const isDeleted = deletedSet.has(model.id.trim().toLowerCase());
            const isProbing = probing[model.id] === true;
            const modelVision = vision[model.id] ?? model.visionGuess;
            return (
              <div key={model.id} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2">
                <Checkbox
                  checked={isExisting || isDeleted ? false : (checked[model.id] ?? false)}
                  disabled={isExisting || isDeleted}
                  onCheckedChange={(value) => {
                    setChecked((current) => ({ ...current, [model.id]: value === true }));
                  }}
                />
                <span
                  className="min-w-0 flex-1 truncate font-mono text-ui-sm text-foreground"
                  title={model.id}
                >
                  {model.id}
                </span>
                {isExisting || isDeleted ? (
                  <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-foreground-subtle">
                    {intl.formatMessage({
                      id: isDeleted
                        ? "settings.modelhub.pick.deleted"
                        : "settings.modelhub.pick.existing",
                    })}
                  </span>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-w-16"
                  disabled={isExisting || isDeleted}
                  onClick={() => {
                    setVision((current) => ({ ...current, [model.id]: !modelVision }));
                  }}
                >
                  {isProbing ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> : null}
                  {modelVision
                    ? intl.formatMessage({ id: "settings.modelhub.pick.vision" })
                    : intl.formatMessage({ id: "settings.modelhub.pick.text" })}
                </Button>
              </div>
            );
          })
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
        <Button
          type="button"
          disabled={selectedCount === 0}
          onClick={confirm}
          data-testid="v4-modelhub-picker-confirm"
        >
          {intl.formatMessage({ id: "settings.modelhub.pick.confirm" }, { count: selectedCount })}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
