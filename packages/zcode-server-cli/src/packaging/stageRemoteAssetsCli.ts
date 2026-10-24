import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCE_SERVER_REMOTE_RELEASE_TARGETS,
  beginSourceServerRemoteReleaseGeneration,
  collectSourceServerRemoteReleaseArchives,
} from "./remoteAssetRelease.js";

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], { cwd, env, stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const linuxOnly = process.argv.slice(2).includes("--linux");
  const targets = linuxOnly
    ? SOURCE_SERVER_REMOTE_RELEASE_TARGETS.filter((target) => target.startsWith("linux-"))
    : SOURCE_SERVER_REMOTE_RELEASE_TARGETS;
  const env = { ...process.env };
  if (linuxOnly) {
    // Linux 开发入口与 dev:desktop 共用 production 默认值，避免远端模型配置退回 test。
    // 原全平台入口继续沿用通用构建器的环境选择规则。
    const zcodeEnv = env.ZCODE_ENV?.trim().toLowerCase() || "production";
    if (zcodeEnv !== "test" && zcodeEnv !== "production") {
      throw new Error(`Invalid ZCODE_ENV for prepare:remote-assets:linux: ${zcodeEnv}`);
    }
    env.ZCODE_ENV = zcodeEnv;
  }
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const repoRoot = resolve(packageRoot, "../..");
  const { version: manifestVersion } = JSON.parse(
    await readFile(join(repoRoot, "package.json"), "utf8"),
  ) as { version: string };
  // 修复（2026-10-24 v3.15.1 发布失败）：10-11 起根 package.json 走独立 1.y.z 版本线
  // （c7351631），发布 tag 仍是 v3.x。stage 仍按 package.json 建目录（releases/1.16.3），
  // 而 publish-remote-assets 按 ZCODE_APP_VERSION 找 releases/3.15.1 → "release
  // directory not found"，remote-assets job 全挂。这里与 publish-remote-assets 保持
  // 同一优先级（ZCODE_APP_VERSION > package.json），CI 传入发布版本后两侧目录一致。
  const version = process.env.ZCODE_APP_VERSION?.trim() || manifestVersion;
  const versionReleaseDir = join(repoRoot, "packages/desktop/mock-cdn/releases", version);
  await beginSourceServerRemoteReleaseGeneration({ versionReleaseDir });
  await run("pnpm", ["--filter", "@zcode/server-cli", "build"], repoRoot, env);
  for (const [index, target] of targets.entries()) {
    await run(
      "pnpm",
      [
        "--filter",
        "@zcode/server-cli",
        "exec",
        "tsx",
        "src/packaging/stageCli.ts",
        "--target",
        target,
        ...(linuxOnly ? ["--skip-component-archives"] : []),
        ...(index === 0 ? [] : ["--skip-agent-build"]),
      ],
      repoRoot,
      env,
    );
  }
  const collected = await collectSourceServerRemoteReleaseArchives({
    distReleaseDir: join(packageRoot, "dist-release"),
    versionReleaseDir,
    version,
    targets,
  });
  for (const path of collected) console.log(`[source-server-release] ${path}`);
}

await main();
