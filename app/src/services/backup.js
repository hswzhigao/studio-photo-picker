import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function validateKind(kind) {
  if (typeof kind !== 'string' || !/^[a-z0-9_-]+$/i.test(kind)) throw new Error('备份 kind 必须是单段名称');
  return kind;
}

function nextBackupPath(backupDir, kind) {
  validateKind(kind);
  const prefix = `app-${kind}-`;
  const base = `${prefix}${timestamp()}`;
  let candidate = path.join(backupDir, `${base}.sqlite`);
  let suffix = 1;
  while (fs.existsSync(candidate)) candidate = path.join(backupDir, `${base}-${suffix++}.sqlite`);
  return candidate;
}

function requireRegularFile(filePath, label = '文件') {
  const stat = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`${label}必须是普通文件`);
}

export function verifySqlite(filePath) {
  requireRegularFile(filePath, 'SQLite 文件');
  let db;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    return db.pragma('integrity_check', { simple: true }) === 'ok';
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

export async function backupDatabase(dataDir, { includeUploads = true, kind = 'manual' } = {}) {
  const source = path.join(dataDir, 'app.sqlite');
  requireRegularFile(source, '当前数据库');
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const databasePath = nextBackupPath(backupDir, kind);
  const db = new Database(source, { fileMustExist: true });
  try {
    await db.backup(databasePath);
  } finally {
    db.close();
  }
  const uploadsPath = path.join(backupDir, `${path.basename(databasePath, '.sqlite')}.uploads`);
  if (includeUploads) {
    const uploads = path.join(dataDir, 'uploads');
    fs.rmSync(uploadsPath, { recursive: true, force: true });
    if (fs.existsSync(uploads)) fs.cpSync(uploads, uploadsPath, { recursive: true });
    else fs.mkdirSync(uploadsPath, { recursive: true });
  }
  return { databasePath, uploadsPath };
}

export function databaseStats(filePath) {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const exists = table => Boolean(db.prepare("select 1 from sqlite_master where type='table' and name=?").get(table));
    const count = table => exists(table) ? db.prepare(`select count(*) as count from ${table}`).get().count : 0;
    return { orders: count('job'), selectors: count('selector'), selections: count('selection') };
  } finally {
    db.close();
  }
}

export function backupStats(dataDir) {
  const backupDir = path.join(dataDir, 'backups');
  if (!fs.existsSync(backupDir)) return { count: 0, lastBackupAt: null };
  const files = fs.readdirSync(backupDir)
    .filter(name => /^app-[a-z0-9_-]+-.+\.sqlite$/i.test(name))
    .map(name => ({ name, mtimeMs: fs.statSync(path.join(backupDir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { count: files.length, lastBackupAt: files[0] ? new Date(files[0].mtimeMs).toISOString() : null };
}

export function pruneBackups(dataDir, kind, keep) {
  validateKind(kind);
  if (!Number.isInteger(keep) || keep < 0) throw new Error('备份 keep 必须是非负整数');
  const backupDir = path.join(dataDir, 'backups');
  if (!fs.existsSync(backupDir)) return;
  const files = fs.readdirSync(backupDir).filter(name => name.startsWith(`app-${kind}-`) && name.endsWith('.sqlite')).sort().reverse();
  for (const name of files.slice(keep)) {
    fs.rmSync(path.join(backupDir, name), { force: true });
    fs.rmSync(path.join(backupDir, `${name.slice(0, -'.sqlite'.length)}.uploads`), { recursive: true, force: true });
  }
}

export function cleanupGeneratedData(dataDir, { includeUploads = false } = {}) {
  for (const name of ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm', 'thumbnails', 'previews', 'zips']) {
    fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
  }
  if (includeUploads) fs.rmSync(path.join(dataDir, 'uploads'), { recursive: true, force: true });
}

function activeServer(dataDir) {
  const pidFile = path.join(dataDir, '.server.pid');
  if (!fs.existsSync(pidFile)) return false;
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    if (pid === process.pid) return false;
    throw new Error('服务 PID 文件无效');
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      fs.rmSync(pidFile, { force: true });
      return false;
    }
    throw new Error('无法确认服务是否仍在运行');
  }
}

export async function restoreDatabase(dataDir, inputPath) {
  if (activeServer(dataDir)) throw new Error('服务正在运行，请先停止服务后再恢复');
  requireRegularFile(inputPath, '恢复文件');
  if (!verifySqlite(inputPath)) throw new Error('恢复文件 integrity_check 不是 ok');
  const current = path.join(dataDir, 'app.sqlite');
  if (fs.existsSync(current)) await backupDatabase(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const restoreName = path.basename(inputPath, '.sqlite');
  const inputUploads = path.join(path.dirname(inputPath), `${restoreName}.uploads`);
  const restoreUploads = fs.existsSync(inputUploads) && fs.statSync(inputUploads).isDirectory();
  const uploads = path.join(dataDir, 'uploads');
  const temp = path.join(dataDir, `.app.sqlite.restore-${process.pid}-${Date.now()}`);
  const old = path.join(dataDir, `.app.sqlite.previous-${process.pid}-${Date.now()}`);
  const tempUploads = path.join(dataDir, `.uploads.restore-${process.pid}-${Date.now()}`);
  const oldUploads = path.join(dataDir, `.uploads.previous-${process.pid}-${Date.now()}`);
  try {
    fs.copyFileSync(inputPath, temp);
    if (restoreUploads) fs.cpSync(inputUploads, tempUploads, { recursive: true });
    if (fs.existsSync(current)) fs.renameSync(current, old);
    if (restoreUploads && fs.existsSync(uploads)) fs.renameSync(uploads, oldUploads);
    fs.renameSync(temp, current);
    if (restoreUploads) fs.renameSync(tempUploads, uploads);
    fs.rmSync(old, { force: true });
    if (restoreUploads) fs.rmSync(oldUploads, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(temp, { force: true });
    fs.rmSync(tempUploads, { recursive: true, force: true });
    if (!fs.existsSync(current) && fs.existsSync(old)) fs.renameSync(old, current);
    if (restoreUploads && !fs.existsSync(uploads) && fs.existsSync(oldUploads)) fs.renameSync(oldUploads, uploads);
    throw error;
  }
  return databaseStats(current);
}
