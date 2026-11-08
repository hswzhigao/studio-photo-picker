import { config, ensureDirs, lanIp } from './src/config.js';
import { getDb, hasPendingMigrations, initializeDatabase } from './src/db/connection.js';
import { seedDatabase } from './src/db/seed.js';
import { createApp } from './src/app.js';
import { importPhotos } from './src/services/photoImport.js';
import { recoverInterruptedWork } from './src/services/recovery.js';
import { backupDatabase, pruneBackups } from './src/services/backup.js';
import { scheduleDailyBackup } from './src/services/dailyBackup.js';
import fs from 'node:fs';
import path from 'node:path';

ensureDirs();
const pidFile = path.join(config.dataDir, '.server.pid');
const existingPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8').trim()) : null;
if (existingPid !== null) {
  if (!Number.isInteger(existingPid) || existingPid <= 0) throw new Error('服务 PID 文件无效，请手动检查 .server.pid');
  try {
    process.kill(existingPid, 0);
    throw new Error(`服务已在运行（PID ${existingPid}）`);
  } catch (error) {
    if (error.message.startsWith('服务已在运行')) throw error;
    if (error.code !== 'ESRCH') throw new Error(`无法确认旧服务状态（PID ${existingPid}）`);
    fs.rmSync(pidFile, { force: true });
  }
}
fs.writeFileSync(pidFile, String(process.pid), { flag: 'wx', mode: 0o600 });

let db;
let server;
let stopDailyBackup = () => {};
let shuttingDown = false;
function removePidFile() {
  try {
    if (Number(fs.readFileSync(pidFile, 'utf8').trim()) === process.pid) fs.rmSync(pidFile, { force: true });
  } catch { /* startup may have failed before the pid file was readable */ }
}

try {
  const hadDatabase = fs.existsSync(path.join(config.dataDir, 'app.sqlite'));
  db = getDb(config.dataDir);
  if (hadDatabase && hasPendingMigrations(db)) {
    const migrationBackup = await backupDatabase(config.dataDir, { kind: 'migration' });
    console.log(`迁移前备份完成：${migrationBackup.databasePath}`);
  }
  initializeDatabase(db);
  await recoverInterruptedWork({ db, dataDir: config.dataDir, photoSourceDir: config.photoSourceDir, watermarkText: config.watermarkText });
  const jobId = seedDatabase(db, config);
  if (jobId) {
    const count = db.prepare("select count(*) count from photo where job_id=? and import_status='ready'").get(jobId).count;
    if (!count) {
      console.log('正在导入照片并生成预览…');
      await importPhotos({ db, jobId, sourceDir: config.photoSourceDir, dataDir: config.dataDir, watermarkText: config.watermarkText });
    }
  }
  const startupBackup = await backupDatabase(config.dataDir, { kind: 'startup' });
  pruneBackups(config.dataDir, 'startup', 5);
  console.log(`启动备份完成：${startupBackup.databasePath}`);

  const app = createApp({ db, cfg: config });
  stopDailyBackup = scheduleDailyBackup({
    backup: options => backupDatabase(config.dataDir, options),
    prune: (kind, keep) => pruneBackups(config.dataDir, kind, keep),
  });
  server = app.listen(config.port, config.host, () => {
    const baseUrl = config.publicUrl || `http://${config.host}:${config.port}`;
    console.log(`访问地址 ${baseUrl}`);
    if (!config.publicUrl && config.host === '0.0.0.0') console.log(`手机访问地址 http://${lanIp()}:${config.port}`);
    console.log(`后台地址 ${baseUrl}/admin`);
  });

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal}：正在停止服务…`);
    stopDailyBackup();
    app.locals.stopBackgroundTasks?.();
    const closed = new Promise(resolve => server.close(resolve));
    const tasks = app.locals.waitForTasks?.(10000) || Promise.resolve();
    await Promise.race([Promise.all([closed, tasks]), new Promise(resolve => setTimeout(resolve, 10000))]);
    try { db.close(); } finally { removePidFile(); }
    process.exit(0);
  }
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
} catch (error) {
  try { db?.close(); } finally { removePidFile(); }
  throw error;
}
