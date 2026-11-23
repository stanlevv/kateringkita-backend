// Isi file: data referensi publik yang dibaca aplikasi tanpa login, yaitu jenis usaha, kategori menu, titik temu, dan
// pengaturan umum. Alurnya routes/meta.ts → handlers/meta.handler.ts → file ini → database.
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { ambilPemeliharaan } from "./pemeliharaan.service";

/**
 * Daftar jenis usaha yang masih aktif, untuk pilihan saat penjual mendaftar.
 * @returns baris `{ id, name }`, diurutkan menurut urutan tampil lalu id
 */
export async function listMerchantTypes() {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, name FROM merchant_types WHERE is_active ORDER BY sort_order, id",
  );
  return rows;
}

/**
 * Daftar kategori menu yang masih aktif.
 * @returns baris `{ id, name, slug, icon }`, diurutkan menurut urutan tampil lalu id
 */
export async function listCategories() {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, name, slug, icon FROM categories WHERE is_active ORDER BY sort_order, id",
  );
  return rows;
}

/**
 * Daftar titik temu (tempat pembeli mengambil pesanan) yang masih aktif.
 * @returns baris `{ id, name, description }`, diurutkan menurut nama
 */
export async function listPickupPoints() {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, name, description FROM pickup_points WHERE is_active ORDER BY name",
  );
  return rows;
}

/**
 * Pengaturan umum yang boleh dibaca semua orang. Nilainya disimpan di tabel app_settings sebagai pasangan kunci-nilai
 * (`setting_key`, `setting_value`), dan hanya tiga kunci yang dibaca di sini.
 * @returns biaya layanan (angka), zona waktu, nomor WhatsApp layanan pelanggan (`null` bila kosong), dan status mode
 *          pemeliharaan `{ aktif, pesan }` dari pemeliharaan.service
 */
export async function getSettings() {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('service_fee', 'timezone', 'cs_whatsapp')",
  );
  const settings = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
  return {
    service_fee: Number(settings.service_fee),
    timezone: settings.timezone,
    cs_whatsapp: settings.cs_whatsapp || null,
    maintenance: await ambilPemeliharaan(),
  };
}
