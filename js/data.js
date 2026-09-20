/* 数据层与 Api 门面：常量/pool/state、SHA-256 散列、视图权限、审计打点、LocalApi（mock）/HttpApi、示例数据播种 */
'use strict';
/* ================= 数据层 v2（账号体系，localStorage 模拟后端） =================
   后端接口约定（Node+Express+SQLite 阶段 1:1 实现；届时用 HttpApi 替换下方 Api 实现，UI 零改动）：
   POST /api/login                {username, password} → {token, user}
   POST /api/logout
   POST /api/password             {oldPwd, newPwd}
   GET  /api/state?owner=…        教务可带 owner 参数；助教服务端强制只返回自己
   PUT  /api/state                全量/增量保存（后端阶段定）
   GET  /api/users                教务
   POST /api/users                教务创建助教
   POST /api/users/:id/reset      重置密码
   POST /api/users/:id/toggle     停用/启用
   POST /api/students/:id/owner   转移归属
   POST /api/plan-requests            助教发起计划次数修改申请
   POST /api/plan-requests/:id/cancel 撤回申请（仅申请本人）
   POST /api/plan-requests/:id/review 教务审批（通过/驳回）
   旧版 key wb_homework_accuracy_v1 检测到即忽略（不迁移、不删除）。 */
const LS_USERS = 'wb_ha_v2_users';
const LS_DATA  = 'wb_ha_v2_data';
const SS_SESSION = 'wb_ha_v2_session';
const LS_SUBJECTS = 'wb_ha_v2_subjects';  // mock 模式科目树覆盖值（API 模式以服务端 settings 为准）
const APP_VERSION = 'v1.4.1';  // 版本号：登录页/侧栏脚注共用（静态文本处手工同步）
let pool = { students: [], records: [], missed: [], planRequests: [], auditLogs: [] };   // 全量数据池（每条数据带 ownerId = 归属助教 id；planRequests = 计划次数修改申请；auditLogs = 操作审计日志）
let state = { students: [], records: [], missed: [] };  // 当前视图（viewState 过滤结果，元素与 pool 共享引用）
let currentUser = null;   // 当前登录用户对象

function todayStr(){ return fmtDate(new Date()); }
function fmtDate(d){
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
  return y + '-' + m + '-' + dd;
}
function offsetDay(n){ const d = new Date(); d.setDate(d.getDate()+n); return fmtDate(d); }
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

function save(){ localStorage.setItem(LS_DATA, JSON.stringify(pool)); }
function load(){
  try{
    const raw = localStorage.getItem(LS_DATA);
    if(raw){
      const s = JSON.parse(raw);
      if(s && Array.isArray(s.students)){
        pool = s;
        if(!Array.isArray(pool.planRequests)) pool.planRequests = [];  // 旧数据兼容补空
        if(!Array.isArray(pool.auditLogs)) pool.auditLogs = [];        // 旧数据兼容补空
        return true;
      }
    }
  }catch(e){}
  return false;
}

/* ---- 密码散列：SHA-256(salt+密码)，纯 JS 同步实现（mock 期基本保护，不存明文） ----
   说明：不使用 crypto.subtle——它在 file:// 等非安全上下文中不可用（Safari/部分浏览器），
   会导致账号播种与登录直接失败。纯 JS 实现与标准 SHA-256 结果一致，已存散列保持有效。 */
function sha256Hex(text){
  function rr(v, n){ return (v>>>n) | (v<<(32-n)); }
  // UTF-8 编码为字节数组
  const bytes = [];
  for(let i=0; i<text.length; i++){
    let c = text.charCodeAt(i);
    if(c < 0x80){ bytes.push(c); }
    else if(c < 0x800){ bytes.push(0xC0|(c>>6), 0x80|(c&63)); }
    else if(c >= 0xD800 && c <= 0xDBFF){
      const c2 = text.charCodeAt(++i);
      c = 0x10000 + ((c&0x3FF)<<10) + (c2&0x3FF);
      bytes.push(0xF0|(c>>18), 0x80|((c>>12)&63), 0x80|((c>>6)&63), 0x80|(c&63));
    }
    else { bytes.push(0xE0|(c>>12), 0x80|((c>>6)&63), 0x80|(c&63)); }
  }
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let h0=0x6a09e667, h1=0xbb67ae85, h2=0x3c6ef372, h3=0xa54ff53a,
      h4=0x510e527f, h5=0x9b05688c, h6=0x1f83d9ab, h7=0x5be0cd19;
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while(bytes.length % 64 !== 56) bytes.push(0);
  bytes.push(0,0,0,0, (bitLen>>>24)&255, (bitLen>>>16)&255, (bitLen>>>8)&255, bitLen&255);
  const w = new Array(64);
  for(let off=0; off<bytes.length; off+=64){
    for(let i=0; i<16; i++) w[i] = (bytes[off+i*4]<<24) | (bytes[off+i*4+1]<<16) | (bytes[off+i*4+2]<<8) | bytes[off+i*4+3];
    for(let i=16; i<64; i++){
      const s0 = rr(w[i-15],7) ^ rr(w[i-15],18) ^ (w[i-15]>>>3);
      const s1 = rr(w[i-2],17) ^ rr(w[i-2],19) ^ (w[i-2]>>>10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
    }
    let a=h0, b=h1, c=h2, d=h3, e=h4, f=h5, g=h6, h=h7;
    for(let i=0; i<64; i++){
      const S1 = rr(e,6) ^ rr(e,11) ^ rr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rr(a,2) ^ rr(a,13) ^ rr(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
    }
    h0=(h0+a)|0; h1=(h1+b)|0; h2=(h2+c)|0; h3=(h3+d)|0;
    h4=(h4+e)|0; h5=(h5+f)|0; h6=(h6+g)|0; h7=(h7+h)|0;
  }
  return [h0,h1,h2,h3,h4,h5,h6,h7].map(x=>(x>>>0).toString(16).padStart(8,'0')).join('');
}
function makeSalt(){ return uid() + uid(); }
function hashPwd(salt, pwd){ return sha256Hex(salt + ':' + pwd); }

/* ---- 视图过滤与权限 ---- */
// 某条 ownerId 的数据是否在当前可见范围内
// 教务恒为全部数据视角（无范围切换）；销售 mock 期可见全量（UI 只在有关键字时渲染，后端阶段由 API 强制搜索参数）
function ownerInView(ownerId){
  if(!currentUser) return false;
  if(currentUser.role === 'ta') return ownerId === currentUser.id;
  return true;  // admin / sales
}
// 当前视图：助教=自己的数据；教务/销售=全量
function viewState(){
  if(currentUser && (currentUser.role==='admin' || currentUser.role==='sales')) return pool;
  return {
    students: pool.students.filter(s=>ownerInView(s.ownerId)),
    records: pool.records.filter(r=>ownerInView(r.ownerId)),
    missed: pool.missed.filter(m=>ownerInView(m.ownerId))
  };
}
function refreshView(){ state = viewState(); }
// 新录入数据的归属：助教=自己；教务新建=教务自己（对已有学生写数据时归属该学生的助教，由各写入处取 st.ownerId）
function writeOwnerId(){
  return currentUser ? currentUser.id : null;
}
// 越权防护：编辑/删除前校验目标数据 ownerId 是否可写（教务全部可写，助教仅自己，销售恒不可写）
function canWriteOwner(ownerId){
  if(!currentUser) return false;
  if(currentUser.role==='sales') return false;  // 销售只读
  if(currentUser.role==='admin') return true;
  return ownerId === currentUser.id;
}
function isAdminView(){ return !!(currentUser && currentUser.role==='admin'); }
function isSalesView(){ return !!(currentUser && currentUser.role==='sales'); }

/* ---- 操作记录（审计日志）：mock 期 localStorage 保留最近 5000 条（FIFO 裁剪）；后端阶段进 SQLite 无上限 ---- */
function nowTs(){
  const d = new Date();
  return fmtDate(d) + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0') + ':' + String(d.getSeconds()).padStart(2,'0');
}
// 学生相关日志的对象描述：「姓名 · 科目短名」
function auditStuDesc(sid, subject){
  const s = pool.students.find(x=>x.id===sid);
  return (s ? s.name : '（已删除学生）') + (subject ? ' · ' + shortSubject(subject) : '');
}
/* 写操作打点。opts: {user} 指定操作人（登录时 currentUser 尚未赋值）；{ownerId} 记录数据归属快照（助教口径过滤用） */
function logAction(action, targetType, targetDesc, detail, opts){
  if(USE_API) return;  // API 模式审计由服务端权威打点，前端不再写本地
  const u = (opts && opts.user) || currentUser;
  if(!u) return;
  pool.auditLogs = pool.auditLogs || [];
  pool.auditLogs.push({
    id: uid(),
    ts: nowTs(),               // YYYY-MM-DD HH:mm:ss（本地时间，精确到秒）
    userId: u.id, userName: u.name, role: u.role,
    action: action,
    targetType: targetType,    // record/missed/student/plan/account/auth/data
    targetDesc: targetDesc || '',
    detail: detail || '',
    ownerId: (opts && opts.ownerId) || u.id
  });
  if(pool.auditLogs.length > 5000) pool.auditLogs = pool.auditLogs.slice(-5000);
  save();
}
function ownerName(ownerId){
  const u = getUsersCache().find(x=>x.id===ownerId);
  return u ? u.name : '未分配';
}
function stuOwnerId(sid){ const s = pool.students.find(x=>x.id===sid); return s ? s.ownerId : null; }

/* ================= Api 层 =================
   LocalApi：localStorage 驱动（演示环境）；HttpApi：真实后端（fetch + Bearer token）。
   两者方法签名一一对应（见文件头 REST 约定）；门面 Api 按启动探测结果转发，UI 代码零改动。 */
const LocalApi = {
  _users: null,
  _loadUsers(){
    if(this._users) return this._users;
    try{ this._users = JSON.parse(localStorage.getItem(LS_USERS)) || []; }catch(e){ this._users = []; }
    return this._users;
  },
  _saveUsers(){ localStorage.setItem(LS_USERS, JSON.stringify(this._users)); },
  // POST /api/login（role 可选：传则校验所选角色与账号角色一致）
  async login(username, password, role){
    const u = this._loadUsers().find(x=>x.username===username);
    if(!u) return {ok:false, msg:'账号不存在'};
    if(role && u.role !== role){
      return {ok:false, msg: u.role==='admin' ? '该账号是教务账号，请切换为「教务」角色登录' : '该账号是助教账号，请切换为「助教」角色登录'};
    }
    if(u.disabled) return {ok:false, msg:'该账号已被停用，请联系教务'};
    if(hashPwd(u.salt, password) !== u.passHash) return {ok:false, msg:'密码错误'};
    sessionStorage.setItem(SS_SESSION, JSON.stringify({uid:u.id, ts:Date.now()}));
    logAction('登录成功', 'auth', u.name + '（' + u.username + '）', '', {user: u});
    return {ok:true, user:u};
  },
  // POST /api/logout
  logout(){ sessionStorage.removeItem(SS_SESSION); },
  // 会话存 sessionStorage：刷新保持，关闭浏览器需重登
  currentSession(){
    try{
      const s = JSON.parse(sessionStorage.getItem(SS_SESSION));
      if(!s) return null;
      const u = this._loadUsers().find(x=>x.id===s.uid);
      return (u && !u.disabled) ? u : null;
    }catch(e){ return null; }
  },
  // POST /api/password
  async changePassword(oldPwd, newPwd){
    const u = currentUser;
    if(!u) return {ok:false, msg:'未登录'};
    if(!newPwd || newPwd.length < 6) return {ok:false, msg:'新密码至少 6 位'};
    const h = await hashPwd(u.salt, oldPwd);
    if(h !== u.passHash) return {ok:false, msg:'原密码不正确'};
    u.salt = makeSalt();
    u.passHash = await hashPwd(u.salt, newPwd);
    u.mustChangePwd = false;
    delete u.tempPassword;  // 本人改密成功即清除初始密码（账号管理副标题随之消失）
    this._saveUsers();
    logAction('修改密码', 'auth', u.name + '（' + u.username + '）', '');
    return {ok:true};
  },
  // GET /api/state?owner=…（视图过滤由前端 viewState 完成；后端阶段助教由服务端强制过滤）
  getState(){ return pool; },
  // PUT /api/state
  saveState(p){ pool = p; save(); refreshView(); },
  // GET /api/users（教务）
  listUsers(){ return this._loadUsers().slice(); },
  // POST /api/users（教务创建助教，账号唯一）
  async createUser(name, username, password, role){
    role = role || 'ta';
    if(!name || !username || !password) return {ok:false, msg:'请填写完整信息'};
    if(password.length < 6) return {ok:false, msg:'初始密码至少 6 位'};
    if(this._loadUsers().some(x=>x.username===username)) return {ok:false, msg:'该登录账号已存在'};
    const salt = makeSalt();
    // tempPassword：初始密码明文（仅教务账号管理页副标题展示用，待本人改密后清除）
    const u = {id:uid(), username, name, role, salt, passHash:await hashPwd(salt, password),
      disabled:false, createdAt:todayStr(), mustChangePwd:true, tempPassword:password};
    this._users.push(u); this._saveUsers();
    logAction('创建账号', 'account', name + '（' + username + '）', '角色：' + (role==='sales' ? '销售' : '助教'));
    return {ok:true, user:u};
  },
  // POST /api/users/:id/reset（重置为指定初始密码，下次登录强制改密）
  async resetPassword(id, newPwd){
    const u = this._loadUsers().find(x=>x.id===id);
    if(!u) return {ok:false, msg:'账号不存在'};
    u.salt = makeSalt();
    u.passHash = await hashPwd(u.salt, newPwd);
    u.mustChangePwd = true;
    u.tempPassword = newPwd;  // 重置后的初始密码在账号管理副标题持久显示，直到本人改密
    this._saveUsers();
    logAction('重置密码', 'account', u.name + '（' + u.username + '）', '');
    return {ok:true};
  },
  // POST /api/users/:id/toggle（停用拒登但数据保留；不能停自己，不能停最后一个教务）
  toggleUser(id){
    const u = this._loadUsers().find(x=>x.id===id);
    if(!u) return {ok:false, msg:'账号不存在'};
    if(currentUser && u.id===currentUser.id) return {ok:false, msg:'不能停用自己的账号'};
    if(u.role==='admin' && !u.disabled){
      const admins = this._users.filter(x=>x.role==='admin' && !x.disabled);
      if(admins.length<=1) return {ok:false, msg:'至少保留一个可用的教务账号'};
    }
    const act = u.disabled ? '启用账号' : '停用账号';
    u.disabled = !u.disabled;
    this._saveUsers();
    logAction(act, 'account', u.name + '（' + u.username + '）', '');
    return {ok:true, user:u};
  },
  // GET /api/subjects：mock 模式读 localStorage 覆盖值，无则 tree:null（调用方回落默认树）
  getSubjects(){
    try{
      const s = localStorage.getItem(LS_SUBJECTS);
      return { ok:true, tree: s ? JSON.parse(s) : null };
    }catch(e){ return { ok:true, tree:null }; }
  },
  // PUT /api/subjects：mock 模式写 localStorage 覆盖值（仅教务的校验由 UI 层保证，与 API 一致整体替换）
  saveSubjects(tree){
    localStorage.setItem(LS_SUBJECTS, JSON.stringify(tree));
    logAction('更新科目树', 'data', '科目管理', '一级分类 ' + Object.keys(tree).length + ' 个');
    return { ok:true };
  },
  // POST /api/students/:id/owner（学生 + 其作业记录 + 未交记录一并改 ownerId）
  transferStudent(ids, newOwnerId){
    const t = this._loadUsers().find(x=>x.id===newOwnerId);
    if(!t || t.role!=='ta') return {ok:false, msg:'目标助教不存在'};
    let n = 0;
    const names = [];
    pool.students.forEach(s=>{ if(ids.includes(s.id)){ s.ownerId = newOwnerId; n++; names.push(s.name); } });
    pool.records.forEach(r=>{ if(ids.includes(r.studentId)) r.ownerId = newOwnerId; });
    pool.missed.forEach(m=>{ if(ids.includes(m.studentId)) m.ownerId = newOwnerId; });
    logAction('转移归属', 'student', names.join('、'), '转移给 ' + t.name, {ownerId: newOwnerId});
    save(); refreshView();
    return {ok:true, count:n};
  },
  /* ---- 计划次数修改审批 ---- */
  // 某学生某科目的待审批申请（同学生同科目同时最多一条 pending）
  pendingPlanRequest(studentId, subject){
    return (pool.planRequests || []).find(r=>r.studentId===studentId && r.subject===subject && r.status==='pending') || null;
  },
  // POST /api/plan-requests（助教发起二次修改申请；内部校验归属/首次/重复/无变化）
  createPlanRequest(req){
    const st = pool.students.find(x=>x.id===req.studentId);
    if(!st) return {ok:false, msg:'学生不存在'};
    if(st.archived) return {ok:false, msg:'历史学生不可修改计划'};
    if(!canWriteOwner(st.ownerId)) return {ok:false, msg:'没有权限操作该数据'};
    const oldPlan = (st.subjPlans && st.subjPlans[req.subject] !== undefined) ? st.subjPlans[req.subject] : null;
    if(oldPlan === null) return {ok:false, msg:'首次设置无需申请，直接保存即可'};
    if(req.newPlan === oldPlan) return {ok:false, msg:'次数未变化'};
    if(this.pendingPlanRequest(st.id, req.subject)) return {ok:false, msg:'该科目已有待审核的修改申请，请先撤回'};
    const r = { id: uid(), studentId: st.id, ownerId: st.ownerId, subject: req.subject,
      oldPlan: oldPlan, newPlan: req.newPlan, reason: req.reason || '',
      status: 'pending', requestedBy: currentUser ? currentUser.id : null, requestedAt: todayStr(),
      reviewedBy: null, reviewedAt: null };
    pool.planRequests.push(r);
    logAction('申请修改计划次数', 'plan', auditStuDesc(st.id, req.subject),
      oldPlan + ' → ' + req.newPlan + ' 次' + (req.reason ? '，理由：' + req.reason : ''), {ownerId: st.ownerId});
    save(); refreshView();
    return {ok:true, request:r};
  },
  // POST /api/plan-requests/:id/cancel（仅申请本人（或教务）且 status=pending）
  cancelPlanRequest(id){
    const r = (pool.planRequests || []).find(x=>x.id===id);
    if(!r) return {ok:false, msg:'申请不存在'};
    if(r.status !== 'pending') return {ok:false, msg:'该申请已处理，不能撤回'};
    if(!currentUser || (currentUser.role!=='admin' && r.requestedBy!==currentUser.id)) return {ok:false, msg:'只能撤回自己的申请'};
    r.status = 'cancelled';
    logAction('撤回修改申请', 'plan', auditStuDesc(r.studentId, r.subject), r.oldPlan + ' → ' + r.newPlan + ' 次', {ownerId: r.ownerId});
    save(); refreshView();
    return {ok:true};
  },
  // POST /api/plan-requests/:id/review（仅教务；approve 时写入 subjPlans 生效）
  reviewPlanRequest(id, approve, note){
    if(!currentUser || currentUser.role!=='admin') return {ok:false, msg:'仅教务可审批'};
    const r = (pool.planRequests || []).find(x=>x.id===id);
    if(!r) return {ok:false, msg:'申请不存在'};
    if(r.status !== 'pending') return {ok:false, msg:'该申请已处理'};
    r.status = approve ? 'approved' : 'rejected';
    r.reviewedBy = currentUser.id;
    r.reviewedAt = todayStr();
    if(note) r.note = note;
    if(approve){
      const st = pool.students.find(x=>x.id===r.studentId);
      if(st){
        st.subjPlans = st.subjPlans || {};
        st.subjPlans[r.subject] = r.newPlan;
        st.subjPlanSetAt = st.subjPlanSetAt || {};
        st.subjPlanSetAt[r.subject] = todayStr();  // 审批通过日作为新计划的设定日
      }
    }
    save(); refreshView();
    logAction(approve ? '审批通过' : '审批驳回', 'plan', auditStuDesc(r.studentId, r.subject),
      r.oldPlan + ' → ' + r.newPlan + ' 次' + (note ? '，' + note : ''), {ownerId: r.ownerId});
    return {ok:true, request:r};
  },
  /* 首次运行播种：教务 admin/admin123 + 示例助教 ta1/ta2（ta123456）+ 销售 sales1（sales123456）及各自示例数据。
     演示期账号均不强制改密（mustChangePwd 仅用于教务新建/重置的账号）。 */
  async _ensureSeed(){
    const users = this._loadUsers();
    let fresh = false;
    const mk = (name, username, pwd, role)=>{
      const salt = makeSalt();
      return {id:uid(), username, name, role, salt, passHash:hashPwd(salt, pwd),
        disabled:false, createdAt:todayStr(), mustChangePwd:false};
    };
    if(!users.length){
      this._users = [ mk('教务管理员','admin','admin123','admin'),
                      mk('王助教','ta1','ta123456','ta'),
                      mk('李助教','ta2','ta123456','ta'),
                      mk('张顾问','sales1','sales123456','sales') ];
      this._saveUsers();
      fresh = true;
    } else {
      // 演示期：清掉早期版本播种的演示账号上的「首登强制改密」标记
      let changed = false;
      users.forEach(u=>{
        if((u.username==='admin' || u.username==='ta1' || u.username==='ta2') && u.mustChangePwd){
          u.mustChangePwd = false; changed = true;
        }
      });
      // 销售角色演示账号一次性回填（已有浏览器补齐）
      if(!users.some(u=>u.role==='sales')){
        this._users.push(mk('张顾问','sales1','sales123456','sales'));
        changed = true;
      }
      if(changed) this._saveUsers();
    }
    if(!load()){ pool = {students:[], records:[], missed:[], planRequests:[], auditLogs:[]}; }
    if(fresh && !pool.students.length && !pool.records.length && !pool.missed.length){
      const tas = this._users.filter(u=>u.role==='ta');
      tas.forEach(t=>seedSamplesFor(t.id));
      if(tas.length) save();
    }
    // 演示期：注入审批流示例数据（示例学生仍在且未注入过；「清空示例数据」后不会再次注入）
    if(!pool.planReqSampled && pool.students.some(s=>s.sample)){
      this._users.filter(u=>u.role==='ta').forEach(t=>seedPlanRequestSamples(t.id));
      pool.planReqSampled = true;
      save();
    }
    // 演示期：注入历史学生示例数据（同样一次性注入，清空示例后不重复注入）
    if(!pool.alumniSampled && pool.students.some(s=>s.sample)){
      this._users.filter(u=>u.role==='ta').forEach(t=>seedAlumniSamples(t.id));
      pool.alumniSampled = true;
      save();
    }
    // 演示期：注入操作记录示例数据（同样一次性，清空示例后不重复注入）
    if(!pool.auditSampled && pool.students.some(s=>s.sample)){
      seedAuditSamples();
      pool.auditSampled = true;
      save();
    }
  }
};

/* ---- HttpApi：真实后端实现（M5a 骨架：认证 + 读取链路 + 账号管理；业务写路径 M5b 接入） ---- */
const HttpApi = {
  _token: null,
  // 统一响应处理：res.ok 且 body.ok 才算成功；401 清会话回登录页；网络异常给友好提示
  async _req(method, url, body){
    try{
      const res = await fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json', ...(this._token ? { Authorization: 'Bearer ' + this._token } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await res.json().catch(() => null);
      if(res.status === 401){
        // 已登录会话里的 401 才是「会话过期」；登录接口自身的 401（密码错误/账号不存在等）要原样展示后端 msg
        if(currentUser){
          this._token = null;
          sessionStorage.removeItem(SS_SESSION);
          forceLogout();  // 注意：不可调用 doLogout（会递归走 logout 接口）
          return { ok: false, msg: '未登录或登录已过期' };
        }
        return { ok: false, msg: (data && data.msg) || '登录失败' };
      }
      if(res.ok && data && data.ok) return data;
      return { ok: false, msg: (data && data.msg) || '请求失败' };
    }catch(e){
      return { ok: false, msg: '网络异常，请重试' };
    }
  },
  // POST /api/login
  async login(username, password, role){
    const r = await this._req('POST', '/api/login', { username: username, password: password, role: role });
    if(!r.ok) return r;
    this._token = r.token;
    sessionStorage.setItem(SS_SESSION, JSON.stringify({ uid: r.user.id, token: r.token, ts: Date.now() }));
    return { ok: true, user: r.user };
  },
  // POST /api/logout
  async logout(){
    await this._req('POST', '/api/logout');
    this._token = null;
    sessionStorage.removeItem(SS_SESSION);
  },
  // 刷新恢复会话：读本地 token → GET /api/me 校验；401 则清除
  async restoreSession(){
    try{
      const s = JSON.parse(sessionStorage.getItem(SS_SESSION));
      if(!s || !s.token) return null;
      this._token = s.token;
      const r = await this._req('GET', '/api/me');
      if(!r.ok){ this._token = null; return null; }
      return r.user;
    }catch(e){ return null; }
  },
  // POST /api/password
  async changePassword(oldPwd, newPwd){
    return this._req('POST', '/api/password', { oldPwd: oldPwd, newPwd: newPwd });
  },
  // GET /api/state（销售无此接口权限，前端跳过；M5.4 起销售走搜索接口）
  async getState(){
    const r = await this._req('GET', '/api/state');
    return r.ok ? { ok: true, state: r.state } : r;
  },
  // GET /api/users（教务）
  async listUsers(){
    const r = await this._req('GET', '/api/users');
    return r.ok ? r.users : [];
  },
  // POST /api/users
  async createUser(name, username, password, role){
    return this._req('POST', '/api/users', { name: name, username: username, password: password, role: role || 'ta' });
  },
  // POST /api/users/:id/reset
  async resetPassword(id, newPwd){
    return this._req('POST', '/api/users/' + id + '/reset', { password: newPwd });
  },
  // POST /api/users/:id/toggle
  async toggleUser(id){
    return this._req('POST', '/api/users/' + id + '/toggle');
  },
  // POST /api/reports/share（家长 H5 报告分享链接，30 天有效；mock 模式无此能力，前端拦截提示）
  shareReport(studentId, subject){
    return this._req('POST', '/api/reports/share', { studentId: studentId, subject: subject });
  },
  // POST /api/reports/push（服务号模板消息推送给已绑定家长）
  pushReport(studentId, subject){
    return this._req('POST', '/api/reports/push', { studentId: studentId, subject: subject });
  },
  // POST /api/students/:id/bind-qr（家长绑定二维码）
  bindQr(studentId){
    return this._req('POST', '/api/students/' + studentId + '/bind-qr');
  },
  // GET /api/students/:id/binds（家长绑定列表）/ POST 解绑
  listBinds(studentId){
    return this._req('GET', '/api/students/' + studentId + '/binds');
  },
  unbindParent(studentId, bindId){
    return this._req('POST', '/api/students/' + studentId + '/binds/' + bindId + '/unbind');
  },
  // GET /api/subjects（科目树，全局共享，全角色可读）
  getSubjects(){ return this._req('GET', '/api/subjects'); },
  // PUT /api/subjects（仅教务，整体替换）
  saveSubjects(tree){ return this._req('PUT', '/api/subjects', { tree: tree }); },
  // 计划申请的 pending 查询是纯前端过滤（pool 已从服务端同步），两种模式一致
  pendingPlanRequest(studentId, subject){ return LocalApi.pendingPlanRequest(studentId, subject); },
  /* ---- M5b：业务写路径（乐观本地更新 + 异步持久化 + 失败重取回滚） ---- */
  // 学生
  addStudent(b){ return this._req('POST', '/api/students', b); },
  updateStudent(id, b){ return this._req('PUT', '/api/students/' + id, b); },
  setStudentArchived(id, flag){ return this._req('POST', '/api/students/' + id + (flag ? '/archive' : '/restore')); },
  // 转移归属：后端为单 id 接口，同名组逐个调用；本地乐观更新，失败重取（服务端校验目标助教）
  async transferStudent(ids, newOwnerId){
    pool.students.forEach(s=>{ if(ids.includes(s.id)) s.ownerId = newOwnerId; });
    pool.records.forEach(r=>{ if(ids.includes(r.studentId)) r.ownerId = newOwnerId; });
    pool.missed.forEach(m=>{ if(ids.includes(m.studentId)) m.ownerId = newOwnerId; });
    refreshView();
    for(const id of ids){
      const r = await this._req('POST', '/api/students/' + id + '/owner', { ownerId: newOwnerId });
      if(!r.ok){ resyncState(); return { ok: false, msg: r.msg || '转移失败，请重试' }; }
    }
    return { ok: true, count: ids.length };
  },
  // 作业记录
  addRecord(b){ return this._req('POST', '/api/records', b); },
  updateRecord(id, b){ return this._req('PUT', '/api/records/' + id, b); },
  deleteRecord(id){ return this._req('DELETE', '/api/records/' + id); },
  // 未交
  addMissed(b){ return this._req('POST', '/api/missed', b); },
  resolveMissed(id){ return this._req('POST', '/api/missed/' + id + '/resolve'); },
  deleteMissed(id){ return this._req('DELETE', '/api/missed/' + id); },
  // 计划次数
  setPlan(b){ return this._req('POST', '/api/plan/set', b); },
  // 学生 JSON 列合并式更新（评语/学习计划与建议/模考/科目列表；整体提交该列）
  updateSubjFields(id, fields){ return this._req('PUT', '/api/students/' + id + '/subj-fields', fields); },
  // 计划审批：先本地乐观更新（含前端校验），再持久化；失败重取回滚
  async createPlanRequest(b){
    const local = LocalApi.createPlanRequest(b);
    if(!local.ok) return local;
    const r = await this._req('POST', '/api/plan-requests', b);
    if(!r.ok){ resyncState(); return r; }
    return { ok: true, request: local.request };
  },
  async cancelPlanRequest(id){
    const r = await this._req('POST', '/api/plan-requests/' + id + '/cancel');
    if(!r.ok){ resyncState(); return r; }
    LocalApi.cancelPlanRequest(id);
    return r;
  },
  async reviewPlanRequest(id, approve, note){
    const r = await this._req('POST', '/api/plan-requests/' + id + '/review', { approve: approve, note: note });
    if(!r.ok){ resyncState(); return r; }
    LocalApi.reviewPlanRequest(id, approve, note);
    return r;
  },
  // 附件上传（multipart；图片 ≤2MB / PDF ≤4MB 客户端先拦一道）
  async uploadFiles(formData){
    try{
      const res = await fetch('/api/files', {
        method: 'POST',
        headers: this._token ? { Authorization: 'Bearer ' + this._token } : {},
        body: formData
      });
      if(res.status === 401){
        this._token = null;
        sessionStorage.removeItem(SS_SESSION);
        forceLogout();
        return { ok: false, msg: '未登录或登录已过期' };
      }
      const data = await res.json().catch(() => null);
      if(res.ok && data && data.ok) return data;
      return { ok: false, msg: (data && data.msg) || '上传失败' };
    }catch(e){ return { ok: false, msg: '网络异常，请重试' }; }
  },
  async _ensureSeed(){ /* API 模式不播种演示数据 */ }
};

/* ---- 写路径持久化帮手（仅 API 模式生效；mock 模式为纯本地行为，零变化） ---- */
// 异步持久化：失败 → 提示 + 重取 state 回滚本地乐观更新；onOk 可拿到响应回填（如学生的 createdAt；id 已由客户端生成贯穿，不再回填 id）
function apiPersist(promise, onOk){
  if(!USE_API || !promise || typeof promise.then !== 'function') return;
  promise.then(r => {
    if(r && r.ok === false){ toast('保存失败，请检查网络后重试'); resyncState(); return; }
    if(onOk) onOk(r);
  }).catch(() => { toast('保存失败，请检查网络后重试'); resyncState(); });
}
// 从服务端重取全量状态（回滚/同步用）
async function resyncState(){
  if(!USE_API) return;
  const s = await HttpApi.getState();
  if(s.ok){ pool = s.state; refreshView(); renderAll(); }
}
// 附件直链（img/PDF 引用；后端对 GET /api/files/:id 放开 ?token= 查询参数）
function fileUrl(id){ return '/api/files/' + id + '?token=' + encodeURIComponent(HttpApi._token || ''); }

/* ---- 模式开关与门面 ---- */
let USE_API = false;          // 启动时探测：同 origin 有后端 → true
let apiImpl = LocalApi;       // 当前实现
// 门面：方法调用绑定到当前实现（保持 this 正确），测试钩子 wb.Api 两种模式均可用
const Api = new Proxy({}, {
  get(t, k){ const v = apiImpl[k]; return typeof v === 'function' ? v.bind(apiImpl) : v; },
  set(t, k, v){ apiImpl[k] = v; return true; }
});
// 快速探测后端（2 秒超时；file:// 或静态托管下立即失败回退 mock）
async function detectApi(){
  if(typeof fetch !== 'function') return false;
  try{
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 2000) : null;
    const res = await fetch('/api/health', ctl ? { signal: ctl.signal } : {});
    if(timer) clearTimeout(timer);
    return !!res.ok;
  }catch(e){ return false; }
}

/* 用户列表缓存：mock 模式实时读 LocalApi；API 模式读缓存（登录/账号操作后刷新）。
   渲染层（归属标签/看板/审批等）全部走这个同步入口，避免渲染函数异步化 */
let usersCache = [];
function getUsersCache(){ return USE_API ? usersCache : LocalApi.listUsers(); }
async function refreshUsersCache(){
  if(!USE_API) return;
  const users = await HttpApi.listUsers();
  if(Array.isArray(users)) usersCache = users;
}

/* ================= 示例数据（相对当前日期；按归属助教分别生成，带 ownerId 与 sample 标记） ================= */
function seedSamplesFor(ownerId){
  const s1 = {id:uid(), name:'林小满', sample:true, ownerId:ownerId};
  const s2 = {id:uid(), name:'陈星宇', sample:true, ownerId:ownerId};
  const s3 = {id:uid(), name:'苏晚晴', sample:true, ownerId:ownerId};
  const s4 = {id:uid(), name:'周子墨', sample:true, ownerId:ownerId};
  const s5 = {id:uid(), name:'林小满', sample:true, ownerId:ownerId};  // 同名示例：与 s1 同名，用于演示「同名合并」
  pool.students.push(s1,s2,s3,s4,s5);
  pool.records.push(
    {id:uid(), studentId:s1.id, date:offsetDay(-1), total:20, correct:18, wrongs:[7,14], subject:'学科 / AP / 微积分BC', images:[], sample:true, ownerId:ownerId},
    {id:uid(), studentId:s2.id, date:offsetDay(-1), total:20, correct:13, wrongs:[3,5,9,11,16,18,20], subject:'学科 / AP / 物理1', images:[], sample:true, ownerId:ownerId},
    {id:uid(), studentId:s3.id, date:offsetDay(-2), total:15, correct:15, wrongs:[], subject:'语培 / 托福', images:[], sample:true, ownerId:ownerId},
    {id:uid(), studentId:s5.id, date:offsetDay(-3), total:18, correct:14, wrongs:[3,9,12,17], subject:'学科 / IB / 数学', images:[], sample:true, ownerId:ownerId},
    {id:uid(), studentId:s3.id, date:offsetDay(-5), total:15, correct:12, wrongs:[4,10,15], subject:'竞赛 / AMC10', images:[], sample:true, ownerId:ownerId}
  );
  // 1 条逾期未交（示例）：周子墨 3 天前未交，至今未补
  pool.missed.push(
    {id:uid(), studentId:s4.id, date:offsetDay(-3), resolved:false, sample:true, ownerId:ownerId},
    {id:uid(), studentId:s2.id, date:offsetDay(-6), resolved:true, sample:true, ownerId:ownerId}
  );
}

/* 审批流示例数据：为指定助教的示例学生补应完成次数，并生成 待审批/已通过/已驳回 各 1 条申请（带 sample 标记，随「清空示例数据」一并清除） */
function seedPlanRequestSamples(ownerId){
  pool.planRequests = pool.planRequests || [];
  const stus = pool.students.filter(s=>s.sample && s.ownerId===ownerId);
  if(!stus.length) return;
  const admin = getUsersCache().find(u=>u.role==='admin');
  const pick = name => stus.find(s=>s.name===name);
  const sA = pick('周子墨'), sB = pick('苏晚晴'), sC = pick('陈星宇');
  // 示例计划补开课日期（相对日期，过去时间——让逾期/宽限口径在演示中可见）
  const setFc = (s, sub, off)=>{ s.subjFirstClass = s.subjFirstClass || {}; s.subjFirstClass[sub] = offsetDay(off); };
  if(sA){  // 待审批：周子墨 竞赛 / AMC10 8 → 10
    sA.subjPlans = sA.subjPlans || {};
    sA.subjPlans['竞赛 / AMC10'] = 8;
    setFc(sA, '竞赛 / AMC10', -20);
    pool.planRequests.push({id:uid(), studentId:sA.id, ownerId:ownerId, subject:'竞赛 / AMC10',
      oldPlan:8, newPlan:10, reason:'竞赛班加课，需要增加 2 次作业', status:'pending',
      requestedBy:ownerId, requestedAt:offsetDay(-1), reviewedBy:null, reviewedAt:null, sample:true});
  }
  if(sB){  // 已通过：苏晚晴 语培 / 托福 12 → 15
    sB.subjPlans = sB.subjPlans || {};
    sB.subjPlans['语培 / 托福'] = 15;
    setFc(sB, '语培 / 托福', -30);
    pool.planRequests.push({id:uid(), studentId:sB.id, ownerId:ownerId, subject:'语培 / 托福',
      oldPlan:12, newPlan:15, reason:'冲分班课程延长', status:'approved',
      requestedBy:ownerId, requestedAt:offsetDay(-3), reviewedBy:admin?admin.id:null, reviewedAt:offsetDay(-2), sample:true});
  }
  if(sC){  // 已驳回：陈星宇 学科 / AP / 物理1 8 → 20
    sC.subjPlans = sC.subjPlans || {};
    sC.subjPlans['学科 / AP / 物理1'] = 8;
    setFc(sC, '学科 / AP / 物理1', -20);
    pool.planRequests.push({id:uid(), studentId:sC.id, ownerId:ownerId, subject:'学科 / AP / 物理1',
      oldPlan:8, newPlan:20, reason:'想把整学期作业一次录完', status:'rejected',
      requestedBy:ownerId, requestedAt:offsetDay(-4), reviewedBy:admin?admin.id:null, reviewedAt:offsetDay(-3), sample:true});
  }
}

/* 历史学生示例数据：为指定助教播种 2 名已毕业/结课学生（archived + sample），
   作业记录日期在 35~60 天前（避开近 30 天趋势图），各带 1 条已处理未交 */
/* 操作记录示例数据：播种一批带 sample 标记的演示日志（随「清空示例数据」一并清除）。
   ownerId 传助教 id 时只播种该助教的条目；不传则播种全部助教 + 教务的条目。 */
function seedAuditSamples(ownerId){
  pool.auditLogs = pool.auditLogs || [];
  const users = getUsersCache();
  const admin = users.find(u=>u.role==='admin');
  const tas = ownerId ? users.filter(u=>u.id===ownerId) : users.filter(u=>u.role==='ta');
  const at = (d, t)=> offsetDay(d) + ' ' + t;  // ts 格式同 nowTs()：YYYY-MM-DD HH:mm:ss
  const mk = (u, d, t, action, type, desc, detail, owner)=>({id:uid(), ts:at(d,t),
    userId:u.id, userName:u.name, role:u.role, action:action, targetType:type,
    targetDesc:desc||'', detail:detail||'', ownerId:(owner===undefined ? u.id : owner), sample:true});
  tas.forEach(ta=>{
    const stus = pool.students.filter(s=>s.sample && s.ownerId===ta.id);
    if(!stus.length) return;
    const has = n => stus.some(s=>s.name===n);
    if(has('林小满')) pool.auditLogs.push(mk(ta,-1,'09:12:00','录入作业','record','林小满 · AP·微积分BC','总 20 对 18，正确率 90%'));
    if(has('周子墨')){
      pool.auditLogs.push(mk(ta,-3,'18:02:00','登记未交','missed','周子墨 · AMC10','未交日期 ' + offsetDay(-3)));
      pool.auditLogs.push(mk(ta,-1,'10:30:00','提交计划修改申请','plan','周子墨 · AMC10','8 → 10 次；理由：竞赛班加课，需要增加 2 次作业'));
    }
    if(has('苏晚晴')) pool.auditLogs.push(mk(ta,-2,'14:20:00','保存评语','student','苏晚晴 · 托福','最近口语进步明显，继续保持'));
    if(has('陈星宇')) pool.auditLogs.push(mk(ta,-6,'14:00:00','新增学生','student','陈星宇',''));
    pool.auditLogs.push(mk(ta,0,'08:55:12','登录系统','auth','','登录成功'));
  });
  if(!ownerId && admin && tas.length){
    pool.auditLogs.push(mk(admin,-6,'11:20:00','创建账号','account','李助教（ta2）','角色：助教', admin.id));
    pool.auditLogs.push(mk(admin,-2,'16:40:00','审批通过','plan','苏晚晴 · 托福','12 → 15 次（申请助教：' + tas[0].name + '）', tas[0].id));
    if(tas[1]) pool.auditLogs.push(mk(admin,-3,'15:05:00','审批驳回','plan','陈星宇 · AP·物理1','8 → 20 次（申请助教：' + tas[1].name + '）', tas[1].id));
    pool.auditLogs.push(mk(admin,0,'08:30:00','登录系统','auth','','登录成功', admin.id));
  }
}

function seedAlumniSamples(ownerId){
  const a1 = {id:uid(), name:'李浩然', school:'深圳外国语学校', gradYear:'2025', archived:true, sample:true, ownerId:ownerId};
  const a2 = {id:uid(), name:'赵雨桐', school:'杭州外国语学校', gradYear:'2024', archived:true, sample:true, ownerId:ownerId};
  pool.students.push(a1, a2);
  pool.records.push(
    {id:uid(), studentId:a1.id, date:offsetDay(-36), total:20, correct:17, wrongs:[4,9,15], subject:'学科 / IB / 数学', images:[], sample:true, ownerId:ownerId},
    {id:uid(), studentId:a1.id, date:offsetDay(-45), total:20, correct:16, wrongs:[2,7,11,18], subject:'学科 / IB / 数学', images:[], sample:true, ownerId:ownerId},
    {id:uid(), studentId:a1.id, date:offsetDay(-52), total:15, correct:14, wrongs:[6], subject:'语培 / 托福', images:[], sample:true, ownerId:ownerId},
    {id:uid(), studentId:a2.id, date:offsetDay(-38), total:18, correct:15, wrongs:[3,8,13], subject:'学科 / AP / 微积分AB', images:[], sample:true, ownerId:ownerId},
    {id:uid(), studentId:a2.id, date:offsetDay(-60), total:15, correct:13, wrongs:[5,12], subject:'竞赛 / AMC12', images:[], sample:true, ownerId:ownerId}
  );
  pool.missed.push(
    {id:uid(), studentId:a1.id, date:offsetDay(-40), resolved:true, subject:'语培 / 托福', sample:true, ownerId:ownerId},
    {id:uid(), studentId:a2.id, date:offsetDay(-55), resolved:true, subject:'学科 / AP / 微积分AB', sample:true, ownerId:ownerId}
  );
}

