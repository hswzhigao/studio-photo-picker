import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { renderPreview } from '../src/services/photoManager.js';

const tempDirs = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('watermark asset', () => {
  it('ships a transparent Chinese watermark PNG independent of system fonts', async () => {
    const asset = path.resolve('assets/watermark.png');
    expect(fs.existsSync(asset)).toBe(true);
    const meta = await sharp(asset).metadata();
    expect(meta.format).toBe('png');
    expect(meta.hasAlpha).toBe(true);
    expect(meta.width).toBeGreaterThan(100);
    expect(meta.height).toBeGreaterThan(20);
  });

  it('composites a visible watermark into the preview', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watermark-test-'));
    tempDirs.push(dir);
    const original = path.join(dir, 'original.jpg');
    const preview = path.join(dir, 'preview.webp');
    await sharp({ create: { width: 900, height: 700, channels: 3, background: '#335577' } }).jpeg().toFile(original);
    await renderPreview(original, preview, '名人婚纱 · 预览');
    const { data, info } = await sharp(preview).raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => { const index = (y * info.width + x) * info.channels; return data[index] + data[index + 1] + data[index + 2]; };
    const corner = at(Math.round(info.width * 0.02), Math.round(info.height * 0.02));
    let bottomRight = 0;
    for (let y = Math.round(info.height * 0.85); y < info.height; y += 1) {
      for (let x = Math.round(info.width * 0.7); x < info.width; x += 1) bottomRight = Math.max(bottomRight, at(x, y));
    }
    expect(bottomRight).toBeGreaterThan(corner + 150);
  });
});
