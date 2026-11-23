import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { ambilPemeliharaan } from "./pemeliharaan.service";

// Data referensi publik (jenis usaha, kategori, titik ambil, pengaturan)

export async function listMerchantTypes() {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, name FROM merchant_types WHERE is_active ORDER BY sort_order, id",
  );
  return rows;
}

export async function listCategories() {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, name, slug, icon FROM categories WHERE is_active ORDER BY sort_order, id",
  );
  return rows;
}

export async function listPickupPoints() {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, name, description FROM pickup_points WHERE is_active ORDER BY name",
  );
  return rows;
}

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
