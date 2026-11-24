-- Verifikasi email dengan kode OTP. NULL = email belum diverifikasi (akun lama dan akun baru).
ALTER TABLE users ADD COLUMN email_verified_at DATETIME NULL AFTER email;

-- Kode OTP verifikasi/ganti email. `email` = alamat tujuan kode; bila beda dengan users.email, verifikasi berhasil
-- sekaligus mengganti email akun. Kode disimpan sebagai hash bcrypt, berlaku 10 menit, maks 5 percobaan.
CREATE TABLE email_verifications (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT          NOT NULL,
  email       VARCHAR(150) NOT NULL,
  code_hash   VARCHAR(255) NOT NULL,
  attempts    TINYINT      NOT NULL DEFAULT 0,
  expires_at  DATETIME     NOT NULL,
  used_at     DATETIME     NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_email_verif_user (user_id, created_at)
);
