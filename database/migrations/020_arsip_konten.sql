-- Arsip konten admin (F33): promo platform, banner, dan pop-up tidak dihapus, hanya diberi waktu arsip. Baris yang
-- archived_at-nya terisi tidak tampil di aplikasi dan promonya tidak bisa dipakai, tetapi riwayat pesanan, pemakaian
-- promo, dan klaim voucher tetap utuh. Satu perubahan per ALTER (TiDB).
ALTER TABLE promos ADD COLUMN archived_at DATETIME NULL;
ALTER TABLE banners ADD COLUMN archived_at DATETIME NULL;
ALTER TABLE popups ADD COLUMN archived_at DATETIME NULL;

-- query tayang publik: yang belum diarsipkan, lalu status dan masa tayang
ALTER TABLE banners ADD INDEX idx_banner_tayang_arsip (archived_at, status, starts_at);
ALTER TABLE popups ADD INDEX idx_popup_tayang_arsip (archived_at, is_active, starts_at);
