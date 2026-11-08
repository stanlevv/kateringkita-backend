-- F18 Admin inti: verifikasi penjual, master jenis usaha yang bisa dinonaktifkan, log aksi admin.

ALTER TABLE merchants
  ADD COLUMN verification_status ENUM('pending','needs_fix','verified','suspended') NOT NULL DEFAULT 'pending',
  ADD COLUMN verification_note   VARCHAR(500) NULL,
  ADD COLUMN suspended_at        DATETIME     NULL,
  ADD COLUMN suspended_reason    VARCHAR(500) NULL;

-- Penjual yang sudah ada sebelum migrasi ini dianggap terverifikasi (K2); yang daftar sesudahnya mulai dari 'pending'.
UPDATE merchants SET verification_status = 'verified', verified_at = COALESCE(verified_at, UTC_TIMESTAMP());

ALTER TABLE merchant_types
  ADD COLUMN is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN sort_order INT     NOT NULL DEFAULT 0;

UPDATE merchant_types SET sort_order = id;

CREATE TABLE admin_audit_logs (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  admin_user_id INT          NOT NULL,
  action        VARCHAR(60)  NOT NULL,
  target_type   VARCHAR(30)  NOT NULL,
  target_id     VARCHAR(40)  NOT NULL,
  reason        VARCHAR(500) NULL,
  before_json   JSON         NULL,
  after_json    JSON         NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_target (target_type, target_id),
  INDEX idx_audit_created (created_at),
  FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE RESTRICT
);
