# v1.16.0 上线后复查整改记录

日期：2026-10-26
范围：复查任务书 N01–N05、AUD-U01–AUD-U04（任务书原文 U01–U04 与原矩阵重号，本台账加 `AUD-` 前缀）。
状态：**本地候选完成；未提交、未部署、未连接生产数据、未发送真实通知。**

## 1. 修复前复现

使用任务包内的隔离复现脚本，仅使用临时 SQLite、随机端口和 DOM 桩，清除微信环境变量：

- 改名后旧审批：科目已改为 AMC12，审批仍把 AMC10=12 写回，旧键复活。
- 删除后旧审批：已删除的 AMC10 计划被旧审批重新创建。
- 归档后旧审批：历史学生计划仍从 8 改为 12。
- 未来成绩：今天 2026-10-26，昨天 90%、未来 11-05 为 10%，今日均分显示 50%，并进入低分预警。
- 无科目预警定位：点击沉睡预警后右侧仍是“选择一名学生”。
- 改名后预警身份：`alert_actions.ref_key` 仍为 `student|AMC10`，已处理逾期重新出现。

## 2. 逐项修复与验收

| 台账 ID | 修复 | 验证 |
|---|---|---|
| N01 | 审批事务重读申请/学生/计划；校验 pending、归档、归属、科目存在、old_plan。待审批时阻止科目改名/删除/归档。失效申请转 `cancelled` 并审计；mock 同步；已处理区显示“已失效”。 | m3：175 项 PASS；smoke：N01 mock 改名/删除/归档拦截、失效取消、审计和已失效展示 PASS。覆盖跨 owner 同名组。 |
| N02 | 今日低分预警和近 7 天均分统一 `date >= weekAgo && date <= today`；未来记录仍保留明细。 | smoke：昨天 90%＋未来 10% → 今日 90%；未来不产生低分预警；仅未来时均分 `—`；`subjectItems` 仍含未来记录。 |
| N03 | `dashGotoStudent` 显式设置 `stuSelectedId`，清理旧编辑态；无科目也打开档案。 | smoke：指定科目和无科目均一次定位正确学生；Safari 点击沉睡预警后打开林小满档案，右侧非空。 |
| N04 | 科目改名事务迁移 lowAcc/planStall 的 `ref_key`，保留动作/时间/snooze；删除清除状态并在审计记数量；mock 同步；最新动作按 createdAt 取。 | m3：改名迁移 done/snooze、state 新键、删除计数、重建不继承均 PASS。smoke：done 和最新 snooze 改名后保持。 |
| N05 | 30 列均输出同高 `.dash-bar-track` 和 `.dash-bar-lbl` 槽，柱体在轨道内向上生长。 | Chrome/WebKit 30 列、30 标签，柱底最大差 **0px**；四宽度无横向溢出。 |
| AUD-U01 | 筛选改为紧凑网格：桌面搜索＋负责助教同排，A-Z 次级入口，条件摘要第二行；录入操作条桌面吸底。 | Chrome/WebKit：1512/1280 筛选区高 **62px**，四字段可见，主操作底部 604px＜716/720px。834/390 触控高度保持 50px，无横向溢出。 |
| AUD-U02 | 看板拆为 filters/overview/trend/tas/cats/subs/alerts 局部更新；学科结果区独立；概览动画只在指标变化时执行；输入框不重建。 | Chrome/WebKit 全宽度：趋势展开与学科搜索/翻页后概览节点 identity 不变，搜索输入节点不变；smoke 断言通过。 |
| AUD-U03 | 助教行改原生 `button`，带 `aria-pressed`、焦点样式和就近“正在查看/返回全部助教”；重绘后焦点回同一行。 | Chrome 真实键盘 Enter 下钻成功，当前范围可见，复位成功；Safari 中元素暴露为可操作 CheckBox，Space 下钻/复位，当前提示出现/隐藏。 |
| AUD-U04 | 新增 `push_deliveries` 表；推送成功/未绑定/取关/限流/失败逐接收人落库，不存 openid；新增 `GET /api/push-deliveries`；教务页面增加只读筛选列表和“定位学生”。 | m10：39 项 PASS；自动/手动、sent/unbound/rate_limited、教务全量、助教本人、销售 403、非法筛选 400、无 openid 均覆盖。smoke：UI 状态/来源/定位渲染 PASS。未新增自动重试，未发送真实消息。 |

## 3. 全量自动回归

| 套件 | 结果 |
|---|---|
| `node test/smoke.js` | 552 项，PASS 552 / FAIL 0 |
| `node test/e2e.api.js` | 177 项，PASS 177 / FAIL 0 |
| `cd server && npm test --cache /tmp/npm-cache-xueqing` | 472 项，PASS 472 / FAIL 0（73＋175＋30＋30＋29＋11＋63＋39＋22） |
| `node test/ui-upgrade-matrix.js` | 93 原项＋7 FIX＋9 复查项，共 109 项，ID 唯一，全有证据 PASS |
| `node test/ui-upgrade-fixtures.js` | 空场景、443/2500、1100/10000 和分页边界 PASS |
| 合计自动断言 | **1,201 项 PASS，0 失败** |

## 4. 浏览器可见验收

原始结果：`post-release-ui__chrome.json`、`post-release-ui__webkit.json`；截图名称前缀 `post-release__*`，按 `.gitignore` 仅保留本地。

- Chrome 155、WebKit 27.2：1512×716、1280×720、834×800、390×844。
- 所有场景 `pageerror=0`、无横向溢出。
- U01 四字段均为 2×2；桌面主操作在视口内。WebKit 390 的筛选区 153px，Chrome 390 为 182px，均无溢出。
- U02 概览和学科输入节点无重建。
- U03 原生按钮、键盘下钻、当前范围提示、复位均 PASS。
- N05 柱底差 0px。
- Safari 真实窗口：本地 v1.16.0 教务登录成功；学生页筛选压缩为一行搜索＋助教＋A-Z，N03 点击沉睡预警打开林小满档案；U03 用键盘 Space 下钻/复位并显示当前范围。证据：`post-release__U01-N03__safari__admin__1512x863__01.jpg`、`post-release__U03__safari__admin__1512x863__01.jpg`。
- Safari 834/390 本轮未复测，保留 `NOT_RUN`；Chrome/WebKit 已覆盖对应宽度。

## 5. 数据与发布边界

- U04 新增 schema：`push_deliveries`（新表，无旧表改写）；路由总数由 58 增至 59。生产发布时必须另做数据库备份和迁移/回滚验证。
- 所有测试库为临时 SQLite；未连接生产 DB，未创建生产业务数据，未调用真实微信，未发真实通知。
- 未执行生产发布、Git 提交或其他外部操作。
- 已知非阻断项：生产三种角色登录页本轮未验收；U04 UI 使用 mock 投递数据验证，真实微信回执仍以授权测试环境为准。
