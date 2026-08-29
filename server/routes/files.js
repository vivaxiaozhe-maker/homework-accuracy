/* 附件路由：上传（multer）/ 鉴权读取 / 删除
   限制：图片（jpg/jpeg/png/webp）单个 ≤2MB；PDF ≤4MB；单次最多 9 个
   落盘 server/uploads/，文件名 = 文件 id + 按 mime 映射的安全扩展名（不信客户端文件名，防路径穿越）
   owner_id = 上传人（上传可能先于记录保存，record_id 可空，保存记录时再绑定） */
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requireRole } = require('../auth');
const { uid, logAudit, canWrite, parseJson } = require('../util');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// mime → 安全扩展名（白名单）
const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'application/pdf': '.pdf'
};
const IMG_MAX = 2 * 1024 * 1024;   // 图片 ≤2MB
const PDF_MAX = 4 * 1024 * 1024;   // PDF ≤4MB

/* 魔数校验：mime 声明必须与文件头一致，防改名伪装上传（GIF 的 47494638 不在白名单 mime 内，类型校验已先拦截） */
const MAGIC = {
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/jpg': [[0xFF, 0xD8, 0xFF]],
  'image/png': [[0x89, 0x50, 0x4E, 0x47]],
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]]  // %PDF
};
function sniffOk(mime, filePath){
  let buf;
  try{
    const fd = fs.openSync(filePath, 'r');
    buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
  }catch(e){ return false; }
  if(mime === 'image/webp') return buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
  const sigs = MAGIC[mime];
  if(!sigs) return false;
  return sigs.some(sig => sig.every((b, i) => buf[i] === b));
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, file._fid + MIME_EXT[file.mimetype])
  }),
  limits: { fileSize: PDF_MAX, files: 9 },
  fileFilter: (req, file, cb) => {
    const ext = MIME_EXT[file.mimetype];
    if(!ext) return cb(new Error('BAD_TYPE'));  // 仅允许图片/PDF
    file._fid = uid('f_');                       // 预生成文件 id（文件名与库行一致）
    cb(null, true);
  }
});

const router = express.Router();

// 统一处理 multer 错误（超限/超数/类型不符）
function uploadMw(req, res, next){
  upload.array('files', 9)(req, res, err => {
    if(!err) return next();
    if(err.message === 'BAD_TYPE') return res.status(400).json({ ok: false, msg: '仅支持图片（jpg/png/webp）或 PDF 文件' });
    if(err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ ok: false, msg: '文件超出大小限制（图片 ≤2MB，PDF ≤4MB）' });
    if(err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ ok: false, msg: '单次最多上传 9 个文件' });
    return res.status(400).json({ ok: false, msg: '上传失败：' + err.message });
  });
}

// POST /api/files（multipart，字段名 files；可选 recordId 直接挂到记录）
router.post('/', requireRole('ta', 'admin'), uploadMw, (req, res) => {
  const files = req.files || [];
  if(!files.length) return res.status(400).json({ ok: false, msg: '未接收到文件' });
  // 魔数校验：mime 声明与文件头不符 → 整批回滚
  const badMagic = files.filter(f => !sniffOk(f.mimetype, f.path));
  if(badMagic.length){
    files.forEach(f => { try{ fs.unlinkSync(f.path); }catch(e){} });
    return res.status(400).json({ ok: false, msg: '文件内容与类型不符：' + badMagic.map(f => f.originalname).join('、') });
  }
  // 图片大小单独收紧（multer 全局限制是 PDF 的 4MB）
  const oversized = files.filter(f => f.mimetype !== 'application/pdf' && f.size > IMG_MAX);
  if(oversized.length){
    files.forEach(f => { try{ fs.unlinkSync(f.path); }catch(e){} });  // 整批回滚
    return res.status(413).json({ ok: false, msg: '图片文件单个不能超过 2MB' });
  }
  // 可选 recordId：校验记录归属当前用户（教务除外）
  const recordId = (req.body && req.body.recordId) || '';
  let rec = null;
  if(recordId){
    rec = db.prepare('SELECT * FROM records WHERE id = ?').get(recordId);
    if(!rec){ files.forEach(f => { try{ fs.unlinkSync(f.path); }catch(e){} }); return res.status(404).json({ ok: false, msg: '记录不存在' }); }
    if(!canWrite(req.user, rec.owner_id)){
      files.forEach(f => { try{ fs.unlinkSync(f.path); }catch(e){} });
      return res.status(403).json({ ok: false, msg: '没有权限' });
    }
  }
  const now = new Date().toISOString();
  const ins = db.prepare('INSERT INTO files (id, record_id, filename, mime, size, path, created_at, owner_id) VALUES (?,?,?,?,?,?,?,?)');
  // busboy 把非 ASCII 文件名按 latin1 解码，转回 UTF-8 防中文乱码
  const fixName = n => Buffer.from(n, 'latin1').toString('utf8');
  const saved = files.map(f => {
    ins.run(f._fid, rec ? rec.id : null, fixName(f.originalname), f.mimetype, f.size, f.path, now, req.user.id);
    return { id: f._fid, filename: fixName(f.originalname), mime: f.mimetype, size: f.size };
  });
  // 直接挂到记录：按类型并入 images/pdfs 数组（防重复）
  if(rec){
    const imgs = parseJson(rec.images, []);
    const pdfs = parseJson(rec.pdfs, []);
    saved.forEach(f => { (f.mime === 'application/pdf' ? pdfs : imgs).includes(f.id) || (f.mime === 'application/pdf' ? pdfs.push(f.id) : imgs.push(f.id)); });
    db.prepare('UPDATE records SET images = ?, pdfs = ? WHERE id = ?').run(JSON.stringify(imgs), JSON.stringify(pdfs), rec.id);
  }
  logAudit(req.user, '上传附件', 'record', rec ? '记录 ' + rec.id : '', saved.length + ' 个文件（' + saved.map(f => f.filename).join('、') + '）', rec ? rec.owner_id : req.user.id);
  res.json({ ok: true, files: saved });
});

// GET /api/files/:id：鉴权读取——教务全部；助教只能读自己 owner 的文件
router.get('/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if(!f) return res.status(404).json({ ok: false, msg: '文件不存在' });
  if(req.user.role !== 'admin' && f.owner_id !== req.user.id){
    return res.status(403).json({ ok: false, msg: '没有权限' });
  }
  if(!fs.existsSync(f.path)) return res.status(404).json({ ok: false, msg: '文件已丢失' });
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', 'inline; filename*=UTF-8\'\'' + encodeURIComponent(f.filename));
  fs.createReadStream(f.path).pipe(res);
});

// DELETE /api/files/:id：仅文件 owner 或教务；删库行 + 删磁盘文件
router.delete('/:id', requireRole('ta', 'admin'), (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if(!f) return res.status(404).json({ ok: false, msg: '文件不存在' });
  if(req.user.role !== 'admin' && f.owner_id !== req.user.id){
    return res.status(403).json({ ok: false, msg: '没有权限' });
  }
  db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
  try{ fs.unlinkSync(f.path); }catch(e){}
  logAudit(req.user, '删除附件', 'record', f.filename, '', f.owner_id);
  res.json({ ok: true });
});

module.exports = router;
