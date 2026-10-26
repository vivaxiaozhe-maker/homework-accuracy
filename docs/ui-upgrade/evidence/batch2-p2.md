# 批次 2：P2 与统计口径实测

日期：2026-10-26
目标版本：`v1.10.0`（本地工作区，未提交/未部署）
环境：mock + 本地真实 API；合成数据。

## FIX-R03

`js/auth.js renderAlumni` 复用 `gradedRecs/lastGradedRec`：历史趋势只画正常成绩点，仅无作业时最近正确率为 `—`，完成次数保留。smoke 的仅无作业最近分数与趋势两项 PASS。

## FIX-R04

`computeDash` 三项覆盖指标统一为当前在服务 studentId 集合，归档记录退出；未交登记与补交成绩计两次行为，软删除未交不计，未来记录不计已发生工作量。

- 回归夹具：1 名在服务学生计划 2 次，未交+无作业+补交共 3 次行为，另有归档学生 10 条历史记录。
- 结果：`entryCover=150%`、`perStu=3.0`，归档 10 条不再抬到 650%/13.0；允许真实超计划比例，不截断。

## FIX-R05

看板 records 来源、范围过滤、最近录入、覆盖行为和沉睡活跃统一 `date <= today`；全部历史同样排除未来，学生/历史/报告明细不变。

- 今天 1 条 + 未来 1 条：近 7 天和全部均只计 1 条，最近录入为今天。
- 旧两条三维指标断言已按已确认口径改为同一在服务集合及今天上界，不是删除或放宽断言。

## FIX-R06

`draftSave` 仅 null/undefined 删除；空字符串和纯空白均保留，现有保存成功路径继续显式传 null。两种草稿回归均 PASS。

## 实际结果

- `node test/smoke.js`：**499 项，PASS 499 / FAIL 0**。
- `node test/e2e.api.js`：**175 项，PASS 175 / FAIL 0**。
- 批次 1 后端全套 427 项已全绿；本批未改 server，候选前仍会再跑全套。
- `node --check js/auth.js js/dashboard.js js/misc.js`（分别执行）及 `git diff --check` 通过。

未执行：Git commit/push、生产部署、生产数据变更、真实通知。
