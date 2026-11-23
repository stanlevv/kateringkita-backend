import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { PopupInput, UpdatePopupInput, popupSchema, updatePopupSchema } from "../dto/popup.dto";
import { AppError } from "../utils/errors";
import { catat, dalamTransaksi, kunci } from "./admin-audit.service";
import { parseBodyWithImage } from "./banner.service";
import { clock } from "./catalog.service";
import { VoucherCard, getAvailableVoucher } from "./voucher.service";

// Pop-up promo saat aplikasi mobile dibuka (rancangan voucher 2026-11-16 §5.5). Hanya admin. Yang tayang = aktif terbaru
// dalam periode yang vouchernya (bila ada) masih tersedia. Frekuensi tampil (sekali sehari, berhenti setelah diklaim) di aplikasi.
const POPUP_PREFIX = "platform/popup/";

const POPUP_COLUMNS =
  "q.id, q.title, q.image_url, q.promo_id, q.starts_at, q.ends_at, q.is_active, q.created_at, p.code AS promo_code";
const POPUP_FROM_SQL = "popups q LEFT JOIN promos p ON p.id = q.promo_id";

const mapPopup = (row: RowDataPacket) => ({
  id: row.id as number,
  title: row.title as string,
  image_url: row.image_url as string,
  promo: row.promo_id ? { id: row.promo_id as number, code: row.promo_code as string } : null,
  starts_at: row.starts_at,
  ends_at: row.ends_at,
  is_active: Boolean(row.is_active),
  created_at: row.created_at,
});
const loadPopup = async (id: number) =>
  mapPopup(
    (await db.query<RowDataPacket[]>(`SELECT ${POPUP_COLUMNS} FROM ${POPUP_FROM_SQL} WHERE q.id = ?`, [id]))[0][0],
  );

export type PublicPopup = { id: number; title: string; image_url: string; promo: VoucherCard | null };

export async function getPublicPopup(userId: number | null): Promise<PublicPopup | null> {
  const nowMs = clock.now();
  const now = new Date(nowMs);
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, title, image_url, promo_id FROM popups WHERE is_active AND starts_at <= ? AND ends_at > ? ORDER BY id DESC LIMIT 5",
    [now, now],
  );
  for (const row of rows) {
    const promo = row.promo_id ? await getAvailableVoucher(row.promo_id, userId, nowMs) : null;
    if (row.promo_id && !promo) continue; // voucher mati / habis periode → pop-up berikutnya
    return { id: row.id, title: row.title, image_url: row.image_url, promo };
  }
  return null;
}

async function validatePlatformVoucher(promoId: number | null | undefined) {
  if (!promoId) return null;
  const [[promo]] = await db.query<RowDataPacket[]>("SELECT id FROM promos WHERE id = ? AND merchant_id IS NULL", [
    promoId,
  ]);
  if (!promo)
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { promo_id: ["Pilih voucher platform."] });
  return promoId;
}

export async function listPopups() {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${POPUP_COLUMNS} FROM ${POPUP_FROM_SQL} ORDER BY q.id DESC LIMIT 50`,
  );
  return rows.map(mapPopup);
}

export async function createPopup(adminId: number, body: unknown) {
  const input: PopupInput = parseBodyWithImage(popupSchema, body, POPUP_PREFIX);
  const promoId = await validatePlatformVoucher(input.promo_id);
  const id = await dalamTransaksi(async (conn) => {
    const [result] = await conn.query<ResultSetHeader>(
      "INSERT INTO popups (title, image_url, promo_id, starts_at, ends_at, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        input.title,
        input.image_url,
        promoId,
        new Date(input.starts_at),
        new Date(input.ends_at),
        input.is_active,
        adminId,
      ],
    );
    await catat(conn, {
      adminId,
      action: "popup.create",
      targetType: "popup",
      targetId: result.insertId,
      after: { title: input.title, promo_id: promoId },
    });
    return result.insertId;
  });
  return loadPopup(id);
}

export async function updatePopup(adminId: number, idRaw: unknown, body: unknown) {
  const input: UpdatePopupInput = parseBodyWithImage(updatePopupSchema, body, POPUP_PREFIX);
  const promoId = input.promo_id === undefined ? undefined : await validatePlatformVoucher(input.promo_id);
  const id = await dalamTransaksi(async (conn) => {
    const popup = await kunci(conn, "popups", idRaw, { notFound: "Pop-up tidak ditemukan." });
    const changes: Record<string, unknown> = Object.fromEntries(
      Object.entries({
        title: input.title,
        image_url: input.image_url,
        promo_id: promoId,
        starts_at: input.starts_at && new Date(input.starts_at),
        ends_at: input.ends_at && new Date(input.ends_at),
        is_active: input.is_active,
      }).filter(([, value]) => value !== undefined),
    );
    const columns = Object.keys(changes);
    if (columns.length) {
      await conn.query(`UPDATE popups SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`, [
        ...columns.map((column) => changes[column]),
        popup.id,
      ]);
      await catat(conn, {
        adminId,
        action: "popup.update",
        targetType: "popup",
        targetId: popup.id,
        before: Object.fromEntries(columns.map((column) => [column, popup[column]])),
        after: changes,
      });
    }
    return popup.id as number;
  });
  return loadPopup(id);
}
