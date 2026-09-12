/* M5a 端到端测试：DOM 桩加载前端脚本 + 真实后端（同进程随机端口 + 临时库），强制走 API 模式。
   运行：node test/e2e.api.js */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

/* ---------- 启动真实后端（独立测试库 + 随机端口） ---------- */
const TEST_DB = path.join(os.tmpdir(), 'xq-m5a-test-' + Date.now() + '.db');
process.env.DB_PATH = TEST_DB;
const { app } = require('../server/index');

/* ---------- 最小 DOM 桩（与 test/smoke.js 相同） ---------- */
function makeEl(id){
  return {
    id: id, value: '', textContent: '', innerHTML: '', disabled: false,
    style: {}, dataset: {}, files: [], onclick: null, placeholder: '',
    classList: {
      _s: new Set(),
      add(...c){ c.forEach(x=>this._s.add(x)); },
      remove(...c){ c.forEach(x=>this._s.delete(x)); },
      toggle(c, f){ if(f===undefined) f=!this._s.has(c); if(f) this._s.add(c); else this._s.delete(c); },
      contains(c){ return this._s.has(c); }
    },
    addEventListener(){}, removeEventListener(){},
    appendChild(){}, click(){}, focus(){}, select(){}
  };
}
const _els = {};
const documentStub = {
  getElementById(id){ return _els[id] || (_els[id] = makeEl(id)); },
  querySelectorAll(){ return []; },
  querySelector(){ return null; },
  createElement(){ return makeEl('anon'); },
  head: makeEl('head'),
  body: makeEl('body')
};
function makeStorage(){
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    clear: () => m.clear(),
    _map: m
  };
}
const alerts = [];
const windowStub = { scrollTo(){}, print(){} };

let pass = 0, fail = 0;
function ok(cond, name){
  if(cond){ pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

(async function main(){
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  // 前端脚本里的 fetch 指向真实服务（相对路径补 origin）
  const apiFetch = (url, opts) => fetch(url.startsWith('http') ? url : base + url, opts);

  const ctx = vm.createContext({
    document: documentStub,
    window: windowStub,
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    fetch: apiFetch,
    AbortController: globalThis.AbortController,
    TextEncoder: globalThis.TextEncoder,
    // alert 已全局替换为 toast；ctx 不再提供 alert，残留调用会以 ReferenceError 暴露
  toast: msg => alerts.push(String(msg)),
    console, setTimeout, clearTimeout,
    Blob: function(){},
    URL: { createObjectURL(){ return 'blob:x'; }, revokeObjectURL(){} },
    FileReader: function(){}
  });
  const sessionStore = ctx.sessionStorage;  // vm context 内同一引用

  const html = fs.readFileSync(path.join(__dirname, '..', '学生作业正确率.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  vm.runInContext(m[1], ctx, { filename: 'inline-script.js' });
  /* 脚本内顶层 function toast 声明会覆盖 ctx 预置桩；加载后改装为「捕获 + 透传真实实现」，
     既有断言继续读 alerts 数组，同时验证真实 toast() 在 DOM 桩下静默工作不抛错 */
  const realToast = ctx.toast;
  ctx.toast = msg => { alerts.push(String(msg)); realToast(msg); };
  await windowStub.__ready;
  const wb = windowStub.__wb;

  /* ---- 模式探测 ---- */
  ok(wb.USE_API === true, '探测到 /api/health → 进入 API 模式');
  ok(documentStub.getElementById('side-foot').textContent === '学情跟踪平台 · 内部系统 · v1.1.3', 'API 模式侧栏脚注为「内部系统」文案并带版本号');
  ok(documentStub.getElementById('login-demo').style.display === 'none', 'API 模式隐藏演示账号提示');
  ok(documentStub.getElementById('login-screen').style.display === 'flex', '未登录显示登录页');

  /* ---- 登录 ---- */
  await wb.doLogin('admin', 'wrong-pwd', 'admin');
  ok(!wb.currentUser && documentStub.getElementById('login-err').textContent.length > 0, '错误密码登录失败（错误提示）');
  ok(documentStub.getElementById('login-err').textContent === '密码错误', '错误密码提示为「密码错误」而非误报会话过期');
  await wb.doLogin('admin', 'admin123', 'admin');
  ok(wb.currentUser && wb.currentUser.username === 'admin' && wb.currentUser.role === 'admin', 'admin 登录成功');
  ok(!!wb.HttpApi._token, '登录后持有 token');
  ok(JSON.parse(sessionStore.getItem('wb_ha_v2_session')).token === wb.HttpApi._token, 'token 已存 sessionStorage');
  ok(wb.pool && Array.isArray(wb.pool.students), '登录后拉取 state 填充 pool');
  ok(documentStub.getElementById('pwd-modal').classList.contains('show'), 'admin 首登强制改密弹窗出现');
  await wb.doChangePwd('admin123', 'admin456', 'admin456');
  ok(documentStub.getElementById('login-screen').style.display === 'none'
    && documentStub.getElementById('app').style.display === 'flex', '改密后进入主界面');

  /* ---- 会话恢复（刷新场景） ---- */
  const u2 = await wb.HttpApi.restoreSession();
  ok(u2 && u2.username === 'admin', 'GET /api/me 校验 token 恢复会话');
  sessionStore.setItem('wb_ha_v2_session', JSON.stringify({ uid: 'x', token: 'bad-token', ts: 1 }));
  const u3 = await wb.HttpApi.restoreSession();
  ok(u3 === null, '无效 token 恢复会话返回 null');
  ok(documentStub.getElementById('login-screen').style.display === 'flex', '401 后强制回登录页');
  // 恢复有效会话供后续步骤
  sessionStore.setItem('wb_ha_v2_session', JSON.stringify({ uid: 'x', token: wb.HttpApi._token, ts: 1 }));

  /* ---- 账号管理经 API ---- */
  await wb.doLogin('admin', 'admin456', 'admin');
  const made = await wb.Api.createUser('王助教', 'ta1', 'ta123456', 'ta');
  ok(made.ok && made.user.role === 'ta', 'API 模式创建助教账号（经后端）');
  const dup = await wb.Api.createUser('王助教', 'ta1', 'ta123456', 'ta');
  ok(!dup.ok && dup.msg.indexOf('已存在') !== -1, 'API 模式重复账号被拒');

  /* ---- 账号管理按钮点击路径（resetUserPwd / toggleUser + askConfirm 确认回调） ---- */
  await vm.runInContext('refreshUsersCache()', ctx);  // 同步账号缓存（上面是直连 Api 创建的，没走 UI 按钮）
  ok(made.user.tempPassword === 'ta123456', '创建账号响应带回初始密码 tempPassword');
  await vm.runInContext('renderAccounts()', ctx);
  const accHtmlA = documentStub.getElementById('accounts-list').innerHTML;
  ok(accHtmlA.indexOf('初始密码：ta123456（待本人修改）') !== -1, '创建后副标题显示初始密码（待本人修改）');
  ok(/创建于 \d{4}-\d{2}-\d{2}</.test(accHtmlA) && !/创建于 \d{4}-\d{2}-\d{2}T/.test(accHtmlA),
    '副标题「创建于」格式化为 YYYY-MM-DD（不再显示 ISO 原始串）');
  vm.runInContext('resetUserPwd("' + made.user.id + '")', ctx);
  const alertsBeforeReset = alerts.length;
  await vm.runInContext('cfCallback()', ctx);  // 模拟点「确认」
  await new Promise(r=>setTimeout(r, 400));
  ok(alerts.length > alertsBeforeReset && alerts[alerts.length-1].indexOf('密码已重置为') !== -1,
    '重置密码按钮全链路生效（确认弹窗→接口→生成新密码提示）');
  const resetPwd = (alerts[alerts.length-1].match(/密码已重置为：([a-z0-9]+)/) || [])[1];
  const accHtmlB = documentStub.getElementById('accounts-list').innerHTML;
  ok(resetPwd && accHtmlB.indexOf('初始密码：' + resetPwd) !== -1, '重置后副标题更新为新初始密码（持久显示）');
  vm.runInContext('toggleUser("' + made.user.id + '")', ctx);
  await vm.runInContext('cfCallback()', ctx);
  await new Promise(r=>setTimeout(r, 400));
  const ta1After = (await wb.Api.listUsers()).find(u=>u.id===made.user.id);
  ok(ta1After && ta1After.disabled === true, '停用按钮全链路生效（账号已停用）');
  ok(alerts[alerts.length-1].indexOf('已停用「王助教」，其名下数据完整保留') !== -1, '停用成功后 alert 反馈（数据保留说明）');
  vm.runInContext('toggleUser("' + made.user.id + '")', ctx);  // 复位：重新启用，避免影响后续用例
  await vm.runInContext('cfCallback()', ctx);
  await new Promise(r=>setTimeout(r, 400));
  ok(alerts[alerts.length-1].indexOf('已启用「王助教」') !== -1, '启用成功后 alert 反馈');
  await wb.Api.resetPassword(made.user.id, 'ta123456');  // 复位密码，供后续登录用例使用
  // 教务直接在服务端给 ta1/ta2 各录一名学生（模拟别的助教已有数据）
  const adminToken = wb.HttpApi._token;
  const sreq = (body) => fetch(base + '/api/students', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken }, body: JSON.stringify(body) });
  // 先把学生转到 ta1 名下：教务创建后转移
  const s1 = await (await sreq({ name: '林小满', school: '深外', gradYear: '2027' })).json();
  await fetch(base + '/api/students/' + s1.student.id + '/owner', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken },
    body: JSON.stringify({ ownerId: made.user.id }) });
  ok(true, '教务为 ta1 准备一名学生');

  /* ---- 助教登录只见自己数据 ---- */
  wb.doLogout();
  const taLogin = await wb.Api.login('ta1', 'ta123456', 'ta');
  ok(taLogin.ok && taLogin.user.mustChangePwd === true, '助教首次登录（需改密）');
  // doLogin 会拉 state；强制改密流程先走完
  await wb.doLogin('ta1', 'ta123456', 'ta');
  await wb.doChangePwd('ta123456', 'ta654321', 'ta654321');
  ok(wb.currentUser && wb.currentUser.username === 'ta1', '助教改密后进入主界面');
  ok(wb.currentUser.mustChangePwd === false, '改密成功后本地 mustChangePwd 同步置否');
  ok(wb.state.students.length === 1 && wb.state.students[0].ownerId === wb.currentUser.id,
    '助教登录后只见自己名下学生（服务端过滤）');

  /* ================= M5b：写路径全链路 ================= */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const apiGetState = async () => (await wb.HttpApi.getState()).state;
  const sid = wb.state.students[0].id;
  const subj = '学科 / AP / 微积分BC';
  const setVal = (id, v) => { documentStub.getElementById(id).value = v; };

  /* ---- 录入作业（本地乐观 + 异步持久化 + id 回填） ---- */
  wb.setQuickEntry({ gid: sid, subject: subj });
  setVal('qe-date', ''); setVal('qe-total', '20'); setVal('qe-correct', '18'); setVal('qe-wrongs', '7,14');
  wb.saveQuickEntry();
  await sleep(300);
  let st1 = await apiGetState();
  ok(st1.records.some(r=>r.studentId===sid && r.total===20 && r.correct===18), '录入作业已持久化到服务端');
  const recId = wb.pool.records.find(r=>r.studentId===sid && r.total===20).id;
  ok(st1.records.some(r=>r.id===recId), '记录 id 客户端生成并贯穿（服务端与本地一致）');

  /* ---- 附件：上传 → 记录引用文件 id → state 回读 ---- */
  const fd = new FormData();
  fd.append('files', new Blob([Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(248, 7)])], { type: 'image/png' }), '批改.png');
  const up = await wb.HttpApi.uploadFiles(fd);
  ok(up.ok && up.files[0].id, '附件上传成功（FormData）');
  const fileId = up.files[0].id;
  const rec2 = await wb.HttpApi.addRecord({ studentId: sid, date: '2026-08-28', total: 10, correct: 9, wrongs: [3], subject: subj, images: [fileId], pdfs: [] });
  ok(rec2.ok, '带附件 id 的作业记录创建成功');
  await wb.resyncState();
  ok(wb.pool.records.some(r=>r.images && r.images[0]===fileId), '重取 state 后本地记录含附件文件 id');
  ok(wb.fileUrl(fileId).indexOf('/api/files/' + fileId + '?token=') === 0, '附件直链拼 token 参数');

  /* ---- 登记未交 → 软删除 ---- */
  wb.setQuickEntry({ gid: sid, subject: '竞赛 / AMC10' });
  setVal('sl-date', '');
  const missBefore = wb.pool.missed.length;
  wb.markMissedToday();
  ok(wb.pool.missed.length === missBefore + 1, '登记未交本地生效');
  await sleep(300);
  st1 = await apiGetState();
  const missRow = st1.missed.find(m=>m.studentId===sid && !m.resolved);
  ok(!!missRow, '登记未交已持久化到服务端');
  wb.removeMissed(missRow.id);
  documentStub.getElementById('cf-ok').onclick();  // 二次确认
  await sleep(300);
  st1 = await apiGetState();
  const missRow2 = st1.missed.find(m=>m.id===missRow.id);
  ok(missRow2 && missRow2.resolved && missRow2.resolution === 'deleted', '软删除已持久化（resolved + resolution=deleted）');

  /* ---- 计划次数：首次直存 → 二次申请 → 教务通过 ---- */
  wb.setQuickEntry({ gid: sid, subject: subj });
  setVal('qe-plan', '10');
  setVal('qe-first-class', '');
  wb.savePlanCount();
  await sleep(300);
  st1 = await apiGetState();
  ok(!(st1.students.find(s=>s.id===sid).subjPlans || {})[subj], '首次设定缺开课日期被拦截');
  setVal('qe-first-class', '2026-08-20');
  wb.savePlanCount();
  await sleep(300);
  st1 = await apiGetState();
  ok(st1.students.find(s=>s.id===sid).subjPlans[subj] === 10, '首次设定计划直存到服务端');
  ok(st1.students.find(s=>s.id===sid).subjFirstClass
    && st1.students.find(s=>s.id===sid).subjFirstClass[subj] === '2026-08-20',
    'firstClassDate 随 plan/set 写入并序列化带出（state 回读）');
  setVal('qe-plan', '12');
  wb.savePlanCount();  // 打开申请弹窗
  setVal('pr-reason', '加课');
  wb.submitPlanRequest();
  await sleep(300);
  st1 = await apiGetState();
  const pendReq = st1.planRequests.find(r=>r.studentId===sid && r.status==='pending');
  ok(pendReq && pendReq.oldPlan === 10 && pendReq.newPlan === 12, '二次修改申请已提交服务端（pending）');
  // 教务通过
  await wb.doLogin('admin', 'admin456', 'admin');
  await wb.Api.reviewPlanRequest(pendReq.id, true);
  await sleep(300);
  st1 = await apiGetState();
  ok(st1.students.find(s=>s.id===sid).subjPlans[subj] === 12, '教务审批通过后计划次数生效');
  ok(st1.planRequests.find(r=>r.id===pendReq.id).status === 'approved', '申请状态已更新 approved');

  /* ---- 初始密码副标题消失：ta1 此前已自行改密（ta654321），其账号行不再展示初始密码 ---- */
  await vm.runInContext('renderAccounts()', ctx);  // 此时仅 admin/ta1 两个账号且均已改密
  ok(documentStub.getElementById('accounts-list').innerHTML.indexOf('初始密码') === -1,
    '本人改密后副标题初始密码行消失（tempPassword 已清除）');

  /* ---- 转移归属 ---- */
  const ta2Made = await wb.Api.createUser('李助教', 'ta2', 'ta123456', 'ta');
  await wb.Api.transferStudent([sid], ta2Made.user.id);
  await sleep(300);
  st1 = await apiGetState();
  ok(st1.students.find(s=>s.id===sid).ownerId === ta2Made.user.id, '转移归属后学生 ownerId 已变更');
  ok(st1.records.filter(r=>r.studentId===sid).every(r=>r.ownerId===ta2Made.user.id), '转移后作业记录归属跟随');

  /* ---- 审计日志（服务端口径） ---- */
  await wb.doLogin('ta1', 'ta654321', 'ta');
  const auditResp = await wb.HttpApi._req('GET', '/api/audit-logs?range=0&pageSize=50');
  ok(auditResp.ok && auditResp.total > 0, '助教可查审计日志接口');
  ok(auditResp.items.every(l=>l.userId===wb.currentUser.id || l.ownerId===wb.currentUser.id), '助教审计口径：只见自己相关');
  wb.switchTab('audit');
  await sleep(400);
  ok(documentStub.getElementById('audit-list').innerHTML.indexOf('audit-row') !== -1, '操作记录页（API 模式）渲染服务端日志');
  ok(documentStub.getElementById('audit-count').textContent.indexOf('共 ') !== -1, '结果统计行渲染');

  /* ---- 销售端接口化 ---- */
  // 先回教务：创建销售账号 + 把学生转回 ta1，再验证销售搜索
  await wb.doLogin('admin', 'admin456', 'admin');
  await wb.Api.createUser('张顾问', 'sales1', 'sales123456', 'sales');
  await wb.Api.transferStudent([sid], (await wb.Api.listUsers()).find(u=>u.username==='ta1').id);
  wb.doLogout();
  await wb.doLogin('sales1', 'sales123456', 'sales');
  wb.setStuQuery('林');
  await sleep(400);
  ok(documentStub.getElementById('stu-list').innerHTML.indexOf('林小满') !== -1, '销售搜索出学生卡（走服务端接口）');
  ok(wb.pool.students.length === 0, '销售本地不拉全量（state 无权限）');
  await wb.toggleSalesSubjectApi(sid, subj, false);
  await sleep(400);
  const panelEl = documentStub.getElementById('sales-api-panel-' + sid);
  ok(panelEl && panelEl.innerHTML.indexOf('作业打卡（只读）') !== -1, '销售科目只读详情面板渲染');

  /* ---- M5c：评语/学习计划建议/模考/科目管理接通 ---- */
  await wb.doLogin('ta1', 'ta654321', 'ta');
  wb.setQuickEntry({ gid: sid, subject: subj });
  setVal('qe-comment', '本月进步明显');
  wb.saveSubjectComment();
  setVal('qe-advice', '每周复盘错题');
  wb.saveSubjectAdvice();
  setVal('mock-score', '92');
  wb.saveMockScore();
  await sleep(400);
  st1 = await apiGetState();
  const stuRow = st1.students.find(s=>s.id===sid);
  ok(stuRow.subjComments && stuRow.subjComments[subj] === '本月进步明显', '评语已持久化到服务端（state 回读）');
  ok(stuRow.subjAdvice && stuRow.subjAdvice[subj] === '每周复盘错题', '学习计划建议已持久化（state 回读）');
  ok(stuRow.mock && stuRow.mock[subj] && stuRow.mock[subj].score === 92, '模考分数已持久化（state 回读）');
  documentStub.getElementById('as-' + sid + '-s1').value = '__custom__';
  documentStub.getElementById('as-' + sid + '-custom').value = '测试科目X';
  wb.confirmAddSubject(sid);
  await sleep(400);
  st1 = await apiGetState();
  ok((st1.students.find(s=>s.id===sid).subjects || []).indexOf('测试科目X') !== -1, '添加科目已持久化（state 回读）');
  // 开课日期直改（走 subj-fields 白名单 subjFirstClass，不审批）
  wb.setQuickEntry({ gid: sid, subject: subj });
  wb.editFirstClass();
  setVal('qe-first-class-edit', '2026-08-25');
  wb.saveFirstClass();
  await sleep(300);
  st1 = await apiGetState();
  ok(st1.students.find(s=>s.id===sid).subjFirstClass[subj] === '2026-08-25', '开课日期直改经 subj-fields 白名单持久化');

  /* ---- 家长分享：报告预览弹窗生成免登录 H5 报告链接（API 模式全链路） ---- */
  vm.runInContext('genReport()', ctx);  // quickEntry 仍指向 sid/subj
  ok(documentStub.getElementById('report-modal').classList.contains('show'), '报告预览弹窗打开（分享入口所在）');
  await vm.runInContext('shareReportToParent()', ctx);
  const shareLink = documentStub.getElementById('rp-share-link').value;
  ok(documentStub.getElementById('rp-share-row').style.display === '' && /^\/r\/[0-9a-f]{32}$/.test(shareLink),
    '「分享给家长」生成 /r/<token> 链接并显示链接框');
  const sharePageResp = await fetch(base + shareLink);  // 桩环境无 location.origin，链接为相对路径
  const shareHtml = await sharePageResp.text();
  ok(sharePageResp.status === 200 && shareHtml.indexOf('作业打卡报告') !== -1 && shareHtml.indexOf('林小满') !== -1,
    '公开报告页免登录可访问且含该学生报告内容');

  /* ---- 科目树接口：助教可读不可写；教务可改且 GET 回读生效 ---- */
  const treeTa = await wb.HttpApi._req('GET', '/api/subjects');
  ok(treeTa.ok && treeTa.tree && treeTa.tree['学科'], '助教 GET /api/subjects 可读');
  const putTa = await wb.HttpApi._req('PUT', '/api/subjects', { tree: {} });
  ok(!putTa.ok, '助教 PUT /api/subjects 被拒（403）');
  await wb.doLogin('admin', 'admin456', 'admin');
  const treeAdm = await wb.HttpApi._req('GET', '/api/subjects');
  ok(treeAdm.ok && treeAdm.tree['学科']['AP'].indexOf('微积分BC') !== -1, '教务 GET /api/subjects 返回默认科目树');
  const newTree = JSON.parse(JSON.stringify(treeAdm.tree));
  newTree['测试分类'] = { '测试系列': ['测试科目'] };
  ok((await wb.HttpApi._req('PUT', '/api/subjects', { tree: newTree })).ok, '教务 PUT /api/subjects 保存成功');
  const treeBack = await wb.HttpApi._req('GET', '/api/subjects');
  ok(treeBack.tree['测试分类'] && treeBack.tree['测试分类']['测试系列'][0] === '测试科目', 'GET 回读新科目树（教务改动生效）');
  await wb.HttpApi._req('PUT', '/api/subjects', { tree: treeAdm.tree });  // 恢复默认树，避免影响其他用例

  /* ---- 客户端 id 贯穿时序：新增学生不跳底 + 新增科目面板可开 + 删除格子可用 ---- */
  await wb.doLogin('ta1', 'ta654321', 'ta');
  const addResp = await wb.HttpApi.addStudent({ id: 'e2e-stu-new', name: '新生丙', gradYear: '2027' });
  ok(addResp.ok && addResp.student && addResp.student.id === 'e2e-stu-new', '后端采用客户端 id（新增学生）');
  await wb.resyncState();  // 模拟重取 state（原先 id 回填替换后会跳底的场景）
  const listHtml = documentStub.getElementById('stu-list').innerHTML;
  ok(listHtml.indexOf('新生丙') !== -1 && listHtml.indexOf('新生丙') < listHtml.indexOf('林小满'),
    '重取 state 后新增学生仍在列表首位（createdAt 排序键生效）');
  vm.runInContext("toggleAddSubject('e2e-stu-new')", ctx);
  ok(documentStub.getElementById('stu-list').innerHTML.indexOf('add-subj-panel') !== -1, '点新增科目面板出现（id 引用未失效）');
  vm.runInContext("toggleAddSubject('e2e-stu-new')", ctx);  // 收起面板
  // 录入作业 → 删除格子可用（id 引用全程有效）
  wb.setQuickEntry({ gid: 'e2e-stu-new', subject: '学科 / AP / 微积分BC' });
  setVal('qe-date', ''); setVal('qe-total', '10'); setVal('qe-correct', '9'); setVal('qe-wrongs', '3');
  wb.saveQuickEntry();
  await sleep(300);
  const newRec = wb.pool.records.find(r => r.studentId === 'e2e-stu-new');
  ok(newRec && (await apiGetState()).records.some(r => r.id === newRec.id), '录入作业已持久化（服务端与本地 id 一致）');
  wb.setSlotEdit({ gid: 'e2e-stu-new', subject: '学科 / AP / 微积分BC', idx: 1 });
  vm.runInContext('deleteSlot()', ctx);
  await vm.runInContext('cfCallback()', ctx);  // 二次确认删除
  await sleep(300);
  ok(!wb.pool.records.some(r => r.id === newRec.id) && !(await apiGetState()).records.some(r => r.id === newRec.id),
    '删除格子可用且服务端同步删除（id 引用全程有效）');

  console.log('\ne2e 断言：' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  srv.close();
  try{ fs.unlinkSync(TEST_DB); fs.unlinkSync(TEST_DB + '-wal'); fs.unlinkSync(TEST_DB + '-shm'); }catch(e){}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
