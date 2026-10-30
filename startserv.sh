#!/usr/bin/env bash
# WhaleGirl 服务启动/重启脚本
# 用法：./startserv.sh
# 行为：服务已在跑 → 重启；没在跑 → 启动。
# 日志：logs/server-<时间戳>.log，每次启动一个新文件，保留供排错，手动清理，例如：
#   ls -t logs/server-*.log | tail -n +21 | xargs rm -f   # 只留最近 20 份
set -u
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR" || exit 1
PID_FILE="$APP_DIR/.server.pid"
LOG_DIR="$APP_DIR/logs"
mkdir -p "$LOG_DIR"

# 找到本项目的 node server.js 进程（先看 pidfile，再按 cwd 兜底匹配）
find_pid() {
  local p
  if [ -f "$PID_FILE" ]; then
    p="$(cat "$PID_FILE" 2>/dev/null)"
    if [ -n "$p" ] && ps -p "$p" -o command= 2>/dev/null | grep -q 'node'; then
      echo "$p"; return 0
    fi
  fi
  for p in $(pgrep -f 'node server\.js' 2>/dev/null); do
    if [ "$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$APP_DIR" ]; then
      echo "$p"; return 0
    fi
  done
  return 1
}

OLD_PID="$(find_pid || true)"
if [ -n "${OLD_PID:-}" ]; then
  echo "服务运行中（pid ${OLD_PID}），重启…"
  kill "$OLD_PID" 2>/dev/null
  for _ in $(seq 1 20); do
    ps -p "$OLD_PID" >/dev/null 2>&1 || break
    sleep 0.5
  done
  if ps -p "$OLD_PID" >/dev/null 2>&1; then
    echo "未响应 SIGTERM，强制结束"
    kill -9 "$OLD_PID" 2>/dev/null
    sleep 1
  fi
  echo "旧进程已停止"
else
  echo "服务未启动，启动…"
fi

LOG_FILE="$LOG_DIR/server-$(date +%Y%m%d-%H%M%S).log"
nohup node server.js >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
sleep 2
if ps -p "$NEW_PID" >/dev/null 2>&1; then
  echo "启动成功（pid ${NEW_PID}）"
  echo "日志：$LOG_FILE"
  echo "实时查看：tail -f $LOG_FILE"
else
  echo "启动失败，最近日志："
  tail -20 "$LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi
