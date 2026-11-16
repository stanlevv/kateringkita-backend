-- Banner beranda aplikasi pembeli (rancangan voucher 2026-11-16 §5.4).
-- merchant_id NULL = banner platform (admin, langsung disetujui); banner penjual tampil setelah disetujui admin.
CREATE TABLE IF NOT EXISTS banners (
  id           INT          AUTO_INCREMENT PRIMARY KEY,
  merchant_id  INT          NULL,
  title        VARCHAR(80)  NOT NULL,
  image_url    VARCHAR(500) NOT NULL,
  target       ENUM('promo','merchant','none') NOT NULL DEFAULT 'none',  -- tujuan saat diketuk
  promo_id     INT          NULL,
  status       ENUM('menunggu','disetujui','ditolak','nonaktif') NOT NULL DEFAULT 'menunggu',
  catatan      VARCHAR(300) NULL,                                         -- alasan admin (wajib bila ditolak)
  starts_at    DATETIME     NOT NULL,
  ends_at      DATETIME     NOT NULL,
  sort_order   INT          NOT NULL DEFAULT 0,                           -- banner platform: kecil tampil dulu
  created_by   INT          NULL,
  reviewed_by  INT          NULL,
  reviewed_at  DATETIME     NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
  FOREIGN KEY (promo_id)    REFERENCES promos(id)    ON DELETE SET NULL,
  FOREIGN KEY (created_by)  REFERENCES users(id)     ON DELETE SET NULL,
  FOREIGN KEY (reviewed_by) REFERENCES users(id)     ON DELETE SET NULL,
  INDEX idx_banner_tayang (status, starts_at, ends_at),
  INDEX idx_banner_toko (merchant_id, status)
);
