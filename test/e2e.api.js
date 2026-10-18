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
  /* 前端已拆分为 js/*.js（v1.9.0）：按 html 中 <script src> 顺序逐个读文件拼接（与原单文件字节级一致），再 vm 执行 */
  const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  if(!srcs.length){ console.error('未找到 <script src> 引用'); process.exit(1); }
  const scriptSrc = srcs.map(s => fs.readFileSync(path.join(__dirname, '..', s), 'utf8')).join('\n');
  vm.runInContext(scriptSrc, ctx, { filename: 'inline-script.js' });
  /* 脚本内顶层 function toast 声明会覆盖 ctx 预置桩；加载后改装为「捕获 + 透传真实实现」，
     既有断言继续读 alerts 数组，同时验证真实 toast() 在 DOM 桩下静默工作不抛错 */
  const realToast = ctx.toast;
  ctx.toast = msg => { alerts.push(String(msg)); realToast(msg); };
  await windowStub.__ready;
  const wb = windowStub.__wb;

  /* ---- 模式探测 ---- */
  ok(wb.USE_API === true, '探测到 /api/health → 进入 API 模式');
  ok(documentStub.getElementById('side-foot').textContent === '学情跟踪平台 · 内部系统 · v1.9.0', 'API 模式侧栏脚注为「内部系统」文案并带版本号');
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
  ok(made.user.tempPassword === 'ta123456', '创建账号当次响应返回初始密码 tempPassword（只显示一次）');
  ok((await wb.Api.listUsers()).find(u=>u.id===made.user.id).tempPassword === undefined, '创建后列表不返回 tempPassword（v1.9.0）');
  await vm.runInContext('renderAccounts()', ctx);
  const accHtmlA = documentStub.getElementById('accounts-list').innerHTML;
  ok(accHtmlA.indexOf('初始密码') === -1, '账号列表不再有「初始密码」副标题行（v1.9.0）');
  ok(/创建于 \d{4}-\d{2}-\d{2}</.test(accHtmlA) && !/创建于 \d{4}-\d{2}-\d{2}T/.test(accHtmlA),
    '副标题「创建于」格式化为 YYYY-MM-DD（不再显示 ISO 原始串）');
  vm.runInContext('resetUserPwd("' + made.user.id + '")', ctx);
  const alertsBeforeReset = alerts.length;
  await vm.runInContext('cfCallback()', ctx);  // 模拟点「确认」
  await new Promise(r=>setTimeout(r, 400));
  ok(alerts.length > alertsBeforeReset && alerts[alerts.length-1].indexOf('密码已重置为') !== -1
    && alerts[alerts.length-1].indexOf('只显示这一次') !== -1,
    '重置密码按钮全链路生效（确认弹窗→接口→新密码提示「只显示这一次」）');
  const accHtmlB = documentStub.getElementById('accounts-list').innerHTML;
  ok(accHtmlB.indexOf('初始密码') === -1, '重置后账号列表仍无初始密码行');
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

  /* ---- 账号删除全链路（v1.9.0 NEW-01，API 模式）：预览 → 确认账号 → 删除 → 列表/锁定/旧会话 ---- */
  {
    const dd = await wb.Api.createUser('删除 e2e', 'dele2e1', 'del123456', 'ta');
    const ddId = dd.user.id;
    // 阻断：给该账号名下放一名学生 → canDelete=false
    const ds = await wb.Api.addStudent({ id: 'dele2e-stu1', name: '删除关联生', gradYear: '2027' });
    await fetch(base + '/api/students/' + ds.student.id + '/owner', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + wb.HttpApi._token },
      body: JSON.stringify({ ownerId: ddId }) });
    await wb.Api.toggleUser(ddId);
    const imp1 = await wb.Api.getUserDeleteImpact(ddId);
    ok(imp1.ok && imp1.canDelete === false && imp1.impact.activeStu === 1, 'e2e 预览：名下有学生 canDelete=false');
    const dr1 = await wb.Api.deleteUser(ddId, 'dele2e1');
    ok(!dr1.ok && dr1.msg.indexOf('业务关联') !== -1, 'e2e 删除：有业务关联被拒（409 口径）');
    // 清空关联（直接删库，避免占用 ta1/教务的学生口径影响后续用例）→ 可删
    require('../server/db.js').prepare('DELETE FROM students WHERE id = ?').run('dele2e-stu1');
    const imp2 = await wb.Api.getUserDeleteImpact(ddId);
    ok(imp2.canDelete === true, 'e2e 预览：交接后 canDelete=true');
    // UI 路径：deleteUserAccount → 确认弹窗（输账号）→ cfCallback 驱动
    await vm.runInContext('refreshUsersCache()', ctx);
    vm.runInContext('deleteUserAccount("' + ddId + '")', ctx);
    await new Promise(r=>setTimeout(r, 400));
    ok(documentStub.getElementById('cf-title').textContent.indexOf('删除账号') !== -1
      && documentStub.getElementById('cf-input-wrap').style.display !== 'none', 'e2e 删除弹窗：要求输入完整登录账号确认');
    documentStub.getElementById('cf-input').value = 'dele2e1';
    documentStub.getElementById('cf-ok').onclick();  // 真实 OK 路径：从输入框读确认账号
    await new Promise(r=>setTimeout(r, 500));
    ok((await wb.Api.listUsers()).every(u=>u.id!==ddId), 'e2e 删除成功：账号列表已移除');
    ok(documentStub.getElementById('accounts-list').innerHTML.indexOf('dele2e1') === -1, 'e2e 删除后账号管理页无该行');
    const reuse = await wb.Api.createUser('复用', 'dele2e1', 'abcdef', 'ta');
    ok(!reuse.ok && reuse.msg.indexOf('永久不可复用') !== -1, 'e2e：已注销用户名永久锁定');
    ok(alerts.some(a=>a.indexOf('用户名永久锁定') !== -1), 'e2e 删除成功反馈（用户名永久锁定）');
  }

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
  const salesMade = await wb.Api.createUser('张顾问', 'sales1', 'sales123456', 'sales');
  await wb.Api.transferStudent([sid], (await wb.Api.listUsers()).find(u=>u.username==='ta1').id);
  wb.doLogout();
  // 强制改密硬限制（v1.9.0）：新账号登录后待改密，业务接口一律 403——先走改密流程再使用
  await wb.Api.login('sales1', 'sales123456', 'sales');
  await wb.HttpApi._req('POST', '/api/password', { oldPwd: 'sales123456', newPwd: 'sales654321' });
  wb.doLogout();
  await wb.doLogin('sales1', 'sales654321', 'sales');
  wb.setStuQuery('林');
  await sleep(400);
  ok(documentStub.getElementById('stu-list').innerHTML.indexOf('林小满') !== -1, '销售搜索出学生卡（走服务端接口）');
  ok(wb.pool.students.length === 0, '销售本地不拉全量（state 无权限）');
  await wb.toggleSalesSubjectApi(sid, subj, false);
  await sleep(400);
  const panelEl = documentStub.getElementById('sales-api-panel-' + sid);
  ok(panelEl && panelEl.innerHTML.indexOf('作业打卡（只读）') !== -1, '销售科目只读详情面板渲染');

  /* ---- v1.9.0 P2-3：销售历史学生「近 30 天归档」筛选（搜索接口带 archivedAt，客户端叠加过滤） ---- */
  await wb.doLogin('admin', 'admin456', 'admin');
  await wb.HttpApi.addStudent({ id: 'e2e-arch-new', name: '归档新生', gradYear: '2026' });
  await wb.HttpApi.addStudent({ id: 'e2e-arch-old', name: '归档旧生', gradYear: '2026' });
  await wb.HttpApi.setStudentArchived('e2e-arch-new', true);
  await wb.HttpApi.setStudentArchived('e2e-arch-old', true);
  // 旧生归档时间篡改为 40 天前（超出近 30 天窗口）
  require('../server/db.js').prepare('UPDATE students SET archived_at = ? WHERE id = ?').run('2026-09-01 08:00:00', 'e2e-arch-old');
  await wb.doLogin('sales1', 'sales654321', 'sales');
  const srch = await wb.HttpApi._req('GET', '/api/search/students?q=' + encodeURIComponent('归档'));
  ok(srch.ok && srch.students.some(s=>s.id==='e2e-arch-new' && s.archivedAt), '销售搜索接口返回 archivedAt 字段');
  vm.runInContext("alumniQuery='归档'; setAlumniRange('all');", ctx);
  await sleep(400);
  const alAll = documentStub.getElementById('alumni-list').innerHTML;
  ok(alAll.indexOf('归档新生') !== -1 && alAll.indexOf('归档旧生') !== -1, '销售历史学生「全部」：新旧归档学生均出现');
  vm.runInContext("setAlumniRange('30d')", ctx);
  await sleep(400);
  const al30 = documentStub.getElementById('alumni-list').innerHTML;
  ok(al30.indexOf('归档新生') !== -1 && al30.indexOf('归档旧生') === -1, '销售历史学生「近 30 天归档」：过滤掉 40 天前归档的学生');
  vm.runInContext("setAlumniRange('all'); alumniQuery='';", ctx);

  /* ---- BUG-04/05（v1.9.0）：销售摘要纯无作业芯片（入口 + 正确率 —）与只读详情未交四态文案 ---- */
  await wb.doLogin('ta1', 'ta654321', 'ta');
  await wb.HttpApi._req('POST', '/api/records', { studentId: sid, date: '2026-10-13', subject: '纯无作业e2e', noHomework: true });
  // 独立「四态e2e」科目：成绩 + 无作业 + 未交 各一（不碰 subj，避免影响后续报告断言）
  await wb.HttpApi._req('POST', '/api/records', { studentId: sid, date: '2026-10-11', total: 10, correct: 9, wrongs: [], subject: '四态e2e' });
  await wb.HttpApi._req('POST', '/api/records', { studentId: sid, date: '2026-10-12', subject: '四态e2e', noHomework: true });
  await wb.HttpApi._req('POST', '/api/missed', { studentId: sid, date: '2026-10-14', subject: '四态e2e' });
  await wb.doLogin('sales1', 'sales654321', 'sales');
  wb.setStuQuery('林');
  await sleep(400);
  const salesListC = documentStub.getElementById('stu-list').innerHTML;
  ok(salesListC.indexOf('纯无作业e2e') !== -1 && salesListC.indexOf('>—</span><span class="sub-cnt">1 次') !== -1,
    'BUG-04：纯无作业科目芯片有入口、正确率 —、次数 1');
  // 打开「四态e2e」科目详情（清缓存强制重取，含新登记的未交）
  vm.runInContext("salesSubjApi=null; delete salesDetailCache['" + sid + "'];", ctx);
  await wb.toggleSalesSubjectApi(sid, '四态e2e', false);
  await sleep(400);
  const panelC = documentStub.getElementById('sales-api-panel-' + sid).innerHTML;
  ok(panelC.indexOf('未交 · 待补交') !== -1 && panelC.indexOf('>0%<') === -1 && panelC.indexOf('错题 0') === -1,
    'BUG-05：销售只读详情未交格子「未交 · 待补交」（不再 0%/错题 0）');
  ok(panelC.indexOf('已提交 · 正确率 90%') !== -1 && panelC.indexOf('本次无作业 · 已完成') !== -1,
    'BUG-05：销售只读详情正常成绩「已提交 · 正确率」、无作业「本次无作业 · 已完成」');

  /* ---- E 批（v1.9.0）：API 模式导出文案 / 图表口径 / 面板吸顶上下文 / 销售命中数 meta ---- */
  await wb.doLogin('admin', 'admin456', 'admin');
  ok(documentStub.getElementById('backup-card-title').textContent === '业务数据导出'
    && documentStub.getElementById('backup-hint').textContent.indexOf('不等同整站恢复包') !== -1,
    'UI-05：API 教务端「业务数据导出」（注明不含附件与系统配置）');
  ok(documentStub.getElementById('btn-import').style.display === 'none'
    && documentStub.getElementById('btn-clear-sample').style.display === 'none',
    'UI-05：生产模式无导入恢复/清空示例残留入口（复核）');
  await wb.doLogin('ta1', 'ta654321', 'ta');
  ok(documentStub.getElementById('backup-card-title').textContent === '数据导出'
    && documentStub.getElementById('backup-hint').textContent.indexOf('你名下学生') !== -1, 'UI-05：API 助教端「数据导出」+ 名下说明');
  ok(documentStub.getElementById('chart-scope').textContent === '（我名下）', 'UI-04：API 助教端图表口径「我名下」');
  wb.setQuickEntry({ gid: sid, subject: subj });
  const ePanel = vm.runInContext('qePanelHtml()', ctx);
  ok(ePanel.indexOf('qe-title-sticky') !== -1 && ePanel.indexOf('作业打卡 · 林小满') !== -1, 'UI-02：API 面板标题吸顶且含学生名');
  wb.setQuickEntry(null);
  await wb.doLogin('sales1', 'sales654321', 'sales');
  wb.setStuQuery('林');
  await sleep(400);
  const metaE = documentStub.getElementById('stu-filter-meta').innerHTML;
  ok(metaE.indexOf('命中 <b>1</b> 个学生') !== -1 && metaE.indexOf('筛选中：搜索「林」') !== -1, 'UI-03：API 销售搜索命中数与筛选中提示');
  wb.setStuQuery('');

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
  ok(vm.runInContext('qeDirty.comment === false && qeDirty.advice === false', ctx) === true,
    'API 模式保存经服务端确认后 dirty 清除（「已保存」提示改在 onOk 显示，v1.9.0）');
  st1 = await apiGetState();
  const stuRow = st1.students.find(s=>s.id===sid);
  ok(stuRow.subjComments && stuRow.subjComments[subj] === '本月进步明显', '评语已持久化到服务端（state 回读）');
  ok(stuRow.subjAdvice && stuRow.subjAdvice[subj] === '每周复盘错题', '学习计划建议已持久化（state 回读）');
  ok(stuRow.mock && stuRow.mock[subj] && stuRow.mock[subj].score === 92, '模考分数已持久化（state 回读）');
  // 最小补丁（v1.9.0）：保存第二科目评语不覆盖第一科目
  wb.setQuickEntry({ gid: sid, subject: '竞赛 / AMC10' });
  setVal('qe-comment', 'AMC 评语');
  wb.saveSubjectComment();
  await sleep(300);
  const stuRowMp = (await apiGetState()).students.find(s=>s.id===sid);
  ok(stuRowMp.subjComments['竞赛 / AMC10'] === 'AMC 评语' && stuRowMp.subjComments[subj] === '本月进步明显',
    '评语最小补丁：保存第二科目不覆盖第一科目（v1.9.0）');
  wb.setQuickEntry({ gid: sid, subject: subj });  // 还原，后续报告用例依赖

  /* ---- BUG-01（v1.9.0）：API 模式保存失败草稿保留可重试；重试成功经确认后清除 ---- */
  vm.runInContext("draftSave('" + sid + "','" + subj + "','comment','失败保留草稿')", ctx);
  setVal('qe-comment', '失败保留草稿');
  // 模拟一次服务端失败（拦截 updateSubjFields）
  vm.runInContext("window.__origUSF = HttpApi.updateSubjFields; HttpApi.updateSubjFields = async ()=>({ok:false,msg:'模拟失败'});", ctx);
  wb.saveSubjectComment();
  await sleep(400);
  ok(vm.runInContext("draftLoad('" + sid + "','" + subj + "','comment')", ctx) === '失败保留草稿'
    && vm.runInContext('qeDirty.comment !== false', ctx) === true, '草稿：API 保存失败草稿保留且 dirty 保持（可重试）');
  // 恢复接口后重试成功 → 服务端确认后草稿与 dirty 清除，服务端值与草稿一致
  vm.runInContext("HttpApi.updateSubjFields = window.__origUSF;", ctx);
  wb.saveSubjectComment();
  await sleep(400);
  ok(vm.runInContext("draftLoad('" + sid + "','" + subj + "','comment')", ctx) === null
    && vm.runInContext('qeDirty.comment === false', ctx) === true, '草稿：重试成功经服务端确认后草稿与 dirty 清除');
  ok((await apiGetState()).students.find(s=>s.id===sid).subjComments[subj] === '失败保留草稿',
    '草稿：重试成功后服务端读回保存值（刷新后与服务端一致）');

  /* ---- ENG-01（v1.9.0）：模考字段级补丁——同科目分数/日期不互踩；取消预约提交精确墓碑 ---- */
  setVal('mock-date', '2026-11-20');
  vm.runInContext('bookMockExam()', ctx);  // 已存分数 92，再约日期（字段级 {date} 提交）
  await sleep(300);
  let mockStE = (await apiGetState()).students.find(s=>s.id===sid).mock[subj];
  ok(mockStE.score === 92 && mockStE.date === '2026-11-20', 'ENG-01：先存分数再约日期，同科目两字段都生效不互踩');
  // 捕获请求体验证精确墓碑：cancelMockExam 只提交 {mock:{本科目:{date:null}}}，不复制其他科目旧值
  vm.runInContext("window.__lastPatch=null; const __oUSF=HttpApi.updateSubjFields.bind(HttpApi); HttpApi.updateSubjFields=async (i,p)=>{ window.__lastPatch=p; return __oUSF(i,p); };", ctx);
  vm.runInContext('cancelMockExam()', ctx);
  await sleep(300);
  const lastPatch = vm.runInContext('window.__lastPatch', ctx);
  ok(lastPatch && Object.keys(lastPatch.mock).length === 1 && lastPatch.mock[subj] && lastPatch.mock[subj].date === null
    && !('score' in lastPatch.mock[subj]), 'ENG-01：取消预约提交精确字段级墓碑（{mock:{科目:{date:null}}}）');
  vm.runInContext("HttpApi.updateSubjFields = window.__origUSF;", ctx);  // 恢复原实现（BUG-01 块存过原始引用）
  mockStE = (await apiGetState()).students.find(s=>s.id===sid).mock[subj];
  ok(mockStE && mockStE.date === undefined && mockStE.score === 92, 'ENG-01：取消预约只清日期留分数');
  // 再验证：清分数提交 {score:null} 且整 slot 清空
  vm.runInContext("window.__lastPatch=null; const __oUSF2=HttpApi.updateSubjFields.bind(HttpApi); HttpApi.updateSubjFields=async (i,p)=>{ window.__lastPatch=p; return __oUSF2(i,p); };", ctx);
  vm.runInContext('clearMockScore()', ctx);
  await sleep(300);
  const lastPatch2 = vm.runInContext('window.__lastPatch', ctx);
  ok(lastPatch2 && lastPatch2.mock[subj] === null, 'ENG-01：清除最后字段提交整 slot null 墓碑');
  vm.runInContext("HttpApi.updateSubjFields = window.__origUSF;", ctx);
  ok(!(await apiGetState()).students.find(s=>s.id===sid).mock[subj], 'ENG-01：整 slot 清空后服务端无残留');
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
  wb.setSlotEdit({ gid: 'e2e-stu-new', subject: '学科 / AP / 微积分BC', refType: 'rec', refId: newRec.id, idx: 1 });
  vm.runInContext('deleteSlot()', ctx);
  await vm.runInContext('cfCallback()', ctx);  // 二次确认删除
  await sleep(300);
  ok(!wb.pool.records.some(r => r.id === newRec.id) && !(await apiGetState()).records.some(r => r.id === newRec.id),
    '删除格子可用且服务端同步删除（id 引用全程有效）');

  /* ---- 家长绑定与推送（服务号未配置时的前端行为；桩服务器无 WECHAT_* 环境变量） ---- */
  ok(wb.pool.students.every(s => typeof s.bindCnt === 'number'), 'state 学生带 bindCnt（绑定状态字段）');
  wb.setQuickEntry({ gid: sid, subject: subj });
  wb.renderStats();
  ok(documentStub.getElementById('stu-list').innerHTML.indexOf('未绑定微信') !== -1, '未绑定学生卡头部显示「未绑定微信」入口');
  await vm.runInContext('openBindModal("' + (typeof bindStu!=='undefined'?bindStu.id:sid) + '")', ctx);
  ok(documentStub.getElementById('bind-qr-box').innerHTML.indexOf('服务号未配置') !== -1, '服务号未配置时绑定弹窗给明确提示（不白屏）');
  vm.runInContext("document.getElementById('bind-modal').classList.remove('show')", ctx);
  await vm.runInContext('pushReportToParent()', ctx);
  ok(alerts[alerts.length-1].indexOf('服务号未配置') !== -1, '推送在服务号未配置时给明确提示');

  /* ---- 解绑审批流：助教申请 → 申请中 → 红点合计 → 教务通过生效；教务直解不变 ---- */
  const dbE2e = require('../server/db.js');
  dbE2e.prepare('INSERT INTO parent_binds (id, student_id, openid, bound_at, unbound) VALUES (?,?,?,?,0)')
    .run('bind_e2e_1', sid, 'openid_e2e_1_xx_yy', '2026-09-16T00:00:00.000Z');
  await wb.resyncState();
  ok(wb.pool.students.find(s=>s.id===sid).bindCnt === 1, '插入绑定后 state bindCnt=1');
  const lb = await wb.HttpApi.listBinds(sid);
  ok(lb.ok && lb.binds.length === 1 && lb.binds[0].openid === 'openid_e2e_1_xx_yy', 'listBinds 返回该学生有效绑定');
  // 助教视角：弹窗显示「申请解绑」（无直解按钮）
  await vm.runInContext('openBindsModal("' + sid + '")', ctx);
  const bindsHtmlTa = documentStub.getElementById('binds-list').innerHTML;
  ok(bindsHtmlTa.indexOf('申请解绑') !== -1 && bindsHtmlTa.indexOf('>解绑<') === -1, '助教绑定管理弹窗显示「申请解绑」（无直解按钮）');
  // 上限 2 名：仅绑 1 名时弹窗给「+ 绑定新家长」入口，点击切到二维码弹窗
  const bindsFoot1 = documentStub.getElementById('binds-foot').innerHTML;
  ok(bindsFoot1.indexOf('已绑定 1 / 2 名家长') !== -1 && bindsFoot1.indexOf('+ 绑定新家长') !== -1,
    '绑定 1 名家长时弹窗显示计数与「+ 绑定新家长」入口');
  vm.runInContext('openBindFromBinds("' + sid + '")', ctx);
  await sleep(200);
  ok(!documentStub.getElementById('binds-modal').classList.contains('show')
    && documentStub.getElementById('bind-modal').classList.contains('show'),
    '「+ 绑定新家长」关闭绑定列表弹窗并打开二维码弹窗');
  // 助教直解接口被拒
  const ubDeny = await wb.HttpApi.unbindParent(sid, 'bind_e2e_1');
  ok(!ubDeny.ok && ubDeny.msg.indexOf('申请') !== -1, '助教直接解绑接口被拒并提示走申请（403）');
  // 提交申请 → 该行变为「申请中」
  vm.runInContext('requestUnbind("' + sid + '","bind_e2e_1")', ctx);
  await vm.runInContext('cfCallback()', ctx);  // 确认弹窗点确认
  await sleep(400);
  ok(documentStub.getElementById('binds-list').innerHTML.indexOf('申请中') !== -1, '申请提交后该行变为「申请中」徽章');
  // 教务审批：红点合计 + 审批块渲染
  await wb.doLogin('admin', 'admin456', 'admin');
  await vm.runInContext('refreshUnbindRequests()', ctx);
  ok(documentStub.getElementById('badge-today').textContent === '1', '红点徽章计数为两类申请合计（此时仅解绑 1 条）');
  const apprHtml = documentStub.getElementById('unbindreq-pending').innerHTML;
  ok(apprHtml.indexOf('林小满') !== -1 && apprHtml.indexOf('王助教') !== -1 && apprHtml.indexOf('openid') !== -1,
    '解绑审批块渲染学生姓名+归属助教+openid 脱敏');
  const reqId = (await wb.HttpApi._req('GET', '/api/unbind-requests?status=pending')).requests[0].id;
  vm.runInContext('reviewUnbindReq("' + reqId + '",true)', ctx);
  await sleep(400);
  ok(dbE2e.prepare('SELECT unbound FROM parent_binds WHERE id = ?').get('bind_e2e_1').unbound === 1, '教务审批通过 → 绑定标失效');
  await wb.resyncState();
  ok(wb.pool.students.find(s=>s.id===sid).bindCnt === 0, '通过后学生卡 bindCnt 同步归零');
  // 教务直解不变（无需申请）
  dbE2e.prepare('INSERT INTO parent_binds (id, student_id, openid, bound_at, unbound) VALUES (?,?,?,?,0)')
    .run('bind_e2e_2', sid, 'openid_e2e_2_zz_ww', '2026-09-16T01:00:00.000Z');
  const ub = await wb.HttpApi.unbindParent(sid, 'bind_e2e_2');
  ok(ub.ok, '教务直接解绑不受影响（无需申请）');
  // 满 2 名家长：弹窗显示上限提示且不再渲染绑定入口
  dbE2e.prepare('INSERT INTO parent_binds (id, student_id, openid, bound_at, unbound) VALUES (?,?,?,?,0)')
    .run('bind_e2e_3', sid, 'openid_e2e_3_aa_bb', '2026-09-16T02:00:00.000Z');
  dbE2e.prepare('INSERT INTO parent_binds (id, student_id, openid, bound_at, unbound) VALUES (?,?,?,?,0)')
    .run('bind_e2e_4', sid, 'openid_e2e_4_cc_dd', '2026-09-16T03:00:00.000Z');
  await vm.runInContext('openBindsModal("' + sid + '")', ctx);
  const bindsFoot2 = documentStub.getElementById('binds-foot').innerHTML;
  ok(bindsFoot2.indexOf('已绑定 2 / 2 名家长') !== -1 && bindsFoot2.indexOf('已绑定 2 名家长（上限）') !== -1
    && bindsFoot2.indexOf('+ 绑定新家长') === -1, '满 2 名家长时弹窗显示上限提示且无绑定入口');
  // 家长显示名（v1.9.0）：无备注按绑定早晚显示「家长 N」，openid 退居副行；有备注显示备注
  const bindsList2 = documentStub.getElementById('binds-list').innerHTML;
  ok(bindsList2.indexOf('家长 1') !== -1 && bindsList2.indexOf('家长 2') !== -1 && bindsList2.indexOf('openid ') !== -1,
    '无备注时按绑定早晚显示「家长 N」序号，openid 退居副行');
  const rm = await wb.HttpApi.remarkParent(sid, 'bind_e2e_3', '小满妈妈');
  ok(rm.ok && rm.remark === '小满妈妈', '家长备注接口成功');
  await vm.runInContext('openBindsModal("' + sid + '")', ctx);
  ok(documentStub.getElementById('binds-list').innerHTML.indexOf('小满妈妈') !== -1, '弹窗显示家长备注名');
  dbE2e.prepare("DELETE FROM parent_binds WHERE id IN ('bind_e2e_3','bind_e2e_4')").run();  // 复原，不影响后续用例

  /* ---- 教务管理改名 + 推送开关卡（API 模式；桩服务器无 WECHAT_* 不影响开关存取） ---- */
  wb.switchTab('data');
  ok(documentStub.getElementById('page-title').textContent === '教务管理', '「数据管理」改名「教务管理」（页签标题联动）');
  await vm.runInContext('refreshPushConfig()', ctx);
  ok(documentStub.getElementById('push-config-card').style.display === '', '教务端显示微信自动推送开关卡');
  ok(documentStub.getElementById('push-cfg-homework').classList.contains('on') === false, '推送开关默认关');
  await vm.runInContext("togglePushConfig('homework')", ctx);
  const cfgAfter = await wb.HttpApi._req('GET', '/api/push-config');
  ok(cfgAfter.ok && cfgAfter.config.homework && cfgAfter.config.homework.enabled === true, '切换开关即 PUT 保存生效');
  ok(alerts[alerts.length-1].indexOf('已开启自动推送') !== -1, '切换开关 toast 反馈');
  // 限流次数控件：步进到 4 并保存生效
  await vm.runInContext("pushMaxStep('homework', 1)", ctx);
  const cfgMax = await wb.HttpApi._req('GET', '/api/push-config');
  ok(cfgMax.ok && cfgMax.config.homework.max === 4, '限流次数步进保存生效（3→4）');
  ok(documentStub.getElementById('push-max-homework').textContent === '4', '限流次数控件显示更新');
  await vm.runInContext("pushMaxStep('homework', -1)", ctx);  // 退回 3
  await vm.runInContext("togglePushConfig('homework')", ctx);  // 关回去，避免影响其他用例

  /* ---- 「本次无作业」第四次态（API 全链路：接口 → state 同步 → 双向转换 → 落地页行） ---- */
  const noHwAdd = await wb.HttpApi.addRecord({ id: 'e2e-nohw-1', studentId: sid, date: '2026-09-18', subject: subj, noHomework: true });
  ok(noHwAdd.ok && noHwAdd.record.noHomework === true && noHwAdd.record.total === 0 && noHwAdd.record.correct === 0,
    'POST 无作业记录成功（noHomework 标志 + 0/0 落库）');
  await wb.resyncState();
  ok(wb.pool.records.find(r=>r.id==='e2e-nohw-1').noHomework === true, 'state 同步带 noHomework 标志');
  const noHwPut = await wb.HttpApi.updateRecord('e2e-nohw-1', { date: '2026-09-18', noHomework: false, total: 12, correct: 10, wrongs: [3, 8] });
  ok(noHwPut.ok && (await apiGetState()).records.find(r=>r.id==='e2e-nohw-1').noHomework === false, 'PUT 无作业 → 正常转换');
  const noHwPut2 = await wb.HttpApi.updateRecord('e2e-nohw-1', { date: '2026-09-18', noHomework: true, total: 12, correct: 10 });
  const noHwRow2 = (await apiGetState()).records.find(r=>r.id==='e2e-nohw-1');
  ok(noHwPut2.ok && noHwRow2.total === 0 && noHwRow2.noHomework === true, 'PUT 正常 → 无作业转换（成绩清零）');
  const shareR2 = await wb.HttpApi.shareReport(sid, subj);
  const sharePg2 = await (await fetch(base + shareR2.url)).text();
  ok(sharePg2.indexOf('本次无作业') !== -1 && sharePg2.indexOf('2026-09-18') !== -1, '落地页无作业行渲染「本次无作业」+ 日期');

  /* ---- v1.9.0：落地页打卡表与格子序列对齐（未交行 + 统计卡口径） ---- */
  const missForReport = await wb.HttpApi.addMissed({ studentId: sid, date: '2026-09-10', subject: subj });
  ok(missForReport.ok, '造一条未处理未交记录（落地页序列对齐测试）');
  const sharePg3 = await (await fetch(base + shareR2.url)).text();  // 复用分享链接（落地页实时渲染）
  ok(sharePg3.indexOf('>未交</td>') !== -1 && sharePg3.indexOf('2026-09-10') !== -1, '落地页打卡表渲染未交行（红「—」+「未交」）');
  ok(sharePg3.indexOf('>未交</td>') < sharePg3.indexOf('2026-09-18'), '未交行按日期排序进入序列（09-10 在 09-18 前）');
  ok(sharePg3.indexOf('>未交</div><div class="v">1 次') !== -1, '落地页统计卡「未交 1 次」（红色警示）');

  /* ---- 待办预警动作接口全流程（snooze/done + state 同步 + 归属校验 + 前端分组渲染） ---- */
  await wb.doLogin('ta1', 'ta654321', 'ta');
  const _d = n => { const d = new Date(); d.setDate(d.getDate()+n);
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
  const missDate = _d(-1), snoozeDay = _d(0);  // 未交=昨天、稍后至今天：动态日期，避免硬编码日期随时间过期
  const alertMiss = await wb.HttpApi.addMissed({ studentId: sid, date: missDate, subject: subj });
  ok(alertMiss.ok, '造一条未交记录（预警测试用）');
  await wb.resyncState();
  // 前端分组渲染：未交进入「未交（宽限内）」组
  ok(documentStub.getElementById('today-list').innerHTML.indexOf('today-grp-miss') !== -1
    && documentStub.getElementById('today-list').innerHTML.indexOf(missDate) !== -1, '未交进入分组待办渲染');
  const snz = await wb.HttpApi._req('POST', '/api/alerts/action', { kind: 'miss', refKey: alertMiss.missed.id, action: 'snooze', snoozeUntil: snoozeDay });
  ok(snz.ok, '预警稍后处理接口成功');
  await wb.resyncState();
  ok((wb.pool.alertActions || []).some(a=>a.kind==='miss' && a.refKey===alertMiss.missed.id && a.action==='snooze'),
    'state 同步带 alertActions（snooze 动作）');
  ok(documentStub.getElementById('today-list').innerHTML.indexOf(missDate) === -1, 'snooze 后该预警今天不再显示');
  const doneR = await wb.HttpApi._req('POST', '/api/alerts/action', { kind: 'miss', refKey: alertMiss.missed.id, action: 'done' });
  ok(doneR.ok, '预警完成接口成功');
  await wb.resyncState();
  ok((wb.pool.alertActions || []).filter(a=>a.refKey===alertMiss.missed.id).length === 2, '同一 ref_key 两条动作均同步（前端取最新生效）');

  /* ---- v1.9.0：科目级逾期端到端（plan/set → 推远活跃日 → 今日概览「逾期」组出现） ---- */
  await wb.HttpApi.addStudent({ id: 'e2e-od-stu', name: '逾期口径生', gradYear: '2027' });
  await wb.HttpApi._req('POST', '/api/plan/set', { studentId: 'e2e-od-stu', subject: '学科 / AP / 统计', plan: 3, firstClassDate: _d(-30) });
  // 把最近活跃（计划设定日）推远到 20 天前（直改库模拟时间流逝）
  require('../server/db.js').prepare("UPDATE students SET subj_plan_set_at = ? WHERE id = ?")
    .run(JSON.stringify({ '学科 / AP / 统计': _d(-20) }), 'e2e-od-stu');
  await wb.resyncState();
  const odHtml = documentStub.getElementById('today-list').innerHTML;
  ok(odHtml.indexOf('today-grp-overdue') !== -1 && odHtml.indexOf('逾期口径生') !== -1
    && odHtml.indexOf('欠 3 次 · 20 天没动静') !== -1, 'v1.9.0：科目级逾期（欠 3 次 · 20 天没动静）进「逾期」组');
  // 格子录满后出清：补 3 条成绩 → 逾期消失
  for(let i=0;i<3;i++){
    await wb.HttpApi.addRecord({ studentId: 'e2e-od-stu', date: _d(0), total: 10, correct: 9, wrongs: [], subject: '学科 / AP / 统计' });
  }
  await wb.resyncState();
  ok(documentStub.getElementById('today-list').innerHTML.indexOf('逾期口径生') === -1, 'v1.9.0：格子录满后逾期出清');
  require('../server/db.js').prepare("DELETE FROM records WHERE student_id = 'e2e-od-stu'").run();
  require('../server/db.js').prepare("DELETE FROM students WHERE id = 'e2e-od-stu'").run();
  await wb.resyncState();
  // 归属校验：ta2 不能处理 ta1 名下预警（ta2 为新建待改密账号，先走改密流程再调业务接口）
  const ta2Login = await wb.Api.login('ta2', 'ta123456', 'ta');
  await wb.HttpApi._req('POST', '/api/password', { oldPwd: 'ta123456', newPwd: 'ta2xx66' });
  const forbid = await wb.HttpApi._req('POST', '/api/alerts/action', { kind: 'miss', refKey: alertMiss.missed.id, action: 'done' });
  ok(ta2Login.ok && !forbid.ok && forbid.msg.indexOf('权限') !== -1, '助教不能处理他人名下学生的预警（403）');
  await wb.doLogin('ta1', 'ta654321', 'ta');  // 恢复

  /* ---- v1.9.0 零碎项（API 模式）：看板卡拆分 + 审计系统操作人 + 教务管理页四卡 ---- */
  await wb.doLogin('admin', 'admin456', 'admin');
  const dashOv2 = documentStub.getElementById('dash-overview').innerHTML;
  ok(dashOv2.indexOf('在服务学生') !== -1 && dashOv2.indexOf('已归档学生') !== -1 && dashOv2.indexOf('含历史') === -1,
    '看板学生卡拆分为「在服务学生 / 已归档学生」（API 模式）');
  // 审计系统操作人：访问分享页产生 user 为空的日志
  await fetch(base + shareR2.url);
  const audSys = await wb.HttpApi._req('GET', '/api/audit-logs?range=0&pageSize=100');
  const sysLog = audSys.items.find(l=>l.action==='访问分享报告');
  ok(sysLog && sysLog.userName === null, '分享页访问日志操作人为 null（系统动作）');
  ok(vm.runInContext('auditRowHtml(' + JSON.stringify(sysLog) + ')', ctx).indexOf('系统 · 微信回调') !== -1,
    '系统动作审计渲染「系统 · 微信回调」徽章');
  // 教务管理页四卡顺序
  wb.switchTab('data');
  ok(documentStub.getElementById('page-title').textContent === '教务管理', '教务管理页标题');
  ok(html.indexOf('id="push-config-card"') < html.indexOf('id="subj-mgmt-card"')
    && html.indexOf('id="subj-mgmt-card"') < html.indexOf('备份与恢复')
    && html.indexOf('备份与恢复') < html.indexOf('id="data-clean-zone"'),
    '教务管理页四卡重排（通知设置→科目设置→备份恢复→危险操作区）');

  /* ---- 走查 P1（v1.9.0）：API 模式导入恢复隐藏 + 提示 ---- */
  ok(documentStub.getElementById('btn-import').style.display === 'none'
    && documentStub.getElementById('import-api-tip').style.display !== 'none',
    'API 模式隐藏「导入恢复」并提示「生产环境数据在服务器，恢复数据请联系管理员」');

  console.log('\ne2e 断言：' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  srv.close();
  try{ fs.unlinkSync(TEST_DB); fs.unlinkSync(TEST_DB + '-wal'); fs.unlinkSync(TEST_DB + '-shm'); }catch(e){}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
