export interface PluginMarketplaceSummary {
  id: string;
  name: string;
  source: string;
  installLocation?: string;
  lastUpdated?: string;
  pluginCount: number;
  description?: string;
  isOfficial: boolean;
}

export type PluginComponentType = "agent" | "command" | "skill" | "hook" | "mcp" | "lsp";

export type PluginScope = "workspace" | "user";

export interface PluginHookDetail {
  args?: string[];
  async?: boolean;
  command: string;
  event: string;
  matcher?: string;
  runnable: boolean;
  shell?: true | string;
  sourcePath: string;
  statusMessage?: string;
  timeout?: number;
  timeoutMs?: number;
  type: "command" | "process";
}

export interface AvailablePluginSummary {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  installed: boolean;
  componentTypes?: PluginComponentType[];
  /** 仅官方市场条目携带：bundled=本地内置 seed，cdn=官方 CDN 目录（含历史缓存）。 */
  officialSource?: "bundled" | "cdn";
}

export interface InstalledPluginSummary {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  enabled: boolean;
  scope: PluginScope;
  installPath?: string;
  nativeScope?: "user" | "project" | "local";
  projectPath?: string;
  installedAt?: string;
  componentTypes?: PluginComponentType[];
  hookDetails?: PluginHookDetail[];
}

export interface PluginsCapability {
  supported: boolean;
  reason?: "desktop_only" | "missing_cli";
}

export interface PluginsOverviewResult {
  marketplaces: PluginMarketplaceSummary[];
  availablePlugins: AvailablePluginSummary[];
  installedPlugins: InstalledPluginSummary[];
  capability: PluginsCapability;
}
