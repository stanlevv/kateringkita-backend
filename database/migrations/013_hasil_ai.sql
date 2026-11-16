-- Rubrik AI: keluaran AI yang lolos validasi skema disimpan, lalu diverifikasi manual admin di web.
-- input_text = pertanyaan pengguna SETELAH disamarkan (email/nomor/NIK/nama → penanda), jadi tabel ini tidak menyimpan data pribadi mentah.
CREATE TABLE ai_results (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  fitur        ENUM('asisten','rekomendasi') NOT NULL,
  user_id      INT          NULL,
  merchant_id  INT          NULL,                    -- toko pemilik pertanyaan (asisten); NULL untuk rekomendasi pembeli
  input_text   VARCHAR(600) NOT NULL,
  output_json  JSON         NOT NULL,                -- keluaran AI yang lolos validasi zod
  status       ENUM('menunggu','disetujui','ditolak') NOT NULL DEFAULT 'menunggu',
  catatan      VARCHAR(300) NULL,                    -- alasan admin (wajib bila ditolak)
  verified_by  INT          NULL,
  verified_at  DATETIME     NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)     REFERENCES users(id)     ON DELETE SET NULL,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE SET NULL,
  FOREIGN KEY (verified_by) REFERENCES users(id)     ON DELETE SET NULL,
  INDEX idx_air_status (status, created_at),
  INDEX idx_air_fitur (fitur, created_at)
);
