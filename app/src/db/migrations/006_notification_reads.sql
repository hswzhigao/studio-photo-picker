ALTER TABLE notification ADD COLUMN read_at TEXT;
CREATE INDEX IF NOT EXISTS idx_notification_selector ON notification(selector_id, id);
