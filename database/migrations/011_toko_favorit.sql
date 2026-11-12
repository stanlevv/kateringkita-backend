-- F05 favorit toko ("Dapur Favorit" di aplikasi pembeli): padanan tabel favorites untuk toko.
-- Hanya tabel baru, data lama tidak disentuh. IF NOT EXISTS: aman bila dijalankan ulang (TiDB).
-- Baris milik toko yang tersembunyi tidak dihapus (D13); ikut terhapus bila pengguna/toko dihapus, sama dengan favorites.
CREATE TABLE IF NOT EXISTS merchant_favorites (
  user_id     INT      NOT NULL,
  merchant_id INT      NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, merchant_id),
  INDEX idx_mfav_terbaru (user_id, created_at),          -- GET /me/favorite-merchants: terbaru dulu
  INDEX idx_mfav_toko (merchant_id),                     -- indeks FK; juga untuk mencari pemfavorit satu toko
  FOREIGN KEY (user_id)     REFERENCES users(id)     ON DELETE CASCADE,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
);
