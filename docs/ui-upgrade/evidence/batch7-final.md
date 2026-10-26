# 批次 7：账号、通知、教务与移动端

日期：2026-10-26
目标版本：`v1.15.0`（本地工作区，未提交/未部署）
环境：mock、真实本地 API 临时库、Chrome/WebKit 隔离浏览器；未发送真实通知。

## 实现

- 删除确认：姓名/账号/角色与逐项影响摘要、主警告；`expectedInput` 未完整匹配时禁用提交，匹配后启用。原 7 类阻断、事务重检、会话吊销、tombstone、审计和永久锁定不变。
- 确认弹窗支持焦点返回；转移弹窗 Esc 关闭后焦点回归归属标签。归属/绑定标签加入 `tabindex`，Enter/Space 可激活。
- 通知 `results`：逐接收人备注名/序号 + sent/error/unsubscribed/rate_limited + 原因，不含 openid；原全站同类共享限流、自动超额丢弃和现有响应字段不变。
- 教务设置注明“全站同类通知共享额度”和保存/发送结果分离；审计、销售、危险操作不变。

## 自动回归

- `node test/smoke.js`：**527 项，PASS 527 / FAIL 0**。
- `node test/e2e.api.js`：**177 项，PASS 177 / FAIL 0**。
- 服务端全套：**435 项，PASS 435 / FAIL 0**（M3 149、M10 29、M11 22，其余原套件不变）。
- 新增删除输入门槛、通知显示名/失败原因、全站共享限流、历史只读等断言。

## 可见验收

Chrome 155.0.8059.86、WebKit 27.2；1512×716。两种引擎均验证：

- 删除预览清晰，未输入/错误账号禁用，完整账号启用，删除成功：`batch7-results.json`、`AC-A05__chrome__admin__1512x716__01.png`。
- 教务设置和作业周期：`AC-C03__chrome__admin__1512x716__01.png`、`AC-C02__chrome__admin__1512x716__01.png`。
- 转移弹窗 Esc：`closed=true`、`ownerFocused=true`，焦点返回归属标签。
- 无 JS 异常和横向溢出。

真实 Safari 最终通过普通窗口＋Accessibility 补测，未启用或修改“允许远程自动化”设置，也不以 WebKit 替代：

- 教务：1512×716 今日、1280×720 看板、834×800 与 390×844 响应式，证据为 `AC-G05__safari__admin__1512x716__01.jpg`、`AC-D02__safari__admin__1280x720__01.jpg`、`AC-U03__safari__admin__834x800__01.jpg`、`AC-U03-mobile__safari__admin__390x844__01.jpg`。
- 助教：390×844 今日与移动导航，证据为 `AC-U03-mobile__safari__ta__390x844__01.jpg`。
- 销售：390×844 现有学生，展开 IB·数学后显示完整只读打卡/评语/建议/模考，无编辑控件；截图未见横向溢出，证据为 `AC-R03__safari__sales__390x844__01.jpg`。

未提交、未部署、未改生产数据、未向真实家长发送消息。
