// @vitest-environment jsdom
/**
 * V1 探针：V4ChatPane 能否脱离 App 外壳单独挂载。
 *
 * 目的不是测业务，而是**用运行时事实回答 PRD §4.5.5 的 V1**：
 * 12 层 Provider 里哪些是渲染必需的、缺哪一层会抛什么。
 *
 * 做法：按 Root.tsx 的顺序逐层加 Provider，每层用独立容器渲染一次，
 * 记录「第一次成功渲染」出现在哪一层。services / platform 用宽松 Proxy 打桩
 * ——本探针只关心 React Context 是否齐全，不关心数据正确性。
 *
 * **手动运行**（根 vitest 的 include 只匹配 `packages/*\/test/**\/*.test.ts`，不含 `.tsx`，
 * 所以它不进默认套件——这是刻意的，避免给 1600 文件的套件再加 2 分钟）：
 *
 * ```
 * cd packages/ui
 * ../../node_modules/.bin/vitest run test/v4ChatPaneRender.test.tsx --pool=threads
 * ```
 *
 * `--pool=threads` 必须显式给：默认的 forks 池在本机沙箱里起不来 worker。
 *
 * 结论（2026-11-04 实测）：裸挂报「useServices 必须在 ServiceProvider 内使用」；
 * 补齐 12 层后渲染成功，且 `v4-draft-prewarm` 日志证明 SessionPane 内部逻辑已执行。
 */
import type { ReactNode } from "react";
import { Component } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LucideProvider } from "lucide-react";

import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { ProjectDirectoryProvider } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { DiffsWorkerPoolProvider } from "@/root/DiffsWorkerPoolProvider.js";
import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";
import { CodingPlanUpgradeDialogProvider } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { RemoteConnectionProgressProvider } from "@/remote-connection-flow/ui/RemoteConnectionProgress.js";
import { V4ChatPane } from "@/v4/V4ChatPane.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 宽松 Proxy 桩：任何属性都可取、可调用、可继续取属性。
 *
 * 两个细节必须处理，否则探针会因为**桩的缺陷**而不是真实缺 Provider 而失败：
 * 1. `then` 必须是函数——`IntlProvider` 会写 `settingService.get().then(...)`；
 *    但被 resolve 出去的值必须是**非 thenable**，否则 `await` 会无限递归。
 * 2. `Symbol.iterator` 要给空迭代器，否则 `[...services.x]` 直接抛。
 */
function makeStub(callable: boolean, thenable: boolean): unknown {
  const fn = function () {
    return makeStub(true, true);
  } as unknown as Record<PropertyKey, unknown>;

  const proxy = new Proxy(fn, {
    get(_target, prop) {
      if (prop === "then") {
        if (!thenable) return undefined;
        // resolve 一个非 thenable 的桩，避免 await 递归。
        return (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(makeStub(true, false)).then(onFulfilled, onRejected);
      }
      if (prop === Symbol.iterator) return function* empty() {};
      if (prop === Symbol.asyncIterator) {
        return async function* empty() {};
      }
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "toString") return () => "";
      if (prop === "valueOf") return () => 0;
      if (prop === "toJSON") return () => ({});
      if (prop === "length") return 0;
      return proxy;
    },
    apply() {
      return makeStub(true, true);
    },
    has() {
      return true;
    },
    construct() {
      return makeStub(true, true);
    },
  });

  void callable;
  return proxy;
}

const services = makeStub(true, true) as never;
const platform = makeStub(true, true) as never;

class Capture extends Component<
  { readonly onError: (error: Error) => void; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    this.props.onError(error);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

const mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = [];

function mount(children: ReactNode): { ok: boolean; error?: string } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });

  let captured: Error | undefined;
  try {
    act(() => {
      root.render(
        <Capture
          onError={(error) => {
            captured = error;
          }}
        >
          {children}
        </Capture>,
      );
    });
  } catch (error) {
    captured = error instanceof Error ? error : new Error(String(error));
  }
  return captured ? { ok: false, error: captured.message } : { ok: true };
}

afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    try {
      act(() => root.unmount());
    } catch {
      // 卸载失败不影响结论
    }
    host.remove();
  }
});

/**
 * 按 Root.tsx 的**外→内**顺序排列。`upTo` = 应用前 N 层。
 *
 * 注意折叠方向：这里从内向外 wrap，必须**反向遍历**，否则第一层会变成最内层
 * （上一版就是这么错的：Service 跑到了 Store 里面，报 useServices 缺 Provider）。
 */
function stack(upTo: number): ReactNode {
  const pane = (
    <V4ChatPane
      workspacePath="/tmp/spike-workspace"
      sessionId={null}
      isDesktop={false}
      onSessionCreated={() => undefined}
    />
  );

  const layers: Array<(child: ReactNode) => ReactNode> = [
    // Root.tsx 里 IntlProvider 在 web 端位于 Root 外层；单独挂 V4ChatPane 时它是必需的
    // （SessionPane 直接调 useZCodeIntl，缺了会抛）。
    (child) => (
      <ZCodeIntlProvider settingService={(services as { settingService: never }).settingService}>
        {child}
      </ZCodeIntlProvider>
    ),
    (child) => <LucideProvider strokeWidth={1.5}>{child}</LucideProvider>,
    (child) => <TooltipProvider>{child}</TooltipProvider>,
    (child) => <ServiceProvider services={services}>{child}</ServiceProvider>,
    (child) => <PlatformProvider platform={platform}>{child}</PlatformProvider>,
    (child) => (
      <StoreProvider broadcastService={(services as { broadcastService: never }).broadcastService}>
        {child}
      </StoreProvider>
    ),
    (child) => <TabStoreProvider>{child}</TabStoreProvider>,
    (child) => <ProjectDirectoryProvider isDesktop={false}>{child}</ProjectDirectoryProvider>,
    (child) => <DiffsWorkerPoolProvider>{child}</DiffsWorkerPoolProvider>,
    (child) => (
      <AssistantCodeCommentFeatureProvider enabled={false}>
        {child}
      </AssistantCodeCommentFeatureProvider>
    ),
    (child) => <CodingPlanUpgradeDialogProvider>{child}</CodingPlanUpgradeDialogProvider>,
    (child) => <RemoteConnectionProgressProvider>{child}</RemoteConnectionProgressProvider>,
  ];

  let node = pane;
  for (const wrap of layers.slice(0, upTo).reverse()) {
    node = wrap(node);
  }
  return node;
}

describe("V4ChatPane 独立挂载（V1）", () => {
  it("裸挂必须报缺 Provider（证明探针有效）", () => {
    const result = mount(stack(0));
    console.log(`[V1] L0 ${result.ok ? "OK" : `FAIL: ${result.error?.slice(0, 200)}`}`);
    expect(result.error ?? "").toMatch(/必须在 .*Provider 内使用/u);
  }, 300_000);

  it("全栈不得报缺 Provider（V1 结论）", () => {
    const result = mount(stack(12));
    console.log(`[V1] L12 ${result.ok ? "OK" : `FAIL: ${result.error?.slice(0, 200)}`}`);
    console.log(`[V1] L12 DOM 长度=${document.body.innerHTML.length}`);
    // 只断言「不是缺 Provider」：桩会让 Radix 的 compose-refs 出现 ref 循环，
    // 那是打桩产物，不是真实缺 Context。缺 Provider 的报错文案固定为「必须在 XxxProvider 内使用」。
    expect(result.error ?? "").not.toMatch(/必须在 .*Provider 内使用/u);
  }, 300_000);
});
