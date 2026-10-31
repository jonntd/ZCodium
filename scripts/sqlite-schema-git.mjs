import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
async function git(cwd, args) {
  return (await exec("git", args, { cwd })).stdout;
}

async function commit(cwd, ref) {
  return (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
}

// 架构/affected resolver 可回退 upstream/HEAD；schema 反篡改不能沿用该语义。
export async function resolveSchemaBase(cwd = process.cwd(), env = process.env) {
  for (const key of [
    "SQLITE_SCHEMA_BASE_REF",
    "CI_MERGE_REQUEST_DIFF_BASE_SHA",
    "CI_MERGE_REQUEST_TARGET_BRANCH_SHA",
  ]) {
    const ref = env[key]?.trim();
    if (ref) return { base: await commit(cwd, ref), label: `${key} ${ref}` };
  }
  const mergeBase = async (ref) => {
    const target = await commit(cwd, ref);
    return {
      base: (await git(cwd, ["merge-base", "HEAD", target])).trim(),
      label: `merge-base ${ref}`,
    };
  };
  // CI 的目标分支比仓库默认分支更准确，配置错误必须阻断而非降级。
  const githubBase = env.GITHUB_BASE_REF?.trim();
  if (githubBase) return mergeBase(`refs/remotes/origin/${githubBase}`);

  let originHead;
  try {
    originHead = (await git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).trim();
  } catch (error) {
    if (error.code !== 1) throw error;
  }
  for (const ref of [
    originHead,
    "refs/remotes/origin/main",
    "refs/remotes/origin/master",
    "refs/heads/main",
    "refs/heads/master",
  ]) {
    if (!ref) continue;
    // 只跳过不存在的本地候选；一旦目标存在，历史缺失/无共同祖先都必须报错。
    try {
      await git(cwd, ["show-ref", "--verify", "--quiet", ref]);
    } catch (error) {
      if (error.code === 1) continue;
      throw error;
    }
    return mergeBase(ref);
  }
  throw new Error(
    "未找到 schema 目标基线；请 fetch 目标分支或设置 SQLITE_SCHEMA_BASE_REF，不能回退 HEAD",
  );
}

export async function readSchemaAtBase(cwd, base, path) {
  const sha = await commit(cwd, base);
  // 先成功读取 tree 再判断不存在，不能把 git show 的损坏对象/权限/无效 ref 等错误当首次引入。
  const entries = await git(cwd, ["ls-tree", "-z", sha, "--", `:(literal)${path}`]);
  if (!entries) return undefined;
  return git(cwd, ["show", `${sha}:${path}`]);
}
