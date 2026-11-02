-- F06 Checkout & holding (C-09, BE-03): tanggal stok hold pesanan + klaim idempotensi POST /orders per pembeli.

-- Tanggal WIB stok yang ditahan pesanan; lepasStok hanya menyentuh penghitung harian menu bila tanggalnya sama (D14).
-- NULL untuk pesanan sebelum F06.
ALTER TABLE orders ADD COLUMN stock_date DATE NULL AFTER hold_until;

-- Klaim Idempotency-Key (D6), di-INSERT pertama di transaksi checkout; request kembar antre di kunci unik ini.
CREATE TABLE order_idempotency (
  customer_id  INT       NOT NULL,
  idem_key     CHAR(36)  NOT NULL,
  request_hash CHAR(64)  NOT NULL,                       -- sha256 body tervalidasi
  order_id     BIGINT    NULL,
  created_at   DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (customer_id, idem_key),
  FOREIGN KEY (customer_id) REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (order_id)    REFERENCES orders(id) ON DELETE CASCADE
);
