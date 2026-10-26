# v1.15.0 生产发布记录

日期：2026-10-26
最终发布提交：`3a302a9ad1690097478f9c58c468b62cab3e7b0e`（功能提交 `7e30aaf`＋HTML 副本同步）
生产：https://xueqing.rocketacademy.com.cn
状态：**已发布后端的依赖/代码和前端静态文件，线上版本 v1.15.0 已生效。**

## 1. 发布物与备份

- 本地三份 HTML 已同步并通过 `cmp`；smoke 527 项 PASS。发布包只含运行所需 HTML/JS/CSS/assets/server 文件，无 docs、test、截图、视觉参考、数据库或密钥。
- 发布包 SHA-256：`450f777504b91df3e1af4410ca891bb3998e1d72a880df699f6166cccfa47e0e`。
- 生产实际代码、原受控配置、SQLite 和附件已备份到服务器 `/opt/xueqing-backups/20261026T045531Z/`；目录权限 700，敏感文件未进入仓库。
- 代码包 SHA-256：`f7fd69e17dcb2f5e0af4fe91063e1d966f90c09bb667700863c52ba449f08231`。
- DB 备份 SHA-256：`3f847e468258f2c55726fc7e024ac1abac40faf12382e580b2129f91ee67ca57`。
- SQLite 使用 better-sqlite3 在线备份，`backup_integrity=ok`；`files_db=1 files_disk=1 files_missing=0`。

## 2. 隔离恢复与预发布

旧版本恢复目录：`/opt/xueqing-restore/20261026T045531Z/`。

- 旧代码＋备份 DB/附件在 3101 端口启动成功，健康检查和 `restore_integrity=ok`。
- 数据：433 学生、1360 成绩、333 未交、375 分享记录。
- 仅在隔离副本创建临时账号验证：admin state、ta owner 隔离、sales search＋state 403、附件鉴权读取、报告 H5 均 PASS。
- 验收进程已停止；临时账号、令牌和报告 token 未写入证据。

新版本预发布目录：`/opt/xueqing-releases/v1.15.0-20261026T045531Z/`。

- `npm ci --omit=dev` 成功，audit 0；express 5.2.1、body-parser 2.4.0、multer 2.5.0。
- 新版本在 3102 端口以生产备份副本运行；三角色 state/search、R01 跨 owner、R02 幂等与事务回滚、静态白名单和 no-store 均 PASS。
- 初次夹具把补交失败触发器放在 R01 前，导致预期外的 500；调整为在 R01 后注入，干净重跑全部通过。未修改产品代码，未将该夹具错误带入生产。
- 预发布进程已停止。

## 3. 正式发布与线上验证

- 保留生产 `ecosystem.config.js`、`server/data/`、`server/uploads/` 不变；未使用远端 Git reset/checkout，未清理生产业务数据。
- 后端执行 `npm ci --omit=dev` 并 pm2 restart；健康检查 `{ok:true,app:'xueqing-api'}`，`live_integrity=ok`。
- 后端发布后、前端替换前，线上旧前端仍为 v1.9.3 且页面/健康检查正常。
- 前端发布后，首页和中文入口均为 `v1.15.0`、`Cache-Control: no-store`，6 个 classic script 顺序正确。
- `js/data.js`、`styles/main.css`、`assets/book-icon.svg` 均 200；`/docs/*`、`/test/*` 均 404。
- 内置浏览器桌面和 390×844 移动视口均显示生产登录页及 v1.15.0。
- 用一个不存在的账号做登录负向探测，按预期返回 HTTP 401「账号不存在」，未创建生产账号或业务数据。
- 生产报告 H5 只读访问 PASS；附件关联 `files_db=1 missing=0`。
- 发布后数据计数保持 433 学生、1360 成绩、333 未交；pm2 `xueqing` online。
- 未发送真实微信通知，未主动生成真实二维码、分享链接或 PDF。

## 4. 未覆盖与后续事项

- `NOT_RUN`：生产三角色已认证页面的只读验收。当前没有可用的生产登录会话，未使用数据库 session、未创建生产验收账号，不能以隔离结果代替。
- `NOT_RUN`：真实微信、二维码、PDF 外部链路。
- 代理限流告警：生产 error log 曾出现 `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`；已在 v1.15.1 设置仅信任 loopback 代理并补回归，见 [`production-v1.15.1-hotfix.md`](production-v1.15.1-hotfix.md)。
- 未执行回滚，未覆盖生产 DB；旧代码和 DB 备份保留用于后续受控回滚。
