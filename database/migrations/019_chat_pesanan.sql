-- Chat pembeli ↔ penjual untuk satu pesanan (koordinasi titik temu dan pengambilan makanan), penanda baca per pihak,
-- dan laporan chat ke admin. Hanya tabel baru, data lama tidak disentuh. IF NOT EXISTS: aman bila dijalankan ulang
-- (TiDB). order_id BIGINT = tipe orders.id.

-- Isi chat. TiDB membagikan blok id per node sehingga id bisa tidak berurutan menurut waktu kirim, dan cek berkala
-- `id > after_id` lalu bisa melewatkan pesan. AUTO_ID_CACHE=1 membuat id berurutan; MySQL mengabaikan opsi /*T! */.
CREATE TABLE IF NOT EXISTS order_messages (
  id             BIGINT       AUTO_INCREMENT PRIMARY KEY,
  order_id       BIGINT       NOT NULL,
  sender_role    ENUM('customer','merchant') NOT NULL,
  sender_user_id INT          NULL,                                   -- akun pengirim; NULL bila akunnya dihapus
  body           TEXT         NULL,                                   -- boleh kosong bila pesan berisi foto
  image_url      VARCHAR(500) NULL,                                   -- foto di folder orders/<order_id>/chat/
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_chat_pesanan (order_id, id),                              -- cek berkala "sesudah id terakhir"; indeks FK
  INDEX idx_chat_pengirim (sender_user_id),                           -- indeks FK
  FOREIGN KEY (order_id)       REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_user_id) REFERENCES users(id)  ON DELETE SET NULL
)
/*T![auto_id_cache] AUTO_ID_CACHE=1 */;

-- Pesan terakhir yang sudah dibaca tiap pihak. Pesan pihak lawan dengan id lebih besar = belum dibaca.
CREATE TABLE IF NOT EXISTS order_chat_reads (
  order_id             BIGINT   NOT NULL,
  reader_role          ENUM('customer','merchant') NOT NULL,
  last_read_message_id BIGINT   NOT NULL,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (order_id, reader_role),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

-- Laporan chat ke admin: satu laporan per pihak per pesanan. Admin hanya boleh membaca chat yang dilaporkan.
CREATE TABLE IF NOT EXISTS order_chat_reports (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  order_id         BIGINT       NOT NULL,
  reporter_role    ENUM('customer','merchant') NOT NULL,
  reporter_user_id INT          NULL,
  reason           VARCHAR(500) NOT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_laporan_pihak (order_id, reporter_role),              -- juga indeks FK order_id
  INDEX idx_laporan_pelapor (reporter_user_id),                       -- indeks FK
  FOREIGN KEY (order_id)         REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (reporter_user_id) REFERENCES users(id)  ON DELETE SET NULL
);
