import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { assertAdditiveSchema } from "../sqlite-schema-contract.mjs";
import { readSchemaAtBase, resolveSchemaBase } from "../sqlite-schema-git.mjs";
import { checkSchemaBaseline } from "../sqlite-schema-baseline.mjs";

const exec = promisify(execFile);
const oldSql = "CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT);\n";
const newSql = "CREATE TABLE tasks(id TEXT PRIMARY KEY);\n";

async function repository(t) {
  const cwd = await mkdtemp(join(tmpdir(), "schema-git-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = async (...args) => (await exec("git", args, { cwd })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Schema Test");
  await git("config", "user.email", "schema@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await git("remote", "add", "origin", "https://example.invalid/repository.git");
  await writeFile(join(cwd, "schema.sql"), oldSql);
  await git("add", ".");
  await git("commit", "-m", "baseline");
  const base = await git("rev-parse", "HEAD");
  await git("update-ref", "refs/remotes/origin/main", base);
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  await git("checkout", "-b", "feature");
  return { cwd, git, base };
}

test("clean committed destructive migration and baseline cannot cancel each other", async (t) => {
  const { cwd, git, base } = await repository(t);
  await writeFile(join(cwd, "schema.sql"), newSql);
  await writeFile(join(cwd, "migration.sql"), newSql);
  await git("add", ".");
  await git("commit", "-m", "remove title and rewrite baseline");
  await git("update-ref", "refs/remotes/origin/feature", "HEAD");
  await git("branch", "--set-upstream-to=origin/feature");
  assert.equal(await git("status", "--porcelain"), "");
  const resolved = await resolveSchemaBase(cwd, {});
  assert.equal(resolved.base, base);
  const previous = await readSchemaAtBase(cwd, resolved.base, "schema.sql");
  assert.throws(() => assertAdditiveSchema(previous, newSql), /Removed column: tasks.title/);
  for (const update of [false, true]) {
    await assert.rejects(
      checkSchemaBaseline({
        cwd,
        base: resolved.base,
        path: "schema.sql",
        current: newSql,
        update,
      }),
      /Removed column: tasks.title/,
    );
  }
});

test("explicit refs override CI, resolve to SHA, and invalid refs fail closed", async (t) => {
  const { cwd, base } = await repository(t);
  assert.equal(
    (
      await resolveSchemaBase(cwd, {
        SQLITE_SCHEMA_BASE_REF: "main",
        CI_MERGE_REQUEST_DIFF_BASE_SHA: "missing",
      })
    ).base,
    base,
  );
  await assert.rejects(resolveSchemaBase(cwd, { SQLITE_SCHEMA_BASE_REF: "missing" }), /git|base/i);
});

test("CI SHAs are exact commits, not merge-bases; invalid CI does not fall back", async (t) => {
  const { cwd, git, base } = await repository(t);
  await git("checkout", "main");
  await writeFile(join(cwd, "target.txt"), "target advanced");
  await git("add", ".");
  await git("commit", "-m", "target advanced");
  const target = await git("rev-parse", "HEAD");
  await git("checkout", "feature");
  assert.notEqual(base, target);
  for (const key of [
    "CI_MERGE_REQUEST_DIFF_BASE_SHA",
    "CI_MERGE_REQUEST_TARGET_BRANCH_SHA",
    "SQLITE_SCHEMA_BASE_REF",
  ]) {
    assert.equal((await resolveSchemaBase(cwd, { [key]: target })).base, target);
    await assert.rejects(resolveSchemaBase(cwd, { [key]: "missing" }));
  }
});

test("GitHub target takes precedence over origin/HEAD and missing target fails", async (t) => {
  const { cwd, git } = await repository(t);
  await git("checkout", "-b", "release");
  await writeFile(join(cwd, "schema.sql"), oldSql + "ALTER TABLE tasks ADD COLUMN extra TEXT;\n");
  await git("add", ".");
  await git("commit", "-m", "release baseline");
  const target = await git("rev-parse", "HEAD");
  await git("update-ref", "refs/remotes/origin/release", target);
  await git("checkout", "-b", "release-feature");
  assert.equal((await resolveSchemaBase(cwd, { GITHUB_BASE_REF: "release" })).base, target);
  await assert.rejects(resolveSchemaBase(cwd, { GITHUB_BASE_REF: "missing" }));
});

test("no target is an error, never an implicit HEAD comparison", async (t) => {
  const { cwd, git } = await repository(t);
  await git("update-ref", "-d", "refs/remotes/origin/main");
  await git("branch", "-D", "main");
  await assert.rejects(resolveSchemaBase(cwd, {}), /SQLITE_SCHEMA_BASE_REF/);
});

test("only a proven absent historical path permits a new baseline", async (t) => {
  const { cwd, base } = await repository(t);
  assert.equal(await readSchemaAtBase(cwd, base, "new-schema.sql"), undefined);
  assert.equal(await readSchemaAtBase(cwd, base, "schema.sql"), oldSql);
  await assert.rejects(readSchemaAtBase(cwd, "missing", "schema.sql"));
  await assert.rejects(readSchemaAtBase(join(cwd, "missing"), base, "schema.sql"));
  await checkSchemaBaseline({ cwd, base, path: "new-schema.sql", current: oldSql, update: true });
  await checkSchemaBaseline({ cwd, base, path: "new-schema.sql", current: oldSql });
  await assert.rejects(
    checkSchemaBaseline({
      cwd,
      base: "missing",
      path: "new-schema.sql",
      current: oldSql,
      update: true,
    }),
  );
});

test("existing baseline blob read failure must not be mistaken for first introduction", async (t) => {
  const { cwd, git, base } = await repository(t);
  const blob = await git("rev-parse", `${base}:schema.sql`);
  await rm(join(cwd, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  await assert.rejects(readSchemaAtBase(cwd, base, "schema.sql"));
  await assert.rejects(
    checkSchemaBaseline({ cwd, base, path: "schema.sql", current: newSql, update: true }),
  );
});

test("an existing target with unrelated history must not fall back to another target", async (t) => {
  const { cwd, git } = await repository(t);
  await git("checkout", "--orphan", "unrelated");
  await git("commit", "-m", "unrelated root");
  await git("update-ref", "refs/remotes/origin/release", "HEAD");
  await git("checkout", "feature");
  await assert.rejects(resolveSchemaBase(cwd, { GITHUB_BASE_REF: "release" }));
});

test("compatible changes still require an exact baseline, update then check succeeds", async (t) => {
  const { cwd, base } = await repository(t);
  const args = {
    cwd,
    base,
    path: "schema.sql",
    current: oldSql + "ALTER TABLE tasks ADD COLUMN extra TEXT;\n",
  };
  await assert.rejects(checkSchemaBaseline(args));
  await checkSchemaBaseline({ ...args, update: true });
  await checkSchemaBaseline(args);
});
