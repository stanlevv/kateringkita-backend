import { RowDataPacket } from "mysql2";
import db from "../config/db";

// Data referensi publik (jenis usaha, kategori, titik ambil, pengaturan)

export async function daftarJenisUsaha() {
  const [rows] = await db.query<RowDataPacket[]>("SELECT id, name FROM merchant_types WHERE is_active ORDER BY sort_order, id");
  return rows;
}

export async function daftarKategori() {
  const [rows] = await db.query<RowDataPacket[]>("SELECT id, name, slug, icon FROM categories WHERE is_active ORDER BY sort_order, id");
  return rows;
}

export async function daftarTitikTemu() {
  const [rows] = await db.query<RowDataPacket[]>("SELECT id, name, description FROM pickup_points WHERE is_active ORDER BY name");
  return rows;
}

export async function ambilPengaturan() {
  const [rows] = await db.query<RowDataPacket[]>("SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('service_fee', 'timezone')");
  const s = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
  return { service_fee: Number(s.service_fee), timezone: s.timezone };
}
