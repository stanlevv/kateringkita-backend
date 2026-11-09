-- F22 AI gateway: penyedia AI dikelola admin, dicoba berurutan (prioritas kecil dulu) dengan fallback otomatis.
-- API key disimpan terenkripsi (AES-256-GCM, kunci turunan JWT_SECRET); dashboard hanya melihat 4 karakter terakhir.
CREATE TABLE ai_providers (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  provider       ENUM('gemini','groq','openrouter','nvidia') NOT NULL,  -- alamat API dikunci di kode per jenis
  label          VARCHAR(60)  NOT NULL,
  model          VARCHAR(120) NOT NULL,
  api_key_enc    TEXT         NOT NULL,
  key_hint       VARCHAR(4)   NOT NULL,
  priority       INT          NOT NULL DEFAULT 100,
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  last_ok_at     DATETIME     NULL,
  last_error     VARCHAR(255) NULL,
  last_error_at  DATETIME     NULL,
  cooldown_until DATETIME     NULL,                  -- dilewati gateway sampai waktu ini (kuota habis / error)
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ai_urut (is_active, priority)
);
