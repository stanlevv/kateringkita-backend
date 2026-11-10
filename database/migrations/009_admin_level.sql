-- Fase 1 kelola admin: tingkat admin + wajib ganti sandi untuk akun dengan sandi sementara.
-- super = semua; ops = operasional (tanpa kelola admin, AI, keuangan, server, setelan); support = hanya baca.
-- ALTER dipisah: TiDB menolak beberapa perubahan kolom dalam satu ALTER pada versi lama.
ALTER TABLE users ADD COLUMN admin_level ENUM('super','ops','support') NULL;
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
-- admin yang sudah ada tetap punya akses penuh
UPDATE users SET admin_level = 'super' WHERE role = 'admin';
