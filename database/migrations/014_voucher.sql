-- Voucher (rancangan 2026-11-16): promo bisa diklaim & ditampilkan di halaman toko, dan satu pesanan boleh memakai
-- satu voucher toko + satu voucher platform. Potongan dicatat terpisah agar pencairan penjual hanya dipotong voucher toko.
-- Satu perubahan per ALTER (TiDB).

-- tampil di halaman toko / daftar voucher & bisa diklaim; FALSE = kode rahasia (tetap bisa diketik)
ALTER TABLE promos ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT TRUE;

-- dompet "Voucher Saya": klaim tidak mengurangi kuota (kuota berkurang saat pesanan dibuat)
CREATE TABLE IF NOT EXISTS promo_claims (
  id          BIGINT   AUTO_INCREMENT PRIMARY KEY,
  promo_id    INT      NOT NULL,
  user_id     INT      NOT NULL,
  claimed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_klaim (promo_id, user_id),
  INDEX idx_klaim_user (user_id, claimed_at),
  FOREIGN KEY (promo_id) REFERENCES promos(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
);

-- discount tetap = merchant_discount + platform_discount; promo_id lama tidak ditulis lagi untuk pesanan baru
ALTER TABLE orders ADD COLUMN merchant_promo_id INT NULL;
ALTER TABLE orders ADD COLUMN merchant_discount INT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN platform_promo_id INT NULL;
ALTER TABLE orders ADD COLUMN platform_discount INT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD CONSTRAINT fk_orders_merchant_promo FOREIGN KEY (merchant_promo_id) REFERENCES promos(id);
ALTER TABLE orders ADD CONSTRAINT fk_orders_platform_promo FOREIGN KEY (platform_promo_id) REFERENCES promos(id);

-- backfill: pesanan lama berpromo tunggal dipindah ke slot menurut pemilik promo
UPDATE orders o JOIN promos p ON p.id = o.promo_id
SET o.merchant_promo_id = IF(p.merchant_id IS NULL, NULL, p.id),
    o.merchant_discount = IF(p.merchant_id IS NULL, 0, o.discount),
    o.platform_promo_id = IF(p.merchant_id IS NULL, p.id, NULL),
    o.platform_discount = IF(p.merchant_id IS NULL, o.discount, 0);
