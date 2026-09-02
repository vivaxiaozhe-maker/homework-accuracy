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
    alert: msg => alerts.push(String(msg)),
    console, setTimeout, clearTimeout,
    Blob: function(){},
    URL: { createObjectURL(){ return 'blob:x'; }, revokeObjectURL(){} },
    FileReader: function(){}
  });
  const sessionStore = ctx.sessionStorage;  // vm context 内同一引用

  const html = fs.readFileSync(path.join(__dirname, '..', '学生作业正确率.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  vm.runInContext(m[1], ctx, { filename: 'inline-script.js' });
  await windowStub.__ready;
  const wb = windowStub.__wb;

  /* ---- 模式探测 ---- */
  ok(wb.USE_API === true, '探测到 /api/health → 进入 API 模式');
  ok(documentStub.getElementById('login-demo').style.display === 'none', 'API 模式隐藏演示账号提示');
  ok(documentStub.getElementById('login-screen').style.display === 'flex', '未登录显示登录页');

  /* ---- 登录 ---- */
  await wb.doLogin('admin', 'wrong-pwd', 'admin');
  ok(!wb.currentUser && documentStub.getElementById('login-err').textContent.length > 0, '错误密码登录失败（错误提示）');
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
  ok(st1.records.some(r=>r.id===recId), '服务端记录 id 已回填到本地 pool');

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

  console.log('\ne2e 断言：' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  srv.close();
  try{ fs.unlinkSync(TEST_DB); fs.unlinkSync(TEST_DB + '-wal'); fs.unlinkSync(TEST_DB + '-shm'); }catch(e){}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
