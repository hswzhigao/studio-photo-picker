import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import archiver from 'archiver';
import { retouchedRoot, retouchedError, retouchedIds, getRetouched, currentRetouched, retouchedView, validatePair, prepareRetouched } from '../../services/retouched.js';

export function registerRetouched(app, ctx) {
  const { db,cfg,requireActor,ownedJob,photoUpload,withMutation,safeFile,downloadHeaders } = ctx;
  const wrap = fn => (req,res,next) => Promise.resolve().then(()=>fn(req,res)).catch(error => {
    if (res.headersSent) return res.destroy();
    const code = error.code || 'INTERNAL_ERROR';
    res.status(error.statusCode || (code==='LIMIT_FILE_SIZE'?400:500)).json({error:{code:code==='LIMIT_FILE_SIZE'?'UPLOAD_TOO_LARGE':code,message:error.statusCode ? code : '精修操作失败'}});
  });
  const authorize = (role) => (req,res,next) => {
    if (role==='admin' && !ownedJob(req.params.id,req.actor)) return res.status(404).json({error:{code:'NOT_FOUND',message:'任务不存在'}});
    next();
  };
  const mutate = (req,kind,payload,fn) => withMutation({jobId:+req.params.id,actor:req.actor,action:`retouched.${kind}`,eventKind:`retouched.${kind}`,payload},fn);
  const view = (req,row) => retouchedView(db,row,req.actor);
  const row = req => getRetouched(db,+req.params.id,req.params.retouchedId,req.actor);
  let zipActive = false;
  let uploadsActive = 0;
  const uploadCapacity = (req,res,next) => {
    if (uploadsActive >= 2) return res.status(429).json({error:{code:'UPLOAD_BUSY',message:'请稍后重试'}});
    uploadsActive += 1;
    let released = false;
    const release = () => { if (!released) { released=true;uploadsActive-=1; } };
    res.on('finish',release);res.on('close',release);next();
  };
  for (const role of ['admin','client']) {
    const base = `/api/${role}/jobs/:id/retouched`;
    const guard = [requireActor(role==='admin'?'staff':'selector'),authorize(role)];
    app.get(base,...guard,wrap((req,res)=>res.json({photos:currentRetouched(db,+req.params.id,req.actor).map(r=>view(req,r)),wechat:/micromessenger/i.test(req.get('user-agent')||'')})));
    if (role==='client') app.get(`${base}/download-all`,...guard,wrap((req,res)=> {
      if(zipActive) throw retouchedError('ZIP_BUSY',429);
      const rows=currentRetouched(db,+req.params.id,req.actor);
      const files=rows.map(r=>{const file=safeFile(r.file_key,[retouchedRoot(cfg)]);if(!file)throw retouchedError('NOT_FOUND',404);return file;});
      zipActive=true;
      const archive=archiver('zip',{store:true});
      const inputs=[];
      const stillAllowed=()=> {
        const session=db.prepare('select * from session where token=? and expires_at>?').get(req.cookies.session,new Date().toISOString());
        const account=db.prepare("select * from customer where id=? and status='active'").get(session?.actor_id);
        return session?.actor_type==='customer' && account && account.password_version===session.password_version && db.prepare('select 1 from selector where id=? and job_id=? and customer_id=?').get(req.actor.actor_id,+req.params.id,account.id) && rows.every(r=>db.prepare("select 1 from retouched_photo where id=? and job_id=? and status='published'").get(r.id,+req.params.id));
      };
      const output = new Transform({transform(chunk,encoding,done){try{if(!stillAllowed())return done(retouchedError('NOT_FOUND',404));done(null,chunk);}catch(e){done(e);}}});
      let closed=false;
      const cleanup=()=>{if(closed)return;closed=true;zipActive=false;clearInterval(timer);archive.abort();for(const input of inputs)input.destroy();output.destroy();};
      const fail=()=>{res.destroy();cleanup();};
      const timer=setInterval(()=>{try{if(!stillAllowed())fail();}catch{fail();}},10);timer.unref();
      res.on('close',cleanup); archive.on('error',fail);archive.on('warning',fail);output.on('error',fail);
      downloadHeaders(res,'retouched.zip');res.type('zip');archive.pipe(output).pipe(res);
      const used=new Set();
      rows.forEach((r,index)=> {
        const clean=path.basename(r.filename.replace(/\\/g,'/')).replace(/[\u0000-\u001f\u007f]/g,'_')||`photo-${r.id}.jpg`;
        const ext=path.extname(clean),stem=path.basename(clean,ext);let name=clean,n=2;
        while(used.has(name.toLowerCase()))name=`${stem}-${n++}${ext}`;used.add(name.toLowerCase());
        const input=fs.createReadStream(files[index]);inputs.push(input);input.on('error',fail);archive.append(input,{name});
      });
      archive.finalize().catch(fail);
    }));
    app.get(`${base}/:retouchedId`,...guard,wrap((req,res)=>res.json({photo:view(req,row(req))})));
    for(const kind of ['thumb','original','download']) app.get(`${base}/:retouchedId/${kind}`,...guard,wrap((req,res)=> {
      const p=row(req); const file=safeFile(kind==='thumb'?p.thumb_key:p.file_key,[retouchedRoot(cfg)]);
      if(!file)throw retouchedError('NOT_FOUND',404);
      res.set('Cache-Control','private, no-store');
      if(kind==='download')downloadHeaders(res,p.filename);
      if(kind==='original') {
        downloadHeaders(res,p.filename);
        res.set('Content-Disposition',res.get('Content-Disposition').replace(/^attachment;/,'inline;'));
      }
      res.sendFile(file);
    }));
    if(role!=='admin')continue;
    app.post(base,...guard,uploadCapacity,(req,res,next)=>photoUpload.single('photo')(req,res,error=>{if(error){if(req.file?.path)fs.rmSync(req.file.path,{force:true});return res.status(400).json({error:{code:error.code==='LIMIT_FILE_SIZE'?'UPLOAD_TOO_LARGE':'INVALID_UPLOAD',message:'上传文件无效或过大'}});}next();}),wrap(async(req,res)=> {
      let prepared;
      try {
        prepared=await prepareRetouched(req.file,cfg);
        const payload = {};
        const result=mutate(req,'uploaded',payload,()=> {
          if(db.prepare('select 1 from retouched_photo where job_id=? and sha256=?').get(+req.params.id,prepared.sha256))throw retouchedError('DUPLICATE_RETOUCHED',409);
          let assetId=crypto.randomUUID(),version=1,pair=null;
          if(req.query.asset_id!==undefined){
            if(typeof req.query.asset_id!=='string')throw retouchedError('INVALID_ASSET');
            const previous=db.prepare('select * from retouched_photo where job_id=? and asset_id=? order by version desc limit 1').get(+req.params.id,req.query.asset_id);
            if(!previous)throw retouchedError('INVALID_ASSET');
            assetId=previous.asset_id;version=previous.version+1;pair=previous.photo_id;
            if(req.query.photo_id!==undefined && validatePair(db,+req.params.id,req.query.photo_id)!==pair)throw retouchedError('INVALID_PHOTO');
          }else if(req.query.photo_id!==undefined)pair=validatePair(db,+req.params.id,req.query.photo_id);
          const keys=Object.keys(prepared);
          const id=db.prepare(`insert into retouched_photo(job_id,asset_id,version,photo_id,uploaded_by,created_at,${keys.join(',')}) values(${Array(6+keys.length).fill('?').join(',')})`).run(+req.params.id,assetId,version,pair,req.actor.actor_id,new Date().toISOString(),...Object.values(prepared)).lastInsertRowid;
          Object.assign(payload,{retouched_photo_id:Number(id),asset_id:assetId,version,photo_id:pair});
          return getRetouched(db,+req.params.id,id,req.actor);
        });
        res.status(201).json({photo:view(req,result)});
      }catch(error){if(prepared)for(const f of [prepared.file_key,prepared.thumb_key])fs.rmSync(f,{force:true});throw error;}
      finally{if(req.file?.path)fs.rmSync(req.file.path,{force:true});}
    }));
    app.patch(`${base}/:retouchedId`,...guard,wrap((req,res)=> {
      const p=row(req);const pair=validatePair(db,+req.params.id,req.body.photo_id);
      const updated=mutate(req,'paired',{retouched_photo_id:p.id,asset_id:p.asset_id,photo_id:pair},()=>{
        if(db.prepare("select 1 from retouched_photo where asset_id=? and status='published'").get(p.asset_id))throw retouchedError('PUBLISHED_ASSOCIATION',409);
        if(pair!==p.photo_id && db.prepare('select 1 from photo_comment c join retouched_photo r on r.id=c.retouched_photo_id where r.asset_id=? limit 1').get(p.asset_id))throw retouchedError('COMMENTED_ASSOCIATION',409);
        db.prepare('update retouched_photo set photo_id=? where job_id=? and asset_id=?').run(pair,+req.params.id,p.asset_id);
        return row(req);
      });res.json({photo:view(req,updated)});
    }));
    for(const action of ['publish','withdraw']) app.post(`${base}/${action}`,...guard,wrap((req,res)=> {
      const ids=retouchedIds(req.body.ids);
      const result=mutate(req,action==='publish'?'published':'withdrawn',{ids},()=> {
        const rows=ids.map(id=>getRetouched(db,+req.params.id,id,req.actor));
        if(rows.some(r=>r.status!==(action==='publish'?'ready':'published')))throw retouchedError('INVALID_STATUS',409);
        if(action==='publish' && rows.some(r=>!r.sha256||!r.width||!r.height||!safeFile(r.file_key,[retouchedRoot(cfg)])||!safeFile(r.thumb_key,[retouchedRoot(cfg)])))throw retouchedError('INVALID_FILE');
        for(const r of rows) db.prepare('update retouched_photo set status=?,published_at=case when ?=\'published\' then ? else published_at end where id=?').run(action==='publish'?'published':'ready',action==='publish'?'published':'withdrawn',new Date().toISOString(),r.id);
        return ids.map(id=>getRetouched(db,+req.params.id,id,req.actor));
      });res.json({photos:result.map(r=>view(req,r))});
    }));
  }
}
