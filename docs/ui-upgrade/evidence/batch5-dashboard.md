# 批次 5：完整数据看板

日期：2026-10-26
目标版本：`v1.13.0`（本地工作区，未提交/未部署）
环境：mock、Chrome/WebKit 隔离浏览器、合成大数据。

## 功能与自动回归

- `computeDash` 保持全量统计；展示分页不影响计数。新增 `buildDashIndex` 按学生/owner/日期建索引，逾期只计算一次。
- 三组预警摘要前 5＋全量总数，展开 20/50 分页；待首录同样分页。低分/逾期/沉睡/待首录均有稳定 studentId，低分科目保留完整路径。
- 固定 30 天趋势有键盘标签和完整数据表；学科支持完整路径/短名搜索、排序和 20/50 分页。
- 助教对比保持横向全集与下钻/一步回全部；D12 可选学生进展表不采用，未替代原模块。
- `node test/smoke.js`：**517 项，PASS 517 / FAIL 0**；其中新增 14 项看板专属用例：25 条名单分页、30 行趋势表、26 科分页和稳定定位/返回。
- R04/R05 当前在服务＋截至今天口径保持；`node test/e2e.api.js` 的 177 项通过（批次 4 同一路由无变化）。

## 性能与可见证据

Chrome 155.0.8059.86、WebKit 27.2；1512×716 / DPR1；macOS ARM64。每场景 20 次学科翻页交互，nearest-rank p95。

| 引擎/场景 | 首次操作 | p95 | 预算 | 当前页/总科目 | 结果 |
|---|---:|---:|---:|---|---|
| Chrome 基础 443 学生/2500 成绩 | 7.7ms | 13.1ms | 200ms | 20 / 40 | PASS |
| Chrome 扩展 1100 学生/10000 成绩 | 18.1ms | 13.0ms | 500ms | 20 / 50 | PASS |
| WebKit 基础 | 9.0ms | 14.0ms | 200ms | 20 / 40 | PASS |
| WebKit 扩展 | 13.0ms | 13.0ms | 500ms | 20 / 50 | PASS |

原始样本：`performance-dashboard__base__chrome__v1.13.0.json`、`performance-dashboard__growth__chrome__v1.13.0.json`、`performance-dashboard__base__webkit__v1.13.0.json`、`performance-dashboard__growth__webkit__v1.13.0.json`。

截图：

- 八项概览：`AC-D02__growth__chrome__admin__1512x716__01.png`。
- 完整名单 401 条、首页 20：`AC-D07__growth__chrome__admin__1512x716__01.png`。
- 30 天数据表：`AC-D08__growth__chrome__admin__1512x716__01.png`。
- 科目末页：`AC-D10__growth__chrome__admin__1512x716__01.png`。
- 助教明细：`AC-D03__growth__chrome__admin__1512x716__01.png`。

全部 `errors=[]`、`horizontalOverflow=false`。本批次执行时真实 Safari 尚未补测；后续已通过普通 Safari 窗口完成补测，见 `final-verification.md`，未将 WebKit 写成 Safari PASS。未提交、未部署、未发送真实通知。
