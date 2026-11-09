import { registerAuth } from './routes/auth.js';
import { registerClient } from './routes/client.js';
import { registerAdmin } from './routes/admin.js';
import { registerMedia } from './routes/media.js';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import archiver from 'archiver';
import multer from 'multer';
import { setSelection, assignSlot, removeSlot, union } from '../services/selection.js';
import { filterVisibleComments, filterVisibleEvents, visibleSelectionCount, visiblePhotoCondition } from '../services/visibility.js';
import { buildSummary, exportCsv } from '../services/export.js';
import { importPhotos, scanSourceDirectory } from '../services/photoImport.js';
import { createPhotoQueue, ensurePhotoDirs, purgeExpiredTrash, backfillPhotoMetadata } from '../services/photoManager.js';
export function createApp({db,cfg}){
 if (!cfg?.dataDir) throw new Error('createApp requires cfg.dataDir');
 ensurePhotoDirs(cfg.dataDir);
 const app=express();
 if (cfg.trustProxy) app.set('trust proxy', cfg.trustProxy);
 app.use((req, res, next) => {
   res.set({
     'X-Content-Type-Options': 'nosniff',
     'Referrer-Policy': 'same-origin',
     'X-Frame-Options': 'DENY',
     'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'"
   });
   next();
 });
 app.use(express.json({ limit: '1mb' })); app.use(cookieParser());
 const loginBuckets = new Map();
 const loginGuard = (req, res) => {
   const key = req.ip || req.socket.remoteAddress || 'unknown';
   const nowMs = Date.now();
   const windowMs = Number(cfg.loginRateLimitWindowMs || 60_000);
   const max = Number(cfg.loginRateLimitMax || 10);
   const bucket = loginBuckets.get(key);
   const current = bucket && nowMs - bucket.startedAt < windowMs ? bucket : { startedAt: nowMs, count: 0 };
   current.count += 1;
   loginBuckets.set(key, current);
   if (current.count > max) { res.status(429).json({ error: { code: 'LOGIN_RATE_LIMITED', message: '登录请求过于频繁，请稍后再试' } }); return false; }
   return true;
 };
 const activeTasks=new Set();
 const trackTask=(task)=>{const promise=Promise.resolve(task);activeTasks.add(promise);promise.then(()=>activeTasks.delete(promise),()=>activeTasks.delete(promise));return promise;};
 const waitForTasks=async (timeoutMs=10000)=>{const deadline=Date.now()+timeoutMs;while(activeTasks.size&&Date.now()<deadline){const remaining=deadline-Date.now();await Promise.race([Promise.allSettled([...activeTasks]),new Promise(resolve=>setTimeout(resolve,Math.min(remaining,100)))]);}};
 const now=()=>new Date().toISOString();
 const event=(jobId,kind,actor,payload={})=>db.prepare('insert into change_event(job_id,kind,actor_type,actor_id,payload,created_at) values(?,?,?,?,?,?)').run(jobId,kind,actor?.actor_type||null,actor?.actor_id||null,JSON.stringify(payload),now());
 const jobPhoto=(jobId,photoId)=>db.prepare(`select p.id from photo p where p.id=? and p.job_id=? and ${visiblePhotoCondition('p')}`).get(photoId,jobId);
 const visibleComments=(jobId,photoId,actor)=>filterVisibleComments(db.prepare('select * from photo_comment where job_id=? and photo_id=? and deleted_at is null order by created_at,id').all(jobId,photoId),actor);
 const visibleEvents=(jobId,actor,after)=>filterVisibleEvents(db.prepare('select * from change_event where job_id=? and id>? order by id').all(jobId,after),actor).map(e=>({...e,payload:e.payload?JSON.parse(e.payload):null}));
 const commentContent=(body)=>{const content=String(body.content||'').trim();if(!content||content.length>500)throw new Error('INVALID_COMMENT');return content};
 const session=(req,res,next)=>{const t=req.cookies.session; const row=t?db.prepare('select * from session where token=? and expires_at>?').get(t,new Date().toISOString()):null; if(row){const table=row.actor_type==='staff'?'staff':'customer';const account=db.prepare(`select * from ${table} where id=?`).get(row.actor_id); if(account?.status==='active'&&account.password_version===row.password_version){req.actor={actor_type:row.actor_type,actor_id:account.id,studio_id:account.studio_id,name:account.name,phone:account.phone,role:account.role,must_change_password:Boolean(account.must_change_password)};const remaining=new Date(row.expires_at).getTime()-Date.now();if(remaining<3*86400000){const expiresAt=new Date(Date.now()+7*86400000).toISOString();db.prepare('update session set expires_at=? where token=?').run(expiresAt,t);res.cookie('session',t,{httpOnly:true,sameSite:'lax',secure:Boolean(cfg.cookieSecure),maxAge:7*86400000});}}} next()}; app.use(session);
 const redactAuditValue=(value)=>{if(Array.isArray(value))return value.map(redactAuditValue);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:password|token|secret|credential|authorization)/i.test(key)).map(([key,item])=>[key,redactAuditValue(item)]));return value};
 const auditAdminMutation=(req,res,next)=>{res.on('finish',()=>{if(!req.actor||req.actor.actor_type!=='staff'||!req.path.startsWith('/api/admin/')||['GET','HEAD','OPTIONS'].includes(req.method)||req.path==='/api/admin/login'||req.path==='/api/admin/change-password'||res.statusCode>=400)return;const jobId=Number(req.params.id);const safeBody=redactAuditValue(req.body);try{db.prepare('insert into audit_log(job_id,actor_type,actor_id,action,payload,created_at) values(?,?,?,?,?,?)').run(Number.isInteger(jobId)&&jobId>0?jobId:null,'staff',req.actor.actor_id,`${req.method} ${req.path}`,JSON.stringify(safeBody),now())}catch{}});next()}; app.use(auditAdminMutation);
 const requireActor=(type, options={})=>(req,res,next)=>{if(!req.actor)return res.status(401).json({error:{code:'UNAUTHENTICATED',message:'请先登录'}});if(type==='selector'&&req.actor.actor_type==='customer'){const selector=db.prepare('select id from selector where customer_id=? and job_id=?').get(req.actor.actor_id,Number(req.params.id));if(!selector)return res.status(404).json({error:{code:'NOT_FOUND',message:'任务不存在'}});req.actor={...req.actor,actor_type:'selector',actor_id:selector.id};}else if(req.actor.actor_type!==type)return res.status(401).json({error:{code:'UNAUTHENTICATED',message:'请先登录'}});if(req.actor.must_change_password&&!options.allowPasswordChange)return res.status(403).json({error:{code:'PASSWORD_CHANGE_REQUIRED',message:'请先修改密码'}});next()};
 const jsonError=(res,status,code,message)=>res.status(status).json({error:{code,message}});
 const privateHeaders=res=>res.set('Cache-Control','private, no-store');
 const downloadHeaders=(res,name)=>{const fallback=String(name).replace(/[^\x20-\x7e]/g,'_').replace(/["\\]/g,'_')||'download.zip';return privateHeaders(res).set('Content-Disposition',`attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(String(name))}`)};
 const mediaHeaders=res=>res.set('Cache-Control','private, max-age=86400');
 const safeFile=(file, roots)=>{try{const resolved=fs.realpathSync(file);return roots.some(root=>{const base=fs.realpathSync(root);const relative=path.relative(base,resolved);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))})&&fs.statSync(resolved).isFile()?resolved:null}catch{return null}};
 const selectorFor=(jobId,actor)=>actor.actor_type==='selector'?db.prepare('select * from selector where id=? and job_id=?').get(actor.actor_id,jobId):null;
 const visiblePhoto=(jobId,photoId,actor)=>{const photo=db.prepare(`select p.* from photo p where p.id=? and p.job_id=? and ${visiblePhotoCondition('p')}`).get(photoId,jobId);if(!photo)return null;const selector=selectorFor(jobId,actor);if(selector)return {photo,selector};if(actor.actor_type==='staff'){const staff=db.prepare('select studio_id from staff where id=?').get(actor.actor_id);const job=db.prepare('select studio_id from job where id=?').get(jobId);return staff?.studio_id===job?.studio_id?{photo}:null;}return null;};
 const packagePhotos=(jobId,selectorId,scope)=>{const base=`select distinct p.* from photo p join selection s on s.photo_id=p.id join selector u on u.id=s.selector_id where p.job_id=? and ${visiblePhotoCondition('p')}`;if(scope==='selected_preview'||scope==='selected_original')return db.prepare(base+' and (u.id=? or u.share_selection=1) order by p.sort,p.id').all(jobId,selectorId);return db.prepare(`select p.* from photo p where p.job_id=? and ${visiblePhotoCondition('p')} order by p.sort,p.id`).all(jobId);};
 const packageView=p=>{const {file_key,...publicPackage}=p;return {...publicPackage,file_url:p.status==='ready'?`/api/client/jobs/${p.job_id}/packages/${p.id}/file`:null};};
 const cleanPackages=()=>{const expired=db.prepare("select id,file_key from download_package where expires_at is not null and expires_at<=?").all(now());for(const p of expired){if(p.file_key){const f=safeFile(p.file_key,[cfg.dataDir]);if(f)try{fs.unlinkSync(f)}catch{}}db.prepare('delete from download_package where id=?').run(p.id);}};
 const packageTimer=setInterval(cleanPackages,3600000); packageTimer.unref(); cleanPackages();
 const buildPackage=({id,jobId,selectorId,scope,photos,file})=>trackTask(new Promise(resolve=>{let settled=false;const finish=()=>{if(!settled){settled=true;resolve();}};const fail=()=>{try{db.prepare("update download_package set status='failed',error=? where id=?").run('ZIP_FAILED',id)}finally{finish()}};try{const output=fs.createWriteStream(file),archive=archiver('zip',{store:true});archive.pipe(output);photos.forEach(photo=>{const source=safeFile(photo.original_key,[cfg.photoSourceDir,cfg.dataDir]);const preview=safeFile(path.join(cfg.dataDir,'previews',`${photo.id}.webp`),[cfg.dataDir]);const input=scope==='selected_preview'?preview:source;if(input)archive.file(input,{name:scope==='selected_preview'?`${photo.id}.webp`:photo.filename});});archive.on('error',fail);output.on('error',fail);output.on('close',()=>{try{db.prepare("update download_package set status='ready',progress=total,file_key=? where id=?").run(file,id)}catch{fail();return}finish()});archive.finalize();}catch{fail()}}));
 app.locals.stopBackgroundTasks=()=>{clearInterval(packageTimer);clearInterval(purgeTimer);photoQueue.stop();}; app.locals.waitForTasks=async (timeoutMs=10000)=>{await Promise.all([waitForTasks(timeoutMs),photoQueue.waitForIdle(timeoutMs)]);};
 const issueSession=(res,type,id,passwordVersion)=>{const token=crypto.randomBytes(32).toString('hex');db.prepare('insert into session(token,actor_type,actor_id,password_version,created_at,expires_at) values(?,?,?,?,?,?)').run(token,type,id,passwordVersion,new Date().toISOString(),new Date(Date.now()+7*86400000).toISOString());res.cookie('session',token,{httpOnly:true,sameSite:'lax',secure:Boolean(cfg.cookieSecure),maxAge:7*86400000});};
 const authenticate=(table,phone,password)=>{const account=db.prepare(`select * from ${table} where phone=?`).get(phone);if(!account)return {error:'INVALID_LOGIN'};if(account.status!=='active')return {error:'ACCOUNT_DISABLED'};if(account.locked_until&&account.locked_until>new Date().toISOString())return {error:'ACCOUNT_LOCKED'};if(!bcrypt.compareSync(password,account.password_hash)){const attempts=account.failed_attempts+1;db.prepare(`update ${table} set failed_attempts=?,locked_until=? where id=?`).run(attempts,attempts>=5?new Date(Date.now()+15*60000).toISOString():null,account.id);return {error:attempts>=5?'ACCOUNT_LOCKED':'INVALID_LOGIN'};}db.prepare(`update ${table} set failed_attempts=0,locked_until=null,last_login_at=? where id=?`).run(new Date().toISOString(),account.id);return {account};};
 const err=(e,res)=>res.status(e.message==='JOB_LOCKED'?409:400).json({error:{code:e.message||'BAD_REQUEST',message:e.message==='JOB_LOCKED'?'选片任务已锁定，不能继续修改':e.message}});
 const createComment=(req,res,type,actorId)=>{try{const jobId=+req.params.id,photoId=+req.params.photoId;const photoExists=type==='staff'?db.prepare('select 1 from photo where id=? and job_id=? and deleted_at is null').get(photoId,jobId):jobPhoto(jobId,photoId);if(!photoExists)return jsonError(res,404,'NOT_FOUND','照片不存在');const content=commentContent(req.body);let parent=null;if(req.body.parent_id){parent=db.prepare('select * from photo_comment where id=? and job_id=? and photo_id=? and deleted_at is null').get(+req.body.parent_id,jobId,photoId);if(!parent)return jsonError(res,404,'NOT_FOUND','父评论不存在');if(parent.parent_id)return jsonError(res,400,'INVALID_COMMENT','评论只支持一层回复');}
   let visibility=req.body.visibility==='studio_only'?'studio_only':'all';let audience=null;if(parent){visibility=parent.visibility;audience=parent.audience_selector_id;} else if(type==='customer'){const selector=db.prepare('select share_selection from selector where id=? and job_id=?').get(actorId,jobId);if(!selector)return jsonError(res,404,'NOT_FOUND','选片人不存在');if(req.body.visibility===undefined)visibility=selector.share_selection?'all':'studio_only';audience=visibility==='studio_only'?actorId:null;} else if(visibility==='studio_only'){audience=Number(req.body.audience_selector_id)||null;}
   const id=db.prepare('insert into photo_comment(job_id,photo_id,parent_id,author_type,author_id,visibility,audience_selector_id,content,created_at) values(?,?,?,?,?,?,?,?,?)').run(jobId,photoId,parent?.id||null,type,actorId,visibility,audience,content,now()).lastInsertRowid;event(jobId,'comment.created',{actor_type:type,actor_id:actorId},{comment_id:Number(id),photo_id:photoId,visibility,audience_selector_id:audience,selector_id:type==='customer'?actorId:null});res.status(201).json({comment:db.prepare('select * from photo_comment where id=?').get(id)})}catch(e){return jsonError(res,400,'INVALID_COMMENT','评论不能为空且最多500字')}};
 const staffStudio=a=>db.prepare('select studio_id,role from staff where id=?').get(a.actor_id);
 const ownedJob=(id,a)=>{const s=staffStudio(a);return db.prepare('select * from job where id=? and studio_id=?').get(+id,s?.studio_id)};
 const adminOnly=(req,res)=>req.actor.role==='admin'||(jsonError(res,403,'FORBIDDEN','仅管理员可执行此操作'),false);
 const changePassword=(req,res,table)=>{const current=String(req.body.current_password||''),next=String(req.body.new_password||'');if(next.length<8||next===current)return jsonError(res,400,'INVALID_PASSWORD','新密码至少8位且不能与旧密码相同');const account=db.prepare('select * from '+table+' where id=?').get(req.actor.actor_id);if(!bcrypt.compareSync(current,account.password_hash))return jsonError(res,401,'INVALID_PASSWORD','当前密码错误');const updatedAt=table==='customer'?',updated_at=?':'';const values=table==='customer'?[bcrypt.hashSync(next,10),new Date().toISOString(),account.id]:[bcrypt.hashSync(next,10),account.id];db.prepare('update '+table+' set password_hash=?,must_change_password=0,password_version=password_version+1'+updatedAt+' where id=?').run(...values);if(req.cookies.session)db.prepare('delete from session where token=?').run(req.cookies.session);issueSession(res,table==='customer'?'customer':'staff',account.id,account.password_version+1);res.json({ok:true});};
 const photoUpload = multer({
   storage: multer.diskStorage({
     destination: (req, file, cb) => { fs.mkdirSync(path.join(cfg.dataDir, 'tmp'), { recursive: true }); cb(null, path.join(cfg.dataDir, 'tmp')); },
     filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.upload`),
   }),
   limits: { fileSize: Number(cfg.photoMaxBytes || 50 * 1024 * 1024), files: 1 },
   fileFilter: (req, file, cb) => cb(null, /\.(jpe?g|png|heic|heif)$/i.test(file.originalname)),
 });
 const photoQueue = createPhotoQueue({ db, cfg });
 const purgeTimer = setInterval(() => { try { purgeExpiredTrash(db, cfg); } catch {} }, 3600000); purgeTimer.unref();
 setImmediate(() => {
   try { purgeExpiredTrash(db, cfg); } catch {}
   try { photoQueue.resume(); } catch {}
   try { trackTask(backfillPhotoMetadata(db, cfg).catch(() => 0)); } catch {}
 });
 app.locals.photoQueue = photoQueue;
 app.locals.waitForPhotoQueue = (timeoutMs) => photoQueue.waitForIdle(timeoutMs);
 app.locals.waitForPhotoIds = (ids, timeoutMs) => photoQueue.waitForIds(ids, timeoutMs);
 app.locals.cleanPackages = cleanPackages;
 const routeContext={db,cfg,now,event,jobPhoto,visibleComments,visibleEvents,commentContent,requireActor,jsonError,privateHeaders,downloadHeaders,mediaHeaders,safeFile,selectorFor,packagePhotos,packageView,cleanPackages,buildPackage,issueSession,authenticate,changePassword,createComment,ownedJob,staffStudio,adminOnly,err,union,buildSummary,exportCsv,importPhotos,scanSourceDirectory,loginGuard,photoUpload,photoQueue,trackTask};
 registerAuth(app,routeContext); registerClient(app,routeContext); registerAdmin(app,routeContext); registerMedia(app,routeContext);

 const dist=path.resolve(process.cwd(),'dist');if(fs.existsSync(dist)){app.use(express.static(dist));app.get('*',(req,res)=>res.sendFile(path.join(dist,'index.html')))}
 app.use((error, req, res, next) => {
   if (res.headersSent) return next(error);
   console.error(error);
   const code = error.code === 'LIMIT_FILE_SIZE' ? 'UPLOAD_TOO_LARGE' : error.message === 'INVALID_UPLOAD' || error.code === 'LIMIT_UNEXPECTED_FILE' ? 'INVALID_UPLOAD' : error.code || 'INTERNAL_ERROR';
   const status = code === 'UPLOAD_TOO_LARGE' || code === 'INVALID_UPLOAD' ? 400 : (error.statusCode || 500);
   return res.status(status).json({ error: { code, message: cfg.production ? '服务器内部错误' : (code === 'UPLOAD_TOO_LARGE' ? '单个文件不能超过50MB' : code === 'INVALID_UPLOAD' ? '只接受有效的 jpg/jpeg/png/heic 图片' : (error.message || '服务器内部错误')) } });
 });
 return app;
}
