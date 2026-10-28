# 未来发布、备份与回滚清单

> 本清单区分本地候选验收、生产发布执行和未执行的外部链路。本地证据见 [`evidence/final-verification.md`](evidence/final-verification.md)，生产记录见 [`evidence/production-v1.15.0.md`](evidence/production-v1.15.0.md) 和 [`evidence/production-v1.15.1-hotfix.md`](evidence/production-v1.15.1-hotfix.md)。

## 1. 授权门禁

| 动作 | 当前授权状态 | 后续要求 |
|---|---|---|
| 本地/隔离环境实施与测试 | 已执行 | 只用合成/隔离副本数据，不触发真实家长通知 |
| Git commit / push | 已按明确授权执行 | 功能 `7e30aaf`、HTML 副本 `3a302a9`；后续文档单独提交 |
| 生产备份与发布 | 已按明确授权执行 v1.15.0 和 v1.15.1 热修 | 实际结果见 [`evidence/production-v1.15.0.md`](evidence/production-v1.15.0.md) 和 [`evidence/production-v1.15.1-hotfix.md`](evidence/production-v1.15.1-hotfix.md) |
| 生产数据清理/导入/修复 | **未授权、未执行** | 未清理、导入或修复生产业务数据 |
| 真实微信、二维码、PDF 外部链路 | **未授权、未执行** | 仅在后续授权测试环境和测试接收人范围验证 |

任何一步勾选都必须附实际时间、执行人、命令/结果和证据路径；文档中的建议命令不代表已经运行。

## 2. 发布前冻结与可恢复备份

- [x] `PASS` 发布 commit、三份 HTML、依赖锁、Node/npm 和配置版本已核对；源入口及两个同步副本通过 `cmp`。
- [x] `PASS` 已审阅 diff 和发布包；无 React 原型、截图、视觉参考、测试 fixture、密钥或无关文件进入生产发布包。
- [x] `PASS` 已记录生产 pm2、前后端版本、健康检查和磁盘余量。
- [x] `PASS` 维护窗口内使用 better-sqlite3 在线备份 WAL 数据库，未直接复制运行中的单个 DB 作为备份。
- [x] `PASS` `server/uploads/` 已备份并保留结构/权限/时间戳；`files_db=1 files_disk=1 files_missing=0`。
- [x] `PASS` 实际代码、依赖锁和 pm2/环境配置已在服务器受控备份；敏感配置未进入仓库、证据或截图。
- [x] `PASS` 发布清单、备份路径、大小与 SHA-256 已记录，见 [`evidence/production-v1.15.0.md`](evidence/production-v1.15.0.md)。
- [x] `PASS` 旧版本已在隔离端口完成恢复演练，DB、三角色权限、附件和报告数据均实际验证。
- [x] `PASS` 已明确回滚触发条件与顺序；备份保留在服务器受控目录，未执行回滚。

## 3. 候选验收门禁

- [x] `PASS` 原 93 项、追加 7 项和上线后复查 9 项均有真实目标实现证据，109 项 PASS、0 项 NOT_RUN；见 [`evidence/post-release-n-u.md`](evidence/post-release-n-u.md) 与 [`../migration-map.md`](../migration-map.md)。
- [x] `PASS` 最终重新运行 smoke 527 项、e2e 177 项、服务端 435 项及分页/容量/事务回归，均 0 失败；结果见 [`evidence/final-verification.md`](evidence/final-verification.md)。
- [x] `PASS` Chrome/WebKit 三角色和四种目标尺寸可见检查完成；真实 Safari 已补测三角色，教务覆盖四种尺寸，助教/销售覆盖 390×844。保存/失败/慢请求、键盘、滚动、弹窗、长文本证据按批次归档，索引见 [`evidence/final-verification.md`](evidence/final-verification.md)。
- [x] `PASS` 基础/扩展场景均完成 20 次交互测量并保留首次值和 p95；全部满足 ≤200ms/≤500ms 预算，原始 JSON 见 [`evidence/final-verification.md`](evidence/final-verification.md)。
- [x] `PASS` R01/R02 跨 owner、事务回滚、幂等重试与附件关联通过；S01 已升级且 `npm audit` 为 0；本轮无未解决 P0/P1 或阻断 P2。
- [x] `PASS` 固定数据集覆盖任务 ID/顺序/计数、均分、日期范围和权限字段；未来日期与当前在服务覆盖口径符合已批准决定，见 [`evidence/batch2-p2.md`](evidence/batch2-p2.md) 及最终回归。
- [x] `PASS` 本轮无 schema 变更；若后续确需变更，必须先另写前向/回滚兼容和数据备份方案，不能套用“无 schema”预案。

## 4. 未来部署顺序（后端先于前端）

新事务接口是前端新流程的前置能力，因此采用“先兼容后端、再前端”的顺序；不得先发会调用不存在接口的新前端。

1. [x] `PASS` 已进入“立即完整发布”维护窗口，发布前再次核对备份可用。
2. [x] `PASS` 后端按锁文件执行 `npm ci --omit=dev`，依赖版本符合目标。
3. [x] `PASS` 原受控 pm2 配置重启成功；健康、DB、附件目录和启动状态已检查。
4. [ ] `PARTIAL` 后端发布后旧前端 v1.9.3 页面与健康检查正常；隔离副本已验证 state/records/missed/计划/报告/附件，但未使用生产已登录会话做旧前端全链路。
5. [x] `PASS` 新 R01/R02 已在隔离副本验证跨 owner、失败回滚和幂等重试，未向真实家长发送消息。
6. [x] `PASS` 已同步 `index.html/dist/index.html` 并发布前端静态文件；CSP、白名单和 no-store 保持。
7. [x] `PASS` 首页和中文入口已从 v1.15.0 更新到 v1.15.1；classic script 顺序及实际 JS/CSS/assets 已验证。
8. [ ] `NOT_RUN` 生产三角色已认证页面只读检查：当前无可用生产登录会话；未创建生产验收账号，未执行业务写入或真实推送。
9. [x] `PASS` 已检查 pm2、错误日志、API、附件关联和报告 H5 并归档脱敏证据；v1.15.1 热修后代理限流告警不再新增，登录负向探测按预期 401。

`deploy.sh` 链包含同步、smoke、git push、scp 和线上验证；未获 Git/生产授权前不得运行。若使用它执行未来发布，也必须先确认其步骤与本次审批范围一致。

## 5. 回滚顺序（与部署反向）

触发严重越权、数据不一致、事务部分成功、关键链路不可用或无法解释的版本异常时，停止扩大验证并启动回滚。

1. [ ] `NOT_RUN` 记录触发时间、现象、日志和当前版本；停止新前端写入，保留现场，不清数据“修复”。
2. [ ] `NOT_RUN` 先回滚前端到上一已验证静态版本，避免旧后端恢复前继续调用新接口；验证版本号和关键只读链路。
3. [ ] `NOT_RUN` 再回滚后端代码，按旧锁文件 `npm ci` 并用旧受控配置重启 pm2；检查 health 和原 API。
4. [ ] `NOT_RUN` 若本轮确无 schema/数据迁移，通常不覆盖数据库；保留回滚期间新数据，并核对新接口已产生的记录/审计。
5. [ ] `NOT_RUN` 若后续存在 schema 或数据迁移，只能执行预先演练的对应回滚方案。不得直接用旧备份覆盖回滚期间的新生产数据；需由负责人评估数据合并/前滚。
6. [ ] `NOT_RUN` 附件按同一备份/变更清单恢复或前滚，避免 DB 与 files 磁盘状态错配；不得批量删除无法立即判定归属的文件。
7. [ ] `NOT_RUN` 做旧版本三角色关键链路、权限、记录/未交、附件和报告只读验证，确认服务稳定。
8. [ ] `NOT_RUN` 汇总影响范围、数据差异、回滚证据与后续修复计划；重新发布需要新的明确授权。

## 6. 本批结论

v1.15.0 已完成生产备份、隔离恢复演练、预发布和正式发布；v1.15.1 已热修代理下的登录限流 IP 识别并上线。生产三角色已认证页面、真实外部链路和回滚未执行，记录见 [`evidence/production-v1.15.0.md`](evidence/production-v1.15.0.md) 和 [`evidence/production-v1.15.1-hotfix.md`](evidence/production-v1.15.1-hotfix.md)。

## 7. v1.16.0 生产发布

- 复查整改 N01–N05、AUD-U01–AUD-U04 已完成本地回归与生产发布，证据见 [`evidence/post-release-n-u.md`](evidence/post-release-n-u.md) 和 [`evidence/production-v1.16.0.md`](evidence/production-v1.16.0.md)。
- 发布提交 `32d1611`；生产备份、隔离恢复、`push_deliveries` 迁移预发布、先后端再前端发布均已完成。
- 线上首页/中文入口 v1.16.0，健康检查正常，error log 新增 0 行；原学生/成绩/未交计数不变。
- 生产三种角色已认证页面和真实微信回执仍未执行，保持 `NOT_RUN`；未发送真实通知、未修改业务数据。

## 8. v1.16.1 生产发布

- N06 响应竞态、N07 归档定位、N08 时间显示已修复，证据见 [`evidence/post-release-n06-n08.md`](evidence/post-release-n06-n08.md) 和 [`evidence/production-v1.16.1.md`](evidence/production-v1.16.1.md)。
- 发布提交 `e09b895`；生产备份、隔离预发布和前端静态发布均已完成。
- 线上首页/中文入口均为 v1.16.1，健康检查正常，error log 新增 0 行；原学生/成绩/未交计数不变。
- 本轮无 schema 变更，后端未重启，路由仍为 59；未发送真实通知、未修改业务数据。
- 生产三角色已认证页面、真实微信回执和慢网并发验收保持 `NOT_RUN`。

## 9. v1.16.2 生产发布

- 学科维度图表改为细条、独立正确率列和 60%/85% 参考线，搜索、排序、分页与统计口径不变。
- 发布提交 `c23c19b`；全量 1,218 项自动断言通过，生产代码/配置、DB 和附件备份均完成，备份 DB `integrity_check=ok`。
- 仅发布前端静态文件，后端未重启、无 schema 变更；首页/中文入口均为 v1.16.2，线上 JS/CSS 与仓库哈希一致。
- 健康检查正常，error log 新增 0 行；发布前后均为 435 学生、1362 成绩、333 未交、2 条投递记录。
- 未发送真实通知、未修改生产业务数据；生产已登录学科看板及真实外部链路保持 `NOT_RUN`。
- 证据见 [`evidence/production-v1.16.2.md`](evidence/production-v1.16.2.md)。

## 10. v1.16.5 生产发布

- 完成 v1.16.2 走查 7 项整改：N09/N11 异步结果一致性、N10 投递刷新、N07-R 历史定位、AUD-U05/06/07 翻页与窄屏交互。
- 发布提交 `8b76e0f`；全量 1,244 项自动断言通过，三批隔离浏览器证据分别为 9、7、20 项 PASS。
- 生产代码/配置、DB 和附件备份完成，备份 DB `integrity_check=ok`；仅发布前端，后端未重启、无 schema 变更。
- 首页/中文入口均为 v1.16.5，线上 HTML/JS/CSS 与仓库哈希一致；健康检查正常，error log 新增 0 行。
- 发布前后均为 435 学生、1362 成绩、333 未交、2 条投递记录；未发送真实通知、未修改业务数据。
- 生产已登录全角色、真实外部链路和实体手机验收保持 `NOT_RUN`。证据见 [`evidence/production-v1.16.5.md`](evidence/production-v1.16.5.md)。
