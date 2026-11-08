CREATE TABLE audit_log_new (id INTEGER PRIMARY KEY, job_id INTEGER REFERENCES job(id), actor_type TEXT NOT NULL, actor_id INTEGER NOT NULL, action TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL);
INSERT INTO audit_log_new(id,job_id,actor_type,actor_id,action,payload,created_at) SELECT id,job_id,actor_type,actor_id,action,payload,created_at FROM audit_log;
DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;
CREATE INDEX IF NOT EXISTS idx_audit_log_job ON audit_log(job_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_type, actor_id, id);
