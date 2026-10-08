import { useCallback, useEffect, useState } from "react";
import { ChevronRight, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import type { RemoteRelayFileConfig, RemoteRelayStatus } from "@zcode/shared";
import { deriveRemoteRelayPublicUrl } from "@zcode/shared";
import {
  buildRelayUrl,
  composeLanSuggestion,
  extractRelayPort,
  isLoopbackRelayHost,
  resolveRelayScenario,
  stripRelayScheme,
} from "@/remoteRelayScenario.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 中继配置表单（spec vps-relay-bridge.md §15 / §18.6）。
 *
 * 原「设置 → 远程访问」分区里的**全部配置项**（场景 / 中继地址 / 主机密钥 / 公开地址 /
 * 配对码 / E2EE / 并发槽位 / 工作区覆盖 / 随应用启动 / 保存）整体搬到这里，作为
 * 「移动端远程控制」弹层内「浏览器直连」面板的「高级设置」折叠块——设置页不再保留
 * 任何远程访问入口，避免两处各有一半配置（迁移前就是这个问题）。
 *
 * 状态由父面板（`RemoteRelayAccessPanel`）轮询并传入；本组件只负责编辑与保存，
 * 保存成功后通过 `onSaved` 把新状态交回，让链接/二维码立即刷新。
 */

const EMPTY_FORM: RemoteRelayFileConfig = {
  url: "",
  hostSecret: "",
  publicUrl: "",
  pairingToken: "",
  e2ee: false,
  channelKey: "",
  slots: 1,
  slotBase: undefined,
  workspace: "",
  autoStart: true,
};

function toForm(config: RemoteRelayFileConfig | null): RemoteRelayFileConfig {
  return {
    url: config?.url ?? "",
    hostSecret: config?.hostSecret ?? "",
    publicUrl: config?.publicUrl ?? "",
    pairingToken: config?.pairingToken ?? "",
    // E2EE 字段必须随表单 round-trip：漏掉的话下一次保存会把已生成的
    // channelKey 抹掉（下次启动重新生成 → 旧链接全部失效）且 e2ee 被静默关闭。
    e2ee: config?.e2ee ?? false,
    channelKey: config?.channelKey ?? "",
    slots: config?.slots ?? 1,
    // slotBase 必须随表单 round-trip：漏掉的话下一次保存会把自动生成的基址抹掉，
    // 重启后重新生成 → 槽位号漂移（多桌面场景会互相顶替）。
    slotBase: config?.slotBase,
    workspace: config?.workspace ?? "",
    windowId: config?.windowId,
    autoStart: config?.autoStart ?? true,
  };
}

function ConfigField({
  id,
  label,
  description,
  placeholder,
  type = "text",
  value,
  onChange,
}: {
  id: string;
  label: string;
  description?: string;
  placeholder?: string;
  type?: "text" | "password";
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-ui-base font-medium text-foreground">
        {label}
      </Label>
      {description ? (
        <div className="text-ui-sm leading-5 text-foreground-subtle">{description}</div>
      ) : null}
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function ConfigToggle({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-ui-base font-medium text-foreground">{label}</div>
        {description ? (
          <div className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{description}</div>
        ) : null}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

export function RemoteRelayConfigForm({
  status,
  onSaved,
  defaultOpen = false,
}: {
  status: RemoteRelayStatus | null;
  onSaved: (next: RemoteRelayStatus) => void;
  defaultOpen?: boolean;
}) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [form, setForm] = useState<RemoteRelayFileConfig>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  // 未配置时默认展开（用户就是来填配置的）；已配置时收起，避免遮住上面的链接。
  const [advancedOpen, setAdvancedOpen] = useState(defaultOpen);

  useEffect(() => {
    // 首次拿到状态后用文件内容回填表单；此后用户编辑不被打断。
    if (status?.fileConfig && form === EMPTY_FORM) {
      setForm(toForm(status.fileConfig));
    }
  }, [status, form]);

  const handleSave = useCallback(async () => {
    if (!platform.remoteRelaySetConfig) return;
    setSaving(true);
    try {
      const next = await platform.remoteRelaySetConfig({ config: form, apply: true });
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
  }, [platform, form, intl, onSaved]);

  const updateField = (key: keyof RemoteRelayFileConfig) => (value: string) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  /**
   * 公开地址与中继地址**通常是同一主机的不同协议**（桌面 WS 拨出 / 手机 HTTP 访问），
   * 主进程缺省由中继地址推导。因此默认只显示中继地址，只有确实不同源时才展开覆盖项。
   */
  const scenario = resolveRelayScenario(form.url);
  const relayHost = stripRelayScheme(form.url);
  const derivedPublicUrl = deriveRemoteRelayPublicUrl(form.url ?? "");
  const publicUrlOverridden = (form.publicUrl ?? "").trim().length > 0;
  // 内网场景若填的是 loopback，手机（即使同 WiFi）根本连不上：给出检测到的局域网地址一键替换。
  const suggestedLanHost = composeLanSuggestion(status?.lanAddresses, extractRelayPort(form.url));
  // 判断的是**手机最终会用的地址**：有覆盖用覆盖，否则用推导值。它指向本机时手机永远连不上。
  // 桌面 → 中继仍可走 loopback，所以这里只建议替换公开地址，不动中继地址。
  const phonePublicUrl = (form.publicUrl ?? "").trim() || derivedPublicUrl;
  const showLanSuggestion = isLoopbackRelayHost(phonePublicUrl) && suggestedLanHost != null;

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
          <p className="text-ui-sm leading-5 text-foreground-subtle">
            {t("settings.remoteRelay.configDescription", {
              path: status?.configFilePath ?? "~/.zcodium/v2/remote-relay.json",
            })}
          </p>

          {/* 场景决定 url 的协议（内网 ws:// / 公网 wss://），地址框只填主机 */}
          <div className="grid gap-1.5">
            <div className="text-ui-base font-medium text-foreground">
              {t("settings.remoteRelay.scenario")}
            </div>
            <div className="text-ui-sm leading-5 text-foreground-subtle">
              {t("settings.remoteRelay.scenarioDescription")}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant={scenario === "lan" ? "default" : "outline"}
                aria-pressed={scenario === "lan"}
                onClick={() => updateField("url")(buildRelayUrl("lan", relayHost))}
              >
                {t("settings.remoteRelay.scenarioLan")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={scenario === "public" ? "default" : "outline"}
                aria-pressed={scenario === "public"}
                onClick={() => updateField("url")(buildRelayUrl("public", relayHost))}
              >
                {t("settings.remoteRelay.scenarioPublic")}
              </Button>
            </div>
          </div>

          <ConfigField
            id="remote-relay-url"
            label={t("settings.remoteRelay.url")}
            description={t("settings.remoteRelay.urlDescription")}
            placeholder={
              scenario === "public" ? "relay.example.com" : (suggestedLanHost ?? "192.168.1.10:3180")
            }
            value={relayHost}
            onChange={(value) => updateField("url")(buildRelayUrl(scenario, value))}
          />

          {showLanSuggestion ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-2 text-ui-sm text-foreground-subtle">
              <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
              <span className="min-w-0 flex-1">{t("settings.remoteRelay.lanLoopbackWarning")}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => updateField("publicUrl")(`http://${suggestedLanHost}`)}
              >
                {t("settings.remoteRelay.lanUseDetected", { address: suggestedLanHost })}
              </Button>
            </div>
          ) : null}

          <ConfigField
            id="remote-relay-host-secret"
            label={t("settings.remoteRelay.hostSecret")}
            description={t("settings.remoteRelay.hostSecretDescription")}
            placeholder="••••••••"
            type="password"
            value={form.hostSecret ?? ""}
            onChange={updateField("hostSecret")}
          />

          {/* 公开地址默认与中继地址同源（只差协议），因此收进开关；不同源才展开输入框。 */}
          <ConfigToggle
            label={t("settings.remoteRelay.publicUrlOverride")}
            description={t("settings.remoteRelay.publicUrlOverrideDescription", {
              derived: derivedPublicUrl || "—",
            })}
            checked={publicUrlOverridden}
            onCheckedChange={(checked) =>
              updateField("publicUrl")(checked ? derivedPublicUrl : "")
            }
          />
          {publicUrlOverridden ? (
            <ConfigField
              id="remote-relay-public-url"
              label={t("settings.remoteRelay.publicUrl")}
              description={t("settings.remoteRelay.publicUrlDescription")}
              placeholder={derivedPublicUrl || "https://relay.example.com"}
              value={form.publicUrl ?? ""}
              onChange={updateField("publicUrl")}
            />
          ) : null}

          <ConfigField
            id="remote-relay-pairing-token"
            label={t("settings.remoteRelay.pairingToken")}
            description={t("settings.remoteRelay.pairingTokenDescription")}
            placeholder=""
            value={form.pairingToken ?? ""}
            onChange={updateField("pairingToken")}
          />

          {/* E2EE（spec §16）：默认关。开启后 Main 自动生成 channelKey 并落盘，
              链接自动追加 #k=（fragment 不会发给中继）。清空保存即轮换。 */}
          <ConfigToggle
            label={t("settings.remoteRelay.e2ee")}
            description={t("settings.remoteRelay.e2eeDescription")}
            checked={form.e2ee ?? false}
            onCheckedChange={(checked) =>
              setForm((previous) => ({ ...previous, e2ee: checked }))
            }
          />
          {form.e2ee ? (
            <ConfigField
              id="remote-relay-channel-key"
              label={t("settings.remoteRelay.channelKey")}
              description={t("settings.remoteRelay.channelKeyDescription")}
              placeholder=""
              value={form.channelKey ?? ""}
              onChange={updateField("channelKey")}
            />
          ) : null}

          {/* 并发客户端槽位（spec §17）：每槽位一条独立连接 + 独立 attachment。 */}
          <ConfigField
            id="remote-relay-slots"
            label={t("settings.remoteRelay.slots")}
            description={t("settings.remoteRelay.slotsDescription")}
            placeholder="1"
            value={String(form.slots ?? 1)}
            onChange={(value) => {
              const parsed = Number.parseInt(value, 10);
              setForm((previous) => ({
                ...previous,
                slots: Number.isInteger(parsed) ? Math.min(8, Math.max(1, parsed)) : 1,
              }));
            }}
          />

          <ConfigField
            id="remote-relay-workspace"
            label={t("settings.remoteRelay.workspace")}
            description={t("settings.remoteRelay.workspaceDescription")}
            placeholder="/path/to/workspace"
            value={form.workspace ?? ""}
            onChange={updateField("workspace")}
          />

          <ConfigToggle
            label={t("settings.remoteRelay.autoStart")}
            description={t("settings.remoteRelay.autoStartDescription")}
            checked={form.autoStart ?? true}
            onCheckedChange={(checked) =>
              setForm((previous) => ({ ...previous, autoStart: checked }))
            }
          />

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button
              type="button"
              className="enabled:cursor-pointer"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              {t("settings.remoteRelay.save")}
            </Button>
            <span className="text-ui-sm text-foreground-subtle">
              {t("settings.remoteRelay.saveHint")}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
