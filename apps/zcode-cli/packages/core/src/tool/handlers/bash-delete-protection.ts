import { analyzeBashCommand, type BashCommandInvocation } from "./bash-command-parser.js";
import type { ToolDeleteProtectionPreferences } from "../types.js";

/**
 * 删除保护的批量审批计数（docs/spec/delete-protection.md §4.2）。
 *
 * 判定必须是同步、无 I/O 的：操作数计数基于命令解析结果，不访问文件系统。
 * 通配符、命令替换、解析失败等「数量不可知」形态一律按达到阈值处理（宁可多问）。
 */

const DELETE_COMMAND_NAMES = new Set(["rm", "rmdir", "unlink"]);

/** 解析失败/不支持语法时的原文兜底：出现独立的删除命令词就按达到阈值处理。 */
const DELETE_COMMAND_FALLBACK_PATTERN = /(^|[^A-Za-z0-9_./-])(rm|rmdir|unlink)(\s|$)/u;

/**
 * 纯前缀修饰：子命令仍按普通命令解析，shell 函数（prelude）照样生效。
 */
const SHELL_PREFIX_WRAPPERS = new Set(["time", "noglob"]);

/**
 * 会 exec 真实二进制的 wrapper：`command`/`sudo`/`env`/`xargs`/`nohup` 都绕过 shell
 * 函数（prelude 拦不到），删除保护只剩审批层兜底——一旦发现这类形态携带删除命令词，
 * 按数量不可知处理（需要审批）。
 */
const BINARY_EXEC_WRAPPERS = new Set(["command", "env", "nohup", "sudo", "xargs"]);

const HAS_GLOB_PATTERN = /[*?[]/u;

interface BashDeleteProtectionEvaluation {
  /** 达到批量删除审批阈值（或数量不可知），需要 alwaysAsk 审批。 */
  requiresApproval: boolean;
  /** 解析出的删除操作数总数；数量不可知（通配符/动态词/解析失败/二进制 exec 形态）时为 undefined。 */
  deleteOperandCount?: number;
}

export function evaluateBashDeleteProtection(input: {
  command: string;
  deleteProtection?: ToolDeleteProtectionPreferences;
}): BashDeleteProtectionEvaluation {
  const preferences = input.deleteProtection;
  // 删除保护关闭时整条判定不生效。
  if (!preferences?.deleteProtectionEnabled) {
    return { requiresApproval: false };
  }
  const threshold = preferences.batchDeleteApprovalThreshold;

  const analysis = analyzeBashCommand(input.command);
  if (analysis.hasParseErrors || analysis.hasUnsupportedSyntax) {
    return {
      requiresApproval: DELETE_COMMAND_FALLBACK_PATTERN.test(input.command),
    };
  }

  let totalOperands = 0;
  let countUnknown = false;
  let sawDeleteCommand = false;
  for (const invocation of analysis.commands) {
    const unwrapped = unwrapDeleteInvocation(invocation);
    if (!unwrapped) continue;
    sawDeleteCommand = true;
    if (unwrapped.kind === "binary-exec" || invocation.hasDynamicWords) {
      // 二进制 exec 形态不走 prelude（真实 unlink）；动态词让操作数不可知。
      // 两者都按「数量不可知」→ 需要审批。
      countUnknown = true;
      continue;
    }
    const { operands, hasGlobOperand } = extractDeleteOperands(unwrapped.argv);
    totalOperands += operands.length;
    if (hasGlobOperand) countUnknown = true;
  }

  if (!sawDeleteCommand) {
    return { requiresApproval: false };
  }
  if (countUnknown) {
    return { requiresApproval: true, deleteOperandCount: undefined };
  }
  return {
    requiresApproval: totalOperands >= threshold,
    deleteOperandCount: totalOperands,
  };
}

type UnwrappedDeleteInvocation =
  | { kind: "shell-function"; argv: string[] }
  | { kind: "binary-exec" };

/**
 * 识别一条 invocation 是否与删除命令相关：
 * - shell-function：shell 内直接调用（可被 prelude 函数拦截为移废纸篓），返回删除命令 argv；
 * - binary-exec：经 exec 二进制的 wrapper 携带删除命令词（prelude 拦不到，只能靠审批兜底）；
 * - undefined：与删除命令无关。
 */
function unwrapDeleteInvocation(
  invocation: BashCommandInvocation,
): UnwrappedDeleteInvocation | undefined {
  let argv = [...invocation.argv];
  while (argv.length > 0 && SHELL_PREFIX_WRAPPERS.has(argv[0]!)) {
    argv = argv.slice(1);
  }
  if (argv.length === 0) return undefined;
  if (DELETE_COMMAND_NAMES.has(argv[0]!)) {
    return { kind: "shell-function", argv };
  }
  if (BINARY_EXEC_WRAPPERS.has(argv[0]!)) {
    // 保守扫描：wrapper 之后出现独立的删除命令词（含 flag/赋值后）即视为二进制删除。
    const rest = argv.slice(1);
    if (rest.some((token) => DELETE_COMMAND_NAMES.has(token))) {
      return { kind: "binary-exec" };
    }
  }
  return undefined;
}

/**
 * 从删除命令 argv 中取非选项操作数；`--` 之后一律按操作数处理。
 * hasGlobOperand 表示存在通配符操作数：实际数量要等 shell 展开，同步判定阶段不可知。
 */
function extractDeleteOperands(deleteArgv: string[]): {
  operands: string[];
  hasGlobOperand: boolean;
} {
  const operands: string[] = [];
  let hasGlobOperand = false;
  let seenDoubleDash = false;
  for (const arg of deleteArgv.slice(1)) {
    if (!seenDoubleDash) {
      if (arg === "--") {
        seenDoubleDash = true;
        continue;
      }
      if (arg.startsWith("-") && arg.length > 1) continue;
    }
    if (HAS_GLOB_PATTERN.test(arg)) hasGlobOperand = true;
    operands.push(arg);
  }
  return { operands, hasGlobOperand };
}
