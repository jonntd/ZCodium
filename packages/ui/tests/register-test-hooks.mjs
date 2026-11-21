/**
 * ui 包 node:test 的钩子注册入口（package.json test 脚本经 `--import` 挂载）：
 * 先挂资产桩（asset-stub-hooks），tsx 由脚本另起的 `--import tsx` 接管 TS 解析。
 */
import { register } from "node:module";

register("./asset-stub-hooks.mjs", import.meta.url);
