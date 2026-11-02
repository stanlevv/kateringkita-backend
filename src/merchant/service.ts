import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { dalamTransaksi } from "../admin/audit";
import { AppError } from "../http/errors";
import { cekUrlGambar } from "../upload/service";
import { UpdateProfileInput } from "./schemas";

export async function getProfile(userId: number) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.id, m.business_name, m.description, m.address, m.wa_number, m.logo_url, m.service_mode, m.is_open,
            TIME_FORMAT(m.open_time, '%H:%i') AS open_time, TIME_FORMAT(m.close_time, '%H:%i') AS close_time,
            m.hold_minutes, m.daily_revenue_target, m.qris_image_url, m.wa_template, t.id AS type_id, t.name AS type_name
     FROM merchants m JOIN merchant_types t ON t.id = m.merchant_type_id WHERE m.user_id = ?`,
    [userId],
  );
  const m = rows[0];
  if (!m) throw new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");
  const [pts] = await db.query<RowDataPacket[]>(
    `SELECT mp.pickup_point_id AS id FROM merchant_pickup_points mp JOIN pickup_points p ON p.id = mp.pickup_point_id
     WHERE mp.merchant_id = ? AND p.is_active ORDER BY mp.pickup_point_id`,
    [m.id],
  );
  return {
    business_name: m.business_name,
    description: m.description,
    address: m.address,
    wa_number: m.wa_number,
    logo_url: m.logo_url,
    merchant_type: { id: m.type_id, name: m.type_name },
    service_mode: m.service_mode,
    is_open: Boolean(m.is_open),
    open_time: m.open_time,
    close_time: m.close_time,
    hold_minutes: m.hold_minutes,
    daily_revenue_target: m.daily_revenue_target,
    qris_image_url: m.qris_image_url,
    wa_template: m.wa_template,
    pickup_point_ids: pts.map((p) => p.id as number),
  };
}

// updated_at sengaja tidak digeser: buka/tutup dapur bukan perbaikan data (D9)
export async function setOpen(userId: number, isOpen: boolean): Promise<{ is_open: boolean }> {
  const [r] = await db.query<any>("UPDATE merchants SET is_open = ?, updated_at = updated_at WHERE user_id = ?", [isOpen, userId]);
  if (r.affectedRows === 0) throw new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");
  return { is_open: isOpen };
}

const invalid = (fields: Record<string, string[]>) => new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", fields);
const COLUMNS = ["business_name", "description", "address", "wa_number", "service_mode", "open_time", "close_time", "hold_minutes", "daily_revenue_target", "wa_template", "logo_url", "qris_image_url"] as const;

export async function updateProfile(userId: number, input: UpdateProfileInput) {
  const sets: Record<string, string | number | null> = {};
  for (const c of COLUMNS) if (input[c] !== undefined) sets[c] = input[c];
  if (sets.description === "") sets.description = null;
  const ids = input.pickup_point_ids === undefined ? undefined : [...new Set(input.pickup_point_ids)].sort((a, b) => a - b);
  if (Object.keys(sets).length === 0 && !ids) throw new AppError(400, "VALIDATION_ERROR", "Tidak ada data yang diubah.");

  await dalamTransaksi(async (conn) => {
    let berubah = false;
    // urutan kunci: toko lalu titik temu (sama dengan cekTitikTemuTerakhir admin)
    const [r] = await conn.query<RowDataPacket[]>(
      "SELECT id, TIME_FORMAT(open_time, '%H:%i') AS o, TIME_FORMAT(close_time, '%H:%i') AS c, logo_url, qris_image_url FROM merchants WHERE user_id = ? FOR UPDATE",
      [userId],
    );
    const m = r[0];
    if (!m) throw new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");
    cekUrlGambar(input.logo_url, m.logo_url, `merchants/${m.id}/logo/`, "logo_url");
    cekUrlGambar(input.qris_image_url, m.qris_image_url, `merchants/${m.id}/qris/`, "qris_image_url");
    // jam tutup harus setelah jam buka; yang tidak dikirim dibandingkan dengan nilai tersimpan
    if ((input.open_time !== undefined || input.close_time !== undefined) && (input.close_time ?? m.c) <= (input.open_time ?? m.o)) {
      throw invalid({ close_time: ["Jam tutup harus setelah jam buka."] });
    }
    if (ids) {
      const [ok] = await conn.query<RowDataPacket[]>("SELECT id FROM pickup_points WHERE id IN (?) AND is_active FOR SHARE", [ids]);
      if (ok.length !== ids.length) throw invalid({ pickup_point_ids: ["Titik temu tidak tersedia."] });
      const [lama] = await conn.query<RowDataPacket[]>("SELECT pickup_point_id AS id FROM merchant_pickup_points WHERE merchant_id = ? ORDER BY 1", [m.id]);
      // hanya selisih yang ditulis: DELETE/INSERT seluruh set antar-penjual bisa deadlock lewat gap lock
      const ada = new Set<number>(lama.map((l) => l.id));
      const buang = [...ada].filter((id) => !ids.includes(id));
      const tambah = ids.filter((id) => !ada.has(id));
      berubah = buang.length > 0 || tambah.length > 0;
      if (buang.length) await conn.query("DELETE FROM merchant_pickup_points WHERE merchant_id = ? AND pickup_point_id IN (?)", [m.id, buang]);
      if (tambah.length) await conn.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES ?", [tambah.map((id) => [m.id, id])]);
    }
    const cols = Object.keys(sets);
    // updated_at otomatis bergeser saat kolom berubah; titik temu tanpa perubahan kolom digeser eksplisit (D9)
    const set = [...cols.map((c) => `${c} = ?`), ...(berubah ? ["updated_at = CURRENT_TIMESTAMP"] : [])];
    if (set.length > 0) await conn.query(`UPDATE merchants SET ${set.join(", ")} WHERE id = ?`, [...cols.map((c) => sets[c]), m.id]);
  });
  return getProfile(userId);
}
