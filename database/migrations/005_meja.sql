-- F21 pesan dari meja: QR di meja → menu tanpa login → bayar online (Midtrans Snap).
-- Pesanan meja tidak punya akun pembeli maupun titik temu. Satu ALTER per pernyataan (TiDB).
CREATE TABLE merchant_tables (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  merchant_id INT          NOT NULL,
  label       VARCHAR(30)  NOT NULL,
  token       CHAR(32)     NOT NULL UNIQUE,           -- isi QR; ganti token = QR lama mati
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_meja_label (merchant_id, label),
  FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
);

ALTER TABLE merchants ADD COLUMN dine_in_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE orders MODIFY customer_id INT NULL;
ALTER TABLE orders MODIFY pickup_point_id INT NULL;
ALTER TABLE orders MODIFY customer_phone VARCHAR(20) NULL;
ALTER TABLE orders MODIFY payment_method ENUM('qris','va','cod','online') NOT NULL;
ALTER TABLE orders ADD COLUMN table_id INT NULL;
ALTER TABLE orders ADD COLUMN guest_token_hash CHAR(64) NULL;   -- SHA-256 token tamu; token asli hanya dipegang peramban tamu
ALTER TABLE orders ADD CONSTRAINT fk_orders_table FOREIGN KEY (table_id) REFERENCES merchant_tables(id) ON DELETE SET NULL;

ALTER TABLE payments MODIFY method ENUM('qris','va','cod','online') NOT NULL;
ALTER TABLE payments ADD COLUMN redirect_url VARCHAR(255) NULL;  -- halaman bayar Snap
