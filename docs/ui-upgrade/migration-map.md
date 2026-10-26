# UI 完整迁移映射台账

## 1. 基线与状态口径

- 冻结基线：`main` / `df79ea98888e01f8a89520f669e7b9baf16159bd` / `v1.9.3`；本台账只做源码映射，不表示新 UI 已实现。
- 原始 93 项 Working Copy：[`source/01-完整功能对照矩阵.json`](source/01-完整功能对照矩阵.json)；逐项验收：[`source/03-逐项验收清单.json`](source/03-逐项验收清单.json)。原文件保持任务包内容不变，新增或变动功能只在本文件追加。
- 93 项 ID 唯一且与 93 条验收项一一对应：`G=10、T=11、D=12、S=23、H=5、P=6、F=2、A=6、C=6、O=4、R=4、U=4`，合计 93。
- 下表“当前基线”来自冻结源码；“目标位置”是后续实施约束，不是完成声明。所有目标状态均为 **NOT_RUN**，证据均为空；原功能已存在、原型已演示或源码已核对都不能记作新 UI `PASS`。
- 角色列是主要入口范围，最终仍以服务端守卫和 `AC-*` 场景为准。销售只读不等于可调用写接口，教务全量也不等于可发明原系统没有的入口。
- 实施批次采用已批准计划：B1 数据安全与依赖，B2 缺陷与统计口径，B3 视觉骨架，B4 今日任务中心，B5 完整看板，B6 学生/录入/历史，B7 账号/教务/审计/销售/移动端。B0 仅冻结与验收准备。

## 2. 映射方法与批次关联

1. 以矩阵 `source_path + source_anchor + line` 定位旧入口，再对照 [`source/02-接口与DOM迁移索引.json`](source/02-接口与DOM迁移索引.json) 的 DOM、函数、静态事件和路由；动态生成的 DOM、内联事件及异步行为仍需在对应批次补查。
2. 新实现必须保留稳定业务 ID、owner 权限、旧 DOM 契约和 API；新增入口追加到本台账，不删除旧行。目标位置可随实施细化，但每次变化须同步验收证据。
3. 证据命名对应 `evidence/AC-<ID>-*`；缺陷追加项使用 `evidence/FIX-<ID>-*`。自动测试、三角色截图、容量/性能记录分别留存，不能相互替代。
4. D12 是可选附加“学生学习进展表”：默认 **不采用**，避免重复 D02–D10 并增加维护面；若后续采用，只能附加且独立分页。T11“最近动态”也只是可选辅助区，不得替代任务中心。
5. 本批未做缺陷复现、浏览器检查、性能测量或生产验证，故没有 `PASS` 项。

## 3. 原 93 项逐项映射

| ID | 功能（简写） | 当前基线入口 | 主要角色 | 目标位置 / 实施批次 | 目标状态 | 证据 |
|---|---|---|---|---|---|---|
| G01 | 三角色登录、密码显隐/回车 | `js/auth.js doLogin`；`#login-*` | 三角色 | 原登录区与函数；B3/B7 | PASS（自动＋三角色浏览器） | [batch7-final](evidence/batch7-final.md) |
| G02 | 强制改密、自主改密 | `js/auth.js openPwdModal/doChangePwd`；`#pwd-*` | 三角色 | 原弹窗与 `/api/password`；B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| G03 | 会话恢复、过期、退出、停用失效 | `js/dashboard.js init`；`js/auth.js doLogout` | 三角色 | 原初始化/认证路由；B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| G04 | API 探测与故障阻断 | `js/dashboard.js init/showApiOutage`；`js/data.js detectApi` | 三角色 | 原探测及 `#api-outage`；B3/B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| G05 | 角色导航与直接切页守卫 | `js/auth.js enterApp`；`js/misc.js switchTab` | 三角色 | 保留导航 ID 与守卫；B3/B7 | PASS（Chrome/WebKit可见） | [batch3-visual](evidence/batch3-visual.md) |
| G06 | ownerId 数据/写权限隔离 | `js/data.js canWriteOwner`；服务端 `canWrite` | 三角色 | 不改授权模型；B1/B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| G07 | Api/HttpApi 持久化与失败恢复 | `js/data.js apiPersist/HttpApi._req` | 教务/助教 | 原门面；R01/R02 新接口接入；B1/B3 | PASS（自动＋事务回归） | [batch7-final](evidence/batch7-final.md) |
| G08 | 弹窗层级、Esc、焦点、取消 | `js/misc.js askConfirm/askInput`；`#confirm-modal/#input-modal` | 三角色 | 原弹窗与 200/300/400 层级；B3/B7 | PASS（自动＋焦点验证） | [batch7-final](evidence/batch7-final.md) |
| G09 | 真实日期、长文本、转义、空态 | `js/data.js todayStr`；`js/misc.js esc` | 三角色 | 系统日期与现有转义；B2/B3/B7 | PASS（自动＋长文本截图） | [batch7-final](evidence/batch7-final.md) |
| G10 | 备份提醒、环境标记、版本同步 | `js/misc.js renderBanners`；`APP_VERSION/#login-ver/#side-foot` | 三角色 | 原横幅与版本三处；B7/发布候选 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| T01 | 今日四项快速统计 | `js/students.js renderToday`；`#quick-grid` | 教务/助教 | 保留四指标；R04/R05；B2/B4 | PASS（自动＋浏览器） | [batch4-today](evidence/batch4-today.md) |
| T02 | 计划修改审批 | `js/auth.js renderPlanRequests/reviewPlanRequest` | 教务 | 原审批区与 plan-requests；B4 | PASS（自动回归） | [batch4-today](evidence/batch4-today.md) |
| T03 | 家长解绑审批 | `js/auth.js renderUnbindRequests/reviewUnbindReq` | 教务 | 原审批区与 unbind-requests；B4 | PASS（自动回归） | [batch4-today](evidence/batch4-today.md) |
| T04 | 未交/逾期/低分三类计数切换 | `js/students.js renderToday`；`#today-cats` | 教务/助教 | 固定分段、全量计数；B4 | PASS（自动＋浏览器） | [batch4-today](evidence/batch4-today.md) |
| T05 | 类内真实助教筛选/计数/空态 | `js/students.js todayTaSet/renderToday` | 教务 | 每组独立筛选，完整可选；B4 | PASS（自动回归） | [batch4-today](evidence/batch4-today.md) |
| T06 | 未交逐条列表与稳定排序 | `js/students.js renderToday`；missed `id` | 教务/助教 | 全量聚合后分页，保留记录身份；B4 | PASS（自动＋容量） | [batch4-today](evidence/batch4-today.md) |
| T07 | 稍后/搁置及次日恢复 | `js/students.js alertSnooze/alertShelve` | 教务/助教 | 原 kind/refKey，确认后出清；B4 | PASS（自动＋API失败） | [batch4-today](evidence/batch4-today.md) |
| T08 | 完成预警、原因及角色差异 | `js/students.js alertDone`；`resolveMissed/removeMissed` | 教务/助教 | 原角色出口；B4 | PASS（自动回归） | [batch4-today](evidence/batch4-today.md) |
| T09 | 近 30 天已处理回溯 | `js/auth.js renderDoneZone`；`#done-zone` | 教务/助教 | 默认收起、全量总数、筛选分页；B4 | PASS（自动＋浏览器） | [batch4-today](evidence/batch4-today.md) |
| T10 | 任务搜索/分页/计数/定位 | `renderToday/pagedRows`；`#today-list` | 教务/助教 | 新增轻量分页视图状态；B4 | PASS（自动＋性能） | [batch4-today](evidence/batch4-today.md) |
| T11 | 可选最近动态辅助区 | `js/auth.js renderAudit` | 教务/助教 | 默认不新增；若加约 5 条并链接审计；B4 | PASS（不采用可选项） | [batch4-today](evidence/batch4-today.md) |
| D01 | 7/30/90/全部与助教下钻 | `js/dashboard.js renderDashboard/dashDrillTa` | 教务 | 原 `#dash-range/#dash-owner`；B5 | PASS（自动＋浏览器） | [batch5-dashboard](evidence/batch5-dashboard.md) |
| D02 | 全局概览八指标 | `js/dashboard.js computeDash`；`#dash-overview` | 教务 | 保留八项；R04/R05；B2/B5 | PASS（自动＋浏览器） | [batch5-dashboard](evidence/batch5-dashboard.md) |
| D03 | 有录入助教明细与状态 | `js/dashboard.js openTaEntryModal` | 教务 | 原 `#ta-entry-modal`；B5 | PASS（自动＋浏览器） | [batch5-dashboard](evidence/batch5-dashboard.md) |
| D04 | 范围内低分预警 | `js/dashboard.js computeDash`；`#dash-alert-low` | 教务 | 保留范围平均口径；R05；B2/B5 | PASS（自动回归） | [batch5-dashboard](evidence/batch5-dashboard.md) |
| D05 | 科目级逾期预警 | `js/misc.js subjectOverdueInfo`；`#dash-alert-miss` | 教务/助教 | 共用逾期函数与旧 planStall key；B5 | PASS（自动回归） | [batch5-dashboard](evidence/batch5-dashboard.md) |
| D06 | 沉睡与待首录名单 | `js/dashboard.js computeDash`；`#dash-alert-sleep` | 教务 | 当前状态口径、未开课排除；B5 | PASS（自动＋浏览器） | [batch5-dashboard](evidence/batch5-dashboard.md) |
| D07 | 预警摘要/总数/完整名单/返回 | `js/dashboard.js dashToggleAlert/dashGotoStudent` | 教务 | 摘要前 5，完整名单分页与状态返回；B5 | PASS（自动＋容量） | [batch5-dashboard](evidence/batch5-dashboard.md) |
| D08 | 固定近 30 天录入趋势 | `js/dashboard.js computeDash`；`#dash-trend` | 教务 | 补可读文本/数据表；R05；B2/B5 | PASS（自动＋浏览器） | [batch5-dashboard](evidence/batch5-dashboard.md) |
| D09 | 助教维度完整对比与下钻 | `js/dashboard.js computeDash/renderDashboard`；`#dash-tas` | 教务 | 横向全集；R04/R05；B2/B5 | PASS（自动回归） | [batch5-dashboard](evidence/batch5-dashboard.md) |
| D10 | 一级学科与具体科目统计 | `js/dashboard.js renderDashboard`；`#dash-cats/#dash-subs` | 教务 | 完整路径 key，搜索排序分页；B5 | PASS（自动＋性能） | [batch5-dashboard](evidence/batch5-dashboard.md) |
| D11 | 指标口径与筛选范围提示 | `js/dashboard.js computeDash/renderDashboard` | 教务 | 明确当前状态/历史区间/在服务范围；B2/B5 | PASS（自动＋文案核对） | [batch5-dashboard](evidence/batch5-dashboard.md) |
| D12 | 可选学生进展附加表 | 仅原型 `App.jsx` 演示 | 教务 | 默认不采用；若采用不得替代 D02–D10；B5 | PASS（不采用可选项） | [batch5-dashboard](evidence/batch5-dashboard.md) |
| S01 | 学生搜索/首字母/组合计数清除 | `js/students.js renderStats`；`#stu-search/#stu-letter-bar` | 教务/助教/销售 | 保留筛选契约；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| S02 | 常显动态助教筛选 | `js/students.js renderStats/setStuTaFilter` | 教务 | 真实账号生成完整选项；B6 | PASS（自动＋浏览器） | [batch6-students](evidence/batch6-students.md) |
| S03 | 科目平均正确率图表 | `js/students.js toggleBarChart/renderStats` | 教务/助教 | 原 `#stats-chart-card/#bar-chart`；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| S04 | 稳定排序、同 owner 同名组隔离 | `js/students.js renderStats` | 教务/助教/销售只读 | 稳定 studentId，不按姓名授权；B1/B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| S05 | 新增/编辑学生与届别查重 | `js/auth.js openEditStudent`；`#stu-modal` | 教务/助教 | 原新增/编辑弹窗；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| S06 | 教务转移归属及关联 | `js/auth.js openTransfer`；`POST /:id/owner` | 教务 | 原转移接口与审计；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| S07 | 多科目全集/三级路径/切换 | `js/students.js subjectItems/renderStats` | 三角色（销售只读） | 连续学生工作区，保留科目全集；B6 | PASS（自动＋浏览器） | [batch6-students](evidence/batch6-students.md) |
| S08 | 科目新增/重命名/删除及关联迁移 | `js/wechat.js confirmAddSubject`；`js/auth.js saveRenameSubject/deleteSubject` | 教务/助教 | R01 事务接口＋原入口；B1/B6 | PASS（自动＋事务回归） | [batch6-students](evidence/batch6-students.md) |
| S09 | 学生×科目计划、首课、0 计划 | `js/students.js savePlanCount`；`POST /api/plan/set` | 教务/助教 | 原审批域和 JSON 键；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| S10 | 计划修改申请/撤回/审批 | `js/students.js openPlanRequest`；plan-requests | 教务/助教 | 原申请审批流；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| S11 | 首课日期编辑、允许未来开课 | `js/students.js saveFirstClass/editFirstClass` | 教务/助教 | 保留未来开课；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| S12 | 四态打卡槽位与超计划记录 | `js/students.js checkinGridHtml/subjectItems` | 三角色（销售只读） | 原槽位与稳定身份；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| S13 | 四字段录入、计算与校验 | `js/students.js slotEditHtml/saveSlot/slCalc` | 教务/助教 | 2×2 等宽布局，不改校验；B6 | PASS（自动＋尺寸实测） | [batch6-students](evidence/batch6-students.md) |
| S14 | 作业查看/修改/删除、稳定 ref | `js/students.js slotEditItem/openSlot/deleteSlot` | 教务/助教 | 保留 `refId/refType`；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| S15 | 无作业切换、暂存与统计语义 | `js/students.js toggleSlotNoHw` | 教务/助教 | 四态互斥，不计评分；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| S16 | 未交登记/防冲突/无科目补录 | `js/students.js markMissedToday/openMissSubjectPicker` | 教务/助教 | 原 missed 流程；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| S17 | 未交展开补录并出清 | `js/students.js startMakeup/saveSlot` | 助教（原入口） | R02 单请求事务、失败保留；B1/B6 | PASS（自动＋事务回归） | [batch6-students](evidence/batch6-students.md) |
| S18 | 按身份隔离的持久草稿 | `js/students.js slotDraftSave`；`js/misc.js draftSave` | 教务/助教 | R06 空草稿修复＋慢响应保护；B2/B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| S19 | 学生×科目老师评语 | `js/wechat.js saveSubjectComment` | 教务/助教 | 原 subj-fields 合并接口；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| S20 | 学生×科目学习建议 | `js/wechat.js saveSubjectAdvice` | 教务/助教 | 原 subj-fields 合并接口；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| S21 | 模考预约/改期/取消/通知 | `js/wechat.js bookMockExam/cancelMockExam` | 教务/助教 | 原 mock 数据与推送开关；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| S22 | 模考分数保存/修改/清除/推送 | `js/wechat.js saveMockScore/clearMockScore` | 教务/助教 | 区分 0 与空；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| S23 | 同名组归档、原因时间、数据保留 | `js/auth.js archiveGroup` | 教务/助教 | 同 owner 组规则，数据保留；B1/B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| H01 | 历史搜索/首字母/归档时间范围 | `js/auth.js renderAlumni/setAlumniRange` | 三角色（销售只读） | 原历史筛选；B6 | PASS（自动＋浏览器） | [batch6-students](evidence/batch6-students.md) |
| H02 | 归档日期/原因/归属/学校/届别 | `js/auth.js renderAlumni`；`#alumni-list` | 三角色（销售只读） | 完整只读字段；B6 | PASS（自动＋浏览器） | [batch6-students](evidence/batch6-students.md) |
| H03 | 历史完整只读档案 | `js/auth.js renderAlumni`；服务端 `rejectArchived` | 三角色（销售只读） | 全入口禁写＋服务端守卫；B6 | PASS（自动＋服务端守卫） | [batch6-students](evidence/batch6-students.md) |
| H04 | 恢复与同名冲突处理 | `js/auth.js restoreGroup`；`POST /:id/restore` | 教务/助教 | 原恢复规则；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| H05 | 归档排除当前预警、历史仍保留 | `js/dashboard.js computeDash`；`activeStudents` | 教务/助教 | R04 当前在服务集合；B2/B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| P01 | 科目报告完整预览 | `js/wechat.js reportHtml/genReport`；`#report-preview` | 教务/助教 | 原报告函数与独立样式；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| P02 | PDF 下载与打印兜底 | `js/wechat.js downloadReport/printReportDirect` | 教务/助教 | 原按需 CDN 与打印路径；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| P03 | 30 天分享/撤销/公开 H5 | `js/wechat.js shareReportToParent`；`GET /r/:token` | 教务/助教；家长只读 | 原 token/H5 边界；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| P04 | 手动与自动微信推送反馈 | `js/wechat.js pushManual`；`server/push.js` | 教务/助教 | 保存与推送结果分离；B6/B7 | PASS（自动回归，未真实发送） | [batch6-students](evidence/batch6-students.md) |
| P05 | 二维码绑定、2 家长、备注 | `js/wechat.js openBindModal/openBindsModal` | 教务/助教 | 原绑定接口与硬限制；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| P06 | 直解/申请解绑/审批联动 | `js/wechat.js requestUnbind/unbindParent` | 教务/助教 | 原审批权限；B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| F01 | images/pdfs、文件接口、历史关联 | `server/routes/files.js`；`server/routes/records.js` | 教务/助教 | 不新增上传入口，不清历史附件；B1/B6 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| F02 | 上传限制/魔数/归属/删除影响 | `server/routes/files.js uploadMw`；`server/routes/users.js` | 教务/助教 | 保持现有限制与权限；B1/B7 | PASS（自动回归） | [batch6-students](evidence/batch6-students.md) |
| A01 | 账号分组、状态与归档人数 | `js/auth.js renderAccounts`；`GET /api/users` | 教务 | 原账号列表；B7 | PASS（自动＋浏览器） | [batch7-final](evidence/batch7-final.md) |
| A02 | 创建助教/销售与首次改密 | `js/auth.js #btn-create-ta`；`POST /api/users` | 教务 | 不新增创建教务；B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| A03 | 重置密码与旧会话吊销 | `js/auth.js resetUserPwd`；`POST /:id/reset` | 教务 | 原重置与会话语义；B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| A04 | 启停用及本人/最后教务保护 | `js/auth.js toggleUser`；`POST /:id/toggle` | 教务 | 原保护与会话吊销；B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| A05 | 删除影响预览七类阻断 | `js/auth.js deleteImpactText/deleteUserAccount` | 教务 | 完整影响清单，前端不代替服务端；B7 | PASS（自动＋浏览器） | [batch7-final](evidence/batch7-final.md) |
| A06 | 删除事务重检/tombstone/审计 | `server/routes/users.js DELETE /:id` | 教务 | 原事务保护，禁止新增级联；B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| C01 | 三类微信开关与独立限流 | `js/auth.js renderPushConfig`；`/api/push-config` | 教务 | 原全站按类型限流；B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| C02 | 全局作业周期 1–30 | `js/auth.js saveHomeworkCycle`；`subjectOverdueInfo` | 教务配置/全员生效 | 原设置接口与共用计算；B7 | PASS（自动＋浏览器） | [batch7-final](evidence/batch7-final.md) |
| C03 | 三级科目树整体草稿保存 | `js/auth.js renderSubjectMgmt/saveSubjectsDraft` | 教务 | 原科目树，不删历史成绩；B7 | PASS（自动＋浏览器） | [batch7-final](evidence/batch7-final.md) |
| C04 | 按角色 JSON 业务导出 | `js/auth.js buildExport`；`#btn-export` | 教务/助教 | 原 JSON；附件/配置另备；B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| C05 | mock 导入/示例与生产差异 | `js/auth.js btn-import/loadSampleData` | 教务/mock | 生产不开放 mock 清导；B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| C06 | 清理权限/影响/二次确认 | `js/auth.js clearSamples/clearSamplesOfView` | 教务/mock | 不新增生产清空接口；B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| O01 | 审计搜索/类型/时间组合 | `js/auth.js renderAudit/renderAuditApi` | 教务/助教 | 原服务端过滤；B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| O02 | 审计分页/加载更多/条件重置 | `js/auth.js renderAuditApi/auditLoadMore` | 教务/助教 | 慢响应不覆盖新条件；B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| O03 | 审计角色范围与删除身份回退 | `server/routes/audit.js GET /`；`visibleAuditLogs` | 教务/助教；销售 403 | 原服务端权限；B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| O04 | 前后值、操作人、归属快照 | `js/data.js logAction`；`server/util.js logAudit` | 教务/助教 | 保留 detail 与快照；B1/B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| R01 | 销售必须关键字才服务端搜索 | `js/students.js renderSalesApiList`；`GET /api/search/students` | 销售 | 空查询不拉全量、不取 state；B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| R02 | 销售特殊字符字面搜索 | `server/routes/search.js`；`js/students.js renderSalesApiList` | 销售 | 保留转义与请求竞态处理；B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| R03 | 销售完整只读科目/四态档案 | `js/students.js salesApiPanel/fillSalesApiPanel` | 销售 | 完整只读详情；B7 | PASS（自动＋浏览器） | [batch7-final](evidence/batch7-final.md) |
| R04 | 销售写入口与服务端隔离 | `js/auth.js enterApp`；各写路由 `requireRole/canWrite` | 销售 | 直接写 API 仍拒绝；B7 | PASS（自动回归） | [batch7-final](evidence/batch7-final.md) |
| U01 | 桌面紧凑与实际笔记本高度 | `styles/main.css`；现有侧栏/工作区 | 三角色 | 视觉 token＋自适应，无整页缩放；B3 | PASS（Chrome/WebKit 1512×716、1280×720） | [batch3-visual](evidence/batch3-visual.md) |
| U02 | sticky 上下文不互挡 | `styles/main.css .qe-title-sticky/#stu-filter-card` | 三角色 | 修正 sticky 与长内容；B6 | PASS（自动＋浏览器） | [batch6-students](evidence/batch6-students.md) |
| U03 | 手机/平板导航触控表格弹窗 | `styles/main.css @media`；`#bottombar` | 三角色 | 390/834 单栏与触控补差；B3/B7 | PASS（Chrome/WebKit 390/834） | [batch6-students](evidence/batch6-students.md) |
| U04 | 键盘/焦点/状态文字/失败/防重 | `js/misc.js toast/askConfirm`；各保存函数 | 三角色 | 可见与可访问状态、慢请求保护；B3–B7 | PASS（自动＋焦点验证） | [batch7-final](evidence/batch7-final.md) |

## 4. 本轮已确认缺陷与依赖追加项（独立于原 93 项）

以下 `FIX-*` 是台账唯一键。括号中的旧缺陷编号来自复查报告；**旧缺陷 R01–R04 与上表销售矩阵 R01–R04 只是同号，绝非同一事项**。依赖 S01 也不是学生矩阵 S01。它们均为已确认纳入范围，不代表已复现或已修复。

| 台账 ID | 原编号 | 范围与兼容目标 | 关联矩阵/批次 | 目标状态 | 证据 |
|---|---|---|---|---|---|
| FIX-R01 | 缺陷 R01 | 跨 owner 同名学生科目操作：统一按稳定 ID 起点、`ownerId + 规范化姓名 + 当前归档范围` 解析；新增科目事务接口，records/missed/subjects/plans/setAt/firstClass/comments/advice/mock 一次提交并保留附件。 | S04/S07/S08/S23/G06；B1 | PASS（自动回归） | [batch1-p1](evidence/batch1-p1.md) |
| FIX-R02 | 缺陷 R02 | 补交原子化：missedId＋稳定 recordId＋成绩/附件同事务，已提交重试返回原结果，异学生或异负载冲突；成功后再清草稿/出清，推送失败不回滚。 | S14/S17/S18/F01/G07；B1 | PASS（自动回归） | [batch1-p1](evidence/batch1-p1.md) |
| FIX-R03 | 缺陷 R03 | 历史学生最近正确率与趋势只取正常成绩，复用 `gradedRecs/lastGradedRec`；无成绩为 `—`，完成次数仍含无作业。 | H03/H05；B2 | PASS（自动回归） | [batch2-p2](evidence/batch2-p2.md) |
| FIX-R04 | 缺陷 R04 | 三项助教覆盖指标统一使用当前在服务 studentId 集合；分子分母同集合，归档退出、恢复计入，不截断 100%。 | T01/D02/D09/H05；B2 | PASS（自动回归） | [batch2-p2](evidence/batch2-p2.md) |
| FIX-R05 | 缺陷 R05 | 区间工作量、均分、最近录入、沉默、低分、学科、助教与全局指标统一加 `date <= today`；学生/历史/报告明细仍可见未来记录。 | G09/T01/D02/D04/D08/D09/D10/D11；B2 | PASS（自动回归） | [batch2-p2](evidence/batch2-p2.md) |
| FIX-R06 | 缺陷 R06 | `draftSave` 仅 null/undefined 删除；空字符串和纯空白为有效草稿，显式保存成功走 clear，保持身份隔离与慢响应保护。 | S18/S19/S20/G07；B2 | PASS（自动回归） | [batch2-p2](evidence/batch2-p2.md) |
| FIX-S01 | 依赖 S01 | `body-parser >=2.4.0`、`multer >=2.5.0`，锁文件同步；保持同步 fileFilter、现有限流/白名单，只在隔离环境验证压缩 JSON 错误与上传。 | F02/G07；B1 | PASS（自动回归） | [batch1-p1](evidence/batch1-p1.md) |

## 4.1 v1.15.1 上线后复查追加项

复查任务书的 `U01–U04` 与原 93 项 U01–U04 重号，本台账统一记为 `AUD-U01–AUD-U04`；任务书原文编号保留在“原编号”列。

| 台账 ID | 原编号 | 范围与兼容目标 | 关联矩阵/批次 | 目标状态 | 证据 |
|---|---|---|---|---|---|
| N01 | 复查 N01 | 审批通过复核 pending/归档/归属/科目存在性/旧计划；待审批时阻止科目改名删除与归档；失效申请取消并审计。 | S09/S10/S23/FIX-R01；批次1 | PASS（自动＋隔离真实 API） | [post-release-n-u](evidence/post-release-n-u.md) |
| N02 | 复查 N02 | 今日近 7 天均分与低分预警统一加 `date <= today`；未来明细保留。 | T01/D04/FIX-R05；批次2 | PASS（自动回归） | [post-release-n-u](evidence/post-release-n-u.md) |
| N03 | 复查 N03 | 预警定位显式设置稳定学生工作区；无科目也打开目标档案，清理旧编辑态。 | D05/D06/D07/S07；批次3 | PASS（自动＋浏览器） | [post-release-n-u](evidence/post-release-n-u.md) |
| N04 | 复查 N04 | 科目改名迁移 lowAcc/planStall 预警身份；删除清状态、重建不继承；mock 同步。 | D05/S08/G06；批次2 | PASS（自动＋隔离真实 API） | [post-release-n-u](evidence/post-release-n-u.md) |
| N05 | 复查 N05 | 30 天趋势所有列预留等高标签轨道，柱底对齐；0 次不浮起。 | D08；批次3 | PASS（自动＋浏览器测量） | [post-release-n-u](evidence/post-release-n-u.md) |
| AUD-U01 | 复查 U01 | 学生筛选区压缩为紧凑两行内布局，进入录入后四字段和主操作可见；移动端保留触控尺寸。 | S01/S02/S13；批次4 | PASS（浏览器四尺寸） | [post-release-n-u](evidence/post-release-n-u.md) |
| AUD-U02 | 复查 U02 | 看板按概览/趋势/助教/学科/预警分区更新；局部操作不重建概览和学科输入框，动画只在指标变化时执行。 | D02–D10；批次4 | PASS（自动＋浏览器节点检查） | [post-release-n-u](evidence/post-release-n-u.md) |
| AUD-U03 | 复查 U03 | 助教对比行改原生按钮，支持键盘 Enter、焦点恢复、就近当前范围与返回入口。 | D09/G08；批次3 | PASS（自动＋浏览器键盘） | [post-release-n-u](evidence/post-release-n-u.md) |
| AUD-U04 | 复查 U04 | 通知投递结果只读持久化、筛选、权限与定位学生；不改限流、不自动重发、不泄露 openid。 | C01/P04；批次5 | PASS（自动＋mock 微信） | [post-release-n-u](evidence/post-release-n-u.md) |

## 5. 已确认口径决定（后续验收的固定基准）

| 决定 | 固定口径 | 影响项 |
|---|---|---|
| 当前覆盖集合 | 助教三项覆盖指标的分子、分母使用同一“当前在服务学生”studentId 集合；归档同步退出、恢复同步计入；禁止用 `Math.min(...,100%)` 等截断掩盖分母问题。 | FIX-R04、D02、D09、H05 |
| 录入行为计数 | 正常成绩与无作业分别按记录计数；未交登记单独计一次；同一未交后来补交成功，未交登记和补交成绩合计两次录入；软删除未交不计。 | FIX-R04、D02、D09 |
| 未来作业 | 允许预录，学生明细继续可见；看板工作量、均分、最近录入和趋势只算 `date <= today`。“全部”是截至今天的全部历史，不包含未来已发生工作量。 | FIX-R05、D01/D02/D04/D08–D11 |
| 日期语义 | 继续按作业 `date` 归日，不把真实点击保存时间伪装成作业日期；若未来需要 `created_at` 绩效，另开需求并单独确认。未来开课、未来模考仍允许。 | FIX-R05、S11、S21、D11 |
| 评分与四态 | 无作业计完成但不进正确率/预警；未交不是 0 分；每份作业正确率简单平均，不按题量加权，空分母显示 `—`。 | R03/R04/R05 相关看板、报告与销售只读项 |

> 最终结论：原矩阵 93 项 + 缺陷/依赖追加 7 项 + v1.15.1 上线后复查追加 9 项，共 109 个目标跟踪条目均已有对应证据并记 PASS。v1.15.0 历史证据见 [`evidence/final-verification.md`](evidence/final-verification.md)；本轮 N01–N05、AUD-U01–AUD-U04 的修复与回归见 [`evidence/post-release-n-u.md`](evidence/post-release-n-u.md)。另有本节 5 项口径决定，不作为已执行验收计数。
