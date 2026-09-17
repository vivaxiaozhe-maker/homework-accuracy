/* 家长推送下沉助手（三个业务模板 + 自动/手动推送共用；docs/parent-push-plan.md）
   kind：homework=作业批改完成通知 / mockBook=考试报名成功通知 / mockScore=考试成绩通知。
   模板字段映射（微信结构已从接口确认）：
     homework:  thing15=学科短名 / thing1=学生姓名 / character_string18=正确率%
     mockBook:  time4=预约日期 / thing3=科目短名+「模考」 / thing6=学生姓名
     mockScore: thing22=科目短名 / thing10=学生姓名 / character_string12=分数+「分」
   url 统一为分享报告链接（复用 reports.ensureShareToken）。 */
const db = require('./db');
const wx = require('./wechat');
const { logAudit, parseJson, shortSubject } = require('./util');
const { ensureShareToken } = require('./routes/reports');

const KIND_LABEL = { homework: '作业批改完成通知', mockBook: '考试报名成功通知', mockScore: '考试成绩通知' };
const TEMPLATE_CFG_KEY = { homework: 'templateHomework', mockBook: 'templateMockBook', mockScore: 'templateMockScore' };

/* 推送开关（settings.push_config JSON；默认全关，仅教务可改） */
const PUSH_CFG_DEFAULT = { homework: false, mockBook: false, mockScore: false };
function pushConfig(){
  const row = db.prepare("SELECT value FROM settings WHERE key = 'push_config'").get();
  if(!row) return Object.assign({}, PUSH_CFG_DEFAULT);
  try{
    const c = JSON.parse(row.value);
    return { homework: !!c.homework, mockBook: !!c.mockBook, mockScore: !!c.mockScore };
  }catch(e){ return Object.assign({}, PUSH_CFG_DEFAULT); }
}
function savePushConfig(c){
  db.prepare("INSERT INTO settings (key, value) VALUES ('push_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ homework: !!c.homework, mockBook: !!c.mockBook, mockScore: !!c.mockScore }));
}
function autoEnabled(kind){ return pushConfig()[kind] === true; }

/* 分享报告链接（推送消息点开的落地页） */
function shareUrlFor(req, st, subject){
  return 'https://' + req.headers.host + '/r/' + ensureShareToken(req.user, st, subject).token;
}

/* 推送执行：查有效绑定 → 逐个 template/send（callWithTokenRetry 自愈）→ 43004 标失效 → 审计。
   slotOverride：自动推送场景传新模考值（st 为更新前旧行，直接读会拿到旧日期/旧分数——已踩过）。
   返回 {sent} / {err, status}（status 供路由响应码：400 未绑定 / 503 未配置 / 502 微信接口失败） */
async function pushTemplate(user, st, kind, subject, url, slotOverride){
  if(!wx.configured()) return { err: '服务号未配置', status: 503 };
  const templateId = wx.cfg()[TEMPLATE_CFG_KEY[kind]];
  if(!templateId) return { err: '模板消息未配置', status: 503 };
  const binds = db.prepare('SELECT * FROM parent_binds WHERE student_id = ? AND unbound = 0').all(st.id);
  if(!binds.length) return { err: '该学生未绑定家长微信', status: 400 };
  const data = buildTplData(kind, st, subject, slotOverride);
  if(!data) return { err: '缺少推送所需数据（如模考日期/分数）', status: 400 };
  let sent = 0, unboundCnt = 0;
  try{
    for(const b of binds){
      try{
        const d = await wx.callWithTokenRetry(accessToken => fetch(
          'https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=' + accessToken, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ touser: b.openid, template_id: templateId, url: url, data: data })
          }).then(r => r.json()));
        if(d && (d.errcode === 0 || d.errcode === undefined)) sent++;
        else if(d && d.errcode === 43004){  // 家长已取关：标记绑定失效
          db.prepare('UPDATE parent_binds SET unbound = 1 WHERE id = ?').run(b.id);
          unboundCnt++;
        }
      }catch(e){ /* 单个家长失败不阻塞其他人 */ }
    }
  }catch(e){ return { err: '微信接口调用失败：' + e.message, status: 502 }; }
  logAudit(user, '推送' + KIND_LABEL[kind], 'student', st.name + ' · ' + shortSubject(subject),
    '成功 ' + sent + ' 人' + (unboundCnt ? '，' + unboundCnt + ' 人已取关标记失效' : ''), st.owner_id);
  if(!sent) return { err: '推送失败（家长可能已取关，请重新绑定）', status: 400 };
  return { sent: sent };
}

/* 按模板结构组装字段；缺数据返回 null。slotOverride：自动推送时的新模考值（优先于库内旧值） */
function buildTplData(kind, st, subject, slotOverride){
  const sn = shortSubject(subject);
  if(kind === 'homework'){
    // 最近正确率：该学生该科目最近一条作业记录
    const lastRec = db.prepare('SELECT * FROM records WHERE student_id = ? AND subject = ? ORDER BY date DESC LIMIT 1').get(st.id, subject);
    const acc = lastRec ? (lastRec.total > 0 ? Math.round(lastRec.correct / lastRec.total * 100) : 0) + '%' : '暂无记录';
    return { thing15: { value: sn }, thing1: { value: st.name }, character_string18: { value: acc } };
  }
  const slot = slotOverride || parseJson(st.mock, {})[subject] || {};
  if(kind === 'mockBook'){
    if(!slot.date) return null;
    return { time4: { value: String(slot.date) }, thing3: { value: sn + '模考' }, thing6: { value: st.name } };
  }
  if(kind === 'mockScore'){
    if(slot.score === undefined || slot.score === null || slot.score === '') return null;
    return { thing22: { value: sn }, thing10: { value: st.name }, character_string12: { value: String(slot.score) + ' 分' } };
  }
  return null;
}

/* ---- 自动推送触发（开关打开才推；静默失败不阻塞保存流程，返回是否已推） ---- */
async function autoHomework(req, st, subject){
  if(!autoEnabled('homework')) return false;
  const r = await pushTemplate(req.user, st, 'homework', subject, shareUrlFor(req, st, subject));
  return !!r.sent;
}
/* 模考列对比新旧值：date 从无到有/变化 → mockBook；score 变化（且有效）→ mockScore */
async function autoMock(req, st, oldMockAll, newMockAll){
  const out = { mockBook: false, mockScore: false };
  for(const sub of Object.keys(newMockAll || {})){
    const oldS = (oldMockAll || {})[sub] || {};
    const newS = newMockAll[sub] || {};
    if(autoEnabled('mockBook') && newS.date && String(newS.date) !== String(oldS.date || '')){
      const r = await pushTemplate(req.user, st, 'mockBook', sub, shareUrlFor(req, st, sub), newS);  // 传新值（st 是更新前旧行）
      if(r.sent) out.mockBook = true;
    }
    const newScore = (newS.score === undefined || newS.score === null) ? '' : String(newS.score);
    const oldScore = (oldS.score === undefined || oldS.score === null) ? '' : String(oldS.score);
    if(autoEnabled('mockScore') && newScore !== '' && newScore !== oldScore){
      const r = await pushTemplate(req.user, st, 'mockScore', sub, shareUrlFor(req, st, sub), newS);
      if(r.sent) out.mockScore = true;
    }
  }
  return out;
}

module.exports = { pushConfig, savePushConfig, autoEnabled, pushTemplate, buildTplData, autoHomework, autoMock, shareUrlFor, KIND_LABEL };
