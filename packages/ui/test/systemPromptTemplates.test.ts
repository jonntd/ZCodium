import assert from "node:assert/strict";
import test from "node:test";
import { RECOMMENDED_IDENTITY_TEMPLATES } from "../src/settings/systemPromptTemplates.js";

// 推荐模板（codex_ui 还原说明 §15）：主身份 Agent 身份的「✧ 推荐模板（1）」。
// 模板内容会整段写入 override 草稿，必须非空且 id 唯一（key 用）。

test("推荐模板：非空、id 唯一、数量与 UI 徽标一致", () => {
  assert.ok(RECOMMENDED_IDENTITY_TEMPLATES.length > 0);
  const ids = new Set<string>();
  for (const template of RECOMMENDED_IDENTITY_TEMPLATES) {
    assert.ok(template.id.length > 0);
    assert.ok(!ids.has(template.id), `模板 id 重复: ${template.id}`);
    ids.add(template.id);
    assert.ok(template.body.trim().length > 0, `模板正文为空: ${template.id}`);
  }
});
