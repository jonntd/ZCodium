# Spec: 从资源管理器拖拽文件到聊天 composer（@mention 形式）

本 spec 定义 VS Code 扩展聊天面板对「从 VS Code 资源管理器（Explorer）拖拽文件/文件夹
进聊天区」的处理契约：拖拽识别、视觉反馈、释放后的插入语义与平台能力边界。
涉及 `packages/ui` 的 composer 拖放层与 `apps/zcode-vscode` 的平台 RPC 面。

> 修订：v1 曾把拖入文件实现为附件卡片（localPath 上行 ref）。应用反馈要求
> Claude Code/Augment 式的 `@文件名` mention 形式，v2 起语义改为 **mention pill**，
> 与仓库既有「应用内文件树拖拽 = mention」规则对齐。

## 1. 背景

composer 已支持 OS 文件拖放（`dataTransfer.files` → 附件）、粘贴、应用内文件树拖拽
（`WORKSPACE_FILE_DRAG_MIME` → mention pill）。VS Code 资源管理器拖拽进 webview 时
dataTransfer **没有 `Files` 类型**、File 对象无本机路径
（`VscodePlatformService.getPathForFile` 恒 null），只有：

- `text/uri-list` —— 被拖资源的 `file://` URI（多行，CRLF 分隔，多选时每行一个）；
- `application/vnd.code.tree.<treeId>` —— VS Code 树拖拽标记（opaque，webview 侧不可读内容）。

## 2. 语义选择

| 拖拽来源                                 | 语义                         |
| ---------------------------------------- | ---------------------------- |
| 应用内文件树（workspace MIME）           | mention pill（不变）         |
| OS 文件 / 资源管理器（可解析出本地文件） | **mention pill（本次修订）** |
| 纯 `Files` 且无法解析出路径的拖拽        | 附件（兜底，行为不变）       |

理由：拖入文件的用户预期是「引用这个文件给 Agent」（Claude Code/Augment 形式），
与文件树拖拽语义一致；mention 随正文 markdown 发送，不进上传队列。
图片等需要字节内容的场景暂不特判（mention 提供路径，Agent 侧按需读取）；
如后续需要可按扩展名/mime 回退附件卡片，属增量变更。

## 3. 规则

**识别（dragover）**：由纯函数 `hasLocalResourceDropSignal`
（`packages/ui/src/lib/workspaceFileDrag.ts`）唯一判定，输入为 `dataTransfer.types`：

- 命中任一 → 可投放（点亮拖拽遮罩/高亮）：
  - `types` 含 `"Files"`；
  - `dataTransfer.items` 存在 `kind === "file"`；
  - `types` 含 `WORKSPACE_FILE_DRAG_MIME`；
  - `types` 同时含 `text/uri-list` **且** 某 type 以 `application/vnd.code.tree` 开头
    （`hasExplorerResourceDragSignal`）。
- 仅 `text/uri-list`（浏览器链接拖拽）**不命中**：不 preventDefault、不点亮，
  保持链接拖入输入框的默认文本插入行为。
- 判定结果映射 `composerDragKind`：workspace MIME → `"workspace"`，其余 → `"attachment"`。

**释放（drop）**：`ConversationComposer.handleConversationDrop` 按序：

1. workspace MIME 命中 → 现状 mention 分流（不变）；
2. **explorer 分支**：`parseFileUriList(getData("text/uri-list"))` 非空且
   `platform.resolveFileDropPaths` 已实现 → `preventDefault()` → 异步 resolve →
   对每个返回条目循环 `appendWorkspaceFileMentionToComposer`（`workspaceFileComposer.ts`），
   一次 drop 产生 N 个 pill（多选拖拽天然支持，顺序与 uri-list 行序一致）；
   resolve 失败 → `attachmentError`（复用 `chat.attachments.readFailed` 文案）；
   同步先复位拖拽反馈；
3. `parseFileUriList` 为空（纯链接等）或平台未实现 resolve → 不 preventDefault，
   落回既有 `Files`/附件兜底与默认行为。

**URI 解析**：`parseFileUriList` 只切分行、跳过 `#` 注释、每行取首个 URL token、
仅收 `file://` scheme（大小写不敏感）、按行去重；**不做 file:// → 本机路径转换，
也不做百分号解码**（Windows 盘符/UNC 与编码语义由 host 的 `vscode.Uri.parse` 承担）。

**路径校验（host）**：`resolveFileDropPaths(uris)` 用 `vscode.Uri.parse(uri).fsPath`
转路径后 `fs.stat` 校验：**只返回存在且为普通文件的条目**（目录、缺失、不可访问的
URI 被静默过滤并按路径去重），返回 `{ path, sizeBytes }`。

**能力门控**：`resolveFileDropPaths` 是 `IPlatformService` 可选方法；未实现的平台
（手机/Web/桌面）返回 `undefined`，explorer 分支整体跳过，行为与改动前一致。

**mention 构造**：复用 `createWorkspaceFileComposerMention`
（`lib/workspaceFileDrag.ts`）：同 workspace 用 relativePath，否则绝对路径；
markdown = `[label](./relativePath)`（`buildFileMentionMarkdown`），随正文发送。

## 4. 视觉反馈

拖拽识别命中后复用现有链路——窗口级预亮（`usePromptEditorDragState`）与整面 drop
遮罩（`WorkspaceHeader` draft 遮罩 / 会话视图高亮）。拖拽期间 `dropEffect = "copy"`。

## 5. 事件顺序

```text
dragover(types 命中) → preventDefault + dropEffect=copy + kind（300ms 心跳复位）
drop → workspace MIME? mention 分流
     → explorer 分支：parseFileUriList → host resolveFileDropPaths(uris)
        → {path,sizeBytes}[] → 循环 appendWorkspaceFileMentionToComposer（N 个 pill）
     → 解析为空/平台未实现 → 不 preventDefault，落回 Files/默认
resolve 失败 → attachmentError 提示，不产生 pill
```

## 6. 验收场景

1. 多选拖 3 个文件 → 3 个 `@pill`，顺序与拖拽选择一致；
2. 单拖 1 个文件 → 1 个 `@pill`（不再是附件卡片）；
3. 拖目录 → 无 pill（host 过滤），无报错；
4. 从浏览器拖网页链接 → 无遮罩，URL 按默认行为插入文本；
5. resolve 失败/全部缺失 → 静默（无 pill；reject 时有错误提示）；
6. 手机/Web/桌面回归：`Files` 拖放与链接拖入行为与改动前一致；
7. 应用内文件树拖拽 → mention（既有语义不变）。
