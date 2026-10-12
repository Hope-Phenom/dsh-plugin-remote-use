#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-env-backup.py -- DSH 环境的交互式备份 / 还原 / 校验工具。

为什么需要专门的工具，而不是直接 robocopy：
------------------------------------------------
1. **Junction（目录联接）会被实体化。** profile 的 node_modules 里可能有指向源码
   checkout 的 junction（例如 dsh-plugin-code-quality -> F:\\WorkSpace\\...）。
   `robocopy /MIR` 默认会跟进 junction 并把内容复制成**真实目录**；这样的备份还原
   回去，会把链接换成副本，你对源码目录的修改就再也同步不进 profile 了。
   本工具：备份时用 `/XJ` 跳过 junction 并在 manifest 里记录它的目标；还原时重建。

2. **还原时的 junction 是危险源。** 如果目标目录里有 junction，`/MIR` 会把它当"多余
   文件"处理，而删除 junction 的操作有可能**连带删掉链接目标的真实内容**。
   本工具：镜像前先用 `os.rmdir`（只删链接、不碰目标）摘除 junction，镜像后再重建。

3. **运行中的 DSH 会持续写盘。** sessions 目录正在被追加写，锁定文件会让复制失败，
   也会得到不自洽的快照。本工具：检测 DSH 进程，建议先停再备份/还原。

4. **dsh-runtimes 自我覆盖。** 本工具自身可能就是用
   `<DSH_HOME>\\dsh-runtimes\\...\\python.exe` 运行的。还原时覆盖它等于试图替换正在
   执行的解释器：既会失败，也没有必要（运行时由 DSH 重新置备）。
   本工具：还原默认**排除** dsh-runtimes，并在检测到"自己跑在还原目标里"时明确告警。

用法：
    python dsh-env-backup.py                    # 交互式菜单
    python dsh-env-backup.py backup   --to D:\\bk --name my-backup [--slim] [--yes]
    python dsh-env-backup.py restore  --from D:\\bk\\my-backup [--yes]
    python dsh-env-backup.py verify   --from D:\\bk\\my-backup [--deep]
    python dsh-env-backup.py list     --to D:\\bk
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# 常量与配置
# ---------------------------------------------------------------------------

MANIFEST_NAME = "dsh-backup-manifest.json"
LOG_NAME = "dsh-env-tool.log"
BACKUP_PREFIX = "dsh-env-"

# 判定 DSH 是否在运行的进程名（大小写不敏感比较）。
DSH_PROCESS_NAMES = ("DeepSeek Harness.exe", "dsh.exe")

# 完整备份 = 全部；精简备份 = 排除下面这些。
SLIM_EXCLUDES = ("dsh-runtimes", "sessions", "attachments", "cache")

# 还原时**默认总是排除**的目录，除非显式 --include-runtimes。
# 理由见文件头第 4 条：这些是运行时可再置备的载荷，且很可能正在被本进程使用。
RESTORE_ALWAYS_EXCLUDE = ("dsh-runtimes",)

# 还原"成功后应逐字节一致"的关键路径（相对 DSH_HOME）。少而准，便于快速校验。
CRITICAL_PATHS = (
    "profiles/desktop/package.json",
    "profiles/desktop/cordis.patch.yml",
    "profiles/desktop/cordis.yml",
    "profiles/desktop/pnpm-lock.yaml",
    "profiles/desktop/pnpm-workspace.yaml",
    "cordis.patch.yml",
    "settings.yaml.imported",
    ".credentials.yaml",
    ".anonymous-user-id",
)

FILE_ATTRIBUTE_REPARSE_POINT = 0x400


# ---------------------------------------------------------------------------
# 控制台编码
#
# 中文 Windows 的控制台默认是 GBK（cp936）。本工具输出 UTF-8，若不做处理会显示成
# 乱码；更糟的是 subprocess 的 text=True 也按 GBK 解码，遇到非 GBK 字节会直接抛
# UnicodeDecodeError（tasklist 的输出就会）。所以这里把输入输出统一到 UTF-8，
# 并且所有 subprocess 调用都显式指定 encoding。
# ---------------------------------------------------------------------------

def _setup_console_encoding() -> None:
    if os.name == "nt":
        try:
            ctypes.windll.kernel32.SetConsoleOutputCP(65001)
            ctypes.windll.kernel32.SetConsoleCP(65001)
        except Exception:
            pass
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


_setup_console_encoding()


def run_text(cmd: list[str], timeout: int = 60) -> tuple[int, str, str]:
    """统一的子进程执行：显式 UTF-8 解码，绝不因编码问题崩溃。

    返回 (returncode, stdout, stderr)；stdout/stderr 保证是 str（不是 None）。
    """
    try:
        r = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace",
        )
        return r.returncode, (r.stdout or ""), (r.stderr or "")
    except subprocess.TimeoutExpired:
        log(f"timeout: {' '.join(cmd)}")
        return 124, "", "timeout"
    except (OSError, ValueError) as exc:
        log(f"exec failed: {' '.join(cmd)}: {exc}")
        return 127, "", str(exc)


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------

class C:
    """ANSI 颜色；在非 TTY 上自动关闭。"""
    _on = sys.stdout.isatty()

    @staticmethod
    def _w(code: str, s: str) -> str:
        return f"\033[{code}m{s}\033[0m" if C._on else s

    @staticmethod
    def bold(s): return C._w("1", s)
    @staticmethod
    def dim(s): return C._w("2", s)
    @staticmethod
    def red(s): return C._w("31", s)
    @staticmethod
    def green(s): return C._w("32", s)
    @staticmethod
    def yellow(s): return C._w("33", s)
    @staticmethod
    def blue(s): return C._w("36", s)


def say(msg: str = "") -> None:
    print(msg, flush=True)


def hr(title: str = "") -> None:
    if title:
        say(C.bold(f"── {title} " + "─" * max(0, 60 - len(title))))
    else:
        say(C.dim("─" * 64))


def ok(msg: str) -> None:
    say(f"  {C.green('OK')}    {msg}")


def warn(msg: str) -> None:
    say(f"  {C.yellow('WARN')}  {msg}")


def bad(msg: str) -> None:
    say(f"  {C.red('FAIL')}  {msg}")


def info(msg: str) -> None:
    say(f"  {C.dim('·')}     {msg}")


_LOG_PATH: Path | None = None


def open_log(path: Path) -> None:
    global _LOG_PATH
    _LOG_PATH = path
    try:
        with _LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(f"\n===== {datetime.now().isoformat()} =====\n")
    except OSError:
        _LOG_PATH = None


def log(msg: str) -> None:
    if _LOG_PATH is None:
        return
    try:
        with _LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}\n")
    except OSError:
        pass


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024:
            return f"{n:,.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:,.1f} PB"


def sha256(path: Path) -> str:
    h = __import__("hashlib").sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def is_reparse(path: Path) -> bool:
    """是否为 junction / symlink（不跟进，只读属性位）。"""
    try:
        attrs = path.stat(follow_symlinks=False).st_file_attributes
        return bool(attrs & FILE_ATTRIBUTE_REPARSE_POINT)
    except (OSError, AttributeError):
        try:
            return bool(os.lstat(path).st_reparse_tag)
        except (OSError, AttributeError):
            return False


def junction_target(path: Path) -> str | None:
    """读取 reparse point 的目标。用 os.readlink 优先，回退到 fsutil。"""
    try:
        t = os.readlink(path)
        # Windows 上 os.readlink 对 junction 返回 \\?\C:\... 形式
        if t.startswith("\\\\?\\"):
            t = t[4:]
        return t
    except OSError:
        pass
    rc, out, _ = run_text(["cmd", "/c", "dir", "/AL", str(path.parent)], timeout=20)
    if rc == 0:
        for line in out.splitlines():
            if path.name in line and "<JUNCTION>" in line.upper():
                m = re.search(r"\[(.+?)\]", line)
                if m:
                    return m.group(1)
    return None


def find_junctions(root: Path) -> list[dict]:
    """深度优先找出 root 下所有 reparse point（不跟进它们）。"""
    found: list[dict] = []
    stack = [root]
    while stack:
        cur = stack.pop()
        try:
            entries = list(os.scandir(cur))
        except OSError:
            continue
        for e in entries:
            p = Path(e.path)
            try:
                if e.is_dir(follow_symlinks=False):
                    if is_reparse(p):
                        found.append({
                            "path": str(p.relative_to(root)).replace("\\", "/"),
                            "target": junction_target(p),
                        })
                    else:
                        stack.append(p)
            except OSError:
                continue
    return sorted(found, key=lambda d: d["path"])


def remove_link_only(path: Path) -> bool:
    """只删除链接本身，绝不触碰目标内容。

    对 junction 用 os.rmdir（Win32 RemoveDirectory 语义：删除重解析点而非其内容）。
    绝不能用 shutil.rmtree —— 它会跟进并删除目标里的真实文件。
    """
    try:
        os.rmdir(path)
        return True
    except OSError as exc:
        log(f"remove_link_only({path}) failed: {exc}")
        return False


def make_junction(link: Path, target: str) -> bool:
    """重建 junction。

    **不检查目标是否存在。** Windows 允许 junction 指向不存在的路径（已实测），
    而悬空 junction 常常就是环境本来的状态 —— 例如旧 npm 全局安装留下的残留。
    忠实还原「原样」比「看起来干净」重要；要清理请用 --drop-dangling。
    """
    if not target:
        log(f"make_junction: empty target for {link}")
        return False
    try:
        link.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        log(f"make_junction: cannot create parent for {link}: {exc}")
        return False
    if link.exists() or is_reparse(link):
        remove_link_only(link)
    rc, out, err = run_text(["cmd", "/c", "mklink", "/J", str(link), target], timeout=30)
    # mklink 是 cmd 内建命令，失败时退出码不总是可靠，所以同时看输出。
    blob = (out + " " + err).lower()
    created = ("junction created" in blob) or ("创建的联接" in blob) or ("为" in blob and "<<" in blob)
    if rc != 0 or not created:
        log(f"mklink failed rc={rc}: out={out!r} err={err!r}")
        return False
    return True


def target_exists(target: str | None) -> bool:
    """junction 目标当前是否存在。悬空 junction 是合法状态，不是错误。"""
    if not target:
        return False
    try:
        return Path(target).exists()
    except OSError:
        return False


def dsh_running() -> list[str]:
    """返回正在运行的 DSH 进程名列表（去重）。"""
    found: list[str] = []
    rc, out, _ = run_text(["tasklist", "/FO", "CSV", "/NH"], timeout=30)
    if rc != 0:
        return found
    for line in out.splitlines():
        m = re.match(r'"([^"]+)"', line)
        if not m:
            continue
        name = m.group(1)
        if any(name.lower() == n.lower() for n in DSH_PROCESS_NAMES):
            if name not in found:
                found.append(name)
    return found


def tree_stats(root: Path) -> tuple[int, int]:
    """(文件数, 总字节)。不跟进 junction。"""
    n = 0
    total = 0
    stack = [root]
    while stack:
        cur = stack.pop()
        try:
            entries = list(os.scandir(cur))
        except OSError:
            continue
        for e in entries:
            p = Path(e.path)
            try:
                if e.is_dir(follow_symlinks=False):
                    if not is_reparse(p):
                        stack.append(p)
                elif e.is_file(follow_symlinks=False):
                    n += 1
                    total += e.stat(follow_symlinks=False).st_size
            except OSError:
                continue
    return n, total


def is_inside(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except (ValueError, OSError):
        return False


def detect_dsh_home() -> Path:
    env = os.environ.get("DSH_HOME")
    if env:
        return Path(env)
    up = os.environ.get("USERPROFILE") or str(Path.home())
    return Path(up) / ".dsh"


def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    try:
        ans = input(f"{prompt}{suffix}: ").strip()
    except (EOFError, KeyboardInterrupt):
        say()
        raise SystemExit(130)
    return ans or default


def ask_yes(prompt: str, default: bool = False) -> bool:
    d = "Y/n" if default else "y/N"
    try:
        ans = input(f"{prompt} [{d}]: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        say()
        raise SystemExit(130)
    if not ans:
        return default
    return ans in ("y", "yes", "是")


def pick(prompt: str, options: list[str], default_index: int = 0) -> int:
    say(C.bold(prompt))
    for i, o in enumerate(options, 1):
        mark = C.green("→") if i - 1 == default_index else " "
        say(f"  {mark} {C.bold(str(i))}) {o}")
    while True:
        raw = ask("选择", str(default_index + 1))
        try:
            idx = int(raw) - 1
            if 0 <= idx < len(options):
                return idx
        except ValueError:
            pass
        bad("请输入选项编号")


# ---------------------------------------------------------------------------
# robocopy 封装
# ---------------------------------------------------------------------------

def run_robocopy(src: Path, dst: Path, *, excludes: tuple[str, ...] = (),
                 mirror: bool = True, dry: bool = False,
                 extra: tuple[str, ...] = ()) -> int:
    """执行 robocopy。返回退出码（0–7 为成功，>=8 有错误）。

    固定使用 /XJ（排除 junction）：junction 由 manifest 记录、还原时重建，
    绝不让 robocopy 跟进它。
    """
    dst.mkdir(parents=True, exist_ok=True)
    cmd: list[str] = ["robocopy", str(src), str(dst)]
    cmd += ["/MIR"] if mirror else ["/E"]
    cmd += ["/XJ"]                      # 不跟进 junction / symlink
    cmd += ["/COPY:DAT", "/DCOPY:DAT"]  # 数据+属性+时间戳（不需要审计 ACL）
    cmd += ["/R:2", "/W:2"]             # 少重试，快速失败
    cmd += ["/NFL", "/NDL", "/NP", "/NJH", "/NJS"]
    cmd += ["/XD", *[str(src / e) for e in excludes]] if excludes else []
    cmd += list(extra)
    if dry:
        cmd += ["/L"]
    log("robocopy: " + " ".join(cmd))
    rc, out, err = run_text(cmd, timeout=3600)
    if out.strip():
        log("robocopy stdout:\n" + out.strip()[:4000])
    if err.strip():
        log("robocopy stderr:\n" + err.strip()[:2000])
    return rc


def robocopy_ok(code: int) -> bool:
    return code < 8


def robocopy_summary(code: int) -> str:
    bits = []
    if code & 1: bits.append("有文件被复制")
    if code & 2: bits.append("有多余项被移除")
    if code & 4: bits.append("有不匹配项")
    if code & 8: bits.append("有复制失败")
    if code & 16: bits.append("严重错误")
    return ", ".join(bits) if bits else "无变化"


# ---------------------------------------------------------------------------
# manifest
# ---------------------------------------------------------------------------

def critical_hashes(root: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for rel in CRITICAL_PATHS:
        p = root / rel
        if p.is_file():
            try:
                out[rel] = sha256(p)
            except OSError as exc:
                out[rel] = f"ERROR:{exc}"
    return out


def write_manifest(dest: Path, data: dict) -> Path:
    p = dest / MANIFEST_NAME
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return p


def read_manifest(backup_dir: Path) -> dict | None:
    p = backup_dir / MANIFEST_NAME
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log(f"read_manifest failed: {exc}")
        return None


def find_backups(root: Path) -> list[tuple[Path, dict]]:
    """扫描 root 下所有含 manifest 的备份目录。"""
    out: list[tuple[Path, dict]] = []
    if not root.is_dir():
        return out
    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            continue
        m = read_manifest(entry)
        if m is not None:
            out.append((entry, m))
    return out


# ---------------------------------------------------------------------------
# 备份
# ---------------------------------------------------------------------------

def do_backup(src: Path, to_dir: Path, name: str, *, slim: bool, assume_yes: bool) -> int:
    hr("备份")
    say(f"  源        : {C.bold(str(src))}")
    say(f"  目标      : {C.bold(str(to_dir / name))}")
    say(f"  模式      : {C.bold('精简（排除 ' + ', '.join(SLIM_EXCLUDES) + '）' if slim else '完整')}")
    say()

    if not src.is_dir():
        bad(f"源目录不存在: {src}")
        return 1
    if is_inside(to_dir, src):
        bad(f"目标目录位于源目录内部: {to_dir}")
        bad("这会复制自己，导致无限增长。请选择源目录之外的位置。")
        return 1
    if is_inside(src, to_dir / name):
        bad("备份目录不能是源目录的父级")
        return 1

    running = dsh_running()
    if running:
        warn(f"检测到 DSH 正在运行: {', '.join(running)}")
        warn("运行中的 DSH 会持续写盘（sessions 等），可能导致快照不自洽、部分文件被锁定。")
        if not assume_yes and not ask_yes("仍然继续备份？", default=False):
            say("已取消。建议先退出 DSH 再备份。")
            return 1
    else:
        ok("DSH 未运行（这是最干净的备份状态）")

    dest = to_dir / name
    if dest.exists():
        if not assume_yes and not ask_yes(f"目标已存在 {dest}，覆盖它？", default=False):
            return 1

    open_log(to_dir / LOG_NAME)

    # junction 必须在 robocopy 之前记录（/XJ 会跳过它们）
    say()
    info("扫描 junction / symlink ...")
    juncs = find_junctions(src)
    dangling = [j for j in juncs if not target_exists(j.get("target"))]
    if not juncs:
        info("  （无）")
    else:
        info(f"  共 {len(juncs)} 个" + (f"，其中 {len(dangling)} 个指向已不存在的目标（悬空，属环境原有状态）" if dangling else ""))
        for j in juncs[:5]:
            info(f"    {j['path']}  ->  {j['target']}")
        if len(juncs) > 5:
            info(f"    ... 其余 {len(juncs) - 5} 个已记入 manifest")

    excludes = SLIM_EXCLUDES if slim else ()
    say()
    info(f"开始复制（{'精简' if slim else '完整'}）...")
    t0 = time.time()
    code = run_robocopy(src, dest, excludes=excludes, mirror=True)

    # 复制完成后，把被 /XJ 跳过的 junction 从备份里清掉（若之前残留为实体目录）
    for j in juncs:
        stale = dest / j["path"]
        if stale.exists() and not is_reparse(stale):
            shutil.rmtree(stale, ignore_errors=True)

    files, size = tree_stats(dest)
    elapsed = time.time() - t0

    say()
    if robocopy_ok(code):
        ok(f"复制完成: {files:,} 文件, {human(size)}, {elapsed:.1f}s  (robocopy rc={code})")
    else:
        bad(f"复制有错误: robocopy rc={code} ({robocopy_summary(code)})")

    info("校验关键文件哈希 ...")
    crit = critical_hashes(src)
    crit_backup = critical_hashes(dest)
    mismatched = [k for k in crit if crit.get(k) != crit_backup.get(k)]
    for k in crit:
        if crit.get(k) == crit_backup.get(k):
            ok(k)
        else:
            bad(f"{k}  (源 {crit.get(k, 'missing')[:12]}... vs 备份 {crit_backup.get(k, 'missing')[:12]}...)")

    manifest = {
        "tool": "dsh-env-backup.py",
        "manifestVersion": 1,
        "createdAt": datetime.now().astimezone().isoformat(),
        "name": name,
        "source": str(src),
        "mode": "slim" if slim else "full",
        "excludes": list(excludes),
        "robocopyExitCode": code,
        "files": files,
        "bytes": size,
        "junctions": juncs,
        "junctionsDangling": len(dangling),
        "criticalHashes": crit,
        "criticalMismatches": mismatched,
        "verified": not mismatched and robocopy_ok(code),
        "dshWasRunning": bool(running),
        "restoreExcludesDefault": list(RESTORE_ALWAYS_EXCLUDE),
    }
    mp = write_manifest(dest, manifest)

    say()
    hr("备份结果")
    if manifest["verified"]:
        say(f"  {C.green('备份完成且校验通过')}")
    else:
        say(f"  {C.red('备份已完成，但校验未通过')}")
    say(f"  位置  : {dest}")
    say(f"  清单  : {mp.name}")
    say(f"  文件  : {files:,} 个, {human(size)}")
    say(f"  junction: {len(juncs)} 个（已记录目标，还原时重建）")
    say()
    say(f"  还原命令:  python {Path(__file__).name} restore --from \"{dest}\"")
    return 0 if manifest["verified"] else 2


# ---------------------------------------------------------------------------
# 还原
# ---------------------------------------------------------------------------

def do_restore(src_home: Path, backup_dir: Path, *, assume_yes: bool,
               include_runtimes: bool, snapshot: bool = True,
               force_running: bool = False, drop_dangling: bool = False) -> int:
    hr("还原")
    m = read_manifest(backup_dir)
    if m is None:
        bad(f"不是有效的备份目录（缺少 {MANIFEST_NAME}）: {backup_dir}")
        return 1

    say(f"  备份      : {C.bold(backup_dir.name)}")
    say(f"  创建时间  : {m.get('createdAt', '?')}")
    say(f"  原始源    : {m.get('source', '?')}")
    say(f"  模式      : {m.get('mode', '?')}   文件 {m.get('files', 0):,} 个, {human(m.get('bytes', 0))}")
    say(f"  还原到    : {C.bold(str(src_home))}")
    juncs = m.get("junctions", [])
    dangling = [j for j in juncs if not target_exists(j.get("target"))]
    say(f"  junction  : {len(juncs)} 个将重建" + (
        f"（{len(dangling)} 个目标已不存在）" if dangling else ""))
    for j in juncs[:4]:
        info(f"  {j['path']}  ->  {j['target']}")
    if len(juncs) > 4:
        info(f"  ... 其余 {len(juncs) - 4} 个见 manifest")
    say()

    if not src_home.is_dir():
        bad(f"还原目标不存在: {src_home}")
        return 1

    running = dsh_running()
    if running:
        bad(f"DSH 正在运行: {', '.join(running)}")
        bad("还原必须在 DSH 完全退出后进行，否则文件被占用、还原必然不完整。")
        if not force_running:
            say(f"  请退出 DSH 后重试。（也可以先只做校验：python {Path(__file__).name} verify --from \"{backup_dir}\"）")
            say(f"  确实无法退出时可用 {C.bold('--force')} 跳过此检查，但要接受还原可能不完整。")
            return 1
        warn("--force 已指定：跳过 DSH 运行检查。还原可能因文件占用而不完整。")
        if not assume_yes and not ask_yes("确定继续？", default=False):
            return 1
    else:
        ok("DSH 未运行")

    # 自我保护：本工具很可能跑在 <DSH_HOME>\dsh-runtimes 里的 python 上
    me = Path(sys.executable)
    if is_inside(me, src_home):
        warn(f"本工具运行在还原目标内部: {me}")
        if not include_runtimes:
            ok("已自动排除 dsh-runtimes（否则会试图覆盖正在执行的解释器）")
        else:
            bad("你显式要求包含 dsh-runtimes，但这会覆盖正在运行的解释器，几乎必然失败。")
            if not assume_yes and not ask_yes("仍然继续？", default=False):
                return 1

    excludes: list[str] = []
    if not include_runtimes:
        excludes += list(RESTORE_ALWAYS_EXCLUDE)

    say()
    say(C.yellow("将要发生:"))
    say(f"  1. 把当前 {src_home} 快照到 {src_home.parent / (backup_dir.name + '.pre-restore-' + datetime.now().strftime('%Y%m%d-%H%M%S'))}")
    say(f"  2. 用 /MIR 把备份镜像回 {src_home}" + (f"（排除 {', '.join(excludes)}）" if excludes else ""))
    say(f"  3. 重建 {len(juncs)} 个 junction" + (
        f"（其中 {len(dangling)} 个目标已不存在，将按原样重建）" if dangling else ""))
    say(f"  4. 逐字节校验 {len(m.get('criticalHashes', {}))} 个关键文件")
    say()
    say(C.red(C.bold("这一步会覆盖你当前的 DSH 配置。")))

    if not assume_yes:
        want = ask(f"输入备份名 {C.bold(backup_dir.name)} 以确认")
        if want != backup_dir.name:
            say("输入不匹配，已取消。")
            return 1

    open_log(src_home.parent / LOG_NAME)

    # --- 1. 还原前快照 ---
    pre_dir = None
    if snapshot:
        pre_dir = src_home.parent / f"{backup_dir.name}.pre-restore-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        say()
        info(f"快照当前状态到 {pre_dir} ...")
        code = run_robocopy(src_home, pre_dir, excludes=tuple(excludes), mirror=True)
        if robocopy_ok(code):
            f, s = tree_stats(pre_dir)
            pf = find_junctions(src_home)
            write_manifest(pre_dir, {
                "tool": "dsh-env-backup.py", "manifestVersion": 1,
                "createdAt": datetime.now().astimezone().isoformat(),
                "name": pre_dir.name, "source": str(src_home),
                "mode": "auto pre-restore snapshot", "excludes": list(excludes),
                "robocopyExitCode": code, "files": f, "bytes": s,
                "junctions": pf, "criticalHashes": critical_hashes(src_home),
                "criticalMismatches": [], "verified": True, "dshWasRunning": False,
                "autoSnapshot": True,
            })
            ok(f"快照完成: {f:,} 文件, {human(s)}")
            say(f"  {C.dim('撤销这次还原：')}python {Path(__file__).name} restore --from \"{pre_dir}\"")
        else:
            bad(f"还原前快照失败 (rc={code})")
            if not ask_yes("快照失败，仍要继续还原？这会让当前状态无法回退", default=False):
                return 1

    # --- 2. 摘除目标里的 junction（关键安全步骤）---
    say()
    info("摘除目标目录中的 junction（只删链接，不碰目标内容）...")
    removed, unremovable = 0, []
    to_remove = {j["path"]: j for j in find_junctions(src_home)}
    for j in juncs:                       # 清单兜底：备份里记录但扫描漏掉的
        to_remove.setdefault(j["path"], j)
    for path, j in sorted(to_remove.items()):
        if remove_link_only(src_home / path):
            removed += 1
        else:
            unremovable.append(path)
    info(f"  已摘除 {removed} 个" + ("（未触碰任何链接目标）" if removed else ""))
    for path in unremovable:
        warn(f"  无法摘除 {path}，/MIR 可能会误删它的目标内容")

    # --- 3. 镜像还原 ---
    say()
    info("镜像还原 ...")
    t0 = time.time()
    code = run_robocopy(backup_dir, src_home, excludes=tuple(excludes), mirror=True)
    elapsed = time.time() - t0
    if robocopy_ok(code):
        ok(f"镜像完成 (rc={code}, {elapsed:.1f}s)")
    else:
        bad(f"镜像有错误 (rc={code}: {robocopy_summary(code)})")

    # --- 4. 重建 junction ---
    #
    # 默认**忠实重建全部**，包括目标已不存在的悬空 junction：那是环境本来的状态，
    # 而 Windows 允许 junction 指向不存在的路径。--drop-dangling 则相反，把悬空项
    # 当作残留清理掉（更适合"我想要一个干净环境"的诉求）。
    say()
    info("重建 junction ...")
    rebuilt, failed, dropped = 0, [], 0
    for j in juncs:
        if not j.get("target"):
            failed.append(f"{j['path']} (清单里没有目标)")
            continue
        missing = not target_exists(j["target"])
        if missing and drop_dangling:
            dropped += 1
            continue
        if make_junction(src_home / j["path"], j["target"]):
            rebuilt += 1
        else:
            failed.append(f"{j['path']} -> {j['target']}")
            warn(f"重建失败: {j['path']} -> {j['target']}")
    if not juncs:
        info("  （备份里没有 junction）")
    else:
        note = f"  已重建 {rebuilt}/{len(juncs)} 个"
        if missing := len(dangling):
            note += f"，其中 {missing} 个目标不存在（按原样保留）" if not drop_dangling \
                else f"，已按 --drop-dangling 丢弃 {dropped} 个悬空项"
        ok(note)

    # --- 5. 校验 ---
    say()
    info("校验关键文件 ...")
    expect = m.get("criticalHashes", {})
    actual = critical_hashes(src_home)
    mismatched = []
    for rel, h in expect.items():
        if actual.get(rel) == h:
            ok(rel)
        else:
            bad(f"{rel}")
            mismatched.append(rel)
    if not expect:
        warn("备份清单里没有关键文件哈希，无法校验（可能是旧版备份）")

    # junction 还原核对
    now_juncs = {j["path"]: j["target"] for j in find_junctions(src_home)}
    intentionally_dropped = 0
    for j in juncs:
        if drop_dangling and not target_exists(j["target"]):
            intentionally_dropped += 1
            continue          # 有意丢弃，不算失败
        got = now_juncs.get(j["path"])
        if got == j["target"]:
            ok(f"junction {j['path']} 已还原")
        else:
            bad(f"junction {j['path']} 未还原（期望 {j['target']}，实得 {got}）")
            mismatched.append("junction:" + j["path"])
    if intentionally_dropped:
        info(f"（{intentionally_dropped} 个悬空 junction 按 --drop-dangling 有意丢弃，不计为失败）")

    say()
    hr("还原结果")
    if not mismatched and robocopy_ok(code):
        say(f"  {C.green('还原完成且校验通过')}")
        say(f"  现在可以启动 DSH。")
    else:
        say(f"  {C.red('还原完成，但有 ' + str(len(mismatched) + (0 if robocopy_ok(code) else 1)) + ' 项未通过')}")
        if pre_dir:
            say(f"  回退:  python {Path(__file__).name} restore --from \"{pre_dir}\"")
    return 0 if (not mismatched and robocopy_ok(code)) else 2


# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------

def do_verify(src_home: Path, backup_dir: Path, *, deep: bool) -> int:
    hr("校验")
    m = read_manifest(backup_dir)
    if m is None:
        bad(f"不是有效的备份目录: {backup_dir}")
        return 1
    say(f"  备份  : {backup_dir.name}  ({m.get('createdAt', '?')})")
    say(f"  对比  : {src_home}")
    say()

    problems = 0

    crit = m.get("criticalHashes", {})
    if crit:
        info("关键文件（与清单记录比对）:")
        for rel, h in crit.items():
            p = src_home / rel
            if not p.is_file():
                bad(f"{rel}  (缺失)")
                problems += 1
            elif sha256(p) == h:
                ok(rel)
            else:
                bad(f"{rel}  (内容不同)")
                problems += 1
    else:
        warn("清单无关键文件哈希")

    info(f"junction（共 {len(m.get('junctions', []))} 个）:")
    juncs = m.get("junctions", [])
    dangling_n = sum(1 for j in juncs if not target_exists(j.get("target")))
    junc_problems = 0
    for j in juncs:
        p = src_home / j["path"]
        if not (is_reparse(p) and junction_target(p) == j["target"]):
            bad(f"{j['path']} 未还原或目标不同（期望 {j['target']}）")
            junc_problems += 1
    problems += junc_problems
    if junc_problems == 0:
        ok(f"全部 {len(juncs)} 个 junction 都存在且指向清单记录的目标")
    # 关键的那个单独点出来，它是"链进 profile 的插件"最容易出事的地方
    for j in juncs:
        if j["path"] == "profiles/desktop/node_modules/dsh-plugin-code-quality" or "code-quality" in j["path"]:
            info(f"  {j['path']} -> {j['target']}")
    if dangling_n:
        # 悬空是合法状态（例如旧 npm 全局安装的残留），但值得知道：
        # 它意味着这些路径现在解析不到任何东西。
        info(f"其中 {dangling_n} 个的目标当前不存在（悬空）；这是环境原有状态，"
             f"还原时会按原样重建，可用 --drop-dangling 清理")

    bf, bs = tree_stats(backup_dir)
    cf, cs = tree_stats(src_home)
    say()
    info(f"备份: {bf:,} 文件, {human(bs)}")
    info(f"当前: {cf:,} 文件, {human(cs)}")
    # 备份自身含 manifest，当前含日志等，数量本就不会完全相等
    info("（数量差异属正常：manifest、日志、sessions 等会各自增长）")

    if deep:
        say()
        info("深度校验：逐文件哈希比对（可能较慢）...")
        ex = set(m.get("excludes", []))
        log(f"deep verify: excludes={sorted(ex)}")
        mism, missing = [], []
        for rel_dir in sorted(p for p in backup_dir.iterdir()
                              if p.is_dir() and p.name not in ex):
            pass
        say("  （深度校验按需实现：本版只做关键文件 + junction + 规模核对）")

    say()
    if problems == 0:
        say(f"  {C.green('校验通过')}")
        return 0
    say(f"  {C.red(f'{problems} 项未通过')}")
    return 2


# ---------------------------------------------------------------------------
# 列表
# ---------------------------------------------------------------------------

def do_list(to_dir: Path) -> int:
    hr("可用备份")
    if not to_dir.is_dir():
        bad(f"目录不存在: {to_dir}")
        return 1
    backups = find_backups(to_dir)
    if not backups:
        info(f"{to_dir} 下没有找到备份（缺少 {MANIFEST_NAME} 的目录不算）")
        return 0
    for d, m in backups:
        tag = C.green("已校验") if m.get("verified") else C.yellow("未校验")
        auto = C.dim(" [自动快照]") if m.get("autoSnapshot") else ""
        say(f"  {C.bold(d.name)}{auto}  {tag}")
        say(f"      {m.get('createdAt', '?')}   模式={m.get('mode', '?')}   "
            f"{m.get('files', 0):,} 文件 / {human(m.get('bytes', 0))}")
        say(f"      junction={len(m.get('junctions', []))}  "
            f"robocopy rc={m.get('robocopyExitCode', '?')}  "
            f"{C.dim(str(d))}")
        say()
    return 0


# ---------------------------------------------------------------------------
# 交互式菜单
# ---------------------------------------------------------------------------

def interactive() -> int:
    home = detect_dsh_home()
    say()
    say(C.bold("DSH 环境备份 / 还原工具"))
    say(C.dim(f"DSH_HOME = {home}"))
    running = dsh_running()
    if running:
        say(C.yellow(f"注意: DSH 正在运行 ({', '.join(running)}) —— 备份/还原前建议先退出"))
    else:
        say(C.dim("DSH 未运行"))

    default_to = home.parent / "dsh-backups"

    while True:
        say()
        hr("主菜单")
        idx = pick("要做什么？", [
            "备份当前环境",
            "还原某个备份",
            "校验备份与当前环境",
            "列出所有备份",
            "退出",
        ])
        say()

        if idx == 0:
            src = Path(ask("源目录（DSH_HOME）", str(home)))
            to = Path(ask("备份存到哪里", str(default_to)))
            name = ask("备份名", BACKUP_PREFIX + datetime.now().strftime("%Y%m%d-%H%M%S"))
            mode_i = pick("备份内容", [
                "完整（全部，约 600 MB）",
                "精简（排除 " + ", ".join(SLIM_EXCLUDES) + "）",
            ])
            do_backup(src, to, name, slim=(mode_i == 1), assume_yes=False)
            home, default_to = src, to

        elif idx == 1:
            to = Path(ask("备份存在哪里", str(default_to)))
            backups = find_backups(to)
            if not backups:
                bad(f"{to} 下没有找到备份")
                continue
            labels = [f"{d.name}   ({m.get('createdAt','?')[:19]}, {m.get('files',0):,} 文件, "
                      f"{'已校验' if m.get('verified') else '未校验'})" for d, m in backups]
            i = pick("还原哪一个？", labels)
            dest = Path(ask("还原到（DSH_HOME）", str(home)))
            include_rt = ask_yes("是否也还原 dsh-runtimes？（默认否，覆盖运行时会失败）", default=False)
            do_restore(dest, backups[i][0], assume_yes=False, include_runtimes=include_rt)
            home = dest

        elif idx == 2:
            to = Path(ask("备份存在哪里", str(default_to)))
            backups = find_backups(to)
            if not backups:
                bad(f"{to} 下没有找到备份")
                continue
            i = pick("校验哪一个？", [d.name for d, _ in backups])
            do_verify(Path(ask("对比哪个环境", str(home))), backups[i][0], deep=False)

        elif idx == 3:
            do_list(Path(ask("备份存在哪里", str(default_to))))

        else:
            say("再见。")
            return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="DSH 环境备份 / 还原 / 校验工具（交互式，也可脚本调用）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("用法：")[-1],
    )
    sub = ap.add_subparsers(dest="cmd")

    b = sub.add_parser("backup", help="备份")
    b.add_argument("--home", default=None, help="DSH_HOME（默认自动探测）")
    b.add_argument("--to", required=True, help="备份存储目录")
    b.add_argument("--name", default=None, help="备份名")
    b.add_argument("--slim", action="store_true", help="精简模式")
    b.add_argument("--yes", action="store_true", help="不询问")

    r = sub.add_parser("restore", help="还原")
    r.add_argument("--home", default=None, help="还原目标（默认自动探测）")
    r.add_argument("--from", dest="frm", required=True, help="备份目录")
    r.add_argument("--yes", action="store_true", help="跳过确认（危险）")
    r.add_argument("--include-runtimes", action="store_true", help="也还原 dsh-runtimes（不推荐）")
    r.add_argument("--no-snapshot", action="store_true", help="还原前不快照当前状态（不推荐）")
    r.add_argument("--force", action="store_true", help="DSH 运行中也强行还原（不推荐）")
    r.add_argument("--drop-dangling", action="store_true",
                   help="丢弃目标已不存在的 junction（默认按原样忠实重建）")

    v = sub.add_parser("verify", help="校验")
    v.add_argument("--home", default=None)
    v.add_argument("--from", dest="frm", required=True)
    v.add_argument("--deep", action="store_true")

    l = sub.add_parser("list", help="列出备份")
    l.add_argument("--to", required=True)

    args = ap.parse_args(argv)

    if args.cmd is None:
        return interactive()

    home = Path(args.home) if getattr(args, "home", None) else detect_dsh_home()

    if args.cmd == "backup":
        name = args.name or (BACKUP_PREFIX + datetime.now().strftime("%Y%m%d-%H%M%S"))
        return do_backup(home, Path(args.to), name, slim=args.slim, assume_yes=args.yes)
    if args.cmd == "restore":
        return do_restore(home, Path(args.frm), assume_yes=args.yes,
                          include_runtimes=args.include_runtimes,
                          snapshot=not args.no_snapshot,
                          force_running=args.force,
                          drop_dangling=args.drop_dangling)
    if args.cmd == "verify":
        return do_verify(home, Path(args.frm), deep=args.deep)
    if args.cmd == "list":
        return do_list(Path(args.to))
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        say("\n已中断。")
        sys.exit(130)
