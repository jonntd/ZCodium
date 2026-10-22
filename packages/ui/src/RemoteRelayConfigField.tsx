import { useCallback, useState, type ChangeEvent } from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input.js";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group.js";
import { Label } from "@/components/ui/label.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 中继配置表单的单字段（label + 说明 + 输入框），从 `RemoteRelayConfigForm` 抽出：
 * 主文件已逼近 `max-lines: 400` 上限，而密钥字段需要额外的交互（显示切换 / 复制）。
 *
 * `secret` / `copyable` 是为密钥类字段加的（主机密钥、配对码、E2EE channelKey）：
 * 这些值的用途就是**抄到别处**（relay `.env` 的 `HOST_SECRET` / `RELAY_TOKEN`，或另一台
 * 设备的表单），40+ 字符手选复制不现实；主机密钥此前只有 password 掩码、既看不见也复制
 * 不了，等于把「与 relay 对齐」做成了不可操作。
 */
export function ConfigField({
  id,
  label,
  description,
  placeholder,
  type = "text",
  value,
  onChange,
  secret = false,
  copyable = false,
}: {
  id: string;
  label: string;
  description?: string;
  placeholder?: string;
  type?: "text" | "password";
  value: string;
  onChange: (value: string) => void;
  /** 敏感值：默认掩码显示，右侧给「显示 / 隐藏」切换。 */
  secret?: boolean;
  /** 右侧给「复制」按钮。 */
  copyable?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch (error) {
      // 剪贴板不可用（权限/非安全上下文）时不影响手动选择，只记一条诊断。
      console.warn("[remote-relay] copy failed", error);
    }
  }, [value]);

  const inputType = secret ? (revealed ? "text" : "password") : type;
  const inputProps = {
    id,
    value,
    placeholder,
    autoComplete: "off",
    spellCheck: false,
    onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
  };

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-ui-base font-medium text-foreground">
        {label}
      </Label>
      {description ? (
        <div className="text-ui-sm leading-5 text-foreground-subtle">{description}</div>
      ) : null}
      {secret || copyable ? (
        <InputGroup>
          <InputGroupInput {...inputProps} type={inputType} />
          <InputGroupAddon align="inline-end">
            {secret ? (
              <InputGroupButton
                size="icon-xs"
                aria-label={intl.formatMessage({
                  id: revealed
                    ? "settings.remoteRelay.hideSecret"
                    : "settings.remoteRelay.revealSecret",
                })}
                onClick={() => setRevealed((previous) => !previous)}
              >
                {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </InputGroupButton>
            ) : null}
            {copyable ? (
              <InputGroupButton
                size="icon-xs"
                aria-label={intl.formatMessage({ id: "settings.remoteRelay.copyValue" })}
                onClick={() => void handleCopy()}
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </InputGroupButton>
            ) : null}
          </InputGroupAddon>
        </InputGroup>
      ) : (
        <Input {...inputProps} type={type} />
      )}
    </div>
  );
}
