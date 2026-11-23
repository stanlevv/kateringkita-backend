import { RowDataPacket } from "mysql2";
import db from "../config/db";
import type { VoucherSayaQuery } from "../dto/voucher.dto";
import { AppError } from "../utils/errors";
import { jam } from "./catalog.service";

// Voucher (rancangan 2026-11-16): promo publik tampil di halaman toko / daftar voucher platform dan bisa diklaim ke
// "Voucher Saya". Klaim tidak mengurangi kuota; kuota berkurang saat pesanan dibuat (rebutan di checkout).
export type VoucherKartu = {
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

const KOLOM = `p.id, p.code, p.description, p.type, p.value, p.max_discount, p.min_subtotal, p.starts_at, p.ends_at, p.quota, p.used_count,
  p.per_user_limit, p.is_active, p.is_public, p.merchant_id, m.slug, m.business_name,
  EXISTS (SELECT 1 FROM promo_claims c WHERE c.promo_id = p.id AND c.user_id = ?) AS claimed`;
// toko tersembunyi (belum diverifikasi / akun nonaktif) → vouchernya tidak tampil
const DARI = `promos p LEFT JOIN merchants m ON m.id = p.merchant_id LEFT JOIN users u ON u.id = m.user_id`;
const TOKO_OK = "(p.merchant_id IS NULL OR (m.verification_status = 'verified' AND u.is_active))";
const TERSEDIA = `p.is_public AND p.is_active AND p.starts_at <= ? AND p.ends_at > ? AND ${TOKO_OK}`;

const habis = (r: RowDataPacket) => r.quota !== null && r.used_count >= r.quota;

export const kartuVoucher = (r: RowDataPacket): VoucherKartu => ({
  id: r.id,
  code: r.code,
  description: r.description ?? null,
  type: r.type,
  value: r.value,
  max_discount: r.max_discount ?? null,
  min_subtotal: r.min_subtotal,
  starts_at: r.starts_at,
  ends_at: r.ends_at,
  slot: r.merchant_id === null ? "platform" : "toko",
  merchant: r.merchant_id === null ? null : { id: r.merchant_id, slug: r.slug, business_name: r.business_name },
  sold_out: habis(r),
  claimed: Boolean(r.claimed),
});

async function tersedia(where: string, args: unknown[], userId: number | null, ms: number) {
  const now = new Date(ms);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${KOLOM} FROM ${DARI} WHERE ${where} AND ${TERSEDIA} ORDER BY p.ends_at, p.id`,
    [userId, ...args, now, now],
  );
  return rows.map(kartuVoucher);
}

/** Voucher toko publik yang berlaku (halaman toko). `userId` null = tamu (claimed selalu false). */
export const voucherToko = (merchantId: number, userId: number | null, ms: number) =>
  tersedia("p.merchant_id = ?", [merchantId], userId, ms);

/** Voucher platform publik yang berlaku (Voucher Saya → "Voucher KateringKita", banner, pop-up). */
export const voucherPlatform = (userId: number | null, ms: number) => tersedia("p.merchant_id IS NULL", [], userId, ms);

/** Satu voucher (untuk banner / pop-up): null bila tidak tersedia untuk diklaim. */
export async function voucherTersedia(
  promoId: number,
  userId: number | null,
  ms: number,
): Promise<VoucherKartu | null> {
  return (await tersedia("p.id = ?", [promoId], userId, ms))[0] ?? null;
}

const tidakAda = () => new AppError(404, "NOT_FOUND", "Voucher tidak ditemukan.");

/** Idempoten: klaim yang sudah ada dikembalikan apa adanya. */
export async function klaimVoucher(userId: number, idRaw: unknown): Promise<VoucherKartu> {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id < 1) throw tidakAda();
  const ms = jam.sekarang();
  const [[r]] = await db.query<RowDataPacket[]>(`SELECT ${KOLOM}, ${TOKO_OK} AS toko_ok FROM ${DARI} WHERE p.id = ?`, [
    userId,
    id,
  ]);
  if (!r) throw tidakAda();
  if (Number(r.claimed)) return kartuVoucher(r);
  const berlaku = new Date(r.starts_at).getTime() <= ms && ms < new Date(r.ends_at).getTime();
  if (!r.is_public || !r.is_active || !berlaku || !Number(r.toko_ok))
    throw new AppError(409, "CONFLICT", "Voucher sedang tidak tersedia.");
  if (habis(r)) throw new AppError(409, "CONFLICT", "Kuota voucher sudah habis.");
  await db.query("INSERT IGNORE INTO promo_claims (promo_id, user_id) VALUES (?, ?)", [id, userId]);
  return kartuVoucher({ ...r, claimed: 1 } as RowDataPacket);
}

const rupiah = (n: number) => `Rp ${Number(n).toLocaleString("id-ID")}`;

/**
 * Voucher Saya: klaim milik pembeli (yang berakhir ≤ 30 hari lalu tetap tampil sebagai tidak bisa dipakai).
 * Dengan merchant_id / subtotal / payment_method (checkout), `usable` & `reason` mengikuti keranjang itu.
 */
export async function voucherSaya(userId: number, f: VoucherSayaQuery) {
  const ms = jam.sekarang();
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${KOLOM}, (SELECT COUNT(*) FROM promo_redemptions x WHERE x.promo_id = p.id AND x.user_id = ?) AS dipakai
     FROM promo_claims k JOIN promos p ON p.id = k.promo_id LEFT JOIN merchants m ON m.id = p.merchant_id
     WHERE k.user_id = ? AND p.ends_at > ? - INTERVAL 30 DAY ORDER BY p.ends_at, p.id`,
    [userId, userId, userId, new Date(ms)],
  );
  return rows.map((r) => {
    const reason =
      new Date(r.ends_at).getTime() <= ms
        ? "Voucher sudah berakhir."
        : new Date(r.starts_at).getTime() > ms
          ? "Belum berlaku"
          : !r.is_active
            ? "Voucher sedang tidak tersedia."
            : habis(r)
              ? "Kuota habis"
              : Number(r.dipakai) >= r.per_user_limit
                ? "Batas pemakaianmu habis"
                : f.merchant_id !== undefined && r.merchant_id !== null && r.merchant_id !== f.merchant_id
                  ? `Khusus ${r.business_name}`
                  : f.subtotal !== undefined && f.subtotal < r.min_subtotal
                    ? `Minimal belanja ${rupiah(r.min_subtotal)}`
                    : r.merchant_id === null && f.payment_method === "cod"
                      ? "Voucher platform hanya untuk bayar non-tunai."
                      : null;
    return { ...kartuVoucher(r), usable: reason === null, reason };
  });
}
