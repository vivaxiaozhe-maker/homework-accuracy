#!/bin/bash
# 学情跟踪平台一键部署：同步副本 → 冒烟测试 → 提交推送（GitHub Pages 演示站自动更新）→ scp 生产
# 用法：
#   ./deploy.sh "提交信息"              # 前端改动：同步 + 冒烟 + 提交推送 + scp 生产
#   ./deploy.sh --with-server "提交信息"  # 后端也有改动：追加 scp server/ 并 pm2 restart
#   ./deploy.sh --skip-prod "提交信息"    # 只提交推送（只更新演示站，不动生产）
#   ./deploy.sh --skip-tests "提交信息"   # 跳过冒烟测试（紧急小改时用，慎用）
set -e
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
  if [ $WITH_SERVER -eq 1 ]; then
    scp -o BatchMode=yes -r server/db.js server/index.js server/util.js server/auth.js server/routes root@47.113.184.105:/opt/xueqing/server/
    ssh -o BatchMode=yes root@47.113.184.105 'pm2 restart xueqing >/dev/null 2>&1 && sleep 2 && curl -s http://localhost:3000/api/health'
  fi
else
  echo "==> 4/5 跳过生产部署"
fi

echo "==> 5/5 验证线上"
curl -s --connect-timeout 8 https://xueqing.rocketacademy.com.cn/api/health
echo ""
VER=$(grep -o 'v[0-9]\+\.[0-9]\+\.[0-9]\+' index.html | head -1)
curl -s https://xueqing.rocketacademy.com.cn/ | grep -q "$VER" && echo "生产版本 $VER 已生效 ✓" || echo "注意：生产页面未检测到 $VER（若刚部署可稍等 CDN 刷新）"
echo "完成：演示站（Pages 自动更新）+ 生产 https://xueqing.rocketacademy.com.cn"
