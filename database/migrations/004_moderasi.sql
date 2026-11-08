-- F13 ulasan + F19 moderasi admin: ulasan bisa disembunyikan admin (tidak tampil & tidak dihitung rating),
-- menu bisa diturunkan admin (tidak tampil di katalog, penjual tidak bisa mengaktifkannya sendiri).
ALTER TABLE reviews
  ADD COLUMN hidden_at     DATETIME     NULL AFTER comment,
  ADD COLUMN hidden_reason VARCHAR(255) NULL AFTER hidden_at;

ALTER TABLE menus
  ADD COLUMN moderated_at      DATETIME     NULL,
  ADD COLUMN moderation_reason VARCHAR(255) NULL;
