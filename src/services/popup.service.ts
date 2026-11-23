// Isi file: pop-up promo yang muncul saat aplikasi mobile dibuka. Hanya admin yang membuat dan mengubahnya; pembeli
// dan tamu hanya melihat satu pop-up yang sedang tayang. Alurnya routes/catalog.ts atau routes/admin.ts →
// handlers/popup.handler.ts → file ini → database.
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { PopupInput, UpdatePopupInput, popupSchema, updatePopupSchema } from "../dto/popup.dto";
import { AppError } from "../utils/errors";
import { catat, dalamTransaksi, kunci } from "./admin-audit.service";
import { parseBodyWithImage } from "./banner.service";
import { clock } from "./catalog.service";
import { VoucherCard, getAvailableVoucher } from "./voucher.service";

// Aturan tayang: pop-up yang aktif dan dalam masa tayang (`starts_at` sampai `ends_at`), yang paling baru dibuat lebih
// dulu; bila pop-up menunjuk sebuah voucher platform, voucher itu harus masih tersedia. Seberapa sering pop-up muncul
// (sekali sehari, berhenti setelah vouchernya diklaim) diatur aplikasi mobile, bukan server.
// Folder gambar pop-up di penyimpanan R2.
const POPUP_PREFIX = "platform/popup/";

const POPUP_COLUMNS =
  "q.id, q.title, q.image_url, q.promo_id, q.starts_at, q.ends_at, q.is_active, q.created_at, p.code AS promo_code";
const POPUP_FROM_SQL = "popups q LEFT JOIN promos p ON p.id = q.promo_id";

// Satu baris pop-up dalam bentuk JSON untuk admin.
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
// Membaca satu pop-up (sudah pasti ada) dalam bentuk JSON.
const loadPopup = async (id: number) =>
  mapPopup(
    (await db.query<RowDataPacket[]>(`SELECT ${POPUP_COLUMNS} FROM ${POPUP_FROM_SQL} WHERE q.id = ?`, [id]))[0][0],
  );

/** Bentuk pop-up yang dikirim ke aplikasi (nama kunci = kontrak JSON); `promo` = kartu voucher bila ada. */
export type PublicPopup = { id: number; title: string; image_url: string; promo: VoucherCard | null };

/**
 * Pop-up yang sedang tayang untuk aplikasi: dari paling banyak 5 pop-up aktif terbaru, diambil yang pertama yang
 * vouchernya (bila ada) masih tersedia.
 * @param userId id pembeli yang login (untuk tanda `claimed` voucher), atau null untuk tamu
 * @returns satu pop-up, atau null bila tidak ada yang tayang
 */
export async function getPublicPopup(userId: number | null): Promise<PublicPopup | null> {
  // 1. Ambil pop-up aktif dalam masa tayang, terbaru dulu.
  const nowMs = clock.now();
  const now = new Date(nowMs);
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, title, image_url, promo_id FROM popups WHERE is_active AND starts_at <= ? AND ends_at > ? ORDER BY id DESC LIMIT 5",
    [now, now],
  );
  // 2. Pop-up yang vouchernya mati atau lewat periode dilewati, lanjut ke pop-up berikutnya.
  for (const row of rows) {
    const promo = row.promo_id ? await getAvailableVoucher(row.promo_id, userId, nowMs) : null;
    if (row.promo_id && !promo) continue;
    return { id: row.id, title: row.title, image_url: row.image_url, promo };
  }
  return null;
}

// Pop-up hanya boleh menunjuk voucher platform (`merchant_id` NULL). Mengembalikan id voucher, atau null bila kosong.
async function validatePlatformVoucher(promoId: number | null | undefined) {
  if (!promoId) return null;
  const [[promo]] = await db.query<RowDataPacket[]>("SELECT id FROM promos WHERE id = ? AND merchant_id IS NULL", [
    promoId,
  ]);
  if (!promo)
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { promo_id: ["Pilih voucher platform."] });
  return promoId;
}

/**
 * Daftar pop-up untuk admin: 50 terbaru, status apa pun.
 * @returns daftar pop-up
 */
export async function listPopups() {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${POPUP_COLUMNS} FROM ${POPUP_FROM_SQL} ORDER BY q.id DESC LIMIT 50`,
  );
  return rows.map(mapPopup);
}

/**
 * Admin membuat pop-up baru, lalu tindakan itu dicatat di log audit admin.
 * @param adminId id admin yang membuat
 * @param body    isi permintaan mentah (diperiksa popupSchema dan aturan gambar)
 * @returns pop-up yang baru disimpan
 * @throws 400 isian tidak valid atau voucher bukan voucher platform
 */
export async function createPopup(adminId: number, body: unknown) {
  // 1. Periksa isian dan voucher.
  const input: PopupInput = parseBodyWithImage(popupSchema, body, POPUP_PREFIX);
  const promoId = await validatePlatformVoucher(input.promo_id);
  const id = await dalamTransaksi(async (conn) => {
    // 2. Simpan pop-up.
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
    // 3. Catat di log audit admin.
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

/**
 * Admin mengubah sebagian isi pop-up. Hanya kolom yang dikirim yang diubah; `promo_id: null` melepas voucher.
 * Perubahan dicatat di log audit beserta nilai sebelumnya.
 * @param adminId id admin yang mengubah
 * @param idRaw   id pop-up dari alamat URL (belum tentu angka)
 * @param body    isi permintaan mentah (diperiksa updatePopupSchema dan aturan gambar)
 * @returns pop-up setelah diubah
 * @throws 400 isian tidak valid atau voucher bukan voucher platform, 404 pop-up tidak ada
 */
export async function updatePopup(adminId: number, idRaw: unknown, body: unknown) {
  // 1. Periksa isian dan voucher (bila dikirim).
  const input: UpdatePopupInput = parseBodyWithImage(updatePopupSchema, body, POPUP_PREFIX);
  const promoId = input.promo_id === undefined ? undefined : await validatePlatformVoucher(input.promo_id);
  const id = await dalamTransaksi(async (conn) => {
    // 2. Kunci pop-up dan susun kolom yang dikirim saja.
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
    // 3. Simpan bila ada perubahan, lalu catat nilai sebelum dan sesudah di log audit.
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
