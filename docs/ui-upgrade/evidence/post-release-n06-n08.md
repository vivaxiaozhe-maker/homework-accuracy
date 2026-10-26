# v1.16.1 通知投递追加整改记录

日期：2026-10-26
范围：追加复查任务书 N06–N08。
状态：**本地候选完成；未提交、未部署、未写生产业务数据、未发送真实通知。**

## 1. N06 响应顺序保护

- 根因：`refreshPushDeliveries` 在异步请求后无条件渲染，旧响应会覆盖新条件、页码和页大小。
- 修复：递增 `pushDeliveryReqSeq`，捕获筛选状态、页码、页大小、登录身份；只有序号和上下文仍匹配时才渲染。错误响应同样受保护；loading 不被旧响应清除；登出时序号失效并恢复默认筛选。
- 回归：
  - all→error，先回 error 后回 all，只显示 error。
  - error→sent，先回 sent 后回 error，只显示 sent。
  - 页码/每页数快速切换，旧失败不能覆盖新成功，总数/页码/页大小一致。
  - 登出后旧响应不渲染。
- 测试：`test/smoke.js` 新增 4 项断言，使用 VM 内异步桩和可控返回顺序。

## 2. N07 现有/历史定位与来源返回

- 根因：所有投递定位都走 `stats`，归档学生只会得到空工作区。
- 修复：按稳定 studentId 与 archived 分流：现有页/历史页分别定位；保留通知筛选、分页和滚动上下文，提供“返回通知投递结果”，不复用看板返回逻辑。
- 历史只读，不自动恢复学生；旧科目已改名/删除时只提示，不创建旧键。
- 回归覆盖：在服务、归档、恢复、同名跨 owner、旧科目删除、返回恢复筛选分页。
- 真实浏览器（Chrome/WebKit）：`pageTitle=历史学生`，目标学生可见，无输入/保存控件；返回为教务管理；无 JS 异常、无横向溢出。

## 3. N08 北京时间显示

- 根因：直接截断 ISO 字符串，丢失 Z 与真实时区。
- 修复：`formatPushDeliveryTime` 显式使用 `Intl.DateTimeFormat` 的 `Asia/Shanghai`，展示“北京时间 YYYY-MM-DD HH:mm”；存储仍为 UTC。
- 回归：`00:30Z → 08:30`；前一日 `23:30Z → 次日 07:30`；非法/空日期显示 `—`。
- Chrome/WebKit 实际列表显示：`北京时间 2026-10-26 08:30`。

## 4. 验证结果

| 套件 | 结果 |
|---|---|
| `node test/smoke.js` | 567 项，PASS 567 / FAIL 0 |
| `node test/e2e.api.js` | 177 项，PASS 177 / FAIL 0 |
| `cd server && npm test --cache /tmp/npm-cache-xueqing` | 472 项，PASS 472 / FAIL 0 |
| `node test/ui-upgrade-matrix.js` | 93＋7＋12，共 112 项有证据 PASS，0 项 NOT_RUN |
| `node test/ui-upgrade-fixtures.js` | 空、基础、扩展和分页边界 PASS |
| 合计自动断言 | **1,216 项 PASS，0 失败** |

浏览器证据：`post-release-n06-n08__chrome.json`、`post-release-n06-n08__webkit.json`；截图前缀 `post-release-n06-n08__*`（仅本地保留，不提交）。

## 5. 边界

- 路由仍为 59，无新增 schema；本次只改前端和测试，不改服务端权限、推送限流、历史投递或自动重试策略。
- 生产当前为 v1.16.0，v1.16.1 尚未部署；发布需另行授权并验证线上版本、真实角色和通知链路。
- 未做真实微信发送、真实二维码、PDF、生产三角色已登录验收或生产慢网测试。
