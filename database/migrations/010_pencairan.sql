-- F26 pencairan dana: semua pembayaran non-tunai lewat Midtrans (masuk akun platform), lalu admin mentransfer bagian
-- penjual ke rekening toko dan mencatatnya di sini. QRIS statis toko (verifikasi manual) dihapus; kolom qris_image_url
-- dibiarkan agar data lama tidak hilang. Satu ALTER per pernyataan (TiDB).
ALTER TABLE merchants ADD COLUMN payout_bank VARCHAR(20) NULL;            -- kode bank/e-wallet (BANK_PENCAIRAN)
ALTER TABLE merchants ADD COLUMN payout_account_number VARCHAR(30) NULL;
ALTER TABLE merchants ADD COLUMN payout_account_name VARCHAR(100) NULL;
ALTER TABLE merchants ADD COLUMN payout_updated_at DATETIME NULL;        -- admin melihat rekening yang baru diganti

CREATE TABLE payouts (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  merchant_id     INT          NOT NULL,
  amount          INT          NOT NULL,
  orders_count    INT          NOT NULL,
  bank            VARCHAR(20)  NOT NULL,                 -- salinan rekening saat dicairkan
  account_number  VARCHAR(30)  NOT NULL,
  account_name    VARCHAR(100) NOT NULL,
  reference       VARCHAR(100) NOT NULL,                 -- nomor referensi transfer dari bank admin
  note            VARCHAR(255) NULL,
  admin_user_id   INT          NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_payouts_waktu (created_at)
);

ALTER TABLE orders ADD COLUMN payout_id BIGINT NULL;                      -- terisi saat bagian penjual sudah dicairkan

ALTER TABLE payments ADD COLUMN refunded_at DATETIME NULL;                -- dana Midtrans pesanan batal dikembalikan admin
ALTER TABLE payments ADD COLUMN refund_ref VARCHAR(100) NULL;
