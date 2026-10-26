# v1.16.0 生产发布记录

日期：2026-10-26
发布提交：`32d1611c92d5b2e0e221234c1dad772a7d065fbe`
生产：https://xueqing.rocketacademy.com.cn
状态：**v1.16.0 已发布，线上版本与新表迁移生效。**

## 1. 发布前备份

- 目录：`/opt/xueqing-backups/20261026T072055Z/`，权限 700；代码、配置、SQLite 在线备份、附件均已保存，敏感文件权限 600。
- 代码包 SHA-256：`92eef1dfe4327481847f44da4ba16f92c1a7cafb5b0f73a3d8d8cb4b3b2ed627`
- DB 备份 SHA-256：`2e7238346d289884ad30c0b26647a268dfcddfc145b3be0070e1a680a11503ac`
- 备份 DB `integrity_check=ok`；发布前 `push_deliveries` 不存在；学生 433、成绩 1361、未交 333。

## 2. 隔离恢复与迁移验证

- 用备份 v1.15.1 代码＋DB 在 3101 端口恢复启动：健康检查通过，`restore_integrity=ok`，数据计数一致。
- v1.16.0 隔离预发布目录：`/opt/xueqing-releases/v1.16.0-20261026T072055Z/`；用生产备份 DB 在 3102 端口启动。
- 新表迁移成功：`push_deliveries=true`，`integrity=ok`；原学生/成绩/未交计数不变，无旧表删除或改写。
- 发布包 SHA-256 与本地一致；包内无 docs/test/截图/本地数据库/密钥。

## 3. 正式发布

- 后端：部署新 server 文件和路由；依赖锁未变，现场版本仍为 express 5.2.1、body-parser 2.4.0、multer 2.5.0、better-sqlite3 12.11.1。
- pm2 `xueqing` 重启成功，健康检查 `{ok:true,app:'xueqing-api'}`。
- 后端上线、前端替换前，线上旧前端仍为 v1.15.1，页面与健康检查正常。
- 迁移后生产 DB：`push_deliveries` 存在、当前 0 行，`integrity_check=ok`；学生 433、成绩 1361、未交 333 保持不变。
- 前端发布后，首页和中文入口均为 v1.16.0，`Cache-Control: no-store`，classic script 顺序正确。
- `js/data.js`、`js/auth.js`、`js/dashboard.js`、`styles/main.css`、`assets/book-icon.svg` 均 200；`/docs/*`、`/test/*` 仍 404。

## 4. 线上验证

- `/api/health` 200。
- 连续两次不存在账号登录探测均返回 HTTP 401；未创建生产账号或业务数据。
- 未登录访问 `/api/push-deliveries` 返回 401。
- 发布前后 error log 行数 640 → 640，`delta=0`，未新增代理或启动错误。
- pm2 在线；未发送真实微信通知，未执行数据清理、导入或修复。
- 真实 Safari 可打开生产 v1.16.0 登录页；当前浏览器没有保留生产登录会话，因此生产三角色已登录页面与 U04 投递列表的已认证验收保持 `NOT_RUN`，未创建生产测试账号。

## 5. 回滚准备

- 旧代码包、旧 DB、附件均在上述受控目录；`push_deliveries` 为新增表，不改旧表结构，旧代码不依赖该表。
- 若需回滚：先回前端到 v1.15.1，再恢复旧后端代码并重启；本轮通常不需要覆盖数据库，保留迁移新增表和期间新数据。
- 当前未触发回滚。
