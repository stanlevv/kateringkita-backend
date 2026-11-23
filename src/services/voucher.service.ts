import { RowDataPacket } from "mysql2";
import db from "../config/db";
import type { MyVouchersQuery } from "../dto/voucher.dto";
import { AppError } from "../utils/errors";
import { clock } from "./catalog.service";

// Voucher (rancangan 2026-11-16): promo publik tampil di halaman toko / daftar voucher platform dan bisa diklaim ke
// "Voucher Saya". Klaim tidak mengurangi kuota; kuota berkurang saat pesanan dibuat (rebutan di checkout).
export type VoucherCard = {
  id: number;
  code: string;
  description: string | null;
  type: "percent" | "fixed" | "free_service_fee";
  value: number;
  max_discount: number | null;
  min_subtotal: number;
  starts_at: Date;
  ends_at: Date;
  slot: "toko" | "platform";
  merchant: { id: number; slug: string; business_name: string } | null;
  sold_out: boolean;
  claimed: boolean;
};

const VOUCHER_COLUMNS = `p.id, p.code, p.description, p.type, p.value, p.max_discount, p.min_subtotal, p.starts_at, p.ends_at, p.quota, p.used_count,
  p.per_user_limit, p.is_active, p.is_public, p.merchant_id, m.slug, m.business_name,
  EXISTS (SELECT 1 FROM promo_claims c WHERE c.promo_id = p.id AND c.user_id = ?) AS claimed`;
// toko tersembunyi (belum diverifikasi / akun nonaktif) → vouchernya tidak tampil
const VOUCHER_FROM_SQL = `promos p LEFT JOIN merchants m ON m.id = p.merchant_id LEFT JOIN users u ON u.id = m.user_id`;
const MERCHANT_VISIBLE_SQL = "(p.merchant_id IS NULL OR (m.verification_status = 'verified' AND u.is_active))";
const AVAILABLE_SQL = `p.is_public AND p.is_active AND p.starts_at <= ? AND p.ends_at > ? AND ${MERCHANT_VISIBLE_SQL}`;

const isSoldOut = (row: RowDataPacket) => row.quota !== null && row.used_count >= row.quota;

export const toVoucherCard = (row: RowDataPacket): VoucherCard => ({
  id: row.id,
  code: row.code,
  description: row.description ?? null,
  type: row.type,
  value: row.value,
  max_discount: row.max_discount ?? null,
  min_subtotal: row.min_subtotal,
  starts_at: row.starts_at,
  ends_at: row.ends_at,
  slot: row.merchant_id === null ? "platform" : "toko",
  merchant: row.merchant_id === null ? null : { id: row.merchant_id, slug: row.slug, business_name: row.business_name },
  sold_out: isSoldOut(row),
  claimed: Boolean(row.claimed),
});

async function listAvailable(where: string, args: unknown[], userId: number | null, nowMs: number) {
  const now = new Date(nowMs);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${VOUCHER_COLUMNS} FROM ${VOUCHER_FROM_SQL} WHERE ${where} AND ${AVAILABLE_SQL} ORDER BY p.ends_at, p.id`,
    [userId, ...args, now, now],
  );
  return rows.map(toVoucherCard);
}

/** Voucher toko publik yang berlaku (halaman toko). `userId` null = tamu (claimed selalu false). */
export const listMerchantVouchers = (merchantId: number, userId: number | null, nowMs: number) =>
  listAvailable("p.merchant_id = ?", [merchantId], userId, nowMs);

/** Voucher platform publik yang berlaku (Voucher Saya → "Voucher KateringKita", banner, pop-up). */
export const listPlatformVouchers = (userId: number | null, nowMs: number) =>
  listAvailable("p.merchant_id IS NULL", [], userId, nowMs);

/** Satu voucher (untuk banner / pop-up): null bila tidak tersedia untuk diklaim. */
export async function getAvailableVoucher(
  promoId: number,
  userId: number | null,
  nowMs: number,
): Promise<VoucherCard | null> {
  return (await listAvailable("p.id = ?", [promoId], userId, nowMs))[0] ?? null;
}

const voucherNotFound = () => new AppError(404, "NOT_FOUND", "Voucher tidak ditemukan.");

/** Idempoten: klaim yang sudah ada dikembalikan apa adanya. */
export async function claimVoucher(userId: number, idRaw: unknown): Promise<VoucherCard> {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id < 1) throw voucherNotFound();
  const nowMs = clock.now();
  const [[row]] = await db.query<RowDataPacket[]>(
    `SELECT ${VOUCHER_COLUMNS}, ${MERCHANT_VISIBLE_SQL} AS toko_ok FROM ${VOUCHER_FROM_SQL} WHERE p.id = ?`,
    [userId, id],
  );
  if (!row) throw voucherNotFound();
  if (Number(row.claimed)) return toVoucherCard(row);
  const isInPeriod = new Date(row.starts_at).getTime() <= nowMs && nowMs < new Date(row.ends_at).getTime();
  if (!row.is_public || !row.is_active || !isInPeriod || !Number(row.toko_ok))
    throw new AppError(409, "CONFLICT", "Voucher sedang tidak tersedia.");
  if (isSoldOut(row)) throw new AppError(409, "CONFLICT", "Kuota voucher sudah habis.");
  await db.query("INSERT IGNORE INTO promo_claims (promo_id, user_id) VALUES (?, ?)", [id, userId]);
  return toVoucherCard({ ...row, claimed: 1 } as RowDataPacket);
}

const formatRupiah = (amount: number) => `Rp ${Number(amount).toLocaleString("id-ID")}`;

/**
 * Voucher Saya: klaim milik pembeli (yang berakhir ≤ 30 hari lalu tetap tampil sebagai tidak bisa dipakai).
 * Dengan merchant_id / subtotal / payment_method (checkout), `usable` & `reason` mengikuti keranjang itu.
 */
export async function listMyVouchers(userId: number, filter: MyVouchersQuery) {
  const nowMs = clock.now();
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${VOUCHER_COLUMNS}, (SELECT COUNT(*) FROM promo_redemptions x WHERE x.promo_id = p.id AND x.user_id = ?) AS dipakai
     FROM promo_claims k JOIN promos p ON p.id = k.promo_id LEFT JOIN merchants m ON m.id = p.merchant_id
     WHERE k.user_id = ? AND p.ends_at > ? - INTERVAL 30 DAY ORDER BY p.ends_at, p.id`,
    [userId, userId, userId, new Date(nowMs)],
  );
  return rows.map((row) => {
    const reason =
      new Date(row.ends_at).getTime() <= nowMs
        ? "Voucher sudah berakhir."
        : new Date(row.starts_at).getTime() > nowMs
          ? "Belum berlaku"
          : !row.is_active
            ? "Voucher sedang tidak tersedia."
            : isSoldOut(row)
              ? "Kuota habis"
              : Number(row.dipakai) >= row.per_user_limit
                ? "Batas pemakaianmu habis"
                : filter.merchant_id !== undefined && row.merchant_id !== null && row.merchant_id !== filter.merchant_id
                  ? `Khusus ${row.business_name}`
                  : filter.subtotal !== undefined && filter.subtotal < row.min_subtotal
                    ? `Minimal belanja ${formatRupiah(row.min_subtotal)}`
                    : row.merchant_id === null && filter.payment_method === "cod"
                      ? "Voucher platform hanya untuk bayar non-tunai."
                      : null;
    return { ...toVoucherCard(row), usable: reason === null, reason };
  });
}
