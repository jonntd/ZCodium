import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, LoaderCircle, TriangleAlert } from "lucide-react";
import type { RemoteRelayFileConfig, RemoteRelayStatus } from "@zcode/shared";
import {
  buildRelayUrl,
  resolveRelayScenario,
  stripRelayScheme,
} from "@/remoteRelayScenario.js";
import { RemoteRelayConfigForm } from "@/RemoteRelayConfigForm.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 「浏览器直连」接入面板（spec vps-relay-bridge.md §15 / §18.6 / §19）。
 *
 * v6 key-room 之后的**主面 = 一个开关 + 一个中继地址**（对齐官方「一个开关」的体验）：
 * - 开关 = 启停中继客户端（拨上去前若地址有改动会先保存再启动）；
 * - 地址框只填主机[:端口]，协议用旁边的「明文 / TLS」小段选择；
 * - 密钥（roomKey / channelKey）由 Main 自动生成、随分享链接分发，**不出现在界面上**
 *   （轮换入口在「高级设置 → 重置密钥」）。
 * 高级设置（`RemoteRelayConfigForm`）收部署细节，其余链接/二维码逻辑不变。
 *
 * 中继是**应用级**配置（全局一份，`~/.zcodium/v2/remote-relay.json`），与弹层所属的
 * 工作区无关：本面板读写的是同一份全局配置，只是入口挪到了工作区头部的远控弹层。
 *
 * Web 环境没有中继 IPC——这里整块不渲染。
 */

const STATUS_POLL_INTERVAL_MS = 5_000;

/** setConfig 是整体覆写：显式挑白名单字段，避免把轮询状态里的杂质写进配置文件。 */
function pickPersistedConfig(file: RemoteRelayFileConfig | null): RemoteRelayFileConfig {
  return {
    url: file?.url,
    roomKey: file?.roomKey,
    publicUrl: file?.publicUrl,
    workspace: file?.workspace,
    windowId: file?.windowId,
    autoStart: file?.autoStart,
    e2ee: file?.e2ee,
    channelKey: file?.channelKey,
    slots: file?.slots,
  };
}

type LinkKey = "lan" | "public";

function AccessLinkRow({
  label,
  url,
  unavailableHint,
  qrDataUrl,
  copied,
  copyLabel,
  copiedLabel,
  onCopy,
  qrAlt,
}: {
  label: string;
  url: string | null;
  unavailableHint: string;
  qrDataUrl: string | null;
  copied: boolean;
  copyLabel: string;
  copiedLabel: string;
  onCopy: () => void;
  qrAlt: string;
}) {
  return (
    // ⚠ `min-w-0` 必须留着：本行是 grid 的子项，默认 `min-width: auto` 会取内容
    // （那条含 token + #k= 的长 URL）的 min-content 宽度，把列顶穿、压到相邻的
    // Bot Channel 卡片上（用户实测「链接地址 UI 拉伸穿透」）。
    <div className="flex min-w-0 items-start gap-3 rounded-lg bg-surface px-3 py-3">
      {url && qrDataUrl ? (
        <img
          src={qrDataUrl}
          alt={qrAlt}
          className="size-24 shrink-0 rounded-md border border-border bg-background p-1"
        />
      ) : null}
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="text-ui-base font-medium text-foreground">{label}</div>
        {url ? (
          <>
            {/* 链接很长（token + #k=），只截断显示；完整值靠复制按钮 / 二维码 / hover。 */}
            <code
              title={url}
              className="block truncate rounded-md bg-background px-2 py-1 text-ui-sm text-foreground"
            >
              {url}
            </code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={copied}
              className="enabled:cursor-pointer"
              onClick={onCopy}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? copiedLabel : copyLabel}
            </Button>
          </>
        ) : (
          <p className="text-ui-sm leading-5 text-foreground-subtle">{unavailableHint}</p>
        )}
      </div>
    </div>
  );
}

export function RemoteRelayAccessPanel() {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [status, setStatus] = useState<RemoteRelayStatus | null>(null);
  const [toggling, setToggling] = useState(false);
  const [copied, setCopied] = useState<LinkKey | null>(null);
  const [qrDataUrls, setQrDataUrls] = useState<{ lan: string | null; public: string | null }>({
    lan: null,
    public: null,
  });
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ⚠ 这里**不能**写 `platform.remoteRelayGetStatus?.bind(platform)`：`.bind()` 每次 render
  // 都产出新的函数引用 → `useCallback` 依赖随之变化 → effect 每次 render 重跑 →
  // `refresh()` → `setStatus(新对象)` → 再 render ⇒ **无限 IPC 轮询循环**（主进程被
  // RemoteRelayGetStatus 打满，而每个请求都要读配置文件 + 重新探测局域网地址）。
  // 平台方法本身是无 `this` 的箭头函数（desktopPlatform.ts），直接引用即可，引用恒定。
  const remoteRelayGetStatus = platform.remoteRelayGetStatus;
  const supported = remoteRelayGetStatus != null;

  const refresh = useCallback(async () => {
    if (!remoteRelayGetStatus) return;
    try {
      setStatus(await remoteRelayGetStatus());
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
    // 焦点回到窗口 / 页面从后台切回时立刻拉一次：5s 轮询的滞后是「设置改了、
    // 面板慢半拍才变」感知的主要来源；窗口可见性变化是用户回来操作的确定信号。
    const refetch = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", refetch);
    window.addEventListener("focus", refetch);
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
      document.removeEventListener("visibilitychange", refetch);
      window.removeEventListener("focus", refetch);
    };
  }, [supported, refresh]);

  const lanShareUrl = status?.lanShareUrl ?? null;
  const publicShareUrl = status?.publicShareUrl ?? null;

  // 链接一变就重编码两条二维码；依赖是字符串原始值，5s 轮询不会因对象重建而重编码。
  useEffect(() => {
    let cancelled = false;
    const encode = (url: string | null) =>
      url
        ? QRCode.toDataURL(url, { margin: 1, width: 200 }).catch((error) => {
            console.warn("[remote-relay] QR encode failed", error);
            return null;
          })
        : Promise.resolve(null);
    void Promise.all([encode(lanShareUrl), encode(publicShareUrl)]).then(([lan, pub]) => {
      if (cancelled) return;
      setQrDataUrls({ lan, public: pub });
    });
    return () => {
      cancelled = true;
    };
  }, [lanShareUrl, publicShareUrl]);

  // ── v6 主卡：开关 + 中继地址（spec §19 对齐官方「一个开关」体验）──────────────
  // 地址草稿只在用户编辑过（dirty）时独立于轮询；未 dirty 时跟随配置回显。
  const configUrl = status?.fileConfig?.url ?? "";
  const [addressDraft, setAddressDraft] = useState("");
  const [scenarioDraft, setScenarioDraft] = useState<"lan" | "public">("lan");
  const addressDirtyRef = useRef(false);
  const [savingAddress, setSavingAddress] = useState(false);

  useEffect(() => {
    if (addressDirtyRef.current) return;
    setAddressDraft(stripRelayScheme(configUrl));
    setScenarioDraft(resolveRelayScenario(configUrl));
  }, [configUrl]);

  const remoteRelaySetConfig = platform.remoteRelaySetConfig;
  const remoteRelayStart = platform.remoteRelayStart;
  const remoteRelayStop = platform.remoteRelayStop;

  const toastError = useCallback(
    (error: unknown) => {
      toast(
        `${intl.formatMessage({ id: "settings.remoteRelay.toggleFailed" })}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { variant: "warning" },
      );
    },
    [intl],
  );

  /** 地址落盘（仅在有改动时）：白名单字段整体覆写 + apply 重启客户端。 */
  const saveAddress = useCallback(async (): Promise<RemoteRelayStatus | null> => {
    if (!remoteRelaySetConfig) return status;
    const host = addressDraft.trim();
    const nextUrl = host ? buildRelayUrl(scenarioDraft, host) : "";
    if (nextUrl === configUrl) {
      addressDirtyRef.current = false;
      return status;
    }
    setSavingAddress(true);
    try {
      const next = await remoteRelaySetConfig({
        config: { ...pickPersistedConfig(status?.fileConfig ?? null), url: nextUrl },
        apply: true,
      });
      setStatus(next);
      addressDirtyRef.current = false;
      setAddressDraft(stripRelayScheme(nextUrl));
      return next;
    } catch (error) {
      toastError(error);
      return null;
    } finally {
      setSavingAddress(false);
    }
  }, [remoteRelaySetConfig, addressDraft, scenarioDraft, configUrl, status, toastError]);

  /**
   * 主开关：拨上去 = 保存未落盘的地址改动 + 启动；拨下来 = 停止。
   * 没有任何地址（草稿与配置都空）时不允许开：启动没有可拨的目标。
   */
  const handleSwitch = useCallback(
    async (next: boolean) => {
      if (!next) {
        if (!remoteRelayStop) return;
        setToggling(true);
        try {
          setStatus(await remoteRelayStop.call(platform));
        } catch (error) {
          toastError(error);
        } finally {
          setToggling(false);
        }
        return;
      }
      if (!remoteRelayStart) return;
      if (!addressDraft.trim() && !configUrl) {
        toast(intl.formatMessage({ id: "settings.remoteRelay.switchNeedsAddress" }), {
          variant: "warning",
        });
        return;
      }
      setToggling(true);
      try {
        // 先落盘地址（有改动时），再启动——start 读的是配置文件；保存失败则保持原位。
        if (addressDirtyRef.current && (await saveAddress()) == null) return;
        setStatus(await remoteRelayStart.call(platform));
      } catch (error) {
        toastError(error);
      } finally {
        setToggling(false);
      }
    },
    [remoteRelayStop, remoteRelayStart, platform, addressDraft, configUrl, saveAddress, intl, toastError],
  );


  const handleCopy = useCallback(async (key: LinkKey, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(key);
      setTimeout(() => setCopied((previous) => (previous === key ? null : previous)), 2_000);
    } catch (error) {
      console.warn("[remote-relay] copy failed", error);
    }
  }, []);

  if (!supported) return null;

  const t = (id: string) => intl.formatMessage({ id });
  const connected = status?.running === true && status.connected;
  const statusText =
    status == null
      ? t("settings.remoteRelay.statusLoading")
      : status.running
        ? connected
          ? t("settings.remoteRelay.statusConnected")
          : t("settings.remoteRelay.statusConnecting")
        : t("settings.remoteRelay.statusStopped");

  return (
    // `min-w-0` 让本卡片服从 grid 轨道宽度（默认 min-width:auto 会取内容的 min-content）；
    // `overflow-hidden` 作为兜底：任何残余溢出都被裁在卡片内，不会压到相邻的 Bot Channel。
    <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="text-ui-base font-medium text-foreground">
            {t("webRemoteControl.browser.title")}
          </div>
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {t("webRemoteControl.browser.description")}
          </p>
        </div>
        {/* 主开关（spec §19 官方形态）：开 = 保存地址改动并启动；关 = 停止。
            没有任何地址时禁用——启动没有可拨的目标。 */}
        <Switch
          checked={status?.running === true}
          disabled={toggling || savingAddress || (!status?.configured && !addressDraft.trim())}
          aria-label={status?.running ? t("settings.remoteRelay.stop") : t("settings.remoteRelay.start")}
          onCheckedChange={(next) => void handleSwitch(next)}
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-ui-sm text-foreground-subtle">
        {toggling || savingAddress ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
        <span>{statusText}</span>
        {status?.e2ee ? (
          <span className="rounded-md bg-surface px-2 py-0.5 text-ui-xs font-medium text-foreground-subtle">
            {t("settings.remoteRelay.badgeE2ee")}
          </span>
        ) : null}
      </div>

      {/* 中继地址：主面唯一的必填输入。只填主机[:端口]，协议用相邻分段选择；
          失焦/回车即落盘（有改动时），开关拨上去之前也会自动保存。 */}
      <div className="mb-3 grid gap-1.5">
        <div className="text-ui-base font-medium text-foreground">
          {t("settings.remoteRelay.url")}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant={scenarioDraft === "lan" ? "default" : "outline"}
              aria-pressed={scenarioDraft === "lan"}
              onClick={() => {
                addressDirtyRef.current = true;
                setScenarioDraft("lan");
              }}
            >
              {t("settings.remoteRelay.scenarioLan")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={scenarioDraft === "public" ? "default" : "outline"}
              aria-pressed={scenarioDraft === "public"}
              onClick={() => {
                addressDirtyRef.current = true;
                setScenarioDraft("public");
              }}
            >
              {t("settings.remoteRelay.scenarioPublic")}
            </Button>
          </div>
          <input
            value={addressDraft}
            placeholder="192.168.1.10:3180"
            spellCheck={false}
            autoComplete="off"
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-ui-sm text-foreground outline-none focus:border-foreground-subtle"
            onChange={(event) => {
              addressDirtyRef.current = true;
              setAddressDraft(event.target.value);
            }}
            onBlur={() => void saveAddress()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </div>
      </div>

      {status == null ? null : status.configured ? (
        <div className="grid min-w-0 grid-cols-1 gap-2">
          <AccessLinkRow
            label={t("webRemoteControl.browser.lan")}
            url={lanShareUrl}
            unavailableHint={t("webRemoteControl.browser.lanUnavailable")}
            qrDataUrl={qrDataUrls.lan}
            copied={copied === "lan"}
            copyLabel={t("settings.remoteRelay.copy")}
            copiedLabel={t("settings.remoteRelay.copied")}
            onCopy={() => void handleCopy("lan", lanShareUrl ?? "")}
            qrAlt={t("webRemoteControl.browser.lan")}
          />
          <AccessLinkRow
            label={t("webRemoteControl.browser.public")}
            url={publicShareUrl}
            unavailableHint={t("webRemoteControl.browser.publicUnavailable")}
            qrDataUrl={qrDataUrls.public}
            copied={copied === "public"}
            copyLabel={t("settings.remoteRelay.copy")}
            copiedLabel={t("settings.remoteRelay.copied")}
            onCopy={() => void handleCopy("public", publicShareUrl ?? "")}
            qrAlt={t("webRemoteControl.browser.public")}
          />
        </div>
      ) : (
        // 未配置时明确交代「为什么没有链接」+「去哪里填」：只留一句灰字时用户会以为功能坏了
        // （实测反馈：「二维码和链接都不显示」）。
        <div className="flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-ui-sm leading-5 text-foreground-subtle">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 flex-1">{t("webRemoteControl.browser.notConfigured")}</span>
        </div>
      )}

      {/* 中继配置：原「设置 → 远程访问」的全部配置项都在这里，未配置时默认展开
          （用户打开弹层就是来填配置的）。保存成功后把新状态交回，链接与二维码立即刷新。 */}
      {status ? (
        <div className="mt-3">
          <RemoteRelayConfigForm
            status={status}
            onSaved={setStatus}
            defaultOpen={!status.configured}
          />
        </div>
      ) : null}
    </section>
  );
}
