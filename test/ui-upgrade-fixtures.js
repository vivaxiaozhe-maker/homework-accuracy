/* UI 升级容量夹具：仅读取本仓库 test/fixtures/ui-upgrade 下的合成数据，绝不连接生产。
   供后续 DOM/真实浏览器容量验收复用；直接运行 node test/ui-upgrade-fixtures.js 做格式与规模校验。 */
'use strict';
const fs = require('fs');
const path = require('path');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ui-upgrade');
const NAMES = ['00-empty', '01-operating-volume', '02-growth-volume'];

function loadFixture(name){
  if(!NAMES.includes(name)) throw new Error('未知合成场景：' + name);
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name + '.json'), 'utf8'));
  const meta = raw._fixtureMeta;
  if(!meta || meta.synthetic !== true || meta.doNotImportProduction !== true){
    throw new Error(name + ' 缺少合成数据/禁止生产导入标记');
  }
  const pool = { ...raw };
  delete pool._fixtureMeta;
  ['students', 'records', 'missed', 'planRequests', 'auditLogs', 'alertActions'].forEach(k=>{
    if(!Array.isArray(pool[k])) throw new Error(name + '.' + k + ' 必须为数组');
  });
  return { pool, meta };
}

function stats(pool){
  const subjects = new Set(pool.records.map(r=>r.subject).filter(Boolean));
  return {
    students: pool.students.length,
    active: pool.students.filter(s=>!s.archived).length,
    archived: pool.students.filter(s=>s.archived).length,
    owners: new Set(pool.students.map(s=>s.ownerId)).size,
    records: pool.records.length,
    missed: pool.missed.length,
    subjects: subjects.size,
    pending: pool.planRequests.filter(r=>r.status==='pending').length,
    alertActions: pool.alertActions.length
  };
}

function mapOwners(pool, ownerMap){
  const mapped = JSON.parse(JSON.stringify(pool));
  const ownerOf = id => {
    const next = ownerMap[id];
    if(!next) throw new Error('合成 owner 未映射：' + id);
    return next;
  };
  mapped.students.forEach(x=>{ x.ownerId = ownerOf(x.ownerId); });
  mapped.records.forEach(x=>{ x.ownerId = ownerOf(x.ownerId); });
  mapped.missed.forEach(x=>{ x.ownerId = ownerOf(x.ownerId); });
  mapped.planRequests.forEach(x=>{ x.ownerId = ownerOf(x.ownerId); if(x.requestedBy) x.requestedBy = ownerOf(x.requestedBy); });
  mapped.alertActions.forEach(x=>{ if(x.actorId) x.actorId = ownerOf(x.actorId); });
  return mapped;
}

// 分页边界行工厂：固定 ID/日期，后续 0/1/20/21/末页删除用例共用，不依赖真实学生。
function makeBoundaryRows(count, prefix){
  const tag = prefix || 'boundary';
  const base = Date.UTC(2026, 0, 1);
  return Array.from({length:count}, (_,i)=>({
    id: tag + '-' + String(i + 1).padStart(4, '0'),
    studentId: tag + '-student',
    ownerId: tag + '-owner',
    subject: '学科 / AP / 统计',
    date: new Date(base + i * 86400000).toISOString().slice(0,10),
    resolved: false
  }));
}

function validate(){
  const expected = {
    '00-empty': { students:0, records:0, missed:0 },
    '01-operating-volume': { active:400, archived:43, owners:11, records:2500, missed:220, subjects:40 },
    '02-growth-volume': { active:1000, archived:100, owners:11, records:10000, missed:500, subjects:50, pending:50 }
  };
  NAMES.forEach(name=>{
    const { pool } = loadFixture(name);
    const actual = stats(pool);
    Object.entries(expected[name]).forEach(([key, value])=>{
      if(actual[key] !== value) throw new Error(name + ' ' + key + ' 期望 ' + value + '，实际 ' + actual[key]);
    });
    [...pool.students, ...pool.records, ...pool.missed].forEach(x=>{
      if(!x.id) throw new Error(name + ' 存在无稳定 ID 的记录');
    });
    if(pool.records.some(r=>!pool.students.some(s=>s.id===r.studentId))) throw new Error(name + ' 存在无学生作业记录');
    if(pool.missed.some(m=>!pool.students.some(s=>s.id===m.studentId))) throw new Error(name + ' 存在无学生未交记录');
    console.log('PASS  ' + name + '：' + JSON.stringify(actual));
  });
  [0,1,20,21,50,500].forEach(n=>{
    const rows = makeBoundaryRows(n, 'page-' + n);
    if(rows.length !== n || new Set(rows.map(x=>x.id)).size !== n) throw new Error('分页边界工厂数量/ID 错误：' + n);
    if(rows.some((x,i)=>i > 0 && rows[i-1].date >= x.date)) throw new Error('分页边界工厂日期不稳定：' + n);
  });
  console.log('PASS  分页边界工厂：0 / 1 / 20 / 21 / 50 / 500，ID 唯一且日期稳定');
}

module.exports = { NAMES, FIXTURE_DIR, loadFixture, stats, mapOwners, makeBoundaryRows, validate };
if(require.main === module) validate();
