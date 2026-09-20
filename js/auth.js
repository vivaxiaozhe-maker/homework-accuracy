/* 账号与权限管理：科目管理/推送开关（教务设置）、科目重命名、学生弹窗与历史学生、登录会话、账号管理、解绑审批、审计页 */
/* ================= 科目管理（教务；数据管理页） =================
   一级分类可增删改（分区卡片标题行右侧按钮）；管理集中在三个级别。
   编辑在内存草稿 subjTreeDraft 上进行，「保存科目树」整体提交（API：PUT /api/subjects；mock：localStorage 覆盖值）。
   删除保护：该路径下已有作业记录时确认文案提示数量，删除仅移出菜单、历史数据保留。 */
let subjTreeDraft = null;
function renderSubjectMgmt(){
  const card = document.getElementById('subj-mgmt-card');
  if(!card) return;
  if(!isAdminView()){ card.style.display = 'none'; return; }
  card.style.display = '';
  if(!subjTreeDraft) subjTreeDraft = JSON.parse(JSON.stringify(subjectTree()));
  let html = '';
  Object.keys(subjTreeDraft).forEach(l1=>{
    // 一级：分区卡片，标题行右侧操作按钮（重命名/删除，与二级系列行同款排布）
    html += '<div class="st-cat"><div class="st-l1row"><b>' + esc(l1) + '</b><span class="st-ops">' +
      '<button class="btn ghost sm st-edit" onclick="subjUiRenameL1(\'' + esc(l1) + '\')">重命名</button>' +
      '<button class="btn danger sm" onclick="subjDelete([\'' + esc(l1) + '\'])">删除</button></span></div>';
    Object.keys(subjTreeDraft[l1]).forEach(l2=>{
      const kids = subjTreeDraft[l1][l2];
      // 二级：一行一个系列——名居左，操作按钮右对齐同行
      html += '<div class="st-l2"><b>' + esc(l2) + '</b><span class="st-ops">' +
        '<button class="btn ghost sm" onclick="subjUiAddSubject(\'' + esc(l1) + '\',\'' + esc(l2) + '\')">+ 科目</button>' +
        '<button class="btn ghost sm st-edit" onclick="subjUiRenameSeries(\'' + esc(l1) + '\',\'' + esc(l2) + '\')">重命名</button>' +
        '<button class="btn danger sm" onclick="subjDelete([\'' + esc(l1) + '\',\'' + esc(l2) + '\'])">删除</button></span></div>';
      // 三级：标签流（仅名称 + 小 ×），自动换行
      if(kids && kids.length){
        html += '<div class="st-l3s">' + kids.map(l3=>
          '<span class="tag sample">' + esc(l3) +
          ' <i class="st-x" onclick="subjDelete([\'' + esc(l1) + '\',\'' + esc(l2) + '\',\'' + esc(l3) + '\'])">✕</i></span>').join('') + '</div>';
      }
    });
    // 每个一级分区底部「+ 系列」
    html += '<div class="st-add"><button class="btn ghost sm" onclick="subjUiAddSeries(\'' + esc(l1) + '\')">+ 系列</button></div></div>';
  });
  html += '<div style="margin-top:4px"><button class="btn ghost sm" onclick="subjUiAddCategory()">+ 新增一级分类</button></div>';
  document.getElementById('subj-tree-editor').innerHTML = html;
}
/* 该路径（前缀）下已有作业记录数：删除保护用 */
function subjRefCount(prefix){
  return pool.records.filter(r=>r.subject===prefix || (r.subject||'').indexOf(prefix + ' / ')===0).length;
}
/* ---- 增（UI 走统一输入弹窗 askInput；逻辑函数可被测试直接调用） ---- */
function subjAddL1(name){
  name = (name||'').trim();
  if(!name){ toast('请输入分类名称'); return; }
  if(subjTreeDraft[name]){ toast('该分类已存在'); return; }
  subjTreeDraft[name] = {};
  renderSubjectMgmt();
}
function subjAddL2(l1, name){
  name = (name||'').trim();
  if(!name){ toast('请输入系列名称'); return; }
  if(!subjTreeDraft[l1]) return;
  if(subjTreeDraft[l1][name] !== undefined){ toast('该系列已存在'); return; }
  subjTreeDraft[l1][name] = null;  // 无三级科目的系列为 null
  renderSubjectMgmt();
}
function subjAddL3(l1, l2, name){
  name = (name||'').trim();
  if(!name){ toast('请输入科目名称'); return; }
  if(!subjTreeDraft[l1] || subjTreeDraft[l1][l2] === undefined) return;
  if(subjTreeDraft[l1][l2] === null) subjTreeDraft[l1][l2] = [];
  if(subjTreeDraft[l1][l2].indexOf(name) !== -1){ toast('该科目已存在'); return; }
  subjTreeDraft[l1][l2].push(name);
  renderSubjectMgmt();
}
function subjUiAddSeries(l1){
  askInput('在「' + l1 + '」下新增系列', '', name=>subjAddL2(l1, name));
}
function subjUiAddSubject(l1, l2){
  askInput('在「' + l2 + '」下新增科目', '', name=>subjAddL3(l1, l2, name));
}
function subjUiAddCategory(){
  askInput('新增一级分类', '', name=>subjAddL1(name));
}
/* ---- 重命名（一级分类/二级系列；保持顺序） ---- */
function subjRenameL1(l1, nn){
  nn = (nn||'').trim();
  if(!nn || nn===l1){ if(!nn) toast('名称不能为空'); return; }
  if(subjTreeDraft[nn]){ toast('该名称已存在'); return; }
  const rebuilt = {};
  Object.keys(subjTreeDraft).forEach(k=>{ rebuilt[k===l1 ? nn : k] = subjTreeDraft[k]; });  // 保持顺序
  subjTreeDraft = rebuilt;
  renderSubjectMgmt();
}
function subjRenameL2(l1, l2, nn){
  nn = (nn||'').trim();
  if(!nn || nn===l2){ if(!nn) toast('名称不能为空'); return; }
  if(subjTreeDraft[l1][nn] !== undefined){ toast('该名称已存在'); return; }
  const rebuilt = {};
  Object.keys(subjTreeDraft[l1]).forEach(k=>{ rebuilt[k===l2 ? nn : k] = subjTreeDraft[l1][k]; });
  subjTreeDraft[l1] = rebuilt;
  renderSubjectMgmt();
}
function subjUiRenameSeries(l1, l2){
  askInput('重命名系列「' + l2 + '」', l2, nn=>subjRenameL2(l1, l2, nn));
}
function subjUiRenameL1(l1){
  askInput('重命名分类「' + l1 + '」', l1, nn=>subjRenameL1(l1, nn));
}
/* ---- 删（二次确认；已有记录时提示数量，历史数据保留） ---- */
function subjDelete(path){
  const prefix = path.join(' / ');
  const n = subjRefCount(prefix);
  const label = path.length===1 ? '分类' : (path.length===2 ? '系列' : '科目');
  askConfirm('删除' + label,
    '确定删除「' + prefix + '」吗？' +
    (n > 0 ? '该科目已有 ' + n + ' 条记录，删除后仅不再出现在菜单，历史数据保留。' : '删除后不再出现在科目菜单。'),
    ()=>{
      if(path.length===1) delete subjTreeDraft[path[0]];
      else if(path.length===2) delete subjTreeDraft[path[0]][path[1]];
      else { const arr = subjTreeDraft[path[0]][path[1]]; const i = arr.indexOf(path[2]); if(i>=0) arr.splice(i,1); }
      renderSubjectMgmt();
    });
}
/* ---- 保存：整体提交；成功后缓存更新，三级联动/图表/看板立即用新树 ---- */
async function saveSubjectsDraft(){
  const tree = subjTreeDraft || subjectTree();
  const r = await Api.saveSubjects(tree);  // mock 同步返回、API 异步，await 兼容
  if(r && r.ok === false){ toast(r.msg || '保存失败'); return; }
  subjectTreeCache = JSON.parse(JSON.stringify(tree));  // API 模式缓存立即生效
  subjTreeDraft = JSON.parse(JSON.stringify(tree));
  toast('科目树已保存，录入与统计即时生效');
  renderAll();
}
document.getElementById('btn-subj-save').addEventListener('click', ()=>{ saveSubjectsDraft(); });
document.getElementById('btn-subj-reset').addEventListener('click', ()=>{
  askConfirm('恢复默认科目树', '确定恢复为内置默认科目树吗？自定义的分类/系列/科目将被移除（历史数据保留）。', async ()=>{
    subjTreeDraft = JSON.parse(JSON.stringify(SUBJECT_TREE));
    await saveSubjectsDraft();
  });
});

/* ================= 微信自动推送开关（教务管理页，仅教务可改；mock 隐藏） ================= */
/* ================= 微信自动推送开关（教务管理页，仅教务可改；mock 隐藏） ================= */
/* 配置结构：{homework:{enabled:false,max:3}, ...}；老布尔格式（{homework:false}）读入时归一化 */
const PUSH_CFG_DEFAULT = { homework:{enabled:false,max:3}, mockBook:{enabled:false,max:3}, mockScore:{enabled:false,max:3} };
function normalizePushCfg(raw){
  const out = {};
  ['homework','mockBook','mockScore'].forEach(k=>{
    const v = raw && raw[k];
    if(v && typeof v === 'object') out[k] = { enabled: !!v.enabled, max: Math.min(10, Math.max(1, parseInt(v.max, 10) || 3)) };
    else out[k] = { enabled: !!v, max: 3 };  // 旧布尔格式兼容
  });
  return out;
}
let pushConfigCache = normalizePushCfg(null);
async function refreshPushConfig(){
  const card = document.getElementById('push-config-card');
  if(!card) return;
  card.style.display = (isAdminView() && USE_API) ? '' : 'none';  // mock 演示环境无微信，隐藏
  if(!USE_API) return;
  const r = await HttpApi._req('GET', '/api/push-config');
  pushConfigCache = (r && r.ok && r.config) ? normalizePushCfg(r.config) : normalizePushCfg(null);
  renderPushConfig();
}
function renderPushConfig(){
  ['homework','mockBook','mockScore'].forEach(k=>{
    const b = document.getElementById('push-cfg-' + k);
    if(b) b.classList.toggle('on', pushConfigCache[k].enabled);  // classList.toggle(c,f) 桩兼容
    const n = document.getElementById('push-max-' + k);
    if(n) n.textContent = String(pushConfigCache[k].max);  // textContent 数字在桩里不自动转字符串，显式 String()
  });
}
async function savePushConfigPatch(patch){
  const r = await HttpApi._req('PUT', '/api/push-config', { config: patch });
  if(!r.ok){ toast(r.msg || '保存失败'); return false; }
  pushConfigCache = normalizePushCfg(r.config);
  renderPushConfig();
  return true;
}
async function togglePushConfig(k){
  if(!isAdminView()) return;
  if(!USE_API){ toast('演示环境暂不支持'); return; }
  const ok = await savePushConfigPatch({ [k]: { enabled: !pushConfigCache[k].enabled } });
  if(ok) toast(pushConfigCache[k].enabled ? '已开启自动推送' : '已关闭自动推送');
}
/* 每 10 分钟最大推送次数步进（1–10），即改即存 */
async function pushMaxStep(k, d){
  if(!isAdminView()) return;
  if(!USE_API){ toast('演示环境暂不支持'); return; }
  const cur = pushConfigCache[k].max;
  const next = Math.min(10, Math.max(1, cur + d));
  if(next === cur) return;
  const ok = await savePushConfigPatch({ [k]: { max: next } });
  if(ok) toast('已设为每 10 分钟最多 ' + next + ' 次');
}

/* ================= 科目重命名 ================= */
let renaming = null;  // {gid: 学生代表id, subject: 科目路径}
function startRenameSubject(gid, subject, ev){
  if(ev) ev.stopPropagation();  // 避免触发 Tab 的快速录入
  renaming = {gid:gid, subject:subject};
  renderStats();
  const inp = document.getElementById('ren-input');
  if(inp){ inp.focus(); inp.select(); }
}
function cancelRename(){
  renaming = null;
  renderStats();
}
function saveRenameSubject(){
  if(!renaming) return;
  const oldName = renaming.subject;
  const newName = document.getElementById('ren-input').value.trim();
  if(!newName){ toast('科目名不能为空'); return; }
  if(newName === oldName){ renaming = null; renderStats(); return; }
  const repStu = state.students.find(s=>s.id===renaming.gid);
  if(!repStu){ renaming = null; renderStats(); return; }
  // 该学生（含同名组）的全部学生 id
  const ids = state.students.filter(s=>!s.archived && s.name.trim()===repStu.name.trim()).map(s=>s.id);
  // 重名检查：该学生已有其他科目叫新名字
  const dup = state.records.some(r=>ids.includes(r.studentId) && r.subject===newName) ||
    state.missed.some(m=>ids.includes(m.studentId) && m.subject===newName) ||
    ids.some(id=>{ const st = state.students.find(x=>x.id===id); return !!(st && Array.isArray(st.subjects) && st.subjects.includes(newName)); });
  if(dup){ toast('该学生已有科目「' + newName + '」，不能重复命名。'); return; }
  // API 模式持久化快照（本地乐观更新前捕获受影响行）
  const snap = {
    recs: pool.records.filter(x=>ids.includes(x.studentId) && x.subject===oldName).map(r=>({id:r.id, date:r.date, total:r.total, correct:r.correct, wrongs:r.wrongs})),
    miss: pool.missed.filter(x=>ids.includes(x.studentId) && x.subject===oldName && !x.resolved).map(m=>({id:m.id, date:m.date}))
  };
  // 同步更新：作业记录、未交记录、手动科目列表
  state.records.forEach(r=>{ if(ids.includes(r.studentId) && r.subject===oldName) r.subject = newName; });
  state.missed.forEach(m=>{ if(ids.includes(m.studentId) && m.subject===oldName) m.subject = newName; });
  state.students.forEach(s=>{
    if(ids.includes(s.id) && Array.isArray(s.subjects)){
      const i = s.subjects.indexOf(oldName);
      if(i!==-1) s.subjects[i] = newName;
    }
  });
  // 同步老师评语的科目键名
  state.students.forEach(s=>{
    if(ids.includes(s.id) && s.subjComments && s.subjComments[oldName] !== undefined){
      s.subjComments[newName] = s.subjComments[oldName];
      delete s.subjComments[oldName];
    }
  });
  // 同步模考数据的科目键名
  state.students.forEach(s=>{
    if(ids.includes(s.id) && s.mock && s.mock[oldName] !== undefined){
      s.mock[newName] = s.mock[oldName];
      delete s.mock[oldName];
    }
  });
  // 同步应完成作业次数（打卡计划）的科目键名
  state.students.forEach(s=>{
    if(ids.includes(s.id) && s.subjPlans && s.subjPlans[oldName] !== undefined){
      s.subjPlans[newName] = s.subjPlans[oldName];
      delete s.subjPlans[oldName];
    }
  });
  // 若该科目的快速录入面板正打开，同步更新
  if(quickEntry && quickEntry.gid===renaming.gid && quickEntry.subject===oldName){
    quickEntry.subject = newName;
  }
  if(slotEdit && slotEdit.gid===renaming.gid && slotEdit.subject===oldName){
    slotEdit.subject = newName;
  }
  renaming = null;
  logAction('重命名科目', 'student', repStu.name, oldName + ' → ' + newName, {ownerId: repStu.ownerId});
  apiRenameSubjectPersist(repStu, ids, oldName, newName, snap);  // API 模式异步持久化（失败重取回滚）
  save();
  renderAll();
}
/* API 模式科目重命名持久化：作业记录/未交逐条改科目 + 学生 JSON 列整体提交（本地已先行乐观更新） */
async function apiRenameSubjectPersist(repStu, ids, oldName, newName, snap){
  if(!USE_API) return;
  try{
    for(const r of snap.recs){
      const res = await HttpApi.updateRecord(r.id, {date: r.date, total: r.total, correct: r.correct, wrongs: r.wrongs, subject: newName});
      if(!res.ok) throw new Error('rec');
    }
    for(const m of snap.miss){
      const res = await HttpApi._req('PUT', '/api/missed/' + m.id, {date: m.date, subject: newName});
      if(!res.ok) throw new Error('miss');
    }
    for(const sid of ids){
      const st = pool.students.find(x=>x.id===sid);
      if(st){
        const res = await HttpApi.updateSubjFields(sid, {subjects: st.subjects || [], subjComments: st.subjComments || {}, subjAdvice: st.subjAdvice || {}, mock: st.mock || {}});
        if(!res.ok) throw new Error('fields');
      }
    }
  }catch(e){
    toast('保存失败，请检查网络后重试');
    resyncState();
  }
}
/* API 模式删除科目持久化：逐条删除该科目作业记录/未交 + 学生 JSON 列整体提交 */
async function apiDeleteSubjectPersist(ids, snap){
  if(!USE_API) return;
  try{
    for(const r of snap.recs){ const res = await HttpApi.deleteRecord(r.id); if(!res.ok) throw 0; }
    for(const m of snap.miss){ const res = await HttpApi.deleteMissed(m.id); if(!res.ok) throw 0; }
    for(const sid of ids){
      const st = pool.students.find(x=>x.id===sid);
      if(st){
        const res = await HttpApi.updateSubjFields(sid, {subjects: st.subjects || [], subjComments: st.subjComments || {}, subjAdvice: st.subjAdvice || {}, mock: st.mock || {}});
        if(!res.ok) throw 0;
      }
    }
  }catch(e){ toast('保存失败，请检查网络后重试'); resyncState(); }
}
/* 删除科目：清除该科目下的全部关联数据（同名组合并处理），带确认 */
function deleteSubject(){
  if(!renaming) return;
  const oldName = renaming.subject;
  const repStu = state.students.find(s=>s.id===renaming.gid);
  if(!repStu){ renaming = null; renderStats(); return; }
  const ids = state.students.filter(s=>!s.archived && s.name.trim()===repStu.name.trim()).map(s=>s.id);
  const nRecs = state.records.filter(r=>ids.includes(r.studentId) && r.subject===oldName).length;
  const nMiss = state.missed.filter(m=>ids.includes(m.studentId) && m.subject===oldName).length;
  askConfirm('删除科目', '确定删除科目「' + oldName + '」吗？该科目下的 ' + nRecs + ' 条作业记录' +
    (nMiss? '、' + nMiss + ' 条未交记录' : '') +
    '，以及打卡计划、老师评语、模考信息将一并清除，此操作不可恢复。', ()=>{
    // API 模式持久化快照（本地删除前捕获受影响行）
    const snap = {
      recs: pool.records.filter(x=>ids.includes(x.studentId) && x.subject===oldName).map(r=>({id:r.id})),
      miss: pool.missed.filter(x=>ids.includes(x.studentId) && x.subject===oldName).map(m=>({id:m.id}))
    };
    pool.records = pool.records.filter(r=>!(ids.includes(r.studentId) && r.subject===oldName));
    pool.missed = pool.missed.filter(m=>!(ids.includes(m.studentId) && m.subject===oldName));
    state.students.forEach(s=>{
      if(ids.includes(s.id)){
        if(Array.isArray(s.subjects)) s.subjects = s.subjects.filter(x=>x!==oldName);
        if(s.subjComments) delete s.subjComments[oldName];
        if(s.mock) delete s.mock[oldName];
        if(s.subjPlans) delete s.subjPlans[oldName];
      }
    });
    // 关闭指向该科目的各种编辑状态
    if(quickEntry && ids.includes(quickEntry.gid) && quickEntry.subject===oldName) quickEntry = null;
    if(slotEdit && ids.includes(slotEdit.gid) && slotEdit.subject===oldName) slotEdit = null;
    if(mockEdit && ids.includes(mockEdit.gid) && mockEdit.subject===oldName) mockEdit = null;
    renaming = null;
    logAction('删除科目', 'student', repStu.name, oldName + '（含 ' + nRecs + ' 条作业记录）', {ownerId: repStu.ownerId});
    apiDeleteSubjectPersist(ids, snap);  // API 模式异步持久化（失败重取回滚）
    save();
    renderAll();
  });
}

/* ================= 新增/编辑学生弹窗 & 历史学生 ================= */
let editStuIds = null;  // null=新增；数组=正在编辑的同名组学生 id
function initGradYears(){
  const sel = document.getElementById('ns-gradyear');
  const y = new Date().getFullYear();
  let html = '<option value="">选择毕业年份…</option>';
  for(let i=0;i<11;i++) html += '<option value="' + (y+i) + '">' + (y+i) + ' 年</option>';
  sel.innerHTML = html;
}
document.getElementById('btn-open-add-stu').addEventListener('click', ()=>{
  editStuIds = null;
  document.getElementById('ns-title').textContent = '新增在服务学生';
  document.getElementById('ns-desc').textContent = '录入学生的基本信息，之后即可在「现有学生」明细中为其录入作业。';
  document.getElementById('ns-name').value = '';
  document.getElementById('ns-school').value = '';
  initGradYears();
  document.getElementById('stu-modal').classList.add('show');
});
// 点击明细卡姓名 → 编辑该同名组学生的信息
function openEditStudent(ids){
  const group = state.students.filter(s=>ids.includes(s.id));
  if(!group.length) return;
  editStuIds = ids;
  const rep = group.find(s=>s.school || s.gradYear) || group[0];
  document.getElementById('ns-title').textContent = '修改学生信息';
  document.getElementById('ns-desc').textContent = '修改会应用到「' + rep.name + '」的全部档案，作业记录自动跟随。';
  document.getElementById('ns-name').value = rep.name;
  document.getElementById('ns-school').value = rep.school || '';
  initGradYears();
  document.getElementById('ns-gradyear').value = rep.gradYear || '';
  document.getElementById('stu-modal').classList.add('show');
}
document.getElementById('ns-cancel').addEventListener('click', ()=>document.getElementById('stu-modal').classList.remove('show'));
document.getElementById('ns-ok').addEventListener('click', ()=>{
  const name = document.getElementById('ns-name').value.trim();
  const school = document.getElementById('ns-school').value.trim();
  const gradYear = document.getElementById('ns-gradyear').value;
  if(!name){ toast('请输入学生姓名'); return; }
  if(!gradYear){ toast('请选择毕业年份'); return; }
  if(editStuIds){
    // 越权防护：只能编辑可见范围内的学生
    const denied = editStuIds.some(id=>{ const s = pool.students.find(x=>x.id===id); return !s || !canWriteOwner(s.ownerId); });
    if(denied){ toast('没有权限操作该数据'); return; }
    // 编辑模式：同名冲突检查（排除本组）
    const clash = activeStudents().some(s=>!editStuIds.includes(s.id) && s.name.trim()===name);
    if(clash){ toast('已有另一位同名学生「' + name + '」，不能改成相同姓名。'); return; }
    pool.students.forEach(s=>{ if(editStuIds.includes(s.id)){ s.name = name; s.school = school; s.gradYear = gradYear; } });
    const firstStu = pool.students.find(x=>editStuIds.includes(x.id));
    logAction('修改学生信息', 'student', name, (school || '无学校') + (gradYear ? ' · ' + gradYear + ' 届' : ''), {ownerId: firstStu ? firstStu.ownerId : undefined});
    apiPersist(HttpApi.updateStudent(editStuIds[0], {name: name, school: school, gradYear: gradYear}));  // 后端会同步同名组
  } else {
    if(!canWriteOwner(writeOwnerId())){ toast('没有权限操作该数据'); return; }  // 销售等只读角色不可新增
    if(activeStudents().some(s=>s.name.trim()===name)){ toast('「' + name + '」已在现有学生中，同名不能重复录入。'); return; }
    const newStu = {id:uid(), name, school, gradYear, ownerId:writeOwnerId()};
    pool.students.push(newStu);
    logAction('新增学生', 'student', name, (school || '无学校') + (gradYear ? ' · ' + gradYear + ' 届' : ''));
    // id 由客户端生成并贯穿（后端采用同一 id，引用从此恒定）；仅回填 createdAt 供排序
    apiPersist(HttpApi.addStudent({id: newStu.id, name: name, school: school, gradYear: gradYear}),
      r=>{ if(r.student && r.student.createdAt) newStu.createdAt = r.student.createdAt; });
  }
  save();
  document.getElementById('stu-modal').classList.remove('show');
  renderAll();
});

/* 归档 / 恢复学生（按同名组操作，作业记录保留） */
function archiveGroup(ids){
  const denied = ids.some(id=>{ const s = pool.students.find(x=>x.id===id); return !s || !canWriteOwner(s.ownerId); });
  if(denied){ toast('没有权限操作该数据'); return; }
  askConfirm('转为历史学生', '该学生将从「现有学生」移到「历史学生」，录入下拉中不再出现；科目、作业记录、打卡、评语、模考等数据完整保留，可在历史板块查看（恢复为现有学生后可继续编辑）。确定吗？', ()=>{
    pool.students.forEach(s=>{ if(ids.includes(s.id)) s.archived = true; });
    const st0 = pool.students.find(x=>x.id===ids[0]);
    logAction('归档学生', 'student', st0 ? st0.name : '', '转为历史学生', {ownerId: st0 ? st0.ownerId : undefined});
    apiPersist(HttpApi.setStudentArchived(ids[0], true));  // 后端同步同名组
    save(); renderAll();
  });
}
function restoreGroup(ids){
  const denied = ids.some(id=>{ const s = pool.students.find(x=>x.id===id); return !s || !canWriteOwner(s.ownerId); });
  if(denied){ toast('没有权限操作该数据'); return; }
  pool.students.forEach(s=>{ if(ids.includes(s.id)) s.archived = false; });
  const st0 = pool.students.find(x=>x.id===ids[0]);
  logAction('恢复学生', 'student', st0 ? st0.name : '', '恢复为现有学生', {ownerId: st0 ? st0.ownerId : undefined});
  apiPersist(HttpApi.setStudentArchived(ids[0], false));
  save(); renderAll();
}

/* 历史学生列表（完整明细同步：科目正确率、评语、模考、打卡计划、未交记录；只读查看） */
let alumniQuery = '';  // 历史学生搜索词（姓名/学校部分匹配）
document.getElementById('alumni-search').addEventListener('input', function(){
  alumniQuery = this.value.trim();
  renderAlumni();
});
function renderAlumni(){
  const list = document.getElementById('alumni-list');
  const groups = [];
  archivedStudents().forEach(s=>{
    const key = (s.ownerId||'') + '|' + s.name.trim();
    let g = groups.find(x=>x.key===key);
    if(!g){ g = {key:key, name:s.name.trim(), ownerId:s.ownerId||'', ids:[], school:'', gradYear:'', sample:false}; groups.push(g); }
    g.ids.push(s.id);
    if(s.sample) g.sample = true;
    if(s.school) g.school = s.school;
    if(s.gradYear) g.gradYear = s.gradYear;
  });
  // 首字母筛选条（所有角色可见；与姓名/学校搜索叠加取交集）
  const alLb = document.getElementById('alumni-letter-bar');
  if(alLb) alLb.innerHTML = letterBarHtml(alumniLetters, 'alumni');
  // 姓名/学校搜索 + 首字母筛选叠加过滤
  const filtered = groups.filter(g=>(!alumniQuery || g.name.indexOf(alumniQuery)!==-1 || (g.school||'').indexOf(alumniQuery)!==-1) && matchLetters(g.name, alumniLetters));
  // 销售视角：无关键字只展示示例历史学生（演示用），真实学生仍需搜索
  if(isSalesView()){
    if(USE_API){ renderSalesApiList(list, true); return; }  // API 模式：搜索走服务端
    if(!alumniQuery){
      const demo = groups.filter(g=>g.sample && matchLetters(g.name, alumniLetters));
      list.innerHTML = demo.length
        ? '<p class="hint" style="margin-bottom:10px">以下为示例历史学生（演示用）；查询真实学生请输入姓名或学校：</p>' + demo.map(g=>salesStuCard(g, true)).join('')
        : '<p class="hint">' + (alumniLetters.length ? '没有匹配该首字母的示例历史学生。' : '输入学生姓名或学校进行查询') + '</p>';
      return;
    }
    list.innerHTML = filtered.length
      ? filtered.map(g=>salesStuCard(g, true)).join('')
      : '<p class="hint">没有匹配「' + esc(alumniQuery) + '」的历史学生。</p>';
    return;
  }
  if(!groups.length){
    list.innerHTML = '<p class="hint empty-tip"><svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect x="5" y="7" width="38" height="34" rx="6" fill="#F0F8F4"/><path d="M24 15v21M24 15c-2.5-2.8-6-3.8-10-3.8v21c4 0 7.5 1 10 3.8 2.5-2.8 6-3.8 10-3.8v-21c-4 0-7.5 1-10 3.8z" stroke="#5FB89A" stroke-width="2.2" stroke-linejoin="round"/></svg>暂无历史学生。学生毕业或结课后，可在「现有学生」明细卡中转为历史学生。</p>';
    return;
  }
  if(!filtered.length){
    list.innerHTML = '<p class="hint">没有匹配「' + esc(alumniQuery) + '」的历史学生。</p>';
    return;
  }
  list.innerHTML = filtered.map(g=>{
    const recs = state.records.filter(r=>g.ids.includes(r.studentId)).sort((a,b)=>a.date<b.date?-1:1);
    const misses = state.missed.filter(m=>g.ids.includes(m.studentId));
    const openMiss = misses.filter(m=>!m.resolved);
    const s = {id:g.ids[0], name:g.name, sample:g.sample};

    // 趋势迷你折线（最近 8 次）
    let trend = '<span class="hint">暂无记录</span>';
    if(recs.length){
      const last = recs.slice(-8);
      const pts = last.map((r,i)=>{
        const x = 6 + i*(108/Math.max(1,last.length-1 || 1));
        const y = 34 - acc(r)*0.28;
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
      trend = '<svg width="120" height="40" viewBox="0 0 120 40"><polyline points="' + pts + '" fill="none" stroke="#5FB89A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }

    // 分科目统计（含手动添加的学习科目），点击徽章可查看打卡情况（只读）
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
        const arrG = gradedRecs(arr);  // 徽章正确率排除无作业（次数含无作业——计入已完成）
        const sa = arrG.length ? Math.round(arrG.reduce((x,r)=>x+acc(r),0)/arrG.length) : null;
        const isActive = quickEntry && quickEntry.gid===s.id && quickEntry.subject===k;
        const repStuCmt = state.students.find(x=>x.id===s.id);
        const hasCmt = !!(repStuCmt && repStuCmt.subjComments && repStuCmt.subjComments[k]);
        const planCnt = (repStuCmt && repStuCmt.subjPlans && repStuCmt.subjPlans[k]) || null;
        const mockSt = (repStuCmt && repStuCmt.mock && repStuCmt.mock[k]) || {};
        const mockDate = mockSt.date || '';
        const mockScore = (mockSt.score!==undefined && mockSt.score!==null && mockSt.score!=='') ? mockSt.score : null;
        const omc = overdueMissCount(g.ids, k);
        return '<span class="sub-chip' + (isActive?' active':'') + '" onclick="toggleQuickEntry(\'' + s.id + '\',\'' + esc(k) + '\')" title="点击查看该科目打卡情况、评语与模考">' +
          '<span class="sub-name">' + esc(shortSubject(k)) + '</span>' +
          (omc>=2 ? '<span class="sub-alert" title="该科目有 ' + omc + ' 次逾期未交作业">!</span>' : '') +
          (hasCmt ? '<span class="sub-cmt-dot" title="已有老师评语"></span>' : '') +
          (mockDate ? '<span class="mock-tag booked" title="已预约 ' + esc(mockDate) + ' 模考">约</span>' : '') +
          (mockScore!==null ? '<span class="mock-tag score" title="结课模考分数">模考 ' + esc(mockScore) + '</span>' : '') +
          (sa !== null ? '<span class="acc-badge ' + accClass(sa) + '">' + sa + '%</span>' : '<span class="acc-badge" style="background:var(--cream2);color:var(--ink2)">' + (arr.length ? '—' : '未录入') + '</span>') +
          '<span class="sub-cnt" title="' + (planCnt!==null ? '已完成 ' + arr.length + ' 次，应完成 ' + planCnt + ' 次' : '已录入 ' + arr.length + ' 次') + '">' + (planCnt!==null ? arr.length + '/' + planCnt : arr.length) + ' 次</span></span>';
      }).join('') + '</div>';
    }

    // 未交记录（只读展示）
    const missHtml = '<div style="font-size:13px;color:var(--ink2);margin-top:6px">历史未交 <b style="color:var(--red)">' + misses.length + '</b> 次' +
      (openMiss.length
        ? '（含 ' + openMiss.length + ' 次未处理：' + openMiss.map(m=>m.date + (m.subject ? '（' + esc(shortSubject(m.subject)) + '）' : '')).join('、') + '）'
        : '（均已处理）') + '</div>';

    return '<div class="stu-card">' +
      '<div class="stu-head"><div class="avatar">' + esc(g.name.slice(0,1)) + '</div>' +
      '<div class="grow"><b>' + esc(g.name) + '</b>' +
      (g.school ? ' <span style="font-weight:400;font-size:12px;color:var(--ink2)">' + esc(g.school) + '</span>' : '') +
      (g.gradYear ? ' <span class="tag mint">' + g.gradYear + ' 届</span>' : '') +
      (g.ids.length>1 ? ' <span class="tag mint">同名合并 ×' + g.ids.length + '</span>' : '') +
      (g.sample?' <span class="tag sample">示例</span>':'') +
      (isAdminView() ? ' <span class="tag mint owner-tag" onclick="openTransfer([\'' + g.ids.join('\',\'') + '\'])" title="归属助教，点击可转移归属">归属：' + esc(ownerName(g.ownerId)) + '</span>' : '') + '</div>' +
      trend +
      '</div>' +
      '<div class="stu-nums"><span>历史作业 <b>' + recs.length + '</b> 次</span><span>未交次数 <b style="color:var(--red)">' + misses.length + '</b></span>' +
      (recs.length ? '<span>最近正确率 <b>' + acc(recs[recs.length-1]) + '%</b></span>' : '') +
      '<span style="margin-left:auto"><button class="btn ghost sm" onclick="restoreGroup([\'' + g.ids.join('\',\'') + '\'])">恢复为现有学生</button></span></div>' +
      subHtml +
      (quickEntry && quickEntry.gid===s.id ? qePanelHtml() : '') +
      missHtml +
      '</div>';
  }).join('');
}
/* 导出内容 = 当前视图数据（助教只导出自己名下；教务全量）+ 当前可见的操作记录 */
function buildExport(){
  const out = JSON.parse(JSON.stringify(state));
  out.auditLogs = JSON.parse(JSON.stringify(visibleAuditLogs()));
  return out;
}
document.getElementById('btn-export').addEventListener('click', ()=>{
  const blob = new Blob([JSON.stringify(buildExport(), null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '作业正确率备份-' + todayStr().replace(/-/g,'') + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
document.getElementById('btn-import').addEventListener('click', ()=>document.getElementById('f-import').click());
document.getElementById('f-import').addEventListener('change', function(e){
  const f = e.target.files[0];
  if(!f) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const data = JSON.parse(reader.result);
      if(!data || !Array.isArray(data.students) || !Array.isArray(data.records) || !Array.isArray(data.missed)){
        throw new Error('bad');
      }
      askConfirm('导入恢复', '将用备份文件替换当前数据范围的数据（共 ' + data.records.length + ' 条作业记录；助教导入时数据归属强制记为本人），确定继续吗？', ()=>{
        // 先移除当前范围内的数据，再写入导入数据
        pool.students = pool.students.filter(s=>!ownerInView(s.ownerId));
        pool.records = pool.records.filter(r=>!ownerInView(r.ownerId));
        pool.missed = pool.missed.filter(m=>!ownerInView(m.ownerId));
        // 助教导入：ownerId 强制覆盖为本人；教务导入：保留文件内 ownerId（无归属的记到教务名下）
        const targetOwner = currentUser.role==='ta' ? writeOwnerId() : null;
        ['students','records','missed'].forEach(k=>{
          data[k].forEach(it=>{ it.ownerId = targetOwner || it.ownerId || currentUser.id; pool[k].push(it); });
        });
        logAction('导入恢复', 'data', '', '导入 ' + data.students.length + ' 名学生、' + data.records.length + ' 条作业记录');
        save(); renderAll();
        toast('导入完成！');
      });
    }catch(err){ toast('文件格式不正确，请选择本工作台导出的 JSON 备份文件。'); }
  };
  reader.readAsText(f);
  e.target.value = '';
});
/* 清空当前数据范围内的示例数据（按 ownerId 分别生效） */
function clearSamplesOfView(){
  const sampleStuIds = state.students.filter(s=>s.sample).map(s=>s.id);
  pool.records = pool.records.filter(r=>!(ownerInView(r.ownerId) && (r.sample || sampleStuIds.includes(r.studentId))));
  pool.missed = pool.missed.filter(m=>!(ownerInView(m.ownerId) && (m.sample || sampleStuIds.includes(m.studentId))));
  pool.planRequests = (pool.planRequests || []).filter(r=>!(ownerInView(r.ownerId) && (r.sample || sampleStuIds.includes(r.studentId))));
  pool.auditLogs = (pool.auditLogs || []).filter(l=>!(l.sample && ownerInView(l.ownerId || l.userId)));
  pool.students = pool.students.filter(s=>!(ownerInView(s.ownerId) && s.sample));
}
function clearSamples(){
  if(USE_API){ toast('示例数据功能仅在演示环境（无后端）可用'); return; }
  if(!isAdminView()){ toast('仅教务可清理数据'); return; }
  askConfirm('清空示例数据', '将删除当前数据范围内所有标记为「示例」的学生、作业记录和未交记录，你自己录入的数据不受影响。确定吗？', ()=>{
    clearSamplesOfView();
    logAction('清空示例数据', 'data', '', '');
    save(); renderAll();
  });
}
document.getElementById('btn-clear-sample').addEventListener('click', clearSamples);
/* 教务在「全部数据」视角重载示例：按助教分发（每位助教一套）；指定助教/助教视角则只载入当前范围 */
function doLoadSampleData(){
  // 备份当前数据，防止误覆盖
  try{ localStorage.setItem('wb_ha_v2_backup', JSON.stringify(pool)); }catch(e){}
  clearSamplesOfView();
  let owners;
  if(isAdminView()){
    owners = getUsersCache().filter(u=>u.role==='ta' && !u.disabled).map(u=>u.id);
    if(!owners.length) owners = [writeOwnerId()];
  } else {
    owners = [writeOwnerId()];
  }
  owners.forEach(oid=>{ seedSamplesFor(oid); seedPlanRequestSamples(oid); seedAlumniSamples(oid); });
  if(isAdminView()){ seedAuditSamples(); } else { seedAuditSamples(writeOwnerId()); }
  logAction('重载示例数据', 'data', '', '为 ' + owners.length + ' 个账号生成示例数据');
  save(); renderAll();
}
function loadSampleData(){
  if(USE_API){ toast('示例数据功能仅在演示环境（无后端）可用'); return; }
  if(!isAdminView()){ toast('仅教务可清理数据'); return; }
  const adminAll = isAdminView();  // 教务恒为全部数据视角
  askConfirm('重新载入示例数据',
    adminAll
      ? '将为每位助教各生成一套示例数据（含作业记录、审批申请、历史学生），你自己录入的数据不受影响。确定继续吗？'
      : '将在当前数据范围重新生成示例数据（该范围原有示例数据会先清除），你自己录入的数据不受影响。确定继续吗？',
    ()=>{
      doLoadSampleData();
      toast('已载入最新示例数据（含同名合并演示）！旧数据已自动备份到本机浏览器。');
    });
}
document.getElementById('btn-load-sample').addEventListener('click', loadSampleData);
document.getElementById('btn-clear-all').addEventListener('click', ()=>{
  if(USE_API){ toast('清空功能仅在演示环境（无后端）可用'); return; }
  if(!isAdminView()){ toast('仅教务可清理数据'); return; }
  askConfirm('清空全部数据', '将删除当前数据范围内的所有学生、作业记录和未交记录（含你自己录入的数据），此操作不可恢复！建议先导出备份。确定继续吗？', ()=>{
    pool.students = pool.students.filter(s=>!ownerInView(s.ownerId));
    pool.records = pool.records.filter(r=>!ownerInView(r.ownerId));
    pool.missed = pool.missed.filter(m=>!ownerInView(m.ownerId));
    logAction('清空全部数据', 'data', '', '');
    save(); renderAll();
  });
});

/* ================= 登录与会话 ================= */
function showLogin(){
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}
function enterApp(){
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('user-name').textContent = currentUser.name;
  const rb = document.getElementById('user-role');
  rb.textContent = currentUser.role==='admin' ? '教务' : (currentUser.role==='sales' ? '销售' : '助教');
  rb.classList.toggle('admin', currentUser.role==='admin');
  // 页签显隐：教务=全部（底部 Tab 用看板替换低频的「数据管理」与「账号」，腾位给「记录」）；助教=今日/现有/历史/数据/记录；销售=仅现有/历史
  const role = currentUser.role;
  const navVis = role==='admin' ? ['today','dashboard','stats','alumni','accounts','data','audit']
    : role==='sales' ? ['stats','alumni']
    : ['today','stats','alumni','data','audit'];
  const tabVis = role==='admin' ? ['today','dashboard','stats','alumni','audit']
    : role==='sales' ? ['stats','alumni']
    : ['today','stats','alumni','data','audit'];
  ['today','dashboard','stats','alumni','accounts','data','audit'].forEach(t=>{
    document.getElementById('nav-' + t).style.display = navVis.indexOf(t)>=0 ? '' : 'none';
    document.getElementById('tab-' + t).style.display = tabVis.indexOf(t)>=0 ? '' : 'none';
  });
  // 「数据管理」页的清理数据区块仅教务可见（助教只保留导出/导入；销售无此页签）
  document.getElementById('data-clean-zone').style.display = role==='admin' ? '' : 'none';
  // 销售端搜索框提示语 + 隐藏图表卡与新增学生入口（只读查询）
  document.getElementById('stats-chart-card').style.display = role==='sales' ? 'none' : '';
  document.getElementById('btn-open-add-stu').style.display = role==='sales' ? 'none' : '';
  if(role==='sales'){
    document.getElementById('stu-search').placeholder = '输入学生姓名或学校进行查询';
  } else {
    document.getElementById('stu-search').placeholder = '按学生姓名搜索，支持部分匹配，如：林';
  }
  stuQuery = ''; alumniQuery = '';
  refreshView();
  renderAll();
  switchTab(role==='sales' ? 'stats' : 'today');
  renderMotto();
}

/* ================= 顶部温暖短句（每 10 次页面刷新换一句，给员工一点情绪价值） ================= */
const MOTTO_LIST = [
  '慢慢来，一切都来得及。',
  '今天也辛苦了，记得照顾好自己。',
  '别急，事情总会一件一件做完的。',
  '你已经做得很好了。',
  '累了就歇一会儿，喝口热茶。',
  '不必事事完美，尽力就好。',
  '照顾好学生之前，先照顾好自己。',
  '日子缓缓，自有答案。',
  '每一步都算数，哪怕走得慢一点。',
  '窗外的天气不错，记得抬头看看。',
  '放轻松，你比自己想象的更可靠。',
  '忙里偷闲不是偷懒，是充电。',
  '今天解决不了的事，明天再看也许就有办法了。',
  '被学生需要，本身就是一件温暖的事。',
  '下班后的时间，也属于你自己。',
  '不慌不忙，把每一件小事做好。'
];
/* 计数存 localStorage：每次进入主界面 count+1，每满 10 次换下一句 */
function renderMotto(){
  const el = document.getElementById('motto');
  if(!el) return;
  let st = {count: 0};
  try{ st = JSON.parse(localStorage.getItem('wb_ha_v2_motto')) || st; }catch(e){}
  st.count = (st.count || 0) + 1;
  const idx = Math.floor((st.count - 1) / 10) % MOTTO_LIST.length;
  try{ localStorage.setItem('wb_ha_v2_motto', JSON.stringify(st)); }catch(e){}
  el.textContent = MOTTO_LIST[idx];
}
/* 登录界面角色选择：助教 / 教务（默认助教） */
let loginRole = 'ta';
document.querySelectorAll('#login-role-seg .role-opt').forEach(b=>b.addEventListener('click', ()=>{
  loginRole = b.dataset.role;
  document.querySelectorAll('#login-role-seg .role-opt').forEach(x=>x.classList.toggle('active', x===b));
}));
async function doLogin(u, p, role){
  u = u!==undefined ? u : document.getElementById('login-user').value.trim();
  p = p!==undefined ? p : document.getElementById('login-pass').value;
  role = role!==undefined ? role : loginRole;
  const err = document.getElementById('login-err');
  if(!u || !p){ err.textContent = '请输入账号和密码'; return; }
  const res = await Api.login(u, p, role);
  if(!res.ok){ err.textContent = res.msg; return; }
  currentUser = res.user;
  document.getElementById('login-pass').value = '';
  err.textContent = '';
  if(USE_API && currentUser.role !== 'sales'){
    const s = await HttpApi.getState();  // 登录成功拉取服务端数据填充 pool（销售无 state 权限，M5.4 走搜索接口）
    if(s.ok){ pool = s.state; refreshView(); }
  }
  if(USE_API) await refreshUsersCache();
  if(USE_API) await refreshSubjectTree();  // 科目树缓存（录入/统计用）
  if(currentUser.mustChangePwd){ openPwdModal(true); return; }  // 首登/重置后强制改密
  enterApp();
}
/* 401 时强制回登录页（不走 logout 接口，避免递归） */
function forceLogout(){
  sessionStorage.removeItem(SS_SESSION);
  currentUser = null;
  document.getElementById('pwd-modal').classList.remove('show');
  showLogin();
}
function doLogout(){
  const r = Api.logout();
  if(r && typeof r.then === 'function') r.catch(()=>{});  // HttpApi 登出为异步，失败不阻塞本地退出
  currentUser = null;
  subjTreeDraft = null;  // 科目管理草稿随会话清空（下次登录从当前树重新初始化）
  unbindReqCache = [];   // 解绑申请缓存随会话清空
  pushConfigCache = Object.assign({}, PUSH_CFG_DEFAULT);  // 推送开关缓存复位
  if(USE_API){  // API 模式登出清空服务端快照，避免下个登录用户看到残留数据
    pool = { students: [], records: [], missed: [], planRequests: [], auditLogs: [] };
    refreshView();
  }
  document.getElementById('pwd-modal').classList.remove('show');
  document.getElementById('transfer-modal').classList.remove('show');
  showLogin();
}
document.getElementById('btn-login').addEventListener('click', ()=>doLogin());
document.getElementById('login-pass').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
document.getElementById('login-user').addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });
document.getElementById('btn-logout').addEventListener('click', doLogout);

/* ================= 修改密码（验旧密；mustChangePwd 时强制，不可取消） ================= */
let pwdForced = false;
function openPwdModal(forced){
  pwdForced = !!forced;
  document.getElementById('pwd-title').textContent = forced ? '首次登录请修改密码' : '修改密码';
  document.getElementById('pwd-desc').textContent = forced ? '为保障账号安全，请设置新密码后继续使用。' : '修改登录密码，下次登录生效。';
  document.getElementById('pwd-old').value = '';
  document.getElementById('pwd-new').value = '';
  document.getElementById('pwd-new2').value = '';
  document.getElementById('pwd-err').textContent = '';
  document.getElementById('pwd-cancel').style.display = forced ? 'none' : '';
  document.getElementById('pwd-modal').classList.add('show');
}
async function doChangePwd(oldP, newP, newP2){
  oldP = oldP!==undefined ? oldP : document.getElementById('pwd-old').value;
  newP = newP!==undefined ? newP : document.getElementById('pwd-new').value;
  newP2 = newP2!==undefined ? newP2 : document.getElementById('pwd-new2').value;
  const err = document.getElementById('pwd-err');
  if(newP !== newP2){ err.textContent = '两次输入的新密码不一致'; return; }
  const res = await Api.changePassword(oldP, newP);
  if(!res.ok){ err.textContent = res.msg; return; }
  if(currentUser) currentUser.mustChangePwd = false;  // 成功后本地同步，防同会话残留状态
  document.getElementById('pwd-modal').classList.remove('show');
  if(pwdForced){ pwdForced = false; enterApp(); }
  else toast('密码已修改，下次登录请使用新密码。');
}
document.getElementById('btn-chpwd').addEventListener('click', ()=>openPwdModal(false));
document.getElementById('pwd-cancel').addEventListener('click', ()=>document.getElementById('pwd-modal').classList.remove('show'));
document.getElementById('pwd-ok').addEventListener('click', ()=>doChangePwd());

/* ================= 教务：账号管理 ================= */
function renderAccounts(){
  const el = document.getElementById('accounts-list');
  if(!el) return;
  const users = getUsersCache();
  el.innerHTML = users.map(u=>{
    const stuCnt = pool.students.filter(s=>s.ownerId===u.id).length;
    const isSelf = currentUser && u.id===currentUser.id;
    return '<div class="acct-row">' +
      '<div class="grow"><b>' + esc(u.name) + '</b> ' +
      '<span class="tag ' + (u.role==='admin'?'amber':'mint') + '">' + (u.role==='admin'?'教务':(u.role==='sales'?'销售':'助教')) + '</span>' +
      (u.disabled ? ' <span class="tag red">已停用</span>' : '') +
      (u.mustChangePwd ? ' <span class="tag sample">待改密</span>' : '') +
      (isSelf ? ' <span class="tag sample">当前登录</span>' : '') +
      '<div class="hint" style="margin-top:2px">账号 ' + esc(u.username) + ' · 学生 ' + stuCnt + ' 人 · 创建于 ' + esc((u.createdAt||'-').slice(0,10)) + '</div>' +
      // 待改密且有初始密码：琥珀色持久展示（创建/重置写入，本人改密后由后端/本地清除）
      (u.mustChangePwd && u.tempPassword
        ? '<div class="hint" style="margin-top:2px;color:#B9802A;font-weight:600">初始密码：' + esc(u.tempPassword) + '（待本人修改）</div>'
        : '') +
      '</div>' +
      (u.role==='ta' || u.role==='sales'
        ? '<button class="btn ghost sm" onclick="resetUserPwd(\'' + u.id + '\')">重置密码</button>' +
          '<button class="btn ' + (u.disabled?'mint':'danger') + ' sm" onclick="toggleUser(\'' + u.id + '\')">' + (u.disabled?'启用':'停用') + '</button>'
        : '') +
      '</div>';
  }).join('') || '<p class="hint">暂无账号</p>';
}
/* 教务「计划修改审批」区块：待审批列表（已处理记录并入「已处理事项」统一回溯区） */
function renderPlanRequests(){
  const pendEl = document.getElementById('planreq-pending');
  if(!pendEl) return;
  const reqs = pool.planRequests || [];
  const pending = reqs.filter(r=>r.status==='pending');
  const users = getUsersCache();
  const stuNameOf = sid => { const s = pool.students.find(x=>x.id===sid); return s ? s.name : '（已删除学生）'; };
  const reqUserOf = uid2 => { const u = users.find(x=>x.id===uid2); return u ? u.name : '未知'; };
  pendEl.innerHTML = pending.length ? pending.map(r=>
    '<div class="acct-row">' +
    '<div class="grow"><b>' + esc(stuNameOf(r.studentId)) + '</b> <span class="tag mint">' + esc(shortSubject(r.subject)) + '</span>' +
    ' <b>' + r.oldPlan + ' → ' + r.newPlan + '</b> 次' +
    '<div class="hint" style="margin-top:2px">申请助教：' + esc(reqUserOf(r.requestedBy)) + ' · ' + esc(r.requestedAt) + ' · 理由：' + (r.reason ? esc(r.reason) : '—') + '</div></div>' +
    '<button class="btn mint sm" onclick="reviewPlanRequest(\'' + r.id + '\',true)">通过</button>' +
    '<button class="btn danger sm" onclick="reviewPlanRequest(\'' + r.id + '\',false)">驳回</button>' +
    '</div>').join('') : '<p class="hint">暂无待审批的修改申请。</p>';
  const cb = document.getElementById('planreq-badge-card');
  cb.style.display = pending.length ? '' : 'none';
  cb.textContent = pending.length + ' 条待审批';
}
/* ================= 解绑审批（仅教务；助教解绑家长需教务审批） =================
   数据在服务端（mock 不支持绑定，恒为空）；refreshUnbindRequests 异步自取数自渲染 */
let unbindReqCache = [];
async function refreshUnbindRequests(){
  if(!USE_API){ unbindReqCache = []; renderUnbindRequests(); renderPendingBadges(); return; }
  const r = await HttpApi._req('GET', '/api/unbind-requests?status=pending');
  unbindReqCache = (r && r.ok && Array.isArray(r.requests)) ? r.requests : [];
  renderUnbindRequests();
  renderPendingBadges();
}
function renderUnbindRequests(){
  const zone = document.getElementById('unbindreq-zone');
  if(!zone) return;
  const pend = isAdminView() ? unbindReqCache.filter(r=>r.status==='pending') : [];
  zone.style.display = pend.length ? '' : 'none';
  // 每条：解绑学生 + 归属助教 + 家长 openid 脱敏 + 申请时间 + 通过/驳回
  document.getElementById('unbindreq-pending').innerHTML = pend.map(r=>
    '<div class="acct-row">' +
    '<div class="grow"><b>' + esc(r.studentName || '（已删除学生）') + '</b> <span class="tag amber">解绑申请</span>' +
    '<div class="hint" style="margin-top:2px">归属助教：' + esc(r.ownerName || '未知') + ' · 家长 ' + esc(maskOpenid(r.openid || '')) + ' · ' + esc(String(r.requestedAt || '').slice(0, 10)) + '</div></div>' +
    '<button class="btn mint sm" onclick="reviewUnbindReq(\'' + r.id + '\',true)">通过</button>' +
    '<button class="btn danger sm" onclick="reviewUnbindReq(\'' + r.id + '\',false)">驳回</button>' +
    '</div>').join('');
  const cb = document.getElementById('unbindreq-badge-card');
  cb.style.display = pend.length ? '' : 'none';
  cb.textContent = pend.length + ' 条待审批';
}
/* 教务审批解绑：通过直接生效（绑定标失效 + bindCnt 同步）；驳回需确认 */
function reviewUnbindReq(id, approve){
  if(approve){
    (async ()=>{
      const res = await HttpApi._req('POST', '/api/unbind-requests/' + id + '/review', { approve: true });
      if(!res.ok){ toast(res.msg); return; }
      toast('已通过，该家长已解绑');
      await refreshUnbindRequests();
      resyncState();  // 学生卡 bindCnt 同步
    })();
  } else {
    askConfirm('驳回解绑申请', '确定驳回这条解绑申请吗？该家长的绑定保持不变。', async ()=>{
      const res = await HttpApi._req('POST', '/api/unbind-requests/' + id + '/review', { approve: false });
      if(!res.ok){ toast(res.msg); return; }
      toast('已驳回，绑定保持不变');
      await refreshUnbindRequests();
    });
  }
}
/* ================= 已处理事项统一回溯区（今天要处理卡片底部，近 30 天） =================
   助教：自己名下的已处理未交 + 自己提交的申请结果；教务：全部（未交条目附归属助教名）。
   30 天窗口按 resolvedAt / reviewedAt 过滤；无数据时不渲染。 */
let doneZoneExpand = false;
function renderDoneZone(){
  const zone = document.getElementById('done-zone');
  if(!zone) return;
  if(!currentUser || isSalesView()){ zone.style.display = 'none'; return; }
  const winStart = offsetDay(-29);
  const items = [];
  // 已处理未交（软删除留痕：resolution = made-up 已补交 / deleted 已删除）
  state.missed.filter(m=>m.resolved && m.resolvedAt && m.resolvedAt >= winStart).forEach(m=>{
    const st = pool.students.find(x=>x.id===m.studentId);
    items.push({ kind:'miss', at:m.resolvedAt, resolution:m.resolution || 'made-up',
      name: st ? st.name : '（已删除学生）', subject: m.subject || '', date: m.date, ownerId: m.ownerId });
  });
  // 已处理审批
  (pool.planRequests || []).filter(r=>(r.status==='approved' || r.status==='rejected') && r.reviewedAt && r.reviewedAt >= winStart)
    .forEach(r=>{
      if(!isAdminView() && r.requestedBy !== currentUser.id) return;
      const st = pool.students.find(x=>x.id===r.studentId);
      const reqUser = getUsersCache().find(u=>u.id===r.requestedBy);
      items.push({ kind:'req', at:r.reviewedAt, status:r.status,
        name: st ? st.name : '（已删除学生）', subject: r.subject, oldPlan: r.oldPlan, newPlan: r.newPlan,
        reqBy: reqUser ? reqUser.name : '未知' });
    });
  items.sort((a,b)=> a.at===b.at ? 0 : (a.at<b.at ? 1 : -1));  // 按处理时间倒序
  if(!items.length){ zone.style.display = 'none'; return; }
  zone.style.display = '';
  document.getElementById('done-zone-title').textContent = '已处理事项（近 30 天）· ' + items.length + ' 条';
  const shown = doneZoneExpand ? items : items.slice(0,10);
  let html = shown.map(it=>{
    if(it.kind==='miss'){
      const del = it.resolution==='deleted';
      return '<div class="todo-item">' +
        '<div class="grow"><span class="tag ' + (del ? '' : 'mint') + '"' + (del ? ' style="background:#EFE7D2;color:#8A7B52"' : '') + '>' + (del ? '已删除' : '已补交') + '</span>' +
        '<span class="who">' + esc(it.name) + '</span>' +
        (it.subject ? '<span class="tag mint">' + esc(shortSubject(it.subject)) + '</span>' : '') +
        (isAdminView() ? '<span class="tag sample">归属 ' + esc(ownerName(it.ownerId)) + '</span>' : '') +
        '<div style="font-size:13px;color:var(--ink2)">未交日期 ' + it.date + ' · 处理于 ' + it.at + '</div></div>' +
        '</div>';
    }
    const ap = it.status==='approved';
    return '<div class="todo-item">' +
      '<div class="grow"><span class="tag ' + (ap ? 'mint' : 'red') + '">' + (ap ? '已通过' : '已驳回') + '</span>' +
      '<span class="who">' + esc(it.name) + '</span>' +
      '<span class="tag mint">' + esc(shortSubject(it.subject)) + '</span>' +
      '<span style="font-size:13px"> ' + it.oldPlan + ' → ' + it.newPlan + ' 次</span>' +
      '<div style="font-size:13px;color:var(--ink2)">申请助教 ' + esc(it.reqBy) + ' · 处理于 ' + it.at + '</div></div>' +
      '</div>';
  }).join('');
  if(items.length > 10){
    html += '<button class="btn ghost sm" style="width:100%" onclick="doneZoneToggle()">' +
      (doneZoneExpand ? '收起' : '展开全部 ' + items.length + ' 条') + '</button>';
  }
  document.getElementById('done-list').innerHTML = html;
}
function doneZoneToggle(){ doneZoneExpand = !doneZoneExpand; renderDoneZone(); }

/* ================= 操作记录（审计回溯页签，助教/教务可见） =================
   角色口径（前端过滤，后端阶段服务端强制）：助教 = 自己的操作 + 涉及自己名下学生的日志；教务 = 全部；销售 = 无入口 */
let auditQuery = '', auditType = '', auditRange = 30, auditShown = 50;
document.getElementById('audit-search').addEventListener('input', function(){ auditQuery = this.value.trim(); auditShown = 50; renderAudit(); });
document.getElementById('audit-type').addEventListener('change', function(){ auditType = this.value; auditShown = 50; renderAudit(); });
document.getElementById('audit-range').addEventListener('change', function(){ auditRange = parseInt(this.value,10); auditShown = 50; renderAudit(); });
function visibleAuditLogs(){
  const logs = pool.auditLogs || [];
  if(!currentUser || currentUser.role==='sales') return [];
  if(currentUser.role==='admin') return logs;
  return logs.filter(l=>l.userId===currentUser.id || (l.ownerId && l.ownerId===currentUser.id));  // 助教
}
const AUDIT_TYPE_BADGE = {record:'mint', missed:'red', plan:'amber', student:'sample', account:'sample', auth:'sample', data:'sample'};
function auditRowHtml(l){
  return '<div class="audit-row">' +
    '<span class="audit-ts">' + esc(l.ts.slice(5,16)) + '</span>' +
    '<span class="audit-user">' + esc(l.userName) + '<span class="role-badge' + (l.role==='admin'?' admin':'') + '">' +
      ({admin:'教务', ta:'助教', sales:'销售'}[l.role] || l.role) + '</span></span>' +
    '<span class="tag ' + (AUDIT_TYPE_BADGE[l.targetType] || 'sample') + '">' + esc(l.action) + '</span>' +
    '<span class="audit-target">' + esc(l.targetDesc) + '</span>' +
    (l.detail ? '<div class="audit-detail">' + esc(l.detail) + '</div>' : '') +
    '</div>';
}
function renderAudit(){
  const list = document.getElementById('audit-list');
  if(!list) return;
  if(USE_API){ renderAuditApi(false); return; }  // API 模式：搜索/筛选/分页全部由服务端完成
  const cntEl = document.getElementById('audit-count');
  const moreEl = document.getElementById('audit-more');
  if(!currentUser || currentUser.role==='sales'){ list.innerHTML = ''; cntEl.textContent = ''; moreEl.innerHTML = ''; return; }
  const start = auditRange ? offsetDay(-(auditRange-1)) : null;  // 1=今天
  let logs = visibleAuditLogs().slice().reverse();  // 时间倒序
  if(start) logs = logs.filter(l=>l.ts.slice(0,10) >= start);
  if(auditType) logs = logs.filter(l=>l.targetType===auditType);
  if(auditQuery){
    const q = auditQuery;
    logs = logs.filter(l=>(l.targetDesc + ' ' + l.detail + ' ' + l.userName + ' ' + l.action).indexOf(q) !== -1);
  }
  cntEl.textContent = '共 ' + logs.length + ' 条匹配';
  const shown = logs.slice(0, auditShown);
  list.innerHTML = shown.length ? shown.map(auditRowHtml).join('') : '<p class="hint">暂无匹配的操作记录。</p>';
  moreEl.innerHTML = logs.length > auditShown
    ? '<button class="btn ghost sm" style="width:100%" onclick="auditLoadMore()">加载更多（已显示 ' + shown.length + '/' + logs.length + ' 条）</button>'
    : '';
}
/* API 模式：审计查询走服务端（GET /api/audit-logs），搜索/筛选/分页服务端完成；「加载更多」按页累加 */
let auditApiPage = 1;
const auditApiItems = [];
async function renderAuditApi(append){
  const list = document.getElementById('audit-list');
  const cntEl = document.getElementById('audit-count');
  const moreEl = document.getElementById('audit-more');
  if(!currentUser || currentUser.role==='sales'){ list.innerHTML = ''; cntEl.textContent = ''; moreEl.innerHTML = ''; return; }
  if(!append){ auditApiPage = 1; auditApiItems.length = 0; }
  const r = await HttpApi._req('GET', '/api/audit-logs?q=' + encodeURIComponent(auditQuery) +
    '&type=' + encodeURIComponent(auditType) + '&range=' + auditRange + '&page=' + auditApiPage + '&pageSize=50');
  if(!r.ok){ cntEl.textContent = r.msg || '加载失败'; return; }
  auditApiItems.push.apply(auditApiItems, r.items);
  cntEl.textContent = '共 ' + r.total + ' 条匹配';
  list.innerHTML = auditApiItems.length ? auditApiItems.map(auditRowHtml).join('') : '<p class="hint">暂无匹配的操作记录。</p>';
  moreEl.innerHTML = auditApiItems.length < r.total
    ? '<button class="btn ghost sm" style="width:100%" onclick="auditLoadMore()">加载更多（已显示 ' + auditApiItems.length + '/' + r.total + ' 条）</button>'
    : '';
}
function auditLoadMore(){
  if(USE_API){ auditApiPage++; renderAuditApi(true); return; }
  auditShown += 50; renderAudit();
}
/* 教务审批：通过直接生效；驳回需确认 */
function reviewPlanRequest(id, approve){
  if(approve){
    (async ()=>{
      const res = await Api.reviewPlanRequest(id, true);  // mock 同步、API 异步，await 兼容
      if(!res.ok){ toast(res.msg); return; }
      renderAll();
    })();
  } else {
    askConfirm('驳回申请', '确定驳回这条计划修改申请吗？学生的应完成次数将保持不变。', async ()=>{
      const res = await Api.reviewPlanRequest(id, false);
      if(!res.ok){ toast(res.msg); return; }
      renderAll();
    });
  }
}
/* 侧栏/底部 Tab「今日概览」待审批红点徽章（仅教务可见，0 不显示；计划申请 + 解绑申请合计） */
function renderPendingBadges(){
  const planN = (isAdminView() && pool.planRequests) ? pool.planRequests.filter(r=>r.status==='pending').length : 0;
  const unbindN = isAdminView() ? unbindReqCache.filter(r=>r.status==='pending').length : 0;
  const n = planN + unbindN;
  ['badge-today','badge-today-tab'].forEach(id=>{
    const el = document.getElementById(id);
    el.style.display = n > 0 ? '' : 'none';
    el.textContent = String(n);
  });
}
function resetUserPwd(id){
  const u = getUsersCache().find(x=>x.id===id);
  if(!u) return;
  askConfirm('重置密码', '将重置「' + u.name + '」的登录密码，其下次登录需使用新密码并被要求修改。确定吗？', async ()=>{
    const np = 'ta' + Math.random().toString(36).slice(2,8);
    const res = await Api.resetPassword(id, np);
    if(res.ok) toast('密码已重置为：' + np + '\n请转告该助教（销售同理），其首次登录需修改密码。');
    else toast(res.msg || '重置失败');
    await refreshUsersCache();
    renderAll();
  });
}
function toggleUser(id){
  const u = getUsersCache().find(x=>x.id===id);
  if(!u) return;
  askConfirm(u.disabled ? '启用账号' : '停用账号',
    u.disabled ? '确定重新启用「' + u.name + '」吗？' : '停用后「' + u.name + '」将无法登录，其名下学生与作业数据完整保留。确定吗？',
    async ()=>{
      const res = await Api.toggleUser(id);  // mock 同步返回、API 异步返回，await 兼容两者
      if(!res.ok){ toast(res.msg); return; }
      // 操作反馈闭环：明确告知停用/启用结果（停用数据完整保留）
      const nowDisabled = res.user ? res.user.disabled : !u.disabled;
      toast(nowDisabled ? '已停用「' + u.name + '」，其名下数据完整保留' : '已启用「' + u.name + '」');
      await refreshUsersCache();
      renderAll();
    });
}
document.getElementById('btn-create-ta').addEventListener('click', async ()=>{
  const name = document.getElementById('ac-name').value.trim();
  const username = document.getElementById('ac-username').value.trim();
  const pwd = document.getElementById('ac-password').value;
  const role = document.getElementById('ac-role').value;
  const res = await Api.createUser(name, username, pwd, role);
  if(!res.ok){ toast(res.msg); return; }
  document.getElementById('ac-name').value = '';
  document.getElementById('ac-username').value = '';
  document.getElementById('ac-password').value = '';
  await refreshUsersCache();
  renderAll();
  toast('已创建' + (role==='sales' ? '销售' : '助教') + '账号「' + name + '」，初始密码：' + pwd + '，首次登录需修改。');
});

/* ================= 教务：转移学生归属 ================= */
let transferIds = null;
function openTransfer(ids){
  if(!isAdminView()) return;
  transferIds = ids;
  const sel = document.getElementById('tf-target');
  const cur = stuOwnerId(ids[0]);
  const opts = getUsersCache().filter(u=>u.role==='ta' && !u.disabled && u.id!==cur);
  if(!opts.length){ toast('暂无可转移的目标助教'); return; }
  sel.innerHTML = opts.map(u=>'<option value="' + u.id + '">' + esc(u.name) + '（' + esc(u.username) + '）</option>').join('');
  document.getElementById('transfer-modal').classList.add('show');
}
document.getElementById('tf-cancel').addEventListener('click', ()=>document.getElementById('transfer-modal').classList.remove('show'));
document.getElementById('tf-ok').addEventListener('click', ()=>{
  const target = document.getElementById('tf-target').value;
  document.getElementById('transfer-modal').classList.remove('show');
  askConfirm('确认转移归属', '该学生的全部作业记录、未交记录将一并转移给「' + ownerName(target) + '」，确定吗？', async ()=>{
    const res = await Api.transferStudent(transferIds, target);  // mock 同步、API 异步（本地乐观+逐个调用后端），await 兼容
    if(!res.ok){ toast(res.msg); return; }
    renderAll();
  });
});

