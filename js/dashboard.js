/* 数据看板与应用初始化：教务看板聚合渲染、renderAll、init（模式探测/会话恢复）、__wb 测试钩子 */
/* ================= 教务：数据看板 =================
   基于 pool 全量（上帝视角），与 topbar「数据范围」独立；仅教务可见。
   口径：录入/正确率类指标受时间范围筛选影响；逾期未交、沉睡学生为当前状态指标，不受影响。 */
let dashRange = 30;   // 7 | 30 | 90 | 0（全部），默认近 30 天
let dashOwner = 'all';
function dashRangeStart(){ return dashRange === 0 ? null : offsetDay(-(dashRange - 1)); }

/* 看板聚合数据（渲染与测试共用，避免 NaN/除零：所有均值在空数组时给 null） */
function dashAvg(recs){
  const graded = gradedRecs(recs);
  return graded.length ? Math.round(graded.reduce((s,r)=>s+acc(r),0)/graded.length) : null;
}
function buildDashIndex(){
  const index = { studentsById:new Map(), studentsByOwner:new Map(), recordsByOwner:new Map(), recordsByStudent:new Map(), recordsByDate:new Map(), missedByOwner:new Map(), missedByStudent:new Map() };
  const push = (map,key,value)=>{ if(!map.has(key)) map.set(key,[]); map.get(key).push(value); };
  pool.students.forEach(s=>{ index.studentsById.set(s.id,s); push(index.studentsByOwner,s.ownerId,s); });
  pool.records.forEach(r=>{ push(index.recordsByOwner,r.ownerId,r); push(index.recordsByStudent,r.studentId,r); push(index.recordsByDate,r.date,r); });
  pool.missed.forEach(m=>{ push(index.missedByOwner,m.ownerId,m); push(index.missedByStudent,m.studentId,m); });
  return index;
}
function computeDash(){
  const t = todayStr();
  const tas = getUsersCache().filter(u=>u.role==='ta');
  const index = buildDashIndex();
  const allOwnerRecords = dashOwner==='all' ? pool.records : (index.recordsByOwner.get(dashOwner) || []);
  const recsOwner = allOwnerRecords.filter(r=>r.date <= t);
  const start = dashRangeStart();
  const recs = start ? recsOwner.filter(r=>r.date >= start) : recsOwner;
  const missed = dashOwner==='all' ? pool.missed : (index.missedByOwner.get(dashOwner) || []);
  const students = dashOwner==='all' ? pool.students : (index.studentsByOwner.get(dashOwner) || []);
  const avgAcc = dashAvg(recs);
  const isActiveMissed = m => { const st = index.studentsById.get(m.studentId); return !(st && st.archived); };
  const openMiss = missed.filter(m=>!m.resolved && isActiveMissed(m));
  // 逾期只计算一次；助教横向对比复用同一结果，避免逐助教重复扫描
  const allOverdueSubs = [];
  pool.students.filter(s=>!s.archived && s.subjPlans).forEach(st=>{
    const studentData = { records:index.recordsByStudent.get(st.id) || [], missed:index.missedByStudent.get(st.id) || [] };
    Object.keys(st.subjPlans).forEach(sub=>{
      const info = subjectOverdueInfo(st, sub, studentData);
      if(info) allOverdueSubs.push({ refKey:st.id+'|'+sub, studentId:st.id, name:st.name, ownerId:st.ownerId, subject:sub,
        days:info.days, owed:info.owed });
    });
  });
  allOverdueSubs.sort((a,b)=>(b.days-a.days) || String(a.refKey).localeCompare(String(b.refKey)));
  const overdueSubs = allOverdueSubs.filter(x=>dashOwner==='all' || x.ownerId===dashOwner);
  const overdueCountByOwner = new Map();
  allOverdueSubs.forEach(x=>overdueCountByOwner.set(x.ownerId,(overdueCountByOwner.get(x.ownerId)||0)+1));

  // 固定近 30 天；日期索引避免每天重新扫描全量记录
  const trend = [];
  for(let i=29; i>=0; i--){
    const date = offsetDay(-i);
    const dr = (index.recordsByDate.get(date) || []).filter(r=>dashOwner==='all' || r.ownerId===dashOwner);
    trend.push({ date:date, cnt:dr.length, avg:dashAvg(dr) });
  }

  // 助教维度对比（按范围内录入次数降序；≥7 天未录入标「沉默」）
  // 最近作业日期 = records.date；最近操作时间 = 审计 ts，避免当天补录旧作业被误判为沉默
  const activityActions = new Set(['录入作业','补录作业','修改作业','登记未交','补交未交','录入作业（无作业）','修改作业（无作业）']);
  const activityRows = USE_API ? (pool.taActivity || []) : (pool.auditLogs || []).filter(l=>activityActions.has(l.action))
    .map(l=>({ownerId:l.userId,lastActionAt:l.ts}));
  const lastActionByOwner = new Map();
  activityRows.forEach(a=>{
    if(!a.ownerId || !a.lastActionAt) return;
    const prev = lastActionByOwner.get(a.ownerId);
    if(!prev || a.lastActionAt > prev) lastActionByOwner.set(a.ownerId,a.lastActionAt);
  });
  // 跨助教对比不受「助教筛选」下拉影响；时间范围过滤保留
  const taRows = tas.map(u=>{
    const ownerRecords = index.recordsByOwner.get(u.id) || [];
    const rs = ownerRecords.filter(r=>r.date <= t && (!start || r.date >= start));
    const ms = index.missedByOwner.get(u.id) || [];
    const allRs = ownerRecords.filter(r=>r.date <= t);
    const lastDate = allRs.length ? allRs.reduce((a,b)=>a.date>b.date?a:b).date : null;
    const lastActionAt = lastActionByOwner.get(u.id) || null;
    const activityDate = lastActionAt ? lastActionAt.slice(0,10) : lastDate;  // 历史无审计时向后兼容
    const stuActive = (index.studentsByOwner.get(u.id) || []).filter(s=>!s.archived);
    const activeIds = new Set(stuActive.map(s=>s.id));
    const activeRecs = allRs.filter(r=>activeIds.has(r.studentId));
    const activeMissed = ms.filter(m=>activeIds.has(m.studentId) && m.resolution!=='deleted' && m.date <= t);
    const entryStudentIds = new Set(activeRecs.concat(activeMissed).map(x=>x.studentId));
    const stuWithEntry = stuActive.filter(st=>entryStudentIds.has(st.id));
    const entryCnt = activeRecs.length + activeMissed.length;
    const planTotal = stuActive.reduce((n,st)=> n + Object.values(st.subjPlans||{}).reduce((x,y)=>x+(Number(y)||0),0), 0);
    return { user:u, stuCnt:stuActive.length,
      stuCover:stuActive.length ? Math.round(stuWithEntry.length/stuActive.length*100) : null,
      entryCover:planTotal>0 ? Math.round(entryCnt/planTotal*100) : null,
      perStu:stuWithEntry.length ? (entryCnt/stuWithEntry.length).toFixed(1) : null,
      recCnt:rs.length, avg:dashAvg(rs), missCnt:ms.filter(m=>!m.resolved).length,
      overdueCnt:overdueCountByOwner.get(u.id) || 0, lastDate:lastDate, lastActionAt:lastActionAt,
      silent:!activityDate || activityDate <= offsetDay(-7) };
  }).sort((a,b)=>b.recCnt-a.recCnt);

  const catMap = new Map(), subMapD = new Map();
  const pushGroup = (map,key,r)=>{ if(!map.has(key)) map.set(key,[]); map.get(key).push(r); };
  recs.forEach(r=>{
    const sub = r.subject || '未指定';
    const head = sub.split(' / ')[0];
    const cat = subjectTree()[head] ? head : '其他';
    pushGroup(catMap,cat,r); pushGroup(subMapD,sub,r);
  });
  const cats = Array.from(catMap, ([name,rows])=>({ name:name, cnt:rows.length, avg:dashAvg(rows),
    stuCnt:new Set(rows.map(r=>r.studentId)).size })).sort((a,b)=>b.cnt-a.cnt);
  const subs = Array.from(subMapD, ([key,rows])=>({ key:key, name:shortSubject(key), cnt:rows.length, avg:dashAvg(rows),
    stuCnt:new Set(rows.map(r=>r.studentId)).size })).sort((a,b)=>b.cnt-a.cnt);

  // 低分按 owner+同名合并，view model 同时保留稳定代表 ID 和完整科目路径
  const lowMap = {};
  recs.forEach(r=>{
    const st = index.studentsById.get(r.studentId);
    if(st && st.archived) return;
    const key = (r.ownerId||'') + '|' + (st ? st.name.trim() : r.studentId);
    (lowMap[key] = lowMap[key] || {name:st?st.name:'（已删除学生）', ownerId:r.ownerId, recs:[]}).recs.push(r);
  });
  const lowStus = Object.values(lowMap).map(g=>{
    const subA = new Map();
    const gRecs = gradedRecs(g.recs);
    gRecs.forEach(r=>pushGroup(subA,r.subject||'未指定',r));
    const rep = pool.students.find(s=>!s.archived && (s.ownerId||'')===(g.ownerId||'') && s.name.trim()===g.name.trim()) || index.studentsById.get(g.recs[0].studentId);
    return { name:g.name, ownerId:g.ownerId, studentId:rep ? rep.id : g.recs[0].studentId, avg:dashAvg(gRecs),
      lowSubs:Array.from(subA, ([key,rows])=>({ key:key, name:shortSubject(key), avg:dashAvg(rows) }))
        .filter(x=>x.avg<60).sort((a,b)=>a.avg-b.avg || String(a.key).localeCompare(String(b.key))) };
  }).filter(g=>g.avg !== null && g.avg<60).sort((a,b)=>a.avg-b.avg || String(a.studentId).localeCompare(String(b.studentId)));

  const firstTimers = [];
  const sleepers = students.filter(s=>!s.archived).map(s=>{
    const rs = (index.recordsByStudent.get(s.id) || []).filter(r=>r.date <= t);
    const last = rs.length ? rs.reduce((a,b)=>a.date>b.date?a:b).date : null;
    return { studentId:s.id, name:s.name, ownerId:s.ownerId, last:last,
      days:last ? Math.round((new Date(t)-new Date(last))/86400000) : null, _fc:s.subjFirstClass || {} };
  }).filter(x=>{
    if(x.days !== null) return x.days >= 7;
    const fcs = Object.values(x._fc).filter(Boolean);
    if(fcs.length && fcs.every(date=>date > t)) return false;
    firstTimers.push(x);
    return false;
  }).sort((a,b)=>(b.days-a.days) || String(a.studentId).localeCompare(String(b.studentId)));

  const ownersWithRecs = new Set(recs.map(r=>r.ownerId));
  return { recCnt:recs.length, avgAcc:avgAcc,
    todayRecs:recsOwner.filter(r=>r.date===t).length,
    activeStu:students.filter(s=>!s.archived).length,
    archivedStu:students.filter(s=>s.archived).length,
    missCnt:openMiss.length, overdueCnt:overdueSubs.length,
    taWithRecs:tas.filter(u=>ownersWithRecs.has(u.id)).length, taTotal:tas.length,
    trend:trend, taRows:taRows, cats:cats, subs:subs,
    lowStus:lowStus, overdueList:overdueSubs, sleepers:sleepers, firstTimers:firstTimers };
}

let dashAlertPage = {}, dashAlertPageSize = {}, dashTrendTable = false;
let dashSubjectQuery = '', dashSubjectSort = 'cnt', dashSubjectPage = 1, dashSubjectPageSize = 20;
let dashReturnContext = null, dashLastData = null, dashOverviewKey = '';
function renderDashboard(scope){
  const boxes = ['dash-overview','dash-trend','dash-tas','dash-cats','dash-subs','dash-alert-low','dash-alert-miss','dash-alert-sleep'];
  // 助教守卫：入口不渲染，直接切到 pane-dashboard 也不产出内容
  if(!isAdminView()){
    boxes.forEach(id=>{ const el = document.getElementById(id); if(el) el.innerHTML = ''; });
    return;
  }
  const d = computeDash();
  dashLastData = d;
  const showAll = !scope || scope === 'all';
  const show = key => showAll || (Array.isArray(scope) && scope.includes(key));
  if(show('filters')){
    // 筛选条：助教下拉 + 时间范围按钮态
    const sel = document.getElementById('dash-owner');
    const tas = getUsersCache().filter(u=>u.role==='ta');
    sel.innerHTML = '<option value="all">全部助教</option>' +
      tas.map(u=>'<option value="' + esc(u.id) + '">' + esc(u.name) + (u.disabled ? '（已停用）' : '') + '</option>').join('');
    sel.value = dashOwner;
    document.querySelectorAll('#dash-range .role-opt').forEach(b=>b.classList.toggle('active', parseInt(b.dataset.range,10)===dashRange));
    const current = document.getElementById('dash-current');
    if(current) current.textContent = '当前：' + (dashOwner==='all' ? '全部助教' : ownerName(dashOwner)) + ' · ' + (dashRange===0 ? '截至今天的全部历史' : '近 ' + dashRange + ' 天');
    const reset = document.getElementById('dash-owner-reset');
    if(reset) reset.style.display = dashOwner==='all' ? 'none' : '';
  }

  // 1. 全局概览卡（学生拆两张：在服务 / 已归档）
  if(show('overview')){
    document.getElementById('dash-overview').innerHTML =
      '<div class="quick"><div class="num">' + d.activeStu + '</div><div class="lbl">在服务学生</div></div>' +
      '<div class="quick"><div class="num">' + d.archivedStu + '</div><div class="lbl">已归档学生</div></div>' +
      '<div class="quick"><div class="num">' + d.recCnt + '</div><div class="lbl">范围内录入次数</div></div>' +
      '<div class="quick"><div class="num">' + (d.avgAcc===null?'—':d.avgAcc+'%') + '</div><div class="lbl">范围内平均正确率</div></div>' +
      '<div class="quick"><div class="num" style="color:' + (d.missCnt?'var(--red)':'var(--mint-d)') + '">' + d.missCnt + '</div><div class="lbl">未交次数</div></div>' +
      '<div class="quick"><div class="num" style="color:' + (d.overdueCnt?'var(--red)':'var(--mint-d)') + '">' + d.overdueCnt + '</div><div class="lbl">逾期科目</div></div>' +
      '<div class="quick" style="cursor:pointer" onclick="openTaEntryModal()" title="点击查看助教录入明细"><div class="num">' + d.taWithRecs + '/' + d.taTotal + ' <span style="font-size:14px;color:var(--ink2)">›</span></div><div class="lbl">有录入助教/助教总数</div></div>' +
      '<div class="quick"><div class="num">' + d.todayRecs + '</div><div class="lbl">今日已录入</div></div>';
    const overviewKey = [d.activeStu,d.archivedStu,d.recCnt,d.avgAcc,d.missCnt,d.overdueCnt,d.taWithRecs,d.taTotal,d.todayRecs].join('|');
    if(overviewKey !== dashOverviewKey) animateNums(document.getElementById('dash-overview'));  // 仅首次或指标变化时滚动
    dashOverviewKey = overviewKey;
  }

  // 固定近 30 天；柱子与数据表同时提供日期、次数和均分，不依赖颜色或 hover
  const maxCnt = d.trend.reduce((m,x)=>Math.max(m,x.cnt),0);
  const chartHtml = maxCnt === 0 ? '<p class="hint">近 30 天暂无录入。</p>' : '<div class="dash-trend-bars">' + d.trend.map(x=>{
    const color = x.avg===null ? '#D5DDE5' : (x.avg>=85?'#4FA88B':(x.avg>=60?'#C7A75E':'#C95353'));
    const h = Math.max(2,Math.round(x.cnt/maxCnt*80));
    const isFirst = x.date.slice(8)==='01', isToday = x.date===todayStr();
    const label = x.date + '，录入 ' + x.cnt + ' 次，平均正确率 ' + (x.avg===null?'无评分':x.avg+'%');
    // 每列预留同高标签轨道，柱体只在轨道内向上生长，避免有标签的列被抬高
    return '<div class="dash-bar-col" tabindex="0" role="img" aria-label="' + esc(label) + '" title="' + esc(label) + '">' +
      '<div class="dash-bar-track"><div class="dash-bar" style="height:' + h + 'px;background:' + color + '"></div></div>' +
      '<div class="dash-bar-lbl">' + ((isFirst||isToday) ? (isToday?'今天':x.date.slice(5)) : '') + '</div></div>';
  }).join('') + '</div>';
  const trendTable = dashTrendTable ? '<div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>日期</th><th>录入次数</th><th>平均正确率</th></tr></thead><tbody>' +
    d.trend.map(x=>'<tr><td>' + x.date + '</td><td>' + x.cnt + '</td><td>' + (x.avg===null?'—':x.avg+'%') + '</td></tr>').join('') +
    '</tbody></table></div>' : '';
  if(show('trend')) document.getElementById('dash-trend').innerHTML = chartHtml +
    '<button type="button" class="btn ghost sm dash-trend-toggle" aria-expanded="' + dashTrendTable + '" onclick="dashToggleTrendTable()">' +
    (dashTrendTable?'收起':'查看') + '30 天数据表</button>' + trendTable;

  // 3. 助教维度对比（点击行下钻）
  const maxTa = d.taRows.reduce((m,x)=>Math.max(m,x.recCnt),0);
  if(show('tas')){
  document.getElementById('dash-tas').innerHTML = d.taRows.length ? d.taRows.map(x=>
    '<button type="button" class="dash-ta-row' + (dashOwner===x.user.id?' active':'') + '" data-ta-id="' + esc(x.user.id) + '"' +
    ' aria-pressed="' + (dashOwner===x.user.id?'true':'false') + '" onclick="dashDrillTa(\'' + esc(jsStr(x.user.id)) + '\')" title="点击下钻到该助教">' +
    '<span class="grow"><b>' + esc(x.user.name) + '</b>' +
    (x.user.disabled ? ' <span class="tag red">已停用</span>' : '') +
    (x.silent ? ' <span class="tag amber">沉默</span>' : '') +
    '<span class="hint" style="display:block;margin-top:2px">学生 ' + x.stuCnt + ' 人 · 最近作业日期 ' + (x.lastDate || '从未') + '</span>' +
    '<span class="hint" style="display:block;margin-top:2px">最近操作时间 ' + (x.lastActionAt ? x.lastActionAt.slice(0,16) : '无记录') + '</span>' +
    // 当前在服务覆盖指标：学生覆盖率 / 作业录入覆盖率 / 人均录入次数（实际录入含未交+补交两次行为）
    '<span class="hint" style="display:block;margin-top:2px;font-size:12px">学生覆盖 ' + (x.stuCover===null?'—':x.stuCover+'%') +
    ' · 录入覆盖 ' + (x.entryCover===null?'—':x.entryCover+'%') +
    ' · 人均 ' + (x.perStu===null?'—':x.perStu) + ' 次<span style="opacity:.7">（当前在服务 · 截至今天）</span></span></span>' +
    '<span class="dash-ta-bar"><span class="dash-ta-fill" style="width:' + (maxTa ? Math.round(x.recCnt/maxTa*100) : 0) + '%"></span></span>' +
    '<span class="dash-ta-num">录入 ' + x.recCnt + ' 次</span>' +
    (x.avg===null
      ? '<span class="acc-badge" style="background:var(--cream2);color:var(--ink2)">未录入</span>'
      : '<span class="acc-badge ' + accClass(x.avg) + '">' + x.avg + '%</span>') +
    '<span class="dash-ta-num">未交 ' + x.missCnt + (x.overdueCnt ? ' · 逾期科目 <b style="color:var(--red)">' + x.overdueCnt + '</b>' : '') + '</span>' +
    '</button>').join('') : '<p class="hint">暂无助教账号。</p>';
  const taCurrent = document.getElementById('dash-ta-current');
  if(taCurrent){
    if(dashOwner === 'all'){ taCurrent.style.display = 'none'; taCurrent.innerHTML = ''; }
    else {
      const cu = getUsersCache().find(u=>u.id===dashOwner);
      taCurrent.style.display = '';
      taCurrent.innerHTML = '正在查看 <b>' + esc(cu ? cu.name : ownerName(dashOwner)) + '</b>' +
        '<button type="button" class="btn ghost sm" onclick="dashResetOwner()">返回全部助教</button>';
    }
  }
  }

  // 4. 学科维度：一级类目行 + 具体科目条形（复用 subj-row，含 60% 关注线）
  if(show('cats')) document.getElementById('dash-cats').innerHTML = d.cats.length ? d.cats.map(c=>
    '<div class="dash-cat-row"><span class="cat-name">' + esc(c.name) + '</span>' +
    '<span>记录 <b>' + c.cnt + '</b> 次</span>' +
    '<span>平均正确率 <b style="color:' + (c.avg===null?'var(--ink2)':(c.avg>=85?'var(--mint-d)':(c.avg>=60?'#B9802A':'var(--red)'))) + '">' + (c.avg===null?'—（均无作业）':c.avg + '%') + '</b></span>' +
    '<span>涉及学生 <b>' + c.stuCnt + '</b> 人</span></div>').join('')
    : '<p class="hint">范围内暂无作业记录。</p>';
  if(show('subs')){
    const subjectControls = '<div class="today-filter dash-sub-filter"><input id="dash-subject-search" class="today-search" value="' + esc(dashSubjectQuery) + '" placeholder="搜索完整科目路径或短名" aria-label="搜索科目" oninput="dashSubjectSearchSet(this.value)">' +
      '<select id="dash-subject-sort" aria-label="科目排序" onchange="dashSubjectSortSet(this.value)">' +
      '<option value="cnt"' + (dashSubjectSort==='cnt'?' selected':'') + '>按记录数降序</option>' +
      '<option value="avg"' + (dashSubjectSort==='avg'?' selected':'') + '>按平均正确率降序</option>' +
      '<option value="stuCnt"' + (dashSubjectSort==='stuCnt'?' selected':'') + '>按学生数降序</option>' +
      '<option value="name"' + (dashSubjectSort==='name'?' selected':'') + '>按完整路径升序</option></select>' +
      '<button type="button" class="btn ghost sm" id="dash-subject-clear" onclick="dashSubjectClear()" style="display:none">清除条件</button></div>';
    document.getElementById('dash-subs').innerHTML = subjectControls + '<div id="dash-subject-results"></div>';
    renderSubjectResults(d);
  }

  // 摘要前 5 条；展开后只渲染完整名单的当前页，待首录同样分页
  const alertPager = (key,items)=>{
    const page = pagedRows(items,dashAlertPage[key],dashAlertPageSize[key]);
    dashAlertPage[key] = page.page; dashAlertPageSize[key] = page.pageSize;
    const html = '<div class="today-pager dash-alert-pager"><span class="pager-meta">第 ' + page.start + '–' + page.end + ' 条 / 共 ' + page.total + ' 条</span>' +
      '<label>每页 <select id="dash-alert-size-' + key + '" onchange="dashAlertPageSizeSet(\'' + key + '\',this.value)">' +
      '<option value="20"' + (page.pageSize===20?' selected':'') + '>20</option><option value="50"' + (page.pageSize===50?' selected':'') + '>50</option></select> 条</label>' +
      '<button type="button" class="btn ghost sm" onclick="dashAlertPageGo(\'' + key + '\',-1)"' + (page.page<=1?' disabled':'') + '>上一页</button>' +
      '<span class="pager-page">第 ' + page.page + ' / ' + page.pages + ' 页</span>' +
      '<button type="button" class="btn ghost sm" onclick="dashAlertPageGo(\'' + key + '\',1)"' + (page.page>=page.pages?' disabled':'') + '>下一页</button></div>';
    return { rows:page.rows, html:html };
  };
  const renderAlertList = (items,key,emptyText,renderItem)=>{
    if(!items.length) return '<p class="hint">' + emptyText + '</p>';
    const expanded = !!dashAlertExpand[key];
    let h = '<div class="dash-alert-total">共 ' + items.length + ' 条</div>';
    if(expanded){
      const page = alertPager(key,items);
      h += page.rows.map(renderItem).join('') + page.html;
    } else {
      h += items.slice(0,5).map(renderItem).join('');
    }
    if(items.length>5) h += '<button type="button" class="btn ghost sm dash-alert-toggle" onclick="dashToggleAlert(\'' + key + '\')">' + (expanded?'收起':'展开全部 ' + items.length + ' 条') + '</button>';
    return h;
  };
  if(show('alerts')) document.getElementById('dash-alert-low').innerHTML = renderAlertList(d.lowStus,'low','范围内没有低分学生。',g=>{
    const subject = g.lowSubs.length ? g.lowSubs[0].key : '';
    return '<button class="dash-alert-item" onclick="dashGotoStudent(\'' + esc(jsStr(g.studentId)) + '\',\'' + esc(jsStr(subject)) + '\')">' +
      '<b>' + esc(g.name) + '</b> <span class="tag red">' + g.avg + '%</span>' +
      '<div class="meta">归属 ' + esc(ownerName(g.ownerId)) +
      (g.lowSubs.length ? ' · 低分科目：' + g.lowSubs.map(s=>esc(s.name)+' '+s.avg+'%').join('、') : '') + '</div></button>';
  });
  if(show('alerts')) document.getElementById('dash-alert-miss').innerHTML = renderAlertList(d.overdueList,'miss','没有逾期科目。',x=>
    '<button class="dash-alert-item" onclick="dashGotoStudent(\'' + esc(jsStr(x.studentId)) + '\',\'' + esc(jsStr(x.subject)) + '\')">' +
    '<b>' + esc(x.name) + '</b> <span class="tag red">欠 ' + x.owed + ' 次 · ' + x.days + ' 天没动静</span>' +
    '<div class="meta">归属 ' + esc(ownerName(x.ownerId)) + ' · ' + esc(shortSubject(x.subject)) + '</div></button>');
  let firstHtml = '';
  if(d.firstTimers.length){
    firstHtml = '<button type="button" class="btn ghost sm dash-first-toggle" onclick="dashToggleAlert(\'first\')">待首录 ' + d.firstTimers.length + ' 人（从未有作业记录）' + (dashAlertExpand.first?' ▾':' ▸') + '</button>';
    if(dashAlertExpand.first){
      const page = alertPager('first',d.firstTimers);
      firstHtml += page.rows.map(x=>'<button class="dash-alert-item dash-first-item" onclick="dashGotoStudent(\'' + esc(jsStr(x.studentId)) + '\')">' +
        '<b>' + esc(x.name) + '</b><div class="meta">归属 ' + esc(ownerName(x.ownerId)) + '</div></button>').join('') + page.html;
    }
  }
  if(show('alerts')) document.getElementById('dash-alert-sleep').innerHTML = renderAlertList(d.sleepers,'sleep','没有沉睡学生。',x=>
    '<button class="dash-alert-item" onclick="dashGotoStudent(\'' + esc(jsStr(x.studentId)) + '\')">' +
    '<b>' + esc(x.name) + '</b> <span class="tag amber">' + x.days + ' 天无记录</span>' +
    '<div class="meta">归属 ' + esc(ownerName(x.ownerId)) + '</div></button>') + firstHtml;
}
/* 学科结果区独立渲染：输入/翻页时只换结果，不重建搜索框与光标 */
function renderSubjectResults(d){
  const data = d || dashLastData;
  const box = document.getElementById('dash-subject-results');
  if(!data || !box) return;
  const subjectQuery = dashSubjectQuery.trim().toLowerCase();
  let subjectRows = data.subs.filter(x=>!subjectQuery || (x.key+' '+x.name).toLowerCase().indexOf(subjectQuery)!==-1);
  subjectRows = subjectRows.slice().sort((a,b)=>{
    if(dashSubjectSort==='name') return a.key.localeCompare(b.key);
    const field = dashSubjectSort==='avg' ? 'avg' : (dashSubjectSort==='stuCnt' ? 'stuCnt' : 'cnt');
    const av = a[field]===null ? -1 : a[field], bv = b[field]===null ? -1 : b[field];
    return bv-av || a.key.localeCompare(b.key);
  });
  const page = pagedRows(subjectRows,dashSubjectPage,dashSubjectPageSize);
  dashSubjectPage = page.page; dashSubjectPageSize = page.pageSize;
  const rowsHtml = page.rows.map(x=>{
    const color = x.avg===null ? '#C9C2B0' : (x.avg>=85?'#4FA88B':(x.avg>=60?'#C7A75E':'#C95353'));
    return '<div class="subj-row dash-subject-row" data-subject-key="' + esc(x.key) + '">' +
      '<div class="subj-name' + (x.avg!==null && x.avg<60?' low':'') + '" title="' + esc(x.key) + '">' + esc(x.name) + '</div>' +
      '<div class="subj-bar"><div class="subj-fill" style="width:' + (x.avg===null?0:x.avg) + '%;background:' + color + '"></div></div>' +
      '<div class="subj-pct">' + (x.avg===null?'—':x.avg+'%') + '</div>' +
      '<div class="subj-cnt">' + x.cnt + ' 次 · ' + x.stuCnt + ' 人</div></div>';
  }).join('');
  const guide = '<div class="dash-subject-guide"><span>平均正确率</span><span><i class="dash-ref-60"></i>60% 关注线 <i class="dash-ref-85"></i>85% 优秀线</span></div>';
  const pager = '<div class="today-pager dash-sub-pager"><span class="pager-meta">第 ' + page.start + '–' + page.end + ' 科 / 共 ' + page.total + ' 科</span>' +
    '<label>每页 <select id="dash-subject-size" onchange="dashSubjectPageSizeSet(this.value)"><option value="20"' + (page.pageSize===20?' selected':'') + '>20</option>' +
    '<option value="50"' + (page.pageSize===50?' selected':'') + '>50</option></select> 科</label>' +
    '<button type="button" class="btn ghost sm" onclick="dashSubjectPageGo(-1)"' + (page.page<=1?' disabled':'') + '>上一页</button>' +
    '<span class="pager-page">第 ' + page.page + ' / ' + page.pages + ' 页</span>' +
    '<button type="button" class="btn ghost sm" onclick="dashSubjectPageGo(1)"' + (page.page>=page.pages?' disabled':'') + '>下一页</button></div>';
  box.innerHTML = (page.rows.length ? '<div class="dash-subject-list">' + guide + rowsHtml + '</div>' : '<p class="hint">没有符合条件的科目。</p>') + pager;
  const clear = document.getElementById('dash-subject-clear');
  if(clear) clear.style.display = (subjectQuery || dashSubjectSort!=='cnt') ? '' : 'none';
}
let dashAlertExpand = { low:false, miss:false, sleep:false, first:false };
// 局部操作只重绘目标区块：不重建概览数字、不丢学科搜索光标
function dashToggleAlert(key){ dashAlertExpand[key] = !dashAlertExpand[key]; renderDashboard(['alerts']); }
function dashAlertPageGo(key,delta){ dashAlertPage[key] = (dashAlertPage[key]||1)+delta; renderDashboard(['alerts']); }
function dashAlertPageSizeSet(key,value){ dashAlertPageSize[key] = parseInt(value,10)===50?50:20; dashAlertPage[key]=1; renderDashboard(['alerts']); }
function dashToggleTrendTable(){ dashTrendTable = !dashTrendTable; renderDashboard(['trend']); }
function dashSubjectSearchSet(value){ dashSubjectQuery=value; dashSubjectPage=1; renderSubjectResults(); }
function dashSubjectSortSet(value){ dashSubjectSort=value; dashSubjectPage=1; renderSubjectResults(); }
function dashSubjectPageGo(delta){ dashSubjectPage+=delta; renderSubjectResults(); }
function dashSubjectPageSizeSet(value){ dashSubjectPageSize=parseInt(value,10)===50?50:20; dashSubjectPage=1; renderSubjectResults(); }
function dashSubjectClear(){
  dashSubjectQuery=''; dashSubjectSort='cnt'; dashSubjectPage=1;
  const inp = document.getElementById('dash-subject-search'); if(inp) inp.value = '';
  const sort = document.getElementById('dash-subject-sort'); if(sort) sort.value = 'cnt';
  renderSubjectResults();
}
function dashResetOwner(){ dashOwner='all'; renderDashboard(); }
function dashGotoStudent(studentId, subject){
  const st = pool.students.find(s=>s.id===studentId);
  const name = st ? st.name : studentId;
  dashReturnContext = { scrollY:typeof window.scrollY==='number' ? window.scrollY : 0 };
  switchTab('stats');
  stuQuery = name;
  stuTaFilter = st ? st.ownerId : 'all';
  const inp = document.getElementById('stu-search');
  if(inp) inp.value = name;
  const rep = st ? pool.students.find(s=>!s.archived && (s.ownerId||'')===(st.ownerId||'') && s.name.trim()===st.name.trim()) || st : null;
  // 预警定位必须打开右侧档案；清理旧编辑态但不清草稿
  stuSelectedId = rep ? rep.id : null;
  slotEdit = null; mockEdit = null; addSubjGid = null;
  quickEntry = rep && subject ? {gid:rep.id,subject:subject} : null;
  renderStats();
  const btn = document.getElementById('dash-return-btn');
  if(btn) btn.style.display = '';
}
function dashReturnDashboard(){
  switchTab('dashboard');
  const btn = document.getElementById('dash-return-btn');
  if(btn) btn.style.display = 'none';
  renderDashboard();
  const top = dashReturnContext ? dashReturnContext.scrollY : 0;
  dashReturnContext = null;
  const restore = ()=>window.scrollTo({top:top,behavior:'auto'});
  if(typeof requestAnimationFrame==='function') requestAnimationFrame(restore); else restore();
}
/* 助教行下钻：再点同一行返回全部助教 */
function dashDrillTa(id){
  dashOwner = (dashOwner === id) ? 'all' : id;
  renderDashboard();
  // 重绘后把焦点还给同一助教入口，键盘用户不会丢失位置
  if(typeof document.querySelectorAll === 'function'){
    const row = Array.from(document.querySelectorAll('#dash-tas [data-ta-id]')).find(el=>el.dataset.taId===id);
    if(row && row.focus) row.focus();
  }
}
document.querySelectorAll('#dash-range .role-opt').forEach(b=>b.addEventListener('click', ()=>{
  dashRange = parseInt(b.dataset.range, 10);
  renderDashboard();
}));
document.getElementById('dash-owner').addEventListener('change', function(){
  dashOwner = this.value;
  renderDashboard();
});

/* ================= 看板「有录入助教」明细弹窗（v1.5.7） =================
   点击全局概览卡弹出：范围内未录入的助教排前（红标「未录入」+ 最近录入日期或「从未」+ 沉默标记），
   有录入的绿标 + 次数 + 最近日期；数据复用 computeDash 的 taRows，跟随当前时间范围/助教筛选 */
function openTaEntryModal(){
  const d = computeDash();
  const rows = (d.taRows || []).slice().sort((a,b)=> (a.recCnt===0?0:1)-(b.recCnt===0?0:1) || (b.recCnt-a.recCnt));
  const noneCnt = rows.filter(x=>x.recCnt===0).length;
  document.getElementById('ta-entry-list').innerHTML =
    (rows.length && noneCnt===0 ? '<p class="hint" style="margin:0 0 10px">范围内全部助教均有录入。</p>' : '') +
    rows.map(x=>{
      const none = x.recCnt===0;
      return '<div class="acct-row"><div class="grow"><b>' + esc(x.user.name) + '</b> ' +
        (none ? '<span class="tag red">未录入</span>' : '<span class="tag mint">已录入 ' + x.recCnt + ' 次</span>') +
        (x.silent ? ' <span class="tag amber">≥7 天沉默</span>' : '') +
        (x.user.disabled ? ' <span class="tag red">已停用</span>' : '') +
        '<div class="hint" style="margin-top:2px">最近作业日期：' + (x.lastDate || '从未') + ' · 最近操作时间：' + (x.lastActionAt ? x.lastActionAt.slice(0,16) : '无记录') + '</div></div></div>';
    }).join('') || '<p class="hint">暂无助教账号。</p>';
  document.getElementById('ta-entry-modal').classList.add('show');
}

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
  refreshHomeworkCycle();   // 全局作业周期（全角色读取；仅教务可改，内部含展示守卫）
  renderDashboard();  // 内部含教务守卫，助教端自动清空看板内容
  renderAudit();      // 内部含角色守卫（销售/未登录不产出）
  renderSubjectMgmt();  // 科目管理卡片（内部含教务守卫）
  renderPendingBadges();  // 待审批红点（仅教务显示）
}
document.getElementById('today-str').textContent =
  todayStr() + ' · ' + ['周日','周一','周二','周三','周四','周五','周六'][new Date().getDay()];

window.__ready = (async function init(){
  USE_API = await detectApi();  // 同 origin 探测到后端（200 + JSON 服务标识）→ API 模式；否则 mock 演示模式
  // v1.8.3 ENG-03：生产域名下探测失败 → 明确错误页 + 重试按钮，阻止进入可编辑演示模式（防数据来源/保存位置静默切换）
  if(!USE_API && isProdHost()){ showApiOutage(); return; }
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

/* v1.8.3 ENG-03：生产站后端故障阻断页——显示错误横幅 + 重试按钮，隐藏登录卡（不回落演示数据） */
function showApiOutage(){
  const o = document.getElementById('api-outage');
  if(o) o.style.display = 'flex';
  const lc = document.querySelector('.login-card');
  if(lc) lc.style.display = 'none';
  const ls = document.getElementById('login-screen');
  if(ls) ls.style.display = 'flex';
}

/* 测试钩子：供 node DOM 桩冒烟测试访问内部状态（不影响 UI） */
window.__wb = {
  Api, HttpApi, LocalApi,
  get USE_API(){ return USE_API; },
  setUseApi(v){ USE_API = v; apiImpl = v ? HttpApi : LocalApi; },  // 测试用：强制切换模式
  detectApi, isProdHost, showApiOutage,
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
  subjectOverdue, subjectOverdueInfo, unresolvedMissCount, addDays, editFirstClass, saveFirstClass, openMissSubjectPicker, confirmMissSubject,
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
