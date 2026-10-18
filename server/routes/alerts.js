/* 首页待办预警操作路由（v1.5.0）：POST /api/alerts/action
   预警动作：snooze（稍后处理，snoozeUntil 当天有效，明天再出现）/ done（完成，永久消失并进已处理事项）
   / shelve（搁置：家长侧等暂不可控的逾期项，长期退出待办，进已处理事项可查；仅 kind=miss 允许）。
   归属校验：miss → missed 记录归属；lowAcc/planStall → refKey 中 studentId 的学生归属。助教只能处理自己名下。 */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../auth');
const { uid, logAudit, canWrite } = require('../util');

const router = express.Router();

// POST /api/alerts/action {kind, refKey, action, snoozeUntil?}
router.post('/alerts/action', requireRole('ta', 'admin'), (req, res) => {
  const { kind, refKey, action, snoozeUntil, note } = req.body || {};
  if(['miss', 'lowAcc', 'planStall'].indexOf(kind) === -1) return res.status(400).json({ ok: false, msg: 'kind 不合法' });
  if(!refKey) return res.status(400).json({ ok: false, msg: '缺少 refKey' });
  if(!['snooze', 'done', 'shelve'].includes(action)) return res.status(400).json({ ok: false, msg: 'action 不合法' });
  // shelve（搁置）仅限未交类预警：低分/停滞没有「家长侧不可控」语义，不允许搁置
  if(action === 'shelve' && kind !== 'miss') return res.status(400).json({ ok: false, msg: '仅未交类预警支持搁置' });
  if(action === 'snooze' && !/^\d{4}-\d{2}-\d{2}$/.test(String(snoozeUntil || '')))
    return res.status(400).json({ ok: false, msg: 'snoozeUntil 格式应为 YYYY-MM-DD' });
  const noteStr = String(note || '').slice(0, 50);
  // 解析 ref_key 归属
  let ownerId = null, desc = '';
  if(kind === 'miss'){
    const m = db.prepare('SELECT owner_id FROM missed WHERE id = ?').get(refKey);
    if(!m) return res.status(404).json({ ok: false, msg: '未交记录不存在' });
    ownerId = m.owner_id; desc = '未交 ' + refKey;
  } else {
    const st = db.prepare('SELECT * FROM students WHERE id = ?').get(String(refKey).split('|')[0]);
    if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
    ownerId = st.owner_id;
    desc = st.name + ' · ' + String(refKey).split('|').slice(1).join('|');
  }
  if(!canWrite(req.user, ownerId)) return res.status(403).json({ ok: false, msg: '没有权限操作该数据' });
  const id = uid('aa_');
  db.prepare(`INSERT INTO alert_actions (id, kind, ref_key, action, actor_id, actor_name, note, created_at, snooze_until)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, kind, refKey, action, req.user.id, req.user.name, noteStr,
      new Date().toISOString(), action === 'snooze' ? snoozeUntil : null);
  logAudit(req.user, action === 'done' ? '预警完成' : action === 'shelve' ? '搁置逾期预警' : '预警稍后处理', 'student', desc,
    (kind === 'miss' ? '未交' : kind === 'lowAcc' ? '正确率偏低' : '计划停滞') +
    (action === 'snooze' ? '，稍后至 ' + snoozeUntil : '') + (noteStr ? '，原因：' + noteStr : ''), ownerId);
  res.json({ ok: true, id: id });
});

module.exports = router;
