# 批次 6：学生与完整录入工作区

日期：2026-10-26
目标版本：`v1.14.0`（本地工作区，未提交/未部署）
环境：mock、真实本地 API、Chrome/WebKit 隔离浏览器、合成数据。

## 实现与自动回归

- `#stu-list` 为唯一双栏容器：`#stu-rows`（桌面 286px）＋`#stu-workspace`；不复制或隐藏第二份工作区。`selectStudentWorkspace` 只开档案，`quickEntry` 继续决定科目面板。
- 现有和历史助教筛选默认常显，来自真实账号；筛选、A–Z、组合计数、分组与角色范围保留。
- 四字段为 2×2 等宽网格，正确率/错误数为辅助文本；校验、四态、稳定 refId/refType、草稿和补交事务不变。
- sticky 按真实筛选高度偏移，模考控件统一高度；长文本可换行，未录入中性色与未交红色区分。
- 历史只读、R03 正常成绩过滤、报告/PDF/H5/二维码和附件关联未改；未新增上传入口。
- 补齐历史只读服务端守卫：新增/编辑/删除作业、登记未交、学生基本信息和科目字段在 archived 状态均返回 400，恢复后放行；`server/test/m3.test.js` 为 **149 项全绿**。
- `node test/smoke.js`：**522 项，PASS 522 / FAIL 0**。
- `node test/e2e.api.js`：**177 项，PASS 177 / FAIL 0**。
- 服务端全套此前 427 项通过，候选前再跑；附件接口和历史字段保持。

## 布局与性能

Chrome 155.0.8059.86、WebKit 27.2；1512×716 / DPR1；macOS ARM64。每场景 20 次打卡槽切换，nearest-rank p95。

| 引擎/场景 | 首次操作 | p95 | 预算 | 四字段实测 | 结果 |
|---|---:|---:|---:|---|---|
| Chrome 基础 443 学生/2500 成绩 | 51.2ms | 48.8ms | 200ms | 各 421×42px | PASS |
| Chrome 扩展 1100 学生/10000 成绩 | 332.7ms | 327.3ms | 500ms | 各 421×42px | PASS |
| WebKit 基础 | 33.0ms | 33.0ms | 200ms | 各 417×42px | PASS |
| WebKit 扩展 | 135.0ms | 134.0ms | 500ms | 各 417×42px | PASS |

原始样本：`performance-students__base__chrome__v1.14.0.json`、`performance-students__growth__chrome__v1.14.0.json`、`performance-students__base__webkit__v1.14.0.json`、`performance-students__growth__webkit__v1.14.0.json`。

截图：`AC-S07__base__chrome__admin__1512x716__01.png`、`AC-S13__base__chrome__admin__1512x716__01.png`、`AC-S13-responsive__chrome__ta__834x800__01.png`、`AC-H01__chrome__sales__390x844__01.png`、`AC-H01-admin__chrome__admin__1280x720__01.png`；WebKit 有对应文件。

响应式补充：834 宽助教四字段各 233×42px；390 销售历史无输入控件；1280 教务历史助教筛选可见；所有场景 `errors=[]`、`horizontalOverflow=false`。详见 `batch6-responsive-results.json`。

本批次执行时真实 Safari 尚未补测；后续已通过普通 Safari 窗口完成助教/销售等角色补测，见 `final-verification.md`，不以 WebKit 替代。未提交、未部署、未发送真实通知或生产写入。
