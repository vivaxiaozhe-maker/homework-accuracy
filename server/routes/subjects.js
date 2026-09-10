/* 科目树接口（三级科目树：分类 → 系列 → 科目，全局共享配置）
   GET /api/subjects  所有登录角色可读（settings 表无记录时返回内置默认树）
   PUT /api/subjects  仅教务；body 为完整科目树 JSON（{tree: {...}}，兼容直接传树），整体替换；写审计日志 */
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../auth');
const { logAudit } = require('../util');

const router = express.Router();

/* 内置默认科目树（与前端 SUBJECT_TREE 保持一致；库中无覆盖值时的兜底） */
const DEFAULT_SUBJECT_TREE = {
  '学科': {
    'AP': ['微积分AB','微积分BC','物理1','物理2','物理力学','物理电磁','化学','生物','宏观','微观','统计','心理学','人文地理','环境科学','欧洲史','世界史','美国历史','语言与写作','文学与写作','艺术史','计算机A','计算机原理'],
    'IB': ['数学','物理','化学','经济','历史','生物'],
    'AL': ['数学','物理','化学','经济','历史','生物']
  },
  '竞赛': {'AMC10':null,'AMC12':null,'ABO':null,'BPHO':null,'BBO':null,'UKCHO':null,'物理碗':null},
  '语培': {'托福':null,'雅思':null,'SAT':null,'ACT':null}
};

/* 结构校验：一级 = 普通对象（键非空字符串）；二级值 = 字符串数组或 null；拒绝多余类型 */
function validTree(t){
  if(!t || typeof t !== 'object' || Array.isArray(t)) return false;
  for(const k1 of Object.keys(t)){
    if(!k1) return false;
    const l2 = t[k1];
    if(!l2 || typeof l2 !== 'object' || Array.isArray(l2)) return false;
    for(const k2 of Object.keys(l2)){
      if(!k2) return false;
      const v = l2[k2];
      if(v === null) continue;
      if(!Array.isArray(v)) return false;
      for(const k3 of v){ if(typeof k3 !== 'string' || !k3) return false; }
    }
  }
  return true;
}

// GET /api/subjects（全局 /api 守卫已完成登录校验；所有角色可读）
router.get('/', (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'subject_tree'").get();
  let tree = DEFAULT_SUBJECT_TREE;
  if(row){
    try{ const t = JSON.parse(row.value); if(validTree(t)) tree = t; }catch(e){}
  }
  res.json({ ok: true, tree: tree });
});

// PUT /api/subjects（仅教务；整体替换科目树）
router.put('/', requireAdmin, (req, res) => {
  const tree = req.body && (req.body.tree !== undefined ? req.body.tree : req.body);
  if(!validTree(tree)) return res.status(400).json({ ok: false, msg: '科目树结构不正确' });
  db.prepare("INSERT INTO settings (key, value) VALUES ('subject_tree', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(tree));
  logAudit(req.user, '更新科目树', 'data', '科目管理', '一级分类 ' + Object.keys(tree).length + ' 个');
  res.json({ ok: true });
});

module.exports = router;
