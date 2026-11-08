import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { backupDatabase, cleanupGeneratedData } from '../src/services/backup.js';

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), '..', 'data'));
const includeUploads = process.argv.includes('--include-uploads');
const rl = readline.createInterface({ input, output });
try {
  const confirmation = await rl.question('请输入“确认清空”以继续：');
  if (confirmation !== '确认清空') throw new Error('未确认，已取消清理');
  if (includeUploads) {
    const uploadsConfirmation = await rl.question('将删除 uploads，请再次输入“确认删除上传”：');
    if (uploadsConfirmation !== '确认删除上传') throw new Error('未确认删除 uploads，已取消清理');
  }
  const dbPath = path.join(dataDir, 'app.sqlite');
  if (fs.existsSync(dbPath)) {
    const result = await backupDatabase(dataDir);
    console.log(`清理前已备份：${result.databasePath}`);
  }
  cleanupGeneratedData(dataDir, { includeUploads });
  fs.mkdirSync(dataDir, { recursive: true });
  console.log('已清理本地生成数据，备份和原始照片未修改。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rl.close();
}
