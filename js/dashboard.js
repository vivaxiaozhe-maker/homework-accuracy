/* 数据看板与应用初始化：教务看板聚合渲染、renderAll、init（模式探测/会话恢复）、__wb 测试钩子 */
/* ================= 教务：数据看板 =================
   基于 pool 全量（上帝视角），与 topbar「数据范围」独立；仅教务可见。
   口径：录入/正确率类指标受时间范围筛选影响；逾期未交、沉睡学生为当前状态指标，不受影响。 */
let dashRange = 30;   // 7 | 30 | 90 | 0（全部），默认近 30 天
let dashOwner = 'all';
function dashRangeStart(){ return dashRange === 0 ? null : offsetDay(-(dashRange - 1)); }

/* 看板聚合数据（渲染与测试共用，避免 NaN/除零：所有均值在空数组时给 null） */
function computeDash(){
  const t = todayStr();
  const tas = getUsersCache().filter(u=>u.role==='ta');
  const recsOwner = pool.records.filter(r=>dashOwner==='all' || r.ownerId===dashOwner);
  const start = dashRangeStart();
  const recs = start ? recsOwner.filter(r=>r.date >= start) : recsOwner;
  const missed = pool.missed.filter(m=>dashOwner==='all' || m.ownerId===dashOwner);
  const students = pool.students.filter(s=>dashOwner==='all' || s.ownerId===dashOwner);
  const avgAcc = recs.length ? Math.round(recs.reduce((s,r)=>s+acc(r),0)/recs.length) : null;
  // 已归档学生的未交不算逾期（学习已结束，不再催办）
  const isActiveMissed = m => { const st = pool.students.find(x=>x.id===m.studentId); return !(st && st.archived); };
  const openMiss = missed.filter(m=>!m.resolved && isActiveMissed(m));
  const overdue = openMiss.filter(m=>isOverdueMissed(m, pool.students.find(x=>x.id===m.studentId)));

  // 近 30 天录入趋势：始终画 30 天，受助教筛选影响
  const trend = [];
  for(let i=29; i>=0; i--){
    const d = offsetDay(-i);
    const dr = recsOwner.filter(r=>r.date===d);
    trend.push({ date:d, cnt:dr.length,
      avg: dr.length ? Math.round(dr.reduce((s,r)=>s+acc(r),0)/dr.length) : null });
  }

  // 助教维度对比（按范围内录入次数降序；≥7 天未录入标「沉默」）
  const taRows = tas.map(u=>{
    const rs = recs.filter(r=>r.ownerId===u.id);
    const ms = missed.filter(m=>m.ownerId===u.id);
    const allRs = pool.records.filter(r=>r.ownerId===u.id);
    const lastDate = allRs.length ? allRs.reduce((a,b)=>a.date>b.date?a:b).date : null;
    return { user:u, stuCnt: pool.students.filter(s=>s.ownerId===u.id && !s.archived).length,
      recCnt: rs.length,
      avg: rs.length ? Math.round(rs.reduce((s,r)=>s+acc(r),0)/rs.length) : null,
      missCnt: ms.filter(m=>!m.resolved).length,
      overdueCnt: ms.filter(m=>isOverdueMissed(m, pool.students.find(x=>x.id===m.studentId))).length,
      lastDate: lastDate,
      silent: !lastDate || lastDate <= offsetDay(-7) };
  }).sort((a,b)=>b.recCnt-a.recCnt);

  // 学科维度：一级类目 + 具体科目（均按记录数降序）
  const catMap = {}, subMapD = {};
  recs.forEach(r=>{
    const sub = r.subject || '未指定';
    const head = sub.split(' / ')[0];
    const cat = subjectTree()[head] ? head : '其他';
    (catMap[cat] = catMap[cat] || []).push(r);
    (subMapD[sub] = subMapD[sub] || []).push(r);
  });
  const cats = Object.keys(catMap).map(k=>({ name:k, cnt:catMap[k].length,
    avg: Math.round(catMap[k].reduce((s,r)=>s+acc(r),0)/catMap[k].length),
    stuCnt: new Set(catMap[k].map(r=>r.studentId)).size })).sort((a,b)=>b.cnt-a.cnt);
  const subs = Object.keys(subMapD).map(k=>({ key:k, name:shortSubject(k), cnt:subMapD[k].length,
    avg: Math.round(subMapD[k].reduce((s,r)=>s+acc(r),0)/subMapD[k].length),
    stuCnt: new Set(subMapD[k].map(r=>r.studentId)).size })).sort((a,b)=>b.cnt-a.cnt);

  // 预警一：低分学生（范围内平均正确率 <60%，按 ownerId+姓名 组合同名合并）
  const lowMap = {};
  recs.forEach(r=>{
    const st = pool.students.find(x=>x.id===r.studentId);
    const key = (r.ownerId||'') + '|' + (st ? st.name.trim() : r.studentId);
    (lowMap[key] = lowMap[key] || {name: st ? st.name : '（已删除学生）', ownerId: r.ownerId, recs: []}).recs.push(r);
  });
  const lowStus = Object.values(lowMap).map(g=>{
    const subA = {};
    g.recs.forEach(r=>{ const k = r.subject || '未指定'; (subA[k] = subA[k] || []).push(r); });
    return { name: g.name, ownerId: g.ownerId,
      avg: Math.round(g.recs.reduce((s,r)=>s+acc(r),0)/g.recs.length),
      lowSubs: Object.keys(subA)
        .map(k=>({ name: shortSubject(k), avg: Math.round(subA[k].reduce((s,r)=>s+acc(r),0)/subA[k].length) }))
        .filter(x=>x.avg<60).sort((a,b)=>a.avg-b.avg) };
  }).filter(g=>g.avg<60).sort((a,b)=>a.avg-b.avg);

  // 预警二：逾期未交（当前状态指标，不受时间范围影响），按逾期天数降序
  const overdueList = overdue.map(m=>{
    const st = pool.students.find(x=>x.id===m.studentId);  // 看板基于 pool，与 topbar 数据范围独立
    return {
      id: m.id, name: st ? st.name : '（已删除学生）', ownerId: m.ownerId, subject: m.subject || '', date: m.date,
      days: Math.max(1, Math.round((new Date(t) - new Date(m.date)) / 86400000))
    };
  }).sort((a,b)=>b.days-a.days);

  // 预警三：沉睡学生（≥7 天无任何作业记录的现有学生，当前状态指标）
  const sleepers = students.filter(s=>!s.archived).map(s=>{
    const rs = pool.records.filter(r=>r.studentId===s.id);
    const last = rs.length ? rs.reduce((a,b)=>a.date>b.date?a:b).date : null;
    return { name: s.name, ownerId: s.ownerId, last: last,
      days: last ? Math.round((new Date(t) - new Date(last)) / 86400000) : null };
  }).filter(x=>x.days===null || x.days>=7)
    .sort((a,b)=>(b.days===null?999999:b.days)-(a.days===null?999999:a.days));

  return { recCnt: recs.length, avgAcc: avgAcc,
    todayRecs: recsOwner.filter(r=>r.date===t).length,
    activeStu: students.filter(s=>!s.archived).length,
    archivedStu: students.filter(s=>s.archived).length,
    missCnt: openMiss.length, overdueCnt: overdue.length,
    taWithRecs: tas.filter(u=>recs.some(r=>r.ownerId===u.id)).length, taTotal: tas.length,
    trend: trend, taRows: taRows, cats: cats, subs: subs,
    lowStus: lowStus, overdueList: overdueList, sleepers: sleepers };
}

function renderDashboard(){
  const boxes = ['dash-overview','dash-trend','dash-tas','dash-cats','dash-subs','dash-alert-low','dash-alert-miss','dash-alert-sleep'];
  // 助教守卫：入口不渲染，直接切到 pane-dashboard 也不产出内容
  if(!isAdminView()){
    boxes.forEach(id=>{ const el = document.getElementById(id); if(el) el.innerHTML = ''; });
    return;
  }
  const d = computeDash();
  // 筛选条：助教下拉 + 时间范围按钮态
  const sel = document.getElementById('dash-owner');
  const tas = getUsersCache().filter(u=>u.role==='ta');
  sel.innerHTML = '<option value="all">全部助教</option>' +
    tas.map(u=>'<option value="' + u.id + '">' + esc(u.name) + (u.disabled ? '（已停用）' : '') + '</option>').join('');
  sel.value = dashOwner;
  document.querySelectorAll('#dash-range .role-opt').forEach(b=>b.classList.toggle('active', parseInt(b.dataset.range,10)===dashRange));

  // 1. 全局概览卡
  document.getElementById('dash-overview').innerHTML =
    '<div class="quick"><div class="num">' + d.activeStu + '</div><div class="lbl">现有学生（含历史 ' + d.archivedStu + '）</div></div>' +
    '<div class="quick"><div class="num">' + d.recCnt + '</div><div class="lbl">范围内录入次数</div></div>' +
    '<div class="quick"><div class="num">' + (d.avgAcc===null?'—':d.avgAcc+'%') + '</div><div class="lbl">范围内平均正确率</div></div>' +
    '<div class="quick"><div class="num" style="color:' + (d.overdueCnt?'var(--red)':'var(--mint-d)') + '">' + d.missCnt + '</div><div class="lbl">未交次数（逾期 ' + d.overdueCnt + '）</div></div>' +
    '<div class="quick"><div class="num">' + d.taWithRecs + '/' + d.taTotal + '</div><div class="lbl">有录入助教/助教总数</div></div>' +
    '<div class="quick"><div class="num">' + d.todayRecs + '</div><div class="lbl">今日已录入</div></div>';
  animateNums(document.getElementById('dash-overview'));  // 数字滚动动画（桩环境/减动效直接终值）

  // 2. 近 30 天录入趋势柱（纯 div；柱高=次数，柱色=当天平均正确率）
  const maxCnt = d.trend.reduce((m,x)=>Math.max(m,x.cnt),0);
  document.getElementById('dash-trend').innerHTML = maxCnt === 0
    ? '<p class="hint">近 30 天暂无录入。</p>'
    : d.trend.map(x=>{
        const color = x.cnt===0 ? '#EAE3D2' : (x.avg>=85?'#5FB89A':(x.avg>=60?'#E8A94C':'#DE6B6B'));
        const h = Math.max(2, Math.round(x.cnt/maxCnt*80));
        const isFirst = x.date.slice(8)==='01', isToday = x.date===todayStr();
        return '<div class="dash-bar-col" title="' + x.date + ' · ' + x.cnt + ' 次' + (x.avg===null?'':' · 平均 ' + x.avg + '%') + '">' +
          '<div class="dash-bar" style="height:' + h + 'px;background:' + color + '"></div>' +
          ((isFirst||isToday) ? '<div class="dash-bar-lbl">' + (isToday?'今天':x.date.slice(5)) + '</div>' : '') +
          '</div>';
      }).join('');

  // 3. 助教维度对比（点击行下钻）
  const maxTa = d.taRows.reduce((m,x)=>Math.max(m,x.recCnt),0);
  document.getElementById('dash-tas').innerHTML = d.taRows.length ? d.taRows.map(x=>
    '<div class="dash-ta-row' + (dashOwner===x.user.id?' active':'') + '" onclick="dashDrillTa(\'' + x.user.id + '\')" title="点击下钻到该助教">' +
    '<div class="grow"><b>' + esc(x.user.name) + '</b>' +
    (x.user.disabled ? ' <span class="tag red">已停用</span>' : '') +
    (x.silent ? ' <span class="tag amber">沉默</span>' : '') +
    '<div class="hint" style="margin-top:2px">学生 ' + x.stuCnt + ' 人 · 最近录入 ' + (x.lastDate || '从未') + '</div></div>' +
    '<div class="dash-ta-bar"><div class="dash-ta-fill" style="width:' + (maxTa ? Math.round(x.recCnt/maxTa*100) : 0) + '%"></div></div>' +
    '<span class="dash-ta-num">录入 ' + x.recCnt + ' 次</span>' +
    (x.avg===null
      ? '<span class="acc-badge" style="background:var(--cream2);color:var(--ink2)">未录入</span>'
      : '<span class="acc-badge ' + accClass(x.avg) + '">' + x.avg + '%</span>') +
    '<span class="dash-ta-num">未交 ' + x.missCnt + (x.overdueCnt ? '（逾期 <b style="color:var(--red)">' + x.overdueCnt + '</b>）' : '') + '</span>' +
    '</div>').join('') : '<p class="hint">暂无助教账号。</p>';

  // 4. 学科维度：一级类目行 + 具体科目条形（复用 subj-row，含 60% 关注线）
  document.getElementById('dash-cats').innerHTML = d.cats.length ? d.cats.map(c=>
    '<div class="dash-cat-row"><span class="cat-name">' + esc(c.name) + '</span>' +
    '<span>记录 <b>' + c.cnt + '</b> 次</span>' +
    '<span>平均正确率 <b style="color:' + (c.avg>=85?'var(--mint-d)':(c.avg>=60?'#B9802A':'var(--red)')) + '">' + c.avg + '%</b></span>' +
    '<span>涉及学生 <b>' + c.stuCnt + '</b> 人</span></div>').join('')
    : '<p class="hint">范围内暂无作业记录。</p>';
  document.getElementById('dash-subs').innerHTML = d.subs.map(x=>{
    const color = x.avg>=85 ? '#5FB89A' : (x.avg>=60 ? '#E8A94C' : '#DE6B6B');
    return '<div class="subj-row">' +
      '<div class="subj-name' + (x.avg<60?' low':'') + '" title="' + esc(x.key) + '">' + esc(x.name) + '</div>' +
      '<div class="subj-bar"><div class="subj-fill" style="width:' + x.avg + '%;background:' + color + '"></div>' +
      '<span class="subj-pct">' + x.avg + '%</span></div>' +
      '<div class="subj-cnt" style="flex-basis:96px">' + x.cnt + ' 次 · ' + x.stuCnt + ' 人</div>' +
      '</div>';
  }).join('');

  // 5. 预警名单（低分/沉睡跳「现有学生」并填搜索框；逾期跳「今日概览」）；各默认显示前 5 条，超出折叠
  const renderAlertList = (items, key, emptyText, renderItem)=>{
    if(!items.length) return '<p class="hint">' + emptyText + '</p>';
    const expanded = !!dashAlertExpand[key];
    let h = (expanded ? items : items.slice(0,5)).map(renderItem).join('');
    if(items.length > 5){
      h += '<button class="btn ghost sm" style="width:100%" onclick="dashToggleAlert(\'' + key + '\')">' +
        (expanded ? '收起' : '展开全部 ' + items.length + ' 条') + '</button>';
    }
    return h;
  };
  document.getElementById('dash-alert-low').innerHTML = renderAlertList(d.lowStus, 'low', '范围内没有低分学生。', g=>
    '<button class="dash-alert-item" onclick="dashGotoStudent(\'' + esc(g.name) + '\')">' +
    '<b>' + esc(g.name) + '</b> <span class="tag red">' + g.avg + '%</span>' +
    '<div class="meta">归属 ' + esc(ownerName(g.ownerId)) +
    (g.lowSubs.length ? ' · 低分科目：' + g.lowSubs.map(s=>esc(s.name) + ' ' + s.avg + '%').join('、') : '') + '</div>' +
    '</button>');
  document.getElementById('dash-alert-miss').innerHTML = renderAlertList(d.overdueList, 'miss', '没有逾期未交的作业。', x=>
    '<button class="dash-alert-item" onclick="switchTab(\'today\')">' +
    '<b>' + esc(x.name) + '</b> <span class="tag red">逾期 ' + x.days + ' 天</span>' +
    '<div class="meta">归属 ' + esc(ownerName(x.ownerId)) + (x.subject ? ' · ' + esc(shortSubject(x.subject)) : '') + ' · ' + x.date + '</div>' +
    '</button>');
  document.getElementById('dash-alert-sleep').innerHTML = renderAlertList(d.sleepers, 'sleep', '没有沉睡学生。', x=>
    '<button class="dash-alert-item" onclick="dashGotoStudent(\'' + esc(x.name) + '\')">' +
    '<b>' + esc(x.name) + '</b> <span class="tag amber">' + (x.days===null ? '从未有记录' : x.days + ' 天无记录') + '</span>' +
    '<div class="meta">归属 ' + esc(ownerName(x.ownerId)) + '</div>' +
    '</button>');
}
/* 预警名单折叠/展开（默认前 5 条） */
let dashAlertExpand = { low: false, miss: false, sleep: false };
function dashToggleAlert(key){ dashAlertExpand[key] = !dashAlertExpand[key]; renderDashboard(); }
/* 预警跳转：跳到「现有学生」并把姓名填入搜索框（复用现有搜索机制定位学生卡） */
function dashGotoStudent(name){
  switchTab('stats');  // 先切页（切页会清空筛选），再填搜索词
  stuQuery = name;
  const inp = document.getElementById('stu-search');
  if(inp) inp.value = name;
  renderStats();
}
/* 助教行下钻：再点同一行返回全部助教 */
function dashDrillTa(id){
  dashOwner = (dashOwner === id) ? 'all' : id;
  renderDashboard();
}
document.querySelectorAll('#dash-range .role-opt').forEach(b=>b.addEventListener('click', ()=>{
  dashRange = parseInt(b.dataset.range, 10);
  renderDashboard();
}));
document.getElementById('dash-owner').addEventListener('change', function(){
  dashOwner = this.value;
  renderDashboard();
});

/* ================= 初始化 ================= */
function renderAll(){
  refreshView();
  renderBanners();
  renderToday();
  renderDoneZone();  // 已处理事项统一回溯区（内部按角色过滤）
  renderStats();
  renderAlumni();
  // 计划修改审批区挂在「今日概览-今天要处理」卡片顶部，仅教务可见
  document.getElementById('planreq-zone').style.display = isAdminView() ? '' : 'none';
  if(isAdminView()){ renderAccounts(); renderPlanRequests(); }
  refreshUnbindRequests();  // 解绑审批区 + 红点合计（异步自取数自渲染；mock 恒空）
  refreshPushConfig();      // 微信自动推送开关卡（仅教务 + API 模式显示；内部含守卫）
  renderDashboard();  // 内部含教务守卫，助教端自动清空看板内容
  renderAudit();      // 内部含角色守卫（销售/未登录不产出）
  renderSubjectMgmt();  // 科目管理卡片（内部含教务守卫）
  renderPendingBadges();  // 待审批红点（仅教务显示）
}
document.getElementById('today-str').textContent =
  todayStr() + ' · ' + ['周日','周一','周二','周三','周四','周五','周六'][new Date().getDay()];

window.__ready = (async function init(){
  USE_API = await detectApi();  // 同 origin 探测到后端 → API 模式；否则 mock 演示模式
  // 侧栏脚注按运行模式区分：mock 保持「演示环境」静态文案，API 模式（正式环境）改为内部系统
  const sideFoot = document.getElementById('side-foot');
  if(sideFoot && USE_API) sideFoot.textContent = '学情跟踪平台 · 内部系统 · ' + APP_VERSION;
  document.getElementById('login-demo').style.display = USE_API ? 'none' : '';  // 演示账号提示仅 mock 模式
  const loginTag = document.querySelector('.login-tag');
  if(loginTag) loginTag.textContent = USE_API ? '内部系统' : '内部系统 · 演示环境：数据暂存本机';
  if(USE_API){
    apiImpl = HttpApi;
    const u = await HttpApi.restoreSession();  // 刷新恢复：本地 token → /api/me 校验
    if(u){
      currentUser = u;
      if(u.role !== 'sales'){
        const s = await HttpApi.getState();
        if(s.ok){ pool = s.state; }
      }
      await refreshUsersCache();
      await refreshSubjectTree();
      refreshView();
      enterApp();
      if(u.mustChangePwd) openPwdModal(true);
      return;
    }
    showLogin();
    return;
  }
  // mock 模式：行为与此前完全一致
  apiImpl = LocalApi;
  await Api._ensureSeed();  // 首次运行播种账号与示例数据
  load();
  const u = Api.currentSession();
  if(u){
    currentUser = u;
    enterApp();
    if(u.mustChangePwd) openPwdModal(true);
  } else {
    showLogin();
  }
})();

/* 测试钩子：供 node DOM 桩冒烟测试访问内部状态（不影响 UI） */
window.__wb = {
  Api, HttpApi, LocalApi,
  get USE_API(){ return USE_API; },
  setUseApi(v){ USE_API = v; apiImpl = v ? HttpApi : LocalApi; },  // 测试用：强制切换模式
  refreshUsersCache,
  doLogin, doChangePwd, doLogout, enterApp, showLogin,
  saveQuickEntry, saveSlot, removeMissed, markMissedToday, buildExport,
  viewState, refreshView, canWriteOwner, writeOwnerId,
  renderDashboard, computeDash, dashDrillTa, dashGotoStudent, dashToggleAlert,
  savePlanCount, submitPlanRequest, cancelPlanRequest, reviewPlanRequest, renderPlanRequests, renderPendingBadges,
  setStuTaFilter, toggleTaGroup, renderStats, renderAlumni, clearSamplesOfView,
  qePanelHtml, reportHtml, renderToday, saveSubjectAdvice, gotoPlanEntry, doLoadSampleData, renderMotto, toggleSalesSubject,
  saveSubjectComment, saveMockScore, confirmAddSubject,
  renderDoneZone, doneZoneToggle, resolveMissed,
  isOverdueMissed, addDays, editFirstClass, saveFirstClass, openMissSubjectPicker, confirmMissSubject,
  toggleSalesSubjectApi, fileUrl, renderAuditApi, resyncState,
  get salesSubjApi(){ return salesSubjApi; },
  logAction, visibleAuditLogs, renderAudit, auditLoadMore,
  setAuditQuery(v){ auditQuery = v; auditShown = 50; renderAudit(); },
  setAuditType(v){ auditType = v; auditShown = 50; renderAudit(); },
  setAuditRange(v){ auditRange = v; auditShown = 50; renderAudit(); },
  switchTab,
  get stuTaFilter(){ return stuTaFilter; },
  get stuQuery(){ return stuQuery; },
  setStuQuery(v){ stuQuery = v; renderStats(); },
  get alumniQuery(){ return alumniQuery; },
  setAlumniQuery(v){ alumniQuery = v; renderAlumni(); },
  get currentUser(){ return currentUser; },
  get pool(){ return pool; },
  get state(){ return state; },
  get dashRange(){ return dashRange; },
  get dashOwner(){ return dashOwner; },
  setDashRange(v){ dashRange = v; renderDashboard(); },
  setDashOwner(v){ dashOwner = v; renderDashboard(); },
  setQuickEntry(v){ quickEntry = v; },
  setSlotEdit(v){ slotEdit = v; }
};
