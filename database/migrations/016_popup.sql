-- Pop-up promo saat aplikasi mobile dibuka (rancangan voucher 2026-11-16 §5.5): hanya admin; yang tayang = aktif terbaru
-- dalam periode. Aplikasi menampilkannya sekali per hari per pop-up dan tidak lagi bila vouchernya sudah diklaim.
CREATE TABLE IF NOT EXISTS popups (
  id          INT          AUTO_INCREMENT PRIMARY KEY,
  title       VARCHAR(80)  NOT NULL,
  image_url   VARCHAR(500) NOT NULL,
  promo_id    INT          NULL,                 -- voucher platform yang bisa diklaim dari pop-up
  starts_at   DATETIME     NOT NULL,
  ends_at     DATETIME     NOT NULL,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by  INT          NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (promo_id)   REFERENCES promos(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id)  ON DELETE SET NULL,
  INDEX idx_popup_tayang (is_active, starts_at, ends_at)
);
