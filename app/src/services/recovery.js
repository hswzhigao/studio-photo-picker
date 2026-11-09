import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { renderPreview } from './photoManager.js';

const interruptedImportMessage = '服务重启中断，请重新导入';
const interruptedPackageMessage = '服务重启中断，请重新打包';

function resolveDataFile(file, dataDir) {
  if (!file) return null;
  return path.isAbsolute(file) ? file : path.join(dataDir, file);
}

function isInside(file, root) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function rebuildPhoto(photo, { dataDir, photoSourceDir, watermarkText }) {
  const original = resolveDataFile(photo.original_key, dataDir);
  if (!original || !fs.existsSync(original)) return false;
  const thumb = resolveDataFile(photo.thumb_key, dataDir) || path.join(dataDir, 'thumbnails', `${photo.id}.webp`);
  const preview = resolveDataFile(photo.preview_key, dataDir) || path.join(dataDir, 'previews', `${photo.id}.webp`);
  if (!isInside(thumb, path.join(dataDir, 'thumbnails')) || !isInside(preview, path.join(dataDir, 'previews'))) return false;
  fs.mkdirSync(path.dirname(thumb), { recursive: true });
  fs.mkdirSync(path.dirname(preview), { recursive: true });
  if (!fs.existsSync(thumb)) await sharp(original).rotate().resize({ width: 400, withoutEnlargement: true }).webp({ quality: 84 }).toFile(thumb);
  if (!fs.existsSync(preview)) await renderPreview(original, preview, watermarkText || '名人婚纱 · 预览');
  return true;
}

export async function recoverInterruptedWork({ db, dataDir, photoSourceDir = dataDir, watermarkText = '' }) {
  const now = new Date().toISOString();
  db.prepare("update import_task set status='failed', errors=?, finished_at=? where status in ('pending','processing')").run(interruptedImportMessage, now);
  const packages = db.prepare("select id,file_key from download_package where status='pending'").all();
  for (const item of packages) {
    const file = resolveDataFile(item.file_key, dataDir);
    if (file && isInside(file, path.join(dataDir, 'zips')) && fs.existsSync(file)) fs.rmSync(file, { force: true });
    db.prepare("update download_package set status='failed', error=? where id=?").run(interruptedPackageMessage, item.id);
  }
  const photos = db.prepare("select * from photo where import_status='ready' and (thumb_key is not null or preview_key is not null)").all();
  for (const photo of photos) {
    try { await rebuildPhoto(photo, { dataDir, photoSourceDir, watermarkText }); } catch { /* leave the database row intact; the media endpoint reports a missing derivative */ }
  }
  return { recoveredImports: true, packages: packages.length };
}
