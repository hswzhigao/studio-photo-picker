-- Phase 2 password authentication. OTP/invite columns remain only for legacy data; no API trusts them.
CREATE INDEX IF NOT EXISTS idx_customer_phone ON customer(phone);
CREATE INDEX IF NOT EXISTS idx_staff_phone ON staff(phone);
