/**
 * ThemeBridge — VS Code 主题 → @zcode/ui 主题 class 映射（架构 §2.4 主题跟随，T04）。
 *
 * 映射规则（与 packages/web/src/main.tsx 同款 class 体系）：
 * - Dark / HighContrast ⇒ `dark` + `theme-zai-dark`
 * - Light / HighContrastLight ⇒ `theme-zai-light`
 * 持久化 localStorage 键复用 `zcode-theme`（useTheme hook 的读取键）。
 */

export const THEME_STORAGE_KEY = "zcode-theme";

/** vscode.ColorThemeKind 枚举值（1 Light, 2 Dark, 3 HighContrast, 4 HighContrastLight）。 */
export type VscodeThemeKind = 1 | 2 | 3 | 4;

export interface ThemeClassState {
  dark: boolean;
  zaiTheme: "theme-zai-light" | "theme-zai-dark";
}

/** 纯映射函数（vitest 直测）。 */
export function mapVsCodeTheme(kind: VscodeThemeKind): ThemeClassState {
  const dark = kind === 2 || kind === 3;
  return {
    dark,
    zaiTheme: dark ? "theme-zai-dark" : "theme-zai-light",
  };
}

/** 把映射结果应用到 documentElement（webview 环境调用；测试用假 document 跳过）。 */
export function applyThemeClasses(kind: VscodeThemeKind, doc: Document): void {
  const state = mapVsCodeTheme(kind);
  doc.documentElement.classList.toggle("dark", state.dark);
  doc.documentElement.classList.toggle("theme-zai-light", state.zaiTheme === "theme-zai-light");
  doc.documentElement.classList.toggle("theme-zai-dark", state.zaiTheme === "theme-zai-dark");
  try {
    localStorage.setItem(THEME_STORAGE_KEY, state.dark ? "zai-dark" : "zai-light");
  } catch {
    // localStorage 不可用时跳过持久化（useTheme 会回落 host 帧）。
  }
}

// ── 主题运行时跟随（§2.2：非仅挂载时一次） ──

/** HostFrameBus 的最小结构面（只认 theme 帧；避免 themeBridge 依赖桥实现）。 */
export interface ThemeFrameSource {
  on(kind: "theme", handler: (payload: unknown) => void): () => void;
  lastPayload(kind: "theme"): unknown;
}

function isVscodeThemeKind(value: unknown): value is VscodeThemeKind {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

/**
 * 主题帧运行时跟随（App.tsx useEffect 消费体的提取，node 环境可测）：
 * 订阅时先以最近一帧同步一次（重挂载/晚订阅不丢当前主题），之后每帧应用；
 * 非法载荷（schema 外 kind）静默丢弃，不抛错。返回解除函数。
 */
export function followThemeFrames(
  source: ThemeFrameSource | null | undefined,
  doc: Document,
  apply: (kind: VscodeThemeKind, doc: Document) => void = applyThemeClasses,
): () => void {
  if (!source) return () => {};
  const applyPayload = (payload: unknown): void => {
    if (isVscodeThemeKind(payload)) apply(payload, doc);
  };
  const initial = source.lastPayload("theme");
  if (initial !== undefined) applyPayload(initial);
  return source.on("theme", applyPayload);
}
