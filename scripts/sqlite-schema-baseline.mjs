import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertAdditiveSchema } from "./sqlite-schema-contract.mjs";
import { readSchemaAtBase } from "./sqlite-schema-git.mjs";

export async function checkSchemaBaseline({ cwd, base, path, current, update = false }) {
  // 先校验目标历史再允许更新；否则删列与重写 baseline 会互相抵消。
  const previous = await readSchemaAtBase(cwd, base, path);
  if (previous !== undefined) assertAdditiveSchema(previous, current);
  const file = join(cwd, path);
  if (update) await writeFile(file, current);
  else {
    const baseline = await readFile(file, "utf8");
    assertAdditiveSchema(baseline, current);
    assertAdditiveSchema(current, baseline);
    if (baseline !== current)
      throw new Error(`Schema baseline differs: ${path}; review then run pnpm db:schema:update`);
  }
}
