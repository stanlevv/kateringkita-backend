// Isi file: voucher untuk pembeli, yaitu promo publik yang bisa dilihat dan diklaim ke "Voucher Saya". Alurnya
// routes/catalog.ts → handlers/voucher.handler.ts → file ini → database. Daftar voucher di sini juga dipakai
// catalog.service (halaman toko), banner.service, dan popup.service.
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import type { MyVouchersQuery } from "../dto/voucher.dto";
import { AppError } from "../utils/errors";
import { clock } from "./catalog.service";

// Voucher = baris tabel `promos` yang `is_public`. Ada dua jenis: voucher toko (`merchant_id` terisi, hanya untuk
// pesanan di toko itu) dan voucher platform (`merchant_id` NULL, dibuat admin). Klaim hanya mencatat voucher ke
// "Voucher Saya" (tabel promo_claims) dan tidak mengurangi kuota; kuota (`quota`, jumlah pemakaian untuk semua
// pembeli) baru berkurang saat pesanan dibuat, jadi pembeli bisa berebut sisa kuota di checkout.
/** Bentuk satu kartu voucher yang dikirim ke aplikasi (nama kunci = kontrak JSON). */
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

// Kolom kartu voucher. `?` pertama diisi id pembeli untuk menghitung `claimed` (sudah diklaim pembeli ini atau belum).
const VOUCHER_COLUMNS = `p.id, p.code, p.description, p.type, p.value, p.max_discount, p.min_subtotal, p.starts_at, p.ends_at, p.quota, p.used_count,
  p.per_user_limit, p.is_active, p.is_public, p.merchant_id, m.slug, m.business_name,
  EXISTS (SELECT 1 FROM promo_claims c WHERE c.promo_id = p.id AND c.user_id = ?) AS claimed`;
// Toko tersembunyi (belum diverifikasi atau akun pemiliknya nonaktif) → vouchernya tidak tampil.
const VOUCHER_FROM_SQL = `promos p LEFT JOIN merchants m ON m.id = p.merchant_id LEFT JOIN users u ON u.id = m.user_id`;
const MERCHANT_VISIBLE_SQL = "(p.merchant_id IS NULL OR (m.verification_status = 'verified' AND u.is_active))";
// Syarat voucher tersedia: publik, aktif, sudah mulai, belum berakhir, dan tokonya tampil. Dua `?` = waktu sekarang.
const AVAILABLE_SQL = `p.is_public AND p.is_active AND p.starts_at <= ? AND p.ends_at > ? AND ${MERCHANT_VISIBLE_SQL}`;

// Kuota habis bila jumlah terpakai sudah mencapai kuota; kuota NULL = tanpa batas.
const isSoldOut = (row: RowDataPacket) => row.quota !== null && row.used_count >= row.quota;

/**
 * Mengubah baris promo dari database menjadi kartu voucher untuk aplikasi.
 * @param row baris hasil kueri yang memakai kolom voucher di file ini
 * @returns kartu voucher; `slot` = "toko" atau "platform", `sold_out` = kuota habis, `claimed` = sudah diklaim
 */
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

// Daftar voucher yang tersedia dengan syarat tambahan `where`, urut dari yang paling cepat berakhir.
async function listAvailable(where: string, args: unknown[], userId: number | null, nowMs: number) {
  const now = new Date(nowMs);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${VOUCHER_COLUMNS} FROM ${VOUCHER_FROM_SQL} WHERE ${where} AND ${AVAILABLE_SQL} ORDER BY p.ends_at, p.id`,
    [userId, ...args, now, now],
  );
  return rows.map(toVoucherCard);
}

/**
 * Voucher toko yang tersedia, untuk halaman toko.
 * @param merchantId id toko
 * @param userId     id pembeli yang login, atau null untuk tamu (`claimed` selalu false)
 * @param nowMs      waktu sekarang dalam milidetik
 * @returns daftar kartu voucher toko itu
 */
export const listMerchantVouchers = (merchantId: number, userId: number | null, nowMs: number) =>
  listAvailable("p.merchant_id = ?", [merchantId], userId, nowMs);

/**
 * Voucher platform yang tersedia, untuk bagian "Voucher KateringKita" di aplikasi.
 * @param userId id pembeli yang login, atau null untuk tamu
 * @param nowMs  waktu sekarang dalam milidetik
 * @returns daftar kartu voucher platform
 */
export const listPlatformVouchers = (userId: number | null, nowMs: number) =>
  listAvailable("p.merchant_id IS NULL", [], userId, nowMs);

/**
 * Satu voucher yang masih tersedia untuk diklaim, dipakai banner dan pop-up yang menunjuk ke sebuah voucher.
 * @param promoId id promo
 * @param userId  id pembeli yang login, atau null untuk tamu
 * @param nowMs   waktu sekarang dalam milidetik
 * @returns kartu voucher, atau null bila voucher itu tidak tersedia (mati, di luar periode, tersembunyi)
 */
export async function getAvailableVoucher(
  promoId: number,
  userId: number | null,
  nowMs: number,
): Promise<VoucherCard | null> {
  return (await listAvailable("p.id = ?", [promoId], userId, nowMs))[0] ?? null;
}

const voucherNotFound = () => new AppError(404, "NOT_FOUND", "Voucher tidak ditemukan.");

/**
 * Mengklaim voucher ke "Voucher Saya" milik pembeli. Bersifat idempoten (diulang berkali-kali hasilnya sama): klaim
 * yang sudah ada dikembalikan apa adanya. Klaim tidak mengurangi kuota.
 * @param userId id pembeli yang login
 * @param idRaw  id voucher dari alamat URL (belum tentu angka)
 * @returns kartu voucher dengan `claimed: true`
 * @throws 404 voucher tidak ada, 409 voucher tidak tersedia (tersembunyi, nonaktif, di luar periode, toko tersembunyi)
 *         atau kuotanya sudah habis
 */
export async function claimVoucher(userId: number, idRaw: unknown): Promise<VoucherCard> {
  // 1. Ambil voucher beserta tanda tokonya tampil (`toko_ok`).
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id < 1) throw voucherNotFound();
  const nowMs = clock.now();
  const [[row]] = await db.query<RowDataPacket[]>(
    `SELECT ${VOUCHER_COLUMNS}, ${MERCHANT_VISIBLE_SQL} AS toko_ok FROM ${VOUCHER_FROM_SQL} WHERE p.id = ?`,
    [userId, id],
  );
  if (!row) throw voucherNotFound();
  // 2. Sudah diklaim → kembalikan saja tanpa memeriksa ulang.
  if (Number(row.claimed)) return toVoucherCard(row);
  // 3. Voucher harus tersedia dan kuotanya belum habis.
  const isInPeriod = new Date(row.starts_at).getTime() <= nowMs && nowMs < new Date(row.ends_at).getTime();
  if (!row.is_public || !row.is_active || !isInPeriod || !Number(row.toko_ok))
    throw new AppError(409, "CONFLICT", "Voucher sedang tidak tersedia.");
  if (isSoldOut(row)) throw new AppError(409, "CONFLICT", "Kuota voucher sudah habis.");
  // 4. Catat klaim. INSERT IGNORE: dua klaim bersamaan tidak membuat baris ganda.
  await db.query("INSERT IGNORE INTO promo_claims (promo_id, user_id) VALUES (?, ?)", [id, userId]);
  return toVoucherCard({ ...row, claimed: 1 } as RowDataPacket);
}

const formatRupiah = (amount: number) => `Rp ${Number(amount).toLocaleString("id-ID")}`;

/**
 * "Voucher Saya": semua voucher yang pernah diklaim pembeli, termasuk yang berakhir paling lama 30 hari lalu (tampil
 * sebagai tidak bisa dipakai). Bila dipanggil dari checkout dengan `merchant_id` / `subtotal` / `payment_method`,
 * kolom `usable` dan `reason` mengikuti keranjang itu.
 * @param userId id pembeli yang login
 * @param filter query yang sudah lolos myVouchersSchema; semuanya opsional
 * @returns kartu voucher ditambah `usable` (bisa dipakai) dan `reason` (alasan tidak bisa dipakai, atau null)
 */
export async function listMyVouchers(userId: number, filter: MyVouchersQuery) {
  // 1. Ambil klaim pembeli beserta berapa kali pembeli ini sudah memakai voucher itu (`dipakai`).
  const nowMs = clock.now();
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${VOUCHER_COLUMNS}, (SELECT COUNT(*) FROM promo_redemptions x WHERE x.promo_id = p.id AND x.user_id = ?) AS dipakai
     FROM promo_claims k JOIN promos p ON p.id = k.promo_id LEFT JOIN merchants m ON m.id = p.merchant_id
     WHERE k.user_id = ? AND p.ends_at > ? - INTERVAL 30 DAY ORDER BY p.ends_at, p.id`,
    [userId, userId, userId, new Date(nowMs)],
  );
  return rows.map((row) => {
    // 2. Alasan pertama yang cocok dipakai, dengan urutan: berakhir, belum mulai, nonaktif, kuota habis, jatah
    //    pembeli habis, toko lain, belanja kurang dari minimal, voucher platform dengan bayar tunai (COD).
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
    // 3. Bisa dipakai bila tidak ada alasan penolakan.
    return { ...toVoucherCard(row), usable: reason === null, reason };
  });
}
