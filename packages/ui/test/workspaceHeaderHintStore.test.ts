// 顶栏状态提示 store（spec: workspace-header-status-hint）。
// 契约面很小：全量覆写（无 TTL/无累加）、null 即清除、host 壳层是唯一写入方。
import { beforeEach, describe, expect, it } from "vitest";
import {
  useWorkspaceHeaderHintStore,
  type WorkspaceHeaderHint,
} from "@/store/workspaceHeaderHintStore.js";

function hint(tone: WorkspaceHeaderHint["tone"]): WorkspaceHeaderHint {
  return { message: "当前链路不支持二进制帧，传输已退化为 base64 文本帧", tone };
}

describe("workspaceHeaderHintStore", () => {
  beforeEach(() => {
    useWorkspaceHeaderHintStore.getState().setWorkspaceHeaderHint(null);
  });

  it("初值恒为 null：桌面/Web 入口从不写入，header 零渲染", () => {
    expect(useWorkspaceHeaderHintStore.getState().hint).toBeNull();
  });

  it("写入后 header 读到同一份 hint（workspace 级事实，多实例同显）", () => {
    useWorkspaceHeaderHintStore.getState().setWorkspaceHeaderHint(hint("info"));
    expect(useWorkspaceHeaderHintStore.getState().hint).toEqual(hint("info"));
  });

  it("重复写入是全量覆写，不累加不合并", () => {
    useWorkspaceHeaderHintStore.getState().setWorkspaceHeaderHint(hint("info"));
    useWorkspaceHeaderHintStore.getState().setWorkspaceHeaderHint(hint("warning"));
    expect(useWorkspaceHeaderHintStore.getState().hint).toEqual({
      message: "当前链路不支持二进制帧，传输已退化为 base64 文本帧",
      tone: "warning",
    });
  });

  it("传 null 清除：capabilities 恢复正常后 chip 消失", () => {
    useWorkspaceHeaderHintStore.getState().setWorkspaceHeaderHint(hint("info"));
    useWorkspaceHeaderHintStore.getState().setWorkspaceHeaderHint(null);
    expect(useWorkspaceHeaderHintStore.getState().hint).toBeNull();
  });
});
