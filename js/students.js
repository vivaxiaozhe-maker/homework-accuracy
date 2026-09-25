/* 学生侧业务：今日概览、科目树数据源、学生统计与图表、销售端只读视图、作业录入打卡、计划次数审批申请 */
/* ================= 今日概览（v1.5.0 分组改版） =================
   四组预警按优先级排列：逾期未交 > 未交（宽限内）> 正确率偏低 > 计划停滞；
   默认只展开最紧急的非空组，其余折叠显示组头+数量；顶部计数条点击展开对应分组并滚动定位。
   行操作：查看记录（跳该生该科目打卡面板）/ 稍后处理（snooze 当天有效，明天再出现）/ 完成（done，进已处理事项）。
   未交行的完成路径 = 去补录（现有补录流），删除未交保留；归档学生不进任何分组。
   教务视角：未交只读（无补录/删除），但允许稍后处理/完成（管理职责）。 */
let todayExpandKey = null;  // 当前展开的分组 key（null = 自动选最紧急非空组）
// 同一 ref_key 取最新一条预警动作
function alertActionMap(){
  const map = {};
  (state.alertActions || []).forEach(a=>{ map[a.kind + '|' + a.refKey] = a; });
  return map;
}
function isDoneAlert(amap, kind, refKey){ const a = amap[kind + '|' + refKey]; return !!(a && a.action==='done'); }
// snooze 当天有效（snoozeUntil >= 今天 → 今天不显示，明天再出现）
function snoozedToday(amap, kind, refKey){
  const a = amap[kind + '|' + refKey];
  return !!(a && a.action==='snooze' && a.snoozeUntil && a.snoozeUntil >= todayStr());
}
// 行内处理状态徽章：曾被稍后处理过的显示「稍后至 X」（琥珀）
function snoozeBadgeHtml(amap, kind, refKey){
  const a = amap[kind + '|' + refKey];
  return (a && a.action==='snooze') ? '<span class="tag amber">稍后至 ' + esc(a.snoozeUntil) + '</span>' : '';
}
/* 稍后处理：snooze 1 天（不弹二次确认，直接 toast）；mock 写 pool.alertActions，API 走 /api/alerts/action 后 resync */
function alertSnooze(kind, refKey){
  const a = { id: uid(), kind: kind, refKey: refKey, action: 'snooze',
    actorId: currentUser ? currentUser.id : null, actorName: currentUser ? currentUser.name : '',
    note: '', createdAt: new Date().toISOString(), snoozeUntil: todayStr() };
  if(USE_API){
    apiPersist(HttpApi._req('POST', '/api/alerts/action', { kind: kind, refKey: refKey, action: 'snooze', snoozeUntil: todayStr() }),
      ()=>resyncState());
  } else {
    pool.alertActions = pool.alertActions || [];
    pool.alertActions.push(a);
    save(); refreshView();
  }
  toast('已稍后处理，明天再提醒您');
  renderAll();
}
/* 完成：写 done（永久消失并进已处理事项） */
function alertDone(kind, refKey){
  askConfirm('完成该预警', '完成后该预警不再出现在待办，可在下方「已处理事项」中回溯。确定已完成处理吗？', ()=>{
    const a = { id: uid(), kind: kind, refKey: refKey, action: 'done',
      actorId: currentUser ? currentUser.id : null, actorName: currentUser ? currentUser.name : '',
      note: '', createdAt: new Date().toISOString(), snoozeUntil: null };
    if(USE_API){
      apiPersist(HttpApi._req('POST', '/api/alerts/action', { kind: kind, refKey: refKey, action: 'done' }),
        ()=>resyncState());
    } else {
      pool.alertActions = pool.alertActions || [];
      pool.alertActions.push(a);
      save(); refreshView();
    }
    toast('已完成处理');
    renderAll();
  });
}
/* 计数条/组头点击：展开对应分组并滚动定位 */
function todayCatGo(key){
  todayExpandKey = key;
  renderToday();
  const el = document.getElementById('today-grp-' + key);
  if(el && el.scrollIntoView) el.scrollIntoView({ block:'start', behavior:'smooth' });  // 桩无此方法则静默
}
function renderToday(){
  const list = document.getElementById('today-list');
  const catsEl = document.getElementById('today-cats');
  const t = todayStr();
  const amap = alertActionMap();
  const admin = isAdminView();

  // ---- 未交：拆分为 逾期未交 / 未交（宽限内）两组（归档学生与未开课不进；done/snooze 生效的不显示）----
  const overdueRows = [], graceRows = [];
  state.missed.filter(m=>!m.resolved).forEach(m=>{
    const st = state.students.find(x=>x.id===m.studentId);
    if(st && st.archived) return;  // 已归档 = 学习已结束：不进待办（数据保留在历史学生卡）
    const fc = m.subject && st && st.subjFirstClass && st.subjFirstClass[m.subject];
    if(fc && fc > t) return;  // 未开课：不进入今天要处理
    if(isDoneAlert(amap, 'miss', m.id) || snoozedToday(amap, 'miss', m.id)) return;
    (isOverdueMissed(m, st) ? overdueRows : graceRows).push(m);
  });
  overdueRows.sort((a,b)=>a.date<b.date?-1:1);  // 最久未交在前
  graceRows.sort((a,b)=>a.date<b.date?-1:1);

  // ---- 正确率偏低：近 7 天 <60% 有成绩记录，按学生+科目聚合为一条（取该科目最低分记录）----
  const weekAgo = offsetDay(-7);
  const lowMap = {};
  gradedRecs(state.records.filter(r=>r.date>=weekAgo)).forEach(r=>{
    const st = state.students.find(x=>x.id===r.studentId);
    if(st && st.archived) return;
    if(acc(r) >= 60) return;
    const key = r.studentId + '|' + (r.subject || '');
    if(!lowMap[key] || acc(r) < acc(lowMap[key].rec)) lowMap[key] = { rec: r, refKey: key };
  });
  const lowRows = Object.values(lowMap)
    .filter(x=>!isDoneAlert(amap, 'lowAcc', x.refKey) && !snoozedToday(amap, 'lowAcc', x.refKey));

  // ---- 计划停滞：科目已设定应完成次数，但超过 7 天没有新作业记录（基准日 = max(设定日, 最近记录日)；未开课不提醒）----
  const stallRows = [];
  state.students.filter(s=>!s.archived && s.subjPlans).forEach(st=>{
    Object.keys(st.subjPlans).forEach(sub=>{
      const fc = st.subjFirstClass && st.subjFirstClass[sub];
      if(fc && fc > t) return;
      const setAt = st.subjPlanSetAt && st.subjPlanSetAt[sub];
      const recs = state.records.filter(r=>r.studentId===st.id && r.subject===sub);
      const lastRec = recs.length ? recs.reduce((a,b)=>a.date>b.date?a:b).date : null;
      const base = [setAt, lastRec].filter(Boolean).sort().pop();
      if(!base) return;  // 无设定时间且无记录：不提醒（避免上线当天刷屏）
      const days = Math.round((new Date(t) - new Date(base)) / 86400000);
      const refKey = st.id + '|' + sub;
      if(days > 7 && !isDoneAlert(amap, 'planStall', refKey) && !snoozedToday(amap, 'planStall', refKey)){
        stallRows.push({ st: st, sub: sub, days: days, refKey: refKey });
      }
    });
  });

  // ---- 行渲染 ----
  const renderMissRow = m =>
    '<div class="todo-item' + (overdueRows.indexOf(m)!==-1?' overdue':'') + '">' +
    '<div class="grow"><span class="who">' + esc(stuName(m.studentId)) + '</span>' +
    '<span class="tag mint">' + esc(shortSubject(m.subject || '未指定科目')) + '</span>' +
    (m.sample ? '<span class="tag sample">示例</span>' : '') +
    (admin ? '<span class="tag sample">归属 ' + esc(ownerName(m.ownerId)) + '</span>' : '') +
    (overdueRows.indexOf(m)!==-1
      ? '<span class="tag red" title="开课后超过 7 天未补交">逾期</span>'
      : '<span class="tag amber" title="宽限期内（开课后 7 天内）或未填开课时间的未交">未交</span>') +
    snoozeBadgeHtml(amap, 'miss', m.id) +
    '<div style="font-size:13px;color:var(--ink2)">未交日期 ' + m.date + '</div></div>' +
    // 未交行的完成路径 = 去补录（现有补录流）；教务只读不显示
    (admin ? '' :
      '<button class="btn mint sm" onclick="resolveMissed(\'' + m.id + '\')" title="跳转到该生该科目的打卡面板补录这次作业；填写并保存后，该条未交才算补交完成">去补录</button>' +
      '<button class="btn ghost sm" onclick="removeMissed(\'' + m.id + '\')" title="删除该未交记录">删除</button>') +
    '<button class="btn ghost sm" onclick="alertSnooze(\'miss\',\'' + m.id + '\')" title="今天不再提醒，明天再出现">稍后处理</button>' +
    '</div>';
  const renderLowRow = x => {
    const r = x.rec;
    return '<div class="todo-item">' +
      '<div class="grow"><span class="who">' + esc(stuName(r.studentId)) + '</span>' +
      '<span class="tag mint">' + esc(shortSubject(r.subject || '未指定科目')) + '</span>' +
      '<span class="tag red">正确率偏低 ' + acc(r) + '%</span>' +
      (r.sample ? '<span class="tag sample">示例</span>' : '') +
      (admin ? '<span class="tag sample">归属 ' + esc(ownerName(r.ownerId)) + '</span>' : '') +
      snoozeBadgeHtml(amap, 'lowAcc', x.refKey) +
      '<div style="font-size:13px;color:var(--ink2)">' + r.date + ' 作业，错题 ' + (r.total-r.correct) + ' 道，建议安排订正</div></div>' +
      (admin ? '' : '<button class="btn mint sm" onclick="gotoCorrect(\'' + r.studentId + '\')">录入订正</button>') +
      '<button class="btn ghost sm" onclick="alertSnooze(\'lowAcc\',\'' + esc(x.refKey) + '\')">稍后处理</button>' +
      '<button class="btn ghost sm" onclick="alertDone(\'lowAcc\',\'' + esc(x.refKey) + '\')">完成</button>' +
      '</div>';
  };
  const renderStallRow = x =>
    '<div class="todo-item">' +
    '<div class="grow"><span class="who">' + esc(x.st.name) + '</span>' +
    '<span class="tag mint">' + esc(shortSubject(x.sub)) + '</span>' +
    '<span class="tag amber">计划停滞</span>' +
    (admin ? '<span class="tag sample">归属 ' + esc(ownerName(x.st.ownerId)) + '</span>' : '') +
    snoozeBadgeHtml(amap, 'planStall', x.refKey) +
    '<div style="font-size:13px;color:var(--ink2)">「' + esc(shortSubject(x.sub)) + '」已 ' + x.days + ' 天未更新（应完成 ' + x.st.subjPlans[x.sub] + ' 次）</div></div>' +
    (admin ? '' : '<button class="btn mint sm" onclick="gotoPlanEntry(\'' + x.st.id + '\',\'' + esc(x.sub) + '\')">去录入</button>') +
    '<button class="btn ghost sm" onclick="alertSnooze(\'planStall\',\'' + esc(x.refKey) + '\')">稍后处理</button>' +
    '<button class="btn ghost sm" onclick="alertDone(\'planStall\',\'' + esc(x.refKey) + '\')">完成</button>' +
    '</div>';

  // ---- 分组 + 计数条 ----
  const groups = [
    { key:'overdueMiss', label:'逾期未交', rows: overdueRows, render: renderMissRow },
    { key:'miss', label:'未交（宽限内）', rows: graceRows, render: renderMissRow },
    { key:'lowAcc', label:'正确率偏低', rows: lowRows, render: renderLowRow },
    { key:'planStall', label:'计划停滞', rows: stallRows, render: renderStallRow }
  ];
  const nonEmpty = groups.filter(g=>g.rows.length);
  if(todayExpandKey===null || !nonEmpty.some(g=>g.key===todayExpandKey)) todayExpandKey = nonEmpty.length ? nonEmpty[0].key : null;
  if(catsEl){
    catsEl.innerHTML = nonEmpty.length > 1 ? nonEmpty.map(g=>
      '<span class="sub-chip' + (g.key===todayExpandKey?' active':'') + '" onclick="todayCatGo(\'' + g.key + '\')">' +
      g.label + ' ' + g.rows.length + '</span>').join('') : '';
  }
  let html = nonEmpty.map(g=>{
    const open = g.key===todayExpandKey;
    return '<div class="today-grp" id="today-grp-' + g.key + '">' +
      '<div class="today-grp-head" onclick="todayCatGo(\'' + g.key + '\')">' +
      '<span class="chev">' + (open?'▾':'▸') + '</span><b>' + g.label + '</b>' +
      '<span class="cnt">' + g.rows.length + (g.key==='miss' ? ' 次未交' : ' 条') + '</span></div>' +
      // 折叠组仍渲染行（CSS 隐藏），保证内容可检索/可测试
      '<div class="today-grp-body"' + (open?'':' style="display:none"') + '>' + g.rows.map(g.render).join('') + '</div></div>';
  }).join('');

  if(!html){
    html = '<div class="empty-ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" fill="#E4F3EC" stroke="none"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>今天没有待处理事项，全部完成！</div>';
  }
  list.innerHTML = html;

  // 快速统计
  const todayRecs = state.records.filter(r=>r.date===t).length;
  const unresolved = state.missed.filter(m=>{
    if(m.resolved) return false;
    const st = state.students.find(x=>x.id===m.studentId);
    return !(st && st.archived);  // 已归档学生的未交不计入待办统计
  }).length;
  const recent = gradedRecs(state.records.filter(r=>r.date>=weekAgo));  // 无作业记录不参与正确率统计
  const avgAcc = recent.length ? Math.round(recent.reduce((s,r)=>s+acc(r),0)/recent.length) : null;
  document.getElementById('quick-grid').innerHTML =
    '<div class="quick"><div class="num">' + new Set(activeStudents().map(s=>s.name.trim())).size + '</div><div class="lbl">学生总数</div></div>' +
    '<div class="quick"><div class="num">' + todayRecs + '</div><div class="lbl">今日已录入</div></div>' +
    '<div class="quick"><div class="num">' + (avgAcc===null?'—':avgAcc+'%') + '</div><div class="lbl">近7天平均正确率</div></div>' +
    '<div class="quick"><div class="num" style="color:' + (unresolved?'var(--red)':'var(--mint-d)') + '">' + unresolved + '</div><div class="lbl">未补交作业</div></div>';
  animateNums(document.getElementById('quick-grid'));  // 数字滚动动画（桩环境/减动效直接终值）
}
/* 今日概览「去补录」：跳转到该生该科目的打卡面板，并直接打开这次未交的补录表单。
   注意：这里不立即标记补交——只有保存了作业记录（saveSlot）才视为补交完成；
   若未填写或取消退出，未交记录保持原样，仍显示在「今日概览」。 */
function resolveMissed(id){
  const m = state.missed.find(x=>x.id===id);
  if(!m) return;
  const stu = state.students.find(s=>s.id===m.studentId);
  if(!stu || stu.archived) return;  // 历史学生：不跳转、不标记
  if(!m.subject){
    // 无科目（「未指定科目」）：先弹三级联动选科目，选后回填到该未交记录再进打卡面板
    openMissSubjectPicker(m.id);
    return;
  }
  // 同名合并组需解析代表学生（否则打卡面板可能挂在组内非代表条目上不显示）
  const rep = activeStudents().find(s=>s.name.trim()===stu.name.trim() && (s.ownerId||'')===(stu.ownerId||'')) || stu;
  const items = subjectItems(rep.id, m.subject);
  const pos = items.findIndex(it=>it.type==='miss' && it.miss.id===id);
  switchTab('stats');
  // 打开该生该科目的「作业打卡」面板（若已是同一面板则不重复切换）
  if(quickEntry && quickEntry.gid===rep.id && quickEntry.subject===m.subject){
    renderAll();
  } else {
    toggleQuickEntry(rep.id, m.subject);
  }
  // 自动展开补录表单：定位原未交所在格子（表单内日期自动预填为该未交日期）
  if(pos >= 0){
    slotEdit = {gid: rep.id, subject: m.subject, idx: pos+1};
    renderAll();
  }
}
/* 无科目未交的补录流程：三级联动选科目 → 回填 missed.subject（记审计）→ 进入打卡面板补录 */
let missPickId = null;  // 当前待选科目的未交记录 id
function openMissSubjectPicker(missedId){
  missPickId = missedId;
  const p = 'as-ms';  // 复用新增科目面板的三级联动（getAddSubjValue/asSub1Change 读取 'as-' + 前缀 的 id）
  document.getElementById(p + '-s1').innerHTML = '<option value="">选择分类…</option>' +
    Object.keys(subjectTree()).map(k=>'<option value="' + k + '">' + k + '</option>').join('') +
    '<option value="__custom__">自定义…</option>';
  document.getElementById(p + '-s2').innerHTML = '<option value="">二级科目…</option>';
  document.getElementById(p + '-s2').disabled = true;
  document.getElementById(p + '-s3').innerHTML = '<option value="">三级科目…</option>';
  document.getElementById(p + '-s3').disabled = true; document.getElementById(p + '-s3').style.display = 'none';
  document.getElementById(p + '-custom').value = ''; document.getElementById(p + '-custom').style.display = 'none';
  document.getElementById('miss-subj-modal').classList.add('show');
}
function confirmMissSubject(){
  const subj = getAddSubjValue('ms');  // 复用新增科目面板的三级联动取值
  if(!subj){ toast('请选择科目'); return; }
  const m = pool.missed.find(x=>x.id===missPickId);
  document.getElementById('miss-subj-modal').classList.remove('show');
  missPickId = null;
  if(!m) return;
  if(!canWriteOwner(m.ownerId)){ toast('没有权限操作该数据'); return; }
  m.subject = subj;
  logAction('补登未交科目', 'missed', auditStuDesc(m.studentId, subj), '原未交日期 ' + m.date, {ownerId: m.ownerId});
  apiPersist(HttpApi._req('PUT', '/api/missed/' + m.id, {date: m.date, subject: subj}));
  save();
  resolveMissed(m.id);  // 回填后走正常补录跳转
}
function removeMissed(id){
  const m = pool.missed.find(x=>x.id===id);
  if(!m || !canWriteOwner(m.ownerId)){ toast('没有权限操作该数据'); return; }
  askConfirm('删除未交记录', '确定删除这条未交记录吗？删除后可在「已处理事项」中回溯。', ()=>{
    m.resolved = true;          // 软删除：留痕，不从数组移除
    m.resolution = 'deleted';
    m.resolvedAt = todayStr();
    logAction('删除未交', 'missed', auditStuDesc(m.studentId, m.subject), '原未交日期 ' + m.date, {ownerId: m.ownerId});
    apiPersist(HttpApi.deleteMissed(id));
    save(); renderAll();
  });
}
function gotoCorrect(studentId){
  switchTab('stats');
  const stu = state.students.find(s=>s.id===studentId);
  if(stu){
    const g = activeStudents().find(s=>s.name.trim()===stu.name.trim());
    if(g && g.subjects && g.subjects.length){
      toggleQuickEntry(g.id, g.subjects[0]);
    }
  }
}
/* 停滞提醒「去录入」：跳转到该生该科目的打卡面板（取同名组代表学生） */
function gotoPlanEntry(studentId, subject){
  const stu = state.students.find(s=>s.id===studentId);
  if(!stu || stu.archived) return;
  const rep = activeStudents().find(s=>s.name.trim()===stu.name.trim() && (s.ownerId||'')===(stu.ownerId||''));
  switchTab('stats');
  toggleQuickEntry((rep || stu).id, subject);
}

/* ================= 科目树（三级联动） ================= */
/* 内置默认科目树（与后端 DEFAULT_SUBJECT_TREE 保持一致；无覆盖值时的兜底） */
const SUBJECT_TREE = {
  '学科': {
    'AP': ['微积分AB','微积分BC','物理1','物理2','物理力学','物理电磁','化学','生物','宏观','微观','统计','心理学','人文地理','环境科学','欧洲史','世界史','美国历史','语言与写作','文学与写作','艺术史','计算机A','计算机原理'],
    'IB': ['数学','物理','化学','经济','历史','生物'],
    'AL': ['数学','物理','化学','经济','历史','生物']
  },
  '竞赛': {'AMC10':null,'AMC12':null,'ABO':null,'BPHO':null,'BBO':null,'UKCHO':null,'物理碗':null},
  '语培': {'托福':null,'雅思':null,'SAT':null,'ACT':null}
};
/* 科目树数据源：API 模式 = 启动时 GET /api/subjects 的内存缓存；mock 模式 = localStorage 覆盖值或内置默认。
   所有用到科目树的地方（三级联动/图表分组/看板类目）统一走 subjectTree()，保存后即时生效 */
let subjectTreeCache = null;
function subjectTree(){
  if(USE_API) return subjectTreeCache || SUBJECT_TREE;
  try{
    const s = localStorage.getItem(LS_SUBJECTS);
    if(s){ const t = JSON.parse(s); if(t && typeof t === 'object' && !Array.isArray(t)) return t; }
  }catch(e){}
  return SUBJECT_TREE;
}
// API 模式：登录/恢复会话后拉取科目树缓存
async function refreshSubjectTree(){
  if(!USE_API) return;
  const r = await HttpApi.getSubjects();
  if(r && r.ok && r.tree) subjectTreeCache = r.tree;
}
/* ================= 学生统计 ================= */
let stuQuery = '';
let stuTaFilter = 'all';  // 学生明细助教维度筛选（仅教务可见）：'all' 或助教 id
let stuTaExpanded = {};  // 「全部学生」分组展开状态：ownerId → true 表示已展开（默认折叠）
function setStuTaFilter(v){ stuTaFilter = v; renderStats(); }
function toggleTaGroup(oid){ stuTaExpanded[oid] = !stuTaExpanded[oid]; renderStats(); }
/* 「各科目平均正确率」图表卡片默认折叠（html 里 stats-chart-card 带 collapsed 类），点击标题手动展开 */
function toggleBarChart(){
  document.getElementById('stats-chart-card').classList.toggle('collapsed');
}
document.getElementById('stu-search').addEventListener('input', function(){
  stuQuery = this.value.trim();
  renderStats();
});
function renderStats(){
  // 同名同姓合并为一组（统计按姓名聚合，原始记录不受影响）；只统计现有学生
  // 归属不同的同名学生不合并（按 ownerId+姓名 分组），避免跨助教混同
  const groups = [];
  activeStudents().forEach(s=>{
    const key = (s.ownerId||'') + '|' + s.name.trim();
    let g = groups.find(x=>x.key===key);
    if(!g){ g = {key:key, name:s.name.trim(), ownerId:s.ownerId||'', ids:[], sample:false}; groups.push(g); }
    g.ids.push(s.id);
    if(s.sample) g.sample = true;
    if(s.school) g.school = s.school;
    if(s.gradYear) g.gradYear = s.gradYear;
  });

  // 首字母筛选条（搜索框下方，所有角色可见；与姓名搜索/助教筛选叠加取交集）
  const stuLb = document.getElementById('stu-letter-bar');
  if(stuLb) stuLb.innerHTML = letterBarHtml(stuLetters, 'stu');

  // 销售视角：只读查询模式——默认只显示搜索框，输入关键字后才渲染匹配的只读学生卡
  if(isSalesView()){
    const chipBoxS = document.getElementById('stu-ta-filter');
    if(chipBoxS) chipBoxS.innerHTML = '';
    document.getElementById('bar-chart').innerHTML = '<p class="hint">输入学生姓名或学校进行查询</p>';
    const listS = document.getElementById('stu-list');
    if(USE_API){ renderSalesApiList(listS, false); return; }  // API 模式：搜索走服务端
    if(!stuQuery){
      // 无关键字：只展示示例学生（演示用），真实学生仍需搜索——防批量泄露；首字母筛选叠加生效
      const demo = groups.filter(g=>g.sample && matchLetters(g.name, stuLetters));
      listS.innerHTML = demo.length
        ? '<p class="hint" style="margin-bottom:10px">以下为示例学生（演示用）；查询真实学生请输入姓名或学校：</p>' + demo.map(g=>salesStuCard(g, false)).join('')
        : '<p class="hint">' + (stuLetters.length ? '没有匹配该首字母的示例学生。' : '输入学生姓名或学校进行查询') + '</p>';
      return;
    }
    const matchedS = groups.filter(g=>(g.name.indexOf(stuQuery)!==-1 || (g.school||'').indexOf(stuQuery)!==-1) && matchLetters(g.name, stuLetters));
    listS.innerHTML = matchedS.length
      ? matchedS.map(g=>salesStuCard(g, false)).join('')
      : '<p class="hint">没有匹配「' + esc(stuQuery) + '」的学生。</p>';
    return;
  }

  // 明细按创建时间倒序：排序键用学生 createdAt（ISO 解析；服务端 id 非时间戳格式，用 id 解析会退化为 0 导致跳动）。
  // createdAt 缺失（旧 mock 数据）时回落 id 的时间戳解析，mock 模式行为不变
  const stuSortKey = s => {
    const t = s.createdAt ? Date.parse(s.createdAt) : NaN;
    return isNaN(t) ? (parseInt(s.id, 36) || 0) : t;
  };
  groups.sort((a,b)=>{
    const ma = Math.max(...a.ids.map(id=>{ const s = pool.students.find(x=>x.id===id); return s ? stuSortKey(s) : 0; }));
    const mb = Math.max(...b.ids.map(id=>{ const s = pool.students.find(x=>x.id===id); return s ? stuSortKey(s) : 0; }));
    return mb - ma;
  });

  // 柱状图
  const wrap = document.getElementById('bar-chart');
  // 姓名搜索 + 首字母筛选叠加过滤（取交集；图表与明细同口径联动）
  const filtered = groups.filter(g=>(!stuQuery || g.name.indexOf(stuQuery) !== -1) && matchLetters(g.name, stuLetters));

  // 助教维度筛选 chips（仅教务可见；助教端不渲染该行）。只作用于学生明细列表，不影响上方图表
  const chipBox = document.getElementById('stu-ta-filter');
  if(chipBox){
    if(!isAdminView()){
      chipBox.innerHTML = '';
    } else {
      const chipTas = getUsersCache().filter(u=>u.role==='ta');
      chipBox.innerHTML = '<div class="ta-chips">' +
        '<span class="sub-chip' + (stuTaFilter==='all'?' active':'') + '" onclick="setStuTaFilter(\'all\')">全部学生</span>' +
        chipTas.map(u=>'<span class="sub-chip' + (stuTaFilter===u.id?' active':'') + '" onclick="setStuTaFilter(\'' + u.id + '\')">' +
          esc(u.name) + (u.disabled ? ' <span class="chip-cnt">已停用</span>' : '') + '</span>').join('') +
        '</div>';
    }
  }

  // 柱状图：每个科目 → 范围内所有学生的平均正确率（排除无作业记录——无作业不产生正确率）
  const chartRecs = gradedRecs(state.records.filter(r=>filtered.some(g=>g.ids.includes(r.studentId))));
  const subjMap = {};
  chartRecs.forEach(r=>{
    const k = r.subject || '未指定';
    (subjMap[k] = subjMap[k] || []).push(r);
  });
  // 按科目树顺序规整排列（学科 → 竞赛 → 语培 → 其他/未指定）
  const ordered = [];
  const tree = subjectTree();
  Object.keys(tree).forEach(cat=>{
    Object.keys(tree[cat]).forEach(l2=>{
      const kids = tree[cat][l2];
      if(kids){ kids.forEach(l3=>ordered.push(cat + ' / ' + l2 + ' / ' + l3)); }
      else { ordered.push(cat + ' / ' + l2); }
    });
  });
  Object.keys(subjMap).forEach(k=>{ if(ordered.indexOf(k)===-1) ordered.push(k); });
  const stats = ordered.filter(k=>subjMap[k]).map(k=>{
    const arr = subjMap[k];
    const cat = tree[k.split(' / ')[0]] ? k.split(' / ')[0] : '其他';
    return {key:k, cat:cat, name:shortSubject(k), cnt:arr.length,
      avg:Math.round(arr.reduce((x,r)=>x+acc(r),0)/arr.length)};
  });

  if(!stats.length){
    wrap.innerHTML = stuQuery
      ? '<p class="hint">没有匹配「' + esc(stuQuery) + '」的作业记录。</p>'
      : (stuLetters.length
        ? '<p class="hint">没有匹配该首字母的作业记录。</p>'
        : '<p class="hint empty-tip"><svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect x="5" y="7" width="38" height="34" rx="6" fill="#F0F8F4"/><path d="M24 15v21M24 15c-2.5-2.8-6-3.8-10-3.8v21c4 0 7.5 1 10 3.8 2.5-2.8 6-3.8 10-3.8v-21c-4 0-7.5 1-10 3.8z" stroke="#5FB89A" stroke-width="2.2" stroke-linejoin="round"/></svg>暂无作业记录，录入后即可看到图表。</p>');
  } else {
    // 横向条形列表：分组标题 + 每行一个科目（名称/进度条/正确率/次数），长标签不再重叠
    let html = '', lastCat = '';
    stats.forEach(x=>{
      if(x.cat !== lastCat){
        lastCat = x.cat;
        html += '<div class="subj-cat">' + esc(x.cat) + '</div>';
      }
      const color = x.avg>=85 ? '#5FB89A' : (x.avg>=60 ? '#E8A94C' : '#DE6B6B');
      html += '<div class="subj-row">' +
        '<div class="subj-name" title="' + esc(x.key) + '">' + esc(x.name) + '</div>' +
        '<div class="subj-bar"><div class="subj-fill" style="width:' + x.avg + '%;background:' + color + '"></div>' +
        '<span class="subj-pct">' + x.avg + '%</span></div>' +
        '<div class="subj-cnt">' + x.cnt + ' 次</div>' +
        '</div>';
    });
    wrap.innerHTML = html;
  }

  // 学生明细
  const list = document.getElementById('stu-list');
  if(!activeStudents().length){
    list.innerHTML = '<p class="hint empty-tip"><svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect x="5" y="7" width="38" height="34" rx="6" fill="#F0F8F4"/><path d="M24 15v21M24 15c-2.5-2.8-6-3.8-10-3.8v21c4 0 7.5 1 10 3.8 2.5-2.8 6-3.8 10-3.8v-21c-4 0-7.5 1-10 3.8z" stroke="#5FB89A" stroke-width="2.2" stroke-linejoin="round"/></svg>暂无在服务学生，点右上角「新增学生」录入。</p>';
    return;
  }
  // 教务的助教维度筛选与姓名搜索叠加生效
  const detail = (isAdminView() && stuTaFilter!=='all') ? filtered.filter(g=>g.ownerId===stuTaFilter) : filtered;
  if(!filtered.length){
    list.innerHTML = stuQuery
      ? '<p class="hint">没有匹配「' + esc(stuQuery) + '」的学生，换个关键词试试。</p>'
      : '<p class="hint">没有匹配该首字母的学生，换个字母试试。</p>';
    return;
  }
  if(!detail.length){
    list.innerHTML = '<p class="hint">该助教名下暂无匹配的学生。</p>';
    return;
  }
  const renderStuCard = g=>{
    const recs = state.records.filter(r=>g.ids.includes(r.studentId)).sort((a,b)=>a.date<b.date?-1:1);
    const recsG = gradedRecs(recs);  // 有成绩的记录（无作业不参与正确率，但计入作业次数）
    const avg = recsG.length ? Math.round(recsG.reduce((x,r)=>x+acc(r),0)/recsG.length) : null;
    const misses = state.missed.filter(m=>g.ids.includes(m.studentId));
    const openMiss = misses.filter(m=>!m.resolved);
    const s = {id:g.ids[0], name:g.name, sample:g.sample};  // 组内第一个条目用于操作

    // 趋势迷你折线（最近 8 次有成绩的记录；无作业不占点）
    let trend = '<span class="hint">暂无记录</span>';
    if(recsG.length){
      const last = recsG.slice(-8);
      const pts = last.map((r,i)=>{
        const x = 6 + i*(108/Math.max(1,last.length-1 || 1));
        const y = 34 - acc(r)*0.28;
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
      trend = '<svg width="120" height="40" viewBox="0 0 120 40"><polyline points="' + pts + '" fill="none" stroke="#5FB89A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }

    // 分科目正确率（每位同学按科目分别统计）；徽章可点击作为 Tab，展开该科目快速录入
    // 同时包含学生手动添加的学习科目（可能尚无作业记录）
    const subMap = {};
    recs.forEach(r=>{ const k = r.subject || '未指定'; (subMap[k]=subMap[k]||[]).push(r); });
    const orderedSubjects = [];
    const _seen = new Set();
    recs.forEach(r=>{ const k = r.subject || '未指定'; if(!_seen.has(k)){ _seen.add(k); orderedSubjects.push(k); } });
    g.ids.forEach(id=>{
      const stu = state.students.find(x=>x.id===id);
      if(stu && stu.subjects) stu.subjects.forEach(sub=>{ if(!_seen.has(sub)){ _seen.add(sub); orderedSubjects.push(sub); } });
    });
    let subHtml = '';
    if(orderedSubjects.length){
      subHtml = '<div class="sub-acc">' + orderedSubjects.map(k=>{
        const arr = subMap[k] || [];
        const arrG = gradedRecs(arr);  // 徽章正确率排除无作业（次数仍含无作业——计入已完成）
        const sa = arrG.length ? Math.round(arrG.reduce((x,r)=>x+acc(r),0)/arrG.length) : null;
        const isActive = quickEntry && quickEntry.gid===s.id && quickEntry.subject===k;
        const isRenaming = renaming && renaming.gid===s.id && renaming.subject===k;
        const repStuCmt = state.students.find(x=>x.id===s.id);
        const hasCmt = !!(repStuCmt && repStuCmt.subjComments && repStuCmt.subjComments[k]);
        const planCnt = (repStuCmt && repStuCmt.subjPlans && repStuCmt.subjPlans[k]) || null;
        const mockSt = (repStuCmt && repStuCmt.mock && repStuCmt.mock[k]) || {};
        const mockDate = mockSt.date || '';
        const mockScore = (mockSt.score!==undefined && mockSt.score!==null && mockSt.score!=='') ? mockSt.score : null;
        const omc = overdueMissCount(g.ids, k);
        if(isRenaming){
          return '<span class="chip-edit">' +
            '<input id="ren-input" value="' + esc(k) + '" onkeydown="if(event.key===\'Enter\')saveRenameSubject();if(event.key===\'Escape\')cancelRename()">' +
            '<button class="btn mint sm" onclick="saveRenameSubject()">保存</button>' +
            '<button class="btn ghost sm" onclick="cancelRename()">取消</button>' +
            '<button class="btn danger sm" onclick="deleteSubject()" title="删除该科目及其全部作业记录、打卡计划、评语、模考信息">删除科目</button>' +
            '</span>';
        }
        return '<span class="sub-chip' + (isActive?' active':'') + '" onclick="toggleQuickEntry(\'' + s.id + '\',\'' + esc(k) + '\')" title="点击录入该科目作业">' +
          '<span class="sub-name">' + esc(shortSubject(k)) + '</span>' +
          (omc>=2 ? '<span class="sub-alert" title="该科目有 ' + omc + ' 次逾期未交作业">!</span>' : '') +
          (hasCmt ? '<span class="sub-cmt-dot" title="已有老师评语"></span>' : '') +
          (mockDate ? '<span class="mock-tag booked" title="已预约 ' + esc(mockDate) + ' 模考">约</span>' : '') +
          (mockScore!==null ? '<span class="mock-tag score" title="结课模考分数">模考 ' + esc(mockScore) + '</span>' : '') +
          (sa !== null ? '<span class="acc-badge ' + accClass(sa) + '">' + sa + '%</span>' : '<span class="acc-badge" style="background:var(--cream2);color:var(--ink2)">' + (arr.length ? '—' : '未录入') + '</span>') +
          '<span class="sub-cnt" title="' + (planCnt!==null ? '已完成 ' + arr.length + ' 次，应完成 ' + planCnt + ' 次' : '已录入 ' + arr.length + ' 次') + '">' + (planCnt!==null ? arr.length + '/' + planCnt : arr.length) + ' 次</span>' +
          '<span class="edit-ico" onclick="startRenameSubject(\'' + s.id + '\',\'' + esc(k) + '\',event)" title="修改科目名">✎</span></span>';
      }).join('') + '</div>';
    }

    let missHtml = '';
    if(openMiss.length){
      missHtml = '<div class="missed-list">未交 ' + openMiss.length + ' 次：' +
        openMiss.map(m=>m.date + (m.subject ? '（' + esc(shortSubject(m.subject)) + '）' : '')).join('、') + '</div>';
    } else {
      missHtml = '<div style="font-size:13px;color:var(--ink2);margin-top:6px">历史未交 ' + misses.length + ' 次（均已处理）</div>';
    }

    // 每次详细记录已合并进科目 Tab 的打卡格子视图（点击科目徽章查看）
    // 家长绑定状态（学生维度，服务号推送用）：显示在学生卡头部标签区
    const repStuBind = state.students.find(x=>x.id===s.id);
    const bindCnt = repStuBind ? (repStuBind.bindCnt || 0) : 0;
    const bindTag = bindCnt > 0
      ? ' <span class="tag mint owner-tag" onclick="openBindsModal(\'' + s.id + '\')" title="点击查看已绑定家长，可手动解绑">已绑定家长（' + bindCnt + ' 人）</span>'
      : ' <span class="tag amber owner-tag" onclick="openBindModal(\'' + s.id + '\')" title="生成家长绑定二维码，转发给家长微信扫码即绑定">未绑定微信</span>';

    return '<div class="stu-card">' +
      '<div class="stu-head"><div class="avatar">' + esc(g.name.slice(0,1)) + '</div>' +
      '<div class="grow"><b class="stu-name-link" onclick="openEditStudent([\'' + g.ids.join('\',\'') + '\'])" title="点击修改学生信息">' + esc(g.name) + '</b>' +
      (g.school ? ' <span style="font-weight:400;font-size:12px;color:var(--ink2)">' + esc(g.school) + '</span>' : '') +
      (g.gradYear ? ' <span class="tag mint">' + g.gradYear + ' 届</span>' : '') +
      (g.ids.length>1 ? ' <span class="tag mint">同名合并 ×' + g.ids.length + '</span>' : '') +
      (g.sample?' <span class="tag sample">示例</span>':'') +
      (isAdminView() ? ' <span class="tag mint owner-tag" onclick="openTransfer([\'' + g.ids.join('\',\'') + '\'])" title="归属助教，点击可转移归属">归属：' + esc(ownerName(g.ownerId)) + '</span>' : '') +
      bindTag + '</div>' +
      trend +
      '<button class="btn ghost sm" onclick="toggleAddSubject(\'' + s.id + '\')" title="为该学生添加学习科目">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>新增科目</button>' +
      '</div>' +
      '<div class="stu-nums"><span>作业次数 <b>' + recs.length + '</b></span><span>未交次数 <b style="color:var(--red)">' + misses.length + '</b></span>' +
      (lastGradedRec(recs) ? '<span>最近正确率 <b>' + acc(lastGradedRec(recs)) + '%</b></span>' : '') +
      '<span style="margin-left:auto"><button class="btn ghost sm" onclick="archiveGroup([\'' + g.ids.join('\',\'') + '\'])">转为历史学生</button></span></div>' +
      subHtml +
      (addSubjGid===s.id ? addSubjPanelHtml(s.id) : '') +
      (quickEntry && quickEntry.gid===s.id ? qePanelHtml() : '') +
      missHtml +
      '</div>';
  };
  // 教务且选中「全部学生」：按助教分组展示（分组顺序沿用 getUsersCache() 中助教顺序），
  // 默认折叠只显示组头，点击组头展开/收起；有搜索词时自动展开含匹配结果的组；
  // 选中某位助教：只显示该助教的学生卡（无分组标题，直接展开）
  if(isAdminView() && stuTaFilter==='all'){
    const tas = getUsersCache().filter(u=>u.role==='ta');
    const renderGroup = (key, label, gs)=>{
      const open = !!stuQuery || !!stuTaExpanded[key];
      return '<div class="ta-group-head" style="cursor:pointer" onclick="toggleTaGroup(\'' + key + '\')" title="点击展开/收起">' +
        '<span class="chev">' + (open ? '▾' : '▸') + '</span>' + label +
        '<span class="cnt">' + gs.length + ' 个学生</span></div>' +
        (open ? gs.map(renderStuCard).join('') : '');
    };
    let html = '';
    tas.forEach(u=>{
      const gs = detail.filter(g=>g.ownerId===u.id);
      if(!gs.length) return;
      html += renderGroup(u.id, esc(u.name) + (u.disabled?'（已停用）':''), gs);
    });
    const others = detail.filter(g=>!tas.some(u=>u.id===g.ownerId));
    if(others.length) html += renderGroup('__other__', '其他（教务直接录入）', others);
    list.innerHTML = html;
  } else {
    list.innerHTML = detail.map(renderStuCard).join('');
  }
}
/* 销售视角只读学生卡：姓名/学校/届/归属助教/科目徽章/作业与未交次数/最近趋势；无任何操作入口（无 onclick） */
function salesStuCard(g, isAlumni){
  const recs = state.records.filter(r=>g.ids.includes(r.studentId)).sort((a,b)=>a.date<b.date?-1:1);
  const recsG = gradedRecs(recs);  // 无作业不参与正确率/趋势（次数计入）
  const misses = state.missed.filter(m=>g.ids.includes(m.studentId));
  let trend = '<span class="hint">暂无记录</span>';
  if(recsG.length){
    const last = recsG.slice(-8);
    const pts = last.map((r,i)=>{
      const x = 6 + i*(108/Math.max(1,last.length-1 || 1));
      const y = 34 - acc(r)*0.28;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    trend = '<svg width="120" height="40" viewBox="0 0 120 40"><polyline points="' + pts + '" fill="none" stroke="#5FB89A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  const subMap = {};
  recs.forEach(r=>{ const k = r.subject || '未指定'; (subMap[k]=subMap[k]||[]).push(r); });
  const subKeys = Object.keys(subMap);
  const subHtml = subKeys.length ? '<div class="sub-acc">' + subKeys.map(k=>{
    const arr = subMap[k];
    const arrG = gradedRecs(arr);  // 徽章正确率排除无作业（次数含无作业——计入已完成）
    const sa = arrG.length ? Math.round(arrG.reduce((x,r)=>x+acc(r),0)/arrG.length) : null;
    const isOpen = salesSubj && salesSubj.gid===g.ids[0] && salesSubj.subject===k;
    return '<span class="sub-chip' + (isOpen?' active':'') + '" onclick="toggleSalesSubject(\'' + g.ids[0] + '\',\'' + esc(k) + '\')" title="点击查看该科目详情（只读）">' +
      '<span class="sub-name">' + esc(shortSubject(k)) + '</span>' +
      (sa === null
        ? '<span class="acc-badge" style="background:var(--cream2);color:var(--ink2)">—</span>'  // 仅无作业记录：无正确率
        : '<span class="acc-badge ' + accClass(sa) + '">' + sa + '%</span>') +
      '<span class="sub-cnt">' + arr.length + ' 次</span></span>';
  }).join('') + '</div>' : '';
  return '<div class="stu-card">' +
    '<div class="stu-head"><div class="avatar">' + esc(g.name.slice(0,1)) + '</div>' +
    '<div class="grow"><b>' + esc(g.name) + '</b>' +
    (g.school ? ' <span style="font-weight:400;font-size:12px;color:var(--ink2)">' + esc(g.school) + '</span>' : '') +
    (g.gradYear ? ' <span class="tag mint">' + g.gradYear + ' 届</span>' : '') +
    (g.sample ? ' <span class="tag sample">示例</span>' : '') +
    ' <span class="tag amber">归属：' + esc(ownerName(g.ownerId)) + '</span></div>' +
    trend + '</div>' +
    '<div class="stu-nums"><span>' + (isAlumni ? '历史作业' : '作业次数') + ' <b>' + recs.length + '</b></span>' +
    '<span>未交次数 <b style="color:var(--red)">' + misses.length + '</b></span>' +
    (lastGradedRec(recs) ? '<span>最近正确率 <b>' + acc(lastGradedRec(recs)) + '%</b></span>' : '') +
    '</div>' +
    subHtml +
    (salesSubj && salesSubj.gid===g.ids[0] ? salesSubjectPanel(g, salesSubj.subject) : '') +
    '</div>';
}

/* ================= 销售端：科目只读详情（点击徽章展开，无任何编辑入口） ================= */
let salesSubj = null;  // {gid, subject} 当前展开的科目详情
function toggleSalesSubject(gid, subject){
  salesSubj = (salesSubj && salesSubj.gid===gid && salesSubj.subject===subject) ? null : {gid:gid, subject:subject};
  renderStats(); renderAlumni();
}
/* 只读打卡格子：复用 checkinGrid 的结构与配色，去掉全部 onclick/补录提示 */
function salesCheckinGrid(g, subject){
  const st = state.students.find(x=>x.id===g.ids[0]);
  const plan = (st && st.subjPlans && st.subjPlans[subject]) || 0;
  const recs = state.records.filter(r=>g.ids.includes(r.studentId) && r.subject===subject)
    .map(r=>({type:'rec', date:r.date, rec:r}));
  const miss = state.missed.filter(m=>g.ids.includes(m.studentId) && (m.subject||'')===subject && !m.resolved)
    .map(m=>({type:'miss', date:m.date, miss:m}));
  const items = recs.concat(miss).sort((a,b)=> a.date===b.date ? (a.type==='rec'?-1:1) : (a.date<b.date?-1:1));
  const total = Math.max(plan, items.length);
  if(!total) return '<span style="font-size:12px;color:var(--ink2)">暂无计划与记录</span>';
  return Array.from({length: total}, (_,i)=>{
    const idx = i+1;
    const it = items[i];
    if(it && it.type==='miss'){
      return '<div class="ci-slot miss" title="第 ' + idx + ' 次：' + it.miss.date + ' 未交">' +
        '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span><span class="ci-mark">未交✗</span></div>' +
        '<div class="ci-date">' + it.miss.date + '</div>' +
        '<div class="ci-acc" style="color:var(--red)">0%</div>' +
        '<div class="ci-wrongs">错题 0</div>' +
        '</div>';
    }
    const r = it && it.type==='rec' ? it.rec : null;
    if(r){
      if(r.noHomework){  // 销售只读：无作业格子同样中性展示（无正确率与错题）
        return '<div class="ci-slot nohw" title="本次无作业">' +
          '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span><span class="ci-mark">无作业</span></div>' +
          '<div class="ci-date">' + r.date + '</div>' +
          '<div class="ci-acc" style="color:var(--ink2)">—</div>' +
          '<div class="ci-wrongs">本次无作业</div>' +
          '</div>';
      }
      const ra = acc(r);
      const acls = ra>=85?'good':(ra>=60?'mid':'bad');
      return '<div class="ci-slot done" title="第 ' + idx + ' 次：' + r.date + '，正确率 ' + ra + '%' +
        (r.wrongs&&r.wrongs.length ? '，错题 ' + esc(r.wrongs.join('、')) : '') + '">' +
        '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span><span class="ci-mark"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg></span></div>' +
        '<div class="ci-date">' + r.date + '</div>' +
        '<div class="ci-acc ' + acls + '">' + ra + '%</div>' +
        '<div class="ci-wrongs">' + (r.wrongs&&r.wrongs.length ? '错 ' + esc(r.wrongs.join('、')) : '无错题') + '</div>' +
        '</div>';
    }
    return '<div class="ci-slot miss" title="第 ' + idx + ' 次作业未完成">' +
      '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span></div>' +
      '<div class="ci-date">未完成</div>' +
      '<div class="ci-acc" style="color:var(--red)">—</div>' +
      '<div class="ci-wrongs">未完成</div>' +
      '</div>';
  }).join('');
}
/* 只读科目详情面板：打卡格子 + 老师评语 + 学习计划与建议 + 模考（全部只读） */
function salesSubjectPanel(g, subject){
  const st = state.students.find(x=>x.id===g.ids[0]);
  const plan = (st && st.subjPlans && st.subjPlans[subject]) || 0;
  const recCount = state.records.filter(r=>g.ids.includes(r.studentId) && r.subject===subject).length;
  const cmt = (st && st.subjComments && st.subjComments[subject]) || '';
  const adv = (st && st.subjAdvice && st.subjAdvice[subject]) || '';
  const mock = (st && st.mock && st.mock[subject]) || {};
  const mockDate = mock.date || '';
  const mockScore = (mock.score!==undefined && mock.score!==null && mock.score!=='') ? mock.score : '';
  const roBox = t => '<div style="font-size:13px;color:var(--ink2);background:var(--cream2);border-radius:8px;padding:8px 10px;white-space:pre-wrap">' + t + '</div>';
  return '<div class="qe-panel">' +
    '<div class="qe-title">「' + esc(shortSubject(subject)) + '」作业打卡（只读）</div>' +
    '<div class="plan-row"><span style="font-size:14px;font-weight:600">应完成作业次数</span><span class="plan-hint">' +
      (plan ? '已定 ' + plan + ' 次，已完成 ' + recCount + ' 次' : '未设置计划') + '</span></div>' +
    '<div class="ci-title">打卡情况' + (plan ? '（应完成 ' + plan + ' 次，已完成 ' + recCount + ' 次）' : '') + '</div>' +
    '<div class="ci-grid">' + salesCheckinGrid(g, subject) + '</div>' +
    '<div class="qe-comment"><div class="qe-title">老师评语（' + esc(shortSubject(subject)) + '）</div>' +
      roBox(cmt ? esc(cmt) : '<span class="hint">暂无评语</span>') + '</div>' +
    '<div class="qe-comment"><div class="qe-title">学习计划与建议（' + esc(shortSubject(subject)) + '）</div>' +
      roBox(adv ? esc(adv) : '<span class="hint">暂无</span>') + '</div>' +
    '<div class="qe-mock"><div class="qe-title">模考（' + esc(shortSubject(subject)) + '）</div>' +
      '<div class="mock-row">' + (mockDate ? '<span class="mock-booked">✓ 已预约 ' + esc(mockDate) + ' 模考</span>' : '<span class="hint">未预约模考</span>') + '</div>' +
      '<div class="mock-row" style="margin-top:8px">' + (mockScore!=='' ? '结课模考分数：<b>' + esc(mockScore) + '</b> 分' : '<span class="hint">未录入模考分数</span>') + '</div>' +
    '</div>' +
    '</div>';
}

/* ================= 销售端（API 模式）：搜索/详情走服务端接口，本地不拉全量 ================= */
let salesSubjApi = null;        // {id, subject} 当前展开的科目详情
const salesDetailCache = {};    // studentId → 详情（接口返回）
// 列表：GET /api/search/students?q=
async function renderSalesApiList(listEl, isAlumni){
  const q = isAlumni ? alumniQuery : stuQuery;
  if(!q){ listEl.innerHTML = '<p class="hint">输入学生姓名或学校进行查询</p>'; return; }
  const r = await HttpApi._req('GET', '/api/search/students?q=' + encodeURIComponent(q));
  if(!r.ok){ listEl.innerHTML = '<p class="hint">查询失败，请重试。</p>'; return; }
  // 首字母筛选在服务端搜索结果上叠加（客户端后过滤）
  const letters = isAlumni ? alumniLetters : stuLetters;
  const items = r.students.filter(s=> (isAlumni ? s.archived : !s.archived) && matchLetters(s.name, letters));
  listEl.innerHTML = items.length
    ? items.map(s=>salesApiCard(s, isAlumni)).join('')
    : '<p class="hint">没有匹配「' + esc(q) + '」的' + (isAlumni ? '历史' : '') + '学生。</p>';
  // 列表是异步渲染的：若有展开中的科目详情且已缓存，渲染完成后自动回填面板（避免竞态）
  if(salesSubjApi && salesDetailCache[salesSubjApi.id]) fillSalesApiPanel(salesSubjApi.id);
}
function fillSalesApiPanel(id){
  const el = document.getElementById('sales-api-panel-' + id);
  if(el && salesSubjApi && salesSubjApi.id===id) el.innerHTML = salesApiPanel(salesDetailCache[id], salesSubjApi.subject);
}
function salesApiCard(s, isAlumni){
  const subHtml = (s.subjects && s.subjects.length) ? '<div class="sub-acc">' + s.subjects.map(sub=>
    '<span class="sub-chip" onclick="toggleSalesSubjectApi(\'' + s.id + '\',\'' + esc(sub.subject) + '\',' + isAlumni + ')" title="点击查看该科目详情（只读）">' +
    '<span class="sub-name">' + esc(shortSubject(sub.subject)) + '</span>' +
    '<span class="acc-badge ' + accClass(sub.avg) + '">' + sub.avg + '%</span>' +
    '<span class="sub-cnt">' + sub.cnt + ' 次</span></span>').join('') + '</div>' : '';
  return '<div class="stu-card">' +
    '<div class="stu-head"><div class="avatar">' + esc(s.name.slice(0,1)) + '</div>' +
    '<div class="grow"><b>' + esc(s.name) + '</b>' +
    (s.school ? ' <span style="font-weight:400;font-size:12px;color:var(--ink2)">' + esc(s.school) + '</span>' : '') +
    (s.gradYear ? ' <span class="tag mint">' + esc(s.gradYear) + ' 届</span>' : '') +
    ' <span class="tag amber">归属：' + esc(s.ownerName) + '</span></div></div>' +
    '<div class="stu-nums"><span>' + (isAlumni ? '历史作业' : '作业次数') + ' <b>' + s.recCnt + '</b></span>' +
    '<span>未交次数 <b style="color:var(--red)">' + s.missCnt + '</b></span>' +
    (s.lastAcc !== null ? '<span>最近正确率 <b>' + s.lastAcc + '%</b></span>' : '') +
    '</div>' + subHtml +
    (salesSubjApi && salesSubjApi.id===s.id ? '<div id="sales-api-panel-' + s.id + '"></div>' : '') +
    '</div>';
}
// 详情：GET /api/search/students/:id（带缓存），展开只读面板
async function toggleSalesSubjectApi(id, subject, isAlumni){
  salesSubjApi = (salesSubjApi && salesSubjApi.id===id && salesSubjApi.subject===subject) ? null : {id:id, subject:subject};
  if(isAlumni) renderAlumni(); else renderStats();
  if(!salesSubjApi) return;
  if(!salesDetailCache[id]){
    const r = await HttpApi._req('GET', '/api/search/students/' + id);
    if(!r.ok) return;
    salesDetailCache[id] = r.student;
  }
  fillSalesApiPanel(id);  // 面板占位由 renderSalesApiList 渲染；此处先填一次，重绘时由列表末尾自动回填
}
/* 只读科目详情面板（数据来自服务端）：打卡格子 + 评语 + 学习计划与建议 + 模考 */
function salesApiPanel(st, subject){
  const sub = (st.subjects || []).find(x=>x.subject===subject) || {plan:null, done:0, items:[]};
  const plan = sub.plan || 0;
  const cmt = (st.subjComments && st.subjComments[subject]) || '';
  const adv = (st.subjAdvice && st.subjAdvice[subject]) || '';
  const mock = (st.mock && st.mock[subject]) || {};
  const mockDate = mock.date || '';
  const mockScore = (mock.score!==undefined && mock.score!==null && mock.score!=='') ? mock.score : '';
  const roBox = t => '<div style="font-size:13px;color:var(--ink2);background:var(--cream2);border-radius:8px;padding:8px 10px;white-space:pre-wrap">' + t + '</div>';
  const total = Math.max(plan, sub.items.length);
  let grid = '<span style="font-size:12px;color:var(--ink2)">暂无计划与记录</span>';
  if(total){
    grid = Array.from({length: total}, (_,i)=>{
      const idx = i+1;
      const it = sub.items[i];
      if(it && it.type==='miss'){
        return '<div class="ci-slot miss" title="第 ' + idx + ' 次：' + it.date + ' 未交">' +
          '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span><span class="ci-mark">未交✗</span></div>' +
          '<div class="ci-date">' + it.date + '</div><div class="ci-acc" style="color:var(--red)">0%</div>' +
          '<div class="ci-wrongs">错题 0</div></div>';
      }
      if(it && it.type==='rec'){
        if(it.noHomework){  // 无作业格子（服务端明细带 noHomework 标记）
          return '<div class="ci-slot nohw" title="本次无作业">' +
            '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span><span class="ci-mark">无作业</span></div>' +
            '<div class="ci-date">' + it.date + '</div><div class="ci-acc" style="color:var(--ink2)">—</div>' +
            '<div class="ci-wrongs">本次无作业</div></div>';
        }
        const ra = it.acc;
        const acls = ra>=85?'good':(ra>=60?'mid':'bad');
        return '<div class="ci-slot done" title="第 ' + idx + ' 次：' + it.date + '，正确率 ' + ra + '%' +
          (it.wrongs&&it.wrongs.length ? '，错题 ' + esc(it.wrongs.join('、')) : '') + '">' +
          '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span><span class="ci-mark"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg></span></div>' +
          '<div class="ci-date">' + it.date + '</div>' +
          '<div class="ci-acc ' + acls + '">' + ra + '%</div>' +
          '<div class="ci-wrongs">' + (it.wrongs&&it.wrongs.length ? '错 ' + esc(it.wrongs.join('、')) : '无错题') + '</div></div>';
      }
      return '<div class="ci-slot miss" title="第 ' + idx + ' 次作业未完成">' +
        '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span></div>' +
        '<div class="ci-date">未完成</div><div class="ci-acc" style="color:var(--red)">—</div>' +
        '<div class="ci-wrongs">未完成</div></div>';
    }).join('');
  }
  return '<div class="qe-panel">' +
    '<div class="qe-title">「' + esc(shortSubject(subject)) + '」作业打卡（只读）</div>' +
    '<div class="plan-row"><span style="font-size:14px;font-weight:600">应完成作业次数</span><span class="plan-hint">' +
      (plan ? '已定 ' + plan + ' 次，已完成 ' + sub.done + ' 次' : '未设置计划') + '</span></div>' +
    '<div class="ci-title">打卡情况' + (plan ? '（应完成 ' + plan + ' 次，已完成 ' + sub.done + ' 次）' : '') + '</div>' +
    '<div class="ci-grid">' + grid + '</div>' +
    '<div class="qe-comment"><div class="qe-title">老师评语（' + esc(shortSubject(subject)) + '）</div>' +
      roBox(cmt ? esc(cmt) : '<span class="hint">暂无评语</span>') + '</div>' +
    '<div class="qe-comment"><div class="qe-title">学习计划与建议（' + esc(shortSubject(subject)) + '）</div>' +
      roBox(adv ? esc(adv) : '<span class="hint">暂无</span>') + '</div>' +
    '<div class="qe-mock"><div class="qe-title">模考（' + esc(shortSubject(subject)) + '）</div>' +
      '<div class="mock-row">' + (mockDate ? '<span class="mock-booked">✓ 已预约 ' + esc(mockDate) + ' 模考</span>' : '<span class="hint">未预约模考</span>') + '</div>' +
      '<div class="mock-row" style="margin-top:8px">' + (mockScore!=='' ? '结课模考分数：<b>' + esc(mockScore) + '</b> 分' : '<span class="hint">未录入模考分数</span>') + '</div>' +
    '</div>' +
    '</div>';
}
/* ================= 卡内科目 Tab 快速录入 ================= */
let quickEntry = null;  // {gid: 学生代表id, subject: 科目路径}
function toggleQuickEntry(gid, subject){
  if(quickEntry && quickEntry.gid===gid && quickEntry.subject===subject){
    quickEntry = null;  // 再点一次收起
  } else {
    quickEntry = {gid:gid, subject:subject};
  }
  renderAll();
}
function qePanelHtml(){
  const st = state.students.find(x=>x.id===quickEntry.gid);
  const isArchived = !!(st && st.archived);  // 历史学生：只读查看
  const savedComment = (st && st.subjComments && st.subjComments[quickEntry.subject]) ? st.subjComments[quickEntry.subject] : '';
  const savedAdvice = (st && st.subjAdvice && st.subjAdvice[quickEntry.subject]) ? st.subjAdvice[quickEntry.subject] : '';
  // 模考数据：{date:'YYYY-MM-DD', score:数字}，按 学生×科目 存储
  const mock = (st && st.mock && st.mock[quickEntry.subject]) || {};
  const mockDate = mock.date || '';
  const mockScore = (mock.score!==undefined && mock.score!==null && mock.score!=='') ? mock.score : '';
  const isMockEditDate = mockEdit && mockEdit.gid===quickEntry.gid && mockEdit.subject===quickEntry.subject && mockEdit.field==='date';
  const isMockEditScore = mockEdit && mockEdit.gid===quickEntry.gid && mockEdit.subject===quickEntry.subject && mockEdit.field==='score';
  let mockBookHtml;
  if(mockDate && !isMockEditDate){
    mockBookHtml = '<span class="mock-booked">✓ 已预约 ' + esc(mockDate) + ' 模考</span>' +
      '<button class="btn ghost sm" onclick="editMock(\'date\')">修改日期</button>' +
      '<button class="btn ghost sm" onclick="cancelMockExam()">取消预约</button>' +
      '<button class="btn ghost sm" onclick="pushManual(\'mock-book\')" title="给已绑定家长推送「考试报名成功通知」">推送报名通知</button>';
  } else {
    mockBookHtml = '<input id="mock-date" type="date" value="' + (mockDate || todayStr()) + '">' +
      '<button class="btn mint sm" onclick="bookMockExam()">预约模考</button>';
  }
  let mockScoreHtml;
  if(mockScore!=='' && !isMockEditScore){
    mockScoreHtml = '<span class="mock-score-shown">结课模考分数：<b>' + esc(mockScore) + '</b>分</span>' +
      '<button class="btn ghost sm" onclick="editMock(\'score\')">修改</button>' +
      '<button class="btn ghost sm" onclick="clearMockScore()">清除</button>' +
      '<button class="btn ghost sm" onclick="pushManual(\'mock-score\')" title="给已绑定家长推送「考试成绩通知」">推送成绩通知</button>';
  } else {
    mockScoreHtml = '<input id="mock-score" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="结课模考分数（0-100，直接输入数字）" value="' + (mockScore!==''?esc(mockScore):'') + '">' +
      '<button class="btn mint sm" onclick="saveMockScore()">保存模考分数</button>';
  }
  const plan = (st && st.subjPlans && st.subjPlans[quickEntry.subject]) || '';
  // 首次课程时间（科目级）：首次设定计划时必填；已设后助教可直改（不审批，记审计）
  const firstClass = (st && st.subjFirstClass && st.subjFirstClass[quickEntry.subject]) || '';
  const fcEditing = fcEdit && fcEdit.gid===quickEntry.gid && fcEdit.subject===quickEntry.subject;
  // 首次课程行：教务/历史学生只读展示；助教未设时不显示（随首次设定表单一起填）
  let firstClassHtml = '';
  if(plan || firstClass){
    firstClassHtml = '<div class="plan-row" style="margin-top:-4px"><span style="font-size:14px;font-weight:600">第一次课程时间</span>' +
      ((!isAdminView() && !isArchived)
        ? (fcEditing
            ? '<input id="qe-first-class-edit" type="date" value="' + esc(firstClass) + '">' +
              '<button class="btn mint sm" onclick="saveFirstClass()">保存</button>' +
              '<button class="btn ghost sm" onclick="fcEdit=null;renderAll()">取消</button>'
            : '<span class="plan-hint">' + esc(firstClass || '未填') + '</span>' +
              '<button class="btn ghost sm" onclick="editFirstClass()" title="修改开课日期（直接生效，不走审批）">修改</button>')
        : '<span class="plan-hint">' + esc(firstClass || '未填') + '</span>') +
      '</div>';
  }
  // 计划次数修改的申请状态：pending 显示「审核中（N→M）+ 撤回」；最近一次被驳回显示提示（有新申请/通过后消失）
  const pendReq = st ? Api.pendingPlanRequest(st.id, quickEntry.subject) : null;
  const lastReq = st ? (pool.planRequests || []).filter(r=>r.studentId===st.id && r.subject===quickEntry.subject && (r.status==='approved' || r.status==='rejected')).slice(-1)[0] : null;
  return '<div class="qe-panel">' +
    '<div class="qe-title" style="display:flex;align-items:center;justify-content:space-between;gap:10px"><span>「' + esc(shortSubject(quickEntry.subject)) + '」作业打卡</span>' +
    '<button class="btn mint sm" onclick="genReport()" title="生成该生该科目的作业打卡报告 PDF（含打卡情况、老师评语、模考信息）">⬇ 生成报告</button></div>' +
    '<div class="plan-row">' +
    (isArchived
      ? '<span style="font-size:14px;font-weight:600">应完成作业次数</span><span class="plan-hint">' + (plan ? '已定 ' + plan + ' 次，已完成 ' + countSubjectRecs(quickEntry.gid, quickEntry.subject) + ' 次' : '未设置计划') + '</span>'
      : isAdminView()
        // 教务视角只读：计划变更只走审批流，教务不在打卡面板直改
        ? '<span style="font-size:14px;font-weight:600">应完成作业次数</span><span class="plan-hint">' + (plan ? '已定 ' + plan + ' 次，已完成 ' + countSubjectRecs(quickEntry.gid, quickEntry.subject) + ' 次' : '未设置计划') + '</span>' +
          (pendReq ? ' <span class="tag amber">有修改申请待审批（' + pendReq.oldPlan + ' → ' + pendReq.newPlan + '）</span>' : '')
        : '<span style="font-size:14px;font-weight:600">应完成作业次数</span>' +
          '<input id="qe-plan" type="number" min="0" inputmode="numeric" placeholder="如 10" value="' + esc(plan) + '">' +
          (!plan ? '<input id="qe-first-class" type="date" title="第一次课程时间（必填，允许未来日期——提前排课）">' : '') +
          (!plan ? '<span class="plan-hint" style="color:var(--red)">* 首次设定需选第一次课程时间</span>' : '') +
          '<button class="btn mint sm" onclick="savePlanCount()">' + (plan ? '修改' : '保存') + '</button>' +
          (plan ? '<span class="plan-hint">已定 ' + plan + ' 次，点击格子录入或查看当次作业</span>' : '<span class="plan-hint">填写次数并保存后，自动生成打卡格子</span>') +
          (pendReq
            ? ' <span class="tag amber">已发送教管审批（' + pendReq.oldPlan + ' → ' + pendReq.newPlan + '）</span>' +
              '<button class="btn ghost sm" onclick="cancelPlanRequest(\'' + pendReq.id + '\')">撤回申请</button>'
            : (lastReq && lastReq.status==='rejected'
                ? ' <span class="tag red">上次修改申请已被驳回</span>'
                : ''))) +
    '</div>' +
    firstClassHtml +
    '<div class="ci-title">打卡情况' + (plan ? '（应完成 ' + plan + ' 次，已完成 ' + countSubjectRecs(quickEntry.gid, quickEntry.subject) + ' 次）' : '') + '</div>' +
    '<div class="ci-grid">' + checkinGridHtml() + '</div>' +
    (slotEdit && slotEdit.gid===quickEntry.gid && slotEdit.subject===quickEntry.subject ? slotEditHtml() : '') +
    '<div class="qe-comment">' +
    '<div class="qe-title">老师评语（' + esc(shortSubject(quickEntry.subject)) + '）</div>' +
    (isArchived
      ? '<div style="font-size:13px;color:var(--ink2);background:var(--cream2);border-radius:8px;padding:8px 10px;white-space:pre-wrap">' + (savedComment ? esc(savedComment) : '<span class="hint">暂无评语</span>') + '</div>'
      : '<textarea id="qe-comment" rows="2" placeholder="写一句给这位学生的科目评语，保存后科目旁会出现绿色小圆点…">' + esc(savedComment) + '</textarea>' +
        '<div class="qe-comment-actions">' +
        '<button class="btn mint sm" onclick="saveSubjectComment()">保存评语</button>' +
        '<span class="qe-saved-tip" id="qe-comment-tip" style="display:none">✓ 已保存</span>' +
        '</div>') +
    '</div>' +
    '<div class="qe-mock">' +
    '<div class="qe-title">模考（' + esc(shortSubject(quickEntry.subject)) + '）</div>' +
    (isArchived
      ? '<div class="mock-row">' + (mockDate ? '<span class="mock-booked">✓ 已预约 ' + esc(mockDate) + ' 模考</span>' : '<span class="hint">未预约模考</span>') + '</div>' +
        '<div class="mock-row" style="margin-top:8px">' + (mockScore!=='' ? '结课模考分数：<b>' + esc(mockScore) + '</b> 分' : '<span class="hint">未录入模考分数</span>') + '</div>'
      : '<div class="mock-row">' + mockBookHtml + '</div>' +
        '<div class="mock-row" style="margin-top:8px">' + mockScoreHtml + '</div>') +
    '</div>' +
    '<div class="qe-comment">' +
    '<div class="qe-title">学习计划与建议（' + esc(shortSubject(quickEntry.subject)) + '）</div>' +
    (isArchived
      ? '<div style="font-size:13px;color:var(--ink2);background:var(--cream2);border-radius:8px;padding:8px 10px;white-space:pre-wrap">' + (savedAdvice ? esc(savedAdvice) : '<span class="hint">暂无</span>') + '</div>'
      : '<textarea id="qe-advice" rows="3" placeholder="写给这位学生的学习计划与建议，会随「生成报告」一起输出…">' + esc(savedAdvice) + '</textarea>' +
        '<div class="qe-comment-actions">' +
        '<button class="btn mint sm" onclick="saveSubjectAdvice()">保存计划与建议</button>' +
        '<span class="qe-saved-tip" id="qe-advice-tip" style="display:none">✓ 已保存</span>' +
        '</div>') +
    '</div>' +
    '</div>';
}
function qeCalc(){
  const total = parseInt(document.getElementById('qe-total').value, 10);
  const correct = parseInt(document.getElementById('qe-correct').value, 10);
  const box = document.getElementById('qe-calc');
  if(!isNaN(total) && !isNaN(correct) && total>0 && correct>=0 && correct<=total){
    const a = Math.round(correct/total*100);
    box.innerHTML = '错误数 <b>' + (total-correct) + '</b>　正确率 <b style="color:' +
      (a>=85?'var(--mint-d)':(a>=60?'#B9802A':'var(--red)')) + '">' + a + '%</b>';
  } else {
    box.innerHTML = '错误数 <b>—</b>　正确率 <b>—</b>';
  }
}
function saveQuickEntry(){
  const date = document.getElementById('qe-date').value || todayStr();
  const total = parseInt(document.getElementById('qe-total').value, 10);
  const correct = parseInt(document.getElementById('qe-correct').value, 10);
  if(isNaN(total) || total<=0){ toast('请填写有效的总题数'); return; }
  if(isNaN(correct) || correct<0 || correct>total){ toast('正确题目数需在 0 到总题数之间'); return; }
  const wrongs = document.getElementById('qe-wrongs').value.split(/[,，、\s]+/).map(s=>s.trim()).filter(Boolean);
  const st = pool.students.find(x=>x.id===quickEntry.gid);
  if(!st || !canWriteOwner(st.ownerId)){ toast('没有权限操作该数据'); return; }
  const newRec = {id:uid(), studentId:quickEntry.gid, date:date, total:total, correct:correct,
    wrongs:wrongs, subject:quickEntry.subject, images:[], pdfs:[], ownerId:st.ownerId};
  pool.records.push(newRec);
  logAction('录入作业', 'record', auditStuDesc(quickEntry.gid, quickEntry.subject),
    '日期 ' + date + '，总 ' + total + ' 对 ' + correct + '（正确率 ' + Math.round(correct/total*100) + '%）', {ownerId: st.ownerId});
  apiPersist(HttpApi.addRecord({id: newRec.id, studentId: newRec.studentId, date: date, total: total, correct: correct,
    wrongs: wrongs, subject: newRec.subject, images: newRec.images, pdfs: newRec.pdfs}),
    r=>{ if(r && r.pushed) toast('作业成绩已推送给家长'); });  // id 客户端生成并贯穿；开关打开时服务端自动推送
  quickEntry = null;
  save();
  renderAll();
}
/* ================= 应完成次数 + 作业打卡（合并作业录入与详细记录） ================= */
let slotEdit = null;  // {gid, subject, idx} 当前展开编辑的打卡格子
let slNoHw = false;   // 「本次无作业」态（第四次态）：随格子开闭重置；打开已存的无作业记录时自动开启
let slTmpVals = null; // 切入无作业前的表单值暂存（「取消无作业」切回时恢复）
function countSubjectRecs(gid, subject){
  return state.records.filter(r=>r.studentId===gid && r.subject===subject).length;
}
function subjectRecsSorted(gid, subject){
  return state.records.filter(r=>r.studentId===gid && r.subject===subject)
    .sort((a,b)=>a.date<b.date?-1:1);
}
/* 保存应完成作业次数：助教首次设置直存；二次修改走教务审批（申请弹窗）；教务直改免审批（有 pending 则确认后自动驳回） */
function savePlanCount(){
  if(!quickEntry) return;
  const v = parseInt(document.getElementById('qe-plan').value, 10);
  if(isNaN(v) || v<0){ toast('请填写有效的次数（0 或正整数）'); return; }
  const st = state.students.find(x=>x.id===quickEntry.gid);
  if(!st || !canWriteOwner(st.ownerId)){ toast('没有权限操作该数据'); return; }
  const subject = quickEntry.subject;
  const oldPlan = (st.subjPlans && st.subjPlans[subject] !== undefined) ? st.subjPlans[subject] : null;
  let firstClassForPersist = null;  // 首次设定时由表单填入的第一次课程时间
  const applyPlan = ()=>{
    st.subjPlans = st.subjPlans || {};
    st.subjPlans[subject] = v;
    st.subjPlanSetAt = st.subjPlanSetAt || {};
    st.subjPlanSetAt[subject] = todayStr();  // 记录设定日期，供「计划停滞提醒」使用
    logAction(isAdminView() ? '教务直改计划次数' : '设定应完成次数', 'plan', auditStuDesc(st.id, subject), '设定为 ' + v + ' 次', {ownerId: st.ownerId});
    apiPersist(HttpApi.setPlan({studentId: st.id, subject: subject, plan: v, firstClassDate: firstClassForPersist || (st.subjFirstClass && st.subjFirstClass[subject])}));
    save();
    renderAll();
  };
  if(isAdminView()){
    // 教务直改免审批；若该生该科目存在 pending 申请，确认后自动驳回
    const pend = Api.pendingPlanRequest(st.id, subject);
    if(pend){
      askConfirm('直接修改计划次数', '该学生该科目有 1 条待审批的修改申请（' + pend.oldPlan + ' → ' + pend.newPlan + ' 次），直接保存将自动驳回该申请。确定吗？', ()=>{
        Api.reviewPlanRequest(pend.id, false, '教务直接修改，自动驳回');
        applyPlan();
      });
      return;
    }
    applyPlan();
    return;
  }
  if(oldPlan === null){
    // 首次设定：必须选第一次课程时间（允许未来日期——提前排课）
    const fcInput = document.getElementById('qe-first-class');
    const fc = fcInput ? fcInput.value : '';
    if(!fc){ toast('请选择第一次课程时间'); return; }
    firstClassForPersist = fc;
    st.subjFirstClass = st.subjFirstClass || {};
    st.subjFirstClass[subject] = fc;
    applyPlan(); return;
  }
  if(v === oldPlan){ toast('次数未变化，无需修改'); return; }
  const pend = Api.pendingPlanRequest(st.id, subject);
  if(pend){ toast('该科目已有待审核的修改申请（' + pend.oldPlan + ' → ' + pend.newPlan + ' 次），请先撤回或等待教务审批。'); return; }
  openPlanRequest(st, subject, oldPlan, v);  // 二次修改：走审批申请
}
/* ---- 第一次课程时间：助教直改（不走审批，记审计） ---- */
let fcEdit = null;  // {gid, subject} 当前展开的开课日期编辑行
function editFirstClass(){
  if(!quickEntry) return;
  fcEdit = {gid: quickEntry.gid, subject: quickEntry.subject};
  renderAll();
}
function saveFirstClass(){
  if(!quickEntry || !fcEdit) return;
  const inp = document.getElementById('qe-first-class-edit');
  const v = inp ? inp.value : '';
  if(!v){ toast('请选择第一次课程时间'); return; }
  const st = state.students.find(x=>x.id===quickEntry.gid);
  if(!st || !canWriteOwner(st.ownerId)){ toast('没有权限操作该数据'); return; }
  st.subjFirstClass = st.subjFirstClass || {};
  st.subjFirstClass[quickEntry.subject] = v;
  fcEdit = null;
  logAction('修改开课日期', 'plan', auditStuDesc(st.id, quickEntry.subject), '首次课程 ' + v, {ownerId: st.ownerId});
  apiPersist(HttpApi.updateSubjFields(st.id, {subjFirstClass: st.subjFirstClass}));
  save();
  renderAll();
}
/* ================= 计划修改申请弹窗（助教） ================= */
let planReqCtx = null;  // {gid, subject, oldPlan, newPlan}
function openPlanRequest(st, subject, oldPlan, newPlan){
  planReqCtx = {gid: st.id, subject: subject, oldPlan: oldPlan, newPlan: newPlan};
  document.getElementById('pr-stu').textContent = st.name;
  document.getElementById('pr-subj').textContent = shortSubject(subject);
  document.getElementById('pr-change').textContent = oldPlan + ' 次 → ' + newPlan + ' 次';
  document.getElementById('pr-reason').value = '';
  document.getElementById('pr-modal').classList.add('show');
}
function submitPlanRequest(){
  if(!planReqCtx) return;
  const reason = document.getElementById('pr-reason').value.trim();
  _submitPlanRequestAsync(planReqCtx, reason);  // mock 同步、API 异步，行为一致
}
async function _submitPlanRequestAsync(ctx, reason){
  const res = await Api.createPlanRequest({studentId: ctx.gid, subject: ctx.subject, newPlan: ctx.newPlan, reason: reason});
  if(!res.ok){ toast(res.msg); return; }
  planReqCtx = null;
  document.getElementById('pr-modal').classList.remove('show');
  renderAll();
  toast('已提交修改申请，教务审核通过后生效。');
}
document.getElementById('pr-cancel').addEventListener('click', ()=>{
  planReqCtx = null;
  document.getElementById('pr-modal').classList.remove('show');
});
document.getElementById('pr-ok').addEventListener('click', submitPlanRequest);
document.getElementById('ms-cancel').addEventListener('click', ()=>{
  missPickId = null;
  document.getElementById('miss-subj-modal').classList.remove('show');
});
document.getElementById('ms-ok').addEventListener('click', confirmMissSubject);
/* 助教撤回待审核申请 */
function cancelPlanRequest(id){
  askConfirm('撤回申请', '确定撤回这条计划修改申请吗？撤回后可重新提交。', async ()=>{
    const res = await Api.cancelPlanRequest(id);  // mock 同步、API 异步，await 兼容
    if(!res.ok){ toast(res.msg); return; }
    renderAll();
  });
}
/* 打卡区「今日未交」：按同表单页选择的日期登记未交（默认今天，支持补登历史日期），生成对应打卡格子 */
function markMissedToday(){
  if(!quickEntry) return;
  const gid = quickEntry.gid, subject = quickEntry.subject;
  const st = state.students.find(x=>x.id===gid);
  if(st && st.archived) return;
  if(!st || !canWriteOwner(st.ownerId)){ toast('没有权限操作该数据'); return; }
  // 优先取当前录入表单中的日期（补登未交场景），无表单则默认今天
  const dateInput = document.getElementById('sl-date');
  const date = (dateInput && dateInput.value) ? dateInput.value : todayStr();
  const hasRec = state.records.some(r=>r.studentId===gid && r.subject===subject && r.date===date);
  if(hasRec){ toast('该日期已录入该科目的作业记录，无需登记未交'); return; }
  const dup = state.missed.some(m=>m.studentId===gid && m.date===date && (m.subject||'')===subject && !m.resolved);
  if(dup){ toast('该学生在该日期已有此科目的未交记录'); return; }
  const newMiss = {id:uid(), studentId:gid, date:date, subject:subject, resolved:false, ownerId:st.ownerId};
  pool.missed.push(newMiss);
  logAction('登记未交', 'missed', auditStuDesc(gid, subject), '日期 ' + date, {ownerId: st.ownerId});
  apiPersist(HttpApi.addMissed({id: newMiss.id, studentId: gid, date: date, subject: subject}));  // id 客户端生成并贯穿
  save();
  renderAll();
}
/* 该科目打卡序列：作业记录 + 未处理的未交记录按日期合并排序，作为打卡格子数据源 */
function subjectItems(gid, subject){
  const recs = subjectRecsSorted(gid, subject).map(r=>({type:'rec', date:r.date, rec:r}));
  const miss = state.missed.filter(m=>m.studentId===gid && (m.subject||'')===subject && !m.resolved)
    .map(m=>({type:'miss', date:m.date, miss:m}));
  return recs.concat(miss).sort((a,b)=> a.date===b.date ? (a.type==='rec'?-1:1) : (a.date<b.date?-1:1));
}
/* 生成打卡格子：有记录=完成✓（日期/正确率/错题），未交=未交✗（日期/0%/错题0），无记录=未完成（无标记） */
function checkinGridHtml(){
  const gid = quickEntry.gid, subject = quickEntry.subject;
  const st = state.students.find(x=>x.id===gid);
  const plan = (st && st.subjPlans && st.subjPlans[subject]) || 0;
  const items = subjectItems(gid, subject);
  let total = Math.max(plan, items.length);
  // 补录中：编辑区指向的格子需显示出来
  if(slotEdit && slotEdit.gid===gid && slotEdit.subject===subject && slotEdit.idx>total) total = slotEdit.idx;
  if(!total) return '<span style="font-size:12px;color:var(--ink2)">暂无计划与记录，先在上方填写应完成次数</span>';
  return Array.from({length: total}, (_,i)=>{
    const idx = i+1;
    const it = items[i];
    if(it && it.type==='miss'){
      return '<div class="ci-slot miss" onclick="openSlot(' + idx + ')" title="第 ' + idx + ' 次：' + it.miss.date + ' 未交（' + (st&&st.archived?'点击查看':'点击补录') + '）">' +
        '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span><span class="ci-mark">未交✗</span></div>' +
        '<div class="ci-date">' + it.miss.date + '</div>' +
        '<div class="ci-acc" style="color:var(--red)">0%</div>' +
        '<div class="ci-wrongs">错题 0</div>' +
        '</div>';
    }
    const r = it && it.type==='rec' ? it.rec : null;
    if(r){
      if(r.noHomework){  // 无作业格子（第四次态）：中性灰蓝，只显示「无作业」+ 日期，不显示百分比与错题
        return '<div class="ci-slot nohw" onclick="openSlot(' + idx + ')" title="本次无作业（点击查看/修改）">' +
          '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span><span class="ci-mark">无作业</span></div>' +
          '<div class="ci-date">' + r.date + '</div>' +
          '<div class="ci-acc" style="color:var(--ink2)">—</div>' +
          '<div class="ci-wrongs">本次无作业</div>' +
          '</div>';
      }
      const ra = acc(r);
      const acls = ra>=85?'good':(ra>=60?'mid':'bad');
      return '<div class="ci-slot done" onclick="openSlot(' + idx + ')" title="第 ' + idx + ' 次：' + r.date + '，正确率 ' + ra + '%' +
        (r.wrongs&&r.wrongs.length ? '，错题 ' + esc(r.wrongs.join('、')) : '') + '（点击查看/修改）">' +
        '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span><span class="ci-mark"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg></span></div>' +
        '<div class="ci-date">' + r.date + '</div>' +
        '<div class="ci-acc ' + acls + '">' + ra + '%</div>' +
        '<div class="ci-wrongs">' + (r.wrongs&&r.wrongs.length ? '错 ' + esc(r.wrongs.join('、')) : '无错题') + '</div>' +
        '</div>';
    }
    return '<div class="ci-slot miss" onclick="openSlot(' + idx + ')" title="第 ' + idx + ' 次作业未完成' + (st&&st.archived?'':'，点击补录') + '">' +
      '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span></div>' +
      '<div class="ci-date">未完成</div>' +
      '<div class="ci-acc" style="color:var(--red)">—</div>' +
      '<div class="ci-wrongs">' + (st&&st.archived?'未完成':'点击补录') + '</div>' +
      '</div>';
  }).join('');
}
/* 点击格子：展开/收起当次录入（有记录则修改，无记录则新增） */
function openSlot(idx){
  if(slotEdit && slotEdit.gid===quickEntry.gid && slotEdit.subject===quickEntry.subject && slotEdit.idx===idx){
    slotEdit = null;
  } else {
    slotEdit = {gid:quickEntry.gid, subject:quickEntry.subject, idx:idx};
  }
  // 无作业态随格子开闭重置；打开已存的无作业记录时自动进入无作业态（日期可改、可切回正常录入）
  slNoHw = false;
  if(slotEdit){
    const it = subjectItems(slotEdit.gid, slotEdit.subject)[slotEdit.idx-1];
    if(it && it.type==='rec' && it.rec.noHomework) slNoHw = true;
  }
  renderAll();
  // 表单打开后立即计算一次：有已存记录且非满分无错题时，错题号立即显示必填红框
  if(slotEdit && !slNoHw && document.getElementById('sl-wrongs')) slCalc();
}
/* 「本次无作业」切换：正常成绩 → 无作业时若已有成绩内容需确认（成绩将被清除）；无作业 → 正常直接切回并恢复暂存值 */
function toggleSlotNoHw(){
  if(!slotEdit) return;
  if(!slNoHw){
    const items = subjectItems(slotEdit.gid, slotEdit.subject);
    const r = items[slotEdit.idx-1] && items[slotEdit.idx-1].type==='rec' ? items[slotEdit.idx-1].rec : null;
    const filledEl = document.getElementById('sl-total');
    const hasScore = (r && r.total > 0) || (filledEl && filledEl.value !== '');
    if(hasScore){
      askConfirm('本次无作业', '切换为「本次无作业」后，本次的题数、正确数与错题号将被清除。确定吗？', ()=>{
        slTmpVals = {
          total: filledEl ? filledEl.value : '',
          correct: document.getElementById('sl-correct') ? document.getElementById('sl-correct').value : '',
          wrongs: document.getElementById('sl-wrongs') ? document.getElementById('sl-wrongs').value : ''
        };
        slNoHw = true;
        renderAll();
      });
      return;
    }
    slNoHw = true;
    renderAll();
    return;
  }
  slNoHw = false;  // 取消无作业：切回正常表单（恢复切入前的填写值）
  renderAll();
}
/* 当次作业编辑区 HTML */
function slotEditHtml(){
  const items = subjectItems(slotEdit.gid, slotEdit.subject);
  const it = items[slotEdit.idx-1];
  const r = it && it.type==='rec' ? it.rec : null;
  const miss = it && it.type==='miss' ? it.miss : null;
  const st = state.students.find(x=>x.id===slotEdit.gid);
  // 历史学生：只读展示当次详情
  if(st && st.archived){
    if(miss){
      return '<div class="slot-edit"><div class="se-title">第 ' + slotEdit.idx + ' 次作业</div>' +
        '<div style="font-size:13px;color:var(--red);padding:4px 0">该次作业未交（' + miss.date + '），正确率 0%，错题 0。</div>' +
        '<div class="se-actions"><button class="btn ghost sm" onclick="openSlot(' + slotEdit.idx + ')">关闭</button></div></div>';
    }
    if(!r){
      return '<div class="slot-edit"><div class="se-title">第 ' + slotEdit.idx + ' 次作业</div>' +
        '<div style="font-size:13px;color:var(--red);padding:4px 0">该次作业未完成（未录入记录）。</div>' +
        '<div class="se-actions"><button class="btn ghost sm" onclick="openSlot(' + slotEdit.idx + ')">关闭</button></div></div>';
    }
    if(r.noHomework){  // 无作业记录：只读文案（无成绩可展示）
      return '<div class="slot-edit"><div class="se-title">第 ' + slotEdit.idx + ' 次作业（' + esc(shortSubject(slotEdit.subject)) + '）</div>' +
        '<div style="font-size:13px;color:var(--ink2);padding:4px 0">该次无作业（' + r.date + '）。</div>' +
        '<div class="se-actions"><button class="btn ghost sm" onclick="openSlot(' + slotEdit.idx + ')">关闭</button></div></div>';
    }
    const ra = acc(r);
    return '<div class="slot-edit"><div class="se-title">第 ' + slotEdit.idx + ' 次作业（' + esc(shortSubject(slotEdit.subject)) + '）</div>' +
      '<div class="se-grid">' +
      '<div class="se-calc">日期 <b>' + r.date + '</b></div>' +
      '<div class="se-calc">总题数 <b>' + r.total + '</b>　正确数 <b>' + r.correct + '</b>　错误数 <b>' + (r.total-r.correct) + '</b></div>' +
      '<div class="se-calc">正确率 <b style="color:' + (ra>=85?'var(--mint-d)':(ra>=60?'#B9802A':'var(--red)')) + '">' + ra + '%</b></div>' +
      (r.wrongs && r.wrongs.length ? '<div class="se-calc">错题 <b>' + esc(r.wrongs.join('、')) + '</b></div>' : '<div class="se-calc">错题 <span class="hint">无</span></div>') +
      '</div>' +
      '<div class="se-actions"><button class="btn ghost sm" onclick="openSlot(' + slotEdit.idx + ')">关闭</button></div></div>';
  }
  // 该次为未交记录：展示未交信息并直接提供补录表单（保存后该次未交自动视为已补交）
  if(miss){
    return '<div class="slot-edit">' +
      '<div class="se-title">补录第 ' + slotEdit.idx + ' 次作业（' + esc(shortSubject(slotEdit.subject)) + '）</div>' +
      '<div style="font-size:13px;color:var(--red);padding:4px 0 2px">该次为 ' + miss.date + ' 的未交作业（正确率 0%、错题 0）。填写下方信息并保存即完成这次补交；取消则保持未交状态。</div>' +
      '<div class="se-grid">' +
      '<input id="sl-date" type="date" value="' + miss.date + '">' +
      '<input id="sl-total" type="number" min="1" inputmode="numeric" placeholder="总题数" oninput="slCalc()">' +
      '<input id="sl-correct" type="number" min="0" inputmode="numeric" placeholder="正确题目数" oninput="slCalc()">' +
      '<div class="se-calc" id="sl-calc">错误数 <b>—</b>　正确率 <b>—</b></div>' +
      '<input id="sl-wrongs" class="se-full" placeholder="错题号（用逗号分隔，可空）">' +
      '</div>' +
      '<div class="se-actions">' +
      '<button class="btn mint sm" onclick="saveSlot()">保存并补交</button>' +
      '<button class="btn ghost sm" onclick="openSlot(' + slotEdit.idx + ')">取消</button>' +
      '</div></div>';
  }
  return '<div class="slot-edit">' +
    '<div class="se-title">' + (r ? '修改' : '录入') + '第 ' + slotEdit.idx + ' 次作业（' + esc(shortSubject(slotEdit.subject)) + '）' + (slNoHw ? '<span class="tag sample">本次无作业</span>' : '') + '</div>' +
    '<div class="se-grid">' +
    '<input id="sl-date" type="date" value="' + (r ? r.date : todayStr()) + '">' +
    '<input id="sl-total" type="number" min="1" inputmode="numeric" placeholder="总题数" value="' + (slNoHw ? '' : (r ? r.total : (slTmpVals ? slTmpVals.total : ''))) + '" oninput="slCalc()"' + (slNoHw ? ' disabled' : '') + '>' +
    '<input id="sl-correct" type="number" min="0" inputmode="numeric" placeholder="正确题目数" value="' + (slNoHw ? '' : (r ? r.correct : (slTmpVals ? slTmpVals.correct : ''))) + '" oninput="slCalc()"' + (slNoHw ? ' disabled' : '') + '>' +
    '<div class="se-calc" id="sl-calc">' + (slNoHw ? '本次无作业，仅需选择日期' : (r ? '已保存：错误数 <b>' + (r.total-r.correct) + '</b>　正确率 <b>' + acc(r) + '%</b>' : '错误数 <b>—</b>　正确率 <b>—</b>')) + '</div>' +
    '<input id="sl-wrongs" class="se-full" placeholder="错题号（用逗号分隔，可空）" value="' + (slNoHw ? '' : (r && r.wrongs ? esc(r.wrongs.join(',')) : (slTmpVals ? esc(slTmpVals.wrongs) : ''))) + '"' + (slNoHw ? ' disabled' : '') + '>' +
    '</div>' +
    '<div class="se-actions">' +
    '<button class="btn mint sm" onclick="saveSlot()">' + (r ? '保存修改' : '完成打卡') + '</button>' +
    '<button class="btn ghost sm" onclick="openSlot(' + slotEdit.idx + ')">取消</button>' +
    (r ? '<button class="btn danger sm" onclick="deleteSlot()">删除该次记录</button>' : '') +
    '<span style="margin-left:auto"></span>' +
    '<button class="btn ghost sm" onclick="toggleSlotNoHw()">' + (slNoHw ? '取消无作业' : '本次无作业') + '</button>' +
    '<button class="btn danger sm" onclick="markMissedToday()" ' + (slNoHw
      ? 'disabled title="无作业态下不可登记未交；如需登记请先「取消无作业」"'
      : 'title="按本表单选择的日期登记该生该科目未交，并在打卡格子中生成对应的一次（正确率 0%、错题 0）；日期留空默认今天，可补登历史日期"') + '>今日未交</button>' +
    '</div></div>';
}
/* 当次编辑实时计算 */
function slCalc(){
  const total = parseInt(document.getElementById('sl-total').value, 10);
  const correct = parseInt(document.getElementById('sl-correct').value, 10);
  const box = document.getElementById('sl-calc');
  if(!isNaN(total) && !isNaN(correct) && total>0 && correct>=0 && correct<=total){
    const a = Math.round(correct/total*100);
    box.innerHTML = '错误数 <b>' + (total-correct) + '</b>　正确率 <b style="color:' +
      (a>=85?'var(--mint-d)':(a>=60?'#B9802A':'var(--red)')) + '">' + a + '%</b>';
  } else {
    box.innerHTML = '错误数 <b>—</b>　正确率 <b>—</b>';
  }
  // 非满分时错题号必填：红框 + 必填提示，填写后自动恢复
  const w = document.getElementById('sl-wrongs');
  if(w){
    const need = !isNaN(total) && !isNaN(correct) && total>0 && correct>=0 && correct<total;
    const filled = w.value.trim().length > 0;
    if(need && !filled){
      w.style.borderColor = 'var(--red)';
      w.style.background = '#FDF1F1';
      w.placeholder = '必填：错题号（用逗号分隔）';
    } else {
      w.style.borderColor = '';
      w.style.background = '';
      w.placeholder = '错题号（用逗号分隔，可空）';
    }
  }
}
/* 保存当次打卡：有记录则更新，无记录则新增；无作业态（slNoHw）走第四次态分支（只校验日期，成绩清零） */
function saveSlot(){
  if(!slotEdit) return;
  const st0 = pool.students.find(x=>x.id===slotEdit.gid);
  if(!st0 || !canWriteOwner(st0.ownerId)){ toast('没有权限操作该数据'); return; }
  const date = document.getElementById('sl-date').value || todayStr();
  const items = subjectItems(slotEdit.gid, slotEdit.subject);
  const it = items[slotEdit.idx-1];
  const r = it && it.type==='rec' ? it.rec : null;
  const miss = it && it.type==='miss' ? it.miss : null;
  /* ---- 无作业保存：只校验日期；total/correct/wrongs 清零；正常 → 无作业转换在 toggleSlotNoHw 已确认 ---- */
  if(slNoHw){
    if(r){
      if(!canWriteOwner(r.ownerId)){ toast('没有权限操作该数据'); return; }
      r.date = date; r.total = 0; r.correct = 0; r.wrongs = []; r.noHomework = true;
      logAction('修改作业（无作业）', 'record', auditStuDesc(slotEdit.gid, slotEdit.subject), '日期 ' + date, {ownerId: r.ownerId});
      apiPersist(HttpApi.updateRecord(r.id, {date: date, total: 0, correct: 0, wrongs: [], subject: r.subject, noHomework: true}),
        rr=>{ if(rr && rr.pushed) toast('作业成绩已推送给家长'); });
    } else {
      const newRec = {id:uid(), studentId:slotEdit.gid, date:date, total:0, correct:0,
        wrongs:[], subject:slotEdit.subject, images:[], pdfs:[], ownerId:st0.ownerId, noHomework:true};
      pool.records.push(newRec);
      logAction('录入作业（无作业）', 'record', auditStuDesc(slotEdit.gid, slotEdit.subject), '日期 ' + date, {ownerId: st0.ownerId});
      apiPersist(HttpApi.addRecord({id: newRec.id, studentId: newRec.studentId, date: date, total: 0, correct: 0,
        wrongs: [], subject: newRec.subject, images: newRec.images, pdfs: newRec.pdfs, noHomework: true}),
        rr=>{ if(rr && rr.pushed) toast('作业成绩已推送给家长'); });
      // 未交格子本期不提供转无作业入口（slotEditHtml 未交分支无该按钮），此分支仅为防御
      if(miss){
        miss.resolved = true; miss.resolution = 'made-up'; miss.resolvedAt = todayStr();
        apiPersist(HttpApi.resolveMissed(miss.id));
      }
    }
    slNoHw = false; slTmpVals = null;
    slotEdit = null;
    save();
    renderAll();
    toast('已打卡：本次无作业');
    return;
  }
  const total = parseInt(document.getElementById('sl-total').value, 10);
  const correct = parseInt(document.getElementById('sl-correct').value, 10);
  if(isNaN(total) || total<=0){ toast('请填写有效的总题数'); return; }
  if(isNaN(correct) || correct<0 || correct>total){ toast('正确题目数需在 0 到总题数之间'); return; }
  const wrongs = document.getElementById('sl-wrongs').value.split(/[,，、\s]+/).map(s=>s.trim()).filter(Boolean);
  if(correct < total && wrongs.length === 0){ toast('正确题目数小于总题数，请填写错题号'); return; }
  if(r){
    if(!canWriteOwner(r.ownerId)){ toast('没有权限操作该数据'); return; }
    r.date = date; r.total = total; r.correct = correct; r.wrongs = wrongs; r.noHomework = false;  // 无作业 → 正常转换
    logAction('修改作业', 'record', auditStuDesc(slotEdit.gid, slotEdit.subject),
      '日期 ' + date + '，总 ' + total + ' 对 ' + correct + '（正确率 ' + Math.round(correct/total*100) + '%）', {ownerId: r.ownerId});
    apiPersist(HttpApi.updateRecord(r.id, {date: date, total: total, correct: correct, wrongs: wrongs, subject: r.subject, noHomework: false}),
      rr=>{ if(rr && rr.pushed) toast('作业成绩已推送给家长'); });
  } else {
    const newRec = {id:uid(), studentId:slotEdit.gid, date:date, total:total, correct:correct,
      wrongs:wrongs, subject:slotEdit.subject, images:[], pdfs:[], ownerId:st0.ownerId};
    pool.records.push(newRec);
    logAction(miss ? '补录作业' : '录入作业', 'record', auditStuDesc(slotEdit.gid, slotEdit.subject),
      '日期 ' + date + '，总 ' + total + ' 对 ' + correct + '（正确率 ' + Math.round(correct/total*100) + '%）', {ownerId: st0.ownerId});
    apiPersist(HttpApi.addRecord({id: newRec.id, studentId: newRec.studentId, date: date, total: total, correct: correct,
      wrongs: wrongs, subject: newRec.subject, images: newRec.images, pdfs: newRec.pdfs}),
      rr=>{ if(rr && rr.pushed) toast('作业成绩已推送给家长'); });  // id 客户端生成并贯穿，不再回填
    if(miss){
      miss.resolved = true; miss.resolution = 'made-up'; miss.resolvedAt = todayStr();  // 补录成功：该次未交视为已补交（留痕），不再占用打卡格子
      logAction('补交未交', 'missed', auditStuDesc(miss.studentId, miss.subject), '原未交日期 ' + miss.date, {ownerId: miss.ownerId});
      apiPersist(HttpApi.resolveMissed(miss.id));
    }
  }
  slTmpVals = null;  // 正常保存后清掉无作业切换的暂存值
  slotEdit = null;
  save();
  renderAll();
}
/* 删除当次打卡记录 */
function deleteSlot(){
  if(!slotEdit) return;
  const items = subjectItems(slotEdit.gid, slotEdit.subject);
  const it = items[slotEdit.idx-1];
  const r = it && it.type==='rec' ? it.rec : null;
  if(!r) return;
  if(!canWriteOwner(r.ownerId)){ toast('没有权限操作该数据'); return; }
    askConfirm('删除作业记录', '确定删除第 ' + slotEdit.idx + ' 次作业记录（' + r.date + '）？此操作不可恢复。', ()=>{
      pool.records = pool.records.filter(x=>x.id!==r.id);
      logAction('删除作业', 'record', auditStuDesc(slotEdit.gid, slotEdit.subject),
        '日期 ' + r.date + '，总 ' + r.total + ' 对 ' + r.correct, {ownerId: r.ownerId});
      apiPersist(HttpApi.deleteRecord(r.id));
      slotEdit = null;
      save();
      renderAll();
    });
}
