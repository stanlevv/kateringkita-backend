-- Token FCM perangkat pembeli untuk notifikasi push (F40). Satu token terikat ke satu sesi login (session_jti);
-- token yang sama dipakai akun lain berarti pindah pemilik (UNIQUE pada token). Dihapus saat pengguna dihapus.
CREATE TABLE push_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  session_jti CHAR(36) NOT NULL,
  token VARCHAR(512) NOT NULL,
  platform ENUM('android','web') NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_push_token (token),
  KEY idx_push_user (user_id),
  KEY idx_push_session (session_jti),
  CONSTRAINT fk_push_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
