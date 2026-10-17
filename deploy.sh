#!/bin/bash
# 学情跟踪平台一键部署：同步副本 → 冒烟测试 → 提交推送（GitHub Pages 演示站自动更新）→ scp 生产
# 用法：
#   ./deploy.sh "提交信息"              # 前端改动：同步 + 冒烟 + 提交推送 + scp 生产
#   ./deploy.sh --with-server "提交信息"  # 后端也有改动：追加 scp server/ 并 pm2 restart
#   ./deploy.sh --skip-prod "提交信息"    # 只提交推送（只更新演示站，不动生产）
#   ./deploy.sh --skip-tests "提交信息"   # 跳过冒烟测试（紧急小改时用，慎用）
# 回滚步骤：git revert 对应 commit → 重跑本脚本（--with-server 视是否动过后端）即可；
#   后端依赖随之回滚（脚本会检测 server/package*.json 变更并在生产重装）。
set -e
set -o pipefail  # 管道吞退出码防护：node test/smoke.js | tail -1 失败即中断部署（已走查发现）
cd "$(dirname "$0")"

WITH_SERVER=0; SKIP_PROD=0; SKIP_TESTS=0; MSG=""
for arg in "$@"; do
  case "$arg" in
    --with-server) WITH_SERVER=1 ;;
    --skip-prod) SKIP_PROD=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    *) MSG="$arg" ;;
  esac
done
MSG="${MSG:-更新}"

echo "==> 1/5 同步 index.html 与 dist/"
cp 学生作业正确率.html index.html
cp 学生作业正确率.html dist/index.html

if [ $SKIP_TESTS -eq 0 ]; then
  echo "==> 2/5 冒烟测试"
  node test/smoke.js | tail -1
else
  echo "==> 2/5 跳过测试"
fi

echo "==> 3/5 提交并推送"
git add -A
git diff --cached --quiet && { echo "没有改动，无需提交"; } || git commit -m "$MSG"
git push -q

if [ $SKIP_PROD -eq 0 ]; then
  echo "==> 4/5 部署到生产服务器"
  scp -o ConnectTimeout=15 -o BatchMode=yes index.html 学生作业正确率.html root@47.113.184.105:/opt/xueqing/
  # v1.4.0 前端拆分：js/ 与 styles/ 目录同步到生产（先远端建目录，避免首次部署缺目录失败）
  # v1.5.2 页头素材：assets/ 目录同口径同步
  ssh -o ConnectTimeout=15 -o BatchMode=yes root@47.113.184.105 'mkdir -p /opt/xueqing/js /opt/xueqing/styles /opt/xueqing/assets'
  scp -o BatchMode=yes -r js styles assets root@47.113.184.105:/opt/xueqing/
  if [ $WITH_SERVER -eq 1 ]; then
    scp -o BatchMode=yes server/*.js root@47.113.184.105:/opt/xueqing/server/
    scp -o BatchMode=yes -r server/routes root@47.113.184.105:/opt/xueqing/server/
    ssh -o BatchMode=yes root@47.113.184.105 'pm2 restart xueqing >/dev/null 2>&1 && sleep 2 && curl -s http://localhost:3000/api/health'
  fi
  # v1.8.3 ENG-04 依赖门禁：--with-server 时始终同步依赖；或本次提交动了 server/package*.json 时也触发
  # （防「仓库依赖已更新、生产没装」漂移）。npm install 失败 → set -e 中断部署；安装后输出关键包版本供对照。
  DEPS_CHANGED=0
  if git diff --name-only HEAD~1 HEAD 2>/dev/null | grep -qE '^server/package(-lock)?\.json$'; then DEPS_CHANGED=1; fi
  if [ $WITH_SERVER -eq 1 ] || [ $DEPS_CHANGED -eq 1 ]; then
    echo "==> 4.5/5 同步后端依赖（package*.json 变更=$DEPS_CHANGED，with-server=$WITH_SERVER）"
    scp -o BatchMode=yes server/package.json server/package-lock.json root@47.113.184.105:/opt/xueqing/server/
    ssh -o BatchMode=yes root@47.113.184.105 'cd /opt/xueqing/server && npm install --omit=dev && pm2 restart xueqing && echo "[deps] 生产安装版本：" && npm ls express better-sqlite3 helmet multer bcryptjs express-rate-limit --depth=0 2>/dev/null'
  fi
else
  echo "==> 4/5 跳过生产部署"
fi

echo "==> 5/5 验证线上"
curl -s --connect-timeout 8 https://xueqing.rocketacademy.com.cn/api/health
echo ""
VER=$(grep -o 'v[0-9]\+\.[0-9]\+\.[0-9]\+' index.html | head -1)
# CDN 缓存可能让版本检测误报：重试 3 次（间隔 5s）再下结论
VERIFIED=0
for i in 1 2 3; do
  if curl -s https://xueqing.rocketacademy.com.cn/ | grep -q "$VER"; then VERIFIED=1; break; fi
  [ $i -lt 3 ] && sleep 5
done
[ $VERIFIED -eq 1 ] && echo "生产版本 $VER 已生效 ✓" || echo "注意：生产页面未检测到 $VER（CDN 刷新较慢，请稍后手动 curl 复核）"
echo "完成：演示站（Pages 自动更新）+ 生产 https://xueqing.rocketacademy.com.cn"
