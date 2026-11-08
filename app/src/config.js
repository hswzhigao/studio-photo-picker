import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
const root = path.resolve(process.cwd(), '..', '..');
export const config = {
  port: Number(process.env.PORT || 3000),
  photoSourceDir: path.resolve(process.env.PHOTO_SOURCE_DIR || root),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data')),
  studioName: '名人婚纱',
  watermarkText: '名人婚纱 · 预览',
  overageUnitPrice: 20,
};
export function lanIp() { const nets = os.networkInterfaces(); for (const list of Object.values(nets)) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address; return '127.0.0.1'; }
export function ensureDirs() { for (const dir of ['','thumbnails','previews','uploads','zips']) fs.mkdirSync(path.join(config.dataDir, dir), { recursive: true }); }
