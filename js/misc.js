/* 通用工具：格式化/短科目名/拼音首字母筛选/逾期判定/页签切换/确认与输入弹窗/toast/数字滚动/横幅 */
/* ================= 工具 ================= */
function stuName(id){ const s = state.students.find(x=>x.id===id); return s ? s.name : '（已删除学生）'; }
function acc(r){ return r.total>0 ? Math.round(r.correct/r.total*100) : 0; }
function accClass(a){ return a>=85 ? 'acc-good' : (a>=60 ? 'acc-mid' : 'acc-low'); }
// 科目路径缩短显示：「学科 / AP / 微积分BC」→「AP·微积分BC」；「竞赛 / AMC10」→「AMC10」
function shortSubject(s){
  if(!s) return '未指定';
  const p = s.split(' / ');
  if(p.length === 3) return p[1] + '·' + p[2];
  if(p.length === 2) return p[1];
  return s;
}
function esc(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ================= 拼音首字母筛选（零依赖） =================
   内置「姓氏 → 拼音首字母」映射（百家姓 + 常见姓氏，普通对象，缺字随时加一行）；
   英文名取首字符大写 A–Z；未收录的字归「#」（其他）。 */
const SURNAME_LETTER = {
  // A
  '阿':'A','艾':'A','安':'A','敖':'A','昂':'A','爱':'A',
  // B
  '白':'B','巴':'B','柏':'B','班':'B','包':'B','鲍':'B','贝':'B','贲':'B','毕':'B','卞':'B','边':'B','卜':'B','步':'B','薄':'B','保':'B','暴':'B','邴':'B','宾':'B','别':'B','波':'B','布':'B','伯':'B','摆':'B',
  // C
  '蔡':'C','曹':'C','岑':'C','柴':'C','昌':'C','常':'C','车':'C','陈':'C','成':'C','程':'C','池':'C','迟':'C','褚':'C','储':'C','楚':'C','崔':'C','丛':'C','才':'C','操':'C','晁':'C','谌':'C','承':'C','初':'C','崇':'C','苍':'C','充':'C','从':'C',
  // D
  '戴':'D','邓':'D','刁':'D','丁':'D','董':'D','杜':'D','段':'D','狄':'D','窦':'D','堵':'D','都':'D','党':'D','东':'D','豆':'D','刀':'D','达':'D','笪':'D',
  // E
  '鄂':'E','尔':'E','耳':'E',
  // F
  '樊':'F','范':'F','方':'F','房':'F','费':'F','丰':'F','封':'F','冯':'F','凤':'F','伏':'F','符':'F','傅':'F','富':'F','付':'F','法':'F','凡':'F','扶':'F','福':'F',
  // G
  '干':'G','甘':'G','高':'G','戈':'G','葛':'G','耿':'G','弓':'G','公':'G','宫':'G','龚':'G','巩':'G','勾':'G','古':'G','谷':'G','顾':'G','关':'G','管':'G','桂':'G','郭':'G','国':'G','盖':'G','归':'G','广':'G','缑':'G','郜':'G',
  // H
  '哈':'H','海':'H','韩':'H','杭':'H','郝':'H','何':'H','和':'H','贺':'H','赫':'H','洪':'H','侯':'H','胡':'H','扈':'H','花':'H','华':'H','滑':'H','怀':'H','桓':'H','黄':'H','惠':'H','霍':'H','宦':'H','衡':'H','弘':'H','红':'H','后':'H','郈':'H',
  // J
  '姬':'J','吉':'J','嵇':'J','纪':'J','季':'J','计':'J','冀':'J','郏':'J','家':'J','贾':'J','简':'J','江':'J','姜':'J','蒋':'J','焦':'J','金':'J','靳':'J','晋':'J','荆':'J','景':'J','井':'J','居':'J','鞠':'J','暨':'J','汲':'J','蓟':'J','籍':'J',
  // K
  '康':'K','柯':'K','孔':'K','寇':'K','匡':'K','况':'K','蒯':'K','夔':'K','邝':'K','空':'K','隗':'K','阚':'K','亢':'K',
  // L
  '赖':'L','蓝':'L','郎':'L','劳':'L','雷':'L','黎':'L','李':'L','厉':'L','利':'L','连':'L','廉':'L','梁':'L','廖':'L','林':'L','蔺':'L','凌':'L','刘':'L','柳':'L','龙':'L','娄':'L','卢':'L','鲁':'L','陆':'L','路':'L','逯':'L','吕':'L','栾':'L','罗':'L','骆':'L','冷':'L','兰':'L','栗':'L','励':'L','练':'L',
  // M
  '麻':'M','马':'M','麦':'M','满':'M','茅':'M','毛':'M','梅':'M','蒙':'M','孟':'M','糜':'M','米':'M','宓':'M','苗':'M','缪':'M','闵':'M','明':'M','莫':'M','牟':'M','牧':'M','慕':'M','穆':'M','母':'M','门':'M','墨':'M',
  // N
  '那':'N','南':'N','倪':'N','聂':'N','宁':'N','牛':'N','钮':'N','农':'N','乜':'N','年':'N',
  // O
  '欧':'O','区':'O',
  // P
  '潘':'P','庞':'P','逄':'P','裴':'P','彭':'P','皮':'P','平':'P','蒲':'P','濮':'P','朴':'P','浦':'P','普':'P','盘':'P',
  // Q
  '戚':'Q','祁':'Q','齐':'Q','钱':'Q','强':'Q','乔':'Q','秦':'Q','钦':'Q','丘':'Q','邱':'Q','仇':'Q','裘':'Q','屈':'Q','瞿':'Q','权':'Q','全':'Q','阙':'Q','璩':'Q','琴':'Q','覃':'Q','青':'Q','卿':'Q',
  // R
  '冉':'R','饶':'R','任':'R','戎':'R','荣':'R','容':'R','茹':'R','阮':'R','芮':'R','汝':'R','融':'R',
  // S
  '桑':'S','沙':'S','山':'S','单':'S','商':'S','尚':'S','邵':'S','佘':'S','申':'S','沈':'S','慎':'S','盛':'S','师':'S','施':'S','石':'S','时':'S','史':'S','舒':'S','束':'S','双':'S','水':'S','司':'S','松':'S','宋':'S','苏':'S','宿':'S','隋':'S','孙':'S','索':'S','寿':'S','殳':'S','厍':'S','韶':'S','莘':'S','绳':'S','帅':'S',
  // T
  '邰':'T','谈':'T','谭':'T','汤':'T','唐':'T','陶':'T','滕':'T','田':'T','童':'T','通':'T','佟':'T','屠':'T','涂':'T','钭':'T','檀':'T','泰':'T',
  // W
  '万':'W','汪':'W','王':'W','危':'W','韦':'W','卫':'W','尉':'W','魏':'W','温':'W','文':'W','闻':'W','翁':'W','邬':'W','巫':'W','吴':'W','伍':'W','武':'W','乌':'W','沃':'W','蔚':'W','毋':'W','完':'W',
  // X
  '郗':'X','习':'X','席':'X','夏':'X','冼':'X','咸':'X','相':'X','向':'X','项':'X','萧':'X','解':'X','谢':'X','辛':'X','邢':'X','幸':'X','熊':'X','胥':'X','徐':'X','许':'X','宣':'X','薛':'X','荀':'X','肖':'X','奚':'X','西':'X','郤':'X','须':'X','修':'X',
  // Y
  '燕':'Y','严':'Y','言':'Y','阎':'Y','颜':'Y','晏':'Y','羊':'Y','阳':'Y','杨':'Y','仰':'Y','养':'Y','姚':'Y','叶':'Y','伊':'Y','衣':'Y','易':'Y','殷':'Y','尹':'Y','印':'Y','应':'Y','雍':'Y','尤':'Y','游':'Y','于':'Y','余':'Y','俞':'Y','鱼':'Y','庾':'Y','禹':'Y','郁':'Y','喻':'Y','元':'Y','袁':'Y','岳':'Y','乐':'Y','越':'Y','云':'Y','鄢':'Y','闫':'Y','苑':'Y','运':'Y','恽':'Y',
  // Z
  '昝':'Z','臧':'Z','曾':'Z','查':'Z','翟':'Z','詹':'Z','湛':'Z','张':'Z','章':'Z','赵':'Z','甄':'Z','郑':'Z','支':'Z','植':'Z','钟':'Z','仲':'Z','周':'Z','朱':'Z','诸':'Z','祝':'Z','庄':'Z','卓':'Z','宗':'Z','邹':'Z','祖':'Z','左':'Z','终':'Z','竺':'Z','宰':'Z','占':'Z','展':'Z','战':'Z','仉':'Z','折':'Z'
};
const LETTER_LIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('');
// 名字 → 首字母（中文查姓氏表；英文首字符大写；其他归 #）
function nameLetter(name){
  const c = (name||'').trim().charAt(0);
  if(!c) return '#';
  if(/[a-zA-Z]/.test(c)) return c.toUpperCase();
  return SURNAME_LETTER[c] || '#';
}
/* 首字母筛选状态（模块变量：多选并集，切页不清空，仅刷新重置） */
let stuLetters = [];
let alumniLetters = [];
function matchLetters(name, letters){ return !letters.length || letters.indexOf(nameLetter(name)) !== -1; }
function toggleLetter(kind, l){
  const arr = kind==='stu' ? stuLetters : alumniLetters;
  const i = arr.indexOf(l);
  if(i === -1) arr.push(l); else arr.splice(i, 1);
  if(kind==='stu') renderStats(); else renderAlumni();
}
function clearLetters(kind){
  if(kind==='stu'){ stuLetters = []; renderStats(); } else { alumniLetters = []; renderAlumni(); }
}
// 筛选条：A–Z + # 横排可横滚（sub-chip 风格），有选中时末尾「清除筛选」
function letterBarHtml(letters, kind){
  return '<div class="letter-bar">' +
    LETTER_LIST.map(l=>'<span class="sub-chip letter-chip' + (letters.indexOf(l)!==-1?' active':'') + '" onclick="toggleLetter(\'' + kind + '\',\'' + l + '\')">' + l + '</span>').join('') +
    (letters.length ? '<span class="sub-chip letter-clear" onclick="clearLetters(\'' + kind + '\')">清除筛选</span>' : '') +
    '</div>';
}
/* ---- 逾期统一判定（首次课程时间口径） ----
   逾期 ⟺ 未处理 && 该科目已填开课时间（未填一律不算逾期）&& 开课时间 ≤ 今天（未开课不算）&& 未交日期 + 7 天宽限 < 今天
   「未指定科目」的未交无法定位开课时间 → 不算逾期 */
function addDays(dateStr, n){ const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return fmtDate(d); }
function isOverdueMissed(m, st){
  if(!m || m.resolved) return false;
  if(!m.subject) return false;
  const fc = st && st.subjFirstClass && st.subjFirstClass[m.subject];
  if(!fc) return false;
  const t = todayStr();
  if(fc > t) return false;
  return addDays(m.date, 7) < t;
}
// 某学生（组）某科目的逾期未交次数（统一逾期口径）
function overdueMissCount(ids, subject){
  return state.missed.filter(m=>{
    if((m.subject||'')!==subject || ids.indexOf(m.studentId)===-1) return false;
    const st = state.students.find(x=>x.id===m.studentId);
    return isOverdueMissed(m, st);
  }).length;
}
function hasSample(){
  return state.students.some(s=>s.sample) || state.records.some(r=>r.sample) || state.missed.some(m=>m.sample);
}
// 现有学生 = 未归档；历史学生 = 已归档（已毕业/结课）
function activeStudents(){ return state.students.filter(s=>!s.archived); }
function archivedStudents(){ return state.students.filter(s=>s.archived); }

/* ================= 页签切换 ================= */
/* topbar 主标题 = 当前页签名称（产品名只在侧栏品牌区出现，顶部不再重复） */
const TAB_TITLES = { today:'今日概览', dashboard:'数据看板', stats:'现有学生', alumni:'历史学生', accounts:'账号管理', data:'教务管理', audit:'操作记录' };
function switchTab(name){
  // 角色页签守卫：教务=全部 6 个；助教=今日/现有/历史/数据；销售=仅现有/历史
  const role = currentUser ? currentUser.role : null;
  const allowed = role==='admin' ? ['today','dashboard','stats','alumni','accounts','data','audit']
    : role==='sales' ? ['stats','alumni']
    : ['today','stats','alumni','data','audit'];
  if(allowed.indexOf(name) === -1) name = role==='sales' ? 'stats' : 'today';
  addSubjGid = null;  // 切页 = 取消未确认的「新增科目」面板（回来时重新展开）
  // 切页 = 清空筛选条件恢复默认展示（姓名搜索 + 首字母筛选）
  stuQuery = ''; alumniQuery = ''; stuLetters = []; alumniLetters = [];
  const ss = document.getElementById('stu-search'); if(ss) ss.value = '';
  const as = document.getElementById('alumni-search'); if(as) as.value = '';
  document.querySelectorAll('.nav-btn,.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.tab===name));
  document.querySelectorAll('.tab-pane').forEach(p=>p.classList.toggle('active', p.id==='pane-'+name));
  const pt = document.getElementById('page-title');  // DOM 桩下为桩元素，赋值静默安全
  if(pt) pt.textContent = TAB_TITLES[name] || TAB_TITLES.today;
  if(name==='stats') renderStats();
  if(name==='alumni') renderAlumni();
  if(name==='accounts') renderAccounts();
  if(name==='audit') renderAudit();
  window.scrollTo({top:0, behavior:'smooth'});
  return name;
}
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click', ()=>switchTab(b.dataset.tab)));

/* ================= 确认弹窗 ================= */
let cfCallback = null;
/* 产品内 toast（替代浏览器原生 alert）：顶部居中白色卡片 + 薄荷绿点缀，3 秒自动消失，
   多条依次向下堆叠；\n 多行由 CSS pre-line 支持。DOM 桩环境下 appendChild/removeChild 为空操作或缺失，静默工作不抛错。 */
function toast(msg){
  const zone = document.getElementById('toast-zone');
  if(!zone) return;  // 防御：挂载点缺失时静默
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = String(msg);
  zone.appendChild(t);
  setTimeout(()=>{
    t.classList.add('out');
    setTimeout(()=>{ if(t.parentNode && t.parentNode.removeChild) t.parentNode.removeChild(t); }, 260);
  }, 3000);
}
/* 统计数字滚动动画（克制奖励感，0.6s ease-out）：先写终值再从 0 滚动，动画结束值与静态渲染完全一致；
   测试桩环境（元素无 querySelectorAll）/无 requestAnimationFrame/系统减动效时直接保留终值，防断言抖动。
   仅处理纯数字（可带 % 后缀）；「2/2」「—」等格式直接跳过。 */
function animateNums(scopeEl){
  if(!scopeEl || typeof scopeEl.querySelectorAll !== 'function') return;  // DOM 桩元素无此方法 → 保持终值
  if(typeof requestAnimationFrame !== 'function') return;
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  scopeEl.querySelectorAll('.quick .num').forEach(el=>{
    const m = el.textContent.match(/^(\d+)(%?)$/);
    if(!m) return;
    const target = parseInt(m[1], 10), suffix = m[2];
    if(!target) return;  // 0 无需滚动
    const t0 = Date.now();
    const step = ()=>{
      const k = Math.min(1, (Date.now() - t0) / 600);
      const eased = 1 - Math.pow(1 - k, 3);  // ease-out cubic
      el.textContent = (k === 1 ? target : Math.round(target * eased)) + suffix;
      if(k < 1) requestAnimationFrame(step);
    };
    el.textContent = '0' + suffix;
    requestAnimationFrame(step);
  });
}
function askConfirm(title, text, cb){
  document.getElementById('cf-title').textContent = title;
  document.getElementById('cf-text').textContent = text;
  cfCallback = cb;
  document.getElementById('confirm-modal').classList.add('show');
}
document.getElementById('cf-cancel').onclick = ()=>document.getElementById('confirm-modal').classList.remove('show');
document.getElementById('cf-ok').onclick = ()=>{
  document.getElementById('confirm-modal').classList.remove('show');
  if(cfCallback) cfCallback();
};
/* 单行输入弹窗（替代浏览器原生 prompt）：askInput(标题, 默认值, 回调)。
   确认/取消用 onclick 属性挂接（与确认弹窗一致），DOM 桩环境测试可直接驱动 */
let inCallback = null;
function askInput(title, def, cb){
  document.getElementById('in-title').textContent = title;
  const inp = document.getElementById('in-value');
  inp.value = def || '';
  inCallback = cb;
  document.getElementById('input-modal').classList.add('show');
  if(inp.focus) inp.focus();
}
document.getElementById('in-cancel').onclick = ()=>{
  document.getElementById('input-modal').classList.remove('show');
  inCallback = null;
};
document.getElementById('in-ok').onclick = ()=>{
  const v = document.getElementById('in-value').value;
  document.getElementById('input-modal').classList.remove('show');
  const cb = inCallback; inCallback = null;
  if(cb) cb(String(v).trim());
};

/* ================= 横幅 ================= */
function renderBanners(){
  const sb = document.getElementById('sample-banner');
  const bt = document.getElementById('backup-tip');
  if(isSalesView()){ sb.style.display = 'none'; bt.style.display = 'none'; return; }  // 销售端不显示数据横幅
  if(hasSample()){
    sb.style.display = 'flex';
    sb.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="#B9802A" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>' +
      '<span>当前包含<b>示例数据</b>（日期按今天自动生成，仅用于演示）</span><span class="spacer"></span>' +
      (isAdminView() ? '<button class="btn ghost sm" onclick="clearSamples()">清空示例数据</button>' : '');  // 清理入口仅教务可见
  } else { sb.style.display = 'none'; }

  const total = state.records.length + state.missed.length;
  if(total >= 30){
    bt.style.display = 'flex';
    bt.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/></svg>' +
      '数据已积累 ' + total + ' 条，建议导出 JSON 备份。';
  } else { bt.style.display = 'none'; }
}

