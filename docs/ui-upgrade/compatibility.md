# 兼容基线与新增事务接口约束

## 1. 核对范围与结果

基线为 `df79ea98888e01f8a89520f669e7b9baf16159bd` / `v1.9.3`，生产源入口是 `学生作业正确率.html`；`index.html`、`dist/index.html` 仍由既有部署同步逻辑生成，不作为手工修改源。

本批用任务包 [`02-接口与DOM迁移索引.json`](source/02-接口与DOM迁移索引.json) 对照当前真实文件，独立做静态计数与集合比较，并校验索引中的 8 个 SHA-256：

| 项目 | 索引数量 | 当前代码核对 | 结果 |
|---|---:|---:|---|
| 静态 DOM ID | 190 | 190，且 190 个唯一 | 集合一致，无缺失、无额外项 |
| 命名函数 | 241 | 241 | 文件＋名称集合一致 |
| 静态事件绑定 | 40 | 40 | 文件＋DOM ID＋事件集合一致 |
| 路由 | 56 | 56 | 按 `server/index.js` 挂载前缀规范化后方法＋路径＋来源一致 |
| 索引内源码哈希 | 8 | 8 | 全部匹配 |

计数说明：命名函数需同时匹配函数声明和函数表达式；`js/dashboard.js:320` 的 `window.__ready = (async function init(){...})` 是索引第 241 项。只匹配行首声明会少算 1 个，不能据此误报代码缺函数。挂在 router 根路径的 `/` 在比较时规范化为挂载路径本身，例如 `POST /api/students/`，与索引的 `POST /api/students` 是同一路由写法，不另算异常。

这些数字是静态迁移基线，不覆盖动态 DOM、运行时内联事件、异步竞态或权限行为，也不是回归通过证明。本批未执行缺陷复现或测试。

## 2. DOM、脚本和前端调用契约

### 2.1 DOM 与动态边界

- 190 个静态 ID 的完整清单位于源索引 `static_dom_ids`，本文件不复制一份容易漂移的第二清单。迁移时逐项保留；确需替换必须记录旧 ID、调用方、替代理由和回归证据。
- 关键容器包括 `#pane-today/#today-cats/#today-list/#done-zone`、`#pane-dashboard/#dash-*`、`#pane-stats/#stu-*`、`#pane-alumni/#alumni-*`、账号/教务/审计容器，以及报告、绑定、确认、输入等弹窗。
- 动态 ID/变量同样是契约：`quickEntry`、`slotEdit.refId/refType`、`slotSaving`、`today-grp-<key>`、`sl-date/sl-total/sl-correct/sl-wrongs/sl-err` 等不能因重排 DOM 丢失。索引不声称覆盖这些全部动态节点。
- 40 个 `getElementById(...).addEventListener(...)` 静态绑定与索引一致；大量内联 `onclick/oninput/onchange` 还需在对应实施批次单独保留和验证。
- 弹窗层级保持登录屏 200、业务弹窗 300、`#confirm-modal/#input-modal` 400；业务弹窗内再确认不得被遮挡。`toast` 也在 400 层，不能被新工作区覆盖。

### 2.2 classic script 顺序

`学生作业正确率.html:619-624` 当前无 `type=module`、无打包器，顺序必须原样保留：

1. `js/data.js`：常量、pool/state、权限、LocalApi/HttpApi/Api 门面；
2. `js/misc.js`：共享工具、逾期、弹窗、横幅；
3. `js/students.js`：今日、学生、录入；
4. `js/wechat.js`：报告、推送、绑定、评语/建议、模考、科目新增；
5. `js/auth.js`：账号、审批、科目维护、审计；
6. `js/dashboard.js`：看板、`renderAll` 和最终 `init`。

不能改成无序动态加载或 React 入口；新增前端能力优先放现有模块。`HttpApi._req` 以 HTTP 成功且响应体 `ok:true` 为成功，401 会清会话；新接口必须返回 JSON `{ok:true,...}` 或带适当 HTTP 状态的 `{ok:false,msg,...}`，前端只有服务端确认成功后才能做最终出清。

## 3. 原始 56 个路由基线与 B1 新增接口

下表按来源文件归并展示，方法＋完整路径与 02 索引一致；现有路由全部保留。销售无 `/api/state` 业务全集权限，搜索和写接口仍以服务端角色/owner 守卫为权威。

B1 已新增并验证 `POST /api/students/subject-operation`、`POST /api/records/makeup`，因此当前实现为 58 个路由；原 56 个接口均未删除。

| 来源 | 当前路由 |
|---|---|
| `server/routes/auth.js` | `POST /api/login`；`GET /api/me`；`POST /api/logout`；`POST /api/password` |
| `server/routes/users.js` | `GET /api/users`；`POST /api/users`；`POST /api/users/:id/reset`；`POST /api/users/:id/toggle`；`GET /api/users/:id/delete-impact`；`DELETE /api/users/:id` |
| `server/routes/state.js` | `GET /api/state` |
| `server/routes/students.js` | `POST /api/students`；`PUT /api/students/:id`；`POST /api/students/:id/archive`；`POST /api/students/:id/restore`；`POST /api/students/:id/owner`；`PUT /api/students/:id/subj-fields`；`POST /api/students/:id/bind-qr`；`GET /api/students/:id/binds`；`PUT /api/students/:id/binds/:bindId/remark`；`POST /api/students/:id/binds/:bindId/unbind`；`POST /api/students/:id/binds/:bindId/unbind-request` |
| `server/routes/records.js` | `POST /api/records`；`PUT /api/records/:id`；`DELETE /api/records/:id`；`POST /api/missed`；`POST /api/missed/:id/resolve`；`PUT /api/missed/:id`；`DELETE /api/missed/:id` |
| `server/routes/planreq.js` | `POST /api/plan/set`；`POST /api/plan-requests`；`POST /api/plan-requests/:id/cancel`；`POST /api/plan-requests/:id/review` |
| `server/routes/search.js` | `GET /api/search/students`；`GET /api/search/students/:id` |
| `server/routes/audit.js` | `GET /api/audit-logs` |
| `server/routes/files.js` | `POST /api/files`；`GET /api/files/:id`；`DELETE /api/files/:id` |
| `server/routes/reports.js` | `POST /api/reports/share`；`POST /api/reports/push`；`POST /api/reports/share/:token/revoke` |
| `server/routes/subjects.js` | `GET /api/subjects`；`PUT /api/subjects` |
| `server/routes/settings.js` | `GET /api/homework-cycle`；`PUT /api/homework-cycle` |
| `server/routes/unbind.js` | `GET /api/unbind-requests`；`POST /api/unbind-requests/:id/review` |
| `server/routes/push.js` | `GET /api/push-config`；`PUT /api/push-config`；`POST /api/push/:kind` |
| `server/routes/alerts.js` | `POST /api/alerts/action` |
| `server/routes/wechat.js` | `GET /api/wechat/callback`；`POST /api/wechat/callback` |
| `server/index.js` | `GET /api/health`；`GET /r/:token` |

## 4. FIX-R01：科目事务接口兼容约束

B1 已新增 `POST /api/students/subject-operation`，实现于 `server/routes/students.js` 并放在 `PUT /:id` 等 `/:id` 参数路由之前；`operation=rename|delete` 已通过 smoke/e2e 自动回归，证据见 `evidence/batch1-p1.md`。

- 旧 `POST/PUT /api/records`、`PUT/DELETE /api/missed/:id`、`PUT /api/students/:id/subj-fields`、`POST /api/plan/set` 不删除、不改现有调用方语义；新 UI 的科目重命名/删除走单事务接口，mock 走同一分组规则与结果路径。
- 请求必须以被点击学生的稳定 `studentId` 和精确 `studentIds` 为身份依据，并携带 `operation`、`oldSubject`、重命名时的 `newSubject`。服务端重新读取并校验：ID 全集精确、同组、同 owner、当前归档范围、操作者权限、科目名及目标冲突；不能信任前端按姓名提交的组，也不能因 admin 全量视图跨 owner。
- 分组统一为“稳定 ID 起点 → `ownerId + 规范化姓名 + 当前归档范围`”。前后端/mock 的姓名规范化必须一致；当前服务端多处使用 `TRIM(name)`，创建查重另用 `LOWER(TRIM(name))`，实施时需明确复用规则而不是再发明一种授权分组。
- 一个 SQLite 事务内覆盖 records、missed、students.subjects、subj_plans、subj_plan_set_at、subj_first_class、subj_comments、subj_advice、mock 及应写审计。任一校验或写入失败整体回滚，不保留“记录已改、计划未改”等部分成功。
- 重命名保留记录 ID、学生 ID、附件 ID 和 images/pdfs 关联；删除维持现有业务含义与审计，不得借新表单缺省数组额外清除其他科目附件。计划平移仍不绕过既有审批域。
- 前端在 `js/auth.js saveRenameSubject/deleteSubject` 接入，成功后再更新本地并 `resyncState`；失败展示错误并重取权威状态，不能以乐观更新伪装事务成功。响应至少兼容 `{ok:true}`，可向后兼容地增加 `updated` 等摘要字段。
- 关联入口 `openEditStudent/archiveGroup/restoreGroup/openTransfer/renderStats` 需复用适用分组规则；显示合并绝不构成跨 owner 授权。

## 5. FIX-R02：补交事务接口兼容约束

B1 已在 `server/routes/records.js` 新增 `POST /api/records/makeup`，前端经 `HttpApi.makeupMissed` 调用；成功、失败保留、幂等重试、异负载冲突和事务回滚均已通过 e2e，证据见 `evidence/batch1-p1.md`。

- 请求包含 `missedId`、客户端生成并贯穿的稳定 `recordId`、学生/日期/科目/成绩/noHomework 及附件内容；校验 missed、record、student 的身份和 owner 一致。ID 已用于其他学生或同 ID 对应不同负载时返回冲突，不能覆盖原记录。
- 一个事务内完成成绩创建/更新、images/pdfs 与 files.record_id 绑定、指定 missed 的 `resolved=1/resolution='made-up'/resolved_at`、审计；任一步失败均不得出清未交或留下半份成绩。
- 超时重试按相同 `missedId + recordId` 识别已提交结果并返回已存结果；不得重复生成成绩或重复出清。异学生、异负载返回 409 或明确 4xx。现有 `clientId` 冲突语义可复用，但需补足“同负载重试成功”的幂等结果。
- 现有 `POST /api/records` 和 `POST /api/missed/:id/resolve` 保留给其他调用方；新补交流不再依次发送两个写请求。普通新增/编辑作业的既有响应和自动推送行为不变。
- `js/students.js saveSlot` 补交分支改为单请求；`slotSaving` 防重复，服务端确认后才清草稿、关闭编辑器并 resync。失败保留未交行、草稿、输入和可重试状态，不提前 toast 成功。
- 微信 `push.autoHomework` 在数据库事务成功提交之后按原开关执行；推送失败或限流不回滚作业，保存结果与推送结果分开反馈。附件字节在文件系统，SQLite 事务不能代替文件系统回滚，失败清理和孤儿附件边界需另行验证。

## 6. 旧预警 kind/refKey 与数据口径

`POST /api/alerts/action` 当前只接受以下契约，新 UI 不得换 key：

| kind | refKey | 行为/限制 |
|---|---|---|
| `miss` | missed 记录稳定 ID | snooze/done/shelve；shelve 只允许此类；不删除原 missed |
| `lowAcc` | `studentId + '|' + subject` | snooze/done；首页近 7 天正常成绩低分，按学生×科目聚合，不改成看板范围平均 |
| `planStall` | `studentId + '|' + 完整科目路径` | 名称保留用于现“逾期科目”；snooze/done，存量处理状态不得复活 |

同一 `kind|refKey` 采用最新动作；snooze 当天有效、次日再现，done/shelve 退出待办并进入已处理回溯。完整科目路径不能换成展示短名。归档学生不进当前预警；未交不随时间自动升级成逾期。

## 7. 附件、报告/H5、CSP 与静态资源边界

### 附件

- 保留 `records.images/pdfs`、`files.record_id/owner_id` 和 `/api/files` 三个接口。`PUT /api/records/:id` 当前“未传 images/pdfs 则保留；传了才校验并重新绑定”的语义不能退化。
- 当前上传限制：jpg/jpeg/png/webp 图片单文件 2MB、PDF 4MB、单次最多 9 个，MIME 白名单和魔数校验；读取/删除按 owner/admin 鉴权。
- 本任务不新增上传入口，也不声称线上上传全流程已验证。历史关联和既有可读接口必须保留；表单未传附件不等于 `[]`。
- FIX-S01 依赖升级要求 `body-parser >=2.4.0`、`multer >=2.5.0` 及锁文件同步，保持同步 fileFilter、现有限流和白名单；只在隔离环境测试。

### 报告、PDF、打印与家长 H5

- 后台报告继续走 `js/wechat.js reportHtml/genReport/downloadReport/printReportDirect` 和 `#report-modal/#report-preview`；PDF 按需从 jsdelivr 加载，失败保留打印/另存为兜底。
- 打印使用 `#reportArea` 与 `styles/main.css:335-340` 的独立打印规则；后台新布局不得污染报告分页。
- 家长页是 `GET /r/:token` 服务端直出、零 JS、`server/routes/reports.js` 内联 `PAGE_CSS`，公开于 `/api` auth 守卫之外；30 天 token、撤销/过期语义保持不变。证据和日志不得泄露 token。
- 分享/推送仍限助教/教务，绑定最多 2 名有效家长；真实微信/PDF 只在授权测试环境与测试接收人验证，本批未发送。

### CSP 与静态白名单

`server/index.js:18-27` 当前 CSP 必须保持兼容：

- `script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net`；
- `script-src-attr 'unsafe-inline'`（现有内联事件依赖）；
- `style-src 'self' 'unsafe-inline'`；
- `img-src 'self' data: blob: https://mp.weixin.qq.com`（微信二维码）。

不得为了 React、图标包或远程 Google Fonts 放宽 CSP；默认系统字体栈。静态白名单仅两个 HTML 入口及 `/js/*`、`/styles/*`、`/assets/*`，保持路径穿越防护和 no-store；`docs/ui-upgrade/` 不是生产静态资源目录，不应加入白名单。
