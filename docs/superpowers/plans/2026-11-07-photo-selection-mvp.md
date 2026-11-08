# 名人婚纱在线选片 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `claude-dev/app` 构建一个可通过电脑和同一 Wi-Fi 手机访问的本地多人协作选片网站，完成真实 63 张照片导入、客户选片、多人并集、后台汇总/锁定/导出与原片下载闭环。

**Architecture:** 使用一个 Express 进程提供 REST API 和 Vue 3/Vite 构建产物；SQLite 保存业务数据，sharp 在本地生成缩略图与水印预览图，archiver 生成原片 ZIP。客户端和影楼后台共享业务服务层，登录会话使用本地 cookie，选片通过自动保存和 10 秒轮询同步。

**Tech Stack:** Node.js 20+, Express, better-sqlite3, sharp, archiver, multer, bcryptjs, cookie-parser, Vue 3, Vite, Vitest/Supertest。

## Global Constraints

- 原始照片目录只读：不得移动、重命名、删除、覆盖或写回 `/Users/chigo.liao/Documents/爸妈摄影/` 下的照片。
- 所有生成的 SQLite、缩略图、水印预览、上传文件和 ZIP 必须位于 `claude-dev/app/data/`。
- 照片源默认扫描项目根目录第一层的 `jpg/jpeg/png/heic`，跳过隐藏文件和 `claude-dev/`。
- 服务监听 `0.0.0.0:3000`，启动时打印 localhost、局域网访问地址和 `/admin`。
- 默认影楼为“名人婚纱”，预览水印为“名人婚纱 · 预览”，开发验证码为 `123456`，加片为 ¥20/张。
- 合并精修使用所有选片人的并集；相框/摆台必须来自精修；锁定后客户不能修改；锁定后原片可下载，除非任务关闭原片下载。
- 本地版不自动清理数据，不接真实短信、在线支付、云存储、WebSocket 或小程序。
- 所有业务错误返回 `{ error: { code, message } }`；不信任客户端传入的 selector 身份；文件下载不暴露绝对路径。
- 视觉遵循设计稿：`#F6F4F0` 背景、`#7A4E31` 主色、`#2E6460` 辅色、`#A33A1E` 警示、白色卡片和 12px 圆角。

---

### Task 1: 项目骨架、SQLite schema 与演示数据

**Files:**
- Create: `claude-dev/app/package.json`
- Create: `claude-dev/app/.env.example`
- Create: `claude-dev/app/vite.config.js`
- Create: `claude-dev/app/server.js`
- Create: `claude-dev/app/src/app.js`
- Create: `claude-dev/app/src/config.js`
- Create: `claude-dev/app/src/db/connection.js`
- Create: `claude-dev/app/src/db/schema.sql`
- Create: `claude-dev/app/src/db/seed.js`
- Create: `claude-dev/app/src/middleware/errors.js`
- Create: `claude-dev/app/data/.gitkeep`
- Test: `claude-dev/app/test/db.test.js`

**Interfaces:**
- Produces `createApp({ db, config })` for later API tests.
- Produces `getDb(config)`, `initializeDatabase(db)`, and `seedDatabase(db, config)`.
- `GET /api/health` returns `{ ok: true, studio: "名人婚纱" }`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { createTestDb } from './helpers.js';
import { initializeDatabase, seedDatabase } from '../src/db/seed.js';

describe('database seed', () => {
  it('creates the demo job, selectors, package items and staff', () => {
    const db = createTestDb();
    initializeDatabase(db);
    seedDatabase(db, { photoSourceDir: '/tmp/photos', devOtp: '123456' });
    expect(db.prepare('select name from studio').get().name).toBe('名人婚纱');
    expect(db.prepare('select count(*) as count from selector').get().count).toBe(3);
    expect(db.prepare('select count(*) as count from job_item').get().count).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claude-dev/app && npm test -- --run test/db.test.js`
Expected: FAIL because package files and database modules do not yet exist.

- [ ] **Step 3: Write minimal implementation**

Create SQLite tables for studio, staff, package_template, package_template_item, job, job_item, photo, selector, selection, slot_assignment, photo_note, retouched_photo, download_package, audit_log, notification, otp_code, and session. Seed one studio, admin staff, standard package, selecting job, three selectors and four job items. Make seed idempotent by checking for an existing studio/job. Store timestamps as ISO strings and use foreign keys/unique constraints for selector-phone and selection pairs.

Create Express app with JSON parsing, cookie parsing, `/api/health`, API error middleware, and SPA fallback only when a built client exists.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd claude-dev/app && npm test -- --run test/db.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add claude-dev/app claude-dev/docs/superpowers/plans/2026-11-07-photo-selection-mvp.md
git commit -m "chore: scaffold local photo selection app"
```

---

### Task 2: 照片导入、缩略图、水印预览

**Files:**
- Create: `claude-dev/app/src/services/photoImport.js`
- Create: `claude-dev/app/src/routes/import.js`
- Create: `claude-dev/app/src/utils/files.js`
- Test: `claude-dev/app/test/photo-import.test.js`

**Interfaces:**
- `scanSourceDirectory(sourceDir): string[]` returns first-level supported image paths only.
- `importPhotos({ db, jobId, sourceDir, dataDir, watermarkText }): Promise<{ total, imported, failed }>`.
- `GET /api/admin/jobs/:jobId/import-status` returns import counters and failed files.
- `POST /api/admin/jobs/:jobId/import` starts/awaits a source-directory import for staff.

- [ ] **Step 1: Write the failing test**

```js
it('imports supported photos without changing source metadata and creates watermarked derivatives', async () => {
  const before = statSync(samplePhoto);
  const result = await importPhotos({ db, jobId, sourceDir: fixtureDir, dataDir, watermarkText: '名人婚纱 · 预览' });
  expect(result.imported).toBe(2);
  expect(db.prepare('select count(*) as count from photo where job_id = ?').get(jobId).count).toBe(2);
  expect(existsSync(path.join(dataDir, 'thumbnails', `${photoId}.webp`))).toBe(true);
  expect(existsSync(path.join(dataDir, 'previews', `${photoId}.webp`))).toBe(true);
  expect(statSync(samplePhoto).size).toBe(before.size);
  expect(statSync(samplePhoto).mtimeMs).toBe(before.mtimeMs);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claude-dev/app && npm test -- --run test/photo-import.test.js`
Expected: FAIL because import service does not exist.

- [ ] **Step 3: Write minimal implementation**

Scan only `sourceDir` entries, reject hidden files, directories and unsupported extensions. Use safe deterministic derivative filenames based on photo id. Insert photo metadata, use sharp to rotate according to EXIF, resize thumbnail to width 400 and preview to width 1600, composite an SVG watermark in the lower-right corner, and write derivatives below `data/`. Catch each file independently and persist `import_status`/`import_error`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd claude-dev/app && npm test -- --run test/photo-import.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add claude-dev/app/src/services/photoImport.js claude-dev/app/src/routes/import.js claude-dev/app/src/utils/files.js claude-dev/app/test/photo-import.test.js
git commit -m "feat: import photos and generate previews"
```

---

### Task 3: 认证、业务规则与客户 API

**Files:**
- Create: `claude-dev/app/src/middleware/auth.js`
- Create: `claude-dev/app/src/services/selection.js`
- Create: `claude-dev/app/src/services/job.js`
- Create: `claude-dev/app/src/routes/auth.js`
- Create: `claude-dev/app/src/routes/client.js`
- Test: `claude-dev/app/test/selection.test.js`
- Test: `claude-dev/app/test/auth-permission.test.js`

**Interfaces:**
- `mergeSelection(db, jobId): { photoIds, count, quota, overage, overageAmount }`.
- `setSelection(db, { jobId, selectorId, photoId, selected }): void`.
- `assignSlot(db, { jobId, jobItemId, photoId, selectorId }): void`.
- `getClientJob(db, { jobId, selectorId }): object` hides non-public selections.
- `POST /api/auth/login` creates selector/staff sessions; `GET /api/auth/me` returns current identity.

- [ ] **Step 1: Write failing tests**

```js
it('counts the union and clears the caller slot when unselecting', () => {
  setSelection(db, { jobId, selectorId: xiaoya, photoId: 1, selected: true });
  setSelection(db, { jobId, selectorId: ajie, photoId: 1, selected: true });
  assignSlot(db, { jobId, jobItemId: frameItem, photoId: 1, selectorId: xiaoya });
  setSelection(db, { jobId, selectorId: xiaoya, photoId: 1, selected: false });
  expect(mergeSelection(db, jobId).count).toBe(1);
  expect(db.prepare('select count(*) as count from slot_assignment where selector_id = ? and photo_id = 1').get(xiaoya).count).toBe(0);
});

it('does not expose a private selector choice to another client', async () => {
  const response = await request(app).get(`/api/client/jobs/${jobId}/photos`).set('Cookie', ajieCookie);
  expect(response.body.photos.find((photo) => photo.id === privatePhoto).others).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claude-dev/app && npm test -- --run test/selection.test.js test/auth-permission.test.js`
Expected: FAIL because services and routes do not yet exist.

- [ ] **Step 3: Write minimal implementation**

Implement session cookies backed by the session table; development OTP accepts `123456` and logs requested codes. Staff login checks bcrypt password. Add client guards that derive selector id from session and verify job membership. Implement selection updates in transactions, slot validation against a `retouch` union, share visibility filtering, review summaries, note updates, submit/withdraw, and 10-second-safe polling through normal GET routes. Lock state returns `409 JOB_LOCKED`; overage acceptance is required by submit when needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd claude-dev/app && npm test -- --run test/selection.test.js test/auth-permission.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add claude-dev/app/src/middleware/auth.js claude-dev/app/src/services/selection.js claude-dev/app/src/services/job.js claude-dev/app/src/routes/auth.js claude-dev/app/src/routes/client.js claude-dev/app/test/selection.test.js claude-dev/app/test/auth-permission.test.js
git commit -m "feat: add client selection and visibility rules"
```

---

### Task 4: 后台汇总、锁定、导出和下载

**Files:**
- Create: `claude-dev/app/src/services/export.js`
- Create: `claude-dev/app/src/services/downloads.js`
- Create: `claude-dev/app/src/routes/admin.js`
- Create: `claude-dev/app/src/routes/downloads.js`
- Test: `claude-dev/app/test/export.test.js`

**Interfaces:**
- `buildSummary(db, jobId): object` includes every selector and all choices regardless of visibility.
- `exportCsv(db, jobId): string` emits UTF-8 BOM CSV with original filename, per-selector marks, use and notes.
- `createOriginalZip({ db, jobId, dataDir }): Promise<string>` writes a safe ZIP path under `data/zips/`.
- Admin routes support list/detail/create, summary, remind, lock/reopen, settlement, CSV and import status.

- [ ] **Step 1: Write failing tests**

```js
it('exports private selections for staff and creates a zip outside the source directory', async () => {
  const summary = buildSummary(db, jobId);
  expect(summary.selectors.find((item) => item.name === '妈妈').selectionCount).toBeGreaterThan(0);
  const csv = exportCsv(db, jobId);
  expect(csv).toContain('妈妈');
  const zipPath = await createOriginalZip({ db, jobId, dataDir });
  expect(zipPath.startsWith(path.join(dataDir, 'zips'))).toBe(true);
  expect(unzipList(zipPath)).not.toContain('../');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claude-dev/app && npm test -- --run test/export.test.js`
Expected: FAIL because export/download services do not exist.

- [ ] **Step 3: Write minimal implementation**

Build staff-only summary with every selector, union metrics, slot final values and suggestion history. Lock only from selecting/submitted and set `locked_at`; reopen only from locked. Produce escaped CSV using safe field conversion and BOM. Stream original files through controlled download handlers; single original downloads require locked status and allow-original flag. ZIP only adds basenames under a flat root, stores package record and reuses a fresh valid package.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd claude-dev/app && npm test -- --run test/export.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add claude-dev/app/src/services/export.js claude-dev/app/src/services/downloads.js claude-dev/app/src/routes/admin.js claude-dev/app/src/routes/downloads.js claude-dev/app/test/export.test.js
git commit -m "feat: add admin summary locking export and downloads"
```

---

### Task 5: Vue 客户端与视觉实现

**Files:**
- Create: `claude-dev/app/client/index.html`
- Create: `claude-dev/app/client/src/main.js`
- Create: `claude-dev/app/client/src/router.js`
- Create: `claude-dev/app/client/src/api.js`
- Create: `claude-dev/app/client/src/styles.css`
- Create: `claude-dev/app/client/src/App.vue`
- Create: `claude-dev/app/client/src/views/LoginView.vue`
- Create: `claude-dev/app/client/src/views/WorkspaceView.vue`
- Create: `claude-dev/app/client/src/views/LightboxView.vue`
- Create: `claude-dev/app/client/src/views/ReviewView.vue`
- Create: `claude-dev/app/client/src/views/MyPhotosView.vue`
- Create: `claude-dev/app/client/src/views/AdminJobsView.vue`
- Create: `claude-dev/app/client/src/views/AdminSetupView.vue`
- Create: `claude-dev/app/client/src/views/AdminJobDetailView.vue`
- Create: `claude-dev/app/client/src/components/PhotoCard.vue`
- Create: `claude-dev/app/client/src/components/QuotaPanel.vue`
- Create: `claude-dev/app/client/src/components/SelectorList.vue`
- Create: `claude-dev/app/client/src/components/ReviewSummary.vue`
- Test: `claude-dev/app/test/client-smoke.test.js`

**Interfaces:**
- `api.js` exports `get`, `post`, `patch`, `remove` and always throws `{ code, message }` from API errors.
- Workspace receives job state and performs selection/slot/note/share calls; it polls every 10 seconds.
- Admin detail renders staff summary and uses lock/export/remind actions.

- [ ] **Step 1: Write failing test**

```js
it('renders the real imported photo count and the mobile quota layout', async () => {
  render(WorkspaceView, { props: { job: fixtureJobWith63Photos } });
  expect(screen.getByText('63 张底片')).toBeInTheDocument();
  expect(screen.getByText('精修')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claude-dev/app && npm test -- --run test/client-smoke.test.js`
Expected: FAIL because Vue client files do not exist.

- [ ] **Step 3: Write minimal implementation**

Build a responsive client shell with a brand header and route-aware navigation. Login supports selector mobile/OTP and staff account entry for `/admin`. Workspace uses real thumbnail URLs, 4:5 photo cards, 44px check buttons, filters, quota cards, collaborator visibility, save status, and fixed mobile submit bar. Lightbox uses preview URLs, keyboard arrows/space, notes and slot controls. Review shows union count, overage acceptance, missing slots and submit state. Admin pages mirror `Admin.html` and `AdminSetup.html` with dark navigation, selector cards, horizontally scrollable summary table, real import progress, lock/reopen/export buttons. Include loading, empty, error, locked and offline-pending states; use browser localStorage for failed pending actions. Use CSS variables and media queries rather than inline design placeholders.

- [ ] **Step 4: Run client tests and build**

Run: `cd claude-dev/app && npm test -- --run test/client-smoke.test.js && npm run build`
Expected: PASS and Vite build completes.

- [ ] **Step 5: Commit**

```bash
git add claude-dev/app/client claude-dev/app/vite.config.js claude-dev/app/test/client-smoke.test.js
git commit -m "feat: build responsive client and admin screens"
```

---

### Task 6: Seed real photos, start server and run browser acceptance

**Files:**
- Modify: `claude-dev/app/src/db/seed.js`
- Modify: `claude-dev/app/src/app.js`
- Create: `claude-dev/app/scripts/reset.js`
- Create: `claude-dev/app/README.md`
- Test: `claude-dev/app/test/acceptance.test.js`

**Interfaces:**
- `npm run dev` starts the server and imports the demo source photos automatically when needed.
- `npm run reset` removes only `app/data/` generated files and recreates schema/seed; it never touches source photos.
- Demo routes: client `/c/demo`, admin `/admin`.

- [ ] **Step 1: Write failing acceptance test**

```js
it('seeds all source photos and keeps source files unchanged', async () => {
  const response = await request(app).get('/api/admin/jobs/1/summary').set('Cookie', staffCookie);
  expect(response.body.photoCount).toBe(63);
  expect(sourceSnapshotAfter).toEqual(sourceSnapshotBefore);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd claude-dev/app && npm test -- --run test/acceptance.test.js`
Expected: FAIL until startup import and demo routes are wired.

- [ ] **Step 3: Write minimal implementation**

On startup initialize DB, seed demo records, and ensure demo job has the root source directory. Import source photos if job has zero completed photos, await import before logging ready, and print `http://localhost:3000`, detected LAN URL and `http://localhost:3000/admin`. Add reset script that deletes `data/app.sqlite`, generated derivative directories and ZIPs only. Document accounts, URLs, OTP, Wi-Fi access, test commands, and source-file safety.

- [ ] **Step 4: Run verification**

Run:

```bash
cd claude-dev/app
npm install
npm test -- --run
npm run build
npm run reset
npm start
```

Expected: all tests pass, build succeeds, server prints addresses, API reports 63 imported photos, client workspace displays real thumbnails with watermarks, admin displays all selectors including 妈妈, and a lock/download smoke flow succeeds.

Use browser inspection at desktop and a 390px viewport to verify no overlap, real image rendering, accessible labels, keyboard focus, and mobile three-column grid. Compare source file sizes and mtimes before/after.

- [ ] **Step 5: Commit**

```bash
git add claude-dev/app
 git commit -m "feat: ship local photo selection MVP"
```
