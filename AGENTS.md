# 学情跟踪平台 · AGENTS.md

面向 AI 代理的项目交接文档：读这份就能接手开发，不用翻历史。

## 这是什么

火箭学院内部系统：助教记录学生作业正确率/未交/模考/评语，教务管理全局，销售只读。家长通过微信服务号收模板消息推送（作业成绩/模考预约/模考成绩三类），点开 H5 落地页看详情。

- 生产：https://xueqing.rocketacademy.com.cn（阿里云 ECS `root@47.113.184.105`，SSH 免密已配好，pm2 进程名 `xueqing`）
- 演示站：GitHub Pages（仓库 github.com/vivaxiaozhe-maker/homework-accuracy，push 即更新，mock 模式数据存 localStorage）
- 微信服务号密钥：只在生产服务器 `/opt/xueqing/ecosystem.config.js`，**不入库**

## 架构

- 前端：原生 HTML/CSS/JS，零构建。入口 `学生作业正确率.html`（源文件，改它）；`index.html` 和 `dist/index.html` 是它的副本（deploy.sh 自动同步，不要手改）
  - `js/data.js` 数据层（LocalApi mock / HttpApi 双实现 + Api 门面 + USE_API 同源探测）、`js/misc.js` 工具/弹窗/横幅、`js/students.js` 学生/打卡/录入、`js/wechat.js` 报告/推送/家长绑定、`js/auth.js` 账号/审批/审计、`js/dashboard.js` 看板/初始化
  - `styles/main.css` 全部样式；`assets/` 页头素材（SVG）
  - 模块索引详见 `docs/architecture.md`
- 后端：`server/` Express 5 + better-sqlite3。`index.js` 入口 + 静态白名单中间件（只放行两个 html 入口、`/js/*`、`/styles/*`、`/assets/*`，防路径穿越）；`routes/` 按域拆分；`db.js` SQLite + 幂等迁移（PRAGMA table_info + ALTER TABLE 模式）；`push.js` 微信模板推送 + 按类型限流（默认 3 次/10 分钟，教务管理页可配 1-10）；`wechat.js` 微信 API 封装
- 家长落地页 `/r/:token`：服务端渲染、零 JS、空字段隐藏；分享链接 30 天有效

## 领域口径（改动前必读，都是踩坑踩出来的）

- **作业记录四态互斥**：正常成绩 / 无作业（`no_homework=1`，total=0）/ 未交（missed 表）/ 未录入（空格子）。无作业计入完成次数但**不进任何正确率统计和预警**；未交独立体系，不算 0 分
- **逾期判定**（`js/misc.js` `isOverdueMissed`）：未处理 + 已开课（subjFirstClass ≤ 今天）+ 未交日期 + 7 天宽限 < 今天；未指定科目或未填开课时间一律不算逾期
- **已归档学生**不进首页/看板任何预警
- **权限**：admin 全量、ta 仅名下（ownerId 归属）、sales 只读；解绑家长仅教务直解、助教走 unbind-request 审批
- **推送**：保存成绩/预约模考/存模考分时按开关自动推 + 手动补推按钮；微信模板 character_string 字段不支持中文（无作业时填 `-`，中文信息靠落地页承载）
- **家长绑定**：每学生最多 2 名有效绑定（扫码回调处硬限制）；openid 无含义，显示用 remark 备注或「家长 N」序号
- **预警处理状态**（alert_actions 表）：snooze 当天有效明天再现；done 永久消失进「已处理事项」区

## 工程规约

- **版本号**：改功能必升版。三处同步——html 里 `#login-ver` + `#side-foot` 静态文案、`js/data.js` APP_VERSION、测试断言（smoke/e2e 里有版本断言）。sed 批量替换上一版号即可
- **测试**：三套全绿才交付——`node test/smoke.js`（前端 DOM 桩）、`node test/e2e.api.js`（起真实后端的端到端）、`cd server && npm test --cache /tmp/npm-cache-xueqing`（9 个里程碑套件）。CSS 纯改动只跑 smoke；逻辑改动加 e2e；server 改动才跑后端
- **部署**：`./deploy.sh "msg"`（前端）/ `./deploy.sh --with-server "msg"`（含后端，pm2 restart）。脚本链：同步副本 → smoke → git push → scp 生产 → 线上版本验证。**deploy.sh 运行时不要让其他进程改文件**（git add -A 会卷进半成品）
- **git 推送有长期授权**（用户已确认），但 GitHub 443 在这个网络环境间歇断流：repo 已配 `http.version=HTTP/1.1`（必须，HTTP/2 必挂）；还失败就让用户开全局代理，或绕过 GitHub 直接 scp 生产（之后补 push）
- **npm 缓存权限坑**：本机 `~/.npm` 有 root 残留，一切 npm 命令加 `--cache /tmp/npm-cache-xueqing`
- **本地预览**：`./dev.sh`（mock）/ `./dev.sh --api`（本地后端 + /api 代理）。live-server 不要加 `--entry-file`（SPA 回退会让 /api/health 返回 200，mock/API 探测会误判）
- **z-index 层级**：登录屏 200 < 业务弹窗 300 < 确认/输入弹窗 400（`#confirm-modal`、`#input-modal` 必须最高，弹窗内再弹窗已被压过两次）

## 用户协作偏好

- 中文交流
- 大改动/新功能：先出方案写到计划里让用户确认再动手（涉及口径的问题先用 AskUserQuestion 问清）
- 小改动（文案/样式/明显 bug）：直接改直接部署
- 部署后主动验证线上版本号生效；后台任务完成要汇报

## 成本控制约定（2026-10 与用户确认）

- **批次切小**：一次 1~3 个问题为一个实施批次，不搞 5+ 项的大批整改（调试面小、返工少）
- **小活不派子代理**：边界清楚、单文件级的小改由主代理直接改（成本约为派代理的 1/5）；子代理只用于跨多文件的大功能
- **任务书钉锚点**：派子代理时把行号/函数名/文件路径写进 brief，减少其探索消耗；涉及前后端联动的方案，两端改动点都在方案阶段钉死，避免"后端改了前端没跟上"式返工
- **测试分层**：迭代期只跑受影响套件，部署前才跑全量三套
- 测试断言总量不省（463+ 项断言是线上零事故的保障）
