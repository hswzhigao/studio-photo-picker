-- Keep every legacy placeholder row and field; legacy files are not implicitly published.
ALTER TABLE retouched_photo ADD COLUMN asset_id TEXT;
ALTER TABLE retouched_photo ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version > 0);
ALTER TABLE retouched_photo ADD COLUMN status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','published','withdrawn'));
ALTER TABLE retouched_photo ADD COLUMN width INTEGER;
ALTER TABLE retouched_photo ADD COLUMN height INTEGER;
ALTER TABLE retouched_photo ADD COLUMN size_bytes INTEGER;
ALTER TABLE retouched_photo ADD COLUMN sha256 TEXT;
ALTER TABLE retouched_photo ADD COLUMN published_at TEXT;
ALTER TABLE retouched_photo ADD COLUMN created_at TEXT;
UPDATE retouched_photo SET asset_id='legacy-' || id;
CREATE UNIQUE INDEX idx_retouched_asset_version ON retouched_photo(asset_id, version);
CREATE UNIQUE INDEX idx_retouched_job_hash ON retouched_photo(job_id, sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX idx_retouched_job_status ON retouched_photo(job_id,status,asset_id,version);
CREATE TRIGGER retouched_insert_guard BEFORE INSERT ON retouched_photo BEGIN
  SELECT CASE WHEN NEW.asset_id IS NULL OR NOT EXISTS(SELECT 1 FROM job WHERE id=NEW.job_id)
    OR (NEW.photo_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM photo WHERE id=NEW.photo_id AND job_id=NEW.job_id))
    OR EXISTS(SELECT 1 FROM retouched_photo WHERE asset_id=NEW.asset_id AND (job_id<>NEW.job_id OR photo_id IS NOT NEW.photo_id))
    THEN RAISE(ABORT,'INVALID_RETOUCHED_ASSOCIATION') END;
END;
CREATE TRIGGER retouched_update_guard BEFORE UPDATE OF job_id,asset_id,photo_id ON retouched_photo BEGIN
  SELECT CASE WHEN NEW.asset_id IS NULL OR NEW.asset_id IS NOT OLD.asset_id OR NEW.job_id<>OLD.job_id
    OR NOT EXISTS(SELECT 1 FROM job WHERE id=NEW.job_id)
    OR (NEW.photo_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM photo WHERE id=NEW.photo_id AND job_id=NEW.job_id))
    THEN RAISE(ABORT,'INVALID_RETOUCHED_ASSOCIATION') END;
END;
CREATE TRIGGER retouched_photo_delete_guard BEFORE DELETE ON photo
WHEN EXISTS(SELECT 1 FROM retouched_photo WHERE photo_id=OLD.id) BEGIN
  SELECT RAISE(ABORT,'RETOUCHED_PHOTO_IN_USE');
END;
