/** 非 TS 资源模块声明（esbuild 处理，tsc 仅消音）。 */
declare module "*.css";

/** 构建期烙入的 monorepo 根（esbuild define，见 esbuild.mjs）；fullui 产物定位用。 */
declare const __ZCODE_REPO_ROOT__: string;
