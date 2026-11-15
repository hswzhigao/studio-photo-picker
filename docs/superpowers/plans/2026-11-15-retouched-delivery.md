# 精修交付 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox syntax.

**Goal:** 为订单新增精修原文件查看、修前后对比、下载、版本反馈及后台交付管理，并上传发布用户指定的 22 张文件。

**Architecture:** 独立精修资产/版本，不覆盖 photo。独立 route/service 封装业务，复用会话、文件安全、审计和评论可见性；Vue 客户交付页与后台精修管理页消费一致 API。

**Tech Stack:** Node.js、Express、better-sqlite3、Multer、Sharp、Archiver、Vue 3、Vitest、Supertest。

## Global Constraints

- 规格：`docs/superpowers/specs/2026-11-15-retouched-delivery-design.md`，已获用户确认。
- 用户要求直接在当前目录开发；基线 `d1b8531`，22 files / 111 tests passed。原有预期拒绝测试会输出 Multer/SQLite stderr。
- 不提交 Git，除非用户明确另行授权；部署可以使用包含本次工作文件的临时发布快照，不能捎带无关文件。
- 正式订单 #1「廖府」仅做授权上传/配对/发布，操作验收用专用测试订单 #3。
- 原文件字节、hash 不变，不额外水印或压缩；原片、选片、相框、订单状态不变。
- 客户只看本订单已发布版本；默认反馈 studio_only；原片评论与精修评论隔离。
- 保留 v6 知更鸟蓝样式、现有权限、输入校验及原片下载规则。
- 无秘密写盘、日志或报告；不返回服务器绝对路径；所有写入逐项审计。

---

## API contract

Base `B=/api/{admin|client}/jobs/:id/retouched`.

- `GET B` -> `{photos: AssetView[], wechat:boolean}`。AssetView 为当前版本公开安全字段：`id,asset_id,photo_id,filename,version,status,width,height,size_bytes,sha256,published_at,thumb_url,original_url,download_url,before_url,comment_count,versions`。versions 是同资产可见版本数组，不含路径。客户只获得已发布版本。
- `GET B/:retouchedId` -> `{photo: AssetView}`。
- `POST admin B` multipart field `photo`；optional query `asset_id`（新增版本）、`photo_id`（关联原片）-> 201 `{photo}`；已存在同 hash -> 409 `DUPLICATE_RETOUCHED`。上传同步处理完成后 ready 草稿。
- `PATCH admin B/:retouchedId` JSON `{photo_id:number|null}` -> `{photo}`；发布版本不允许变更，409；关联要与订单相同且可用。
- `POST admin B/publish` / `POST admin B/withdraw` JSON `{ids:number[]}` -> `{photos}`，原子验证所有 ID，不部分成功。
- `GET B/:retouchedId/{thumb|original|download}`；客户验证发布/订单；员工验证影楼。original inline 原 JPEG/PNG，download attachment，private/no-store，safeFile 限定精修 uploads 根目录。撤回即时拒绝，不使用持久缓存。
- `GET B/:retouchedId/comments` -> `{comments: CommentView[]}`，字段沿用现有评论，并有 author_name、retouched_photo_id。
- `POST B/:retouchedId/comments` body `{content,visibility?,parent_id?}` -> 201 `{comment}`。客户默认 studio_only，仅当前版本允许新建；员工可回复历史。父评论同版本、同 job、可见、最多一层。
- `PATCH B/:retouchedId/comments/:commentId` `{content}` / `DELETE ...`；本人且可见；编辑五分钟；客户用 selector ID 的现有语义。写入审计/事件含 visibility/audience，私密内容不进入公共事件。
- `GET client B/download-all` 流式 ZIP，当前已发布版本，最多一请求同时生成，超过返回 429；每次校验成员发布及可访问性，原文件 store 模式。文件名安全、重复名加后缀；中断销毁归档。不缓存磁盘 ZIP，避免旧版本缓存和到期清理负担。

## Task 1: 精修模型、上传/发布、媒体权限与下载

**Files:** Create migration `app/src/db/migrations/011_retouched_delivery.sql`, service `app/src/services/retouched.js`, route `app/src/http/routes/retouched.js`, tests `app/test/retouched-delivery.test.js`; modify `app/src/http/createApp.js`, `app/src/services/photoManager.js`、`app/src/services/backup.js`（确有遗漏才改）、migration tests。

**Consumes:** createApp routeContext 的 db,cfg,requireActor,ownedJob,photoUpload,withMutation,safeFile,downloadHeaders；existing retouched_photo 占位表为空于生产，只读核对已经完成。
**Produces:** 上述除 comments 外所有 API；导出 `registerRetouched(app,ctx)`，实现新版本和稳定 asset_id，供下一任务扩展。

- [ ] 写最小上传/发布测试，先运行失败。
```js
const r=await request(app).post(`/api/admin/jobs/${job}/retouched`).set('Cookie',staffCookie).attach('photo',jpeg,'one.jpg');
expect(r.status).toBe(201);
expect((await request(app).get(`/api/client/jobs/${job}/retouched`).set('Cookie',clientCookie)).body.photos).toEqual([]);
```
- [ ] 最小实现迁移与业务模块；migration 保留旧字段/记录并重建必要约束，不改动旧照片。ready/published/withdrawn 定义为草稿/发布/撤回；asset_id 归组，version 正整数。使用随机文件名和 SHA-256，临时→最终原子移动，失败清理。
- [ ] 增加并观察失败测试：跨影楼/订单、draft/withdrawn 媒体不可读、同 hash 409、非法字节/类型/超限、错误关联、新版本替换当前、历史保留、审计故障回滚、单张 bytes/hash 相同、ZIP仅当前版本、链接越界拒绝。
- [ ] 最小实现完整 API，所有 ID 数组数量上限 100、整数去重、非空；图片尺寸及内容校验，单文件 50MiB；精修存于 uploads 子目录，缩略图在其中以便备份覆盖。原片 purge 若存在精修关联跳过该原片并测试，不能级联丢失反馈。
- [ ] 运行 `npx vitest run --root . test/retouched-delivery.test.js test/migrations.test.js test/photo-management.test.js`，预期全通过；测试 afterEach 关闭 app background tasks 并等任务完成。
- [ ] 自查并写 report：RED/GREEN 命令、修改文件、接口差异、风险。不要 commit。

## Task 2: 精修版本反馈与原片评论隔离

**Files:** migration 可新增 `012_retouched_comments.sql`，`app/src/services/retouched.js`、`app/src/http/routes/retouched.js`、`app/src/http/createApp.js`、`app/src/http/routes/client.js`、`app/src/http/routes/admin.js`、`app/src/services/photoFilters.js`、`app/src/services/visibility.js`；tests `app/test/retouched-comments.test.js`。

**Consumes:** Task1 retouched IDs/asset_id/status 和同订单权限。
**Produces:** API contract comments endpoints；旧评论默认 `retouched_photo_id IS NULL`，后台原片计数/列表不误混，精修 UI有独立反馈。

- [ ] 测试先行，证明同一 photo 的精修反馈不会出现在旧原片列表：
```js
const created=await request(app).post(`${clientBase}/${retouchedId}/comments`).set('Cookie',clientCookie).send({content:'脸部修得不自然'});
expect(created.status).toBe(201);
expect(created.body.comment.visibility).toBe('studio_only');
expect((await request(app).get(`/api/client/jobs/${job}/photos/${photo}/comments`).set('Cookie',clientCookie)).body.comments).toHaveLength(0);
```
- [ ] 迁移 rebuild photo_comment 支持 nullable photo_id 和 retouched FK，原片必须photo、精修必须版本；保留旧ID、parent、索引，foreign_key_check通过。
- [ ] 增加失败测试并实现：客户默认私密、公开仅同订单、他人私密不可读/回复、跨版本父评论404、一层回复、500字/空白拒绝、本人五分钟编辑/删除、历史客户新反馈409、locked/retouching/delivered可反馈、原片更改接口不能按ID编辑精修反馈。
- [ ] 所有旧原片查询/计数/事件过滤增加明确上下文，不把精修私密事件暴露给其他客户；staff 回复继承父可见性。反馈写入业务+审计+事件同事务，event不含私密content。
- [ ] `npx vitest run --root . test/retouched-comments.test.js test/phase4-comments.test.js test/client-a2-a5.test.js test/admin-photo-export.test.js` 全通过，report不含秘密，不commit。

## Task 3: 客户精修交付和后台管理页面

**Files:** Create `app/client/src/views/client/ClientRetouched.vue`, `app/client/src/views/admin/Retouched.vue`, shared focused components if needed；modify router.js、ClientLayout.vue、JobDetail.vue；scoped styles或专用css，tests `app/client/src/retouched.test.js`、router.test.js。

**Consumes:** API contract above。api.upload accepts query parameters in URL, uses field photo；JSON通过 api.*。
**Produces:** 客户/后台 routes `/jobs/:id/retouched` 和 `/admin/jobs/:id/retouched`，入口和完整功能。

- [ ] 写路由/SSR组件行为测试，运行观察 missing route/components失败。现有 test infrastructure支持Vue SSR而非浏览器DOM时，用组件 SSR+纯状态函数测试，不能只assert源码字符串。
- [ ] 实现客户列表、空/加载/错误、原文件查看器、适应/放大、前后切换/并排、键盘Escape与前后、单张/全量下载、微信提示、版本选择、反馈及回复/编辑/删除；请求竞态用序列号/AbortController防止切换照片后旧反馈覆盖。
- [ ] 实现后台一张一请求上传（最多2并发/每批100张）、独立失败重试、对应原片select和缩略图对照、版本上传、勾选批量发布/撤回、精修反馈查看回复；所有错误可见且发布前有数量确认。
- [ ] 使用v6 design tokens和现有api，不改写旧选片页面；390px和桌面均无水平溢出；按钮可访问、disabled时不操作，反馈默认studio_only。
- [ ] `npm test -- --run`、`npm run build`，report给出检查结果和实际操作待验项；不commit。

## Task 4: 独立审查、图片核对、部署与正式交付

**Files:** Update app/README.md 精修流程；验收报告放被忽略的 `验收记录/精修交付/`，不加入Git；精修源文件及hash清单不加入Git。

- [ ] 独立review本次diff：API权限/状态/事务、评论隔离、前端流程、迁移/备份；修复所有critical/important并补先失败测试。
- [ ] 运行全量测试/build/diff check，记录实际测试数；确认只包含本次文件且未覆盖用户后续改动。
- [ ] 22 张精修逐一配对63张修前，近似场景放大核对，先验证本地与生产未修原图hash一致；输出私有配对清单（含photo id、source filename、retouched filename、sha256），无法确定保留未配对。
- [ ] 部署前只读核对线上git版本与dirty状态、服务状态、磁盘容量，创建DB与文件备份；发布快照不得包含data/或秘密；使用既有deploy.sh自测、build、health及失败回滚流程，必要时临时bundle不修改用户Git历史。
- [ ] 专用订单 #3 用自生成样片验收：员工上传/关联/发布/新版/撤回、客户高清/对比/下载hash/ZIP/反馈/权限/390px，清理本轮验收数据和临时会话。禁止真实订单验收评论/选片。
- [ ] 经业务API上传22张到#1，验证server hash与本地一致，发布；不更改原片/selection/slot/job状态。发布后只读确认列表与资源可用。
- [ ] 更新README和交付报告，最终回复上线URL、22张实际发布数、配对数/未配对清单、测试数、操作方式和遗留项。不要声称真机微信已验收。
