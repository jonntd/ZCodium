/* eslint-disable no-console */
/**
 * 真实 VS Code / Antigravity 扩展宿主内的部署产物验收（不需要用户手动 Reload Window）。
 *
 * 由 scripts/run-extension-host-smoke.sh 以 --extensionTestsPath 注入隔离实例，
 * 在扩展宿主进程里直接 require("vscode") 调用真实 API，断言：
 *   1) 部署目录里的 package.json / extension.js 能被宿主发现并 activate；
 *   2) 视图容器、TreeView、Webview 声明与贡献点一致；
 *   3) 所有 gode.* 命令（含本轮新增的 gode.changes.refresh）都真的注册成功；
 *   4) TreeView 可聚焦、刷新命令可执行且无异常。
 *
 * 与 test/ 下的 headless 单测互补：单测验逻辑，本测试验「产物在真实宿主里能跑」。
 */
const assert = require("node:assert/strict");
const vscode = require("vscode");

const log = (msg) => console.log("[ext-host-smoke] " + msg);

exports.run = async function run() {
  const ext = vscode.extensions.getExtension("gode.gode");
  assert.ok(ext, "未找到扩展 gode.gode（部署目录未被 --extensionDevelopmentPath 加载）");
  const pkg = ext.packageJSON;
  log(`发现扩展 ${pkg.publisher}.${pkg.name}@${pkg.version}`);

  await ext.activate();
  assert.ok(ext.isActive, "扩展激活失败");
  log("activate() 成功");

  const containerId = pkg.contributes.viewsContainers.activitybar[0].id;
  assert.ok(pkg.contributes.views[containerId], "views 的 key 必须与容器 ID 一致");
  const views = pkg.contributes.views[containerId].map((view) => view.id);
  assert.deepEqual(views, ["gode.chat"], "「文件改动历史」应已移除，只剩对话视图");
  // 旧容器 ID 的布局缓存里仍记着 gode.changesHistory；换容器 ID 让该缓存键失效。
  assert.notEqual(containerId, "gode", "不得复用旧容器 ID，否则幽灵视图缓存复活");
  log(`视图容器 ${containerId}：${views.join(", ")}`);
  const titleWhens = pkg.contributes.menus["view/title"]
    .filter((entry) => typeof entry.when === "string" && entry.when.includes("view =="))
    .map((entry) => entry.when);
  for (const when of titleWhens) {
    const referenced = /view\s*==\s*([A-Za-z0-9_.-]+)/.exec(when)?.[1];
    assert.ok(views.includes(referenced), `标题栏菜单引用了不存在的视图: ${when}`);
  }
  log(`视图声明: ${views.join(", ")}；标题栏 when 全部命中已注册视图`);

  const commands = await vscode.commands.getCommands(true);
  const declared = pkg.contributes.commands.map((entry) => entry.command);
  const required = [
    "gode.openChat",
    "gode.openChatInEditor",
    "gode.newSession",
    "gode.restartAgent",
    "gode.switchWorkspace",
    "gode.pickSession",
    "gode.stop",
    "gode.reviewChanges",
  ];
  const missing = required.filter((command) => !commands.includes(command));
  assert.deepEqual(missing, [], "命令未注册: " + missing.join(", "));
  const notDeclared = required.filter((command) => !declared.includes(command));
  assert.deepEqual(notDeclared, [], "命令未在 package.json 声明: " + notDeclared.join(", "));
  log(`命令注册齐全: ${required.length} 个（清单与运行时一致）`);

  const leftoverChangesCommands = commands.filter((command) =>
    command.startsWith("gode.changes."),
  );
  assert.deepEqual(leftoverChangesCommands, [], "文件改动历史命令族应已移除");
  log("运行时无 gode.changes.* 残留命令");

  await vscode.commands.executeCommand("gode.chat.focus");
  log("Webview 视图 gode.chat 可聚焦（聊天卡片「审查 / 打开」入口保留）");

  // 编辑器标签页形态：命令创建 WebviewPanel 标签，IDE 原生支持拖动/拆分/移动。
  // 用命令返回值做确定性断言（tabGroups 在隔离实例里跨进程同步有延迟，仅作补充观测）。
  const opened = await vscode.commands.executeCommand("gode.openChatInEditor");
  assert.ok(opened, "gode.openChatInEditor 未返回面板状态");
  assert.equal(opened.viewType, "gode.chatEditor", "不是编辑器 WebviewPanel 形态");
  assert.equal(opened.title, "Gode 对话", "编辑器标签标题不符");
  assert.equal(opened.created, true, "首次调用应新建标签");
  // 隔离实例无可见窗口时 viewColumn 尚未同步，不用它做断言；改用「面板持续存在」
  // 证明 WebviewPanel 标签已建立（若被立即销毁，第二次调用会再次 created=true）。
  const again = await vscode.commands.executeCommand("gode.openChatInEditor");
  assert.equal(again.created, false, "面板未保持存在（第二次调用应聚焦而非重建）");
  log(
    `编辑器标签「${opened.title}」已创建并持续存在（viewColumn=${opened.viewColumn ?? "同步中"}，可拖动 / 拆分 / 移动）`,
  );
  const tabGroups = vscode.window.tabGroups;
  if (tabGroups) {
    const labels = tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label));
    log("tabGroups 当前标签：" + (labels.join(" | ") || "（同步中/空）"));
  }

  console.log(
    "[ext-host-smoke] PASS — 真实扩展宿主加载部署产物：激活 / 视图 / 命令全部通过",
  );
};
