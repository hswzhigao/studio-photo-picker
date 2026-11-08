import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getDb, initializeDatabase } from '../src/db/connection.js';
import { generateReadablePassword } from '../src/services/credentials.js';

const phone = String(process.argv[2] || '').trim();
if (!/^1\d{10}$/.test(phone)) {
  console.error('用法：npm run reset-password -- <手机号>');
  process.exit(1);
}

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), '..', 'data'));
const db = getDb(dataDir);
try {
  initializeDatabase(db);
  const password = generateReadablePassword();
  const hash = bcrypt.hashSync(password, 10);
  const table = db.prepare('select id from staff where phone=?').get(phone) ? 'staff' : db.prepare('select id from customer where phone=?').get(phone) ? 'customer' : null;
  if (!table) throw new Error('未找到该手机号对应的员工或客户账号');
  const account = db.prepare(`select id from ${table} where phone=?`).get(phone);
  const update = table === 'customer'
    ? db.prepare('update customer set password_hash=?,must_change_password=1,password_version=password_version+1,updated_at=? where id=?')
    : db.prepare('update staff set password_hash=?,must_change_password=1,password_version=password_version+1 where id=?');
  if (table === 'customer') update.run(hash, new Date().toISOString(), account.id);
  else update.run(hash, account.id);
  db.prepare('delete from session where actor_type=? and actor_id=?').run(table, account.id);
  process.stdout.write(`${password}\n`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
