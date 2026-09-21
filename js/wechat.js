/* 家长触达：作业报告 PDF 与预览弹窗、分享链接、服务号推送、家长绑定/解绑入口（微信相关） */
/* ================= 生成作业打卡报告 PDF（打卡情况 + 老师评语 + 模考） ================= */
const REPORT_CDN = {
  jspdf: 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
  html2canvas: 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js'
};
function loadScript(src){
  return new Promise((res, rej)=>{
    if(document.querySelector('script[data-rpt="1"][src="' + src + '"]')){ res(); return; }
    const s = document.createElement('script');
    s.src = src; s.dataset.rpt = '1';
    s.onload = () => res();
    s.onerror = () => rej(new Error('load fail'));
    document.head.appendChild(s);
    setTimeout(()=>rej(new Error('timeout')), 25000);
  });
}
function subjFileName(s){ return shortSubject(s).replace(/[\\/:*?"<>|]/g,'_'); }
/* 构建报告 HTML：白底 A4 布局（794px），全内联样式便于截图 */
function reportHtml(st, subject){
  const gid = st.id;
  const recs = subjectRecsSorted(gid, subject);
  const plan = (st.subjPlans && st.subjPlans[subject]) || 0;
  const done = recs.length;
  const total = Math.max(plan, done);
  const rate = plan>0 ? Math.round(done/plan*100) + '%' : '—';
  const today = todayStr();
  const subjName = shortSubject(subject);
  let rows = '';
  for(let i=0;i<total;i++){
    const r = recs[i];
    const idx = i+1;
    const td = 'padding:7px 10px;border:1px solid #DDE3E0;font-size:13px;color:#374151';
    if(r){
      if(r.noHomework){  // 无作业记录：正确率 — + 错题列「本次无作业」（灰，不带评级；与落地页同口径）
        rows += '<tr>' +
          '<td style="' + td + '">第' + idx + '次</td>' +
          '<td style="' + td + '">' + esc(r.date) + '</td>' +
          '<td style="' + td + ';color:#9CA3AF">—</td>' +
          '<td style="' + td + ';color:#9CA3AF">本次无作业</td></tr>';
      } else {
      const ra = acc(r);
      const wrongs = (r.wrongs && r.wrongs.length) ? esc(r.wrongs.join('、')) : '无错题';
      rows += '<tr>' +
        '<td style="' + td + '">第' + idx + '次</td>' +
        '<td style="' + td + '">' + esc(r.date) + '</td>' +
        '<td style="' + td + ';font-weight:700;color:' + (ra>=85?'#0F8F68':(ra>=60?'#B9802A':'#DC2626')) + '">' + ra + '%</td>' +
        '<td style="' + td + '">' + wrongs + '</td></tr>';
      }
    } else {
      rows += '<tr>' +
        '<td style="' + td + '">第' + idx + '次</td>' +
        '<td style="' + td + '">未完成</td>' +
        '<td style="' + td + ';font-weight:700;color:#DC2626">—</td>' +
        '<td style="' + td + ';color:#DC2626">未完成</td></tr>';
    }
  }
  if(!rows) rows = '<tr><td colspan="4" style="padding:10px;border:1px solid #DDE3E0;font-size:13px;color:#9CA3AF">暂无作业记录</td></tr>';
  const comment = (st.subjComments && st.subjComments[subject]) ? st.subjComments[subject] : '';
  const advice = (st.subjAdvice && st.subjAdvice[subject]) ? st.subjAdvice[subject] : '';
  const mock = (st.mock && st.mock[subject]) || {};
  const mockDate = mock.date || '';
  const mockScore = (mock.score!==undefined && mock.score!==null && mock.score!=='') ? mock.score : '';
  return '<div style="width:702px;padding:40px 46px 46px;box-sizing:border-box;background:#fff;color:#1F2937;font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',\'Hiragino Sans GB\',\'Microsoft YaHei\',sans-serif">' +
    '<div style="border-bottom:3px solid #2FBF8F;padding-bottom:14px;margin-bottom:18px">' +
      '<div style="font-size:26px;font-weight:800;letter-spacing:1px">作业打卡报告</div>' +
      '<div style="font-size:13px;color:#6B7280;margin-top:8px">学生：<b style="color:#1F2937">' + esc(st.name) + '</b>' +
      (st.school ? '　｜　学校：' + esc(st.school) : '') +
      (st.gradYear ? '　｜　年级：' + esc(st.gradYear) + ' 届' : '') +
      '　｜　科目：<b style="color:#1F2937">' + esc(subjName) + '</b></div>' +
      '<div style="font-size:12px;color:#9CA3AF;margin-top:4px">生成日期：' + today + '</div>' +
    '</div>' +
    '<div style="display:flex;gap:10px;margin-bottom:20px">' +
      '<div style="flex:1;background:#F0FBF6;border:1px solid #D8F0E5;border-radius:10px;padding:10px 14px;text-align:center">' +
        '<div style="font-size:12px;color:#6B7280">应完成</div><div style="font-size:20px;font-weight:800;color:#0F8F68">' + plan + ' 次</div></div>' +
      '<div style="flex:1;background:#F0FBF6;border:1px solid #D8F0E5;border-radius:10px;padding:10px 14px;text-align:center">' +
        '<div style="font-size:12px;color:#6B7280">已完成</div><div style="font-size:20px;font-weight:800;color:#0F8F68">' + done + ' 次</div></div>' +
      '<div style="flex:1;background:#FDF3F2;border:1px solid #F0C6C2;border-radius:10px;padding:10px 14px;text-align:center">' +
        '<div style="font-size:12px;color:#6B7280">未完成</div><div style="font-size:20px;font-weight:800;color:#DC2626">' + Math.max(0,total-done) + ' 次</div></div>' +
      '<div style="flex:1;background:#F0FBF6;border:1px solid #D8F0E5;border-radius:10px;padding:10px 14px;text-align:center">' +
        '<div style="font-size:12px;color:#6B7280">完成率</div><div style="font-size:20px;font-weight:800;color:#0F8F68">' + rate + '</div></div>' +
    '</div>' +
    '<div style="font-size:15px;font-weight:700;color:#0F8F68;margin-bottom:8px">一、作业打卡情况</div>' +
    '<table style="width:100%;border-collapse:collapse;margin-bottom:20px">' +
      '<tr style="background:#2FBF8F">' +
        '<th style="padding:7px 10px;border:1px solid #2FBF8F;font-size:13px;color:#fff;text-align:left">次数</th>' +
        '<th style="padding:7px 10px;border:1px solid #2FBF8F;font-size:13px;color:#fff;text-align:left">日期</th>' +
        '<th style="padding:7px 10px;border:1px solid #2FBF8F;font-size:13px;color:#fff;text-align:left">正确率</th>' +
        '<th style="padding:7px 10px;border:1px solid #2FBF8F;font-size:13px;color:#fff;text-align:left">错题</th>' +
      '</tr>' + rows + '</table>' +
    '<div style="font-size:15px;font-weight:700;color:#0F8F68;margin-bottom:8px">二、老师评语</div>' +
    (comment
      ? '<div style="background:#F8FAF9;border-left:4px solid #2FBF8F;padding:12px 14px;font-size:13px;color:#374151;line-height:1.7;white-space:pre-wrap;margin-bottom:20px">' + esc(comment) + '</div>'
      : '<div style="padding:12px 14px;font-size:13px;color:#9CA3AF;background:#F8FAF9;margin-bottom:20px">暂无评语</div>') +
    '<div style="font-size:15px;font-weight:700;color:#0F8F68;margin-bottom:8px">三、模考信息</div>' +
    '<table style="width:100%;border-collapse:collapse;margin-bottom:6px">' +
      '<tr><td style="padding:7px 10px;border:1px solid #DDE3E0;font-size:13px;color:#374151;background:#F8FAF9;width:110px">预约日期</td>' +
      '<td style="padding:7px 10px;border:1px solid #DDE3E0;font-size:13px;color:#374151">' + (mockDate ? esc(mockDate) : '未预约') + '</td></tr>' +
      '<tr><td style="padding:7px 10px;border:1px solid #DDE3E0;font-size:13px;color:#374151;background:#F8FAF9">结课模考分数</td>' +
      '<td style="padding:7px 10px;border:1px solid #DDE3E0;font-size:13px;color:#374151">' + (mockScore!=='' ? esc(mockScore) + ' 分' : '未录入') + '</td></tr>' +
    '</table>' +
    '<div style="font-size:15px;font-weight:700;color:#0F8F68;margin-bottom:8px">四、学习计划与建议</div>' +
    (advice
      ? '<div style="background:#F8FAF9;border-left:4px solid #2FBF8F;padding:12px 14px;font-size:13px;color:#374151;line-height:1.7;white-space:pre-wrap;margin-bottom:20px">' + esc(advice) + '</div>'
      : '<div style="padding:12px 14px;font-size:13px;color:#9CA3AF;background:#F8FAF9;margin-bottom:20px">暂无</div>') +
    '<div style="margin-top:26px;text-align:right;font-size:11px;color:#9CA3AF">本报告由「火箭学院 · 学情跟踪平台」自动生成</div>' +
    '</div>';
}
/* 点「生成报告」→ 先打开预览弹窗（A4 白底可滚动，复用 reportHtml 输出，内容结构不动） */
function genReport(){
  if(!quickEntry) return;
  const st = state.students.find(x=>x.id===quickEntry.gid);
  if(!st){ toast('未找到学生数据'); return; }
  document.getElementById('report-preview').innerHTML = reportHtml(st, quickEntry.subject);
  const shareRow = document.getElementById('rp-share-row');  // 每次打开重置分享区（防残留上一次链接）
  if(shareRow) shareRow.style.display = 'none';
  const shareInp = document.getElementById('rp-share-link');
  if(shareInp) shareInp.value = '';
  document.getElementById('report-modal').classList.add('show');
}
/* 「分享给家长」：API 模式调 share 接口生成 30 天免登录 H5 链接；mock 演示环境提示不支持 */
async function shareReportToParent(){
  if(!quickEntry) return;
  if(!USE_API){ toast('演示环境暂不支持分享（正式环境可用）'); return; }
  const r = await HttpApi.shareReport(quickEntry.gid, quickEntry.subject);
  if(!r.ok){ toast(r.msg || '生成分享链接失败'); return; }
  const origin = (typeof location !== 'undefined' && location.origin) ? location.origin : '';  // 桩环境无 location → 相对路径
  document.getElementById('rp-share-link').value = origin + r.url;
  document.getElementById('rp-share-row').style.display = '';
  toast('分享链接已生成，点「复制链接」发给家长');
}
/* 「复制链接」：clipboard API，老浏览器 execCommand 兜底 */
async function copyShareLink(){
  const inp = document.getElementById('rp-share-link');
  if(!inp || !inp.value) return;
  try{
    if(typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText){
      await navigator.clipboard.writeText(inp.value);
    } else {
      if(inp.select) inp.select();
      if(typeof document.execCommand === 'function') document.execCommand('copy');
    }
    toast('已复制，去微信粘贴给家长吧');
  }catch(e){ toast('复制失败，请手动长按链接复制'); }
}
/* 「⬇ 下载 PDF」：点击时才加载 CDN 组件，走既有生成流程；CDN 失败兜底打印窗口 */
async function downloadReport(){
  if(!quickEntry) return;
  const st = state.students.find(x=>x.id===quickEntry.gid);
  if(!st){ toast('未找到学生数据'); return; }
  const subject = quickEntry.subject;
  let area = document.getElementById('reportArea');
  if(!area){ area = document.createElement('div'); area.id = 'reportArea'; document.body.appendChild(area); }
  area.innerHTML = reportHtml(st, subject);
  const fileName = st.name + '_' + subjFileName(subject) + '_作业报告_' + todayStr() + '.pdf';
  try{
    await Promise.all([loadScript(REPORT_CDN.jspdf), loadScript(REPORT_CDN.html2canvas)]);
  }catch(e){
    toast('PDF 组件加载失败（可能网络受限），已打开打印窗口，请选择「另存为 PDF」。');
    printReport(area); return;
  }
  // 置于屏幕中央截图（遮罩效果），clone 完成后立即隐藏原始 DOM
  area.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:99999;background:#fff;box-shadow:0 0 0 9999px rgba(30,41,59,.45)';
  try{
    const canvas = await html2canvas(area, {scale:2, backgroundColor:'#ffffff', useCORS:true,
      onclone:()=>{ area.style.display='none'; }});
    const pageW = 794, pageH = 1123, pxPerPage = pageH*2;
    const pdf = new jspdf.jsPDF({orientation:'portrait', unit:'px', format:[pageW, pageH], compress:true});
    let y = 0, p = 1;
    while(y < canvas.height){
      if(p>1) pdf.addPage();
      const h = Math.min(pxPerPage, canvas.height - y);
      const c = document.createElement('canvas');
      c.width = canvas.width; c.height = h;
      c.getContext('2d').drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
      pdf.addImage(c.toDataURL('image/png'), 'PNG', 0, 0, pageW, h/2);
      y += h; p++;
    }
    pdf.save(fileName);
  }catch(e){
    area.style.display='none';
    toast('PDF 生成失败，已打开打印窗口，请选择「另存为 PDF」。');
    printReport(area);
  }
}
/* 「打印/另存为」：不加载 CDN，直接用打印兜底路径 */
function printReportDirect(){
  if(!quickEntry) return;
  const st = state.students.find(x=>x.id===quickEntry.gid);
  if(!st){ toast('未找到学生数据'); return; }
  let area = document.getElementById('reportArea');
  if(!area){ area = document.createElement('div'); area.id = 'reportArea'; document.body.appendChild(area); }
  area.innerHTML = reportHtml(st, quickEntry.subject);
  printReport(area);
}
document.getElementById('rp-close').addEventListener('click', ()=>document.getElementById('report-modal').classList.remove('show'));
document.getElementById('rp-download').addEventListener('click', ()=>{ downloadReport(); });
document.getElementById('rp-print').addEventListener('click', ()=>{ printReportDirect(); });
document.getElementById('rp-share').addEventListener('click', ()=>{ shareReportToParent(); });
document.getElementById('rp-copy').addEventListener('click', ()=>{ copyShareLink(); });
/* 「推送给家长」：服务号模板消息推送报告；未绑定时提示并打开绑定弹窗引导；mock 提示不支持 */
async function pushReportToParent(){
  if(!quickEntry) return;
  if(!USE_API){ toast('演示环境暂不支持推送（正式环境可用）'); return; }
  const r = await HttpApi.pushReport(quickEntry.gid, quickEntry.subject);
  if(r.ok){ toast('已推送到家长微信'); return; }
  toast(r.msg || '推送失败，请重试');
  if(r.msg && r.msg.indexOf('未绑定') !== -1) openBindModal(quickEntry.gid);  // 未绑定 → 引导绑定
}
document.getElementById('rp-push').addEventListener('click', ()=>{ pushReportToParent(); });
/* 手动推送（模考报名/成绩通知；防止家长没收到时补推。报告弹窗「推送给家长」是作业报告模板，别混） */
async function pushManual(kind){
  if(!quickEntry) return;
  if(!USE_API){ toast('演示环境暂不支持推送（正式环境可用）'); return; }
  const r = await HttpApi._req('POST', '/api/push/' + kind, { studentId: quickEntry.gid, subject: quickEntry.subject });
  if(r.ok){ toast('已推送到家长微信'); return; }
  toast(r.msg || '推送失败，请重试');
  if(r.msg && r.msg.indexOf('未绑定') !== -1) openBindModal(quickEntry.gid);  // 未绑定 → 引导绑定
}
/* 「绑定家长微信」：调 bind-qr 生成/复用学生专属二维码（同一学生二维码不变，可重复转发）；mock 提示不支持。
   按学生 id 参数化：学生卡头部「绑定家长微信」标签与推送失败引导共用，不再依赖打卡面板状态 */
async function openBindModal(gid){
  if(!gid) return;
  if(!USE_API){ toast('演示环境暂不支持绑定（正式环境可用）'); return; }
  const box = document.getElementById('bind-qr-box');
  box.innerHTML = '<p class="hint">二维码生成中…</p>';
  document.getElementById('bind-modal').classList.add('show');
  const r = await HttpApi.bindQr(gid);
  if(!r.ok){ box.innerHTML = '<p class="hint">' + esc(r.msg || '生成失败，请重试') + '</p>'; return; }
  box.innerHTML = '<img src="' + esc(r.qrUrl) + '" alt="家长绑定二维码" style="width:220px;height:220px;border-radius:12px;border:1px solid var(--line)">';
}

/* 「已绑定家长」管理弹窗：查看绑定列表（openid 脱敏）；教务可直解，助教走「申请解绑」（审批制）
   每名学生最多绑 2 名家长：未满员时给「+ 绑定新家长」入口，满员时提示需先解绑 */
function maskOpenid(o){ return o && o.length > 10 ? o.slice(0, 6) + '…' + o.slice(-4) : o; }
const MAX_BINDS = 2;
async function openBindsModal(gid){
  if(!gid) return;
  if(!USE_API){ toast('演示环境暂不支持绑定管理（正式环境可用）'); return; }
  const list = document.getElementById('binds-list');
  const foot = document.getElementById('binds-foot');
  list.innerHTML = '<p class="hint">加载中…</p>';
  foot.innerHTML = '';
  document.getElementById('binds-modal').classList.add('show');
  const r = await HttpApi.listBinds(gid);
  if(!r.ok){ list.innerHTML = '<p class="hint">' + esc(r.msg || '加载失败') + '</p>'; return; }
  // 助教视角：拉取自己待审批的解绑申请，对应行标「申请中」且不再显示按钮
  let pendingBindIds = [];
  if(currentUser && currentUser.role === 'ta'){
    const ur = await HttpApi._req('GET', '/api/unbind-requests?status=pending');
    if(ur && ur.ok && Array.isArray(ur.requests)) pendingBindIds = ur.requests.map(x=>x.bindId);
  }
  const cnt = r.binds.length;
  const isAdmin = currentUser && currentUser.role === 'admin';
  list.innerHTML = cnt
    ? r.binds.map(b=>
        '<div class="acct-row" style="align-items:center"><div class="grow"><b>' + esc(maskOpenid(b.openid)) + '</b>' +
        (pendingBindIds.indexOf(b.id) !== -1 ? ' <span class="tag amber">申请中</span>' : '') +
        '<div class="hint" style="margin-top:2px">绑定于 ' + esc(String(b.bound_at).slice(0, 10)) + '</div></div>' +
        (isAdmin
          ? '<button class="btn danger sm" onclick="unbindParent(\'' + gid + '\',\'' + b.id + '\')">解绑</button>'
          : (pendingBindIds.indexOf(b.id) !== -1
              ? ''
              : '<button class="btn ghost sm" onclick="requestUnbind(\'' + gid + '\',\'' + b.id + '\')">申请解绑</button>')) +
        '</div>').join('')
    : '<p class="hint">暂无绑定的家长。</p>';
  // 底部：已绑定 N/2 计数 + 未满员给绑定入口；满员给上限提示（需先解绑才能绑新微信）
  foot.innerHTML = '<div class="hint" style="margin-bottom:8px">已绑定 ' + cnt + ' / ' + MAX_BINDS + ' 名家长</div>' +
    (cnt >= MAX_BINDS
      ? '<div class="bind-limit-tip">该学生已绑定 ' + MAX_BINDS + ' 名家长（上限）。如需绑定新的微信，请先解绑其中一位。</div>'
      : '<button class="btn mint sm" onclick="openBindFromBinds(\'' + gid + '\')">+ 绑定新家长</button>');
}
/* 从「已绑定家长」弹窗跳到绑定二维码弹窗（同一学生二维码不变，可重复转发） */
function openBindFromBinds(gid){
  document.getElementById('binds-modal').classList.remove('show');
  openBindModal(gid);
}
/* 助教「申请解绑」：确认后创建审批申请，该行变为「申请中」 */
function requestUnbind(gid, bindId){
  askConfirm('申请解绑家长', '提交后由教务审批；通过后该家长微信不再收到这名学生的报告推送。确定申请解绑吗？', async ()=>{
    const r = await HttpApi._req('POST', '/api/students/' + gid + '/binds/' + bindId + '/unbind-request');
    if(!r.ok){ toast(r.msg || '申请失败'); return; }
    toast('已提交解绑申请，待教务审批');
    openBindsModal(gid);  // 刷新列表（该行变为「申请中」）
  });
}
function unbindParent(gid, bindId){
  askConfirm('解绑家长', '解绑后该家长微信将不再收到这名学生的报告推送。确定解绑吗？', async ()=>{
    const r = await HttpApi.unbindParent(gid, bindId);
    if(!r.ok){ toast(r.msg || '解绑失败'); return; }
    toast('已解绑');
    openBindsModal(gid);  // 刷新列表
    // 同步本地 bindCnt 并重渲学生卡
    const st = pool.students.find(x=>x.id===gid);
    if(st) st.bindCnt = Math.max(0, (st.bindCnt || 1) - 1);
    refreshView(); renderStats();
  });
}
document.getElementById('binds-close').addEventListener('click', ()=>document.getElementById('binds-modal').classList.remove('show'));
document.getElementById('bind-close').addEventListener('click', ()=>document.getElementById('bind-modal').classList.remove('show'));
function printReport(area){
  area.style.cssText = 'position:absolute;left:0;top:0;width:100%;background:#fff;z-index:99999;';
  window.print();
  setTimeout(()=>{ if(area) area.style.display='none'; }, 1500);
}
/* 保存老师评语（按 学生×科目 存储，同名组合并共享） */
function saveSubjectComment(){
  if(!quickEntry) return;
  const ta = document.getElementById('qe-comment');
  const text = ta ? ta.value : '';
  const st = state.students.find(x=>x.id===quickEntry.gid);
  if(st){
    st.subjComments = st.subjComments || {};
    st.subjComments[quickEntry.subject] = text.trim();
    logAction('保存评语', 'record', auditStuDesc(st.id, quickEntry.subject), text.trim() ? text.trim().slice(0,50) : '（清空评语）', {ownerId: st.ownerId});
    apiPersist(HttpApi.updateSubjFields(st.id, {subjComments: st.subjComments}));  // API 模式：整体提交评语列
    save();
  }
  const tip = document.getElementById('qe-comment-tip');
  if(tip){ tip.style.display='inline'; setTimeout(()=>{ if(tip) tip.style.display='none'; }, 2500); }
}
/* 保存学习计划与建议（按 学生×科目 存储，随「生成报告」输出为第四节） */
function saveSubjectAdvice(){
  if(!quickEntry) return;
  const ta = document.getElementById('qe-advice');
  const text = ta ? ta.value : '';
  const st = state.students.find(x=>x.id===quickEntry.gid);
  if(st){
    st.subjAdvice = st.subjAdvice || {};
    st.subjAdvice[quickEntry.subject] = text.trim();
    logAction('保存学习计划与建议', 'record', auditStuDesc(st.id, quickEntry.subject), text.trim() ? text.trim().slice(0,50) : '（清空）', {ownerId: st.ownerId});
    apiPersist(HttpApi.updateSubjFields(st.id, {subjAdvice: st.subjAdvice}));
    save();
  }
  const tip = document.getElementById('qe-advice-tip');
  if(tip){ tip.style.display='inline'; setTimeout(()=>{ if(tip) tip.style.display='none'; }, 2500); }
}

/* ================= 模考预约与结课分数（按 学生×科目 存储） ================= */
let mockEdit = null;  // {gid, subject, field:'date'|'score'} 当前展开的编辑行
function editMock(field){
  if(!quickEntry) return;
  mockEdit = {gid:quickEntry.gid, subject:quickEntry.subject, field:field};
  renderStats();
}
function getMockStu(){
  return state.students.find(x=>x.id===quickEntry.gid);
}
function getMockSlot(st, subject){
  if(!st) return null;
  st.mock = st.mock || {};
  st.mock[subject] = st.mock[subject] || {};
  return st.mock[subject];
}
function bookMockExam(){
  if(!quickEntry) return;
  const d = document.getElementById('mock-date').value;
  if(!d){ toast('请选择模考日期'); return; }
  const slot = getMockSlot(getMockStu(), quickEntry.subject);
  slot.date = d;
  const mst = getMockStu();
  logAction('预约模考', 'record', auditStuDesc(quickEntry.gid, quickEntry.subject), '预约日期 ' + d, {ownerId: mst ? mst.ownerId : undefined});
  if(mst) apiPersist(HttpApi.updateSubjFields(mst.id, {mock: mst.mock}),
    r=>{ if(r && r.pushed) toast('模考时间已推送给家长'); });  // API 模式：整体提交模考列；开关打开时服务端自动推送
  mockEdit = null;
  save();
  renderAll();
}
function cancelMockExam(){
  if(!quickEntry) return;
  const st = getMockStu();
  if(st && st.mock && st.mock[quickEntry.subject]){
    delete st.mock[quickEntry.subject].date;
    if(!Object.keys(st.mock[quickEntry.subject]).length) delete st.mock[quickEntry.subject];
    logAction('取消模考预约', 'record', auditStuDesc(quickEntry.gid, quickEntry.subject), '', {ownerId: st.ownerId});
    apiPersist(HttpApi.updateSubjFields(st.id, {mock: st.mock}));
  }
  mockEdit = null;
  save();
  renderAll();
}
function saveMockScore(){
  if(!quickEntry) return;
  const v = parseInt(document.getElementById('mock-score').value, 10);
  if(isNaN(v) || v<0 || v>100){ toast('请填写 0-100 之间的模考分数'); return; }
  const slot = getMockSlot(getMockStu(), quickEntry.subject);
  slot.score = v;
  const mst = getMockStu();
  logAction('保存模考分数', 'record', auditStuDesc(quickEntry.gid, quickEntry.subject), '结课模考 ' + v + ' 分', {ownerId: mst ? mst.ownerId : undefined});
  if(mst) apiPersist(HttpApi.updateSubjFields(mst.id, {mock: mst.mock}),
    r=>{ if(r && r.pushed) toast('模考成绩已推送给家长'); });  // 开关打开时服务端自动推送成绩通知
  mockEdit = null;
  save();
  renderAll();
}
function clearMockScore(){
  if(!quickEntry) return;
  const st = getMockStu();
  if(st && st.mock && st.mock[quickEntry.subject]){
    delete st.mock[quickEntry.subject].score;
    if(!Object.keys(st.mock[quickEntry.subject]).length) delete st.mock[quickEntry.subject];
    logAction('清除模考分数', 'record', auditStuDesc(quickEntry.gid, quickEntry.subject), '', {ownerId: st.ownerId});
    apiPersist(HttpApi.updateSubjFields(st.id, {mock: st.mock}));
  }
  mockEdit = null;
  save();
  renderAll();
}

/* ================= 卡内新增科目 Tab ================= */
let addSubjGid = null;  // 当前展开新增科目面板的学生代表 id
function toggleAddSubject(gid){
  addSubjGid = (addSubjGid === gid) ? null : gid;
  renderStats();
}
function addSubjPanelHtml(gid){
  const p = 'as-' + gid;
  const s1opts = '<option value="">选择分类…</option>' +
    Object.keys(subjectTree()).map(k=>'<option value="' + k + '">' + k + '</option>').join('') +
    '<option value="__custom__">自定义…</option>';
  return '<div class="add-subj-panel">' +
    '<div class="add-subj-title">选择该学生的学习科目</div>' +
    '<div class="subject-row">' +
    '<select id="' + p + '-s1" onchange="asSub1Change(\'' + gid + '\')">' + s1opts + '</select>' +
    '<select id="' + p + '-s2" onchange="asSub2Change(\'' + gid + '\')" disabled><option value="">二级科目…</option></select>' +
    '<select id="' + p + '-s3" disabled style="display:none"><option value="">三级科目…</option></select>' +
    '<input id="' + p + '-custom" placeholder="输入自定义科目" style="display:none">' +
    '</div>' +
    '<div style="margin-top:10px;display:flex;gap:8px">' +
    '<button class="btn mint sm" onclick="confirmAddSubject(\'' + gid + '\')">确认添加科目</button>' +
    '<button class="btn ghost sm" onclick="toggleAddSubject(\'' + gid + '\')">取消</button>' +
    '</div>' +
    '</div>';
}
function asSub1Change(gid){
  const p = 'as-' + gid;
  const v = document.getElementById(p + '-s1').value;
  const s2 = document.getElementById(p + '-s2');
  const s3 = document.getElementById(p + '-s3');
  const custom = document.getElementById(p + '-custom');
  s2.innerHTML = '<option value="">二级科目…</option>'; s2.disabled = true;
  s3.innerHTML = '<option value="">三级科目…</option>'; s3.disabled = true; s3.style.display = 'none';
  custom.style.display = 'none';
  if(v === '__custom__'){ custom.style.display = 'block'; return; }
  const tree = subjectTree();
  if(v && tree[v]){
    s2.innerHTML = '<option value="">二级科目…</option>' +
      Object.keys(tree[v]).map(k=>'<option value="' + k + '">' + k + '</option>').join('');
    s2.disabled = false;
  }
}
function asSub2Change(gid){
  const p = 'as-' + gid;
  const v1 = document.getElementById(p + '-s1').value;
  const v2 = document.getElementById(p + '-s2').value;
  const s3 = document.getElementById(p + '-s3');
  s3.innerHTML = '<option value="">三级科目…</option>'; s3.disabled = true; s3.style.display = 'none';
  const tree = subjectTree();
  const children = (v1 && tree[v1]) ? tree[v1][v2] : null;
  if(children){
    s3.innerHTML = '<option value="">三级科目…</option>' +
      children.map(k=>'<option value="' + k + '">' + k + '</option>').join('');
    s3.disabled = false; s3.style.display = 'block';
  }
}
function getAddSubjValue(gid){
  const p = 'as-' + gid;
  const v1 = document.getElementById(p + '-s1').value;
  if(!v1) return null;
  if(v1 === '__custom__') return document.getElementById(p + '-custom').value.trim() || null;
  const v2 = document.getElementById(p + '-s2').value;
  if(!v2) return v1;
  const s3 = document.getElementById(p + '-s3');
  if(!s3.disabled && s3.value) return v1 + ' / ' + v2 + ' / ' + s3.value;
  return v1 + ' / ' + v2;
}
function confirmAddSubject(gid){
  const subj = getAddSubjValue(gid);
  if(!subj){ toast('请选择科目'); return; }
  const repStu = state.students.find(s=>s.id===gid);
  if(!repStu) return;
  const name = repStu.name.trim();
  let added = false;
  state.students.forEach(s=>{
    if(!s.archived && s.name.trim()===name){
      if(!s.subjects) s.subjects = [];
      if(!s.subjects.includes(subj)){ s.subjects.push(subj); added = true; }
    }
  });
  addSubjGid = null;
  if(added){
    logAction('添加科目', 'student', repStu.name, subj, {ownerId: repStu.ownerId});
    // API 模式：同名组每个学生分别整体提交科目列表
    state.students.forEach(s=>{ if(!s.archived && s.name.trim()===name) apiPersist(HttpApi.updateSubjFields(s.id, {subjects: s.subjects})); });
  }
  save();
  renderAll();
  if(!added) toast('该科目已在列表中，无需重复添加。');
}

