#!/bin/bash
# 本地实时预览（等效 VS Code Live Server）：改文件保存后浏览器自动刷新。
# 用法：
#   ./dev.sh          # 前端演示模式（mock 数据，无需后端）：http://localhost:5500
#   ./dev.sh --api    # 全栈联调：另起本地后端 :3000（本地数据库，不影响生产），/api 代理过去
# 首次运行 npx 会下载 live-server 到缓存（一次性）；--cache /tmp 绕开本机 npm 缓存目录的 root 权限残留问题
cd "$(dirname "$0")"

PROXY_ARGS=""
if [ "$1" = "--api" ]; then
  echo "==> 启动本地后端（:3000，本地库 server/data.db）"
  (cd server && PORT=3000 node index.js) &
  BACK_PID=$!
  trap 'kill $BACK_PID 2>/dev/null' EXIT
  sleep 1
  # 前端启动探测 fetch 同源 /api/health，代理到本地后端 → 自动进入 API 模式
  PROXY_ARGS="--proxy=/api:http://localhost:3000/api"
fi

echo "==> 启动前端预览：http://localhost:5500（改文件自动刷新，Ctrl+C 退出）"
npx --yes --cache /tmp/npm-cache-xueqing live-server . --port=5500 --no-browser --wait=300 \
  --ignore=server,node_modules,.git,dist,docs,test,.tools --entry-file=index.html $PROXY_ARGS
