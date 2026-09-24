import type { AppUsageSnapshot } from "@zcode/shared";
import type { ChartConfig } from "@/components/ui/chart.js";
import { getAppUsageModelChartColor } from "@/settings/usage-stats/appUsageChartPalette.js";

interface UsageIntl {
  formatMessage: (descriptor: { id: string }) => string;
}

export interface AppUsageModelPieSlice {
  key: string;
  label: string;
  color: string;
  totalTokens: number;
  share: number;
}

function resolvePieModelLabel(intl: UsageIntl, modelId: string | null): string {
  return modelId?.trim() || intl.formatMessage({ id: "settings.usage.unknownModel" });
}

export function buildAppUsageModelPieChartViewModel({
  intl,
  snapshot,
}: {
  intl: UsageIntl;
  snapshot: AppUsageSnapshot;
}) {
  // 用量页去截断（对齐 zcode-patcher --usage-chart）：不再把 Top5 之外的模型
  // 合并成「其他模型」，全部模型各自出块；颜色在调色板内循环复用。
  const positiveModels = snapshot.models.filter((model) => model.totalTokens > 0);
  const totalModelTokens = positiveModels.reduce((sum, model) => sum + model.totalTokens, 0);
  const chartData: AppUsageModelPieSlice[] = positiveModels.map((model, index) => ({
    key: `model${index}`,
    label: resolvePieModelLabel(intl, model.modelId),
    color: getAppUsageModelChartColor(index),
    totalTokens: model.totalTokens,
    share: totalModelTokens > 0 ? model.totalTokens / totalModelTokens : 0,
  }));
  const chartConfig = chartData.reduce<ChartConfig>((config, slice) => {
    config[slice.key] = {
      label: slice.label,
      color: slice.color,
    };
    return config;
  }, {});

  return {
    chartConfig,
    chartData,
    totalModelTokens,
  };
}
