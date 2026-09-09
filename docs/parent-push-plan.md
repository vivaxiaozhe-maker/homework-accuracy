# 家长微信推送 — 实施方案（服务号模板消息 + H5 报告页）

> 版本：v1.0（2026-09-10）
> 已确认：方案方向（服务号模板消息点对点推送）✓；服务号已注册、认证审核中 ✓；家长绑定用学生专属二维码 ✓（助教在平台生成二维码图片，微信转发给家长，家长扫码关注即自动绑定）

## 整体链路
```
助教点「推送给家长」
  → 后端调服务号模板消息接口
  → 家长微信收到服务号通知（聊天列表，像银行到账提醒）
  → 点开 → H5 报告页（免登录，token 只读，含学生该科目完整报告）
```

## 分步实施

### 第 1 步：H5 报告分享页（不依赖服务号，先做）✅ 已开工
- 后端：`share_tokens` 表（token / student_id / subject / created_by / created_at / expires_at / revoked）；`POST /api/reports/share` 生成链接；`GET /r/:token` 服务端渲染公开只读报告页（无登录、无其他学生数据）；`POST /api/reports/share/:token/revoke` 撤销
- token 安全：32 位随机不可猜测；默认 30 天有效期；访问记录写审计日志
- 前端：报告预览弹窗加「分享给家长」按钮 → 生成链接 → 显示链接 + 「复制链接」（ toast 确认）

### 第 2 步：服务号接入（认证下来后）
- 服务器配置：URL 验证（GET）+ 消息接收（POST，关注事件）；access_token 缓存管理（2 小时有效期，提前刷新）
- 带参数二维码：`POST /api/students/:id/bind-qr` 生成学生专属二维码（scene=绑定 token，永久二维码），学生卡显示「家长绑定二维码」可查看/转发
- 绑定：家长扫码关注 → 关注事件带 scene → 写 `parent_binds` 表（openid ↔ student_id）；一家长多孩子、一学生多家长都支持
- 学生卡显示绑定状态「已绑定家长微信 / 未绑定」

### 第 3 步：模板消息推送
- 模板：微信模板库选教育类（如「作业通知/成绩通知」），字段：学生姓名、科目、正确率、日期 + 链接
- `POST /api/reports/push` {studentId, subject}：查绑定 → 调模板消息接口 → 写审计；未绑定返回明确提示
- 前端：报告预览弹窗加「推送给家长」按钮（未绑定 → 提示并给绑定二维码入口）
- 失败处理：家长取关（errcode 43004）→ 提示并标记绑定失效

### 第 4 步：上线验收
- 真实家长微信扫码绑定 → 助教推送 → 家长收到通知 → 点开 H5 报告页正常

## 数据表（新增）
- `share_tokens`：报告分享链接
- `parent_binds`：id / student_id / openid / bound_at / unbound（取关标记）
- `wechat_config`：服务号 appid/secret/access_token 缓存（或走环境变量 + 内存缓存）

## 环境变量（生产）
- `WECHAT_APPID` / `WECHAT_SECRET` / `WECHAT_TOKEN`（服务器验证用）
