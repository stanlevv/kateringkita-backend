-- F25 pemakaian AI: satu baris per percobaan ke penyedia (berhasil atau gagal) + token yang dilaporkan penyedia.
-- Tanpa FK ke ai_providers: riwayat tetap ada walau penyedia dihapus (label & model disalin). Disimpan 90 hari.
CREATE TABLE ai_usage (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  provider_id       INT          NULL,                  -- NULL = GEMINI_API_KEY di env
  provider          ENUM('gemini','groq','openrouter','nvidia') NOT NULL,
  label             VARCHAR(60)  NOT NULL,
  model             VARCHAR(120) NOT NULL,
  fitur             VARCHAR(20)  NOT NULL,              -- asisten | rekomendasi | uji
  ok                BOOLEAN      NOT NULL,
  latency_ms        INT          NOT NULL,
  prompt_tokens     INT          NULL,                  -- NULL bila penyedia tidak melaporkan
  completion_tokens INT          NULL,
  total_tokens      INT          NULL,
  error             VARCHAR(255) NULL,
  user_id           INT          NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_aiu_waktu (created_at)
);
