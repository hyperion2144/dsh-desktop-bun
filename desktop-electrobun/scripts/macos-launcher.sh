#!/bin/sh
# macOS 主进程 handoff：LaunchServices 必须把「真正持窗的进程」认成 App 主进程。
#
# Electrobun 原生的 launcher 会 spawn 一个 bun 子进程，自己作为 LS 主进程等待；窗口在 bun 里，
# 但 Tangrid 等按 AX 枚举应用的工具只认 LS 主进程，于是漏掉壳窗口。这里让 launcher 自己
# exec 成 bun，PID 不变，freedesktop/AppKit 看到的就是一个真正的单进程 App。
#
# 保留 native launcher 为同目录 launcher.native，更新/回滚可手工使用；本 shim 不依赖它。
set -eu

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SELF="$SELF_DIR/$(basename -- "$0")"
CONTENTS=$(CDPATH= cd -- "$SELF_DIR/.." && pwd)

# 不能留下指向自己的 launcher PID：否则运行时会把 bun 当成 launcher，重启时 spawn 错可执行文件。
unset ELECTROBUN_LAUNCHER_PID
export DSH_SHELL_LAUNCHER="$SELF"

cd "$CONTENTS/Resources"
exec "$CONTENTS/MacOS/bun" "$CONTENTS/Resources/main.js" "$@"
