import { type ExecutionDeleteProtectionPrelude, type ExecutionShellSelection } from "@zcode/contracts";

/**
 * 删除保护 prelude（docs/spec/delete-protection.md §4.1）：
 * 在 POSIX shell 里定义 rm/rmdir/unlink 函数，把删除目标移入系统废纸篓/回收站，
 * 覆盖 shell 内直接调用形式。与 embedded-search prelude 相同的方言门槛。
 * 阈值审批在 CLI 权限层判定，prelude 只负责「移废纸篓」这一种删除语义。
 */
export function buildDeleteProtectionPreludeContent(
  prelude?: ExecutionDeleteProtectionPrelude,
  options: { shellDialect?: ExecutionShellSelection["dialect"] } = {},
): string | undefined {
  if (prelude?.kind !== "delete-protection") return undefined;
  if (!supportsPosixShellFunctionPrelude(options.shellDialect)) return undefined;
  return DELETE_PROTECTION_PRELUDE_CONTENT;
}

function supportsPosixShellFunctionPrelude(
  shellDialect: ExecutionShellSelection["dialect"] | undefined,
): boolean {
  return shellDialect === "posix" || shellDialect === "git-bash";
}

/**
 * 预期行为（与 spec §4.1/§5 对应）：
 * - 选项（含合并短选项与长选项）接受但忽略；`--` 之后一律按路径处理。
 * - 不存在的路径：带 -f/--force 时静默跳过，否则报错并使本次调用退出码非 0。
 * - 任一目标移动失败：报错、退出码非 0，绝不回退为系统删除。
 * - rmdir 保留「仅空目录」语义：非空目录报错（Directory not empty）。
 * - 重名目标追加时间戳/序号后缀，不覆盖废纸篓里的既有文件。
 * - ZCODE_DELETE_PROTECTION_TRASH_DIR 可覆盖废纸篓目录（E2E 用）。
 */
const DELETE_PROTECTION_PRELUDE_CONTENT = [
  "# zcode delete protection: move deletion targets to the system trash.",
  "zcode_trash_unique() {",
  '  local _dir="$1" _base="$2" _cand',
  '  _cand="$_dir/$_base"',
  '  if [ ! -e "$_cand" ] && [ ! -L "$_cand" ]; then printf \'%s\\n\' "$_cand"; return 0; fi',
  "  local _stamp _i=0",
  '  _stamp="$(date +%Y%m%d-%H%M%S)"',
  "  while :; do",
  '    if [ "$_i" -eq 0 ]; then _cand="$_dir/$_stamp-$_base"; else _cand="$_dir/$_stamp-$_i-$_base"; fi',
  '    if [ ! -e "$_cand" ] && [ ! -L "$_cand" ]; then printf \'%s\\n\' "$_cand"; return 0; fi',
  "    _i=$((_i + 1))",
  "  done",
  "}",
  "zcode_trash_win() {",
  "  local _src _kind _win",
  '  _src="$1"',
  "  if [ -d \"$_src\" ]; then _kind=DeleteDirectory; else _kind=DeleteFile; fi",
  '  _win="$(cygpath -w "$_src" 2>/dev/null)" || { printf \'zcode delete protection: cannot map Windows path: %s\\n\' "$_src" >&2; return 1; }',
  "  _win=${_win//\\'/\\'\\'}",
  "  command powershell.exe -NoProfile -NonInteractive -Command \"Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::$_kind('$_win','OnlyErrorDialogs','SendToRecycleBin')\" >/dev/null",
  "}",
  "zcode_trash_one() {",
  "  local _src _trash_dir _dest",
  '  _src="$1"',
  '  if [ ! -e "$_src" ] && [ ! -L "$_src" ]; then',
  '    if [ "${_zcode_trash_force:-0}" = 1 ]; then return 0; fi',
  "    printf 'zcode delete protection: no such file or directory: %s\\n' \"$_src\" >&2",
  "    return 1",
  "  fi",
  '  if [ "${_zcode_trash_command:-rm}" = rmdir ] && [ -d "$_src" ] && [ -n "$(ls -A -- "$_src" 2>/dev/null)" ]; then',
  "    printf 'zcode delete protection: directory not empty: %s\\n' \"$_src\" >&2",
  "    return 1",
  "  fi",
  '  case "$(uname -s)" in',
  "    *MINGW*|*MSYS*|*CYGWIN*)",
  "      zcode_trash_win \"$_src\"",
  "      return",
  "      ;;",
  "  esac",
  '  _trash_dir="${ZCODE_DELETE_PROTECTION_TRASH_DIR:-}"',
  '  if [ -z "$_trash_dir" ]; then',
  '    case "$(uname -s)" in',
  '      Darwin) _trash_dir="$HOME/.Trash" ;;',
  "      *)",
  "        if command -v gio >/dev/null 2>&1; then",
  '          command gio trash -- "$_src" && return 0',
  "          printf 'zcode delete protection: gio trash failed for: %s\\n' \"$_src\" >&2",
  "          return 1",
  "        fi",
  '        _trash_dir="$HOME/.local/share/Trash/files"',
  "        command mkdir -p -- \"$_trash_dir\"",
  "        ;;",
  "    esac",
  "  fi",
  '  if [ ! -d "$_trash_dir" ]; then',
  "    printf 'zcode delete protection: trash directory is missing: %s\\n' \"$_trash_dir\" >&2",
  "    return 1",
  "  fi",
  '  _dest="$(zcode_trash_unique "$_trash_dir" "$(basename -- "$_src")")" || return 1',
  '  if ! command mv -- "$_src" "$_dest"; then',
  "    printf 'zcode delete protection: failed to move to trash: %s\\n' \"$_src\" >&2",
  "    return 1",
  "  fi",
  "}",
  "zcode_trash_invoke() {",
  "  local _zcode_trash_command=\"$1\"",
  "  shift",
  "  local _arg _seen_dd=0",
  "  local -a _zcode_paths=()",
  "  _zcode_trash_force=0",
  '  for _arg in "$@"; do',
  '    if [ "$_seen_dd" = 0 ]; then',
  '      case "$_arg" in',
  "        --) _seen_dd=1; continue ;;",
  "        -*)",
  '          case "$_arg" in *f*|*--force*) _zcode_trash_force=1 ;; esac',
  "          continue",
  "          ;;",
  "      esac",
  "    fi",
  '    _zcode_paths+=("$_arg")',
  "  done",
  '  if [ "${#_zcode_paths[@]}" -eq 0 ]; then',
  "    printf 'zcode delete protection: missing operand\\n' >&2",
  "    return 1",
  "  fi",
  "  local _path _status=0",
  '  for _path in "${_zcode_paths[@]}"; do',
  '    zcode_trash_one "$_path" || _status=1',
  "  done",
  "  return \"$_status\"",
  "}",
  "rm() { zcode_trash_invoke rm \"$@\"; }",
  "rmdir() { zcode_trash_invoke rmdir \"$@\"; }",
  "unlink() { zcode_trash_invoke unlink \"$@\"; }",
].join("\n");
