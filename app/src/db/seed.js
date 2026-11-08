import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { generateReadablePassword } from '../services/credentials.js';
export function seedDatabase(db, cfg) {
  if (db.prepare('select id from studio limit 1').get()) return db.prepare('select id from job limit 1').get().id;
  const now=new Date().toISOString();
  const studio=db.prepare('insert into studio(name,watermark_text,sms_sign) values(?,?,?)').run(cfg.studioName,'名人婚纱 · 预览','【名人婚纱】').lastInsertRowid;
  const initialStaffPassword = cfg.initialStaffPassword || process.env.INITIAL_STAFF_PASSWORD || generateReadablePassword();
  db.prepare('insert into staff(studio_id,name,phone,role,password_hash,must_change_password) values(?,?,?,?,?,1)').run(studio,'管理员','13800000000','admin',bcrypt.hashSync(initialStaffPassword,10));
  if (!cfg.initialStaffPassword && !process.env.INITIAL_STAFF_PASSWORD) console.log('后台已创建初始账号 13800000000，请使用 npm run reset-password -- 13800000000 获取一次性密码。');
  const tpl=db.prepare('insert into package_template(studio_id,name) values(?,?)').run(studio,'婚纱照 · 标准套餐').lastInsertRowid;
  const items=[['精修照片','retouch',20],['30寸相框','print_from_retouch',1],['10寸摆台','print_from_retouch',1],['相册','album',1]];
  for (let i=0;i<items.length;i++) db.prepare('insert into package_template_item(template_id,name,kind,quantity,sort) values(?,?,?,?,?)').run(tpl,...items[i],i);
  const deadline=new Date(Date.now()+7*86400000).toISOString();
  const job=db.prepare('insert into job(studio_id,title,status,deadline_at,allow_overage,overage_unit_price,allow_original_download,invite_token,created_by) values(?,?,?,?,?,?,?,?,?)').run(studio,'示例 · 婚纱照','selecting',deadline,1,cfg.overageUnitPrice,1,crypto.randomBytes(20).toString('hex'),1).lastInsertRowid;
  for (const x of items) db.prepare('insert into job_item(job_id,name,kind,quantity,sort) values(?,?,?,?,?)').run(job,...x,items.indexOf(x));
  const initialCustomerPassword = cfg.initialCustomerPassword || process.env.INITIAL_CUSTOMER_PASSWORD || generateReadablePassword();
  const addCustomer = db.prepare('insert into customer(studio_id,name,phone,password_hash,must_change_password,created_at,updated_at) values(?,?,?,?,?,?,?)');
  [['小雅','13900000001','select_submit',1,1],['阿杰','13900000002','select_submit',1,1],['妈妈','13900000003','select_only',0,0]].forEach(x=>{addCustomer.run(studio,x[0],x[1],bcrypt.hashSync(initialCustomerPassword,10),1,now,now);const customer=db.prepare('select id from customer where phone=?').get(x[1]);db.prepare('insert into selector(job_id,customer_id,name,phone,permission,share_selection,can_change_share,last_active_at) values(?,?,?,?,?,?,?,?)').run(job,customer.id,...x,now);});
  return job;
}
