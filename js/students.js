/* 学生侧业务：今日概览、科目树数据源、学生统计与图表、销售端只读视图、作业录入打卡、计划次数审批申请 */
/* ================= 今日概览任务中心 =================
   三组预警按优先级排列：未交 > 逾期 > 正确率偏低；
   未交 = 登记了「未交」的作业（永久未交，不再随时间升级）；逾期 = 科目级欠账（已开课 + 欠 N 次 + 超过作业周期没动静，原「计划停滞」合并进来）；
   全量聚合后按各组独立条件筛选、稳定排序，仅渲染当前页；分段固定显示全量计数。
   行操作：查看记录（跳该生该科目打卡面板）/ 稍后处理（snooze 当天有效，明天再出现）/ 完成（done，进已处理事项）。
   未交行的完成路径 = 去补录（现有补录流），删除未交保留；归档学生不进任何分组。
   教务视角：未交只读（无补录/删除），但允许稍后处理/完成（管理职责）。 */
let todayExpandKey = null;
let todayTaFilter = {};
let todayQuery = {}, todayPage = {}, todayPageSize = {};
let todayActionPending = {}, todayShelveDraft = {};
function pagedRows(rows, page, pageSize){
  const size = pageSize===50 ? 50 : 20;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(pages, Math.max(1, parseInt(page,10) || 1));
  const startIndex = (current-1) * size;
  return { rows:rows.slice(startIndex,startIndex+size), page:current, pageSize:size, pages:pages,
    total:rows.length, start:rows.length ? startIndex+1 : 0, end:Math.min(rows.length,startIndex+size) };
}
function restoreInputFocus(id){
  const el = document.getElementById(id);
  if(!el || !el.focus) return;
  el.focus();
  if(el.setSelectionRange){ const end = String(el.value || '').length; el.setSelectionRange(end,end); }
}
function todayTaSet(key, oid){ todayTaFilter[key] = oid; todayPage[key] = 1; renderToday(); }
function todaySearchSet(key, value){
  todayQuery[key] = value; todayPage[key] = 1; renderToday(); restoreInputFocus('today-search-' + key);
}
function todayPageGo(key, delta){ todayPage[key] = (todayPage[key] || 1) + delta; renderToday(); }
function todayPageSizeSet(key, value){ todayPageSize[key] = parseInt(value,10)===50 ? 50 : 20; todayPage[key] = 1; renderToday(); }
function todayClearFilters(key){
  delete todayTaFilter[key]; delete todayQuery[key]; todayPage[key] = 1; renderToday();
}
// 同一 ref_key 取最新一条预警动作
function alertActionMap(){
  const map = {};
  (state.alertActions || []).forEach(a=>{ map[a.kind + '|' + a.refKey] = a; });
  return map;
}
function isDoneAlert(amap, kind, refKey){ const a = amap[kind + '|' + refKey]; return !!(a && (a.action==='done' || a.action==='shelve')); }
function snoozedToday(amap, kind, refKey){
  const a = amap[kind + '|' + refKey];
  return !!(a && a.action==='snooze' && a.snoozeUntil && a.snoozeUntil >= todayStr());
}
function snoozeBadgeHtml(amap, kind, refKey){
  const a = amap[kind + '|' + refKey];
  return (a && a.action==='snooze' && a.snoozeUntil && a.snoozeUntil >= todayStr())
    ? '<span class="tag amber">稍后至 ' + esc(a.snoozeUntil) + '</span>' : '';
}
async function submitAlertAction(kind, refKey, action, note){
  const pendingKey = action + '|' + kind + '|' + refKey;
  if(todayActionPending[pendingKey]){ toast('正在提交，请稍候'); return false; }
  todayActionPending[pendingKey] = true;
  try{
    const body = { kind:kind, refKey:refKey, action:action };
    if(action==='snooze') body.snoozeUntil = todayStr();
    if(action==='shelve') body.note = note || '';
    const res = await HttpApi._req('POST', '/api/alerts/action', body);
    if(!res.ok){ toast(res.msg || '操作失败，请重试'); return false; }
    await resyncState();
    return true;
  }catch(e){
    toast('操作失败，请检查网络后重试');
    return false;
  }finally{
    delete todayActionPending[pendingKey];
    renderAll();
  }
}
async function alertSnooze(kind, refKey){
  if(USE_API){
    if(await submitAlertAction(kind,refKey,'snooze','')) toast('已稍后处理，明天再提醒您');
    return;
  }
  const a = { id: uid(), kind: kind, refKey: refKey, action: 'snooze',
    actorId: currentUser ? currentUser.id : null, actorName: currentUser ? currentUser.name : '',
    note: '', createdAt: new Date().toISOString(), snoozeUntil: todayStr() };
  pool.alertActions = pool.alertActions || [];
  pool.alertActions.push(a);
  save(); refreshView();
  toast('已稍后处理，明天再提醒您');
  renderAll();
}
function alertDone(kind, refKey){
  askConfirm('完成该预警', '完成后该预警不再出现在待办，可在下方「已处理事项」中回溯。确定已完成处理吗？', async ()=>{
    if(USE_API){
      if(await submitAlertAction(kind,refKey,'done','')) toast('已完成处理');
      return;
    }
    const a = { id: uid(), kind: kind, refKey: refKey, action: 'done',
      actorId: currentUser ? currentUser.id : null, actorName: currentUser ? currentUser.name : '',
      note: '', createdAt: new Date().toISOString(), snoozeUntil: null };
    pool.alertActions = pool.alertActions || [];
    pool.alertActions.push(a);
    save(); refreshView();
    toast('已完成处理');
    renderAll();
  });
}
function alertShelve(missId){
  askConfirm('搁置该未交项', '用于家长侧等暂不可控的情况。搁置后不再出现在待办，可在「已处理事项」查看；未交记录本身保留，补录成绩后自然关闭。确定搁置吗？', async (note)=>{
    const reason = (note || '').trim();
    todayShelveDraft[missId] = reason;
    if(USE_API){
      if(await submitAlertAction('miss',missId,'shelve',reason)){
        delete todayShelveDraft[missId];
        toast('已搁置，可在已处理事项查看');
      } else {
        alertShelve(missId);
      }
      return;
    }
    const a = { id: uid(), kind: 'miss', refKey: missId, action: 'shelve',
      actorId: currentUser ? currentUser.id : null, actorName: currentUser ? currentUser.name : '',
      note: reason, createdAt: new Date().toISOString(), snoozeUntil: null };
    pool.alertActions = pool.alertActions || [];
    pool.alertActions.push(a);
    delete todayShelveDraft[missId];
    save(); refreshView();
    toast('已搁置，可在已处理事项查看');
    renderAll();
  }, { input: '搁置原因（选填，如：家长暂停课程）' });
  if(todayShelveDraft[missId] !== undefined) document.getElementById('cf-input').value = todayShelveDraft[missId];
}
function todayCatGo(key){
  todayExpandKey = key;
  renderToday();
  const el = document.getElementById('today-grp-' + key);
  if(el && el.scrollIntoView) el.scrollIntoView({ block:'start', behavior:'smooth' });
}
function renderToday(){
  const list = document.getElementById('today-list');
  const catsEl = document.getElementById('today-cats');
  const t = todayStr();
  const amap = alertActionMap();
  const admin = isAdminView();

  const missRows = [];
  state.missed.filter(m=>!m.resolved).forEach(m=>{
    const st = state.students.find(x=>x.id===m.studentId);
    if(st && st.archived) return;
    const fc = m.subject && st && st.subjFirstClass && st.subjFirstClass[m.subject];
    if(fc && fc > t) return;
    if(isDoneAlert(amap, 'miss', m.id) || snoozedToday(amap, 'miss', m.id)) return;
    missRows.push(m);
  });

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
  lowRows.forEach((x,i)=>{ x.order = i; });

  const overdueRows = [];
  state.students.filter(s=>!s.archived && s.subjPlans).forEach(st=>{
    Object.keys(st.subjPlans).forEach(sub=>{
      const info = subjectOverdueInfo(st, sub);
      if(!info) return;
      const refKey = st.id + '|' + sub;
      if(isDoneAlert(amap, 'planStall', refKey) || snoozedToday(amap, 'planStall', refKey)) return;
      overdueRows.push({ st: st, sub: sub, days: info.days, owed: info.owed, refKey: refKey });
    });
  });

  // ---- 行渲染 ----
  // 未交行（v1.9.0）：徽章「未交 · 已 N 天」（当天登记显示「今天登记」）；出清路径 = 补录 / 删除 / 搁置
  const renderMissRow = m => {
    const mDays = Math.max(0, Math.round((new Date(t) - new Date(m.date)) / 86400000));
    return '<div class="todo-item">' +
    '<div class="grow"><span class="who">' + esc(stuName(m.studentId)) + '</span>' +
    '<span class="tag mint">' + esc(shortSubject(m.subject || '未指定科目')) + '</span>' +
    (m.sample ? '<span class="tag sample">示例</span>' : '') +
    (admin ? '<span class="tag sample">归属 ' + esc(ownerName(m.ownerId)) + '</span>' : '') +
    '<span class="tag red" title="登记未交，需补录或催办">' + (mDays >= 1 ? '未交 · 已 ' + mDays + ' 天' : '未交 · 今天登记') + '</span>' +
    snoozeBadgeHtml(amap, 'miss', m.id) +
    '<div style="font-size:13px;color:var(--ink2)">未交日期 ' + m.date + '</div></div>' +
    // 未交行的完成路径 = 去补录（现有补录流）；教务只读不显示
    (admin ? '' :
      '<button class="btn mint sm" onclick="resolveMissed(\'' + esc(jsStr(m.id)) + '\')" title="跳转到该生该科目的打卡面板补录这次作业；填写并保存后，该条未交才算补交完成">去补录</button>' +
      '<button class="btn ghost sm" onclick="removeMissed(\'' + esc(jsStr(m.id)) + '\')" title="删除该未交记录">删除</button>') +
    '<button class="btn ghost sm" onclick="alertSnooze(\'miss\',\'' + esc(jsStr(m.id)) + '\')" title="今天不再提醒，明天恢复显示（不解决问题，只是暂缓）">稍后处理</button>' +
    // 搁置出口（v1.9.0 起挂在未交行）：家长侧等暂不可控的场景长期退出待办，可在已处理事项查看；未交记录本身保留
    '<button class="btn ghost sm" onclick="alertShelve(\'' + esc(jsStr(m.id)) + '\')" title="家长侧等暂不可控的情况：长期退出待办，可在已处理事项查看；未交记录本身保留">搁置</button>' +
    '</div>';
  };
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
      (admin ? '' : '<button class="btn mint sm" onclick="gotoCorrect(\'' + esc(jsStr(r.studentId)) + '\')">录入订正</button>') +
      '<button class="btn ghost sm" onclick="alertSnooze(\'lowAcc\',\'' + esc(jsStr(x.refKey)) + '\')">稍后处理</button>' +
      '<button class="btn ghost sm" onclick="alertDone(\'lowAcc\',\'' + esc(jsStr(x.refKey)) + '\')">完成</button>' +
      '</div>';
  };
  // 逾期行（科目级）：「欠 N 次 · M 天没动静」；操作 = 去录入 / 稍后 / 完成
  const renderOverdueRow = x =>
    '<div class="todo-item">' +
    '<div class="grow"><span class="who">' + esc(x.st.name) + '</span>' +
    '<span class="tag mint">' + esc(shortSubject(x.sub)) + '</span>' +
    '<span class="tag red">逾期</span>' +
    (admin ? '<span class="tag sample">归属 ' + esc(ownerName(x.st.ownerId)) + '</span>' : '') +
    snoozeBadgeHtml(amap, 'planStall', x.refKey) +
    '<div style="font-size:13px;color:var(--ink2)">「' + esc(shortSubject(x.sub)) + '」欠 ' + x.owed + ' 次 · ' + x.days + ' 天没动静（应完成 ' + x.st.subjPlans[x.sub] + ' 次）</div></div>' +
    (admin ? '' : '<button class="btn mint sm" onclick="gotoPlanEntry(\'' + esc(jsStr(x.st.id)) + '\',\'' + esc(jsStr(x.sub)) + '\')">去录入</button>') +
    '<button class="btn ghost sm" onclick="alertSnooze(\'planStall\',\'' + esc(jsStr(x.refKey)) + '\')">稍后处理</button>' +
    '<button class="btn ghost sm" onclick="alertDone(\'planStall\',\'' + esc(jsStr(x.refKey)) + '\')">完成</button>' +
    '</div>';

  const groups = [
    { key:'miss', label:'未交', sub:'登记了「未交」的作业，补录或删除后出清；家长侧暂不可控可搁置', rows:missRows, render:renderMissRow,
      ownerOf:m=>m.ownerId, searchOf:m=>stuName(m.studentId)+' '+(m.subject||'')+' '+shortSubject(m.subject||'未指定科目') },
    { key:'overdue', label:'逾期', sub:'科目已开课且有欠账，超过 ' + homeworkCycleDays + ' 天没动静', rows:overdueRows, render:renderOverdueRow,
      ownerOf:x=>x.st.ownerId, searchOf:x=>x.st.name+' '+x.sub+' '+shortSubject(x.sub) },
    { key:'lowAcc', label:'正确率偏低', sub:'近7天有低于60%的正常成绩，按学生×科目聚合', rows:lowRows, render:renderLowRow,
      ownerOf:x=>x.rec.ownerId, searchOf:x=>stuName(x.rec.studentId)+' '+(x.rec.subject||'')+' '+shortSubject(x.rec.subject||'未指定科目') }
  ];
  const nonEmpty = groups.filter(g=>g.rows.length);
  if(todayExpandKey===null || !nonEmpty.some(g=>g.key===todayExpandKey)) todayExpandKey = nonEmpty.length ? nonEmpty[0].key : null;
  if(catsEl){
    catsEl.className = 'today-segments';
    catsEl.innerHTML = groups.map(g=>'<button type="button" role="tab" id="today-cat-' + g.key + '" class="today-seg' +
      (g.key===todayExpandKey?' active':'') + '" aria-selected="' + (g.key===todayExpandKey?'true':'false') + '" onclick="todayCatGo(\'' + g.key + '\')">' +
      g.label + ' ' + g.rows.length + '</button>').join('');
  }

  let html = '';
  const active = groups.find(g=>g.key===todayExpandKey);
  if(active){
    const owner = todayTaFilter[active.key] || 'all';
    const query = (todayQuery[active.key] || '').trim().toLowerCase();
    let rows = active.rows.slice();
    if(admin && owner!=='all') rows = rows.filter(r=>(active.ownerOf(r)||'')===owner);
    if(query) rows = rows.filter(r=>active.searchOf(r).toLowerCase().indexOf(query)!==-1);
    if(active.key==='miss') rows.sort((a,b)=>a.date===b.date ? String(a.id).localeCompare(String(b.id)) : (a.date<b.date?-1:1));
    else if(active.key==='overdue') rows.sort((a,b)=>(b.days-a.days) || String(a.refKey).localeCompare(String(b.refKey)));
    else rows.sort((a,b)=>(a.order-b.order) || String(a.refKey).localeCompare(String(b.refKey)));

    let ownerHtml = '';
    if(admin){
      const counts = {};
      active.rows.forEach(r=>{ const oid = active.ownerOf(r) || ''; counts[oid] = (counts[oid]||0)+1; });
      const ownerIds = new Set(Object.keys(counts));
      getUsersCache().filter(u=>u.role==='ta').forEach(u=>ownerIds.add(u.id));
      const options = Array.from(ownerIds).sort((a,b)=>(counts[b]||0)-(counts[a]||0) || ownerName(a).localeCompare(ownerName(b)));
      ownerHtml = '<select id="today-owner-' + active.key + '" class="today-owner" aria-label="按助教筛选" onchange="todayTaSet(\'' + active.key + '\',this.value)">' +
        '<option value="all">全部助教 ' + active.rows.length + '</option>' + options.map(oid=>
          '<option value="' + esc(oid) + '"' + (owner===oid?' selected':'') + '>' + esc(ownerName(oid)) + ' ' + (counts[oid]||0) + '</option>').join('') + '</select>';
    }
    const filtered = pagedRows(rows,todayPage[active.key],todayPageSize[active.key]);
    todayPage[active.key] = filtered.page;
    todayPageSize[active.key] = filtered.pageSize;
    const hasConditions = owner!=='all' || !!query;
    const filterHtml = '<div class="today-filter">' + ownerHtml +
      '<input id="today-search-' + active.key + '" class="today-search" value="' + esc(todayQuery[active.key] || '') + '" placeholder="搜索学生或科目" aria-label="搜索学生或科目" oninput="todaySearchSet(\'' + active.key + '\',this.value)">' +
      (hasConditions ? '<button type="button" class="btn ghost sm" onclick="todayClearFilters(\'' + active.key + '\')">清除条件</button>' : '') + '</div>';
    const pagerHtml = '<div class="today-pager"><span class="pager-meta" id="today-page-meta-' + active.key + '">第 ' + filtered.start + '–' + filtered.end + ' 条 / 共 ' + filtered.total + ' 条</span>' +
      '<label>每页 <select id="today-size-' + active.key + '" onchange="todayPageSizeSet(\'' + active.key + '\',this.value)">' +
      '<option value="20"' + (filtered.pageSize===20?' selected':'') + '>20</option><option value="50"' + (filtered.pageSize===50?' selected':'') + '>50</option></select> 条</label>' +
      '<button type="button" class="btn ghost sm" id="today-prev-' + active.key + '" onclick="todayPageGo(\'' + active.key + '\',-1)"' + (filtered.page<=1?' disabled':'') + '>上一页</button>' +
      '<span class="pager-page">第 ' + filtered.page + ' / ' + filtered.pages + ' 页</span>' +
      '<button type="button" class="btn ghost sm" id="today-next-' + active.key + '" onclick="todayPageGo(\'' + active.key + '\',1)"' + (filtered.page>=filtered.pages?' disabled':'') + '>下一页</button></div>';
    html = '<div class="today-grp" id="today-grp-' + active.key + '">' +
      '<div class="today-grp-head" tabindex="0"><b>' + active.label + '</b><span class="grp-sub">' + active.sub + '</span>' +
      '<span class="cnt">全部 ' + active.rows.length + (active.key==='miss' ? ' 次未交' : ' 条') + '</span></div>' +
      '<div class="today-grp-body">' + filterHtml +
      (filtered.rows.length ? filtered.rows.map(active.render).join('') : '<div class="today-empty">没有符合当前筛选条件的事项，请调整条件或清除筛选。</div>') +
      pagerHtml + '</div></div>';
  }

  if(!html){
    if(!isAdminView() && !activeStudents().length){
      html = '<div class="empty-ok">暂无名下学生：到「现有学生」页点「新增学生」录入第一名学生，或等教务分配。</div>';
    } else {
      const firstRecGuide = !isAdminView() && state.records.length === 0 && activeStudents().length > 0;
      html = '<div class="empty-ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" fill="#E4F3EC" stroke="none"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>今天没有待处理事项' +
        (firstRecGuide ? '，从「现有学生」学生卡选择科目开始录入。' : '，全部完成！') + '</div>';
    }
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
  // 自动展开补录表单：按稳定身份绑定原未交记录（表单内日期自动预填为该未交日期）
  if(pos >= 0){
    slotEdit = {gid: rep.id, subject: m.subject, refType: 'miss', refId: id, idx: pos+1};
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
let stuTaFilter = 'all';
let stuTaExpanded = {};
let stuSelectedId = null;
function setStuTaFilter(v){ stuTaFilter = v; renderStats(); }
function toggleTaGroup(oid){ stuTaExpanded[oid] = !stuTaExpanded[oid]; renderStats(); }
function selectStudentWorkspace(gid){
  stuSelectedId = gid;
  quickEntry = null; slotEdit = null; addSubjGid = null;
  if(typeof mockEdit !== 'undefined') mockEdit = null;
  renderAll();
}
/* 「各科目平均正确率」图表卡片默认折叠（html 里 stats-chart-card 带 collapsed 类），点击标题手动展开 */
function toggleBarChart(){
  document.getElementById('stats-chart-card').classList.toggle('collapsed');
}
document.getElementById('stu-search').addEventListener('input', function(){
  stuQuery = this.value.trim();
  renderStats();
});
/* 筛选区 meta（v1.8.4 UI-03）：命中数量 + 已选条件提示 + 一键清除复位 */
function stuFilterMetaHtml(count){
  const taFiltered = isAdminView() && stuTaFilter !== 'all';
  if(!stuQuery && !stuLetters.length && !taFiltered) return '';
  const parts = [];
  if(stuQuery) parts.push('搜索「' + esc(stuQuery) + '」');
  if(stuLetters.length) parts.push('首字母 ' + stuLetters.join('/'));
  if(taFiltered) parts.push('助教 ' + esc(ownerName(stuTaFilter)));
  return '命中 <b>' + count + '</b> 个学生 · 筛选中：' + parts.join(' + ') +
    ' <span class="sub-chip" tabindex="0" style="margin-left:6px" onclick="clearStuFilters()">清除</span>';
}
function clearStuFilters(){
  stuQuery = ''; stuLetters = []; stuTaFilter = 'all';
  const ss = document.getElementById('stu-search'); if(ss) ss.value = '';
  renderStats();
}
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
    const metaS = document.getElementById('stu-filter-meta');
    if(USE_API){ renderSalesApiList(listS, false); return; }  // API 模式：搜索走服务端（meta 在其中异步填充）
    if(!stuQuery){
      // 无关键字：只展示示例学生（演示用），真实学生仍需搜索——防批量泄露；首字母筛选叠加生效
      const demo = groups.filter(g=>g.sample && matchLetters(g.name, stuLetters));
      if(metaS) metaS.innerHTML = stuFilterMetaHtml(demo.length);
      listS.innerHTML = demo.length
        ? '<p class="hint" style="margin-bottom:10px">以下为示例学生（演示用）；查询真实学生请输入姓名或学校：</p>' + demo.map(g=>salesStuCard(g, false)).join('')
        : '<p class="hint">' + (stuLetters.length ? '没有匹配该首字母的示例学生。' : '输入学生姓名或学校进行查询') + '</p>';
      return;
    }
    const matchedS = groups.filter(g=>(g.name.indexOf(stuQuery)!==-1 || (g.school||'').indexOf(stuQuery)!==-1) && matchLetters(g.name, stuLetters));
    if(metaS) metaS.innerHTML = stuFilterMetaHtml(matchedS.length);
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

  // 教务助教筛选常显于学生搜索下方，选项来自真实账号
  const chipBox = document.getElementById('stu-ta-filter');
  if(chipBox){
    if(!isAdminView()){
      chipBox.innerHTML = '';
    } else {
      const chipTas = getUsersCache().filter(u=>u.role==='ta');
      chipBox.innerHTML = '<label class="stu-ta-select-label">负责助教 <select id="stu-ta-select" onchange="setStuTaFilter(this.value)">' +
        '<option value="all">全部助教</option>' + chipTas.map(u=>'<option value="' + esc(u.id) + '"' + (stuTaFilter===u.id?' selected':'') + '>' +
          esc(u.name) + (u.disabled?'（已停用）':'') + '</option>').join('') + '</select></label>';
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

  // 左侧真实学生行 + 右侧唯一工作区；不复制或隐藏第二份完整卡片
  const list = document.getElementById('stu-list');
  const workspaceBlank = '<div class="stu-workspace-empty"><b>选择一名学生</b><p>从左侧列表选择学生，查看完整档案与全部科目；选择科目后再进入录入。</p></div>';
  const splitHtml = (rowsHtml,workspaceHtml)=>'<div class="stu-split"><div id="stu-rows">' + rowsHtml + '</div><div id="stu-workspace">' + (workspaceHtml || workspaceBlank) + '</div></div>';
  if(!activeStudents().length){
    list.innerHTML = splitHtml('<p class="hint empty-tip">暂无在服务学生，点右上角「新增学生」录入。</p>','');
    return;
  }
  const detail = (isAdminView() && stuTaFilter!=='all') ? filtered.filter(g=>g.ownerId===stuTaFilter) : filtered;
  const metaEl = document.getElementById('stu-filter-meta');
  if(metaEl) metaEl.innerHTML = stuFilterMetaHtml(detail.length);
  if(!filtered.length){
    list.innerHTML = splitHtml(stuQuery
      ? '<p class="hint">没有匹配「' + esc(stuQuery) + '」的学生，换个关键词试试。</p>'
      : '<p class="hint">没有匹配该首字母的学生，换个字母试试。</p>','');
    return;
  }
  if(!detail.length){
    list.innerHTML = splitHtml('<p class="hint">该助教名下暂无匹配的学生。</p>','');
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
        const omc = unresolvedMissCount(g.ids, k);  // v1.9.0：角标 = 未交未处理次数（不再叫逾期）
        if(isRenaming){
          return '<span class="chip-edit">' +
            '<input id="ren-input" value="' + esc(k) + '" onkeydown="if(event.key===\'Enter\')saveRenameSubject();if(event.key===\'Escape\')cancelRename()">' +
            '<button class="btn mint sm" onclick="saveRenameSubject()">保存</button>' +
            '<button class="btn ghost sm" onclick="cancelRename()">取消</button>' +
            '<button class="btn danger sm" onclick="deleteSubject()" title="删除该科目及其全部作业记录、打卡计划、评语、模考信息">删除科目</button>' +
            '</span>';
        }
        return '<span class="sub-chip' + (isActive?' active':'') + '" tabindex="0" onclick="toggleQuickEntry(\'' + esc(jsStr(s.id)) + '\',\'' + esc(jsStr(k)) + '\')" title="点击录入该科目作业">' +
          '<span class="sub-name">' + esc(shortSubject(k)) + '</span>' +
          (omc>=2 ? '<span class="sub-alert" title="该科目有 ' + omc + ' 次未交作业未处理">!</span>' : '') +
          (hasCmt ? '<span class="sub-cmt-dot" title="已有老师评语"></span>' : '') +
          (mockDate ? (isMockExpired(mockDate)
            ? '<span class="mock-tag expired" title="预约日期已过（' + esc(mockDate) + '），可修改日期或取消预约">已过期·' + esc(mockDate.slice(5)) + '</span>'
            : '<span class="mock-tag booked" title="已预约 ' + esc(mockDate) + ' 模考">约</span>') : '') +
          (mockScore!==null ? '<span class="mock-tag score" title="结课模考分数">模考 ' + esc(mockScore) + '</span>' : '') +
          (sa !== null ? '<span class="acc-badge ' + accClass(sa) + '">' + sa + '%</span>' : '<span class="acc-badge" style="background:var(--cream2);color:var(--ink2)">' + (arr.length ? '—' : '未录入') + '</span>') +
          '<span class="sub-cnt" title="' + (planCnt!==null ? '已完成 ' + arr.length + ' 次，应完成 ' + planCnt + ' 次' : '已录入 ' + arr.length + ' 次') + '">' + (planCnt!==null ? arr.length + '/' + planCnt : arr.length) + ' 次</span>' +
          '<span class="edit-ico" tabindex="0" onclick="startRenameSubject(\'' + esc(jsStr(s.id)) + '\',\'' + esc(jsStr(k)) + '\',event)" title="修改科目名">✎</span></span>';
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
      ? ' <span class="tag mint owner-tag" tabindex="0" onclick="openBindsModal(\'' + esc(jsStr(s.id)) + '\')" title="点击查看已绑定家长，可手动解绑">已绑定家长（' + bindCnt + ' 人）<span class="tag-go">›</span></span>'
      : ' <span class="tag amber owner-tag" tabindex="0" onclick="openBindModal(\'' + esc(jsStr(s.id)) + '\')" title="生成家长绑定二维码，转发给家长微信扫码即绑定">未绑定微信<span class="tag-go">›</span></span>';

    return '<div class="stu-card">' +
      '<div class="stu-head"><div class="avatar">' + esc(g.name.slice(0,1)) + '</div>' +
      '<div class="grow"><b class="stu-name-link" onclick="openEditStudent([\'' + g.ids.map(id=>esc(jsStr(id))).join('\',\'') + '\'])" title="点击修改学生信息">' + esc(g.name) + '</b>' +
      (g.school ? ' <span style="font-weight:400;font-size:12px;color:var(--ink2)">' + esc(g.school) + '</span>' : '') +
      (g.gradYear ? ' <span class="tag mint">' + g.gradYear + ' 届</span>' : '') +
      (g.ids.length>1 ? ' <span class="tag mint">同名合并 ×' + g.ids.length + '</span>' : '') +
      (g.sample?' <span class="tag sample">示例</span>':'') +
      (isAdminView() ? ' <span class="tag mint owner-tag" tabindex="0" onclick="openTransfer([\'' + g.ids.map(id=>esc(jsStr(id))).join('\',\'') + '\'])" title="归属助教，点击可转移归属">归属：' + esc(ownerName(g.ownerId)) + '<span class="tag-go">›</span></span>' : '') +
      bindTag + '</div>' +
      trend +
      '<button class="btn ghost sm" onclick="toggleAddSubject(\'' + esc(jsStr(s.id)) + '\')" title="为该学生添加学习科目">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>新增科目</button>' +
      '</div>' +
      '<div class="stu-nums"><span>作业次数 <b>' + recs.length + '</b></span><span>未交次数 <b style="color:var(--red)">' + misses.length + '</b></span>' +
      (lastGradedRec(recs) ? '<span>最近正确率 <b>' + acc(lastGradedRec(recs)) + '%</b></span>' : '') +
      // 最近录入时间：弱色纯文字（无徽章底色），与统计信息同行归组，不抢视觉焦点；无记录不显示
      // 当年省年份（录入 09-29），跨年记录保留完整日期避免歧义
      (recs.length ? (function(){ const d = recs.reduce((a,b)=>a.date>b.date?a:b).date;
        return '<span class="last-rec">录入 ' + (d.slice(0,4) === todayStr().slice(0,4) ? d.slice(5) : d) + '</span>'; })() : '') +
      '<span style="margin-left:auto"><button class="btn ghost sm" onclick="archiveGroup([\'' + g.ids.map(id=>esc(jsStr(id))).join('\',\'') + '\'])">转为历史学生</button></span></div>' +
      subHtml +
      (addSubjGid===s.id ? addSubjPanelHtml(s.id) : '') +
      (quickEntry && quickEntry.gid===s.id ? qePanelHtml() : '') +
      missHtml +
      '</div>';
  };
  const recCounts = {}, missCounts = {};
  state.records.forEach(r=>{ recCounts[r.studentId] = (recCounts[r.studentId]||0)+1; });
  state.missed.filter(m=>!m.resolved).forEach(m=>{ missCounts[m.studentId] = (missCounts[m.studentId]||0)+1; });
  const selectedId = quickEntry ? quickEntry.gid : stuSelectedId;
  const selectedGroup = detail.find(g=>g.ids.includes(selectedId));
  const renderStuRow = g=>{
    const recCnt = g.ids.reduce((n,id)=>n+(recCounts[id]||0),0);
    const missCnt = g.ids.reduce((n,id)=>n+(missCounts[id]||0),0);
    return '<button type="button" class="stu-row' + (g.ids.includes(selectedId)?' active':'') + '" onclick="selectStudentWorkspace(\'' + esc(jsStr(g.ids[0])) + '\')">' +
      '<span class="stu-row-avatar">' + esc(g.name.slice(0,1)) + '</span><span class="stu-row-main"><b>' + esc(g.name) + '</b>' +
      '<span class="stu-row-meta">' + (g.school?esc(g.school)+' · ':'') + (g.gradYear?esc(g.gradYear)+' 届':'') + (isAdminView()?' · '+esc(ownerName(g.ownerId)):'') + '</span>' +
      '<span class="stu-row-meta">作业 ' + recCnt + ' 次' + (missCnt?' · 未交 '+missCnt+' 次':'') + '</span></span><span class="stu-row-go">›</span></button>';
  };
  let rowsHtml = '';
  if(isAdminView() && stuTaFilter==='all'){
    const tas = getUsersCache().filter(u=>u.role==='ta');
    const renderGroup = (key,label,gs)=>{
      const open = !!stuQuery || !!stuTaExpanded[key];
      return '<div class="ta-group-head" style="cursor:pointer" tabindex="0" onclick="toggleTaGroup(\'' + esc(jsStr(key)) + '\')" title="点击展开/收起">' +
        '<span class="chev">' + (open?'▾':'▸') + '</span>' + label + '<span class="cnt">' + gs.length + ' 个学生</span></div>' +
        (open ? gs.map(renderStuRow).join('') : '');
    };
    tas.forEach(u=>{
      const gs = detail.filter(g=>g.ownerId===u.id);
      if(gs.length) rowsHtml += renderGroup(u.id,esc(u.name)+(u.disabled?'（已停用）':''),gs);
    });
    const others = detail.filter(g=>!tas.some(u=>u.id===g.ownerId));
    if(others.length) rowsHtml += renderGroup('__other__','其他（教务直接录入）',others);
  } else {
    rowsHtml = detail.map(renderStuRow).join('');
  }
  list.innerHTML = splitHtml(rowsHtml,selectedGroup ? renderStuCard(selectedGroup) : '');
  const filterCard = document.getElementById('stu-filter-card');
  if(filterCard && filterCard.offsetHeight) document.documentElement.style.setProperty('--stu-filter-height',Math.round(filterCard.offsetHeight)+'px');
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
    return '<span class="sub-chip' + (isOpen?' active':'') + '" onclick="toggleSalesSubject(\'' + g.ids[0] + '\',\'' + esc(jsStr(k)) + '\')" title="点击查看该科目详情（只读）">' +
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
  // 归档时间范围筛选（v1.7.2）：历史学生「近 30 天归档」在服务端结果上叠加；无归档时间的旧数据不进
  const rangeStart = (isAlumni && alumniRange==='30d') ? offsetDay(-29) : null;
  const items = r.students.filter(s=> (isAlumni ? s.archived : !s.archived) && matchLetters(s.name, letters)
    && (!rangeStart || (s.archivedAt && String(s.archivedAt).slice(0,10) >= rangeStart)));
  listEl.innerHTML = items.length
    ? items.map(s=>salesApiCard(s, isAlumni)).join('')
    : '<p class="hint">没有匹配「' + esc(q) + '」的' + (isAlumni ? '历史' : '') + '学生。</p>';
  // 列表是异步渲染的：若有展开中的科目详情且已缓存，渲染完成后自动回填面板（避免竞态）
  if(salesSubjApi && salesDetailCache[salesSubjApi.id]) fillSalesApiPanel(salesSubjApi.id);
  // 筛选区 meta 同步（v1.8.4 UI-03）：仅现有学生页（历史学生页无 meta 元素）
  if(!isAlumni){
    const metaEl = document.getElementById('stu-filter-meta');
    if(metaEl) metaEl.innerHTML = stuFilterMetaHtml(items.length);
  }
}
function fillSalesApiPanel(id){
  const el = document.getElementById('sales-api-panel-' + id);
  if(el && salesSubjApi && salesSubjApi.id===id) el.innerHTML = salesApiPanel(salesDetailCache[id], salesSubjApi.subject);
}
function salesApiCard(s, isAlumni){
  const subHtml = (s.subjects && s.subjects.length) ? '<div class="sub-acc">' + s.subjects.map(sub=>
    '<span class="sub-chip" tabindex="0" onclick="toggleSalesSubjectApi(\'' + esc(jsStr(s.id)) + '\',\'' + esc(jsStr(sub.subject)) + '\',' + isAlumni + ')" title="点击查看该科目详情（只读）">' +
    '<span class="sub-name">' + esc(shortSubject(sub.subject)) + '</span>' +
    // 无成绩可算（纯无作业/纯未交/纯计划）→ 正确率 —（v1.8.2 BUG-04）
    (sub.avg === null || sub.avg === undefined
      ? '<span class="acc-badge" style="background:var(--cream2);color:var(--ink2)">—</span>'
      : '<span class="acc-badge ' + accClass(sub.avg) + '">' + sub.avg + '%</span>') +
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
        // 未交格子（v1.8.2 BUG-05）：未交不是零分——分数/错题显示 —，文字独立表达「未交 · 待补交」
        return '<div class="ci-slot miss" title="第 ' + idx + ' 次：' + it.date + ' 未交 · 待补交">' +
          '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span><span class="ci-mark">未交✗</span></div>' +
          '<div class="ci-date">' + it.date + '</div><div class="ci-acc" style="color:var(--red)">—</div>' +
          '<div class="ci-wrongs">未交 · 待补交</div></div>';
      }
      if(it && it.type==='rec'){
        if(it.noHomework){  // 无作业格子（服务端明细带 noHomework 标记）
          return '<div class="ci-slot nohw" title="本次无作业 · 已完成">' +
            '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span><span class="ci-mark">无作业</span></div>' +
            '<div class="ci-date">' + it.date + '</div><div class="ci-acc" style="color:var(--ink2)">—</div>' +
            '<div class="ci-wrongs">本次无作业</div></div>';
        }
        const ra = it.acc;
        const acls = ra>=85?'good':(ra>=60?'mid':'bad');
        return '<div class="ci-slot done" title="第 ' + idx + ' 次：' + it.date + '，已提交 · 正确率 ' + ra + '%' +
          (it.wrongs&&it.wrongs.length ? '，错题 ' + esc(it.wrongs.join('、')) : '') + '">' +
          '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span><span class="ci-mark"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg></span></div>' +
          '<div class="ci-date">' + it.date + '</div>' +
          '<div class="ci-acc ' + acls + '">' + ra + '%</div>' +
          '<div class="ci-wrongs">' + (it.wrongs&&it.wrongs.length ? '错 ' + esc(it.wrongs.join('、')) : '无错题') + '</div></div>';
      }
      return '<div class="ci-slot miss" title="第 ' + idx + ' 次作业待录入">' +
        '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span></div>' +
        '<div class="ci-date">待录入</div><div class="ci-acc" style="color:var(--red)">—</div>' +
        '<div class="ci-wrongs">待录入</div></div>';
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
  stuSelectedId = gid;
  // 评语/建议有未保存修改时提醒（不阻塞切换）
  if(quickEntry && (quickEntry.gid!==gid || quickEntry.subject!==subject) && typeof qeDirtyToast==='function') qeDirtyToast();
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
  // 草稿恢复（v1.8.0 BUG-01）：localStorage 草稿优先于已保存值；有草稿即视为 dirty（切页/刷新后回来可继续编辑）
  const draftCmt = draftLoad(quickEntry.gid, quickEntry.subject, 'comment');
  const draftAdv = draftLoad(quickEntry.gid, quickEntry.subject, 'advice');
  const commentVal = draftCmt !== null ? draftCmt : savedComment;
  const adviceVal = draftAdv !== null ? draftAdv : savedAdvice;
  if(draftCmt !== null) qeDirty.comment = quickEntry.gid + '|' + quickEntry.subject;
  if(draftAdv !== null) qeDirty.advice = quickEntry.gid + '|' + quickEntry.subject;
  // 模考数据：{date:'YYYY-MM-DD', score:数字}，按 学生×科目 存储
  const mock = (st && st.mock && st.mock[quickEntry.subject]) || {};
  const mockDate = mock.date || '';
  const mockScore = (mock.score!==undefined && mock.score!==null && mock.score!=='') ? mock.score : '';
  const isMockEditDate = mockEdit && mockEdit.gid===quickEntry.gid && mockEdit.subject===quickEntry.subject && mockEdit.field==='date';
  const isMockEditScore = mockEdit && mockEdit.gid===quickEntry.gid && mockEdit.subject===quickEntry.subject && mockEdit.field==='score';
  let mockBookHtml;
  if(mockDate && !isMockEditDate){
    mockBookHtml = (isMockExpired(mockDate)
      ? '<span class="mock-booked expired" title="预约日期已过，可修改日期或取消预约">已过期 · ' + esc(mockDate) + '（原预约模考）</span>'
      : '<span class="mock-booked">✓ 已预约 ' + esc(mockDate) + ' 模考</span>') +
      '<button class="btn ghost sm" onclick="editMock(\'date\')">修改日期</button>' +
      '<button class="btn ghost sm" onclick="cancelMockExam()">取消预约</button>' +
      '<button class="btn ghost sm" onclick="pushManual(\'mock-book\')" title="给已绑定家长推送「考试报名成功通知」">推送报名通知</button>';
  } else {
    mockBookHtml = '<span class="mock-lbl">预约日期</span><input id="mock-date" type="date" value="' + (mockDate || todayStr()) + '" aria-label="预约日期">' +
      '<button class="btn mint sm" onclick="bookMockExam()">预约模考</button>';
  }
  let mockScoreHtml;
  if(mockScore!=='' && !isMockEditScore){
    mockScoreHtml = '<span class="mock-score-shown">结课模考分数：<b>' + esc(mockScore) + '</b>分</span>' +
      '<button class="btn ghost sm" onclick="editMock(\'score\')">修改</button>' +
      '<button class="btn ghost sm" onclick="clearMockScore()">清除</button>' +
      '<button class="btn ghost sm" onclick="pushManual(\'mock-score\')" title="给已绑定家长推送「考试成绩通知」">推送成绩通知</button>';
  } else {
    mockScoreHtml = '<span class="mock-lbl">结课分数</span><input id="mock-score" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="0-100" aria-label="结课分数" value="' + (mockScore!==''?esc(mockScore):'') + '">' +
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
    '<div class="qe-title qe-title-sticky" style="display:flex;align-items:center;justify-content:space-between;gap:10px"><span>「' + esc(shortSubject(quickEntry.subject)) + '」作业打卡 · ' + esc(st ? st.name : '') + '</span>' +
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
              '<button class="btn ghost sm" onclick="cancelPlanRequest(\'' + esc(jsStr(pendReq.id)) + '\')">撤回申请</button>'
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
      : '<textarea id="qe-comment" rows="2" placeholder="写一句给这位学生的科目评语，保存后科目旁会出现绿色小圆点…">' + esc(commentVal) + '</textarea>' +
        '<div class="qe-comment-actions">' +
        '<button class="btn mint sm" onclick="saveSubjectComment()">保存评语</button>' +
        '<span class="qe-saved-tip" id="qe-comment-tip" style="display:none">✓ 已保存</span>' +
        '<span class="qe-save-st' + (draftCmt !== null ? ' dirty' : '') + '" id="qe-comment-st">' + (draftCmt !== null ? '未保存' : '') + '</span>' +
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
      : '<textarea id="qe-advice" rows="3" placeholder="写给这位学生的学习计划与建议，会随「生成报告」一起输出…">' + esc(adviceVal) + '</textarea>' +
        '<div class="qe-comment-actions">' +
        '<button class="btn mint sm" onclick="saveSubjectAdvice()">保存计划与建议</button>' +
        '<span class="qe-saved-tip" id="qe-advice-tip" style="display:none">✓ 已保存</span>' +
        '<span class="qe-save-st' + (draftAdv !== null ? ' dirty' : '') + '" id="qe-advice-st">' + (draftAdv !== null ? '未保存' : '') + '</span>' +
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
// {gid, subject, refType:'rec'|'miss'|'new', refId, idx}（v1.8.0 BUG-02）：
// 编辑对象绑定稳定身份——rec/miss 按记录 id 复核，idx 只作「第 N 次」显示编号（随排序位置动态更新）；
// refType 'new' = 空位补录（无记录 id，按位置语义）
let slotEdit = null;
let slNoHw = false;   // 「本次无作业」态（第四次态）：随格子开闭重置；打开已存的无作业记录时自动开启
let slotMakeupOpen = false;  // 未交格子是否已展开「补录成绩」表单（默认只展示未交状态，不要求填题数）
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
  apiPersist(HttpApi.updateSubjFields(st.id, {subjFirstClass: {[quickEntry.subject]: v}}));  // 最小补丁：只提交当前科目键（v1.7.2）
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
  const prReason = document.getElementById('pr-reason');  // 初始焦点落理由输入框（v1.8.4 UI-06）
  if(prReason && prReason.focus) prReason.focus();
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
  // 登记即完成：关闭编辑面板（否则会立刻显示该未交的「补录成绩」表单，让人误以为还要填题数）
  slotEdit = null;
  slotMakeupOpen = false;
  renderAll();
  toast('已登记未交');
}
/* 未交格子点「补录成绩」：展开补交表单（默认只展示未交状态，未交作业没有题目信息不该强制填题数） */
function startMakeup(){
  if(!slotEdit) return;
  slotMakeupOpen = true;
  renderStats();
  if(document.getElementById('sl-wrongs')) slCalc();
}
/* 该科目打卡序列：作业记录 + 未处理的未交记录按日期合并排序，作为打卡格子数据源。
   同日稳定次序（v1.8.0 BUG-02）：日期 → 类型（rec 在 miss 前）→ id 字典序，与 server/routes/search.js 同规则，两端一致 */
function subjectItems(gid, subject){
  const recs = subjectRecsSorted(gid, subject).map(r=>({type:'rec', date:r.date, id:r.id, rec:r}));
  const miss = state.missed.filter(m=>m.studentId===gid && (m.subject||'')===subject && !m.resolved)
    .map(m=>({type:'miss', date:m.date, id:m.id, miss:m}));
  return recs.concat(miss).sort((a,b)=> a.date===b.date
    ? (a.type===b.type ? (a.id<b.id?-1:(a.id>b.id?1:0)) : (a.type==='rec'?-1:1))
    : (a.date<b.date?-1:1));
}
/* slotEdit 身份解析（v1.8.0 BUG-02）：rec/miss 按 refId 在当日排序序列中定位（找不到 = 已被删/已处理）；
   new 按位置语义（空位补录，不拾取位置上的既有记录）。返回 {it, pos, missing}，pos = 当前 1 基序号 */
function slotEditItem(){
  if(!slotEdit) return {it:null, pos:0, missing:false};
  const items = subjectItems(slotEdit.gid, slotEdit.subject);
  if(slotEdit.refType==='rec' && slotEdit.refId){
    const p = items.findIndex(x=>x.type==='rec' && x.id===slotEdit.refId);
    return p!==-1 ? {it:items[p], pos:p+1, missing:false} : {it:null, pos:slotEdit.idx, missing:true};
  }
  if(slotEdit.refType==='miss' && slotEdit.refId){
    const p = items.findIndex(x=>x.type==='miss' && x.id===slotEdit.refId);
    return p!==-1 ? {it:items[p], pos:p+1, missing:false} : {it:null, pos:slotEdit.idx, missing:true};
  }
  return {it:null, pos:slotEdit.idx, missing:false};
}
/* 生成打卡格子：有记录=完成✓（日期/正确率/错题），未交=未交✗（日期/0%/错题0），无记录=未完成（无标记） */
function checkinGridHtml(){
  const gid = quickEntry.gid, subject = quickEntry.subject;
  const st = state.students.find(x=>x.id===gid);
  const plan = (st && st.subjPlans && st.subjPlans[subject]) || 0;
  const items = subjectItems(gid, subject);
  let total = Math.max(plan, items.length);
  // 补录中：编辑区指向的格子需显示出来（idx 为显示编号，随排序位置更新）
  if(slotEdit && slotEdit.gid===gid && slotEdit.subject===subject && slotEdit.idx>total) total = slotEdit.idx;
  if(!total) return '<span style="font-size:12px;color:var(--ink2)">暂无计划与记录，先在上方填写应完成次数</span>';
  return Array.from({length: total}, (_,i)=>{
    const idx = i+1;
    const it = items[i];
    if(it && it.type==='miss'){
      // 未交格子（v1.8.2 BUG-05）：未交不是零分——分数/错题显示 —，文字独立表达「未交 · 待补交」
      return '<div class="ci-slot miss" onclick="openSlot(' + idx + ')" title="第 ' + idx + ' 次：' + it.miss.date + ' 未交 · 待补交（' + (st&&st.archived?'点击查看':'点击补录') + '）">' +
        '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span><span class="ci-mark">未交✗</span></div>' +
        '<div class="ci-date">' + it.miss.date + '</div>' +
        '<div class="ci-acc" style="color:var(--red)">—</div>' +
        '<div class="ci-wrongs">未交 · 待补交</div>' +
        '</div>';
    }
    const r = it && it.type==='rec' ? it.rec : null;
    if(r){
      if(r.noHomework){  // 无作业格子（第四次态）：中性灰蓝，只显示「无作业」+ 日期，不显示百分比与错题
        return '<div class="ci-slot nohw" onclick="openSlot(' + idx + ')" title="本次无作业 · 已完成（点击查看/修改）">' +
          '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span><span class="ci-mark">无作业</span></div>' +
          '<div class="ci-date">' + r.date + '</div>' +
          '<div class="ci-acc" style="color:var(--ink2)">—</div>' +
          '<div class="ci-wrongs">本次无作业</div>' +
          '</div>';
      }
      const ra = acc(r);
      const acls = ra>=85?'good':(ra>=60?'mid':'bad');
      return '<div class="ci-slot done" onclick="openSlot(' + idx + ')" title="第 ' + idx + ' 次：' + r.date + '，已提交 · 正确率 ' + ra + '%' +
        (r.wrongs&&r.wrongs.length ? '，错题 ' + esc(r.wrongs.join('、')) : '') + '（点击查看/修改）">' +
        '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span><span class="ci-mark"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg></span></div>' +
        '<div class="ci-date">' + r.date + '</div>' +
        '<div class="ci-acc ' + acls + '">' + ra + '%</div>' +
        '<div class="ci-wrongs">' + (r.wrongs&&r.wrongs.length ? '错 ' + esc(r.wrongs.join('、')) : '无错题') + '</div>' +
        '</div>';
    }
    // 未录入空格子：「待录入」（非未交、非零分）
    return '<div class="ci-slot todo" onclick="openSlot(' + idx + ')" title="第 ' + idx + ' 次作业待录入' + (st&&st.archived?'':'，点击补录') + '">' +
      '<div class="ci-top"><span class="ci-idx">第' + idx + '次</span></div>' +
      '<div class="ci-date">待录入</div>' +
      '<div class="ci-acc" style="color:var(--red)">—</div>' +
      '<div class="ci-wrongs">' + (st&&st.archived?'待录入':'点击补录') + '</div>' +
      '</div>';
  }).join('');
}
/* 点击格子：展开/收起当次录入（有记录则修改，无记录则新增）。
   v1.8.0 BUG-02：打开时绑定稳定身份（rec/miss 记录 id；空位为 new），同日/插入记录后编辑对象不漂移 */
function openSlot(idx){
  const it0 = subjectItems(quickEntry.gid, quickEntry.subject)[idx-1];
  const refType = it0 ? it0.type : 'new';
  const refId = it0 ? it0.id : null;
  if(slotEdit && slotEdit.gid===quickEntry.gid && slotEdit.subject===quickEntry.subject
    && slotEdit.refType===refType && slotEdit.refId===refId && (refType!=='new' || slotEdit.idx===idx)){
    slotEdit = null;  // 再点同一格子收起
  } else {
    slotEdit = {gid:quickEntry.gid, subject:quickEntry.subject, refType:refType, refId:refId, idx:idx};
  }
  // 无作业态随格子开闭重置；打开已存的无作业记录时自动进入无作业态（日期可改、可切回正常录入）
  slNoHw = false;
  slotMakeupOpen = false;  // 未交格子默认只展示状态，点「补录成绩」才展开表单
  if(slotEdit && slotEdit.refType==='rec'){
    const r0 = state.records.find(x=>x.id===slotEdit.refId);
    if(r0 && r0.noHomework) slNoHw = true;
  }
  renderAll();
  // 表单打开后立即计算一次：有已存记录且非满分无错题时，错题号立即显示必填红框
  if(slotEdit && !slNoHw && document.getElementById('sl-wrongs')) slCalc();
}
/* 「本次无作业」切换：正常成绩 → 无作业时若已有成绩内容需确认（成绩将被清除）；无作业 → 正常直接切回并恢复暂存值 */
function toggleSlotNoHw(){
  if(!slotEdit) return;
  if(!slNoHw){
    const r = slotEdit.refType==='rec' ? (state.records.find(x=>x.id===slotEdit.refId) || null) : null;
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
        slotDraftSave();
        renderAll();
      });
      return;
    }
    slNoHw = true;
    slotDraftSave();
    renderAll();
    return;
  }
  slNoHw = false;  // 取消无作业：切回正常表单（恢复切入前的填写值）
  slotDraftSave();
  renderAll();
}
/* 录入表单草稿（v1.8.0 BUG-01）：随输入持久化到 localStorage（含无作业态与暂存值）；
   绑定格子身份（refType/refId），仅保存/删除成功才清除；取消/切页/刷新后重开同一格子自动恢复 */
function slotDraftSave(){
  if(!slotEdit) return;
  const se = document.getElementById('sl-err');  // 继续输入即清行内校验错误（v1.8.2 UI-01）
  if(se) se.style.display = 'none';
  const g = id=>{ const el = document.getElementById(id); return el ? el.value : ''; };
  const d = {
    refType: slotEdit.refType, refId: slotEdit.refId, idx: slotEdit.idx,
    date: g('sl-date'), total: g('sl-total'), correct: g('sl-correct'), wrongs: g('sl-wrongs'), noHw: slNoHw
  };
  if(slNoHw && slTmpVals){ d.total = slTmpVals.total; d.correct = slTmpVals.correct; d.wrongs = slTmpVals.wrongs; }  // 无作业态下输入框被禁用，成绩值取暂存
  draftSave(slotEdit.gid, slotEdit.subject, 'slot', d);
}
/* 行内校验错误（v1.8.2 UI-01）：贴近字段红字 ✕ + 定位焦点；保留已输入内容不清空 */
function slError(msg, focusId){
  const el = document.getElementById('sl-err');
  if(el){ el.textContent = '✕ ' + msg; el.style.display = ''; }
  const f = focusId ? document.getElementById(focusId) : null;
  if(f && f.focus) f.focus();
}
/* 当次作业编辑区 HTML */
function slotEditHtml(){
  const resolved = slotEditItem();
  if(resolved.missing){  // 记录已被删除/已处理（他端操作）：明确提示，不再指向错误对象（v1.8.0 BUG-02）
    return '<div class="slot-edit"><div class="se-title">第 ' + slotEdit.idx + ' 次作业</div>' +
      '<div style="font-size:13px;color:var(--red);padding:4px 0">该记录已被删除或已处理，无法继续编辑。</div>' +
      '<div class="se-actions"><button class="btn ghost sm" onclick="slotEdit=null;renderAll()">关闭</button></div></div>';
  }
  slotEdit.idx = resolved.pos;  // idx 只作显示编号：随当前排序位置更新
  const it = resolved.it;
  const r = it && it.type==='rec' ? it.rec : null;
  const miss = it && it.type==='miss' ? it.miss : null;
  const st = state.students.find(x=>x.id===slotEdit.gid);
  // 草稿恢复（v1.8.0 BUG-01）：草稿身份与本格子一致才恢复（含无作业态与切入前的成绩暂存值）
  let draftVals = null;
  if(!st || !st.archived){
    const rawDraft = draftLoad(slotEdit.gid, slotEdit.subject, 'slot');
    if(rawDraft){
      try{
        const d = JSON.parse(rawDraft);
        if(d && d.refType === slotEdit.refType && d.refId === slotEdit.refId) draftVals = d;
      }catch(e){}
    }
  }
  if(draftVals){
    slNoHw = !!draftVals.noHw;
    slTmpVals = draftVals.noHw ? {total: draftVals.total || '', correct: draftVals.correct || '', wrongs: draftVals.wrongs || ''} : null;
  }
  // 历史学生：只读展示当次详情
  if(st && st.archived){
    if(miss){
      return '<div class="slot-edit"><div class="se-title">第 ' + slotEdit.idx + ' 次作业</div>' +
        '<div style="font-size:13px;color:var(--red);padding:4px 0">该次作业未交（' + miss.date + '），登记状态「未交 · 待补交」，无成绩数据。</div>' +
        '<div class="se-actions"><button class="btn ghost sm" onclick="openSlot(' + slotEdit.idx + ')">关闭</button></div></div>';
    }
    if(!r){
      return '<div class="slot-edit"><div class="se-title">第 ' + slotEdit.idx + ' 次作业</div>' +
        '<div style="font-size:13px;color:var(--red);padding:4px 0">该次作业待录入（无记录）。</div>' +
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
  // 该次为未交记录：默认只展示未交状态（未交作业没有题目信息，不该一进来就要求填题数）；
  // 点「补录成绩」才展开补交表单（保存后该次未交自动视为已补交）
  if(miss){
    if(!slotMakeupOpen){
      return '<div class="slot-edit">' +
        '<div class="se-title">第 ' + slotEdit.idx + ' 次作业（' + esc(shortSubject(slotEdit.subject)) + '）</div>' +
        '<div style="font-size:13px;color:var(--red);padding:4px 0 6px">该次为 ' + miss.date + ' 的未交作业，登记状态「未交 · 待补交」，无成绩数据。</div>' +
        '<div class="se-actions">' +
        '<button class="btn mint sm" onclick="startMakeup()">补录成绩</button>' +
        '<button class="btn ghost sm" onclick="openSlot(' + slotEdit.idx + ')">关闭</button>' +
        '</div></div>';
    }
    return '<div class="slot-edit">' +
      '<div class="se-title">补录第 ' + slotEdit.idx + ' 次作业（' + esc(shortSubject(slotEdit.subject)) + '）</div>' +
      '<div style="font-size:13px;color:var(--red);padding:4px 0 2px">该次为 ' + miss.date + ' 的未交作业，登记状态「未交 · 待补交」，无成绩数据。填写下方信息并保存即完成这次补交；取消则保持未交状态。</div>' +
      '<div class="se-grid">' +
      '<label class="se-field"><span>日期</span><input id="sl-date" type="date" value="' + (draftVals ? esc(draftVals.date) : miss.date) + '" oninput="slotDraftSave()"></label>' +
      '<label class="se-field"><span>总题数</span><input id="sl-total" type="number" min="1" inputmode="numeric" placeholder="如 20" value="' + (draftVals ? esc(draftVals.total) : '') + '" oninput="slCalc();slotDraftSave()"></label>' +
      '<label class="se-field"><span>正确题目数</span><input id="sl-correct" type="number" min="0" inputmode="numeric" placeholder="如 18" value="' + (draftVals ? esc(draftVals.correct) : '') + '" oninput="slCalc();slotDraftSave()"></label>' +
      '<label class="se-field"><span>错题号</span><input id="sl-wrongs" placeholder="用逗号分隔，可空" value="' + (draftVals ? esc(draftVals.wrongs) : '') + '" oninput="slotDraftSave()"></label>' +
      '</div>' +
      '<div class="se-calc" id="sl-calc">错误数 <b>—</b>　正确率 <b>—</b></div>' +
      '<div class="se-err" id="sl-err" style="display:none"></div>' +
      '<div class="se-actions">' +
      '<button class="btn mint sm" onclick="saveSlot()">保存并补交</button>' +
      '<button class="btn ghost sm" onclick="openSlot(' + slotEdit.idx + ')">取消</button>' +
      '</div></div>';
  }
  return '<div class="slot-edit">' +
    '<div class="se-title">' + (r ? '修改' : '录入') + '第 ' + slotEdit.idx + ' 次作业（' + esc(shortSubject(slotEdit.subject)) + '）' + (slNoHw ? '<span class="tag sample">本次无作业</span>' : '') + '</div>' +
    '<div class="se-grid">' +
    '<label class="se-field"><span>日期</span><input id="sl-date" type="date" value="' + (draftVals ? esc(draftVals.date) : (r ? r.date : todayStr())) + '" oninput="slotDraftSave()"></label>' +
    '<label class="se-field"><span>总题数</span><input id="sl-total" type="number" min="1" inputmode="numeric" placeholder="如 20" value="' + (slNoHw ? '' : (draftVals ? esc(draftVals.total) : (r ? r.total : (slTmpVals ? slTmpVals.total : '')))) + '" oninput="slCalc();slotDraftSave()"' + (slNoHw ? ' disabled' : '') + '></label>' +
    '<label class="se-field"><span>正确题目数</span><input id="sl-correct" type="number" min="0" inputmode="numeric" placeholder="如 18" value="' + (slNoHw ? '' : (draftVals ? esc(draftVals.correct) : (r ? r.correct : (slTmpVals ? slTmpVals.correct : '')))) + '" oninput="slCalc();slotDraftSave()"' + (slNoHw ? ' disabled' : '') + '></label>' +
    '<label class="se-field"><span>错题号</span><input id="sl-wrongs" placeholder="用逗号分隔，可空" value="' + (slNoHw ? '' : (draftVals ? esc(draftVals.wrongs) : (r && r.wrongs ? esc(r.wrongs.join(',')) : (slTmpVals ? esc(slTmpVals.wrongs) : '')))) + '" oninput="slotDraftSave()"' + (slNoHw ? ' disabled' : '') + '></label>' +
    '</div>' +
    '<div class="se-calc" id="sl-calc">' + (slNoHw ? '本次无作业，仅需选择日期' : (r ? '已保存：错误数 <b>' + (r.total-r.correct) + '</b>　正确率 <b>' + acc(r) + '%</b>' : '错误数 <b>—</b>　正确率 <b>—</b>')) + '</div>' +
    '<div class="se-err" id="sl-err" style="display:none"></div>' +
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
let slotSaving = false;  // 提交中防重复点击（v1.8.2 UI-01）
// API 补交：成绩与未交处理由服务端单事务完成；失败不提前改本地，成功才清草稿/关闭并重取权威状态
async function saveMakeupApi(miss, newRec, gid0, sub0){
  const res = await HttpApi.makeupMissed(miss.id, newRec);
  if(!res.ok){ slotSaving = false; toast(res.msg || '补交保存失败，请重试'); return false; }
  slotEdit = null; slTmpVals = null;
  draftSave(gid0, sub0, 'slot', null);
  slotSaving = false;
  await resyncState();
  save(); renderAll();
  if(res.pushed) toast('作业成绩已推送给家长');
  return true;
}
async function saveSlot(){
  if(!slotEdit) return;
  if(slotSaving){ toast('正在保存，请稍候'); return; }
  const st0 = pool.students.find(x=>x.id===slotEdit.gid);
  if(!st0 || !canWriteOwner(st0.ownerId)){ toast('没有权限操作该数据'); return; }
  const gid0 = slotEdit.gid, sub0 = slotEdit.subject;
  const date = document.getElementById('sl-date').value || todayStr();
  // 按稳定身份复核编辑对象（v1.8.0 BUG-02）：rec/miss 按 refId 取对象并确认仍存在与归属；new = 空位补录
  let r = null, miss = null;
  if(slotEdit.refType==='rec'){
    r = state.records.find(x=>x.id===slotEdit.refId) || null;
    if(!r){ toast('该记录已被删除，无法保存'); slotEdit = null; renderAll(); return; }
  } else if(slotEdit.refType==='miss'){
    miss = state.missed.find(x=>x.id===slotEdit.refId && !x.resolved) || null;
    if(!miss){ toast('该未交记录已处理，无法保存'); slotEdit = null; renderAll(); return; }
  }
  const clearDraft = ()=>{ slotSaving = false; draftSave(gid0, sub0, 'slot', null); };  // 保存成功才清草稿（v1.8.0 BUG-01）：API 在 onOk、mock 同步；同时复位提交中标记
  /* ---- 无作业保存：只校验日期；total/correct/wrongs 清零；正常 → 无作业转换在 toggleSlotNoHw 已确认 ---- */
  if(slNoHw){
    slotSaving = true;
    if(r){
      if(!canWriteOwner(r.ownerId)){ slotSaving = false; toast('没有权限操作该数据'); return; }
      r.date = date; r.total = 0; r.correct = 0; r.wrongs = []; r.noHomework = true;
      logAction('修改作业（无作业）', 'record', auditStuDesc(slotEdit.gid, slotEdit.subject), '日期 ' + date, {ownerId: r.ownerId});
      apiPersist(HttpApi.updateRecord(r.id, {date: date, total: 0, correct: 0, wrongs: [], subject: r.subject, noHomework: true}),
        rr=>{ clearDraft(); if(rr && rr.pushed) toast('作业成绩已推送给家长'); },
        ()=>{ slotSaving = false; });
    } else {
      const newRec = {id:uid(), studentId:slotEdit.gid, date:date, total:0, correct:0,
        wrongs:[], subject:slotEdit.subject, images:[], pdfs:[], ownerId:st0.ownerId, noHomework:true};
      // 未交格子正常 UI 不提供转无作业；防御分支也走同一补交事务，禁止双请求部分成功
      if(miss && USE_API){
        const saved = await saveMakeupApi(miss, newRec, gid0, sub0);
        if(saved){ slNoHw = false; slTmpVals = null; }
        return;
      }
      pool.records.push(newRec);
      logAction('录入作业（无作业）', 'record', auditStuDesc(slotEdit.gid, slotEdit.subject), '日期 ' + date, {ownerId: st0.ownerId});
      apiPersist(HttpApi.addRecord({id: newRec.id, studentId: newRec.studentId, date: date, total: 0, correct: 0,
        wrongs: [], subject: newRec.subject, images: newRec.images, pdfs: newRec.pdfs, noHomework: true}),
        rr=>{ clearDraft(); if(rr && rr.pushed) toast('作业成绩已推送给家长'); },
        ()=>{ slotSaving = false; });
      // 未交格子本期不提供转无作业入口（slotEditHtml 未交分支无该按钮），此分支仅为防御
      if(miss){
        miss.resolved = true; miss.resolution = 'made-up'; miss.resolvedAt = todayStr();
        apiPersist(HttpApi.resolveMissed(miss.id), null, ()=>{ slotSaving = false; });
      }
    }
    if(!USE_API) clearDraft();
    slNoHw = false; slTmpVals = null;
    slotEdit = null;
    save();
    renderAll();
    toast('已打卡：本次无作业');
    return;
  }
  const total = parseInt(document.getElementById('sl-total').value, 10);
  const correct = parseInt(document.getElementById('sl-correct').value, 10);
  if(isNaN(total) || total<=0){ slError('请填写有效的总题数', 'sl-total'); return; }
  if(isNaN(correct) || correct<0 || correct>total){ slError('正确题目数需在 0 到总题数之间', 'sl-correct'); return; }
  const wrongs = document.getElementById('sl-wrongs').value.split(/[,，、\s]+/).map(s=>s.trim()).filter(Boolean);
  if(correct < total && wrongs.length === 0){ slError('正确题目数小于总题数，请填写错题号', 'sl-wrongs'); return; }
  slotSaving = true;
  if(r){
    if(!canWriteOwner(r.ownerId)){ slotSaving = false; toast('没有权限操作该数据'); return; }
    r.date = date; r.total = total; r.correct = correct; r.wrongs = wrongs; r.noHomework = false;  // 无作业 → 正常转换
    logAction('修改作业', 'record', auditStuDesc(slotEdit.gid, slotEdit.subject),
      '日期 ' + date + '，总 ' + total + ' 对 ' + correct + '（正确率 ' + Math.round(correct/total*100) + '%）', {ownerId: r.ownerId});
    apiPersist(HttpApi.updateRecord(r.id, {date: date, total: total, correct: correct, wrongs: wrongs, subject: r.subject, noHomework: false}),
      rr=>{ clearDraft(); if(rr && rr.pushed) toast('作业成绩已推送给家长'); },
      ()=>{ slotSaving = false; });
  } else {
    const newRec = {id:uid(), studentId:slotEdit.gid, date:date, total:total, correct:correct,
      wrongs:wrongs, subject:slotEdit.subject, images:[], pdfs:[], ownerId:st0.ownerId};
    if(miss && USE_API){ await saveMakeupApi(miss, newRec, gid0, sub0); return; }
    pool.records.push(newRec);
    logAction(miss ? '补录作业' : '录入作业', 'record', auditStuDesc(slotEdit.gid, slotEdit.subject),
      '日期 ' + date + '，总 ' + total + ' 对 ' + correct + '（正确率 ' + Math.round(correct/total*100) + '%）', {ownerId: st0.ownerId});
    apiPersist(HttpApi.addRecord({id: newRec.id, studentId: newRec.studentId, date: date, total: total, correct: correct,
      wrongs: wrongs, subject: newRec.subject, images: newRec.images, pdfs: newRec.pdfs}),
      rr=>{ clearDraft(); if(rr && rr.pushed) toast('作业成绩已推送给家长'); },  // id 客户端生成并贯穿，不再回填
      ()=>{ slotSaving = false; });
    if(miss){
      miss.resolved = true; miss.resolution = 'made-up'; miss.resolvedAt = todayStr();  // 补录成功：该次未交视为已补交（留痕），不再占用打卡格子
      logAction('补交未交', 'missed', auditStuDesc(miss.studentId, miss.subject), '原未交日期 ' + miss.date, {ownerId: miss.ownerId});
      apiPersist(HttpApi.resolveMissed(miss.id), null, ()=>{ slotSaving = false; });
    }
  }
  if(!USE_API) clearDraft();
  slTmpVals = null;  // 正常保存后清掉无作业切换的暂存值
  slotEdit = null;
  save();
  renderAll();
}
/* 删除当次打卡记录 */
function deleteSlot(){
  if(!slotEdit) return;
  // 按稳定身份复核（v1.8.0 BUG-02）：仅 rec 可删，按 refId 确认对象仍存在与归属
  const r = slotEdit.refType==='rec' ? (state.records.find(x=>x.id===slotEdit.refId) || null) : null;
  if(!r){ toast('该记录已被删除或不可删除'); slotEdit = null; renderAll(); return; }
  if(!canWriteOwner(r.ownerId)){ toast('没有权限操作该数据'); return; }
  const gid0 = slotEdit.gid, sub0 = slotEdit.subject;
  const pos = slotEditItem().pos || slotEdit.idx;
  askConfirm('删除作业记录', '确定删除第 ' + pos + ' 次作业记录（' + r.date + '）？此操作不可恢复。', ()=>{
      pool.records = pool.records.filter(x=>x.id!==r.id);
      logAction('删除作业', 'record', auditStuDesc(slotEdit.gid, slotEdit.subject),
        '日期 ' + r.date + '，总 ' + r.total + ' 对 ' + r.correct, {ownerId: r.ownerId});
      apiPersist(HttpApi.deleteRecord(r.id), ()=>draftSave(gid0, sub0, 'slot', null));
      if(!USE_API) draftSave(gid0, sub0, 'slot', null);
      slotEdit = null;
      save();
      renderAll();
    });
}
