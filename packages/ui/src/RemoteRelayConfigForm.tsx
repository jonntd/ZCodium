import { useCallback, useEffect, useState } from "react";
import { ChevronRight, LoaderCircle, RefreshCw } from "lucide-react";
import type { RemoteRelayFileConfig, RemoteRelayStatus } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 中继配置表单（spec vps-relay-bridge.md §15 / §18.6 / §19）。
 *
 * 「移动端远程控制」弹层内「浏览器直连」面板的「高级设置」折叠块。v6.1 极简后
 * 本块只承载两件事：低频部署项的指引（写配置文件 / env，UI 不再有输入框）与
 * 「重置密钥」。用户的主面 = 开关 + 中继地址（`RemoteRelayAccessPanel`）。
 *
 * 密钥（roomKey / channelKey）**不出现在表单里**：两者由 Main 自动生成落盘
 * （spec §19.5），随分享链接分发；这里只提供「重置密钥」（两把一起清空保存，
 * 补齐链自动生成新值，旧手机链接全部失效）。
 *
 * 状态由父面板（`RemoteRelayAccessPanel`）轮询并传入；本组件只负责编辑与保存，
 * 保存成功后通过 `onSaved` 把新状态交回，让链接/二维码立即刷新。
 */

const EMPTY_FORM: RemoteRelayFileConfig = {
  url: "",
  roomKey: "",
  publicUrl: "",
  // e2ee 默认 true（v4，2026-10-21）：全新设备默认加密，与 Main 侧 isE2eeEnabled 的
  // 「未显式设置 → 开」判定同源（spec §16.5）。
  e2ee: true,
  channelKey: "",
  slots: 1,
  workspace: "",
  autoStart: true,
};

function toForm(config: RemoteRelayFileConfig | null): RemoteRelayFileConfig {
  // 全字段 round-trip：用户看不见这些字段了，但「重置密钥」保存时必须原样带回
  // ——漏掉任何一个（slots/workspace/e2ee…）都会被整体覆写回缺省值。
  return {
    url: config?.url ?? "",
    roomKey: config?.roomKey ?? "",
    publicUrl: config?.publicUrl ?? "",
    e2ee: config?.e2ee ?? true,
    channelKey: config?.channelKey ?? "",
    slots: config?.slots ?? 1,
    workspace: config?.workspace ?? "",
    windowId: config?.windowId,
    autoStart: config?.autoStart ?? true,
  };
}

export function RemoteRelayConfigForm({
  status,
  onSaved,
  defaultOpen = false,
}: {
  status: RemoteRelayStatus | null;
  onSaved: (next: RemoteRelayStatus) => void;
  /** 面板不传（高级里已没有必填项）；SSR 测试用它展开渲染内容。 */
  defaultOpen?: boolean;
}) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [form, setForm] = useState<RemoteRelayFileConfig>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(defaultOpen);

  useEffect(() => {
    // 首次拿到状态后用文件内容回填表单；此后用户编辑不被打断。
    if (status?.fileConfig && form === EMPTY_FORM) {
      setForm(toForm(status.fileConfig));
    }
  }, [status, form]);

  const doSave = useCallback(
    async (config: RemoteRelayFileConfig) => {
      if (!platform.remoteRelaySetConfig) return;
      setSaving(true);
      try {
        const next = await platform.remoteRelaySetConfig({ config, apply: true });
        setForm(toForm(next.fileConfig));
        onSaved(next);
        toast(intl.formatMessage({ id: "settings.remoteRelay.saveSuccess" }));
      } catch (error) {
        toast(
          `${intl.formatMessage({ id: "settings.remoteRelay.saveFailed" })}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { variant: "warning" },
        );
      } finally {
        setSaving(false);
      }
    },
    [platform, intl, onSaved],
  );

  /**
   * 重置密钥（spec §19.5 轮换语义）：roomKey 与 channelKey 一起清空保存，
   * Main 侧补齐链自动生成新值——旧手机链接/PWA 全部失效，需重新扫码。
   * 必须把清空后的对象**显式**传给 doSave：setState 是异步的，读 state 会拿到旧值。
   */
  const handleRotateKeys = useCallback(() => {
    void doSave({ ...form, roomKey: "", channelKey: "" });
  }, [doSave, form]);

  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);

  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left"
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((previous) => !previous)}
      >
        <ChevronRight
          className={`size-4 shrink-0 text-foreground-subtle transition-transform ${
            advancedOpen ? "rotate-90" : ""
          }`}
        />
        <span className="text-ui-base font-medium text-foreground">
          {t("settings.remoteRelay.advanced")}
        </span>
        <span className="ml-auto truncate text-ui-sm text-foreground-subtle">
          {t("settings.remoteRelay.advancedDescription")}
        </span>
      </button>

      {advancedOpen ? (
        <div className="space-y-4 border-t border-border px-3 py-3">
          {/* v6.1 极简（spec §19.4）：用户只需要填中继地址（主卡）；公开地址覆盖 /
              E2EE / 并发槽位 / 工作区覆盖 / 随启动属于低频部署项，写配置文件或环境
              变量即可（字段与语义全部保留，只是不再有 UI 输入）。这里唯一可操作的
              是「重置密钥」。 */}
          <p className="text-ui-sm leading-5 text-foreground-subtle">
            {t("settings.remoteRelay.lowFreqHint")}
          </p>
          <p className="text-ui-sm leading-5 text-foreground-subtle">
            {t("settings.remoteRelay.configDescription", {
              path: status?.configFilePath ?? "~/.zcodium/v2/remote-relay.json",
            })}
          </p>

          {/* 密钥（roomKey / channelKey）不进表单（spec §19.5）：自动生成、随链接分发，
              用户无感；这里只给「重置密钥」——两把一起清空保存，补齐链生成新值，
              旧手机链接全部失效。 */}
          <div className="grid gap-1.5">
            <div className="text-ui-base font-medium text-foreground">
              {t("settings.remoteRelay.keysTitle")}
            </div>
            <div className="text-ui-sm leading-5 text-foreground-subtle">
              {t("settings.remoteRelay.keysAutoManaged")}
            </div>
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving}
                className="enabled:cursor-pointer"
                onClick={handleRotateKeys}
              >
                {saving ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                {t("settings.remoteRelay.rotateKeys")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
