# 前端模块索引（v1.4.0 拆分后）

前端源文件 `学生作业正确率.html`（HTML 骨架 + 全部静态 DOM/弹窗），样式与脚本外置。所有 js 均为 classic script（共享全局词法作用域），**加载顺序即执行顺序，不能调整**。无构建步骤、零依赖。

加载顺序（`学生作业正确率.html` 底部依次引入）：

## styles/main.css
全部样式（奶油薄荷主题变量、组件、响应式、动画）。无 JS 依赖。

## js/data.js
数据层与 Api 门面。内容：localStorage/sessionStorage 常量与版本号（APP_VERSION）、全局 pool/state、`uid()`、SHA-256 纯 JS 实现与密码散列、视图过滤与权限（viewState/canWriteOwner/isAdminView 等）、审计打点（logAction）、`LocalApi`（mock 实现，含播种 `_ensureSeed`）、`HttpApi`（fetch + Bearer token）、写路径帮手（apiPersist/resyncState）、模式探测与 `Api` 门面（Proxy）。
依赖：无（最底层）。被依赖：几乎所有文件。

## js/misc.js
通用工具与基础 UI 件。内容：日期/格式化、`shortSubject`/`esc`、拼音首字母映射表 `SURNAME_LETTER` 与筛选（nameLetter/toggleLetter/letterBarHtml）、逾期未交判定、页签切换 `switchTab`（含 topbar 页签标题联动）、确认弹窗 `askConfirm`、输入弹窗 `askInput`、`toast()`、数字滚动 `animateNums`、示例/备份横幅。
依赖：data.js（pool/state/权限函数）。

## js/students.js
学生侧业务页。内容：今日概览（待办/审批区渲染计划申请、已处理回溯区在 auth.js）、科目树数据源（subjectTree/localStorage 覆盖）、学生统计页（分组/图表/首字母+搜索+助教筛选联动）、销售端只读视图（mock 与服务端搜索两套）、卡内快速录入、作业打卡格子、应完成次数与审批申请提交。
依赖：data.js、misc.js。

## js/wechat.js
家长触达链路。内容：报告 HTML 构建 `reportHtml`、报告预览弹窗、PDF 生成与打印兜底（CDN 动态加载 jsPDF/html2canvas）、分享链接（复制）、服务号推送按钮（报告/模考报名/模考成绩）、家长绑定二维码弹窗、绑定管理弹窗（解绑/申请解绑）。
依赖：data.js（HttpApi/Api）、misc.js（toast/askConfirm/esc）。

## js/auth.js
账号、权限与管理页。内容：科目管理编辑器（教务，数据管理页）、微信自动推送开关卡、科目重命名、新增/编辑学生弹窗、历史学生页、登录/登出/会话恢复（doLogin/doLogout）、顶部短句、修改密码、账号管理页（创建/重置/停用）、解绑审批区（含红点合计）、已处理事项回溯、操作记录页（审计）。
依赖：data.js、misc.js、students.js（渲染函数互调）。

## js/dashboard.js
数据看板与应用初始化。内容：教务数据看板聚合与渲染（computeDash/renderDashboard/预警名单/趋势/助教下钻/学科维度）、`renderAll()`、`init()`（模式探测 /api/health、会话恢复、强制改密入口）、`__wb` 测试钩子导出。
依赖：以上全部（最后加载）。

---

## 测试桩说明
`test/smoke.js` 与 `test/e2e.api.js` 从 html 解析 `<script src>` 顺序、逐个读 js 文件拼接后 vm 执行（与原单文件等价）。新增 js 文件时只需在 html 按顺序加 script 标签，测试桩自动跟随。
