/* eslint-disable max-lines -- 远程访问设置卡片集中维护状态轮询、分享链接与配置表单（含场景/公开地址联动）；
   拆开会把同一份表单状态与 status 轮询跨文件传递，可读性更差（与 McpSettingsSection 等同处理）。 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  LoaderCircle,
  Play,
  RefreshCw,
  Square,
  TriangleAlert,
} from "lucide-react";
import type { RemoteRelayFileConfig, RemoteRelayStatus } from "@zcode/shared";
import { deriveRemoteRelayPublicUrl } from "@zcode/shared";
import {
  buildRelayUrl,
  composeLanSuggestion,
  extractRelayPort,
  isLoopbackRelayHost,
  resolveRelayScenario,
  stripRelayScheme,
} from "./remoteRelayScenario.js";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsBadge, SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 「远程访问」设置卡片（spec §15）：把 VPS 中继的配置/启停/分享链接做成 UI，
 * 对应官方 ZCode「打开 App → UI 里拿链接」的体验。
 * 平台方法由桌面 preload 桥提供；Web 环境下该分区不渲染（见 settingsPageConfig 门控）。
 */

const STATUS_POLL_INTERVAL_MS = 5_000;

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
    <div className="grid gap-1.5 px-4 py-3 sm:grid-cols-[220px_minmax(0,1fr)] sm:items-center sm:gap-4">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-ui-base font-medium text-foreground">
          {label}
        </Label>
        {description ? (
          <div className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{description}</div>
        ) : null}
      </div>
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

export function RemoteRelaySection() {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [status, setStatus] = useState<RemoteRelayStatus | null>(null);
  const [form, setForm] = useState<RemoteRelayFileConfig>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [copied, setCopied] = useState(false);
  // 默认收起：多数用户只需要上面那条链接；中继地址/密钥/工作区属于一次性的高级配置。
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const remoteRelayGetStatus = platform.remoteRelayGetStatus?.bind(platform);
  const supported = remoteRelayGetStatus != null;

  const refresh = useCallback(async () => {
    if (!remoteRelayGetStatus) return;
    try {
      const next = await remoteRelayGetStatus();
      setStatus(next);
    } catch (error) {
      // 轮询失败不打断页面，保留上一次状态即可。
      console.warn("[remote-relay] getStatus failed", error);
    }
  }, [remoteRelayGetStatus]);

  useEffect(() => {
    if (!supported) return;
    void refresh();
    pollTimerRef.current = setInterval(() => {
      void refresh();
    }, STATUS_POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [supported, refresh]);

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
      setStatus(next);
      setForm(toForm(next.fileConfig));
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
  }, [platform, form, intl]);

  const handleToggleRun = useCallback(async () => {
    const method = status?.running ? platform.remoteRelayStop : platform.remoteRelayStart;
    if (!method) return;
    setToggling(true);
    try {
      setStatus(await method.call(platform));
    } catch (error) {
      toast(
        `${intl.formatMessage({ id: "settings.remoteRelay.toggleFailed" })}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { variant: "warning" },
      );
    } finally {
      setToggling(false);
    }
  }, [platform, status?.running, intl]);

  const handleCopyLink = useCallback(async () => {
    if (!status?.shareUrl) return;
    try {
      await navigator.clipboard.writeText(status.shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch (error) {
      console.warn("[remote-relay] copy failed", error);
    }
  }, [status?.shareUrl]);

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

  if (!supported) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-ui-lg font-semibold text-foreground">{t("settings.remoteRelay.title")}</h3>
          <p className="mt-1 text-ui-base text-foreground-subtle">{t("settings.remoteRelay.description")}</p>
        </div>
        <SettingsGroupCard>
          <div className="px-4 py-6 text-ui-base text-foreground-subtle">
            {t("settings.remoteRelay.unsupported")}
          </div>
        </SettingsGroupCard>
      </div>
    );
  }

  const connected = status?.running === true && status.connected;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-ui-lg font-semibold text-foreground">{t("settings.remoteRelay.title")}</h3>
        <p className="mt-1 text-ui-base text-foreground-subtle">{t("settings.remoteRelay.description")}</p>
      </div>

      {/* 状态卡片：连接状态 + 启停 + 分享链接 */}
      <SettingsGroupCard>
        <SettingsRow
          label={t("settings.remoteRelay.status")}
          description={
            status == null
              ? t("settings.remoteRelay.statusLoading")
              : status.running
                ? connected
                  ? t("settings.remoteRelay.statusConnected")
                  : t("settings.remoteRelay.statusConnecting")
                : t("settings.remoteRelay.statusStopped")
          }
          control={
            <div className="flex items-center gap-2">
              {status?.e2ee ? (
                <SettingsBadge>{t("settings.remoteRelay.badgeE2ee")}</SettingsBadge>
              ) : null}
              {status?.running ? (
                <SettingsBadge>
                  <span className={connected ? "text-emerald-600" : "text-amber-600"}>
                    {connected ? "●" : "◐"}
                  </span>{" "}
                  {connected
                    ? t("settings.remoteRelay.badgeConnected")
                    : t("settings.remoteRelay.badgeConnecting")}
                </SettingsBadge>
              ) : (
                <SettingsBadge>{t("settings.remoteRelay.badgeStopped")}</SettingsBadge>
              )}
              <Button
                type="button"
                variant={status?.running ? "outline" : "default"}
                disabled={toggling}
                onClick={() => void handleToggleRun()}
              >
                {toggling ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : status?.running ? (
                  <Square className="size-4" />
                ) : (
                  <Play className="size-4" />
                )}
                {status?.running
                  ? t("settings.remoteRelay.stop")
                  : t("settings.remoteRelay.start")}
              </Button>
            </div>
          }
        />
        <SettingsRow
          label={t("settings.remoteRelay.shareLink")}
          description={t("settings.remoteRelay.shareLinkDescription")}
          control={
            <Button
              type="button"
              variant="outline"
              disabled={!status?.shareUrl || copied}
              onClick={() => void handleCopyLink()}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? t("settings.remoteRelay.copied") : t("settings.remoteRelay.copy")}
            </Button>
          }
          detail={
            status?.shareUrl ? (
              <code className="block max-w-full truncate rounded-md bg-surface px-2 py-1 text-ui-sm text-foreground">
                {status.shareUrl}
              </code>
            ) : (
              <span className="text-ui-sm text-foreground-subtle">
                {t("settings.remoteRelay.shareLinkEmpty")}
              </span>
            )
          }
        />
      </SettingsGroupCard>

      {/* 配置：默认收起。写 ~/.zcodium/v2/remote-relay.json 并热应用。 */}
      <SettingsGroupCard>
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-4 py-3 text-left"
              aria-expanded={advancedOpen}
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
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t border-border px-4 py-3 text-ui-sm leading-5 text-foreground-subtle">
              {t("settings.remoteRelay.configDescription", {
                path: status?.configFilePath ?? "~/.zcodium/v2/remote-relay.json",
              })}
            </div>
            {/* 场景决定 url 的协议（内网 ws:// / 公网 wss://），地址框只填主机 */}
            <SettingsRow
              label={t("settings.remoteRelay.scenario")}
              description={t("settings.remoteRelay.scenarioDescription")}
              control={
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
              }
            />
            <ConfigField
              id="remote-relay-url"
              label={t("settings.remoteRelay.url")}
              description={t("settings.remoteRelay.urlDescription")}
              placeholder={
                scenario === "public"
                  ? "relay.example.com"
                  : (suggestedLanHost ?? "192.168.1.10:3180")
              }
              value={relayHost}
              onChange={(value) => updateField("url")(buildRelayUrl(scenario, value))}
            />
            {showLanSuggestion ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 text-ui-sm text-foreground-subtle">
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
            <SettingsRow
              label={t("settings.remoteRelay.publicUrlOverride")}
              description={t("settings.remoteRelay.publicUrlOverrideDescription", {
                derived: derivedPublicUrl || "—",
              })}
              control={
                <Switch
                  checked={publicUrlOverridden}
                  onCheckedChange={(checked) =>
                    updateField("publicUrl")(checked ? derivedPublicUrl : "")
                  }
                />
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
            <SettingsRow
              label={t("settings.remoteRelay.e2ee")}
              description={t("settings.remoteRelay.e2eeDescription")}
              control={
                <Switch
                  checked={form.e2ee ?? false}
                  onCheckedChange={(checked) =>
                    setForm((previous) => ({ ...previous, e2ee: checked }))
                  }
                />
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
            <SettingsRow
              label={t("settings.remoteRelay.autoStart")}
              description={t("settings.remoteRelay.autoStartDescription")}
              control={
                <Switch
                  checked={form.autoStart ?? true}
                  onCheckedChange={(checked) =>
                    setForm((previous) => ({ ...previous, autoStart: checked }))
                  }
                />
              }
            />
          </CollapsibleContent>
        </Collapsible>
        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <Button type="button" disabled={saving} onClick={() => void handleSave()}>
            {saving ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {t("settings.remoteRelay.save")}
          </Button>
          <span className="text-ui-sm text-foreground-subtle">{t("settings.remoteRelay.saveHint")}</span>
        </div>
      </SettingsGroupCard>
    </div>
  );
}
