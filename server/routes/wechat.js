/* 微信服务器回调（公开路径，挂在 /api 全局守卫之外；安全性靠微信签名验证）
   GET  /api/wechat/callback  服务器配置验证（echostr 原样返回）
   POST /api/wechat/callback  消息/事件接收：subscribe（首次关注，EventKey=qrscene_xxx）/ SCAN（已关注扫码）→ 绑定；
                              unsubscribe（取关）→ 标记绑定失效 */
const express = require('express');
const db = require('../db');
const wx = require('../wechat');
const { uid } = require('../util');

const router = express.Router();

/* GET：服务器配置验证 */
router.get('/callback', (req, res) => {
  if(!wx.configured()) return res.status(503).json({ ok: false, msg: '服务号未配置' });
  const { signature, timestamp, nonce, echostr } = req.query;
  if(!wx.checkSignature(signature, timestamp, nonce)) return res.status(403).json({ ok: false, msg: '验签失败' });
  res.type('text/plain').send(String(echostr || ''));
});

/* POST：消息/事件（text/xml 原文解析；先验签再处理） */
router.post('/callback', express.text({ type: ['text/xml', 'application/xml', 'text/*'] }), (req, res) => {
  if(!wx.configured()) return res.status(503).json({ ok: false, msg: '服务号未配置' });
  const { signature, timestamp, nonce } = req.query;
  if(!wx.checkSignature(signature, timestamp, nonce)) return res.status(403).json({ ok: false, msg: '验签失败' });
  const xml = typeof req.body === 'string' ? req.body : '';
  const openid = wx.xmlVal(xml, 'FromUserName');
  const toUser = wx.xmlVal(xml, 'ToUserName');
  const event = wx.xmlVal(xml, 'Event');
  let scene = wx.xmlVal(xml, 'EventKey');
  res.type('application/xml');

  // 取关：该 openid 全部绑定标记失效（留痕不删行）
  if(event === 'unsubscribe'){
    if(openid) db.prepare('UPDATE parent_binds SET unbound = 1 WHERE openid = ?').run(openid);
    return res.send(wx.replyText(toUser, openid, ''));
  }

  // 关注/扫码：scene = 学生绑定 token（首次关注带 qrscene_ 前缀）
  if(event === 'subscribe' || event === 'SCAN'){
    if(event === 'subscribe' && scene.indexOf('qrscene_') === 0) scene = scene.slice('qrscene_'.length);
    const st = scene ? db.prepare('SELECT * FROM students WHERE bind_token = ?').get(scene) : null;
    if(!st || !openid){
      return res.send(wx.replyText(toUser, openid, '欢迎关注火箭学院。如需接收孩子的作业报告，请向助教获取学生专属二维码扫码绑定。'));
    }
    // 幂等绑定：已有有效绑定 → 不重复；曾取关 → 恢复；无记录 → 新建
    const exist = db.prepare('SELECT * FROM parent_binds WHERE student_id = ? AND openid = ?').get(st.id, openid);
    if(exist){
      if(exist.unbound) db.prepare('UPDATE parent_binds SET unbound = 0, bound_at = ? WHERE id = ?').run(new Date().toISOString(), exist.id);
    } else {
      db.prepare('INSERT INTO parent_binds (id, student_id, openid, bound_at, unbound) VALUES (?,?,?,?,0)')
        .run(uid('bind_'), st.id, openid, new Date().toISOString());
    }
    return res.send(wx.replyText(toUser, openid,
      '绑定成功！「' + st.name + '」的作业打卡报告更新时会推送到这里。'));
  }

  // 其他消息：提示语
  res.send(wx.replyText(toUser, openid, '欢迎关注火箭学院。如需接收孩子的作业报告，请向助教获取学生专属二维码扫码绑定。'));
});

module.exports = router;
