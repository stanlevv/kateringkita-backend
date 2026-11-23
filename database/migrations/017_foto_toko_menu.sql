-- Background profil toko + foto tambahan menu. image_url tetap foto utama (kartu katalog, moderasi, klien lama).
-- Dua ALTER terpisah (pola 004): aman untuk TiDB.
ALTER TABLE merchants ADD COLUMN cover_url VARCHAR(500) NULL AFTER logo_url;
-- Daftar URL foto tambahan (maks 4, dicek service); NULL = tidak ada
ALTER TABLE menus ADD COLUMN gallery JSON NULL AFTER image_url;
