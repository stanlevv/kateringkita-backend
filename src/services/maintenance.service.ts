// Isi file: baca dan ubah status mode pemeliharaan. Mode pemeliharaan = saklar admin untuk menutup sementara aplikasi:
// selama menyala, hampir semua request dijawab 503 oleh middleware/maintenance.ts. Status disimpan di tabel
// app_settings (`maintenance_mode` berisi '0' atau '1', `maintenance_message` berisi pesan; kosong = pesan bawaan).
// Dibaca middleware/maintenance.ts, meta.service, dan admin.handler; diubah lewat admin.handler → file ini → database.
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { recordAudit, withTransaction } from "./admin-audit.service";

/**
 * Status mode pemeliharaan. Nama kuncinya (`aktif`, `pesan`) ikut terkirim apa adanya di JSON respons meta dan admin.
 * `aktif` = mode sedang menyala; `pesan` = pesan dari admin, atau null bila admin tidak mengisinya.
 */
export type MaintenanceStatus = { aktif: boolean; pesan: string | null };
/** Pesan 503 yang dipakai bila admin menyalakan mode pemeliharaan tanpa mengisi pesan. */
export const DEFAULT_MAINTENANCE_MSG = "KateringKita sedang dalam pemeliharaan. Silakan coba lagi nanti.";

// shortcut: cache per proses 10 dtk; instance lain ikut berubah paling lambat 10 dtk.
// Ganti ke pub/sub bila butuh seketika lintas dyno.
// Cache = salinan status di memori supaya tidak setiap request membaca database. `expiresAt` = waktu (milidetik)
// salinan ini kedaluwarsa.
let cache: { value: MaintenanceStatus; expiresAt: number } | null = null;

/**
 * Membaca status mode pemeliharaan. Hasilnya disimpan di cache selama 10 detik, jadi perubahan dari server lain baru
 * terlihat paling lambat 10 detik kemudian.
 * @returns status pemeliharaan; bila baris pengaturan belum ada, dianggap mati dan tanpa pesan
 */
export async function getMaintenance(): Promise<MaintenanceStatus> {
  // 1. Pakai salinan di cache bila belum kedaluwarsa.
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  // 2. Baca dua baris pengaturan, lalu ubah jadi objek `{ setting_key: setting_value }`.
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('maintenance_mode', 'maintenance_message')",
  );
  const settings = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
  // 3. Hanya '1' yang berarti menyala; pesan kosong diubah jadi null.
  const value = { aktif: settings.maintenance_mode === "1", pesan: settings.maintenance_message || null };
  // 4. Simpan ke cache selama 10 detik.
  cache = { value, expiresAt: Date.now() + 10_000 };
  return value;
}

/**
 * Menyalakan atau mematikan mode pemeliharaan dan menyimpan pesannya. Hanya dipanggil dari route admin
 * (PUT /admin/settings/maintenance), dan setiap perubahan dicatat di log audit admin.
 * Semua langkah berjalan dalam satu transaksi DB: rangkaian perubahan yang disimpan semua atau dibatalkan semua.
 * @param adminId id admin yang mengubah, untuk log audit
 * @param status  isi body yang sudah diperiksa: `aktif` (nyala atau mati) dan `pesan` (boleh kosong, maks 200 huruf)
 * @returns status baru; pesan kosong dikembalikan sebagai null
 */
export async function updateMaintenance(
  adminId: number,
  { aktif: active, pesan: message }: { aktif: boolean; pesan: string },
) {
  const savedStatus = await withTransaction(async (conn) => {
    // 1. Pastikan dua baris pengaturan ada (INSERT IGNORE = sisipkan bila belum ada, abaikan bila sudah ada).
    await conn.query(
      "INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('maintenance_mode', '0'), ('maintenance_message', '')",
    );
    // 2. Baca status lama sambil mengunci barisnya (FOR UPDATE), supaya dua admin yang mengubah bersamaan bergantian.
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('maintenance_mode', 'maintenance_message') FOR UPDATE",
    );
    const settings = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
    const previousStatus = { aktif: settings.maintenance_mode === "1", pesan: settings.maintenance_message || null };
    const newStatus = { aktif: active, pesan: message || null };
    // 3. Tulis status baru.
    await conn.query("UPDATE app_settings SET setting_value = ? WHERE setting_key = 'maintenance_mode'", [
      active ? "1" : "0",
    ]);
    await conn.query("UPDATE app_settings SET setting_value = ? WHERE setting_key = 'maintenance_message'", [message]);
    // 4. Catat status sebelum dan sesudah di log audit admin, di transaksi yang sama.
    await recordAudit(conn, {
      adminId,
      action: "settings.maintenance",
      targetType: "settings",
      targetId: "maintenance",
      before: previousStatus,
      after: newStatus,
    });
    return newStatus;
  });
  // 5. Kosongkan cache server ini supaya status baru langsung terbaca di sini.
  cache = null;
  return savedStatus;
}
