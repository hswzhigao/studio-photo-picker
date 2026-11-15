import { getRetouched, currentRetouched, retouchedError, positiveId } from '../../services/retouched.js';
import { canSeeComment } from '../../services/visibility.js';

export function registerRetouchedComments(app, {db,requireActor,ownedJob,withMutation,now}) {
  const wrap=fn=>(req,res)=>{try{fn(req,res);}catch(e){res.status(e.statusCode||500).json({error:{code:e.statusCode?e.code:'INTERNAL_ERROR',message:e.statusCode?e.code:'反馈操作失败'}});}};
  const content=body=>{if(typeof body.content!=='string'||!body.content.trim()||body.content.trim().length>500)throw retouchedError('INVALID_COMMENT');return body.content.trim();};
  const view=c=>({...c,author_name:c.author_type==='staff'?(db.prepare('select name from staff where id=?').get(c.author_id)?.name||'影楼'):(db.prepare('select name from selector where id=? and job_id=?').get(c.author_id,c.job_id)?.name||'选片人')});
  const find=(req,id)=>{const c=db.prepare('select * from photo_comment where id=? and job_id=? and retouched_photo_id=? and deleted_at is null').get(positiveId(id),+req.params.id,+req.params.retouchedId);if(!c||!canSeeComment(c,req.actor))throw retouchedError('NOT_FOUND',404);return c;};
  const mutate=(req,kind,c,fn)=>{
    const actor={...req.actor,actor_type:req.actor.actor_type==='staff'?'staff':'customer'};
    return withMutation({jobId:+req.params.id,actor,action:`retouched.comment.${kind}`,eventKind:`retouched.comment.${kind}`,payload:c},fn);
  };
  for(const role of ['admin','client']) {
    const base=`/api/${role}/jobs/:id/retouched/:retouchedId/comments`;
    const guard=[requireActor(role==='admin'?'staff':'selector'),(req,res,next)=>{
      if(role==='admin'&&!ownedJob(req.params.id,req.actor))return res.status(404).json({error:{code:'NOT_FOUND',message:'任务不存在'}});
      try{req.retouched=getRetouched(db,+req.params.id,req.params.retouchedId,req.actor);next();}catch(e){res.status(e.statusCode||400).json({error:{code:e.code,message:e.code}});}
    }];
    app.get(base,...guard,wrap((req,res)=>res.json({comments:db.prepare('select * from photo_comment where job_id=? and retouched_photo_id=? and deleted_at is null order by created_at,id').all(+req.params.id,req.retouched.id).filter(c=>canSeeComment(c,req.actor)).map(view)})));
    app.post(base,...guard,wrap((req,res)=>{
      const p=req.retouched;
      if(role==='client'&&!currentRetouched(db,+req.params.id,req.actor).some(c=>c.id===p.id))throw retouchedError('HISTORICAL_VERSION',409);
      const text=content(req.body);
      if(req.body.visibility!==undefined&&!['studio_only','all'].includes(req.body.visibility))throw retouchedError('INVALID_VISIBILITY');
      const parent=req.body.parent_id===undefined?null:find(req,req.body.parent_id);
      if(parent?.parent_id)throw retouchedError('INVALID_COMMENT');
      const visibility=parent?.visibility||req.body.visibility||'studio_only';
      let audience=parent?.audience_selector_id??null;
      if(!parent&&visibility==='studio_only'){
        if(role==='client')audience=req.actor.actor_id;
        else if(req.body.audience_selector_id!==undefined){audience=positiveId(req.body.audience_selector_id);if(!db.prepare('select 1 from selector where id=? and job_id=?').get(audience,+req.params.id))throw retouchedError('INVALID_AUDIENCE');}
      }
      const payload={retouched_photo_id:p.id,photo_id:p.photo_id,visibility,audience_selector_id:audience,selector_id:role==='client'?req.actor.actor_id:null};
      const id=mutate(req,'created',payload,()=>{const id=Number(db.prepare('insert into photo_comment(job_id,photo_id,retouched_photo_id,parent_id,author_type,author_id,visibility,audience_selector_id,content,created_at) values(?,?,?,?,?,?,?,?,?,?)').run(+req.params.id,p.photo_id,p.id,parent?.id||null,role==='admin'?'staff':'customer',req.actor.actor_id,visibility,audience,text,now()).lastInsertRowid);payload.comment_id=id;return id;});
      res.status(201).json({comment:view(find(req,id))});
    }));
    for(const method of ['patch','delete'])app[method](`${base}/:commentId`,...guard,wrap((req,res)=>{
      const c=find(req,req.params.commentId),type=role==='admin'?'staff':'customer';
      if(c.author_type!==type||c.author_id!==req.actor.actor_id)throw retouchedError('NOT_FOUND',404);
      if(Date.now()-Date.parse(c.created_at)>300000)throw retouchedError('COMMENT_EDIT_EXPIRED');
      const text=method==='patch'?content(req.body):null;
      mutate(req,method==='patch'?'updated':'deleted',{comment_id:c.id,retouched_photo_id:c.retouched_photo_id,photo_id:c.photo_id,visibility:c.visibility,audience_selector_id:c.audience_selector_id},()=>{
        if(method==='patch')db.prepare('update photo_comment set content=?,edited_at=? where id=?').run(text,now(),c.id);
        else db.prepare('update photo_comment set deleted_at=? where id=?').run(now(),c.id);
      });res.json({ok:true});
    }));
  }
}
