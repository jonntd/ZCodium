/**
 * 渲染可见性 gate（架构 §2.2 双源可见性，T03/①）。
 *
 * 组2 在 host 侧生产 visibility 帧（chatPanel onDidChangeVisibility，载荷形状唯一定义处
 * src/host/hostFrameKinds.ts 的 VisibilityHostFramePayload）；webview 侧再叠加
 * document.visibilitychange 自证源，**任一源声明隐藏即暂停渲染**——host 帧缺失
 * （旧 host / 帧未达）不阻塞渲染（初值按可见处理），document.hidden 恒可读。
 *
 * 纯逻辑（combineVisibility / subscribeRenderVisibility）node 环境可测；
 * useRenderPaused 为 React 装配薄壳（App.tsx 消费）。
 */

import { useEffect, useState } from "react";

/** visibility 帧载荷（与 src/host/hostFrameKinds.ts VisibilityHostFramePayload 同形）。 */
export interface VisibilityFramePayload {
  visible: boolean;
}

/** HostFrameBus 的最小结构面（只认 visibility 帧）。 */
export interface VisibilityFrameSource {
  on(kind: "visibility", handler: (payload: unknown) => void): () => void;
  lastPayload(kind: "visibility"): unknown;
}

/**
 * 双源 gate：document 隐藏 → 暂停；host 帧显式 visible=false → 暂停；
 * host 帧缺失（null）按可见处理（避免初始隐藏态锁死渲染）。
 */
export function combineVisibility(hostVisible: boolean | null, documentHidden: boolean): boolean {
  return documentHidden || hostVisible === false;
}

/** 读取 document 自证源（node/测试无 document 时恒可见）。 */
export function readDocumentHidden(doc: Document | null | undefined): boolean {
  if (!doc) return false;
  return doc.hidden === true || doc.visibilityState === "hidden";
}

/**
 * 订阅双源可见性：立即以当前合成状态回调一次，之后任一源变化再回调。
 * 返回解除函数（同时移除 document 监听与 host 帧订阅）。
 */
export function subscribeRenderVisibility(
  source: VisibilityFrameSource | null | undefined,
  doc: Document,
  onChange: (paused: boolean) => void,
): () => void {
  let hostVisible: boolean | null = null;
  let documentHidden = readDocumentHidden(doc);
  const emit = (): void => {
    onChange(combineVisibility(hostVisible, documentHidden));
  };

  const onDocumentVisibility = (): void => {
    documentHidden = readDocumentHidden(doc);
    emit();
  };
  doc.addEventListener("visibilitychange", onDocumentVisibility);

  const initial = source?.lastPayload("visibility") as VisibilityFramePayload | undefined;
  if (initial && typeof initial.visible === "boolean") hostVisible = initial.visible;
  const offHost = source
    ? source.on("visibility", (payload: unknown) => {
        const record = payload as VisibilityFramePayload | null;
        if (record && typeof record.visible === "boolean") {
          hostVisible = record.visible;
          emit();
        }
      })
    : () => {};

  emit();
  return () => {
    doc.removeEventListener("visibilitychange", onDocumentVisibility);
    offHost();
  };
}

/**
 * App 装配面：双源 gate → 是否暂停渲染（webview 隐藏时挂起对话区重挂载成本）。
 * 无 document（node 测试）恒返回 false。
 */
export function useRenderPaused(
  source: VisibilityFrameSource | null | undefined,
  doc: Document | null = typeof document === "undefined" ? null : document,
): boolean {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!doc) return;
    return subscribeRenderVisibility(source, doc, setPaused);
  }, [source, doc]);
  return paused;
}
