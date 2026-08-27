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
- [ ] M2 认证与账号 API
- [ ] M3 业务数据 API（增量接口、服务端 owner 过滤、审计日志打点）
- [ ] M4 附件上传
- [ ] M5 前端切换 HttpApi
- [ ] M6 测试与加固
- [ ] M7 部署 / M8 上线

详见 `docs/backend-plan.md`。
