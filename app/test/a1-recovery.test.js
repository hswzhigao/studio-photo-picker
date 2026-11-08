import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, initializeDatabase } from '../src/db/connection.js';
import { recoverInterruptedWork } from '../src/services/recovery.js';

describe('A1 restart recovery', () => {
  it('marks interrupted jobs failed, removes partial packages, and rebuilds missing derivatives', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-recovery-'));
    fs.mkdirSync(path.join(root, 'zips'));
    fs.mkdirSync(path.join(root, 'thumbnails'));
    fs.mkdirSync(path.join(root, 'previews'));
    const db = getDb(root);
    initializeDatabase(db);
    const studio = db.prepare("insert into studio(name,watermark_text,sms_sign) values ('S','W','S')").run().lastInsertRowid;
    const staff = db.prepare("insert into staff(studio_id,name,phone,role,password_hash) values (?,?,?,?,?)").run(studio, 'A', '13800000031', 'admin', 'hash').lastInsertRowid;
    const job = db.prepare("insert into job(studio_id,title,deadline_at,invite_token,created_by) values (?,?,?,?,?)").run(studio, 'J', new Date().toISOString(), 't', staff).lastInsertRowid;
    const now = new Date().toISOString();
    const importPending = db.prepare("insert into import_task(job_id,source,status,created_at) values (?,?,?,?)").run(job, 'album', 'pending', now).lastInsertRowid;
    const importProcessing = db.prepare("insert into import_task(job_id,source,status,created_at) values (?,?,?,?)").run(job, 'album2', 'processing', now).lastInsertRowid;
    const partial = path.join(root, 'zips', 'partial.zip');
    fs.writeFileSync(partial, 'partial');
    const pkg = db.prepare("insert into download_package(job_id,kind,status,file_key,created_at) values (?,?,?,?,?)").run(job, 'client', 'pending', partial, now).lastInsertRowid;
    const original = path.join(root, 'original.jpg');
    fs.copyFileSync(path.join(process.cwd(), 'test', 'fixtures', 'photo-1.jpg'), original);
    const photo = db.prepare("insert into photo(job_id,filename,original_key,import_status,thumb_key,preview_key) values (?,?,?,?,?,?)").run(job, 'original.jpg', original, 'ready', path.join(root, 'thumbnails', '1.webp'), path.join(root, 'previews', '1.webp')).lastInsertRowid;

    await recoverInterruptedWork({ db, dataDir: root, photoSourceDir: root, watermarkText: 'W' });

    expect(db.prepare('select status,errors,finished_at from import_task where id=?').get(importPending)).toMatchObject({ status: 'failed', errors: '服务重启中断，请重新导入' });
    expect(db.prepare('select status from import_task where id=?').get(importProcessing).status).toBe('failed');
    expect(db.prepare('select status,error from download_package where id=?').get(pkg)).toMatchObject({ status: 'failed', error: '服务重启中断，请重新打包' });
    expect(fs.existsSync(partial)).toBe(false);
    expect(fs.existsSync(path.join(root, 'thumbnails', `${photo}.webp`))).toBe(true);
    expect(fs.existsSync(path.join(root, 'previews', `${photo}.webp`))).toBe(true);
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
