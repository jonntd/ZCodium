// 请求头模拟预设（1:1 移植自 zcode-patcher --modelhub 的 __mhHeaders 面板）。
// 两个官方客户端指纹预设；shared 计数 ≥2 的键（user-agent/accept）在切换预设时
// 不从渠道里清除，其余键切换即替换。session_id 为 auto 键：每次启用重新生成 uuid。

export interface ModelhubHeaderPreset {
  key: string;
  value: string;
  /** auto 键的值是动态生成的（如 uuid），每次启用重置。 */
  auto?: "uuid";
}

export const MODELHUB_HEADER_PRESETS: Record<"claude" | "codex", ModelhubHeaderPreset[]> = {
  claude: [
    { key: "user-agent", value: "claude-cli/2.1.6 (external, cli)" },
    { key: "x-app", value: "cli" },
    { key: "anthropic-version", value: "2023-06-01" },
    {
      key: "anthropic-beta",
      value:
        "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
    },
    { key: "accept", value: "application/json" },
    { key: "x-stainless-lang", value: "js" },
    { key: "x-stainless-runtime", value: "node" },
    { key: "x-stainless-runtime-version", value: "v24.13.0" },
    { key: "x-stainless-os", value: "Windows" },
    { key: "x-stainless-arch", value: "x64" },
    { key: "x-stainless-package-version", value: "0.60.0" },
    { key: "x-stainless-retry-count", value: "0" },
    { key: "x-stainless-timeout", value: "600000" },
  ],
  codex: [
    { key: "user-agent", value: "codex_cli_rs/0.42.0 (Windows 11.0.26100; x86_64) unknown" },
    { key: "OpenAI-Beta", value: "responses=experimental" },
    { key: "originator", value: "codex_cli_rs" },
    { key: "session_id", value: "", auto: "uuid" },
    { key: "accept", value: "text/event-stream" },
    { key: "version", value: "0.42.0" },
  ],
};

/** 在两个预设中都出现的键（切换预设时保留渠道里的现值，不当作另一预设的残留清除）。 */
export function sharedPresetKeys(): Set<string> {
  const counts = new Map<string, number>();
  for (const rows of Object.values(MODELHUB_HEADER_PRESETS)) {
    for (const row of rows) counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
}

export function generateHeaderUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.trunc(Math.random() * 16);
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}
