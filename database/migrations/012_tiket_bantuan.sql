-- Tiket bantuan (CS) dua arah pembeli ↔ tim admin, menggantikan nomor WhatsApp CS di aplikasi. Urusan pesanan
-- (menu, waktu ambil, pesanan belum siap) tetap langsung ke penjual lewat WhatsApp.
-- Hanya tabel baru, data lama tidak disentuh. IF NOT EXISTS: aman bila dijalankan ulang (TiDB).
CREATE TABLE IF NOT EXISTS support_tickets (
  id                    INT          AUTO_INCREMENT PRIMARY KEY,
  code                  VARCHAR(20)  NOT NULL UNIQUE,                 -- TK-YYYYMMDD-XXXX (tanggal WIB)
  user_id               INT          NOT NULL,                        -- pembeli pembuat tiket
  order_id              BIGINT       NULL,                            -- pesanan terkait (opsional); BIGINT = tipe orders.id
  category              ENUM('akun','pembayaran','pesanan','penjual','aplikasi','lainnya') NOT NULL,
  subject               VARCHAR(120) NOT NULL,
  status                ENUM('open','answered','closed') NOT NULL DEFAULT 'open', -- open = menunggu admin, answered = menunggu pembeli
  last_message_at       DATETIME     NOT NULL,
  customer_last_read_at DATETIME     NULL,                            -- pesan admin sesudah waktu ini = belum dibaca pembeli
  closed_at             DATETIME     NULL,
  closed_by             ENUM('customer','admin') NULL,
  created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tiket_pembeli (user_id, last_message_at),                -- GET /me/tickets: terbaru dulu; juga indeks FK user_id
  INDEX idx_tiket_status (status, last_message_at),                  -- GET /admin/tickets?status=: antrean open terlama dulu
  INDEX idx_tiket_pesanan (order_id),                                -- indeks FK
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id             BIGINT   AUTO_INCREMENT PRIMARY KEY,
  ticket_id      INT      NOT NULL,
  sender_role    ENUM('customer','admin') NOT NULL,
  sender_user_id INT      NULL,                                       -- nama admin asli hanya tampil di dashboard admin
  body           TEXT     NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pesan_tiket (ticket_id, id),                              -- percakapan satu tiket; juga indeks FK ticket_id
  INDEX idx_pesan_pengirim (sender_user_id),                          -- indeks FK
  FOREIGN KEY (ticket_id)      REFERENCES support_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_user_id) REFERENCES users(id)           ON DELETE SET NULL
);
