/**
 * SessionTabBar — Claude Code「Untitled」风格的会话标签栏（插件 webview 专用）。
 *
 * - 点击切换会话；「+」新建草稿会话；
 * - 未锁定标签可原生拖拽重排（HTML5 drag，不引入 dnd 依赖）；
 * - 锁定后固定在最左侧，不可拖动、不可关闭，再点图钉解锁；
 * - 状态由 App 持久化到 webview localStorage。
 */
import { useState, type DragEvent } from "react";
import type { SessionTab } from "./sessionTabs";

export interface SessionTabBarProps {
  tabs: readonly SessionTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  onTogglePin: (id: string) => void;
  onReorder: (fromId: string, toId: string) => void;
}

function PinGlyph({ filled }: { filled: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"
      fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2">
      <path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z" />
    </svg>
  );
}

export function SessionTabBar({
  tabs,
  activeId,
  onSelect,
  onNew,
  onClose,
  onTogglePin,
  onReorder,
}: SessionTabBarProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const handleDragStart = (event: DragEvent<HTMLDivElement>, tab: SessionTab) => {
    if (tab.pinned) {
      event.preventDefault();
      return;
    }
    setDraggingId(tab.id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", tab.id);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, tab: SessionTab) => {
    event.preventDefault();
    const fromId = event.dataTransfer.getData("text/plain") || draggingId;
    if (fromId) onReorder(fromId, tab.id);
    setDraggingId(null);
    setOverId(null);
  };

  return (
    <div
      role="tablist"
      aria-label="会话标签"
      data-testid="session-tab-bar"
      className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-card-border bg-card px-1.5"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        const isDropTarget = overId === tab.id && draggingId !== tab.id && !tab.pinned;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            data-tab-id={tab.id}
            data-pinned={tab.pinned ? "true" : "false"}
            draggable={!tab.pinned}
            onDragStart={(event) => handleDragStart(event, tab)}
            onDragOver={(event) => {
              if (tab.pinned) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setOverId(tab.id);
            }}
            onDragLeave={() => setOverId((current) => (current === tab.id ? null : current))}
            onDrop={(event) => handleDrop(event, tab)}
            onDragEnd={() => {
              setDraggingId(null);
              setOverId(null);
            }}
            className={[
              "flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 text-ui-xs",
              active
                ? "border-border bg-input text-foreground"
                : "border-transparent text-foreground-subtle hover:bg-hover/40",
              tab.pinned ? "cursor-default" : "cursor-grab",
              draggingId === tab.id ? "opacity-50" : "",
              isDropTarget ? "border-l-2 border-l-primary" : "",
            ].join(" ")}
          >
            {tab.pinned ? (
              <span className="text-foreground-subtle" title="已锁定">
                <PinGlyph filled />
              </span>
            ) : null}
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="max-w-[9rem] truncate bg-transparent px-0.5 text-left text-inherit"
              title={tab.sessionId ? `${tab.title} · ${tab.sessionId}` : `${tab.title} · 新对话`}
              onClick={() => onSelect(tab.id)}
            >
              {tab.title}
            </button>
            <button
              type="button"
              className="rounded px-0.5 text-foreground-subtle hover:text-foreground"
              title={tab.pinned ? "解锁标签" : "锁定标签（固定到最左侧，不可拖动/关闭）"}
              aria-label={tab.pinned ? "解锁标签" : "锁定标签"}
              onClick={() => onTogglePin(tab.id)}
            >
              <PinGlyph filled={tab.pinned} />
            </button>
            {tab.pinned ? null : (
              <button
                type="button"
                className="rounded px-0.5 text-foreground-subtle hover:text-foreground"
                title="关闭标签"
                aria-label="关闭标签"
                onClick={() => onClose(tab.id)}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"
                  fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-foreground-subtle hover:bg-hover/40 hover:text-foreground"
        title="新建对话标签"
        aria-label="新建对话标签"
        onClick={onNew}
      >
        +
      </button>
    </div>
  );
}
