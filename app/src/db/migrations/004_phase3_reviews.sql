CREATE TABLE IF NOT EXISTS job_review (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES job(id), selector_id INTEGER NOT NULL REFERENCES selector(id), rating INTEGER NOT NULL, content TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(job_id, selector_id));
CREATE INDEX IF NOT EXISTS idx_review_job ON job_review(job_id);
