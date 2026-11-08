import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
const sourceRoot = path.resolve(process.cwd(), '..', '..');
const projectRoot = path.resolve(process.cwd(), '..');
const legacyDataDir = path.resolve(process.cwd(), 'data');
const hasCustomDataDir = Boolean(process.env.DATA_DIR);
const envFlag = (name, fallback = false) => process.env[name] === undefined ? fallback : /^(1|true|yes)$/i.test(process.env[name]);
export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3000),
  publicUrl: String(process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  seedDemo: envFlag('SEED_DEMO', false),
  trustProxy: envFlag('TRUST_PROXY', false) ? 1 : false,
  cookieSecure: process.env.NODE_ENV === 'production' || envFlag('COOKIE_SECURE', false),
  production: process.env.NODE_ENV === 'production',
  version: process.env.APP_VERSION || '1.0.0',
  loginRateLimitMax: Number(process.env.LOGIN_RATE_LIMIT_MAX || 10),
  loginRateLimitWindowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 60_000),
  photoSourceDir: path.resolve(process.env.PHOTO_SOURCE_DIR || sourceRoot),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(projectRoot, 'data')),
  studioName: '名人婚纱',
  watermarkText: '名人婚纱 · 预览',
  overageUnitPrice: 20,
};
export function lanIp() { const nets = os.networkInterfaces(); for (const list of Object.values(nets)) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address; return '127.0.0.1'; }
export function ensureDirs(dataDir = config.dataDir) {
  if (dataDir === config.dataDir && !hasCustomDataDir && config.dataDir !== legacyDataDir && fs.existsSync(path.join(legacyDataDir, 'app.sqlite')) && !fs.existsSync(path.join(config.dataDir, 'app.sqlite'))) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.cpSync(legacyDataDir, config.dataDir, { recursive: true, errorOnExist: false, force: false });
    console.log(`已将旧数据复制到 ${config.dataDir}，原目录保留。`);
  }
  for (const dir of ['', 'thumbnails', 'previews', 'uploads', 'zips', 'backups']) fs.mkdirSync(path.join(dataDir, dir), { recursive: true });
}
