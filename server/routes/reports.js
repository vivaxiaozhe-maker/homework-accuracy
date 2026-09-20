/* 报告分享路由（家长 H5 报告页 + 服务号模板消息推送，方案：docs/parent-push-plan.md 第 1/3 步）
   - POST /api/reports/share            助教/教务生成（或复用）分享链接，归属校验在路由内
   - POST /api/reports/share/:token/revoke  撤销（创建者本人或教务）
   - POST /api/reports/push             模板消息推送给已绑定家长
   - GET  /r/:token                     公开只读报告页在 index.js 单独挂载（/api 全局守卫之外） */
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { requireRole } = require('../auth');
const { logAudit, canWrite, parseJson, nowTs } = require('../util');
const wx = require('../wechat');

const router = express.Router();
router.use(requireRole('ta', 'admin'));  // 销售无报告分享/推送入口（前端销售端也无报告弹窗）

const SHARE_DAYS = 30;

/* 创建/复用分享 token（同学生同科目同类型有未过期未撤销的链接 → 复用）：返回 {token, reused}
   kind：homework（作业成绩/报告分享，默认）/ mockbook（模考报名）/ mockscore（模考成绩）——落地页按类型渲染 */
function ensureShareToken(user, st, subject, kind){
  kind = kind || 'homework';
  const nowIso = new Date().toISOString();
  const exist = db.prepare(`SELECT token FROM share_tokens
                            WHERE student_id = ? AND subject = ? AND IFNULL(kind,'homework') = ? AND revoked = 0 AND expires_at > ?
                            ORDER BY created_at DESC`).get(st.id, subject, kind, nowIso);
  if(exist) return { token: exist.token, reused: true };
  const token = crypto.randomBytes(16).toString('hex');  // 32 位 hex
  const exp = new Date(Date.now() + SHARE_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO share_tokens (token, student_id, subject, created_by, created_at, expires_at, revoked, kind) VALUES (?,?,?,?,?,?,0,?)')
    .run(token, st.id, subject, user.id, nowIso, exp, kind);
  logAudit(user, '生成分享链接', 'student', st.name + ' · ' + subject, '有效期 ' + SHARE_DAYS + ' 天', st.owner_id);
  return { token: token, reused: false };
}

// POST /api/reports/share {studentId, subject}：创建分享链接；同学生同科目复用未过期未撤销的 token
router.post('/share', (req, res) => {
  const { studentId, subject } = req.body || {};
  if(!studentId || !subject) return res.status(400).json({ ok: false, msg: '缺少学生或科目' });
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限操作该数据' });
  const r = ensureShareToken(req.user, st, subject);
  res.json({ ok: true, url: '/r/' + r.token, reused: r.reused });
});

/* POST /api/reports/push {studentId, subject}：模板消息推送给该学生已绑定的家长（方案第 3 步）
   生成/复用分享链接 → 查有效绑定 → 逐个调 template/send；errcode 43004（家长已取关）标记绑定失效 */
router.post('/push', async (req, res) => {
  const { studentId, subject } = req.body || {};
  if(!studentId || !subject) return res.status(400).json({ ok: false, msg: '缺少学生或科目' });
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限操作该数据' });
  if(!wx.configured()) return res.status(503).json({ ok: false, msg: '服务号未配置' });
  const binds = db.prepare('SELECT * FROM parent_binds WHERE student_id = ? AND unbound = 0').all(studentId);
  if(!binds.length) return res.status(400).json({ ok: false, msg: '该学生未绑定家长微信' });
  if(!wx.cfg().templateId) return res.status(503).json({ ok: false, msg: '模板消息未配置' });
  const shareUrl = 'https://' + req.headers.host + '/r/' + ensureShareToken(req.user, st, subject).token;
  // 最近正确率：该学生该科目最近一条作业记录
  const lastRec = db.prepare('SELECT * FROM records WHERE student_id = ? AND subject = ? ORDER BY date DESC LIMIT 1').get(studentId, subject);
  const lastAcc = lastRec ? (lastRec.total > 0 ? Math.round(lastRec.correct / lastRec.total * 100) : 0) + '%' : '暂无记录';
  // 模板字段按模式映射：homework=「作业批改完成通知」thing4/5/6/7/15；content=单字段 content；默认=first/keyword1-3/remark 通用结构
  let tplData;
  if(wx.cfg().templateMode === 'homework'){
    const ta = db.prepare('SELECT name FROM users WHERE id = ?').get(st.owner_id);
    tplData = {
      thing4: { value: st.name },                                    // 学员姓名
      thing5: { value: shortSubject(subject) },                      // 课程名称
      thing7: { value: '作业打卡报告（最近正确率 ' + lastAcc + '）' },  // 作业名称
      thing6: { value: ta ? ta.name : '助教' },                       // 批改教师
      thing15: { value: shortSubject(subject) }                      // 学科
    };
  } else if(wx.cfg().templateMode === 'content'){
    tplData = { content: { value: '【' + st.name + '】' + shortSubject(subject) + ' 作业打卡报告已更新，最近正确率 ' + lastAcc + '。点击查看完整打卡报告' } };
  } else {
    tplData = {
      first: { value: st.name + ' 的「' + shortSubject(subject) + '」作业打卡报告已更新' },
      keyword1: { value: st.name },
      keyword2: { value: shortSubject(subject) },
      keyword3: { value: lastAcc + '（' + nowTs().slice(0, 10) + '）' },
      remark: { value: '点击查看完整打卡报告' }
    };
  }
  let accessToken;
  try{ accessToken = await wx.getAccessToken(); }
  catch(e){ return res.status(502).json({ ok: false, msg: '微信接口调用失败：' + e.message }); }
  let sent = 0, unboundCnt = 0;
  for(const b of binds){
    try{
      const d = await wx.callWithTokenRetry(accessToken => fetch('https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=' + accessToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ touser: b.openid, template_id: wx.cfg().templateId, url: shareUrl, data: tplData })
      }).then(r => r.json()));
      if(d.errcode === 0 || d.errcode === undefined){ sent++; }
      else if(d.errcode === 43004){  // 家长已取关：标记绑定失效
        db.prepare('UPDATE parent_binds SET unbound = 1 WHERE id = ?').run(b.id);
        unboundCnt++;
      }
    }catch(e){ /* 单个家长失败不阻塞其他人 */ }
  }
  logAudit(req.user, '推送报告给家长', 'student', st.name + ' · ' + subject,
    '成功 ' + sent + ' 人' + (unboundCnt ? '，' + unboundCnt + ' 人已取关标记失效' : ''), st.owner_id);
  if(!sent) return res.status(400).json({ ok: false, msg: '推送失败（家长可能已取关，请重新绑定）' });
  res.json({ ok: true, sent: sent });
});

// POST /api/reports/share/:token/revoke：撤销（创建者本人或教务；幂等）
router.post('/share/:token/revoke', (req, res) => {
  const t = db.prepare('SELECT * FROM share_tokens WHERE token = ?').get(req.params.token);
  if(!t) return res.status(404).json({ ok: false, msg: '链接不存在' });
  if(req.user.role !== 'admin' && t.created_by !== req.user.id){
    return res.status(403).json({ ok: false, msg: '仅创建者本人或教务可撤销' });
  }
  if(!t.revoked){
    db.prepare('UPDATE share_tokens SET revoked = 1 WHERE token = ?').run(t.token);
    const st = db.prepare('SELECT name, owner_id FROM students WHERE id = ?').get(t.student_id);
    logAudit(req.user, '撤销分享链接', 'student', (st ? st.name : '（已删除学生）') + ' · ' + t.subject, '', st ? st.owner_id : null);
  }
  res.json({ ok: true });
});

/* ---- 公开报告页渲染（服务端直出，零 JS，样式内联，风格沿用奶油薄荷但独立简化） ---- */
function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 与前端 shortSubject 一致：「学科 / AP / 微积分BC」→「AP·微积分BC」
function shortSubject(s){
  if(!s) return '未指定';
  const p = String(s).split(' / ');
  if(p.length === 3) return p[1] + '·' + p[2];
  if(p.length === 2) return p[1];
  return s;
}
function accOf(r){ return r.total > 0 ? Math.round(r.correct / r.total * 100) : 0; }

const PAGE_CSS = `
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    background:#FAF5E9;color:#31423B;line-height:1.6;padding:22px 14px 40px}
  .page{max-width:720px;margin:0 auto;background:#fff;border:1px solid #EAE3D2;border-radius:16px;
    box-shadow:0 1px 2px rgba(62,90,78,.05),0 6px 20px rgba(62,90,78,.07);padding:28px 22px 34px}
  .head{border-bottom:3px solid #5FB89A;padding-bottom:14px;margin-bottom:18px}
  .head h1{font-size:24px;letter-spacing:1px}
  .meta{font-size:13px;color:#6B7C74;margin-top:8px}
  .meta b{color:#31423B}
  .date{font-size:12px;color:#9CA3AF;margin-top:4px}
  .cards{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}
  .card{flex:1;min-width:120px;background:#F0F8F4;border:1px solid #D8F0E5;border-radius:10px;padding:10px 12px;text-align:center}
  .card.bad{background:#FDF3F2;border-color:#F0C6C2}
  .card .l{font-size:12px;color:#6B7C74}
  .card .v{font-size:19px;font-weight:800;color:#3E9B7F}
  .card.bad .v{color:#DE6B6B}
  h2{font-size:15px;color:#3E9B7F;margin:18px 0 8px}
  table{width:100%;border-collapse:collapse;margin-bottom:6px}
  th{background:#5FB89A;color:#fff;font-size:13px;text-align:left;padding:7px 10px;border:1px solid #5FB89A}
  td{padding:7px 10px;border:1px solid #DDE3E0;font-size:13px;color:#374151}
  td.k{background:#F8FAF9;width:96px}
  .note{background:#F8FAF9;border-left:4px solid #5FB89A;padding:12px 14px;font-size:13px;color:#374151;
    line-height:1.7;white-space:pre-wrap;margin-bottom:6px;border-radius:0 8px 8px 0}
  .none{padding:12px 14px;font-size:13px;color:#9CA3AF;background:#F8FAF9;margin-bottom:6px;border-radius:8px}
  .foot{margin-top:26px;text-align:right;font-size:11px;color:#9CA3AF}
  /* 类型落地页大卡（模考预约时间 / 模考分数突出展示） */
  .hero{background:#F0F8F4;border:1px solid #D8F0E5;border-radius:14px;padding:20px;text-align:center;margin-bottom:18px}
  .hero .l{font-size:13px;color:#6B7C74}
  .hero .v{font-size:34px;font-weight:800;color:#3E9B7F;margin-top:6px}
  .hero .d{font-size:12px;color:#9CA3AF;margin-top:4px}
  .tips{background:#FBF0DC;border:1px solid #F0D9AC;border-radius:10px;padding:12px 14px;font-size:13px;color:#8A6D2A;line-height:1.8;margin-bottom:6px}
  .mini{display:flex;gap:8px;flex-wrap:wrap}
  .mini .m{flex:1;min-width:100px;background:#F8FAF9;border:1px solid #DDE3E0;border-radius:8px;padding:8px 10px;text-align:center}
  .mini .m .a{font-weight:800;color:#3E9B7F;font-size:16px}
  .mini .m .b{font-size:11px;color:#9CA3AF}
  .invalid{max-width:420px;margin:12vh auto 0;text-align:center}
  .invalid .ico{width:56px;height:56px;border-radius:50%;background:#FBF0DC;color:#B9802A;
    font-size:28px;line-height:56px;margin:0 auto 14px;font-weight:700}
  .invalid h1{font-size:18px;margin-bottom:8px}
  .invalid p{font-size:13px;color:#6B7C74}
`;

// 失效页（token 不存在 404 / 已撤销或过期 410）
function invalidPage(){
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>链接已失效 · 火箭学院</title><style>' + PAGE_CSS + '</style></head><body>' +
    '<div class="invalid"><div class="ico">!</div><h1>链接已失效</h1>' +
    '<p>该报告链接已撤销或已过期。<br>如需查看最新报告，请联系孩子的助教重新分享。</p></div>' +
    '</body></html>';
}

// 报告页：结构与前端 reportHtml 对齐（学生/科目/日期、四项统计卡、打卡情况表、评语、模考、建议、落款）
function reportPage(st, subject, recs){
  const plans = parseJson(st.subj_plans, {});
  const plan = plans[subject] || 0;
  const done = recs.length;
  const total = Math.max(plan, done);
  const rate = plan > 0 ? Math.round(done / plan * 100) + '%' : '—';
  const comments = parseJson(st.subj_comments, {});
  const advice = parseJson(st.subj_advice, {});
  const mock = parseJson(st.mock, {});
  const comment = comments[subject] || '';
  const adv = advice[subject] || '';
  const mk = mock[subject] || {};
  let rows = '';
  for(let i = 0; i < total; i++){
    const r = recs[i];
    if(r){
      const ra = accOf(r);
      const wrongs = (r.wrongs && parseJson(r.wrongs, []).length) ? esc(parseJson(r.wrongs, []).join('、')) : '无错题';
      rows += '<tr><td>第' + (i+1) + '次</td><td>' + esc(r.date) + '</td>' +
        '<td style="font-weight:700;color:' + (ra >= 85 ? '#0F8F68' : (ra >= 60 ? '#B9802A' : '#DC2626')) + '">' + ra + '%</td>' +
        '<td>' + wrongs + '</td></tr>';
    } else {
      rows += '<tr><td>第' + (i+1) + '次</td><td>未完成</td>' +
        '<td style="font-weight:700;color:#DC2626">—</td><td style="color:#DC2626">未完成</td></tr>';
    }
  }
  if(!rows) rows = '<tr><td colspan="4" style="color:#9CA3AF">暂无作业记录</td></tr>';
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + esc(st.name) + ' 的作业打卡报告 · 火箭学院</title><style>' + PAGE_CSS + '</style></head><body>' +
    '<div class="page">' +
    '<div class="head"><h1>作业打卡报告</h1>' +
      '<div class="meta">学生：<b>' + esc(st.name) + '</b>' +
      '　｜　科目：<b>' + esc(shortSubject(subject)) + '</b></div>' +
      '<div class="date">生成日期：' + nowTs().slice(0, 10) + '</div></div>' +
    '<div class="cards">' +
      '<div class="card"><div class="l">应完成</div><div class="v">' + plan + ' 次</div></div>' +
      '<div class="card"><div class="l">已完成</div><div class="v">' + done + ' 次</div></div>' +
      '<div class="card bad"><div class="l">未完成</div><div class="v">' + Math.max(0, total - done) + ' 次</div></div>' +
      '<div class="card"><div class="l">完成率</div><div class="v">' + rate + '</div></div></div>' +
    '<h2>一、作业打卡情况</h2>' +
    '<table><tr><th>次数</th><th>日期</th><th>正确率</th><th>错题</th></tr>' + rows + '</table>' +
    // 空字段隐藏整个区块：无评语/无模考/无建议则不留空标题（三类落地页统一口径）
    (comment ? '<h2>二、老师评语</h2><div class="note">' + esc(comment) + '</div>' : '') +
    ((mk.date || (mk.score !== undefined && mk.score !== null && mk.score !== ''))
      ? '<h2>三、模考信息</h2>' +
        '<table><tr><td class="k">预约日期</td><td>' + (mk.date ? esc(mk.date) : '未预约') + '</td></tr>' +
        '<tr><td class="k">结课模考分数</td><td>' + (mk.score !== undefined && mk.score !== null && mk.score !== '' ? esc(mk.score) + ' 分' : '未录入') + '</td></tr></table>'
      : '') +
    (adv ? '<h2>四、学习计划与建议</h2><div class="note">' + esc(adv) + '</div>' : '') +
    '<div class="foot">本报告由「火箭学院 · 学情跟踪平台」自动生成</div>' +
    '</div></body></html>';
}

/* ---- 类型落地页共用：头部（学生/科目/日期）与近期作业摘要（近 3 条，空则隐藏） ---- */
function pageHead(st, subject, h1){
  return '<div class="head"><h1>' + h1 + '</h1>' +
    '<div class="meta">学生：<b>' + esc(st.name) + '</b>' +
    '　｜　科目：<b>' + esc(shortSubject(subject)) + '</b></div>' +
    '<div class="date">生成日期：' + nowTs().slice(0, 10) + '</div></div>';
}
function recentRecsHtml(recs){
  if(!recs.length) return '';  // 无作业记录：整个摘要区块隐藏
  const last = recs.slice(-3).reverse();  // 最近 3 条（新→旧）
  return '<h2>近期作业表现</h2><div class="mini">' + last.map(r=>{
    const a = accOf(r);
    return '<div class="m"><div class="a">' + a + '%</div><div class="b">' + esc(r.date) + '</div></div>';
  }).join('') + '</div>';
}
const PAGE_FOOT = '<div class="foot">本报告由「火箭学院 · 学情跟踪平台」自动生成</div>';

/* 模考报名落地页：预约时间大卡 + 备考提示 + 近期作业摘要（空字段隐藏） */
function mockBookPage(st, subject, recs){
  const mk = (parseJson(st.mock, {})[subject]) || {};
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + esc(st.name) + ' 的模考预约 · 火箭学院</title><style>' + PAGE_CSS + '</style></head><body>' +
    '<div class="page">' + pageHead(st, subject, '模考预约提醒') +
    '<div class="hero"><div class="l">预约模考时间</div><div class="v">' + esc(mk.date || '待定') + '</div></div>' +
    '<div class="tips">备考提示：请提前 15 分钟到场，带好文具与准考证；考前可让孩子复习近期错题，保持作息规律。</div>' +
    recentRecsHtml(recs) +
    PAGE_FOOT + '</div></body></html>';
}

/* 模考成绩落地页：分数大卡 + 历次（其他科目）模考对比 + 近期作业摘要（空字段隐藏） */
function mockScorePage(st, subject, recs){
  const mockAll = parseJson(st.mock, {});
  const mk = mockAll[subject] || {};
  // 历次对比：该学生其他科目已录入的模考分数（无则整块隐藏）
  const others = Object.keys(mockAll).filter(k => k !== subject &&
    mockAll[k] && mockAll[k].score !== undefined && mockAll[k].score !== null && mockAll[k].score !== '');
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + esc(st.name) + ' 的模考成绩 · 火箭学院</title><style>' + PAGE_CSS + '</style></head><body>' +
    '<div class="page">' + pageHead(st, subject, '模考成绩通知') +
    '<div class="hero"><div class="l">结课模考分数</div><div class="v">' + esc(mk.score) + ' 分</div>' +
    (mk.date ? '<div class="d">模考日期 ' + esc(mk.date) + '</div>' : '') + '</div>' +
    (others.length
      ? '<h2>其他科目模考成绩</h2><div class="mini">' + others.map(k=>
          '<div class="m"><div class="a">' + esc(mockAll[k].score) + ' 分</div><div class="b">' + esc(shortSubject(k)) + '</div></div>').join('') + '</div>'
      : '') +
    recentRecsHtml(recs) +
    PAGE_FOOT + '</div></body></html>';
}

// GET /r/:token：公开只读报告页（免登录；只含该学生该科目数据；按分享类型渲染对应落地页）
function sharePage(req, res){
  const t = db.prepare('SELECT * FROM share_tokens WHERE token = ?').get(req.params.token);
  if(!t) return res.status(404).send(invalidPage());
  if(t.revoked || t.expires_at <= new Date().toISOString()) return res.status(410).send(invalidPage());
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(t.student_id);
  if(!st) return res.status(410).send(invalidPage());  // 学生已删除（暂不可达，保留防御）
  // 访问审计：公开访问无登录用户（user 字段为空），归属快照便于助教口径过滤
  logAudit(null, '访问分享报告', 'student', st.name + ' · ' + t.subject, '家长端打开报告页', st.owner_id);
  const recs = db.prepare('SELECT * FROM records WHERE student_id = ? AND subject = ? ORDER BY date').all(t.student_id, t.subject);
  res.setHeader('Cache-Control', 'no-store');
  const kind = t.kind || 'homework';  // 旧行 NULL 按作业成绩页处理
  if(kind === 'mockbook') return res.send(mockBookPage(st, t.subject, recs));
  if(kind === 'mockscore') return res.send(mockScorePage(st, t.subject, recs));
  res.send(reportPage(st, t.subject, recs));
}

module.exports = { router, sharePage, ensureShareToken };
