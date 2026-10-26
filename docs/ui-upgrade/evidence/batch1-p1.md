# 批次 1：P1 与依赖修复实测

日期：2026-10-26
目标版本：`v1.10.0`（本地工作区，未提交/未部署）
环境：mock + 本地真实 API/临时 SQLite；全部为合成数据。

## FIX-R01：同 owner 同名组与科目事务

实现：

- `js/auth.js resolveStudentGroup`：稳定 studentId 起点，`ownerId + trim/toLowerCase + archived` 解析；重命名/删除不再跨 owner。
- `POST /api/students/subject-operation`：服务端重算完整组并核对 studentIds；单事务覆盖 records、missed、subjects、plans/setAt/firstClass/comments/advice/mock 与审计。
- 重命名保留业务/附件 ID；删除维持 records 删除、missed 软删除，磁盘附件仅在 commit 后处理。
- API 不再乐观更新，成功/失败均重取权威状态；保留快速录入上下文。

实测：

- smoke 的 R01 三项均 PASS：跨 owner 重命名隔离、`subjPlanSetAt` 平移、跨 owner 删除隔离。
- e2e 的 R01 三项均 PASS：真实 API 跨 owner 全字段隔离、计划设定日期平移、事务后段故障整体回滚。

## FIX-R02：补交事务与幂等

实现：

- `POST /api/records/makeup` + `HttpApi.makeupMissed`；同一事务创建成绩、绑定附件、处理 missed、写审计。
- `saveSlot` 补交改单请求，失败不改本地/保留输入，成功才清草稿、关闭并重取状态。
- 同 missedId + recordId + 同负载重试返回 `idempotent:true`，不重复推送；异负载或 ID 冲突拒绝。

e2e 七项均 PASS：请求失败无部分成功、原未交保持、输入保留、成功双生效、同负载幂等、异负载冲突、事务中途故障同时回滚。

## FIX-S01：依赖

实际安装版本：Express 5.2.1、body-parser 2.4.0、multer 2.5.0；`server/package.json` 与锁文件同步。

- `npm audit --cache /tmp/npm-cache-xueqing`：`found 0 vulnerabilities`。
- 服务端 M2/M3/M4 等全套通过，包含压缩 JSON 相关错误处理与上传回归；未在生产运行漏洞载荷。

## 实际命令结果

- `node test/e2e.api.js`：**175 项，PASS 175 / FAIL 0**。
- `cd server && npm test --cache /tmp/npm-cache-xueqing`：**427 项，全部 PASS**（72+143+30+30+29+11+63+28+21）。
- `node test/smoke.js`：499 项中 PASS 493；R01 全绿，剩余 6 项是批次 2 的 R03–R06，未记批次 1 全绿。
- 两个新增路由文件及前端改动均通过 `node --check`、`git diff --check`。

未执行：Git commit/push、生产部署、生产数据变更、真实通知。
