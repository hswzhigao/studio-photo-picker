import { config, ensureDirs, lanIp } from './src/config.js';
import { getDb, initializeDatabase } from './src/db/connection.js';
import { seedDatabase } from './src/db/seed.js';
import { createApp } from './src/app.js';
import { importPhotos } from './src/services/photoImport.js';
ensureDirs(); const db=getDb(config.dataDir); initializeDatabase(db); const jobId=seedDatabase(db,config); const count=db.prepare("select count(*) count from photo where job_id=? and import_status='ready'").get(jobId).count;
if(!count){console.log('正在导入照片并生成预览…');await importPhotos({db,jobId,sourceDir:config.photoSourceDir,dataDir:config.dataDir,watermarkText:config.watermarkText});}
const app=createApp({db,cfg:config});app.listen(config.port,'0.0.0.0',()=>{console.log(`电脑访问地址 http://localhost:${config.port}`);console.log(`手机访问地址 http://${lanIp()}:${config.port}`);console.log(`后台地址 http://localhost:${config.port}/admin`);});
