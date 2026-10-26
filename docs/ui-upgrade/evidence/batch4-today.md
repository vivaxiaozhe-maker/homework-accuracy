# 批次 4：今日任务中心

日期：2026-10-26
目标版本：`v1.12.0`（本地工作区，未提交/未部署）
环境：mock、真实本地 API 临时库、Chrome/WebKit 隔离浏览器；合成数据。

## 实现与自动回归

- 三类固定分段、各组独立助教/学生科目筛选、稳定排序、默认 20 与可选 50、页码回退和空态；仅当前组当前页进入 DOM。
- 稍后/完成/搁置 API 成功后才出清，失败保留任务；搁置原因失败恢复。已处理区近 30 天全量计数、类型/搜索、20/50 分页。
- `node test/smoke.js`：**503 项，PASS 503 / FAIL 0**。
- `node test/e2e.api.js`：**177 项，PASS 177 / FAIL 0**。
- 21 条边界：首页 20、第二页 1、50 一页可达、过滤空态、末页处理回退；R01–R06 保持通过。

## 浏览器与容量

浏览器：Chrome 155.0.8059.86、Playwright WebKit 27.2；1512×716 / DPR1；macOS ARM64。每场景先记录首次操作，再测 20 次交替翻页至下一渲染帧，nearest-rank p95。

| 引擎/场景 | 首次操作 | 20 次 p95 | 预算 | 当前页/全量 | 结果 |
|---|---:|---:|---:|---|---|
| Chrome 基础 443 学生/2500 成绩 | 22.2ms | 17.7ms | 200ms | 20 / 210 待处理未交 | PASS |
| Chrome 扩展 1100 学生/10000 成绩 | 143.2ms | 136.8ms | 500ms | 20 / 490 待处理未交 | PASS |
| WebKit 基础 | 11.0ms | 15.0ms | 200ms | 20 / 210 | PASS |
| WebKit 扩展 | 49.0ms | 43.0ms | 500ms | 20 / 490 | PASS |

- 原始 20 次样本：`performance__base__chrome__v1.12.0.json`、`performance__growth__chrome__v1.12.0.json`、`performance__base__webkit__v1.12.0.json`、`performance__growth__webkit__v1.12.0.json`。
- 每页截图：`AC-T10__base__chrome__admin__1512x716__list-01.png`、`AC-T10__growth__chrome__admin__1512x716__list-02.png`（另有 WebKit 同名证据）。
- 已处理展开：`AC-T09__base__chrome__admin__1512x716__detail.png`。
- 所有场景 `errors=[]`、`horizontalOverflow=false`。大场景默认只注入内存，WebKit 不写超额 localStorage。

## 状态边界

- 未新增“最近动态”可选区，T11 不替代任务/审批。
- 本批次执行时真实 Safari 受远程自动化未开启限制；后续已通过普通 Safari 窗口补测，最终结果见 `final-verification.md`，WebKit 结果未冒充 Safari。
- 未执行 Git、生产部署、真实通知或生产数据变更。
