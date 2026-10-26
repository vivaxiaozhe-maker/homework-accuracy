# 批次 0：基线与缺陷复现记录

日期：2026-10-26
基线：`main@df79ea98888e01f8a89520f669e7b9baf16159bd` / `v1.9.3`
范围：本地源码、隔离临时 SQLite、合成数据；未连接生产写接口，未发送通知。

## 合成夹具

位置：`test/fixtures/ui-upgrade/`；读取与校验：`test/ui-upgrade-fixtures.js`。

执行：`node test/ui-upgrade-fixtures.js`，3 个场景全部 PASS。

- `00-empty`：0 学生 / 0 记录。
- `01-operating-volume`：400 在服务 + 43 归档、11 助教、2500 成绩、220 未交、40 科目、20 待批。
- `02-growth-volume`：1000 在服务 + 100 归档、11 助教、10000 成绩、500 未交、50 科目、50 待批。
- 所有场景均有 `synthetic:true` 与 `doNotImportProduction:true` 标记；owner 必须映射到隔离测试账号，不能向生产导入。

## 新回归的首次运行（修复前，预期失败）

### `node test/smoke.js`

合计 499 项：PASS 490 / FAIL 9。原有 489 项仍通过，新失败准确复现：

- R01：跨 owner 重命名影响其他助教同名学生。
- R01：重命名漏平移 `subjPlanSetAt`。
- R01：跨 owner 删除影响其他助教同名学生。
- R03：历史学生仅无作业时最近正确率假 0%，并生成无评分折线。
- R04：归档记录抬高当前在服务覆盖率，未统一 studentId 集合。
- R05：近 7 天及全部历史均纳入未来记录，最近录入取未来日期。
- R06：空字符串草稿被删除。
- R06 的纯空白字符串用例已通过，作为对照保留。

### `node test/e2e.api.js`

合计 170 项：PASS 168 / FAIL 2。原有 165 项仍通过：

- 真实 API 的跨 owner 同名学生重命名会改变另一助教的数据，复现 R01；A 的 `subjPlanSetAt` 经现有 plan/set 平移用例通过，mock 路径漏平移仍以 smoke 失败为准。
- 注入成绩创建 503 后，服务端无成绩记录但未交被错误置为 `resolved=1 / made-up`，复现 R02。输入框保留检查通过。

### 依赖

在 `server/` 执行 `npm audit --cache /tmp/npm-cache-xueqing`：2 项 high，与任务包一致：

- body-parser 2.0.0–2.3.0，需 ≥2.4.0。
- multer 2.0.0–2.4.0，需 ≥2.5.0。

只在批次 1 更新锁文件并做隔离回归；不在生产运行漏洞载荷。

## 附件入口盘点

- HTML 中唯一 `input[type=file]` 是 `#f-import`，用于 JSON 导入恢复，不是作业附件上传。
- 前端存在 `HttpApi.uploadFiles` 与 `fileUrl`，后端存在文件接口和历史 `images/pdfs` 字段；当前可见打卡表单没有附件上传控件。
- 本轮不宣称“上传全流程已走通”，不新增上传入口；后续编辑保存必须保留历史附件关联，不能用默认空数组清除。

## 后续转绿门禁

上述新用例不得删除或放宽。R01/R02 还需补事务回滚、幂等和跨 owner 全字段真实 API 用例；R03–R06 修复后重跑原有 smoke/e2e/server 全套，并记录新的实际总数。
