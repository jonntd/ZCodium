// 提示词增强的用户级配置访问（zcode-patcher --enhance-btn 原生版）。
// 读取 ~/.zcode/v2 的 config.json / setting.json / credentials.json 与可选手动渠道
// ~/.zcode/enhance-config.json，并按补丁同款评分挑选可用渠道。
import { createDecipheriv, createHash } from "node:crypto";
import { platform as osPlatform, homedir, userInfo } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export interface JsonObject {
  [key: string]: unknown;
}

function readJsonFile(path: string): JsonObject {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
  } catch {
    return {};
  }
}

function userConfigDir(): string {
  // 与 services/settingService 一致：打包环境允许 ZCODE_DESKTOP_HOME_DIR 重定向家目录。
  const home = process.env.ZCODE_DESKTOP_HOME_DIR?.trim() || homedir();
  return join(home, ".zcode", "v2");
}

interface EnhanceConfigBundle {
  cfg: JsonObject;
  st: JsonObject;
  credRaw: JsonObject;
  manualCfg: JsonObject;
}

export function loadConfigBundle(): EnhanceConfigBundle {
  const dir = userConfigDir();
  return {
    cfg: readJsonFile(join(dir, "config.json")),
    st: readJsonFile(join(dir, "setting.json")),
    credRaw: readJsonFile(join(dir, "credentials.json")),
    // 可选手动渠道：~/.zcode/enhance-config.json（baseURL/apiKey/model/kind/headers）
    manualCfg: readJsonFile(join(homedir(), ".zcode", "enhance-config.json")),
  };
}

/** 解密 enc:v1: 前缀的凭据（aes-256-gcm，密钥=fallback secret 的 sha256），与
 *  services/credentialCipherProvider 同构；失败返回空串让渠道评分自然跳过。 */
function decryptCredential(value: string): string {
  if (typeof value !== "string" || !value.startsWith("enc:v1:")) return value;
  try {
    const parts = value.slice(7).split(".");
    let secret = process.env.ZCODE_CREDENTIAL_SECRET;
    if (!secret) {
      let username = "unknown";
      try {
        username = userInfo().username;
      } catch {
        /* 家目录不可读时退回 unknown */
      }
      secret = `zcode-credential-fallback:${osPlatform()}:${homedir()}:${username}`;
    }
    const key = createHash("sha256").update(secret).digest();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0]!, "base64url"));
    decipher.setAuthTag(Buffer.from(parts[1]!, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[2]!, "base64url")),
      decipher.final(),
    ]).toString("utf-8");
  } catch {
    return "";
  }
}

function decryptCredentials(credRaw: JsonObject): Record<string, string> {
  const cred: Record<string, string> = {};
  for (const key of Object.keys(credRaw)) {
    cred[key] = decryptCredential(credRaw[key] as string);
  }
  return cred;
}

/** 渠道选择：与补丁评分一致（有 apiKey +2 / baseURL +1 / 非内置 +1 / 当前选中 +10）。 */
export function resolveSelectedProviderId(cfg: JsonObject, st: JsonObject): string | null {
  const providers = (cfg.provider ?? {}) as Record<string, JsonObject | null>;
  const selectedKeys = (st.modelProviderFamilySelectedKeys ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(selectedKeys)) {
    const value = String(selectedKeys[key] ?? "");
    const candidates = [value];
    let rest = value;
    while (rest.includes(":")) {
      rest = rest.slice(rest.indexOf(":") + 1);
      candidates.push(rest);
    }
    for (const candidate of candidates) {
      if (providers[candidate]) return candidate;
    }
  }
  return null;
}

export interface ScoredChannel {
  id: string;
  provider: JsonObject;
  options: JsonObject;
  score: number;
  forcedModel?: string;
}

export function scoreChannels(
  cfg: JsonObject,
  st: JsonObject,
  credRaw: JsonObject,
): { oauthTokens: [string, string][]; active: string; scored: ScoredChannel[] } {
  const providers = (cfg.provider ?? {}) as Record<string, JsonObject | null>;
  const decrypted = decryptCredentials(credRaw);
  const oauthTokens = Object.entries(decrypted).filter(
    ([key]) => key.startsWith("oauth:") && key.endsWith(":access_token"),
  ) as [string, string][];
  const active = decrypted["oauth:active_provider"] ?? "";
  const selectedId = resolveSelectedProviderId(cfg, st);
  const scored = Object.keys(providers)
    .filter(
      (id) =>
        providers[id] && providers[id]!.enabled !== false && !String(id).startsWith("builtin:"),
    )
    .map((id) => {
      const provider = providers[id]!;
      const options = (provider.options ?? {}) as JsonObject;
      let score = 0;
      if (String(options.apiKey ?? "").trim()) score += 2;
      if (String(options.baseURL ?? "").trim()) score += 1;
      if (!String(id).startsWith("builtin:")) score += 1;
      if (id === selectedId) score += 10;
      return { id, provider, options, score };
    })
    .sort((a, b) => b.score - a.score);
  return { oauthTokens, active, scored };
}

export function channelModels(provider: JsonObject): { id: string; priority: number }[] {
  const models = (provider.models ?? {}) as Record<string, JsonObject | null>;
  return Object.keys(models)
    .map((id) => ({
      id,
      priority: ((models[id]?.zcode as JsonObject | undefined)?.priority as number) ?? 0,
    }))
    .sort((a, b) => b.priority - a.priority);
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
