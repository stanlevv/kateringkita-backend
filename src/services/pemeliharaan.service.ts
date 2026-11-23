import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { catat, dalamTransaksi } from "./admin-audit.service";

// F27 mode pemeliharaan: app_settings.maintenance_mode ('0'|'1') + maintenance_message ("" = pesan bawaan)
export type Pemeliharaan = { aktif: boolean; pesan: string | null };
export const PESAN_BAWAAN = "KateringKita sedang dalam pemeliharaan. Silakan coba lagi nanti.";

// shortcut: cache per proses 10 dtk; instance lain ikut berubah paling lambat 10 dtk. Ganti ke pub/sub bila butuh seketika lintas dyno.
let cache: { nilai: Pemeliharaan; sampai: number } | null = null;

export async function ambilPemeliharaan(): Promise<Pemeliharaan> {
  if (cache && cache.sampai > Date.now()) return cache.nilai;
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('maintenance_mode', 'maintenance_message')",
  );
  const s = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
  const nilai = { aktif: s.maintenance_mode === "1", pesan: s.maintenance_message || null };
  cache = { nilai, sampai: Date.now() + 10_000 };
  return nilai;
}

export async function ubahPemeliharaan(adminId: number, { aktif, pesan }: { aktif: boolean; pesan: string }) {
  const nilai = await dalamTransaksi(async (conn) => {
    await conn.query(
      "INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('maintenance_mode', '0'), ('maintenance_message', '')",
    );
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('maintenance_mode', 'maintenance_message') FOR UPDATE",
    );
    const s = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
    const lama = { aktif: s.maintenance_mode === "1", pesan: s.maintenance_message || null };
    const baru = { aktif, pesan: pesan || null };
    await conn.query("UPDATE app_settings SET setting_value = ? WHERE setting_key = 'maintenance_mode'", [
      aktif ? "1" : "0",
    ]);
    await conn.query("UPDATE app_settings SET setting_value = ? WHERE setting_key = 'maintenance_message'", [pesan]);
    await catat(conn, {
      adminId,
      action: "settings.maintenance",
      targetType: "settings",
      targetId: "maintenance",
      before: lama,
      after: baru,
    });
    return baru;
  });
  cache = null;
  return nilai;
}
