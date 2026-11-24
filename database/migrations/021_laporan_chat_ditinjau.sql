-- Penanda laporan chat sudah dibuka admin (F34). reviewed_at terisi saat admin pertama kali membuka detail laporan;
-- laporan lama dianggap belum dibuka (NULL). Tanpa indeks: tabelnya kecil.
ALTER TABLE order_chat_reports ADD COLUMN reviewed_at DATETIME NULL;
