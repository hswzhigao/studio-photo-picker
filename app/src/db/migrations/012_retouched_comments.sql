CREATE TABLE photo_comment_new (
 id INTEGER PRIMARY KEY,
 job_id INTEGER NOT NULL REFERENCES job(id),
 photo_id INTEGER REFERENCES photo(id),
 retouched_photo_id INTEGER REFERENCES retouched_photo(id),
 parent_id INTEGER REFERENCES photo_comment(id),
 author_type TEXT NOT NULL,
 author_id INTEGER NOT NULL,
 visibility TEXT NOT NULL DEFAULT 'all',
 audience_selector_id INTEGER REFERENCES selector(id),
 content TEXT NOT NULL,
 created_at TEXT NOT NULL,
 edited_at TEXT,
 deleted_at TEXT,
 CHECK (retouched_photo_id IS NOT NULL OR photo_id IS NOT NULL)
);
INSERT INTO photo_comment_new(id,job_id,photo_id,parent_id,author_type,author_id,visibility,audience_selector_id,content,created_at,edited_at,deleted_at)
 SELECT id,job_id,photo_id,parent_id,author_type,author_id,visibility,audience_selector_id,content,created_at,edited_at,deleted_at FROM photo_comment;
DROP TABLE photo_comment;
ALTER TABLE photo_comment_new RENAME TO photo_comment;
CREATE INDEX idx_comment_job_photo ON photo_comment(job_id,photo_id);
CREATE INDEX idx_comment_job_created ON photo_comment(job_id,created_at);
CREATE INDEX idx_comment_retouched ON photo_comment(job_id,retouched_photo_id,created_at);
CREATE TRIGGER comment_retouched_context BEFORE INSERT ON photo_comment WHEN NEW.retouched_photo_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM retouched_photo r WHERE r.id=NEW.retouched_photo_id AND r.job_id=NEW.job_id AND r.photo_id IS NEW.photo_id) THEN RAISE(ABORT,'invalid retouched comment context') END;
END;
