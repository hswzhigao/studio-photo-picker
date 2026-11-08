import path from 'node:path';
import { backupDatabase } from '../src/services/backup.js';

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), '..', 'data'));
const result = await backupDatabase(dataDir);
console.log(`备份完成：${result.databasePath}`);
console.log(`上传文件备份：${result.uploadsPath}`);
