import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { catat, dalamTransaksi } from "./admin-audit.service";

// F27 mode pemeliharaan: app_settings.maintenance_mode ('0'|'1') + maintenance_message ("" = pesan bawaan)
export type MaintenanceStatus = { aktif: boolean; pesan: string | null };
export const DEFAULT_MAINTENANCE_MSG = "KateringKita sedang dalam pemeliharaan. Silakan coba lagi nanti.";

// shortcut: cache per proses 10 dtk; instance lain ikut berubah paling lambat 10 dtk. Ganti ke pub/sub bila butuh seketika lintas dyno.
let cache: { value: MaintenanceStatus; expiresAt: number } | null = null;

export async function getMaintenance(): Promise<MaintenanceStatus> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('maintenance_mode', 'maintenance_message')",
  );
  const settings = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
  const value = { aktif: settings.maintenance_mode === "1", pesan: settings.maintenance_message || null };
  cache = { value, expiresAt: Date.now() + 10_000 };
  return value;
}

export async function updateMaintenance(
  adminId: number,
  { aktif: active, pesan: message }: { aktif: boolean; pesan: string },
) {
  const savedStatus = await dalamTransaksi(async (conn) => {
    await conn.query(
      "INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('maintenance_mode', '0'), ('maintenance_message', '')",
    );
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('maintenance_mode', 'maintenance_message') FOR UPDATE",
    );
    const settings = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
    const previousStatus = { aktif: settings.maintenance_mode === "1", pesan: settings.maintenance_message || null };
    const newStatus = { aktif: active, pesan: message || null };
    await conn.query("UPDATE app_settings SET setting_value = ? WHERE setting_key = 'maintenance_mode'", [
      active ? "1" : "0",
    ]);
    await conn.query("UPDATE app_settings SET setting_value = ? WHERE setting_key = 'maintenance_message'", [message]);
    await catat(conn, {
      adminId,
      action: "settings.maintenance",
      targetType: "settings",
      targetId: "maintenance",
      before: previousStatus,
      after: newStatus,
    });
    return newStatus;
  });
  cache = null;
  return savedStatus;
}
