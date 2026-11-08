const deps = (ctx) => ctx;

export function registerAuth(app, ctx) {
  const { db, cfg, now, event, jobPhoto, visibleComments, visibleEvents, commentContent, requireActor, jsonError, downloadHeaders, mediaHeaders, safeFile, selectorFor, packagePhotos, packageView, cleanPackages, buildPackage, issueSession, authenticate, changePassword, createComment, ownedJob, staffStudio, adminOnly, err, union, buildSummary, exportCsv, importPhotos, scanSourceDirectory } = ctx;
   app.get('/api/health',(req,res)=>res.json({ok:true,studio:cfg.studioName}));
   app.post('/api/auth/login',(req,res)=>{const phone=String(req.body.phone||''),password=String(req.body.password||'');const result=authenticate('customer',phone,password);if(result.error)return jsonError(res,result.error==='ACCOUNT_LOCKED'?423:401,result.error,'账号或密码错误');const customer=result.account;issueSession(res,'customer',customer.id,customer.password_version);res.json({ok:true,actor:{type:'customer',id:customer.id},must_change_password:Boolean(customer.must_change_password)})});
   app.post('/api/auth/change-password',requireActor('customer',{allowPasswordChange:true}),(req,res)=>changePassword(req,res,'customer'));
   app.post('/api/auth/logout',(req,res)=>{if(req.cookies.session)db.prepare('delete from session where token=?').run(req.cookies.session);res.clearCookie('session').json({ok:true})});
   app.get('/api/auth/me',(req,res)=>res.json({actor:req.actor||null}));
}
