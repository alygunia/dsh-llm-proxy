#!/usr/bin/env bash
# proxy-switch.sh — 一键切换 llm-relay 走代理/直连（DSH 无需任何操作）
# 用法: scripts/proxy-switch.sh on|off|status
#   on    写状态文件 proxy  -> 重启 relay，经代理出站
#   off   写状态文件 direct -> 重启 relay，直连出站
#   status 显示当前状态与 relay 最近一次启动日志
# 多 relay 实例：给每个 unit 各调一次，或改 UNIT 变量。
set -euo pipefail

UNIT="${RELAY_UNIT:-llm-replay-opencode-go}"   # systemd 用户服务名（注意用户单名拼写就是 replay）
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$DIR/proxy-state"

log()   { journalctl --user -u "$UNIT" -n 1 --no-pager -o cat 2>/dev/null || true; }
apply() {
  printf '%s\n' "$1" > "$STATE"
  systemctl --user restart "$UNIT"
  sleep 0.5
  systemctl --user is-active "$UNIT" >/dev/null && echo "✓ relay 已切换" || { echo "✗ relay 启动失败"; exit 1; }
  echo "  $(log)"
}

case "${1:-status}" in
  on)     apply proxy ;;
  off)    apply direct ;;
  status)
    cur="$(cat "$STATE" 2>/dev/null || echo '(无状态文件，跟随服务环境)')"
    echo "状态文件: $cur"
    echo "relay 最近日志: $(log)"
    ;;
  *) echo "usage: $0 on|off|status" >&2; exit 2 ;;
esac
