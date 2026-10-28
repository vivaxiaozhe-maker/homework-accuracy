# v1.16.7 生产发布记录

日期：2026-10-28
发布提交：`0e167c4babeb7308a53d0c2327b97074e94d819b`
生产：https://xueqing.rocketacademy.com.cn
状态：**v1.16.7 已发布，线上版本生效。**

## 1. 变更与发布方式

- v1.16.6：今日概览恢复默认可见的助教异常统计与一键筛选。
- v1.16.7：看板拆分“最近作业日期”（records.date）和“最近操作时间”（audit_logs.ts），沉默优先按实际操作时间判断；`/api/state` 教务响应新增 `taActivity`，无新路由、无 schema。

采用受控顺序：生产备份 → 隔离预发布 → 后端发布与重启 → 前端静态发布 → 线上验证。

## 2. 发布前验证与备份

- 自动回归：smoke 606/606、e2e 179/179、服务端 474/474，合计 1,259 项，0 失败。
- 隔离浏览器：助教统计四种视口 32 项、日期口径两种视口 6 项，全部 PASS。
- 预发布：`/opt/xueqing-releases/v1.16.7-20261028T094234Z/`，使用生产备份 DB 和隔离测试账号，健康检查通过，`taActivity` 返回 11 行聚合结果。
- 备份目录：`/opt/xueqing-backups/20261028T094234Z/`，权限 700；代码/配置、DB 在线备份和附件均完成，敏感文件权限 600。
- 代码包 SHA-256：`a9f0a85f0a88c3f335c8df14322df10dd29db587113293ed1fc404ca4ace4c68`
- DB 备份 SHA-256：`00b7dd1f68afae99229e93ef589eeab7f11b8fe3c23af1e65c40e534c410f760`
- 附件包 SHA-256：`e5dc229096e9e0bda6631afdfa690b5641d02949fd4eb44475b9fdc88785c234`
- 备份 DB `integrity_check=ok`；发布前：435 学生、1366 成绩、333 未交、6 条投递记录。

## 3. 正式发布与线上验证

- 后端仅替换 `server/routes/state.js` 并受控重启 pm2，健康检查通过；前端替换 HTML、`js/dashboard.js`、`js/data.js`、`js/students.js` 和 `styles/main.css`。
- 首次前端检查发现 `students.js` 和 `styles/main.css` 未同步，已立即补齐并复核特性与哈希，无生产业务数据影响。
- 首页和中文入口均为 v1.16.7，`Cache-Control: no-store`；助教统计及两个日期字段代码均已生效，生产登录页显示 v1.16.7。
- 本地与生产 HTML/JS/CSS SHA-256 一致；`/api/health` 正常，pm2 在线。
- 未登录 `/api/state` 返回 401，无效登录探测返回预期 401；`/docs/*`、`/test/*` 仍 404。
- 发布前后 error log 行数 640 → 640，新增 0；数据计数保持 435 学生、1366 成绩、333 未交、6 条投递记录。
- 未发送真实微信通知，未修改生产业务数据。

## 4. 未覆盖与回滚准备

- 生产已登录 Rebecca 看板页面、真实微信/二维码/PDF、实体手机和全角色验收保持 `NOT_RUN`；`taActivity` 已在隔离生产副本中验证。
- 旧代码包、DB、附件均在上述备份目录；需要回滚时先恢复 v1.16.5 前端，再恢复后端 `state.js` 并受控重启。
- 当前未触发回滚。
