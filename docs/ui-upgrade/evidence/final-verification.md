# v1.15.0 最终本地验收记录

日期：2026-10-26
基线：`main@df79ea9`
范围：原功能矩阵 93 项、缺陷/依赖追加 7 项，以及已批准的 R01–R06 与统计口径决定。
状态：**本地候选验收通过；未提交、未推送、未部署、未连接生产、未发送真实通知。**

## 1. 最终自动回归

以下命令均在本轮最终工作区重新执行：

| 检查 | 实际结果 |
|---|---|
| `node test/smoke.js` | 527 项，PASS 527 / FAIL 0 |
| `node test/e2e.api.js` | 177 项，PASS 177 / FAIL 0；含 R01 跨 owner/事务回滚、R02 补交回滚与幂等 |
| `cd server && npm test --cache /tmp/npm-cache-xueqing` | 435 项，PASS 435 / FAIL 0（72 + 149 + 30 + 30 + 29 + 11 + 63 + 29 + 22） |
| `node test/ui-upgrade-matrix.js` | 93 原项 + 7 FIX，100 项有证据 PASS，0 项 NOT_RUN |
| `node test/ui-upgrade-fixtures.js` | 空场景、443 学生/2500 成绩、1100 学生/10000 成绩及 0/1/20/21/50/500 分页边界均 PASS |
| `git diff --check` | PASS |
| 所有改动 JS 的 `node --check` | PASS |
| `cd server && npm audit --cache /tmp/npm-cache-xueqing` | 0 vulnerabilities |

服务端依赖已升级为 body-parser 2.4.0、multer 2.5.0。当前共 58 个路由：原 56 个保留，新增 `POST /api/students/subject-operation` 与 `POST /api/records/makeup`；无 schema 迁移。

## 2. 容量与交互性能

Chrome 155.0.8059.86、WebKit 27.2；每场景首次操作后测量 20 次交互，nearest-rank p95。基础预算 ≤200ms，扩展预算 ≤500ms。

| 交互 | 引擎 | 基础 p95 | 扩展 p95 | 结果 |
|---|---|---:|---:|---|
| 今日任务翻页 | Chrome | 17.7ms | 136.8ms | PASS |
| 今日任务翻页 | WebKit | 15.0ms | 43.0ms | PASS |
| 看板学科翻页 | Chrome | 13.1ms | 13.0ms | PASS |
| 看板学科翻页 | WebKit | 14.0ms | 13.0ms | PASS |
| 学生打卡切换 | Chrome | 48.8ms | 327.3ms | PASS |
| 学生打卡切换 | WebKit | 33.0ms | 134.0ms | PASS |

原始样本和首次操作值见 `performance__*.json`、`performance-dashboard__*.json`、`performance-students__*.json`；过程记录见 `batch4-today.md`、`batch5-dashboard.md`、`batch6-students.md`。

## 3. 浏览器、角色与响应式

- Chrome 与 WebKit：三角色和 1512×716、1280×720、834×800、390×844 的可见检查已留证据；对应场景无 JS 异常、无横向溢出。账号删除、教务设置、焦点返回、长文本、分页和空态见 `batch7-results.json` 及各批次截图。
- 真实 Safari：未开启“允许远程自动化”，未修改系统设置；最终通过普通 Safari 窗口＋Accessibility 实际操作补测，不以 WebKit 结果替代。

真实 Safari 证据：

| 角色 | 尺寸/场景 | 证据 |
|---|---|---|
| 教务 | 1512×716 今日 | `AC-G05__safari__admin__1512x716__01.jpg` |
| 教务 | 1280×720 看板 | `AC-D02__safari__admin__1280x720__01.jpg` |
| 教务 | 834×800 响应式 | `AC-U03__safari__admin__834x800__01.jpg` |
| 教务 | 390×844 移动导航 | `AC-U03-mobile__safari__admin__390x844__01.jpg` |
| 助教 | 390×844 今日与移动导航 | `AC-U03-mobile__safari__ta__390x844__01.jpg` |
| 销售 | 390×844 现有学生及只读科目档案 | `AC-R03__safari__sales__390x844__01.jpg` |

销售实际展开 IB·数学，Accessibility 文本包含只读打卡、成绩、评语、建议和模考；页面无录入/编辑控件，截图未见横向溢出。助教实际登录后仅显示其名下任务与对应角色导航。

## 4. 兼容、统计与外部链路

- 190 个静态 DOM ID、241 个命名函数、40 个静态事件和 classic script 顺序的兼容基线保留；接口说明见 `../compatibility.md`。
- 未交/逾期/无作业/未录入四态语义、owner 权限、归档只读、同名组隔离不变。
- 覆盖指标统一当前在服务集合；未来预录不进入看板历史工作量；空草稿与空成绩语义保持。
- 附件、报告/H5、二维码、分享和推送仅做本地或隔离验证；未调用真实家长通知，未改生产数据。

## 5. 发布边界

本记录只证明本地候选满足已批准的验收范围。生产备份、恢复演练、部署、线上验证、真实外部链路、Git commit/push 均未执行，仍需按 `../release-checklist.md` 另行明确授权。源入口为 `学生作业正确率.html`；`index.html` 与 `dist/index.html` 未手工同步，留待获授权的既有发布流程处理。
