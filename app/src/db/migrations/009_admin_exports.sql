ALTER TABLE download_package ADD COLUMN export_name TEXT;
ALTER TABLE download_package ADD COLUMN missing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE download_package ADD COLUMN created_by INTEGER;
ALTER TABLE download_package ADD COLUMN meta TEXT;
CREATE INDEX idx_download_package_job_kind ON download_package(job_id, kind, id);
