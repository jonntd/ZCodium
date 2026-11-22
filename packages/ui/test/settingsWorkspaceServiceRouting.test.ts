import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function readSource(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

// 2026-11-22 re-baseline（settings-scope 设备分组 01c6656b 起）：
// - 各配置 section 的解析统一走 useConfigWorkspaceServicesResolution（别名
//   useWorkspaceServicesResolution）——同一路由契约的配置面特化（追加第 5 参 options：
//   unscopedServices/forceUnscoped，见 workspace-config-catalog/useConfigWorkspaceServices.ts），
//   原 `useWorkspaceServicesResolution` 前四参语义不变；
// - Subagent 设置从「固定本地服务」演进为「统一 Scope target 服务 + fail-closed」：
//   Scope target 与 useServices() 上下文可属不同远程 host，投影必须 target-scoped，
//   设备离线或 attachment 未就绪时暂停 RPC，不借用其他 Host 的服务。
describe("Settings target workspace service routing", () => {
  it("keeps Model Provider settings on the Local Environment", async () => {
    const source = await readSource("src/SettingsPage.tsx");

    expect(source).toContain("const localHostServices = useBaseWorkspaceServices();");
    expect(source).toContain("<ServiceProvider services={localHostServices}>");
    expect(source).toContain("localModelProviderConnectivityWorkspacePath");
    expect(source).toContain("connectivityWorkspaceRequired={isRemoteModelProviderWorkspace}");
    expect(source).not.toContain("modelProviderServiceResolution");

    const modelProviderStart = source.indexOf('activeSection === "modelProvider"');
    const modelProviderEnd = source.indexOf('activeSection === "memory"', modelProviderStart);
    const modelProviderSection = source.slice(modelProviderStart, modelProviderEnd);
    expect(modelProviderSection).not.toContain("workspaceIdentity={activeWorkspaceIdentity}");
  });

  it("does not expose remote Provider settings or a manual sync action", async () => {
    const source = await readSource("src/settings/ModelProviderSection.tsx");

    expect(source).not.toContain("remoteProviderProvisioningService");
    expect(source).not.toContain("syncLocalToRemote");
    expect(source).not.toContain("remoteProvisioningSupported");
    expect(source).not.toContain("syncRemoteConfirmDescription");
  });

  it("routes Plugin management through the selected workspace services", async () => {
    const source = await readSource("src/settings/PluginsSection.tsx");

    expect(source).toContain(
      "useConfigWorkspaceServicesResolution as useWorkspaceServicesResolution",
    );
    expect(source).toMatch(
      /useWorkspaceServicesResolution\(\s*target\?\.workspacePath,\s*target\?\.remoteSessionId,\s*target\?\.workspaceIdentity,\s*target\?\.remoteTarget,\s*\{/,
    );
    expect(source).toContain(
      "const { pluginManagementService } = targetServiceResolution.services;",
    );
    expect(source).toContain("if (!target || !targetServiceResolution.rpcReady) return;");
    expect(source).toMatch(
      /selectedPlugin &&\s*selectedStoreItem &&\s*targetServiceResolution\.rpcReady/,
    );
    expect(source).toMatch(
      /!targetServiceResolution\.rpcReady\s*\?\s*\(\s*<PluginLoadingState[\s\S]*?id: "common\.connecting"/,
    );
  });

  it("routes Hooks through the selected workspace services", async () => {
    const source = await readSource("src/settings/HooksSection.tsx");

    expect(source).toContain(
      "useConfigWorkspaceServicesResolution as useWorkspaceServicesResolution",
    );
    expect(source).toMatch(
      /useWorkspaceServicesResolution\(\s*targetWorkspacePath,\s*selectedWorkspace\?\.remoteSessionId,\s*targetWorkspaceIdentity,\s*selectedWorkspace\?\.remoteTarget,\s*\{/,
    );
    // target 解析结果经 useMemo 包装出 hooksService（scope 选中远程 workspace 时 context
    // 服务指向激活 host，连接未就绪或 fallback 时不允许把写路径发错 host）。
    expect(source).toMatch(
      /const \{ hooksService: targetHooksService, pluginManagementService \}\s*=\s*\n?\s*targetServiceResolution\.services;/,
    );
    expect(source).toContain("const hooksService = useMemo<IHooksService>");
    expect(source).toContain("if (!targetServiceResolution.rpcReady) return;");
    expect(source).toMatch(
      /!targetServiceResolution\.rpcReady\s*\?\s*\(\s*<PluginLoadingState[\s\S]*?id: "common\.connecting"/,
    );
  });

  it("routes Subagent settings through the Scope target services (fail-closed)", async () => {
    const source = await readSource("src/settings/SubagentsSection.tsx");

    expect(source).toContain(
      "useConfigWorkspaceServicesResolution as useWorkspaceServicesResolution",
    );
    expect(source).toMatch(
      /useWorkspaceServicesResolution\(\s*targetWorkspacePath,\s*selectedWorkspace\?\.remoteSessionId,\s*targetWorkspaceIdentity,\s*selectedWorkspace\?\.remoteTarget,\s*\{/,
    );
    // Scope target 与 useServices() 上下文可属不同远程 host：子代理/插件投影统一
    // target-scoped，设备离线或 attachment 未就绪时 fail-closed 暂停 RPC。
    expect(source).toContain("const targetServiceResolution = scopeBlocked");
    expect(source).toContain(
      "const { pluginManagementService, subagentsService } = targetServiceResolution.services;",
    );
    // Provider/Model 事实属于目标 Environment：模型视图读 Scope target 自己的
    // Registry 视图，等待远端连接期间不能回退到 Base Host 的模型列表。
    expect(source).toContain("targetServiceResolution.services.modelSelectionService");
    expect(source).toContain("targetServiceResolution.rpcReady");
  });

  it("routes Skills through the target passed by PluginsSection", async () => {
    const source = await readSource("src/settings/SkillsSection.tsx");

    expect(source).toContain(
      "useConfigWorkspaceServicesResolution as useWorkspaceServicesResolution",
    );
    expect(source).toMatch(
      /useWorkspaceServicesResolution\(\s*activeWorkspacePath,\s*remoteSessionId,\s*activeWorkspaceIdentity,\s*remoteTarget,\s*\{/,
    );
    expect(source).toMatch(
      /const \{ pluginManagementService, skillsService \}\s*=\s*targetServiceResolution\.services;/,
    );
    expect(source).toContain("if (!targetServiceResolution.rpcReady) return;");
    expect(source).toContain("open={importDialogOpen && targetServiceResolution.rpcReady}");
    // skill-sync 独立对话框已随 settings-scope 演进合并进 SkillsImportDialog
    // （settingsSyncService 由 target 解析结果注入，见「target-scoped settings sync」用例）。
    expect(source).toMatch(
      /!targetServiceResolution\.rpcReady\s*\?\s*\(\s*<PluginLoadingState[\s\S]*?id: "common\.connecting"/,
    );
    expect(source).toContain("projectionMatchesTarget");
    expect(source).toMatch(/loading \|\| !projectionMatchesTarget/);
  });

  it("routes Commands list reads and writes through the selected workspace services", async () => {
    const source = await readSource("src/settings/CommandsSection.tsx");

    expect(source).not.toContain('useServices.js"');
    expect(source).toMatch(
      /useWorkspaceServicesResolution\(\s*currentWorkspaceTab\?\.workspacePath \?\? workspacePath,\s*currentWorkspaceTab\?\.remoteSessionId,\s*currentWorkspaceTab\?\.workspaceIdentity \?\? workspaceIdentity,\s*currentWorkspaceTab\?\.remoteTarget,\s*\{/,
    );
    expect(source).toMatch(
      /const \{ commandsService, pluginManagementService, settingsSyncService \}\s*=\s*listServiceResolution\.services;/,
    );
    // 导入入口的 service 必须与列表 target 同源，且连接未就绪时不允许打开对话框。
    expect(source).toMatch(
      /<CommandsImportDialog\s*open=\{importDialogOpen && listServiceResolution\.rpcReady\}[\s\S]*?settingsSyncService=\{settingsSyncService\}/,
    );
    // 命令列表读写与插件投影都必须拿到 target service，并在连接就绪前暂停 RPC。
    expect(source).toMatch(
      /useCommands\(\{[\s\S]*?commandsService,\s*enabled: listServiceResolution\.rpcReady,\s*\}\)/,
    );
    expect(source).toContain("if (!workspacePath || !listServiceResolution.rpcReady) return;");
    expect(source).toMatch(
      /!listServiceResolution\.rpcReady\s*\?\s*\(\s*<PluginLoadingState[\s\S]*?id: "common\.connecting"/,
    );
  });

  it("requires callers to inject a target-scoped settings sync service into the import dialog", async () => {
    const dialog = await readSource("src/settings/ExternalAgentImportDialog.tsx");

    // Bug 原因：detect/importSelected 携带调用方传入的 target 路径，而 service 曾取自
    // useServices()，跨 host 时会在激活 host 上按另一个 workspace 的路径做 symlink/copy 落盘。
    expect(dialog).not.toContain('useServices.js"');
    expect(dialog).toMatch(/settingsSyncService: ISettingsSyncService;/);

    // 三个 Scope 感知入口都必须注入自己 target 的 service，并在连接未就绪时不开对话框。
    const skills = await readSource("src/settings/SkillsSection.tsx");
    expect(skills).toContain(
      "settingsSyncService={targetServiceResolution.services.settingsSyncService}",
    );
    const mcp = await readSource("src/settings/McpSettingsSection.tsx");
    expect(mcp).toContain("settingsSyncService={services.settingsSyncService}");
    expect(mcp).toContain("PluginLoadingState");
    // 加载门已演进为二分支：配置加载失败先给显式失败态（替代无限 loading），未失败
    // 才落 PluginLoadingState——门本身仍是 !mcpProjectionReady。
    expect(mcp).toMatch(/!mcpProjectionReady\s*\?/);
    expect(mcp).toMatch(/<PluginLoadingState label=\{intl\.formatMessage\(\{ id: "common\.loading" \}\)\s*\}/);
    expect(mcp).toContain("open={importDialogOpen && mcpStoreMatchesActiveWorkspace}");
  });

  it("requires callers to inject a target-scoped commands service", async () => {
    const source = await readSource("src/hooks/useCommands.ts");

    // Bug 原因：service 隐式取自 useServices() 时，Scope 选中的远程 workspace 路径会被
    // 发往当前激活 host。必传参数让错误路由在类型层面就无法通过。
    expect(source).not.toContain('useServices.js"');
    expect(source).toMatch(/commandsService: ICommandsService;/);
    expect(source).toContain("export function useCommands(options: UseCommandsOptions)");
  });
});
