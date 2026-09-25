import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { windowsPathToGitBashPath } from "@zcode/contracts";
import type { ExecutionRequest, ExecutionShellDialect } from "@zcode/contracts";
import { buildEmbeddedSearchPreludeContent } from "./embedded-search-prelude.js";
import { buildDeleteProtectionPreludeContent } from "./delete-protection-prelude.js";

export type StartupShellDialect = ExecutionShellDialect | "legacy-shell";

interface BashInternalScriptMaterializeOptions {
  rootDir: string;
  sessionId: string;
  shellDialect?: StartupShellDialect;
}

interface BashInternalScriptContent {
  id: string;
  content: string;
}

interface MaterializedBashSourceScript {
  path: string;
  shellPath: string;
}

interface BashSourceScript {
  path: string;
  shellPath: string;
  optional?: boolean;
}

interface ApplyBashSourcesOptions {
  leadingSources?: BashSourceScript[];
  rootDir: string;
  sessionId: string;
  shellDialect: StartupShellDialect;
}

export function applyBashSourcesToExecutionRequest(
  request: ExecutionRequest,
  options: ApplyBashSourcesOptions,
): ExecutionRequest {
  if (request.command.mode !== "shell" || request.command.shellProfile !== "posix-bash") {
    return request;
  }

  const embeddedPreludeContent = buildEmbeddedSearchPreludeContent(request.bashPrelude, {
    shellDialect: options.shellDialect,
  });
  const deleteProtectionPreludeContent = buildDeleteProtectionPreludeContent(
    request.bashDeleteProtectionPrelude,
    {
      shellDialect: options.shellDialect,
    },
  );
  // 两个内部 prelude 各自物化为独立 source 脚本：内容 hash 独立，避免一边变化
  // 把另一边的缓存脚本也判为失效。
  const internalScripts: BashInternalScriptContent[] = [];
  if (embeddedPreludeContent) {
    internalScripts.push({ id: "embedded-search-startup", content: embeddedPreludeContent });
  }
  if (deleteProtectionPreludeContent) {
    internalScripts.push({ id: "delete-protection-startup", content: deleteProtectionPreludeContent });
  }
  const materializedScripts = internalScripts.flatMap((script) => {
    const materialized = materializeBashInternalSourceScript(script, {
      rootDir: options.rootDir,
      sessionId: options.sessionId,
      shellDialect: options.shellDialect,
    });
    return materialized ? [materialized] : [];
  });
  const sources = [...(options.leadingSources ?? []), ...materializedScripts];
  const command = applyBashSourceScripts(request.command.command, sources);
  if (command === request.command.command) return request;

  return {
    ...request,
    command: {
      ...request.command,
      command,
    },
  };
}

function materializeBashInternalSourceScript(
  script: BashInternalScriptContent | undefined,
  options: BashInternalScriptMaterializeOptions,
): MaterializedBashSourceScript | undefined {
  if (!script) return undefined;
  if (!supportsBashSourceScripts(options.shellDialect)) return undefined;
  if (script.content.length === 0) return undefined;

  const sessionDir = join(options.rootDir, "bash-startup", sanitizePathSegment(options.sessionId));
  mkdirSync(sessionDir, { recursive: true });

  const hash = hashContent(script.content);
  const fileName = `${sanitizePathSegment(script.id)}-${hash}.sh`;
  const path = join(sessionDir, fileName);

  if (!existsSync(path) || readFileSync(path, "utf8") !== script.content) {
    writeFileSync(path, script.content, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows 可能不保留 POSIX mode bit；文件仍位于 ZCode 自有 storage 下。
    }
  }

  return {
    path,
    shellPath: options.shellDialect === "git-bash" ? windowsPathToGitBashPath(path) : path,
  };
}

function applyBashSourceScripts(command: string, sources: BashSourceScript[]): string {
  const sourceLines = sources.map((source) => {
    const sourceCommand = `. ${quoteSourcePath(source)}`;
    return source.optional ? `${sourceCommand} 2>/dev/null || true` : sourceCommand;
  });
  return sourceLines.length === 0 ? command : [...sourceLines, command].join("\n");
}

function supportsBashSourceScripts(shellDialect: StartupShellDialect | undefined): boolean {
  return shellDialect === "posix" || shellDialect === "git-bash";
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "unknown";
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellQuoteAlways(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteSourcePath(materialized: BashSourceScript): string {
  return materialized.path === materialized.shellPath
    ? shellQuoteAlways(materialized.shellPath)
    : shellQuote(materialized.shellPath);
}
