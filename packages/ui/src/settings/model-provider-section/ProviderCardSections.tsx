/* eslint-disable max-lines -- 模型供应商卡片仍在迁移期集中维护多个紧耦合区块，后续拆分时再移除。 */
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type ReactNode,
} from "react";
import type {
  ProviderSettingsFormProvider,
  ProviderSettingsFormModel,
} from "@/lib/providerSettingsFormTypes.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import type { ProviderApiType } from "@zcode/provider";
import {
  TID_MODEL_PROVIDER_ADD_MODEL_BUTTON,
  TID_MODEL_PROVIDER_BASE_URL_INPUT,
  TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON,
  TID_MODEL_PROVIDER_MODEL_INPUT,
  TID_MODEL_PROVIDER_NAME_EDIT_BUTTON,
  TID_MODEL_PROVIDER_NAME_INPUT,
  testId,
} from "@zcode/shared";
import { InfoIcon, LockKeyholeIcon, Plus, Pencil, Trash2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { toast } from "@/components/ui/toast.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { ApiKeyInput } from "./ApiKeyInput.js";
import { ModelRowInput } from "./ProviderFormControls.js";
import { PresetProviderApiKeyBanner } from "./PresetProviderApiKeyBanner.js";
import { ModelhubModelPickerDialog } from "./ModelhubModelPickerDialog.js";
import { ModelhubHeadersDialog } from "./ModelhubHeadersDialog.js";
import { readDeletedModelIds } from "./modelhubTombstones.js";
import { type ProviderModelDraftValues } from "@/settings/model-provider-section/ProviderModelMetadata.js";
import { ProviderModelMetadataDialog } from "@/settings/model-provider-section/ProviderModelMetadataDialog.js";
import {
  ProviderApiFormatSelect,
  resolveProviderConnectionApiFormatDisplayLabel,
} from "@/settings/model-provider-section/ProviderApiFormatSelect.js";
import { SortableProviderModelList } from "@/settings/model-provider-section/SortableProviderModelList.js";
import { useProviderModelDraft } from "@/settings/model-provider-section/useProviderModelDraft.js";
import { ProviderLogo } from "@/settings/model-provider-section/ProviderLogo.js";
import type { ProviderConfigObject } from "@zcode/provider";

export { formatModelContextWindowLabel } from "@/lib/tokenNumberFormat.js";
export {
  resolveProviderConnectionApiFormatDisplayLabel,
  resolveProviderConnectionApiFormatOptions,
} from "@/settings/model-provider-section/ProviderApiFormatSelect.js";

function shouldShowProviderApiFormat(
  _provider: Pick<ProviderSettingsFormProvider, "providerId">,
): boolean {
  return true;
}

export function ProviderCardHeader({
  providerName,
  logo,
  editingName,
  nameValue,
  nameInputRef,
  nameEditable = true,
  onNameChange,
  onNameBlur,
  onNameKeyDown,
  onNameCompositionEnd,
  onNameCompositionStart,
  onStartEditName,
  onDelete,
  actionsVisible = true,
  providerToggle,
}: {
  providerName: string;
  logo?: ProviderConfigObject["logo"];
  editingName: boolean;
  nameValue: string;
  nameInputRef: RefObject<HTMLInputElement | null>;
  nameEditable?: boolean;
  onNameChange: (value: string) => void;
  onNameBlur: () => void;
  onNameKeyDown: (event: ReactKeyboardEvent) => void;
  onNameCompositionEnd?: () => void;
  onNameCompositionStart?: () => void;
  onStartEditName: () => void;
  onDelete?: () => void;
  actionsVisible?: boolean;
  providerToggle?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const renameRequestedRef = useRef(false);
  const secondaryActionsVisible = actionsVisible && (nameEditable || Boolean(onDelete));

  return (
    <div className="flex items-center justify-between gap-3" data-testid="model-provider-header">
      <div className="flex min-w-0 items-center gap-2">
        <ProviderLogo logo={logo} className="size-5" />
        {editingName ? (
          <Input
            {...TECHNICAL_INPUT_ATTRIBUTES}
            ref={nameInputRef}
            data-testid={TID_MODEL_PROVIDER_NAME_INPUT}
            type="text"
            size="lg"
            className="w-auto min-w-0 text-ui-lg font-semibold"
            value={nameValue}
            onChange={(event) => onNameChange(event.target.value)}
            onCompositionEnd={onNameCompositionEnd}
            onCompositionStart={onNameCompositionStart}
            onBlur={onNameBlur}
            onKeyDown={onNameKeyDown}
          />
        ) : (
          <>
            <div className="min-w-0 truncate text-ui-lg font-semibold text-foreground">
              {providerName}
            </div>
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {providerToggle}
        {secondaryActionsVisible ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="model-provider-actions-button"
                aria-label={intl.formatMessage({ id: "common.more" })}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                // 重命名后的焦点交给输入框，不能被菜单关闭时重新抢回触发按钮。
                if (renameRequestedRef.current) {
                  event.preventDefault();
                  renameRequestedRef.current = false;
                }
              }}
            >
              {nameEditable ? (
                <DropdownMenuItem
                  data-testid={TID_MODEL_PROVIDER_NAME_EDIT_BUTTON}
                  onSelect={() => {
                    renameRequestedRef.current = true;
                    onStartEditName();
                  }}
                >
                  <Pencil className="size-3.5" />
                  {intl.formatMessage({ id: "settings.modelProvider.renameProvider" })}
                </DropdownMenuItem>
              ) : null}
              {nameEditable && onDelete ? <DropdownMenuSeparator /> : null}
              {onDelete ? (
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 className="size-3.5" />
                  {intl.formatMessage({ id: "common.delete" })}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

export function ProviderConnectionSection({
  provider,
  readOnly,
  apiFormat,
  baseUrlValue,
  onApiFormatChange,
  onBaseUrlChange,
  onBaseUrlBlur,
  onBaseUrlKeyDown,
  onBaseUrlCompositionStart,
  onBaseUrlCompositionEnd,
}: {
  provider: ProviderSettingsFormProvider;
  readOnly?: boolean;
  apiFormat: ProviderApiType;
  baseUrlValue: string;
  onApiFormatChange: (value: ProviderApiType) => void;
  onBaseUrlChange: (value: string) => void;
  onBaseUrlBlur: () => void;
  onBaseUrlKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onBaseUrlCompositionStart?: () => void;
  onBaseUrlCompositionEnd?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const showApiFormat = shouldShowProviderApiFormat(provider);
  const readOnlyBaseUrl = provider.config.api?.baseUrl ?? "";
  const resolvedApiFormat = provider.config.api?.type ?? "anthropic-messages";

  const renderReadOnlyField = (label: string, value: string) => (
    <div>
      <label className="mb-1 block text-ui-base text-foreground-subtle">{label}</label>
      <div className="flex min-h-8 items-center gap-2 rounded-lg border border-input-border bg-input px-3 py-1.5 text-ui-base text-foreground">
        <span className="min-w-0 flex-1 break-all">{value || "-"}</span>
        <span
          role="img"
          aria-label={intl.formatMessage(
            { id: "settings.modelProvider.readOnlyField" },
            { field: label },
          )}
          className="shrink-0 text-foreground-subtle"
        >
          <LockKeyholeIcon className="size-3.5" aria-hidden="true" />
        </span>
      </div>
    </div>
  );

  if (readOnly) {
    return (
      <>
        {renderReadOnlyField(
          intl.formatMessage({ id: "settings.modelProvider.baseUrl" }),
          readOnlyBaseUrl,
        )}
        {showApiFormat
          ? renderReadOnlyField(
              intl.formatMessage({ id: "settings.modelProvider.apiFormat" }),
              resolveProviderConnectionApiFormatDisplayLabel(intl, resolvedApiFormat),
            )
          : null}
      </>
    );
  }

  return (
    <>
      <div>
        <label className="mb-1 block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.baseUrl" })}
        </label>
        <Input
          {...TECHNICAL_INPUT_ATTRIBUTES}
          type="text"
          size="lg"
          data-testid={TID_MODEL_PROVIDER_BASE_URL_INPUT}
          value={baseUrlValue}
          placeholder={intl.formatMessage({
            id: "settings.modelProvider.baseUrlPlaceholder",
          })}
          onChange={(event) => onBaseUrlChange(event.target.value)}
          onBlur={onBaseUrlBlur}
          onKeyDown={onBaseUrlKeyDown}
          onCompositionStart={onBaseUrlCompositionStart}
          onCompositionEnd={onBaseUrlCompositionEnd}
        />
      </div>
      {showApiFormat ? (
        <div>
          <label className="mb-1 block text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.apiFormat" })}
          </label>
          <ProviderApiFormatSelect value={apiFormat} onChange={onApiFormatChange} />
        </div>
      ) : null}
    </>
  );
}

export function ProviderApiKeySection({
  apiKeyValue,
  apiKeyVisible,
  readOnly,
  presetApiKeyUrl,
  onOpenPresetApiKey,
  onApiKeyChange,
  onApiKeyBlur,
  onApiKeyKeyDown,
  onApiKeyCompositionStart,
  onApiKeyCompositionEnd,
  onToggleApiKeyVisibility,
}: {
  apiKeyValue: string;
  apiKeyVisible: boolean;
  readOnly?: boolean;
  presetApiKeyUrl?: string;
  onOpenPresetApiKey?: () => void;
  onApiKeyChange: (value: string) => void;
  onApiKeyBlur: () => void;
  onApiKeyKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onApiKeyCompositionStart?: () => void;
  onApiKeyCompositionEnd?: () => void;
  onToggleApiKeyVisibility: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.apiKey" })}
        </label>
        {presetApiKeyUrl && onOpenPresetApiKey ? (
          <PresetProviderApiKeyBanner onOpenApiKey={onOpenPresetApiKey} />
        ) : null}
      </div>
      <ApiKeyInput
        value={apiKeyValue}
        visible={apiKeyVisible}
        readOnly={readOnly}
        onChange={onApiKeyChange}
        onBlur={onApiKeyBlur}
        onKeyDown={onApiKeyKeyDown}
        onCompositionStart={onApiKeyCompositionStart}
        onCompositionEnd={onApiKeyCompositionEnd}
        onToggleVisibility={onToggleApiKeyVisibility}
      />
    </div>
  );
}

function createEmptyModel(): ProviderSettingsFormModel {
  return {
    kind: "candidate",
    modelId: "",
    builtin: false,
    personalConfig: {},
    // 空 ID 尚未解析模型配置，硬编码档位会被误认为智能推荐。
    config: {
      properties: { supportsToolCall: true },
    },
    hasPersonalConfig: false,
    executable: false,
    selectable: false,
  };
}

export function ProviderModelsSection({
  providerId,
  providerName,
  providerEnabled = true,
  providerAccess,
  models,
  onTestModel,
  onModelCommit,
  onModelEnabledChange,
  onDeleteModel,
  onAddModel,
  onReorderModelIds,
  settingsRevision = 0,
  modelhubEndpoint,
  providerHeaders,
  onSaveProviderHeaders,
}: {
  providerId: string;
  providerName?: string;
  providerEnabled?: boolean;
  providerAccess?: ProviderConfigObject["access"];
  models: ProviderSettingsFormModel[];
  onTestModel?: (model: string) => Promise<ModelConnectivityResult>;
  onModelCommit: (
    originalModelId: string,
    model: ProviderSettingsFormModel,
    basedOnRevision: number,
  ) => void | Promise<void>;
  onDeleteModel: (modelId: string) => void;
  onModelEnabledChange?: (modelId: string, enabled: boolean) => void | Promise<void>;
  onAddModel: (model: ProviderSettingsFormModel) => void | Promise<void>;
  onReorderModelIds?: (modelIds: string[]) => void;
  settingsRevision?: number;
  /** 拉取模型（modelhub）用的渠道连接事实；缺省或无 baseUrl 时隐藏拉取入口。 */
  modelhubEndpoint?: { apiType: string; baseUrl: string; apiKey: string } | null;
  /** 渠道当前生效的请求头（api.headers）；配合 onSaveProviderHeaders 提供请求头模拟。 */
  providerHeaders?: Record<string, string> | null;
  onSaveProviderHeaders?: (headers: Record<string, string>) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const { providerSettingsService } = useServices();
  const platform = useOptionalPlatform();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const addSavingRef = useRef(false);
  const [addCommitError, setAddCommitError] = useState<string | null>(null);
  const [addModel] = useState(createEmptyModel);
  const [addDraftErrorField, setAddDraftErrorField] = useState<
    | "id"
    | "contextWindow"
    | "maxOutputTokens"
    | "inputFormat"
    | "reasoningLevelValues"
    | "reasoningLevelMap"
    | null
  >(null);
  const resolveAddModelConfig = useCallback(
    (modelId: string) => providerSettingsService.resolveModelConfig({ providerId, modelId }),
    [providerId, providerSettingsService],
  );
  const editor = useProviderModelDraft({
    model: addModel,
    open: addDialogOpen,
    scopeKey: providerId,
    resolve: resolveAddModelConfig,
  });
  const { draft: addDraft } = editor;

  const openAddDialog = useCallback(() => {
    editor.reset(createEmptyModel());
    setAddDraftErrorField(null);
    setAddCommitError(null);
    setAddDialogOpen(true);
  }, [editor.reset]);

  const updateAddDraft = (patch: Partial<ProviderModelDraftValues>) => {
    editor.change(patch);
    setAddDraftErrorField(null);
  };

  const cancelAddDialog = () => {
    setAddDialogOpen(false);
    editor.reset(createEmptyModel());
    setAddDraftErrorField(null);
    editor.cancel();
  };

  const handleAddDialogOpenChange = useCallback(
    (open: boolean) => {
      // 保存中的关闭/再打开会让旧请求结束掉新草稿，等待本次提交完成再结束编辑。
      if (addSavingRef.current) return;
      if (!open) {
        cancelAddDialog();
        return;
      }
      setAddDialogOpen(true);
    },
    [cancelAddDialog],
  );

  const commitAddDraft = useCallback(async (): Promise<boolean> => {
    if (addSavingRef.current) return false;
    addSavingRef.current = true;
    setAddSaving(true);
    setAddCommitError(null);
    try {
      const result = await editor.commit();
      if (result.status === "invalid") {
        setAddDraftErrorField(result.field);
        return false;
      }
      // 过去只发起异步添加就关闭弹窗，失败后输入也丢了；以实际保存完成作为结束边界。
      await onAddModel(result.model);
      setAddDialogOpen(false);
      editor.reset(createEmptyModel());
      return true;
    } catch (error) {
      setAddCommitError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      addSavingRef.current = false;
      setAddSaving(false);
    }
  }, [editor, onAddModel]);
  const addDraftErrorMessage = addDraftErrorField
    ? intl.formatMessage({
        id: `settings.modelProvider.modelMetadata.invalid.${addDraftErrorField}`,
      })
    : null;

  // ── 拉取模型（zcode-patcher --modelhub 原生版）──
  // main 进程拉取 /models → 选择器勾选（可视觉探测）→ 走与「添加模型」一致的
  // onAddModel 通路逐个落库（useRecommendedConfig=true，推荐配置由服务端解析）。
  const [headersDialogOpen, setHeadersDialogOpen] = useState(false);
  // 删除墓碑：本会话内删除的模型在拉取选择器中标「已删除」并禁止重添。
  // 每次读取现读 localStorage（bugfix：曾用 useState 初值只读一次，墓碑由
  // InlineEditableProviderCard 的删除回调写入，同一卡片挂载期间删除的模型在
  // 随后的拉取选择器里仍可作为新模型勾选）。依赖 models——增删模型都会改变
  // models 引用，触发重读；key=providerId 保证换供应商时重挂载重读。
  const deletedIds = useMemo(() => readDeletedModelIds(providerId), [providerId, models]);
  const [fetchDialogOpen, setFetchDialogOpen] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<{ id: string; visionGuess: boolean }[] | null>(
    null,
  );
  const [fetching, setFetching] = useState(false);
  const modelhubAvailable = platform?.modelhubFetchModels != null;
  const modelhubUsable =
    modelhubAvailable && modelhubEndpoint != null && modelhubEndpoint.baseUrl.trim().length > 0;

  const resolveModelhubDialect = useCallback(() => {
    // 协议 dialect：anthropic-messages → anthropic；其余（含 responses）按 openai-compatible。
    return String(modelhubEndpoint?.apiType ?? "").includes("anthropic")
      ? "anthropic"
      : "openai-compatible";
  }, [modelhubEndpoint?.apiType]);

  const handleFetchModels = useCallback(async () => {
    if (!platform?.modelhubFetchModels || !modelhubEndpoint) return;
    setFetching(true);
    try {
      const result = await platform.modelhubFetchModels({
        baseUrl: modelhubEndpoint.baseUrl,
        ...(modelhubEndpoint.apiKey ? { apiKey: modelhubEndpoint.apiKey } : {}),
        dialect: resolveModelhubDialect(),
      });
      if (!result.ok || !result.models) {
        toast(
          intl.formatMessage(
            { id: "settings.modelhub.fetch.failed" },
            { error: result.error ?? "" },
          ),
        );
        return;
      }
      if (result.models.length === 0) {
        toast(intl.formatMessage({ id: "settings.modelhub.fetch.empty" }));
        return;
      }
      setFetchedModels(result.models);
      setFetchDialogOpen(true);
    } catch (error) {
      toast(
        intl.formatMessage(
          { id: "settings.modelhub.fetch.failed" },
          { error: error instanceof Error ? error.message : String(error) },
        ),
      );
    } finally {
      setFetching(false);
    }
  }, [intl, modelhubEndpoint, platform, resolveModelhubDialect]);

  const handleProbeVision = useCallback(
    async (modelId: string): Promise<boolean | null> => {
      if (!platform?.modelhubProbeVision || !modelhubEndpoint) return null;
      const result = await platform.modelhubProbeVision({
        baseUrl: modelhubEndpoint.baseUrl,
        ...(modelhubEndpoint.apiKey ? { apiKey: modelhubEndpoint.apiKey } : {}),
        model: modelId,
        dialect: resolveModelhubDialect(),
      });
      return result.ok ? (result.vision ?? null) : null;
    },
    [modelhubEndpoint, platform, resolveModelhubDialect],
  );

  const handleConfirmFetchedModels = useCallback(
    async (selected: { id: string; vision: boolean }[]) => {
      const key = (value: string) => value.trim().toLowerCase();
      const existingSet = new Set(models.map((model) => key(model.modelId)));
      for (const id of deletedIds) existingSet.add(key(id));
      let added = 0;
      const addedIds: string[] = [];
      for (const item of selected) {
        if (existingSet.has(key(item.id))) continue;
        try {
          // 与「添加模型」弹窗的提交产物同形：推荐配置由服务端解析，
          // 视觉探测结果通过 metadata 弹窗继续编辑，不在这里伪造 properties。
          await onAddModel({
            ...createEmptyModel(),
            modelId: item.id,
            personalConfig: {},
            useRecommendedConfig: true,
          });
          added += 1;
          addedIds.push(item.id);
          existingSet.add(key(item.id));
        } catch (error) {
          toast(
            intl.formatMessage(
              { id: "settings.modelhub.fetch.addFailed" },
              { model: item.id, error: error instanceof Error ? error.message : String(error) },
            ),
          );
        }
      }
      // 拉取成功后按名称自然排序（与补丁「已按名称自动排序」一致）。
      if (added > 0 && onReorderModelIds) {
        const merged = [...models.map((model) => model.modelId), ...addedIds];
        const natural = [...new Set(merged)].sort((a, b) =>
          String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" }),
        );
        if (JSON.stringify(natural) !== JSON.stringify(models.map((model) => model.modelId))) {
          onReorderModelIds(natural);
        }
      }
      toast(intl.formatMessage({ id: "settings.modelhub.fetch.done" }, { count: added }));
    },
    [deletedIds, intl, models, onAddModel, onReorderModelIds],
  );

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <span className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.models" })}
        </span>
        <div className="flex items-center gap-2">
          {onSaveProviderHeaders ? (
            <Button
              type="button"
              variant="secondary"
              size="default"
              className="rounded-lg"
              data-testid="v4-modelhub-headers-button"
              onClick={() => setHeadersDialogOpen(true)}
            >
              {intl.formatMessage({ id: "settings.modelhub.headers.action" })}
            </Button>
          ) : null}
          {modelhubUsable ? (
            <Button
              type="button"
              variant="secondary"
              size="default"
              className="rounded-lg"
              data-testid="v4-modelhub-fetch-button"
              disabled={fetching}
              onClick={() => void handleFetchModels()}
            >
              {intl.formatMessage({ id: "settings.modelhub.fetch.action" })}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="default"
            className="rounded-lg"
            data-testid={TID_MODEL_PROVIDER_ADD_MODEL_BUTTON}
            onClick={openAddDialog}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            {intl.formatMessage({ id: "settings.modelProvider.addModel" })}
          </Button>
        </div>
      </div>
      <ModelhubHeadersDialog
        open={headersDialogOpen}
        onOpenChange={setHeadersDialogOpen}
        currentHeaders={providerHeaders ?? {}}
        onApply={(headers) => {
          void onSaveProviderHeaders?.(headers).catch((error) => {
            toast(
              intl.formatMessage(
                { id: "settings.modelhub.headers.failed" },
                { error: error instanceof Error ? error.message : String(error) },
              ),
            );
          });
        }}
      />
      <ModelhubModelPickerDialog
        open={fetchDialogOpen}
        onOpenChange={setFetchDialogOpen}
        models={fetchedModels ?? []}
        existingIds={models.map((model) => model.modelId)}
        deletedIds={[...deletedIds]}
        onProbeVision={modelhubAvailable ? (modelId) => handleProbeVision(modelId) : undefined}
        onConfirm={(selected) => void handleConfirmFetchedModels(selected)}
      />
      {models.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-input-border bg-input">
          <SortableProviderModelList
            modelIds={models.map((model) => model.modelId)}
            sortableModelIds={models.map((model) => model.modelId)}
            onReorder={onReorderModelIds}
            renderModel={(_modelId, index) => {
              const model = models[index]!;
              const inputFormat = model.config.properties?.inputFormat;
              const outputFormat = model.config.properties?.outputFormat;
              const completeProperties =
                model.config.properties?.contextWindow != null &&
                inputFormat?.supportsText != null &&
                inputFormat.supportsImage != null &&
                inputFormat.supportsVideo != null &&
                inputFormat.supportsAudio != null &&
                inputFormat.supportsPdf != null &&
                outputFormat?.supportsText != null;
              return (
                <>
                  <ModelRowInput
                    key={`${providerId}/${model.modelId}`}
                    providerId={providerId}
                    providerName={providerName}
                    providerEnabled={providerEnabled}
                    providerAccess={providerAccess}
                    inputTestId={testId(TID_MODEL_PROVIDER_MODEL_INPUT, String(index))}
                    deleteTestId={testId(TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON, String(index))}
                    model={model}
                    onCommit={(value, basedOnRevision) =>
                      onModelCommit(model.modelId, value, basedOnRevision)
                    }
                    onResolveDraft={(nextModelId, personalConfig) =>
                      providerSettingsService.resolveModelConfig({
                        providerId,
                        originalModelId: model.modelId,
                        modelId: nextModelId,
                        personalConfig: structuredClone(personalConfig),
                      })
                    }
                    settingsRevision={settingsRevision}
                    onDelete={!model.builtin ? () => onDeleteModel(model.modelId) : undefined}
                    onEnabledChange={(enabled) => {
                      void Promise.resolve(onModelEnabledChange?.(model.modelId, enabled)).catch(
                        () => undefined,
                      );
                    }}
                    onTest={onTestModel}
                  />
                  {!completeProperties && (
                    <div className="px-3 pb-2 text-ui-sm text-destructive">
                      {model.issues?.[0]?.message ??
                        intl.formatMessage({ id: "settings.modelProvider.modelConfigIncomplete" })}
                    </div>
                  )}
                </>
              );
            }}
          />
        </div>
      ) : (
        <div className="mt-1 flex h-12 items-center justify-start gap-2 rounded-lg border border-dashed border-border px-4 text-left text-ui-base text-foreground-subtle">
          <InfoIcon className="size-4 shrink-0" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.modelProvider.modelsEmpty" })}
        </div>
      )}
      <>
        <ProviderModelMetadataDialog
          onRestore={() => {
            setAddDraftErrorField(null);
            setAddCommitError(null);
            void editor
              .restore()
              .catch((error) =>
                setAddCommitError(error instanceof Error ? error.message : String(error)),
              );
          }}
          mode="add"
          open={addDialogOpen}
          draft={addDraft}
          draftErrorMessage={addCommitError ?? addDraftErrorMessage}
          draftErrorField={addDraftErrorField}
          inheritedConfig={editor.inheritedConfig}
          overrideFields={editor.overrides}
          onOpenChange={handleAddDialogOpenChange}
          onDraftChange={updateAddDraft}
          onCommit={commitAddDraft}
          saving={addSaving}
          modelConfigResolutionPending={editor.pending}
          modelDefaultsLoaded={editor.defaultsLoaded}
          onModelIdBlur={() => {
            void editor.flush().catch(() => undefined);
          }}
        />
      </>
    </div>
  );
}
