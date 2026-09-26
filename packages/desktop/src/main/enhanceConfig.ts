// 提示词增强的用户级配置访问（zcode-patcher --enhance-btn 原生版）。
// 读取 ~/.zcode/v2 的 config.json / setting.json / credentials.json、个人渠道注册表
// provider_config.json 与可选手动渠道 ~/.zcode/enhance-config.json，并按补丁同款评分
// 挑选可用渠道。
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

/**
 * 个人渠道注册表（2026-09-26 bugfix，spec §6）：增强功能最初按补丁布局只扫
 * config.json 的 provider 表；架构迁移后自定义渠道的事实源是 provider-node 的
 * provider_config.json（config.providerConfigRules.providerRules[]），config.json
 * 只剩 builtin 覆盖——旧口径扫描永远得到 0 个渠道，菜单退化为
 * 「config.json 里没有启用的渠道」。这里把个人规则规范化成与 config.json provider
 * 同构的形态（name/kind/options/models），由 enhanceService 合并进列表与评分链路；
 * 同 id 冲突由调用方以本表覆盖 config.json（当前架构的渠道事实源）。
 */
export function loadPersonalProviders(): Record<string, JsonObject> {
  const raw = readJsonFile(join(userConfigDir(), "provider_config.json"));
  const rulesWrap = ((raw.config ?? {}) as JsonObject).providerConfigRules ?? {};
  const rules = (rulesWrap as JsonObject).providerRules;
  const providers: Record<string, JsonObject> = {};
  for (const rule of Array.isArray(rules) ? (rules as JsonObject[]) : []) {
    const providerId = asString(rule.providerId).trim();
    if (!providerId || rule.enabled === false) continue;
    const ruleConfig = (rule.config ?? {}) as JsonObject;
    const access = (ruleConfig.access ?? {}) as JsonObject;
    const api = (ruleConfig.api ?? {}) as JsonObject;
    // 增强链路只支持静态 api-key 凭据；oauth 型个人渠道拿不到可复用 token，跳过。
    const accessType = asString(access.type).trim();
    if (accessType && accessType !== "api-key") continue;
    const apiKey = asString(access.apiKey).trim();
    const baseUrl = asString(api.baseUrl).trim();
    if (!apiKey || !baseUrl) continue;
    const apiType = asString(api.type).trim();
    // 协议分支按 kind.includes("anthropic") 判定，api.type 原文可直接充当；
    // 菜单徽标只暴露归一后的 anthropic/openai 两类，避免露出内部协议串。
    const kind = apiType
      ? apiType.includes("anthropic")
        ? "anthropic"
        : "openai"
      : "anthropic";
    // modelOrder 首位即最高优先（channelModels 按 priority 降序取 Top3 增强）；
    // 只在 personalModelIds 出现、未进 order 的模型追加在尾部（priority 0）。
    const ordered = [...(Array.isArray(ruleConfig.modelOrder) ? ruleConfig.modelOrder : [])];
    for (const modelId of Array.isArray(ruleConfig.personalModelIds) ? ruleConfig.personalModelIds : []) {
      if (!ordered.includes(modelId)) ordered.push(modelId);
    }
    const models: JsonObject = {};
    ordered.forEach((entry, index) => {
      const modelId = asString(entry).trim();
      if (!modelId || models[modelId]) return;
      models[modelId] = { zcode: { priority: ordered.length - index } };
    });
    providers[providerId] = {
      name: asString(rule.providerName).trim() || providerId,
      kind,
      options: {
        apiKey,
        baseURL: baseUrl,
        ...(api.headers && typeof api.headers === "object" ? { headers: api.headers } : {}),
      },
      models,
    };
  }
  return providers;
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

/** 值是否把 id 作为冒号定界的完整段包含在内；不匹配段内子串，避免短 id 误命中。 */
function valueContainsSegment(value: string, id: string): boolean {
  return (
    value === id ||
    value.startsWith(`${id}:`) ||
    value.endsWith(`:${id}`) ||
    value.includes(`:${id}:`)
  );
}

/** 渠道选择：与补丁评分一致（有 apiKey +2 / baseURL +1 / 非内置 +1 / 当前选中 +10）。 */
export function resolveSelectedProviderId(cfg: JsonObject, st: JsonObject): string | null {
  const providers = (cfg.provider ?? {}) as Record<string, JsonObject | null>;
  const selectedKeys = (st.modelProviderFamilySelectedKeys ?? {}) as Record<string, unknown>;
  const values = Object.keys(selectedKeys).map((key) => String(selectedKeys[key] ?? ""));
  // 精确优先：值本身或逐段剥前缀的后缀命中（coding-plan:builtin:x → builtin:x → x）。
  for (const value of values) {
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
  // 嵌入兜底（bugfix）：team-plan:builtin:x:prod:proj 这类值把 provider id 嵌在
  // 中间，逐段剥前缀永远剥不到完整 id；按冒号定界的完整段包含匹配。
  for (const value of values) {
    for (const candidate of Object.keys(providers)) {
      if (candidate && valueContainsSegment(value, candidate)) return candidate;
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
