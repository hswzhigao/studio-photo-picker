import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { restoreDatabase } from '../src/services/backup.js';

const file = process.argv[2];
const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), '..', 'data'));
if (!file) {
  console.error('用法：npm run restore -- <backup.sqlite>');
  process.exitCode = 1;
} else {
  try {
    const stats = await restoreDatabase(dataDir, path.resolve(file));
    console.log(`恢复完成：订单 ${stats.orders}，选片人 ${stats.selectors}，选择数 ${stats.selections}`);
  } catch (error) {
    console.error(`恢复失败：${error.message}`);
    process.exitCode = 1;
  }
}
