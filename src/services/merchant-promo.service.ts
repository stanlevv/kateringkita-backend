// Isi file: promo milik toko yang dikelola penjual sendiri (daftar, buat, ubah, hapus). Alurnya routes/merchant.ts →
// handlers/merchant.handler.ts → file ini → database. Promo toko dan promo platform (dibuat admin) tersimpan di tabel
// yang sama, `promos`: promo toko punya `merchant_id`, promo platform `merchant_id`-nya NULL. Promo yang `is_public`
// tampil sebagai voucher di halaman toko dan bisa diklaim pembeli (lihat voucher.service).
import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { withTransaction, lockRow, withBooleanFlags } from "./admin-audit.service";
import {
  PROMO_FIELDS,
  duplicateCodeError,
  promoCodeSchema,
  comparableValue,
  parseIsPublic,
  parsePromoInput,
} from "./admin-promo.service";
import { getMerchantId } from "./merchant-menu.service";
import { notifyMerchantPromo } from "./admin-announcement.service";

// Aturan isian sama dengan promo platform (dicek `parsePromoInput` di admin-promo.service): jenis `percent` (potongan persen,
// boleh diberi batas `max_discount`), `fixed` (potongan rupiah tetap), `min_subtotal` (minimal belanja), `quota`
// (jumlah pemakaian total untuk semua pembeli; kosong = tanpa batas), dan `per_user_limit` (jatah pakai per pembeli).
// Kode promo unik di seluruh tabel promos. Bedanya dengan promo admin: kode boleh diubah, status lewat PATCH
// is_active, boleh dihapus selama belum pernah dipakai, dan tidak dicatat di log audit admin.
const isDuplicateKey = (error: unknown) => (error as { code?: string } | null)?.code === "ER_DUP_ENTRY";
// Isi permintaan yang bukan objek (kosong, teks, daftar) dianggap {} supaya galatnya tetap per kolom.
const toObject = (body: unknown) =>
  (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
const invalidField = (field: string, message: string) =>
  new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { [field]: [message] });

// `is_active` dari isi permintaan: undefined bila tidak dikirim; selain true/false ditolak 400.
function readIsActive(body: Record<string, unknown>): boolean | undefined {
  if (!("is_active" in body)) return undefined;
  if (typeof body.is_active !== "boolean") throw invalidField("is_active", "Status promo tidak valid.");
  return body.is_active;
}

// Mengunci satu promo milik toko ini (FOR UPDATE = baris dikunci sampai transaksi selesai, supaya dua perubahan tidak
// saling timpa); promo toko lain dianggap tidak ada (404). merchantId berasal dari database (bilangan bulat), jadi
// aman disisipkan ke klausa where milik lockRow().
const lockMerchantPromo = (conn: Parameters<typeof lockRow>[0], merchantId: number, idRaw: unknown) =>
  lockRow(conn, "promos", idRaw, { where: `merchant_id = ${Number(merchantId)}`, notFound: "Promo tidak ditemukan." });

/**
 * Daftar semua promo milik toko penjual yang login, yang terbaru di atas.
 * @param userId id pengguna penjual dari token login
 * @returns baris promo apa adanya, dengan `is_active` dan `is_public` sebagai true/false
 * @throws 404 bila pengguna ini tidak punya toko
 */
export async function listMerchantPromos(userId: number) {
  const [rows] = await db.query<RowDataPacket[]>("SELECT * FROM promos WHERE merchant_id = ? ORDER BY id DESC", [
    await getMerchantId(userId),
  ]);
  return rows.map(withBooleanFlags);
}

// Biaya layanan masuk ke platform, jadi promo toko hanya boleh potongan persen atau nominal. Promo toko lama yang
// sudah berjenis gratis biaya layanan tetap berlaku.
const rejectFreeServiceFee = (type: unknown) => {
  if (type === "free_service_fee") throw invalidField("type", "Promo toko hanya potongan persen atau nominal.");
};

/**
 * Membuat promo baru untuk toko penjual yang login. Bila promo langsung aktif dan publik, pembeli yang memfavoritkan
 * menu toko ini diberi notifikasi promo.
 * @param userId id pengguna penjual dari token login
 * @param body   isi permintaan mentah: `code`, kolom promo (lihat komentar di atas), `is_active` dan `is_public`
 *               (keduanya bawaan true)
 * @returns baris promo yang baru disimpan
 * @throws 400 isian tidak valid atau jenis gratis biaya layanan, 404 pengguna tidak punya toko, 409 kode sudah dipakai
 */
export async function createMerchantPromo(userId: number, body: unknown) {
  // 1. Periksa isian; promo toko tidak boleh berjenis gratis biaya layanan.
  const input = toObject(body);
  const isActive = readIsActive(input) ?? true;
  const isPublic = parseIsPublic(input) ?? true;
  const { code, data } = parsePromoInput(input, 0, true);
  rejectFreeServiceFee(data.type);
  const merchantId = await getMerchantId(userId);
  try {
    // 2. Simpan; kode kembar ditolak oleh indeks unik database (ER_DUP_ENTRY) lalu dijawab 409.
    const [insertResult] = await db.query<ResultSetHeader>(
      `INSERT INTO promos (merchant_id, code, description, type, value, max_discount, min_subtotal, quota, per_user_limit, starts_at, ends_at,
         is_active, is_public)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        merchantId,
        code,
        data.description,
        data.type,
        data.value,
        data.max_discount,
        data.min_subtotal,
        data.quota,
        data.per_user_limit,
        data.starts_at,
        data.ends_at,
        isActive,
        isPublic,
      ],
    );
    // 3. Kabari pemfavorit menu toko. notifyMerchantPromo sendiri yang memeriksa promo aktif, publik, belum berakhir,
    //    dan tokonya tampil di katalog.
    const [[row]] = await db.query<RowDataPacket[]>("SELECT * FROM promos WHERE id = ?", [insertResult.insertId]);
    await notifyMerchantPromo(row);
    return withBooleanFlags(row);
  } catch (error) {
    if (isDuplicateKey(error)) throw duplicateCodeError();
    throw error;
  }
}

/**
 * Mengubah sebagian isi promo toko (PATCH): kolom yang tidak dikirim memakai nilai yang tersimpan, lalu hasil gabungan
 * diperiksa ulang dengan aturan yang sama seperti saat dibuat. Kuota tidak boleh diturunkan di bawah jumlah yang sudah
 * terpakai (`used_count`). Bila promo berubah dari nonaktif menjadi aktif, pemfavorit menu toko diberi notifikasi
 * (dengan syarat yang sama seperti saat dibuat).
 * @param userId id pengguna penjual dari token login
 * @param idRaw  id promo dari alamat URL (belum tentu angka)
 * @param body   isi permintaan mentah berisi kolom yang mau diubah
 * @returns baris promo setelah diubah
 * @throws 400 isian tidak valid, 404 promo tidak ada atau milik toko lain, 409 kode sudah dipakai promo lain
 */
export async function updateMerchantPromo(userId: number, idRaw: unknown, body: unknown) {
  const merchantId = await getMerchantId(userId);
  const input = toObject(body);
  const isActive = readIsActive(input);
  const isPublic = parseIsPublic(input);
  try {
    const { after, activated } = await withTransaction(async (conn) => {
      // 1. Kunci promo milik toko ini. Jenis gratis biaya layanan yang sudah ada boleh tetap; yang dilarang hanya
      //    mengganti jenis lain menjadi gratis biaya layanan.
      const before = await lockMerchantPromo(conn, merchantId, idRaw);
      if ("type" in input && input.type !== before.type) rejectFreeServiceFee(input.type);
      // 2. Gabungkan nilai tersimpan dengan kolom yang dikirim, lalu periksa ulang semuanya.
      const merged = {
        ...Object.fromEntries(
          PROMO_FIELDS.map((field) => [
            field,
            before[field] instanceof Date ? (before[field] as Date).toISOString() : before[field],
          ]),
        ),
        ...Object.fromEntries(PROMO_FIELDS.filter((field) => field in input).map((field) => [field, input[field]])),
      };
      const updated: Record<string, unknown> = { ...parsePromoInput(merged, before.used_count).data };
      if ("code" in input) {
        const parsedCode = promoCodeSchema.safeParse(input.code);
        if (!parsedCode.success) throw invalidField("code", parsedCode.error.issues[0].message);
        updated.code = parsedCode.data;
      }
      if (isActive !== undefined) updated.is_active = isActive;
      if (isPublic !== undefined) updated.is_public = isPublic;
      // 3. Simpan hanya kolom yang nilainya benar-benar berubah.
      const previous = withBooleanFlags(before) as Record<string, unknown>;
      const columns = Object.keys(updated).filter(
        (column) => comparableValue(updated[column]) !== comparableValue(previous[column]),
      );
      if (columns.length) {
        await conn.query(`UPDATE promos SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`, [
          ...columns.map((column) => updated[column]),
          before.id,
        ]);
      }
      const [[after]] = await conn.query<RowDataPacket[]>("SELECT * FROM promos WHERE id = ?", [before.id]);
      return { after, activated: !previous.is_active && Boolean(after.is_active) };
    });
    // 4. Kabari pemfavorit hanya bila promo baru saja dinyalakan.
    if (activated) await notifyMerchantPromo(after);
    return withBooleanFlags(after);
  } catch (error) {
    if (isDuplicateKey(error)) throw duplicateCodeError();
    throw error;
  }
}

/**
 * Menghapus promo toko yang belum pernah dipakai di pesanan. Promo yang sudah dipakai cukup dinonaktifkan, supaya
 * riwayat potongan di pesanan lama tetap punya promonya.
 * @param userId id pengguna penjual dari token login
 * @param idRaw  id promo dari alamat URL
 * @returns `{ id }` promo yang dihapus
 * @throws 404 promo tidak ada atau milik toko lain, 409 promo sudah pernah dipakai
 */
export async function deleteMerchantPromo(userId: number, idRaw: unknown) {
  const merchantId = await getMerchantId(userId);
  return withTransaction(async (conn) => {
    const promo = await lockMerchantPromo(conn, merchantId, idRaw);
    if (promo.used_count > 0) throw new AppError(409, "CONFLICT", "Promo sudah dipakai. Nonaktifkan saja.");
    await conn.query("DELETE FROM promos WHERE id = ?", [promo.id]);
    return { id: promo.id as number };
  });
}
