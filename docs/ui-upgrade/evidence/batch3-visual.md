# 批次 3：视觉骨架与可见验收

日期：2026-10-26
目标版本：`v1.11.0`（本地工作区，未提交/未部署）
环境：本地 mock、独立浏览器上下文、演示账号与示例数据；未访问生产写链路。

## 实现

- `styles/main.css`：深绿 184px 侧栏、暖白连续工作面、浅薄荷选中、细线和金色分节；main 取消固定窄宽。
- 页头桌面 64px，保留书本、真实日期、当前页、用户角色与账户操作；温暖短句仅 CSS 隐藏，DOM 未删。
- 无外部字体/React/整页缩放；移动 bottombar 保持，主要输入约 50px；报告打印和弹窗层级未改。

## 自动测试

`node test/smoke.js`：**499 项，PASS 499 / FAIL 0**。

## Chrome 可见验收

浏览器：Chrome 155.0.8059.86，无头隔离实例。四组均 `errors=[]`、`overflow=false`。

| 场景 | 截图/结果 | 关键实测 |
|---|---|---|
| 教务 1512×716 今日 | `AC-G05__chrome__admin__1512x716__01.png` | 侧栏 184、页头 64、bottombar none |
| 教务 1280×720 看板 | `AC-U01__chrome__admin__1280x720__01.png` | 八项概览完整、无横向溢出 |
| 助教 834×800 今日 | `AC-U03__chrome__ta__834x800__01.png` | 任务行与操作可读、无按钮墙 |
| 销售 390×844 学生 | `AC-U03-mobile__chrome__sales__390x844__01.png` | bottombar block、搜索/只读卡正常 |

原始指标：`batch3-browser-results.json`。

## WebKit 可见验收

浏览器：Playwright WebKit 27.2（UA `Version/27.2 Safari/605.1.15`），隔离安装于 `.tools`，不是对系统 Safari 的替代声明。四组均 `errors=[]`、`overflow=false`；页面版本均 v1.11.0。

对应截图文件名同上、引擎字段改为 `webkit`；原始指标：`batch3-webkit-results.json`。

## 实际 Safari 状态

本批次执行时 **BLOCKED**：本机 Safari 未开启“允许远程自动化”，`safaridriver /session` 无法建立会话；未修改用户系统设置，未将 WebKit 结果写成 Safari PASS。

最终候选已改用普通 Safari 窗口＋Accessibility 完成三角色补测，教务覆盖四种目标尺寸，助教/销售覆盖 390×844；证据与结果见 `final-verification.md`。

## 未覆盖

批次 4–7 的今日分页、看板完整名单、学生双栏工作区、键盘/焦点与性能尚未验收，不能据此宣告 93 项全部完成。未提交、未部署、未发送真实通知。
