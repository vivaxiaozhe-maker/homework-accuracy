/* DOM 桩冒烟测试：加载 学生作业正确率.html 的内联脚本，验证账号体系与权限隔离。
   零依赖，直接运行：node test/smoke.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

/* ---------- 最小 DOM / 浏览器环境桩 ---------- */
function makeEl(id){
  return {
    id: id, value: '', textContent: '', innerHTML: '', disabled: false,
    style: {}, dataset: {}, files: [], onclick: null,
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
    clear: () => m.clear()
  };
}
const alerts = [];
const windowStub = { scrollTo(){}, print(){} };
const ctx = vm.createContext({
  document: documentStub,
  window: windowStub,
  localStorage: makeStorage(),
  sessionStorage: makeStorage(),
  crypto: globalThis.crypto,
  TextEncoder: globalThis.TextEncoder,
  alert: msg => alerts.push(String(msg)),
  console, setTimeout, clearTimeout,
  Blob: function(){},
  URL: { createObjectURL(){ return 'blob:x'; }, revokeObjectURL(){} },
  FileReader: function(){}
});

/* ---------- 加载页面脚本 ---------- */
const html = fs.readFileSync(path.join(__dirname, '..', '学生作业正确率.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if(!m){ console.error('未找到 <script> 块'); process.exit(1); }
vm.runInContext(m[1], ctx, {filename: 'inline-script.js'});

/* ---------- 断言工具 ---------- */
let pass = 0, fail = 0;
function ok(cond, name){
  if(cond){ pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

(async function main(){
  await windowStub.__ready;
  const wb = windowStub.__wb;
  const Api = wb.Api;

  /* ---- SHA-256 纯 JS 实现正确性（与标准实现一致，含中文 UTF-8 / 长输入跨块） ---- */
  ['hello', 'salt123:admin123', '教务:密码', 'a'.repeat(100)].forEach(s=>{
    const expect = nodeCrypto.createHash('sha256').update(s, 'utf8').digest('hex');
    ok(vm.runInContext('sha256Hex(' + JSON.stringify(s) + ')', ctx) === expect,
      'SHA-256 与标准一致：' + JSON.stringify(s.length > 20 ? s.slice(0,17)+'...' : s));
  });

  /* ---- 播种 ---- */
  const users = Api.listUsers();
  ok(users.length === 4, '首次运行播种 4 个账号（admin + ta1 + ta2 + sales1）');
  const admin = users.find(u=>u.username==='admin');
  const ta1 = users.find(u=>u.username==='ta1');
  const ta2 = users.find(u=>u.username==='ta2');
  const sales1 = users.find(u=>u.username==='sales1');
  ok(admin && admin.role==='admin' && admin.mustChangePwd === false, 'admin 为教务且演示期不强制首登改密');
  ok(ta1 && ta2 && ta1.role==='ta' && ta2.role==='ta', 'ta1/ta2 为助教角色');
  ok(sales1 && sales1.role==='sales' && sales1.name==='张顾问', '播种销售演示账号 sales1（张顾问）');
  ok(wb.pool.students.length === 14, '两位助教各有 7 名示例学生（5 现有 + 2 历史，共 14）');
  const alumni = wb.pool.students.filter(s=>s.archived && s.sample);
  ok(alumni.length===4 && alumni.every(s=>s.school && s.gradYear && s.ownerId),
    '每位助教播种 2 名历史示例学生（archived+sample，含学校/届别/归属）');
  ok(wb.pool.records.filter(r=>alumni.some(a=>a.id===r.studentId)).every(r=>r.ownerId && r.sample===true)
    && wb.pool.missed.filter(m=>alumni.some(a=>a.id===m.studentId)).every(m=>m.ownerId && m.resolved===true),
    '历史示例学生的记录/未交带 ownerId 与 sample 标记');

  /* ---- 审批流示例数据播种 ---- */
  const seedReqs = wb.pool.planRequests || [];
  ok(seedReqs.filter(r=>r.status==='pending').length === 2, '示例数据含 2 条待审批申请（每位助教 1 条）');
  ok(seedReqs.filter(r=>r.status==='approved').length === 2 && seedReqs.filter(r=>r.status==='rejected').length === 2,
    '示例数据含已通过/已驳回各 2 条');
  ok(seedReqs.every(r=>r.sample===true && r.ownerId && r.requestedBy), '示例申请带 sample 标记与归属信息');
  await Api._ensureSeed();
  ok(wb.pool.planRequests.length === seedReqs.length, '重复初始化不会重复注入示例申请');
  ok(wb.pool.students.length === 14, '重复初始化不会重复注入历史示例学生（alumniSampled 生效）');

  /* ---- 教务直接登录（演示不强制改密）+ 角色校验 ---- */
  let bad = await Api.login('admin', 'wrong-password', 'admin');
  ok(!bad.ok, '错误密码登录被拒');
  ok(!(await Api.login('admin', 'admin123', 'ta')).ok, '角色不符被拒（教务账号以助教角色登录）');
  ok(!(await Api.login('ta1', 'ta123456', 'admin')).ok, '角色不符被拒（助教账号以教务角色登录）');
  await wb.doLogin('admin', 'admin123', 'admin');
  ok(wb.currentUser && wb.currentUser.username === 'admin', 'admin 初始密码直接登录成功（不强制改密）');
  ok(wb.state.students.length === 14, '教务登录后直接进入主界面，见全部数据（14 名学生）');
  await wb.doChangePwd('bad-old', 'admin456', 'admin456');
  ok((await Api.login('admin', 'admin123', 'admin')).ok, '改密时原密码错误被拒，旧密码仍有效');
  await wb.doChangePwd('admin123', 'admin456', 'admin456');
  ok(!(await Api.login('admin', 'admin123', 'admin')).ok, '改密后旧密码失效');
  ok((await Api.login('admin', 'admin456', 'admin')).ok, '改密后新密码可登录');

  /* ---- 账号唯一性 ---- */
  const dup = await Api.createUser('张三', 'ta1', 'abcdef');
  ok(!dup.ok, '创建助教：重复 username 被拒');
  const made = await Api.createUser('张三', 'ta3', 'abcdef');
  ok(made.ok && made.user.mustChangePwd === true, '创建助教成功且标记首次登录需改密');

  /* ---- topbar 已移除「数据范围」下拉（教务恒为全部数据视角） ---- */
  ok(html.indexOf('id="scope-select"') === -1 && html.indexOf('scope-wrap') === -1, 'topbar 无数据范围下拉与身份提示');
  ok(wb.state.students.length === 14, '教务恒为全部数据视角（14 名学生）');

  /* ---- 助教数据隔离 ---- */
  wb.doLogout();
  await wb.doLogin('ta1', 'ta123456', 'ta');
  ok(wb.currentUser.username === 'ta1', 'ta1 登录成功');
  ok(wb.state.students.length === 7 && wb.state.students.every(s=>s.ownerId===ta1.id), 'ta1 只见自己的学生');
  ok(wb.state.records.length > 0 && wb.state.records.every(r=>r.ownerId===ta1.id), 'ta1 的记录全部归属自己');
  ok(!wb.state.students.some(s=>s.ownerId===ta2.id) && !wb.state.records.some(r=>r.ownerId===ta2.id), 'ta1 视图中不含 ta2 的数据');

  /* ---- 助教导出只含自己数据 ---- */
  const exp = wb.buildExport();
  ok(exp.students.length === 7 && exp.students.every(s=>s.ownerId===ta1.id)
    && exp.records.every(r=>r.ownerId===ta1.id) && exp.missed.every(x=>x.ownerId===ta1.id),
    '助教导出数据只含自己的 ownerId');

  /* ---- 新录入自动打 ownerId ---- */
  const ta1Stu = wb.state.students[0];
  const setVal = (id, v) => { documentStub.getElementById(id).value = v; };
  setVal('qe-date', ''); setVal('qe-total', '10');
  setVal('qe-correct', '9'); setVal('qe-wrongs', '3');
  wb.setQuickEntry({gid: ta1Stu.id, subject: '学科 / AP / 微积分BC'});
  const recBefore = wb.pool.records.length;
  wb.saveQuickEntry();
  const newRec = wb.pool.records[wb.pool.records.length - 1];
  ok(wb.pool.records.length === recBefore + 1 && newRec.ownerId === ta1.id, '新录入作业记录自动打当前用户 ownerId');
  setVal('sl-date', '');
  wb.setQuickEntry({gid: ta1Stu.id, subject: '竞赛 / AMC10'});
  const missBefore = wb.pool.missed.length;
  wb.markMissedToday();
  const newMiss = wb.pool.missed[wb.pool.missed.length - 1];
  ok(wb.pool.missed.length === missBefore + 1 && newMiss.ownerId === ta1.id, '新登记未交记录自动打当前用户 ownerId');

  /* ---- 越权防护 ---- */
  const otherMiss = wb.pool.missed.find(x=>x.ownerId === ta2.id);
  const alertsBefore = alerts.length;
  const missCnt = wb.pool.missed.length;
  wb.removeMissed(otherMiss.id);
  ok(alerts.length > alertsBefore && wb.pool.missed.length === missCnt, '助教删除他人未交记录被拒绝');
  const ta2Stu = wb.pool.students.find(s=>s.ownerId===ta2.id);
  wb.setQuickEntry({gid: ta2Stu.id, subject: '学科 / AP / 物理1'});
  const recCnt = wb.pool.records.length;
  wb.saveQuickEntry();
  ok(wb.pool.records.length === recCnt, '助教给他人学生录入记录被拒绝');

  /* ---- 停用拒登、数据保留 ---- */
  wb.doLogout();
  await wb.doLogin('admin', 'admin456', 'admin');
  const tg = Api.toggleUser(ta2.id);
  ok(tg.ok && tg.user.disabled === true, '教务停用 ta2 成功');
  const selfTg = Api.toggleUser(admin.id);
  ok(!selfTg.ok, '不能停用自己的账号');
  wb.doLogout();
  const disabledLogin = await Api.login('ta2', 'ta123456', 'ta');
  ok(!disabledLogin.ok, '停用后 ta2 登录被拒');
  ok(wb.pool.students.filter(s=>s.ownerId===ta2.id).length === 7, '停用后 ta2 数据完整保留');

  /* ---- 转移归属：学生 + 记录 + 未交一并跟随 ---- */
  await wb.doLogin('admin', 'admin456', 'admin');
  const mvStu = wb.pool.students.find(s=>s.ownerId===ta1.id);
  const mvRecs = wb.pool.records.filter(r=>r.studentId===mvStu.id).length;
  const res = Api.transferStudent([mvStu.id], ta2.id);
  ok(res.ok && mvStu.ownerId === ta2.id, '转移学生归属成功');
  ok(mvRecs > 0 && wb.pool.records.filter(r=>r.studentId===mvStu.id).every(r=>r.ownerId===ta2.id),
    '转移后该生作业记录 ownerId 同步变更');
  ok(wb.pool.missed.filter(x=>x.studentId===mvStu.id).every(x=>x.ownerId===ta2.id),
    '转移后该生未交记录 ownerId 同步变更');
  wb.doLogout();
  await wb.doLogin('ta1', 'ta123456', 'ta');
  ok(wb.state.students.length === 6 && !wb.state.students.some(s=>s.id===mvStu.id), '转移后 ta1 视图不再含该学生');

  /* ---- 数据看板（教务） ---- */
  const offDay = n => { const d = new Date(); d.setDate(d.getDate()+n);
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
  const dashIds = ['dash-overview','dash-trend','dash-tas','dash-cats','dash-subs','dash-alert-low','dash-alert-miss','dash-alert-sleep'];
  wb.doLogout();
  await wb.doLogin('admin', 'admin456', 'admin');
  ok(documentStub.getElementById('nav-dashboard').style.display !== 'none'
    && documentStub.getElementById('tab-dashboard').style.display !== 'none', '教务登录后看板入口（侧栏+底部 Tab）可见');
  ok(documentStub.getElementById('tab-data').style.display === 'none', '教务端底部 Tab 已移除「数据管理」');
  wb.setDashRange(30); wb.setDashOwner('all');
  dashIds.forEach(id=>{
    const h = documentStub.getElementById(id).innerHTML;
    ok(h.length > 0 && h.indexOf('NaN') === -1 && h.indexOf('undefined') === -1,
      '看板板块 ' + id + ' 输出无 NaN/undefined');
  });
  // 助教筛选：选 ta1 后概览只含 ta1 数据
  wb.setDashOwner(ta1.id);
  const dTa1 = wb.computeDash();
  const expectTa1 = wb.pool.records.filter(r=>r.ownerId===ta1.id && r.date >= offDay(-29)).length;
  ok(dTa1.recCnt === expectTa1 && dTa1.recCnt < wb.pool.records.length, '看板助教筛选生效：范围内录入次数只含 ta1 数据');
  // 时间范围：近 7 天 ≤ 全部
  wb.setDashOwner('all');
  wb.setDashRange(7);
  const d7 = wb.computeDash();
  wb.setDashRange(0);
  const dAll = wb.computeDash();
  ok(d7.recCnt <= dAll.recCnt && d7.recCnt === wb.pool.records.filter(r=>r.date >= offDay(-6)).length,
    '时间范围过滤生效（近7天 ≤ 全部，且口径正确）');
  wb.setDashRange(30);
  // 沉默助教徽章：ta3 创建后从未录入
  ok(wb.computeDash().taRows.some(r=>r.user.username==='ta3' && r.silent), '≥7 天未录入的助教显示「沉默」标记');
  // 预警名单：构造低分学生 / 逾期未交 / 沉睡学生
  const lowStu = {id:'dash-low-stu', name:'看板低分测试', ownerId:ta1.id};
  wb.pool.students.push(lowStu);
  wb.pool.records.push({id:'dash-low-rec', studentId:lowStu.id, date:offDay(0), total:10, correct:3,
    wrongs:[1,2,3,4,5,6,7], subject:'学科 / AP / 物理2', images:[], ownerId:ta1.id});
  wb.pool.missed.push({id:'dash-od-miss', studentId:lowStu.id, date:offDay(-5), resolved:false,
    subject:'学科 / AP / 物理2', ownerId:ta1.id});
  wb.pool.students.push({id:'dash-sleep-stu', name:'看板沉睡测试', ownerId:ta2.id});
  wb.renderDashboard();
  const dFix = wb.computeDash();
  ok(dFix.lowStus.some(g=>g.name==='看板低分测试' && g.avg===30), '预警名单：平均 <60% 的低分学生入选');
  ok(dFix.overdueList.some(x=>x.id==='dash-od-miss' && x.days===5), '预警名单：逾期未交入选且逾期天数正确');
  ok(dFix.sleepers.some(x=>x.name==='看板沉睡测试' && x.days===null), '预警名单：14 天无记录学生入选（从未有记录）');
  ok(documentStub.getElementById('dash-alert-low').innerHTML.indexOf('看板低分测试') !== -1
    && documentStub.getElementById('dash-alert-miss').innerHTML.indexOf('看板低分测试') !== -1
    && documentStub.getElementById('dash-alert-sleep').innerHTML.indexOf('看板沉睡测试') !== -1,
    '三类预警名单已渲染到页面');
  // 助教行下钻：筛选下拉同步
  wb.dashDrillTa(ta2.id);
  ok(wb.dashOwner === ta2.id && documentStub.getElementById('dash-owner').value === ta2.id, '点击助教行下钻后筛选下拉同步为该助教');
  wb.dashDrillTa(ta2.id);
  ok(wb.dashOwner === 'all', '再点同一助教行返回全部助教');

  /* ---- 助教端看板守卫 ---- */
  wb.doLogout();
  await wb.doLogin('ta1', 'ta123456', 'ta');
  ok(documentStub.getElementById('nav-dashboard').style.display === 'none'
    && documentStub.getElementById('tab-dashboard').style.display === 'none', '助教登录后看板入口隐藏');
  ok(documentStub.getElementById('tab-data').style.display !== 'none', '助教端底部 Tab 保留「数据管理」');
  ok(dashIds.every(id=>documentStub.getElementById(id).innerHTML === ''), '助教角色下 renderDashboard 不产出内容');

  /* ---- 计划次数二次修改审批流 ---- */
  // 清掉播种的示例申请，从 0 开始验证流程
  wb.pool.planRequests.length = 0;
  // 当前登录 ta1；取一名 ta1 的现有学生
  const planStu = wb.pool.students.find(s=>s.ownerId===ta1.id && !s.archived);
  const planSubj = '学科 / AP / 微积分BC';
  wb.setQuickEntry({gid: planStu.id, subject: planSubj});
  // 首次设置：直接生效，不产生申请
  setVal('qe-plan', '10');
  wb.savePlanCount();
  ok(planStu.subjPlans && planStu.subjPlans[planSubj]===10 && wb.pool.planRequests.length===0,
    '首次设置应完成次数直接生效，不产生申请');
  // 二次修改：生成 pending，当前次数不变
  setVal('qe-plan', '12');
  wb.savePlanCount();
  setVal('pr-reason', '课程加量');
  wb.submitPlanRequest();
  const req1 = wb.pool.planRequests[wb.pool.planRequests.length-1];
  ok(wb.pool.planRequests.length===1 && req1.status==='pending' && req1.oldPlan===10 && req1.newPlan===12
    && req1.reason==='课程加量' && req1.ownerId===ta1.id && req1.requestedBy===ta1.id,
    '二次修改生成 pending 申请（含 oldPlan/newPlan/reason）');
  ok(planStu.subjPlans[planSubj]===10, '申请待审批期间当前次数不变');
  // 新值=旧值拦截
  let alertsB = alerts.length;
  setVal('qe-plan', '10');
  wb.savePlanCount();
  ok(wb.pool.planRequests.length===1 && alerts.length>alertsB, '新值=旧值被拦截，不产生申请');
  // 重复申请拦截
  alertsB = alerts.length;
  setVal('qe-plan', '15');
  wb.savePlanCount();
  ok(wb.pool.planRequests.length===1 && alerts.length>alertsB, '已有 pending 时重复申请被拦截');
  // 撤回后可重新申请
  ok(Api.cancelPlanRequest(req1.id).ok && req1.status==='cancelled', '助教撤回申请成功');
  ok(!Api.cancelPlanRequest(req1.id).ok, '已撤回的申请不能重复撤回');
  setVal('qe-plan', '15');
  wb.savePlanCount();
  setVal('pr-reason', '');
  wb.submitPlanRequest();
  const req2 = wb.pool.planRequests[wb.pool.planRequests.length-1];
  ok(wb.pool.planRequests.length===2 && req2.status==='pending' && req2.newPlan===15, '撤回后可重新发起申请');
  // 越权：助教给他人学生申请
  const ta2StuP = wb.pool.students.find(s=>s.ownerId===ta2.id);
  ta2StuP.subjPlans = {'测试科目': 5};
  ok(!Api.createPlanRequest({studentId: ta2StuP.id, subject:'测试科目', newPlan: 8}).ok,
    '助教给他人学生提交申请被越权拦截');
  // 教务驳回：次数不变
  wb.doLogout();
  await wb.doLogin('admin', 'admin456', 'admin');
  wb.reviewPlanRequest(req2.id, false);
  documentStub.getElementById('cf-ok').onclick();  // 确认驳回
  ok(req2.status==='rejected' && planStu.subjPlans[planSubj]===10, '教务驳回后申请 rejected 且次数不变');
  // 教务通过：次数生效
  wb.doLogout();
  await wb.doLogin('ta1', 'ta123456', 'ta');
  setVal('qe-plan', '18');
  wb.savePlanCount();
  setVal('pr-reason', '');
  wb.submitPlanRequest();
  const req3 = wb.pool.planRequests[wb.pool.planRequests.length-1];
  wb.doLogout();
  await wb.doLogin('admin', 'admin456', 'admin');
  ok(Api.reviewPlanRequest(req3.id, true).ok && req3.status==='approved'
    && req3.reviewedBy===admin.id && planStu.subjPlans[planSubj]===18, '教务通过后应完成次数生效');
  ok(!Api.reviewPlanRequest(req3.id, true).ok, '已审批的申请不能重复审批');
  // 教务直改：免审批生效，pending 自动驳回
  wb.doLogout();
  await wb.doLogin('ta1', 'ta123456', 'ta');
  setVal('qe-plan', '20');
  wb.savePlanCount();
  setVal('pr-reason', '');
  wb.submitPlanRequest();
  const req4 = wb.pool.planRequests[wb.pool.planRequests.length-1];
  ok(req4.status==='pending' && req4.oldPlan===18, '助教再次发起申请（18 → 20）');
  wb.doLogout();
  await wb.doLogin('admin', 'admin456', 'admin');
  wb.setQuickEntry({gid: planStu.id, subject: planSubj});
  setVal('qe-plan', '25');
  wb.savePlanCount();  // 教务直改 → 确认弹窗
  documentStub.getElementById('cf-ok').onclick();  // 确认直改
  ok(planStu.subjPlans[planSubj]===25, '教务直改免审批直接生效');
  ok(req4.status==='rejected' && req4.reviewedBy===admin.id, '教务直改时 pending 申请被自动驳回');
  // 审批区块渲染无 NaN/undefined，已处理区含通过/驳回
  const prPendHtml = documentStub.getElementById('planreq-pending').innerHTML;
  const prDoneHtml = documentStub.getElementById('planreq-done').innerHTML;
  ok(prPendHtml.indexOf('NaN')===-1 && prPendHtml.indexOf('undefined')===-1
    && prDoneHtml.indexOf('NaN')===-1 && prDoneHtml.indexOf('undefined')===-1
    && prDoneHtml.indexOf('已通过')!==-1 && prDoneHtml.indexOf('已驳回')!==-1,
    '审批区块渲染无 NaN/undefined，已处理区含通过/驳回记录');
  // 徽章数量随 pending 变化
  ok(documentStub.getElementById('badge-today').style.display==='none', '无待审批时徽章隐藏');
  const req5 = Api.createPlanRequest({studentId: planStu.id, subject: planSubj, newPlan: 30}).request;
  wb.renderPendingBadges();
  ok(documentStub.getElementById('badge-today').textContent==='1'
    && documentStub.getElementById('badge-today').style.display!=='none', '有 1 条待审批时徽章显示数量');
  Api.reviewPlanRequest(req5.id, true);
  wb.renderPendingBadges();
  ok(documentStub.getElementById('badge-today').style.display==='none', '审批完成后徽章消失');
  wb.doLogout();
  await wb.doLogin('ta1', 'ta123456', 'ta');
  ok(documentStub.getElementById('badge-today').style.display==='none'
    && documentStub.getElementById('badge-today-tab').style.display==='none', '助教端不显示审批徽章');

  /* ---- 学生明细助教维度筛选（教务） ---- */
  const grpCnt = list => new Set(list.map(s=>(s.ownerId||'')+'|'+s.name.trim())).size;
  const cardCnt = html => (html.match(/stu-card/g)||[]).length;
  wb.doLogout();
  await wb.doLogin('admin', 'admin456', 'admin');
  const chipHtml = documentStub.getElementById('stu-ta-filter').innerHTML;
  ok(chipHtml.indexOf('全部学生')!==-1 && chipHtml.indexOf('王助教')!==-1 && chipHtml.indexOf('李助教')!==-1
    && chipHtml.indexOf('已停用')!==-1, '教务端学生明细含助教筛选 chips（全部学生 + 各助教，停用标注）');
  // 「全部学生」：按助教分组，默认折叠（只有组头），点击展开，搜索时自动展开
  const listAll = documentStub.getElementById('stu-list').innerHTML;
  const allActive = wb.pool.students.filter(s=>!s.archived);
  ok(listAll.indexOf('ta-group-head')!==-1 && listAll.indexOf('王助教')!==-1 && listAll.indexOf('李助教')!==-1,
    '「全部学生」视图按助教分组展示（含分组标题）');
  ok(cardCnt(listAll) === 0, '「全部学生」视图分组默认折叠（只有组头，无学生卡）');
  wb.toggleTaGroup(ta1.id);
  const listExp = documentStub.getElementById('stu-list').innerHTML;
  ok(cardCnt(listExp) === grpCnt(allActive.filter(s=>s.ownerId===ta1.id)), '点击组头展开该助教的学生卡');
  wb.toggleTaGroup(ta1.id);  // 收起还原
  ok(cardCnt(documentStub.getElementById('stu-list').innerHTML) === 0, '再次点击收起该组');
  wb.setStuQuery('林');
  const listAutoExp = documentStub.getElementById('stu-list').innerHTML;
  ok(cardCnt(listAutoExp) > 0 && listAutoExp.indexOf('林小满') !== -1, '搜索时自动展开含匹配学生的组');
  wb.setStuQuery('');
  // 选中 ta1：只含 ta1 学生卡，无分组标题，不含 ta2 学生（单助教视图维持直接展开）
  wb.setStuTaFilter(ta1.id);
  const listTa1 = documentStub.getElementById('stu-list').innerHTML;
  const ta1Active = wb.pool.students.filter(s=>s.ownerId===ta1.id && !s.archived);
  ok(listTa1.indexOf('ta-group-head')===-1 && cardCnt(listTa1)===grpCnt(ta1Active)
    && listTa1.indexOf('看板低分测试')!==-1 && listTa1.indexOf('看板沉睡测试')===-1,
    '选中某助教后明细只含该助教的学生卡（无分组标题，直接展开）');
  // 姓名搜索与助教筛选叠加
  wb.setStuQuery('林');
  const listSearch = documentStub.getElementById('stu-list').innerHTML;
  ok(cardCnt(listSearch)===1 && listSearch.indexOf('林小满')!==-1, '姓名搜索与助教筛选叠加生效');
  wb.setStuQuery('');
  wb.setStuTaFilter('all');
  // 历史学生页渲染（含示例历史学生，无 NaN/undefined）
  const alHtml = documentStub.getElementById('alumni-list').innerHTML;
  ok(alHtml.indexOf('NaN')===-1 && alHtml.indexOf('undefined')===-1
    && alHtml.indexOf('李浩然')!==-1 && alHtml.indexOf('赵雨桐')!==-1,
    '历史学生页渲染正常（含示例历史学生，无 NaN/undefined）');
  // 助教端：chips 行不渲染
  wb.doLogout();
  await wb.doLogin('ta1', 'ta123456', 'ta');
  ok(documentStub.getElementById('stu-ta-filter').innerHTML === '', '助教端不渲染助教筛选 chips 行');

  /* ---- 批次一：改名 / 停滞提醒 / 次数按钮形态 / subjAdvice / 清理区块显隐 ---- */
  ok(html.indexOf('<title>学情跟踪平台 · 个人工作台</title>') !== -1, '浏览器 title 已改名「学情跟踪平台」');
  ok(html.indexOf('学生作业正确率') === -1 && (html.match(/学情跟踪平台/g) || []).length >= 5,
    '品牌区/登录页/topbar/报告落款均已改名，旧名无残留');
  // 首次设置已写 subjPlanSetAt（plan-flow 段落中首次设置 10 次）
  const todayS = offDay(0);
  ok(planStu.subjPlanSetAt && planStu.subjPlanSetAt[planSubj] === todayS, '首次设置应完成次数写入 subjPlanSetAt');
  // 审批通过时更新 subjPlanSetAt（req5 已通过，先删字段模拟旧数据再验证审批写入）
  // 直接验证：新建申请并审批通过 → setAt 写入
  const setAtReq = Api.createPlanRequest({studentId: planStu.id, subject: planSubj, newPlan: 32, reason: ''}).request;
  wb.doLogout();
  await wb.doLogin('admin', 'admin456', 'admin');
  delete planStu.subjPlanSetAt[planSubj];  // 模拟旧数据无 setAt
  Api.reviewPlanRequest(setAtReq.id, true);
  ok(planStu.subjPlanSetAt[planSubj] === todayS && planStu.subjPlans[planSubj] === 32,
    '审批通过时写入 subjPlanSetAt 并生效次数');
  // 停滞提醒（ta1 视角）
  wb.doLogout();
  await wb.doLogin('ta1', 'ta123456', 'ta');
  const stagSubj = '学科 / AP / 化学';
  planStu.subjPlans[stagSubj] = 5;
  planStu.subjPlanSetAt[stagSubj] = offDay(-8);
  wb.refreshView(); wb.renderToday();
  let todayHtml = documentStub.getElementById('today-list').innerHTML;
  ok(todayHtml.indexOf('AP·化学') !== -1 && todayHtml.indexOf('已 8 天未更新') !== -1 && todayHtml.indexOf('计划停滞') !== -1,
    '停滞提醒：设定日 8 天前且无记录 → 出现且含天数');
  planStu.subjPlanSetAt[stagSubj] = offDay(-6);
  wb.refreshView(); wb.renderToday();
  todayHtml = documentStub.getElementById('today-list').innerHTML;
  ok(todayHtml.indexOf('AP·化学') === -1, '停滞提醒：6 天前 → 不出现');
  planStu.subjPlanSetAt[stagSubj] = offDay(-8);
  wb.pool.records.push({id:'stag-rec', studentId:planStu.id, date:offDay(-2), total:10, correct:9, wrongs:[4], subject:stagSubj, images:[], ownerId:ta1.id});
  wb.refreshView(); wb.renderToday();
  todayHtml = documentStub.getElementById('today-list').innerHTML;
  ok(todayHtml.indexOf('AP·化学') === -1, '停滞提醒：有更近记录 → 以记录日为基准，不提醒');
  // 旧数据无 setAt 且无记录 → 不提醒
  planStu.subjPlans['学科 / IB / 经济'] = 6;
  wb.refreshView(); wb.renderToday();
  todayHtml = documentStub.getElementById('today-list').innerHTML;
  ok(todayHtml.indexOf('IB·经济') === -1, '旧数据无 subjPlanSetAt 且无记录 → 不提醒');
  // 次数按钮形态（助教视角）
  wb.setQuickEntry({gid: planStu.id, subject: planSubj});
  let rowHtml = wb.qePanelHtml();
  ok(rowHtml.indexOf('>修改</button>') !== -1 && rowHtml.indexOf('id="qe-plan"') !== -1, '已有次数时 plan-row 按钮为「修改」');
  const pend32 = Api.createPlanRequest({studentId: planStu.id, subject: planSubj, newPlan: 35, reason: ''});
  rowHtml = wb.qePanelHtml();
  ok(pend32.ok && rowHtml.indexOf('已发送教管审批（32 → 35）') !== -1 && rowHtml.indexOf('撤回申请') !== -1,
    '提交申请后显示「已发送教管审批（N → M）」并保留撤回');
  Api.cancelPlanRequest(pend32.request.id);
  wb.setQuickEntry({gid: planStu.id, subject: '语培 / 雅思'});
  ok(wb.qePanelHtml().indexOf('>保存</button>') !== -1, '未设置次数时 plan-row 按钮为「保存」');
  // 教务视角 plan-row 只读
  wb.doLogout();
  await wb.doLogin('admin', 'admin456', 'admin');
  wb.setQuickEntry({gid: planStu.id, subject: planSubj});
  const adminRow = wb.qePanelHtml();
  ok(adminRow.indexOf('id="qe-plan"') === -1 && adminRow.indexOf('savePlanCount') === -1 && adminRow.indexOf('已定 32 次') !== -1,
    '教务视角 plan-row 只读（无输入框/保存按钮，显示次数文字）');
  // subjAdvice 保存与报告第四节
  wb.doLogout();
  await wb.doLogin('ta1', 'ta123456', 'ta');
  wb.setQuickEntry({gid: planStu.id, subject: planSubj});
  documentStub.getElementById('qe-advice').value = '每周三次错题复盘';
  wb.saveSubjectAdvice();
  ok(planStu.subjAdvice && planStu.subjAdvice[planSubj] === '每周三次错题复盘', '学习计划与建议按学生×科目保存（subjAdvice）');
  const rpt = wb.reportHtml(planStu, planSubj);
  ok(rpt.indexOf('四、学习计划与建议') !== -1 && rpt.indexOf('每周三次错题复盘') !== -1
    && rpt.indexOf('本报告由「学情跟踪平台」自动生成') !== -1, '报告含第四节「学习计划与建议」与新落款');
  // 清理区块与横幅按钮显隐
  ok(documentStub.getElementById('data-clean-zone').style.display === 'none', '助教端「数据管理」清理数据区块隐藏');
  ok(html.indexOf('id="btn-import"') < html.indexOf('id="data-clean-zone"'), '导出/导入保留在清理区块之外（助教可见）');
  const bannerTa = documentStub.getElementById('sample-banner').innerHTML;
  ok(bannerTa.indexOf('示例数据') !== -1 && bannerTa.indexOf('清空示例数据') === -1, '助教端示例横幅保留提示但无清空按钮');
  wb.doLogout();
  await wb.doLogin('admin', 'admin456', 'admin');
  ok(documentStub.getElementById('data-clean-zone').style.display !== 'none', '教务端清理数据区块可见');
  ok(documentStub.getElementById('sample-banner').innerHTML.indexOf('清空示例数据') !== -1, '教务端示例横幅含清空按钮');
  wb.doLogout();
  await wb.doLogin('ta1', 'ta123456', 'ta');

  /* ---- 清空示例数据覆盖历史学生 ---- */
  wb.clearSamplesOfView();  // ta1 视角
  ok(!wb.pool.students.some(s=>s.ownerId===ta1.id && s.sample), '清空示例数据后 ta1 的示例学生（含历史学生）全部清除');
  ok(wb.pool.students.some(s=>s.ownerId===ta2.id && s.sample && s.archived), '清空示例数据不影响其他助教的历史示例学生');

  /* ---- 教务「全部数据」视角重载示例：按助教分发 ---- */
  wb.doLogout();
  await wb.doLogin('admin', 'admin456', 'admin');
  Api.toggleUser(ta2.id);  // 恢复此前停用的 ta2
  wb.doLoadSampleData();
  const ta3u = Api.listUsers().find(u=>u.username==='ta3');
  ok([ta1.id, ta2.id, ta3u.id].every(id=>wb.pool.students.filter(s=>s.sample && s.ownerId===id).length === 7),
    '全部视角重载示例：每位助教各分发 7 名示例学生（含历史学生）');
  ok(!wb.pool.students.some(s=>s.sample && s.ownerId===admin.id), '示例学生不再归属教务账号');
  ok(wb.pool.planRequests.filter(r=>r.sample && r.status==='pending').length === 3,
    '重载后每位助教恢复 1 条待审批示例申请');

  /* ---- 批次二：看板预警上移 + 折叠 + 沉睡 7 天口径 ---- */
  ok(html.indexOf('预警名单') < html.indexOf('录入趋势（近 30 天）'), '看板板块顺序：预警名单在录入趋势之前');
  ok(html.indexOf('沉睡学生（≥7 天无记录）') !== -1, '沉睡学生口径标题已改 ≥7 天');
  const sleepy = {id:'sleepy-8d', name:'八天沉睡生', ownerId:ta1.id};
  wb.pool.students.push(sleepy);
  wb.pool.records.push({id:'sleepy-rec', studentId:sleepy.id, date:offDay(-8), total:10, correct:9, wrongs:[1], subject:'学科 / AP / 统计', images:[], ownerId:ta1.id});
  ok(wb.computeDash().sleepers.some(x=>x.name==='八天沉睡生' && x.days===8), '沉睡口径 ≥7 天生效（8 天无记录入选）');
  for(let i=1;i<=6;i++){
    const st = {id:'low-'+i, name:'压测低分'+i, ownerId:ta1.id};
    wb.pool.students.push(st);
    wb.pool.records.push({id:'low-rec-'+i, studentId:st.id, date:offDay(0), total:10, correct:3, wrongs:[1,2,3,4,5,6,7], subject:'学科 / AP / 化学', images:[], ownerId:ta1.id});
  }
  wb.renderDashboard();
  const lowHtml = documentStub.getElementById('dash-alert-low').innerHTML;
  ok((lowHtml.match(/dash-alert-item/g)||[]).length === 5 && lowHtml.indexOf('展开全部 7 条') !== -1,
    '预警名单默认显示前 5 条并折叠（含「展开全部 N 条」）');
  wb.dashToggleAlert('low');
  const lowHtml2 = documentStub.getElementById('dash-alert-low').innerHTML;
  ok((lowHtml2.match(/dash-alert-item/g)||[]).length === 7 && lowHtml2.indexOf('收起') !== -1, '展开全部后显示全部记录');
  wb.dashToggleAlert('low');  // 还原折叠

  /* ---- 批次二：教务今日概览（审批迁入 + 未交只读 + 徽章） ---- */
  ok(html.indexOf('id="planreq-zone"') < html.indexOf('id="today-list"'), '审批区块位于「今天要处理」卡片顶部');
  ok(html.indexOf('planreq-card') === -1, '账号管理页不再含审批区块（恢复纯账号功能）');
  ok(documentStub.getElementById('planreq-zone').style.display !== 'none'
    && documentStub.getElementById('planreq-pending').innerHTML.indexOf('通过') !== -1,
    '教务今日概览显示审批区块（待审批列表含通过按钮）');
  ok(documentStub.getElementById('badge-today').textContent === '3'
    && documentStub.getElementById('badge-today').style.display !== 'none', '待审批红点徽章挂在「今日概览」（数量正确）');
  const todayAdmin = documentStub.getElementById('today-list').innerHTML;
  ok(todayAdmin.indexOf('次未交') !== -1 && todayAdmin.indexOf('去补录') === -1 && todayAdmin.indexOf('删除') === -1,
    '教务视角未交卡片只读（无去补录/删除按钮）');
  wb.doLogout();
  await wb.doLogin('ta1', 'ta123456', 'ta');
  ok(documentStub.getElementById('today-list').innerHTML.indexOf('去补录') !== -1, '助教视角未交卡片保留操作按钮');
  ok(documentStub.getElementById('planreq-zone').style.display === 'none', '助教视角不显示审批区块');

  /* ---- 批次二：历史学生搜索 ---- */
  wb.doLogout();
  await wb.doLogin('admin', 'admin456', 'admin');
  wb.setAlumniQuery('杭州');
  const alS = documentStub.getElementById('alumni-list').innerHTML;
  ok(alS.indexOf('赵雨桐') !== -1 && alS.indexOf('李浩然') === -1, '历史学生搜索按学校过滤生效');
  wb.setAlumniQuery('李');
  const alS2 = documentStub.getElementById('alumni-list').innerHTML;
  ok(alS2.indexOf('李浩然') !== -1 && alS2.indexOf('赵雨桐') === -1, '历史学生搜索按姓名过滤生效');
  wb.setAlumniQuery('');

  /* ---- 批次二：销售角色全链路 ---- */
  ok(!(await Api.login('sales1', 'sales123456', 'ta')).ok, '销售账号以助教角色登录被拒');
  wb.doLogout();
  await wb.doLogin('sales1', 'sales123456', 'sales');
  ok(wb.currentUser && wb.currentUser.role === 'sales', 'sales1 登录成功（角色 sales）');
  ok(documentStub.getElementById('user-role').textContent === '销售', 'topbar 角色徽章显示「销售」');
  ok(['today','dashboard','accounts','data'].every(t=>documentStub.getElementById('nav-'+t).style.display === 'none'
    && documentStub.getElementById('tab-'+t).style.display === 'none')
    && documentStub.getElementById('nav-stats').style.display !== 'none'
    && documentStub.getElementById('nav-alumni').style.display !== 'none'
    && documentStub.getElementById('tab-stats').style.display !== 'none'
    && documentStub.getElementById('tab-alumni').style.display !== 'none',
    '销售端仅显示现有/历史两个页签（侧栏+底部 Tab）');
  ok(wb.switchTab('today') === 'stats' && wb.switchTab('dashboard') === 'stats' && wb.switchTab('alumni') === 'alumni',
    '销售端 switchTab 守卫拦截隐藏页签');
  ok(documentStub.getElementById('sample-banner').style.display === 'none', '销售端不显示示例数据横幅');
  ok(documentStub.getElementById('stats-chart-card').style.display === 'none'
    && documentStub.getElementById('btn-open-add-stu').style.display === 'none', '销售端隐藏图表卡与「新增学生」按钮');
  ok(documentStub.getElementById('stu-list').innerHTML.indexOf('stu-card') === -1
    && documentStub.getElementById('stu-list').innerHTML.indexOf('输入学生姓名或学校进行查询') !== -1
    && documentStub.getElementById('alumni-list').innerHTML.indexOf('stu-card') === -1,
    '销售端无关键字时两个页签均不渲染学生卡');
  ok(wb.state.students.length === wb.pool.students.length, '销售 viewState 可见全量（mock 期）');
  wb.setStuQuery('林');
  const salesHtml = documentStub.getElementById('stu-list').innerHTML;
  ok(salesHtml.indexOf('林小满') !== -1 && salesHtml.indexOf('归属：') !== -1, '销售输入关键字后出现匹配学生卡（含归属助教）');
  ok(salesHtml.indexOf('onclick') === -1, '销售学生卡只读（无任何 onclick 操作入口）');
  wb.setAlumniQuery('赵');
  const salesAl = documentStub.getElementById('alumni-list').innerHTML;
  ok(salesAl.indexOf('赵雨桐') !== -1 && salesAl.indexOf('restoreGroup') === -1, '销售历史学生搜索出卡且无恢复按钮');
  wb.setStuQuery(''); wb.setAlumniQuery('');
  ok(!wb.canWriteOwner(ta1.id) && !wb.canWriteOwner(null), 'canWriteOwner 对销售恒 false');
  setVal('qe-total', '10'); setVal('qe-correct', '9'); setVal('qe-wrongs', '1');
  wb.setQuickEntry({gid: wb.pool.students[0].id, subject: '学科 / AP / 微积分BC'});
  const salesRecCnt = wb.pool.records.length;
  wb.saveQuickEntry();
  ok(wb.pool.records.length === salesRecCnt, '销售尝试录入被拒（数据未变）');
  // 创建销售账号
  wb.doLogout();
  await wb.doLogin('admin', 'admin456', 'admin');
  ok(html.indexOf('<option value="sales">销售</option>') !== -1, '创建账号表单含销售角色选项');
  const madeSales = await Api.createUser('钱顾问', 'sales2', 'abc123456', 'sales');
  ok(madeSales.ok && madeSales.user.role === 'sales', '教务创建销售账号成功（角色正确）');

  console.log('\n断言：' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
