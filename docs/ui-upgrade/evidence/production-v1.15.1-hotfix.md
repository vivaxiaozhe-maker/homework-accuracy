# v1.15.1 生产热修记录

日期：2026-10-26
生产：https://xueqing.rocketacademy.com.cn
状态：**已发布，线上 v1.15.1 生效，代理限流告警不再新增。**

## 原因

生产 Nginx 从 `127.0.0.1:3000` 转发并写入 `X-Forwarded-For`，但 Express 未设置 `trust proxy`。express-rate-limit 8.6.2 因此每次登录请求写 `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`，并把所有经 Nginx 的失败登录识别为同一个 `127.0.0.1` 限流键。

## 修复

- `server/index.js` 在路由和限流器初始化前设置 `app.set('trust proxy', 'loopback')`。
- 只信任本机反代：Nginx 转发的请求按真实客户端 IP 限流；外部直连 3000 时不会信任伪造的 XFF。
- `server/test/m2.test.js` 新增回归：同一 XFF 前 10 次失败为 401、第 11 次为 429，且捕获不到 `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`。
- 版本升至 v1.15.1，三份 HTML、`APP_VERSION` 和测试断言同步。

## 回归

- 服务端全套：**436 项，PASS 436 / FAIL 0**（M2 由 72 增至 73，总数为 73＋149＋30＋30＋29＋11＋63＋29＋22）。
- smoke：**527 项，PASS 527 / FAIL 0**。
- e2e：**177 项，PASS 177 / FAIL 0**。
- 改动 JS `node --check` 和 `git diff --check` 通过。

## 发布与验证

- 发布前将当前 v1.15.0 实际代码和 SQLite 在线备份到 `/opt/xueqing-backups/20261026T060816Z/`，校验和与文件权限 600 已核对。
- 仅上传 `server/index.js`、三份 HTML 中的生产入口两份、`js/data.js`；未改依赖、配置、数据库和附件。
- pm2 `xueqing` restart 成功，健康检查 `{ok:true,app:'xueqing-api'}`，DB `integrity=ok`。
- 首页和中文入口 HTTP 200、`no-store`、版本 `v1.15.1`。
- 连续两次使用不存在的账号做公开登录负向探测，均返回预期 HTTP 401，未创建账号或业务数据。
- 生产 error log 在探测前后行数 `640 → 640`，`delta=0`；旧历史告警保留，未清日志。
- 数据计数保持 433 学生、1360 成绩、333 未交；未发送真实通知。
- 未执行生产三角色已认证页面验收（无可用生产登录会话，且未创建生产测试账号）。
