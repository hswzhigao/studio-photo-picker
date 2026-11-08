import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const outputDir = path.resolve(process.env.FIXTURES_DIR || path.join(process.cwd(), 'test', 'fixtures'));
await fs.mkdir(outputDir, { recursive: true });
for (let index = 1; index <= 3; index += 1) {
  const file = path.join(outputDir, `photo-${index}.jpg`);
  await sharp({
    create: {
      width: 96,
      height: 96,
      channels: 3,
      background: { r: 80 + index * 30, g: 100 + index * 20, b: 140 + index * 10 },
    },
  }).jpeg({ quality: 80 }).toFile(file);
}
console.log(`已生成测试图片：${outputDir}`);
