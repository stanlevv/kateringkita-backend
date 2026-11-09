-- F23 log server untuk admin: hanya error 5xx dan request lambat (> 2 dtk), dihapus otomatis setelah 30 hari.
-- Path tanpa query string; tidak menyimpan body, header, atau token.
CREATE TABLE server_logs (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_id  VARCHAR(128) NULL,                  -- sama dengan header X-Request-Id
  level       ENUM('error','slow') NOT NULL,
  method      VARCHAR(10)  NOT NULL,
  path        VARCHAR(255) NOT NULL,
  status      SMALLINT     NOT NULL,
  duration_ms INT          NOT NULL,
  message     VARCHAR(500) NULL,
  user_id     INT          NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_log_waktu (created_at),
  INDEX idx_log_req (request_id)
);
