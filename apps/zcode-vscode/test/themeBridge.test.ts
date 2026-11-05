/**
 * T04 主题/i18n 跟随映射测试（P1-9.4）+ §2.2 主题运行时跟随消费者（T03/①）。
 */

import { describe, expect, it } from "vitest";
import {
  applyThemeClasses,
  followThemeFrames,
  mapVsCodeTheme,
  THEME_STORAGE_KEY,
} from "../src/webview-react/themeBridge";
import { mapVscodeLanguage } from "../src/webview-react/i18nSetup";
import { HostFrameBus } from "../src/webview-react/bridge/hostFrames";

describe("VS Code 主题 → zai 主题 class 映射", () => {
  it("Light(1) → zai-light", () => {
    expect(mapVsCodeTheme(1)).toEqual({ dark: false, zaiTheme: "theme-zai-light" });
  });

  it("Dark(2) → dark + zai-dark", () => {
    expect(mapVsCodeTheme(2)).toEqual({ dark: true, zaiTheme: "theme-zai-dark" });
  });

  it("HighContrast(3) → dark + zai-dark", () => {
    expect(mapVsCodeTheme(3)).toEqual({ dark: true, zaiTheme: "theme-zai-dark" });
  });

  it("HighContrastLight(4) → zai-light", () => {
    expect(mapVsCodeTheme(4)).toEqual({ dark: false, zaiTheme: "theme-zai-light" });
  });

  it("applyThemeClasses 写入 documentElement class 与 localStorage", () => {
    const classes = new Set<string>();
    const store = new Map<string, string>();
    const fakeDoc = {
      documentElement: {
        classList: {
          toggle: (name: string, force: boolean) => {
            if (force) classes.add(name);
            else classes.delete(name);
          },
        },
      },
    } as unknown as Document;
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        setItem: (k: string, v: string) => void store.set(k, v),
        getItem: (k: string) => store.get(k) ?? null,
      },
      configurable: true,
    });
    try {
      applyThemeClasses(2, fakeDoc);
      expect(classes.has("dark")).toBe(true);
      expect(classes.has("theme-zai-dark")).toBe(true);
      expect(store.get(THEME_STORAGE_KEY)).toBe("zai-dark");
    } finally {
      Object.defineProperty(globalThis, "localStorage", { value: original, configurable: true });
    }
  });
});

describe("§2.2 主题运行时跟随：host 帧 → applyThemeClasses（非仅挂载一次）", () => {
  /** 假 document（themeBridge.test 同款 classList 记账面）。 */
  function makeFakeDoc() {
    const classes = new Set<string>();
    return {
      classes,
      doc: {
        documentElement: {
          classList: {
            toggle: (name: string, force: boolean) => {
              if (force) classes.add(name);
              else classes.delete(name);
            },
          },
        },
      } as unknown as Document,
    };
  }

  function withFakeLocalStorage(run: () => void): void {
    const store = new Map<string, string>();
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        setItem: (k: string, v: string) => void store.set(k, v),
        getItem: (k: string) => store.get(k) ?? null,
      },
      configurable: true,
    });
    try {
      run();
    } finally {
      Object.defineProperty(globalThis, "localStorage", { value: original, configurable: true });
    }
  }

  it("host theme 帧驱动 applyThemeClasses（订阅后逐帧跟随）", () => {
    const { classes, doc } = makeFakeDoc();
    const bus = new HostFrameBus();
    const off = followThemeFrames(bus, doc);
    bus.handleMessageData({ t: "host", kind: "theme", payload: 2 });
    expect(classes.has("dark")).toBe(true);
    expect(classes.has("theme-zai-dark")).toBe(true);
    bus.handleMessageData({ t: "host", kind: "theme", payload: 1 });
    expect(classes.has("dark")).toBe(false);
    expect(classes.has("theme-zai-light")).toBe(true);
    off();
    bus.handleMessageData({ t: "host", kind: "theme", payload: 3 });
    expect(classes.has("dark")).toBe(false);
  });

  it("晚订阅以最近一帧立即同步（重挂载/晚订阅不丢当前主题）", () => {
    const { classes, doc } = makeFakeDoc();
    const bus = new HostFrameBus();
    bus.handleMessageData({ t: "host", kind: "theme", payload: 3 });
    const off = followThemeFrames(bus, doc);
    expect(classes.has("dark")).toBe(true);
    expect(classes.has("theme-zai-dark")).toBe(true);
    off();
  });

  it("schema 外主题载荷（0/5/字符串）静默丢弃，不应用不抛错", () => {
    const { classes, doc } = makeFakeDoc();
    const bus = new HostFrameBus();
    const off = followThemeFrames(bus, doc);
    bus.handleMessageData({ t: "host", kind: "theme", payload: 9 });
    bus.handleMessageData({ t: "host", kind: "theme", payload: "dark" });
    expect(classes.size).toBe(0);
    off();
  });

  it("跟随写入 localStorage 主题键（useTheme 回落面）", () => {
    const { doc } = makeFakeDoc();
    const bus = new HostFrameBus();
    withFakeLocalStorage(() => {
      const off = followThemeFrames(bus, doc);
      bus.handleMessageData({ t: "host", kind: "theme", payload: 2 });
      expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe("zai-dark");
      off();
    });
  });

  it("帧源缺失（null）返回 no-op 解除函数", () => {
    const { doc } = makeFakeDoc();
    expect(followThemeFrames(null, doc)()).toBeUndefined();
  });
});

describe("VS Code language → Locale 映射", () => {
  it("zh-cn / zh-TW → zh-CN", () => {
    expect(mapVscodeLanguage("zh-cn")).toBe("zh-CN");
    expect(mapVscodeLanguage("zh-TW")).toBe("zh-CN");
  });

  it("fa → fa-IR", () => {
    expect(mapVscodeLanguage("fa")).toBe("fa-IR");
  });

  it("en / 缺省 → en-US", () => {
    expect(mapVscodeLanguage("en")).toBe("en-US");
    expect(mapVscodeLanguage(undefined)).toBe("en-US");
  });
});
