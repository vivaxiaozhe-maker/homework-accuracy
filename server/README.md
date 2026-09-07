# 学情跟踪平台 后端（xueqing-server）

Node + Express + SQLite（better-sqlite3），为前端单文件工作台提供真实 API（替换 localStorage mock）。

## 启动

```bash
cd server
npm install
npm start          # 或 npm run dev（--watch 热重载）
```

默认端口 3000，访问 `http://localhost:3000/` 打开前端，`GET /api/health` 返回 `{"ok":true}`。

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | `3000` |
| `ADMIN_INIT_PASSWORD` | 首次启动时教务管理员 admin 的初始密码 | 未设置则用 `admin123` 并打印警告 |

## 目录结构

```
server/
├── index.js      # Express 入口：helmet、JSON 解析、静态托管、健康检查、初始化管理员
├── db.js         # SQLite 连接与建表（users/students/records/missed/plan_requests/files/sessions/audit_logs）
├── data/         # SQLite 数据库文件（app.db，git 忽略）
└── uploads/      # 附件落盘目录（M4 起用，git 忽略）
```

## 里程碑进度

- [x] M1 项目骨架与数据库
- [x] M2 认证与账号 API
- [x] M3 业务数据 API（增量接口、服务端 owner 过滤、审计日志打点）
- [x] M4 附件上传
- [x] M5 前端切换 HttpApi
- [x] M6 测试与加固
- [x] M7 部署（阿里云轻量服务器，见下方运维手册）
- [ ] M8 上线

详见 `docs/backend-plan.md`。

## 运维手册（生产服务器）

部署环境：阿里云轻量应用服务器（Alibaba Cloud Linux 3），Node 20 LTS（/usr/local/node，软链至 /usr/local/bin）+ pm2 + Nginx。

### 常用命令

```bash
# 服务管理（pm2，进程名 xueqing）
pm2 list                    # 查看状态
pm2 restart xueqing         # 重启
pm2 stop xueqing            # 停止
pm2 logs xueqing            # 看日志（--lines 200 看更多）
pm2 monit                   # 资源占用

# 代码更新（拉最新代码后重装依赖并重启）
cd /opt/xueqing && git pull
# 注意：服务器直连 github.com 不稳定（Empty reply）。拉不动时的备选：
# 从本地直接传被服务的两个前端文件即可（纯前端改动无需重启服务）：
#   scp index.html 学生作业正确率.html root@47.113.184.105:/opt/xueqing/
# 后端文件（server/）变更时才需要 scp 整个 server/ 并 pm2 restart xueqing
cd server && npm ci --omit=dev
pm2 restart xueqing

# Nginx
nginx -t                    # 配置校验
systemctl reload nginx      # 改配置后热加载

# 健康检查
curl http://localhost:3000/api/health
```

### 备份与恢复

- 每天 03:17 由 crontab 执行 `/opt/xueqing/scripts/backup.sh`：打包 `server/data`（SQLite）与 `server/uploads`（附件）到 `/opt/backups/xueqing-YYYYMMDD-HHMM.tar.gz`，保留最近 30 个，日志写 `/opt/backups/backup.log`
- 手动备份：`bash /opt/xueqing/scripts/backup.sh`
- 恢复演练：停服务 → 解压备份到临时目录核对 → 将 `data/`（与 `uploads/`）覆盖回 `/opt/xueqing/server/` → `pm2 restart xueqing` → curl 健康检查
- 异地副本：当前备份在本机 `/opt/backups`，建议定期 scp 下载或挂对象存储（计划中）

### 故障排查

1. 页面打不开：先 `pm2 list` 看服务是否 online，再 `pm2 logs xueqing`；服务正常则查 Nginx（`nginx -t` + `systemctl status nginx`）
2. 外网不通但服务器本地 curl 正常：检查阿里云控制台安全组入方向规则（需放行 80/443）
3. 磁盘告警：`du -sh /opt/xueqing/server/uploads /opt/backups`；附件是存储大头，必要时挂载数据盘
