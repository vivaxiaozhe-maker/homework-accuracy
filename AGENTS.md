# 学情跟踪平台 · AGENTS.md

面向 AI 代理的项目交接文档：读这份就能接手开发，不用翻历史。

## 这是什么

火箭学院内部系统：助教记录学生作业正确率/未交/模考/评语，教务管理全局，销售只读。家长通过微信服务号收模板消息推送（作业成绩/模考预约/模考成绩三类），点开 H5 落地页看详情。

- 生产：https://xueqing.rocketacademy.com.cn（阿里云 ECS `root@47.113.184.105`，SSH 免密已配好，pm2 进程名 `xueqing`）。当前线上 v1.15.1；v1.16.0 整改为本地候选、尚未发布。发布、备份、回滚和未覆盖项见 `docs/ui-upgrade/release-checklist.md`、`docs/ui-upgrade/evidence/production-*.md` 和 `docs/ui-upgrade/evidence/post-release-n-u.md`
- 演示站：GitHub Pages（仓库 github.com/vivaxiaozhe-maker/homework-accuracy，push 即更新，mock 模式数据存 localStorage）
- 微信服务号密钥：只在生产服务器 `/opt/xueqing/ecosystem.config.js`，**不入库**

## 架构

- 前端：原生 HTML/CSS/JS，零构建。入口 `学生作业正确率.html`（源文件，改它）；`index.html` 和 `dist/index.html` 是它的副本（deploy.sh 自动同步，不要手改）
  - `js/data.js` 数据层（LocalApi mock / HttpApi 双实现 + Api 门面 + USE_API 同源探测）、`js/misc.js` 工具/弹窗/横幅、`js/students.js` 学生/打卡/录入、`js/wechat.js` 报告/推送/家长绑定、`js/auth.js` 账号/审批/审计、`js/dashboard.js` 看板/初始化
  - `styles/main.css` 全部样式；`assets/` 页头素材（SVG）
  - 模块索引详见 `docs/architecture.md`
- 后端：`server/` Express 5 + better-sqlite3。`index.js` 入口 + 静态白名单中间件（只放行两个 html 入口、`/js/*`、`/styles/*`、`/assets/*`，防路径穿越）；`routes/` 按域拆分；`db.js` SQLite + 幂等迁移（PRAGMA table_info + ALTER TABLE 模式）；`push.js` 微信模板推送 + 按类型限流（默认 3 次/10 分钟，全站同类共享，教务管理页可配 1-10）+ `push_deliveries` 逐接收人投递记录；`wechat.js` 微信 API 封装
- 生产反向代理：Nginx 只转发到 `127.0.0.1:3000` 并写 `X-Forwarded-For`；`index.js` 固定 `app.set('trust proxy', 'loopback')`，让登录限流按真实客户端 IP 生效。不要改成 `true`（外部可伪造 XFF）
- 家长落地页 `/r/:token`：服务端渲染、零 JS、空字段隐藏；分享链接 30 天有效

## 领域口径（改动前必读，都是踩坑踩出来的）

- **作业记录四态互斥**：正常成绩 / 无作业（`no_homework=1`，total=0）/ 未交（missed 表）/ 未录入（空格子）。无作业计入完成次数但**不进任何正确率统计和预警**；未交独立体系，不算 0 分
- **未交**：只有登记了「未交」的才算（missed 表）；永久停在未交组，不随时间升级。出清 = 补录 / 删除 / 搁置（shelve）
- **逾期**（v1.9.0 起科目级，`js/misc.js` `subjectOverdueInfo`）：已开课（firstClass ≤ 今天）+ 欠账（已完成 < 应完成）+ 最近活跃超过作业周期；作业周期为全局设置（默认 14 天，教务管理页可配 1–30 天，API `/api/homework-cycle`，前端 `homeworkCycleDays`）。最近活跃 = max(最近成绩日, 最近未交登记日, 计划设定日)；无计划/无活跃记录不算。原「计划停滞」并入逾期（alert_actions 的 kind 名保留 'planStall'，存量 done/snooze/搁置不失效）
- **已归档学生**不进首页/看板任何预警，且为只读档案：服务端 `rejectArchived` 拦截作业/未交/学生字段写入，恢复为现有学生后才可继续编辑
- **同名学生组**：从稳定 studentId 起点，按 ownerId + trim/toLowerCase 姓名 + 当前 archived 范围解析；教务也不能跨 owner。科目重命名/删除走 `/api/students/subject-operation` 单事务，覆盖 records/missed/subjects/plans/setAt/firstClass/comments/advice/mock
- **补交事务**：补录未交走 `/api/records/makeup`（missedId + 稳定 recordId），成绩、附件、made-up、审计一次提交；同负载重试幂等，失败保留未交和草稿，禁止回到 records + resolve 双请求
- **计划审批**：待审批存在时，本科目禁止改名/删除，整组禁止归档；审批通过必须重读并核对 pending、归档、归属、科目存在性和 `old_plan`，状态失效则转 `cancelled` 并审计，不能写回旧键
- **预警身份**：lowAcc/planStall 的 `ref_key = studentId|完整科目路径`；科目改名同事务迁移动作，删除清除状态并保留操作审计；历史回溯按新键展示
- **通知投递**：`push_deliveries` 按接收人保存 sent/unbound/unsubscribed/rate_limited/error、显示名与原因，不存 openid；只读视图不自动重发、不改全站限流
- **看板口径**：历史工作量/均分/最近录入/趋势统一 `date <= today`（“全部”也截至今天，未来预录只在学生/历史/报告明细）；三项助教覆盖指标的分子分母同为当前在服务 studentId 集合，未交登记+补交成绩计两次行为，软删除未交不计
- **权限**：admin 全量、ta 仅名下（ownerId 归属）、sales 只读；解绑家长仅教务直解、助教走 unbind-request 审批
- **推送**：保存成绩/预约模考/存模考分时按开关自动推 + 手动补推按钮；微信模板 character_string 字段不支持中文（无作业时填 `-`，中文信息靠落地页承载）
- **家长绑定**：每学生最多 2 名有效绑定（扫码回调处硬限制）；openid 无含义，显示用 remark 备注或「家长 N」序号
- **预警处理状态**（alert_actions 表）：snooze 当天有效明天再现；done 永久消失进「已处理事项」区

## 工程规约

- **版本号**：功能或行为变更必升版（当前本地候选 v1.16.0，线上 v1.15.1；纯文档不升）。源文件 `学生作业正确率.html` 的 `#login-ver`+`#side-foot`、`js/data.js` `APP_VERSION`、smoke/e2e 版本断言同步；再从源文件 `cp` 到 `index.html`、`dist/index.html` 并用 `cmp` 校验
- **测试**：三套全绿才交付——`node test/smoke.js`（当前 552 项）、`node test/e2e.api.js`（177 项）、`cd server && npm test --cache /tmp/npm-cache-xueqing`（472 项，9 个里程碑套件）。CSS 纯改动只跑 smoke；逻辑改动加 e2e；server 改动跑后端。大版本候选另跑 `node test/ui-upgrade-matrix.js`（109 项证据台账）和 `node test/ui-upgrade-fixtures.js`（空/基础/扩展/分页边界）
- **发布授权**：Git commit/push、生产备份和生产部署**每次都要用户明确授权**，不存在长期授权，AGENTS 不能自行扩权。大版本、后端、依赖或数据相关发布按 `docs/ui-upgrade/release-checklist.md`：在线备份 → 隔离恢复演练 → 隔离预发布 → 先后端再前端 → 线上验证
- **`deploy.sh` 限制**：脚本会同步副本、跑 smoke、`git add -A`、push、scp 并重启；没有备份，且不保证“先后端再前端”。仅在用户明确同意且确认为小前端改动时使用；大版本按上面的受控流程手工执行。运行期间禁止其他进程改文件
- **GitHub 网络**：repo 已配 `http.version=HTTP/1.1`（必须，HTTP/2 易挂）；443 断流时让用户开全局代理。不要擅自绕过 Git 直接 scp 生产来“补提交”，生产发布和 Git 操作都必须已获当次授权
- **npm 缓存权限坑**：本机 `~/.npm` 有 root 残留，一切 npm 命令加 `--cache /tmp/npm-cache-xueqing`
- **证据文件**：`docs/ui-upgrade/evidence/*.{png,jpg,jpeg}` 和 `test/fixtures/ui-upgrade/visual-reference/` 已在 `.gitignore` 中，只保留本地；Markdown、性能 JSON 和功能夹具正常提交
- **本地预览**：`./dev.sh`（mock）/ `./dev.sh --api`（本地后端 + /api 代理）。live-server 不要加 `--entry-file`（SPA 回退会让 /api/health 返回 200，mock/API 探测会误判）
- **z-index 层级**：登录屏 200 < 业务弹窗 300 < 确认/输入弹窗 400（`#confirm-modal`、`#input-modal` 必须最高，弹窗内再弹窗已被压过两次）

## 用户协作偏好

- 中文交流
- 大改动/新功能：先出方案写到计划里让用户确认再动手（涉及口径的问题先用 AskUserQuestion 问清）
- 小改动（文案/样式/明显 bug）：可直接修改并跑受影响测试；正式上线仍需当次发布授权
- 部署后主动验证线上版本号生效、健康检查、登录负向探测和错误日志；后台任务完成要汇报

## 成本控制约定（2026-10 与用户确认）

- **批次切小**：一次 1~3 个问题为一个实施批次，不搞 5+ 项的大批整改（调试面小、返工少）
- **小活不派子代理**：边界清楚、单文件级的小改由主代理直接改（成本约为派代理的 1/5）；子代理只用于跨多文件的大功能
- **任务书钉锚点**：派子代理时把行号/函数名/文件路径写进 brief，减少其探索消耗；涉及前后端联动的方案，两端改动点都在方案阶段钉死，避免"后端改了前端没跟上"式返工
- **测试分层**：迭代期只跑受影响套件，部署前才跑全量三套
- 测试断言总量不省（smoke 552＋e2e 177＋服务端 472，合计 1,201 项是线上零事故的保障）
