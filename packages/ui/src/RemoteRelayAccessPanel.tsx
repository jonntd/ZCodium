import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, LoaderCircle, Play, Square } from "lucide-react";
import type { RemoteRelayStatus } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 「浏览器直连」接入面板（spec vps-relay-bridge.md §15 / §18.6）。
 *
 * 从「设置 → 远程访问」搬到「移动端远程控制」弹层：那里才是用户找"用手机连上来"的地方，
 * 而设置页留给一次性配置。
 *
 * 边界：中继是**应用级**配置（全局一份，`~/.zcodium/v2/remote-relay.json`），与弹层所属
 * 的工作区无关——所以本面板只读状态 + 启停，不改配置；配置仍在设置页（保存即热应用）。
 *
 * 两条链接各给一个复制按钮 + 二维码（spec §18.6）：
 * - **内网**：手机与中继同一 WiFi 时用；中继配成 `127.0.0.1` 时这是唯一可达的地址。
 * - **公网**：手机在外网时用（端口映射 / DDNS / 反代，或中继本来就在 VPS）。
 * 不可用的一条**显示原因**，不硬拼一条连不上的地址出来。
 *
 * Web 环境没有中继 IPC（分区不渲染）——这里同样整块不渲染。
 */

const STATUS_POLL_INTERVAL_MS = 5_000;

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
    <div className="flex items-start gap-3 rounded-lg bg-surface px-3 py-3">
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
            <code className="block truncate rounded-md bg-background px-2 py-1 text-ui-sm text-foreground">
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

  const remoteRelayGetStatus = platform.remoteRelayGetStatus?.bind(platform);
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
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
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
    <section className="mt-4 rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="text-ui-base font-medium text-foreground">
            {t("webRemoteControl.browser.title")}
          </div>
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {t("webRemoteControl.browser.description")}
          </p>
        </div>
        <Button
          type="button"
          variant={status?.running ? "outline" : "default"}
          disabled={toggling}
          className="shrink-0 enabled:cursor-pointer"
          onClick={() => void handleToggleRun()}
        >
          {toggling ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : status?.running ? (
            <Square className="size-4" />
          ) : (
            <Play className="size-4" />
          )}
          {status?.running ? t("settings.remoteRelay.stop") : t("settings.remoteRelay.start")}
        </Button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-ui-sm text-foreground-subtle">
        <span>{statusText}</span>
        {status?.e2ee ? (
          <span className="rounded-md bg-surface px-2 py-0.5 text-ui-xs font-medium text-foreground-subtle">
            {t("settings.remoteRelay.badgeE2ee")}
          </span>
        ) : null}
      </div>

      {status?.configured ? (
        <div className="grid gap-2">
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
        <p className="text-ui-sm leading-5 text-foreground-subtle">
          {t("webRemoteControl.browser.notConfigured")}
        </p>
      )}
    </section>
  );
}
