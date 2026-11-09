-- F13 ulasan + F19 moderasi admin: ulasan bisa disembunyikan admin (tidak tampil & tidak dihitung rating),
-- menu bisa diturunkan admin (tidak tampil di katalog, penjual tidak bisa mengaktifkannya sendiri).
-- Dua ALTER terpisah: TiDB menolak AFTER ke kolom yang ditambahkan di ALTER yang sama ("Unknown column 'hidden_at'").
ALTER TABLE reviews ADD COLUMN hidden_at DATETIME NULL AFTER comment;
ALTER TABLE reviews ADD COLUMN hidden_reason VARCHAR(255) NULL AFTER hidden_at;

ALTER TABLE menus
  ADD COLUMN moderated_at      DATETIME     NULL,
  ADD COLUMN moderation_reason VARCHAR(255) NULL;
