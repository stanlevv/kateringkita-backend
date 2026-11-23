import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { dalamTransaksi } from "./admin-audit.service";
import { AppError } from "../utils/errors";
import { validateImageUrl } from "./upload.service";
import { UpdateProfileInput } from "../dto/merchant.dto";

export async function getProfile(userId: number) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT m.id, m.business_name, m.description, m.address, m.wa_number, m.logo_url, m.cover_url, m.service_mode, m.is_open,
            TIME_FORMAT(m.open_time, '%H:%i') AS open_time, TIME_FORMAT(m.close_time, '%H:%i') AS close_time,
            m.hold_minutes, m.daily_revenue_target, m.wa_template, m.dine_in_enabled, t.id AS type_id, t.name AS type_name
     FROM merchants m JOIN merchant_types t ON t.id = m.merchant_type_id WHERE m.user_id = ?`,
    [userId],
  );
  const merchant = rows[0];
  if (!merchant) throw new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");
  const [pickupPoints] = await db.query<RowDataPacket[]>(
    `SELECT mp.pickup_point_id AS id FROM merchant_pickup_points mp JOIN pickup_points p ON p.id = mp.pickup_point_id
     WHERE mp.merchant_id = ? AND p.is_active ORDER BY mp.pickup_point_id`,
    [merchant.id],
  );
  return {
    business_name: merchant.business_name,
    description: merchant.description,
    address: merchant.address,
    wa_number: merchant.wa_number,
    logo_url: merchant.logo_url,
    cover_url: merchant.cover_url,
    merchant_type: { id: merchant.type_id, name: merchant.type_name },
    service_mode: merchant.service_mode,
    is_open: Boolean(merchant.is_open),
    open_time: merchant.open_time,
    close_time: merchant.close_time,
    hold_minutes: merchant.hold_minutes,
    daily_revenue_target: merchant.daily_revenue_target,
    wa_template: merchant.wa_template,
    pickup_point_ids: pickupPoints.map((point) => point.id as number),
    // F21: pesan dari meja (QR)
    dine_in_enabled: Boolean(merchant.dine_in_enabled),
  };
}

// updated_at sengaja tidak digeser: buka/tutup dapur bukan perbaikan data (D9)
export async function setOpen(userId: number, isOpen: boolean): Promise<{ is_open: boolean }> {
  const [result] = await db.query<any>("UPDATE merchants SET is_open = ?, updated_at = updated_at WHERE user_id = ?", [
    isOpen,
    userId,
  ]);
  if (result.affectedRows === 0) throw new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");
  return { is_open: isOpen };
}

const validationError = (fields: Record<string, string[]>) =>
  new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", fields);
const PROFILE_COLUMNS = [
  "business_name",
  "description",
  "address",
  "wa_number",
  "service_mode",
  "open_time",
  "close_time",
  "hold_minutes",
  "daily_revenue_target",
  "wa_template",
  "logo_url",
  "cover_url",
] as const;

export async function updateProfile(userId: number, input: UpdateProfileInput) {
  const columnValues: Record<string, string | number | null> = {};
  for (const column of PROFILE_COLUMNS) if (input[column] !== undefined) columnValues[column] = input[column];
  if (input.dine_in_enabled !== undefined) columnValues.dine_in_enabled = input.dine_in_enabled ? 1 : 0;
  if (columnValues.description === "") columnValues.description = null;
  const pickupPointIds =
    input.pickup_point_ids === undefined
      ? undefined
      : [...new Set(input.pickup_point_ids)].sort((first, second) => first - second);
  if (Object.keys(columnValues).length === 0 && !pickupPointIds)
    throw new AppError(400, "VALIDATION_ERROR", "Tidak ada data yang diubah.");

  await dalamTransaksi(async (conn) => {
    let pickupPointsChanged = false;
    // urutan kunci: toko lalu titik temu (sama dengan cekTitikTemuTerakhir admin)
    const [merchantRows] = await conn.query<RowDataPacket[]>(
      "SELECT id, TIME_FORMAT(open_time, '%H:%i') AS o, TIME_FORMAT(close_time, '%H:%i') AS c, logo_url, cover_url FROM merchants WHERE user_id = ? FOR UPDATE",
      [userId],
    );
    const merchant = merchantRows[0];
    if (!merchant) throw new AppError(404, "NOT_FOUND", "Toko tidak ditemukan.");
    validateImageUrl(input.logo_url, merchant.logo_url, `merchants/${merchant.id}/logo/`, "logo_url");
    validateImageUrl(input.cover_url, merchant.cover_url, `merchants/${merchant.id}/cover/`, "cover_url");
    // jam tutup harus setelah jam buka; yang tidak dikirim dibandingkan dengan nilai tersimpan
    if (
      (input.open_time !== undefined || input.close_time !== undefined) &&
      (input.close_time ?? merchant.c) <= (input.open_time ?? merchant.o)
    ) {
      throw validationError({ close_time: ["Jam tutup harus setelah jam buka."] });
    }
    if (pickupPointIds) {
      // FOR UPDATE, bukan FOR SHARE: TiDB (production) menolak FOR SHARE (ER_NOT_SUPPORTED_YET)
      const [activePoints] = await conn.query<RowDataPacket[]>(
        "SELECT id FROM pickup_points WHERE id IN (?) AND is_active FOR UPDATE",
        [pickupPointIds],
      );
      if (activePoints.length !== pickupPointIds.length)
        throw validationError({ pickup_point_ids: ["Titik temu tidak tersedia."] });
      const [savedPoints] = await conn.query<RowDataPacket[]>(
        "SELECT pickup_point_id AS id FROM merchant_pickup_points WHERE merchant_id = ? ORDER BY 1",
        [merchant.id],
      );
      // hanya selisih yang ditulis: DELETE/INSERT seluruh set antar-penjual bisa deadlock lewat gap lock
      const savedIds = new Set<number>(savedPoints.map((point) => point.id));
      const removedIds = [...savedIds].filter((id) => !pickupPointIds.includes(id));
      const addedIds = pickupPointIds.filter((id) => !savedIds.has(id));
      pickupPointsChanged = removedIds.length > 0 || addedIds.length > 0;
      if (removedIds.length)
        await conn.query("DELETE FROM merchant_pickup_points WHERE merchant_id = ? AND pickup_point_id IN (?)", [
          merchant.id,
          removedIds,
        ]);
      if (addedIds.length)
        await conn.query("INSERT INTO merchant_pickup_points (merchant_id, pickup_point_id) VALUES ?", [
          addedIds.map((id) => [merchant.id, id]),
        ]);
    }
    const columns = Object.keys(columnValues);
    // updated_at otomatis bergeser saat kolom berubah; titik temu tanpa perubahan kolom digeser eksplisit (D9)
    const assignments = [
      ...columns.map((column) => `${column} = ?`),
      ...(pickupPointsChanged ? ["updated_at = CURRENT_TIMESTAMP"] : []),
    ];
    if (assignments.length > 0)
      await conn.query(`UPDATE merchants SET ${assignments.join(", ")} WHERE id = ?`, [
        ...columns.map((column) => columnValues[column]),
        merchant.id,
      ]);
  });
  return getProfile(userId);
}
