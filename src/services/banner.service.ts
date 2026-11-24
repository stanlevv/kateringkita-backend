// Isi file: banner di beranda aplikasi mobile. Pembeli melihat banner yang sedang tayang; penjual mengajukan banner
// tokonya; admin membuat banner platform dan meninjau (menyetujui, menolak, menonaktifkan) banner penjual. Alurnya
// routes/catalog.ts, routes/merchant.ts, atau routes/admin.ts → handlers/banner.handler.ts → file ini → database.
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { z } from "zod";
import db from "../config/db";
import {
  AdminBannerInput,
  MerchantBannerInput,
  ReviewBannerInput,
  UpdateMerchantBannerInput,
  adminBannerSchema,
  merchantBannerSchema,
  reviewBannerSchema,
  updateMerchantBannerSchema,
} from "../dto/banner.dto";
import { AppError } from "../utils/errors";
import { PRESIGN_SECONDS } from "../utils/r2";
import { recordAudit, withTransaction, lockRow } from "./admin-audit.service";
import { clock } from "./catalog.service";
import { getMerchantId } from "./merchant-menu.service";
import { validateImageUrl } from "./upload.service";
import { VoucherCard, getAvailableVoucher } from "./voucher.service";

// Aturan banner: setiap banner punya masa tayang (`starts_at` sampai `ends_at`) dan status. Banner penjual mulai dari
// `menunggu` dan baru tayang setelah admin mengubahnya menjadi `disetujui` (bisa juga `ditolak` atau `nonaktif`);
// satu toko hanya boleh punya satu banner aktif. Banner platform buatan admin langsung `disetujui`. Tujuan banner
// (`target`): halaman toko, sebuah voucher (`promo`), atau tidak ke mana-mana (`none`, hanya banner platform).
/** Paling banyak 8 banner yang tayang di beranda. */
export const MAX_PUBLIC_BANNERS = 8;
// Folder gambar di penyimpanan R2: banner platform di platform/banner/, banner toko di merchants/<id toko>/banner/.
const PLATFORM_PREFIX = "platform/banner/";
const merchantPrefix = (merchantId: number) => `merchants/${merchantId}/banner/`;

const BANNER_COLUMNS = `b.id, b.merchant_id, b.title, b.image_url, b.target, b.promo_id, b.status, b.catatan, b.starts_at, b.ends_at, b.sort_order,
  b.reviewed_at, b.created_at, p.code AS promo_code, m.slug, m.business_name`;
const BANNER_FROM_SQL =
  "banners b LEFT JOIN promos p ON p.id = b.promo_id LEFT JOIN merchants m ON m.id = b.merchant_id";

// Satu baris banner dalam bentuk JSON untuk penjual dan admin. `catatan` = alasan penolakan dari admin.
const mapBanner = (row: RowDataPacket) => ({
  id: row.id as number,
  title: row.title as string,
  image_url: row.image_url as string,
  target: row.target as string,
  promo: row.promo_id ? { id: row.promo_id as number, code: row.promo_code as string } : null,
  merchant: row.merchant_id
    ? { id: row.merchant_id as number, slug: row.slug as string, business_name: row.business_name as string }
    : null,
  status: row.status as string,
  catatan: (row.catatan as string | null) ?? null,
  starts_at: row.starts_at,
  ends_at: row.ends_at,
  sort_order: row.sort_order as number,
  reviewed_at: row.reviewed_at,
  created_at: row.created_at,
});

const bannerNotFound = () => new AppError(404, "NOT_FOUND", "Banner tidak ditemukan.");
const invalidFields = (fields: Record<string, string[]>) =>
  new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", fields);

/**
 * Memeriksa isi permintaan dengan skema zod sekaligus memeriksa URL gambar, supaya semua galat kolom keluar dalam
 * satu jawaban. Gambar harus hasil unggahan ke folder `prefix` (lihat validateImageUrl). Dipakai juga popup.service.
 * @param schema skema zod untuk isi permintaan
 * @param body   isi permintaan mentah
 * @param prefix folder gambar yang diizinkan, contoh `platform/banner/`
 * @returns isi permintaan yang sudah lolos skema
 * @throws 400 VALIDATION_ERROR berisi semua galat kolom (skema dan gambar)
 */
export function parseBodyWithImage<S extends z.ZodType>(schema: S, body: unknown, prefix: string): z.infer<S> {
  // 1. Kumpulkan galat skema per kolom.
  const parsed = schema.safeParse(body);
  const fields: Record<string, string[]> = {};
  if (!parsed.success)
    for (const issue of parsed.error.issues) (fields[issue.path.join(".") || "body"] ??= []).push(issue.message);
  // 2. Periksa URL gambar bila dikirim; galatnya ditambahkan ke kumpulan yang sama.
  const url = (body as { image_url?: unknown } | null)?.image_url;
  if (typeof url === "string" && url.trim()) {
    try {
      validateImageUrl(url.trim(), null, prefix, "image_url");
    } catch (error) {
      if (error instanceof AppError && error.fields) Object.assign(fields, error.fields);
      else throw error;
    }
  }
  // 3. Ada galat apa pun → 400 dengan semua galat.
  if (Object.keys(fields).length || !parsed.success) throw invalidFields(fields);
  return parsed.data;
}

// Membaca satu banner (sudah pasti ada) dalam bentuk JSON.
const loadBanner = async (id: number) => {
  const [[row]] = await db.query<RowDataPacket[]>(`SELECT ${BANNER_COLUMNS} FROM ${BANNER_FROM_SQL} WHERE b.id = ?`, [
    id,
  ]);
  return mapBanner(row);
};

// ---------------- publik ----------------
/** Bentuk banner yang dikirim ke aplikasi pembeli (nama kunci = kontrak JSON). */
export type PublicBanner = {
  id: number;
  title: string;
  image_url: string;
  target: string;
  promo: VoucherCard | null;
  merchant: { id: number; slug: string; business_name: string } | null;
};

/**
 * Banner yang sedang tayang di beranda: disetujui, dalam masa tayang, dan tokonya (bila banner toko) tampil di
 * katalog. Banner platform didahulukan (urut `sort_order`), lalu banner penjual (yang paling baru disetujui dulu).
 * Banner bertujuan voucher hanya tayang bila vouchernya masih tersedia.
 * @param userId id pembeli yang login (untuk tanda `claimed` voucher), atau null untuk tamu
 * @returns paling banyak 8 banner
 */
export async function listPublicBanners(userId: number | null): Promise<PublicBanner[]> {
  // 1. Ambil calon banner (paling banyak 40) yang memenuhi syarat tayang.
  const nowMs = clock.now();
  const now = new Date(nowMs);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${BANNER_COLUMNS} FROM ${BANNER_FROM_SQL} LEFT JOIN users u ON u.id = m.user_id
     WHERE b.status = 'disetujui' AND b.starts_at <= ? AND b.ends_at > ?
       AND (b.merchant_id IS NULL OR (m.verification_status = 'verified' AND u.is_active))
     ORDER BY b.merchant_id IS NULL DESC, b.sort_order, b.reviewed_at DESC, b.id LIMIT 40`,
    [now, now],
  );
  // 2. Saring satu per satu sampai terkumpul 8; banner yang vouchernya mati, kedaluwarsa, atau disembunyikan dilewati.
  const banners: PublicBanner[] = [];
  for (const row of rows) {
    if (banners.length >= MAX_PUBLIC_BANNERS) break;
    let promo: VoucherCard | null = null;
    if (row.target === "promo") {
      if (!row.promo_id || !(promo = await getAvailableVoucher(row.promo_id, userId, nowMs))) continue;
    }
    const mapped = mapBanner(row);
    banners.push({
      id: mapped.id,
      title: mapped.title,
      image_url: mapped.image_url,
      target: mapped.target,
      promo,
      merchant: mapped.merchant,
    });
  }
  return banners;
}

// ---------------- penjual ----------------
/**
 * Semua banner milik toko penjual yang login (status apa pun), yang terbaru di atas.
 * @param userId id pengguna penjual dari token login
 * @returns daftar banner
 * @throws 404 bila pengguna ini tidak punya toko
 */
export async function listMerchantBanners(userId: number) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${BANNER_COLUMNS} FROM ${BANNER_FROM_SQL} WHERE b.merchant_id = ? ORDER BY b.id DESC`,
    [await getMerchantId(userId)],
  );
  return rows.map(mapBanner);
}

// Banner toko bertujuan voucher wajib menunjuk voucher milik toko itu sendiri. Mengembalikan id voucher, atau null bila
// tujuannya bukan voucher.
async function validateMerchantPromo(
  merchantId: number,
  target: string | undefined,
  promoId: number | null | undefined,
) {
  if (target !== "promo") return null;
  const [[promo]] = promoId
    ? await db.query<RowDataPacket[]>("SELECT id FROM promos WHERE id = ? AND merchant_id = ?", [promoId, merchantId])
    : [[]];
  if (!promo) throw invalidFields({ promo_id: ["Pilih voucher milik tokomu."] });
  return promoId as number;
}

// Satu toko hanya boleh punya satu banner aktif (menunggu atau disetujui, belum berakhir). `excludeId` = banner yang
// sedang diubah, supaya tidak dihitung melawan dirinya sendiri.
async function ensureSingleActive(merchantId: number, excludeId: number | null) {
  const [[countRow]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM banners WHERE merchant_id = ? AND status IN ('menunggu', 'disetujui') AND ends_at > UTC_TIMESTAMP() AND id <> ?`,
    [merchantId, excludeId ?? 0],
  );
  if (Number(countRow.n) > 0) throw new AppError(409, "CONFLICT", "Toko ini sudah punya banner aktif.");
}

/**
 * Penjual mengajukan banner baru untuk tokonya. Banner disimpan dengan status `menunggu` persetujuan admin.
 * @param userId id pengguna penjual dari token login
 * @param body   isi permintaan mentah (diperiksa merchantBannerSchema dan aturan gambar)
 * @returns banner yang baru disimpan
 * @throws 400 isian tidak valid atau voucher bukan milik toko, 404 pengguna tidak punya toko, 409 toko sudah punya
 *         banner aktif
 */
export async function createMerchantBanner(userId: number, body: unknown) {
  // 1. Periksa isian, voucher tujuan, dan batas satu banner aktif.
  const merchantId = await getMerchantId(userId);
  const input: MerchantBannerInput = parseBodyWithImage(merchantBannerSchema, body, merchantPrefix(merchantId));
  const promoId = await validateMerchantPromo(merchantId, input.target, input.promo_id);
  await ensureSingleActive(merchantId, null);
  // 2. Simpan sebagai `menunggu`.
  const [result] = await db.query<ResultSetHeader>(
    `INSERT INTO banners (merchant_id, title, image_url, target, promo_id, status, starts_at, ends_at, created_by)
     VALUES (?, ?, ?, ?, ?, 'menunggu', ?, ?, ?)`,
    [
      merchantId,
      input.title,
      input.image_url,
      input.target,
      promoId,
      new Date(input.starts_at),
      new Date(input.ends_at),
      userId,
    ],
  );
  return loadBanner(result.insertId);
}

/**
 * Penjual mengubah banner tokonya. Setiap perubahan mengembalikan banner ke status `menunggu` dan menghapus hasil
 * tinjauan sebelumnya, jadi harus disetujui admin lagi. Kolom yang tidak dikirim memakai nilai tersimpan.
 * @param userId id pengguna penjual dari token login
 * @param idRaw  id banner dari alamat URL (belum tentu angka)
 * @param body   isi permintaan mentah (diperiksa updateMerchantBannerSchema dan aturan gambar)
 * @returns banner setelah diubah
 * @throws 400 isian tidak valid, 404 banner tidak ada atau milik toko lain, 409 banner yang ditolak / nonaktif
 *         diajukan ulang padahal toko sudah punya banner aktif lain
 */
export async function updateMerchantBanner(userId: number, idRaw: unknown, body: unknown) {
  // 1. Ambil banner milik toko ini.
  const merchantId = await getMerchantId(userId);
  const id = Number(idRaw);
  const [[banner]] =
    Number.isInteger(id) && id > 0
      ? await db.query<RowDataPacket[]>("SELECT * FROM banners WHERE id = ? AND merchant_id = ?", [id, merchantId])
      : [[]];
  if (!banner) throw bannerNotFound();
  // 2. Periksa isian dan voucher tujuan (memakai nilai tersimpan bila tidak dikirim).
  const input: UpdateMerchantBannerInput = parseBodyWithImage(
    updateMerchantBannerSchema,
    body,
    merchantPrefix(merchantId),
  );
  const target = input.target ?? banner.target;
  const promoId = await validateMerchantPromo(
    merchantId,
    target,
    input.promo_id === undefined ? banner.promo_id : input.promo_id,
  );
  // 3. Banner yang ditolak atau nonaktif akan aktif lagi, jadi batas satu banner aktif diperiksa ulang.
  if (banner.status === "ditolak" || banner.status === "nonaktif") await ensureSingleActive(merchantId, banner.id);
  // 4. Simpan dan kembalikan ke antrean persetujuan.
  await db.query(
    `UPDATE banners SET title = ?, image_url = ?, target = ?, promo_id = ?, starts_at = ?, ends_at = ?, status = 'menunggu', catatan = NULL,
       reviewed_by = NULL, reviewed_at = NULL WHERE id = ?`,
    [
      input.title ?? banner.title,
      input.image_url ?? banner.image_url,
      target,
      promoId,
      input.starts_at ? new Date(input.starts_at) : banner.starts_at,
      input.ends_at ? new Date(input.ends_at) : banner.ends_at,
      banner.id,
    ],
  );
  return loadBanner(banner.id);
}

/**
 * Penjual menghapus banner tokonya (status apa pun).
 * @param userId id pengguna penjual dari token login
 * @param idRaw  id banner dari alamat URL
 * @returns `{ id }` banner yang dihapus
 * @throws 404 banner tidak ada atau milik toko lain
 */
export async function deleteMerchantBanner(userId: number, idRaw: unknown) {
  const merchantId = await getMerchantId(userId);
  const id = Number(idRaw);
  const [result] =
    Number.isInteger(id) && id > 0
      ? await db.query<ResultSetHeader>("DELETE FROM banners WHERE id = ? AND merchant_id = ?", [id, merchantId])
      : [{ affectedRows: 0 }];
  if (!result.affectedRows) throw bannerNotFound();
  return { id };
}

// ---------------- admin ----------------
/**
 * Semua banner untuk admin: yang menunggu tinjauan di atas, lalu banner platform (urut `sort_order`), lalu sisanya.
 * @param status saringan status (`menunggu`, `disetujui`, `ditolak`, `nonaktif`), atau kosong untuk semua
 * @returns daftar banner
 */
export async function listAdminBanners(status?: string) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${BANNER_COLUMNS} FROM ${BANNER_FROM_SQL} ${status ? "WHERE b.status = ?" : ""}
     ORDER BY b.status = 'menunggu' DESC, b.merchant_id IS NULL DESC, b.sort_order, b.id DESC`,
    status ? [status] : [],
  );
  return rows.map(mapBanner);
}

/**
 * Admin membuat banner platform. Banner langsung berstatus `disetujui` (tayang sesuai masa tayang) dan dicatat di log
 * audit admin. Tujuannya boleh voucher mana pun atau tanpa tujuan.
 * @param adminId id admin yang membuat
 * @param body    isi permintaan mentah (diperiksa adminBannerSchema dan aturan gambar)
 * @returns banner yang baru disimpan
 * @throws 400 isian tidak valid atau voucher tujuan tidak ada
 */
export async function createAdminBanner(adminId: number, body: unknown) {
  // 1. Periksa isian dan voucher tujuan.
  const input: AdminBannerInput = parseBodyWithImage(adminBannerSchema, body, PLATFORM_PREFIX);
  if (input.target === "promo") {
    const [[promo]] = input.promo_id
      ? await db.query<RowDataPacket[]>("SELECT id FROM promos WHERE id = ?", [input.promo_id])
      : [[]];
    if (!promo) throw invalidFields({ promo_id: ["Pilih voucher."] });
  }
  return withTransaction(async (conn) => {
    // 2. Simpan sebagai banner platform yang sudah disetujui.
    const [result] = await conn.query<ResultSetHeader>(
      `INSERT INTO banners (merchant_id, title, image_url, target, promo_id, status, starts_at, ends_at, sort_order, created_by, reviewed_by, reviewed_at)
       VALUES (NULL, ?, ?, ?, ?, 'disetujui', ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
      [
        input.title,
        input.image_url,
        input.target,
        input.target === "promo" ? input.promo_id : null,
        new Date(input.starts_at),
        new Date(input.ends_at),
        input.sort_order,
        adminId,
        adminId,
      ],
    );
    // 3. Catat di log audit admin.
    await recordAudit(conn, {
      adminId,
      action: "banner.create",
      targetType: "banner",
      targetId: result.insertId,
      after: { title: input.title, target: input.target },
    });
    return result.insertId;
  }).then(loadBanner);
}

// Nama tindakan di log audit untuk tiap status hasil tinjauan.
const AUDIT_ACTIONS: Record<string, string> = {
  disetujui: "banner.approve",
  ditolak: "banner.reject",
  nonaktif: "banner.deactivate",
};
// Jeda sebelum banner penjual boleh disetujui: masa berlaku URL unggah + 1 menit toleransi selisih jam.
const APPROVE_DELAY_SECONDS = PRESIGN_SECONDS + 60;

/**
 * Admin meninjau banner: mengubah status (setujui, tolak dengan alasan, nonaktifkan) dan urutan untuk semua banner.
 * Judul, gambar, dan masa tayang hanya bisa diubah untuk banner platform. Perubahan dicatat di log audit.
 * @param adminId id admin yang meninjau
 * @param idRaw   id banner dari alamat URL
 * @param body    isi permintaan mentah (diperiksa reviewBannerSchema)
 * @returns banner setelah ditinjau
 * @throws 400 isian tidak valid, 404 banner tidak ada, 409 banner penjual disetujui terlalu cepat setelah gambarnya
 *         diunggah
 */
export async function reviewBanner(adminId: number, idRaw: unknown, body: unknown) {
  // 1. Periksa isian.
  const parsed = reviewBannerSchema.safeParse(body);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) (fields[issue.path.join(".") || "body"] ??= []).push(issue.message);
    throw invalidFields(fields);
  }
  const input: ReviewBannerInput = parsed.data;
  const id = await withTransaction(async (conn) => {
    // 2. Kunci banner. URL unggah gambar (presigned URL: alamat unggah sementara yang sudah ditandatangani) bisa
    //    dipakai ulang selama masih berlaku, jadi penjual bisa mengganti isi gambar setelah diajukan. Karena itu
    //    banner penjual baru boleh disetujui setelah URL itu kedaluwarsa, dihitung dari updated_at (ikut berubah
    //    setiap kali penjual mengajukan atau mengubah banner).
    const banner = await lockRow(conn, "banners", idRaw, { notFound: "Banner tidak ditemukan." });
    if (input.status === "disetujui" && banner.merchant_id !== null && banner.status === "menunggu") {
      const [[ageRow]] = await conn.query<RowDataPacket[]>(
        "SELECT TIMESTAMPDIFF(SECOND, updated_at, CURRENT_TIMESTAMP) AS umur FROM banners WHERE id = ?",
        [banner.id],
      );
      if (Number(ageRow.umur) < APPROVE_DELAY_SECONDS) {
        throw new AppError(
          409,
          "CONFLICT",
          `Gambar banner baru saja diunggah. Setujui setelah ${APPROVE_DELAY_SECONDS / 60} menit.`,
        );
      }
    }
    // 3. Susun kolom yang berubah: isi (khusus banner platform), urutan, dan hasil tinjauan.
    const contentFields =
      banner.merchant_id === null
        ? {
            title: input.title,
            image_url: input.image_url,
            starts_at: input.starts_at && new Date(input.starts_at),
            ends_at: input.ends_at && new Date(input.ends_at),
          }
        : {};
    if (banner.merchant_id === null && input.image_url)
      validateImageUrl(input.image_url, banner.image_url, PLATFORM_PREFIX, "image_url");
    const changes: Record<string, unknown> = Object.fromEntries(
      Object.entries({ ...contentFields, sort_order: input.sort_order }).filter(([, value]) => value !== undefined),
    );
    if (input.status)
      Object.assign(changes, {
        status: input.status,
        catatan: input.status === "ditolak" ? input.catatan : (input.catatan ?? null),
        reviewed_by: adminId,
      });
    // 4. Simpan bila ada perubahan, lalu catat di log audit.
    const columns = Object.keys(changes);
    if (columns.length) {
      await conn.query(
        `UPDATE banners SET ${columns.map((column) => `${column} = ?`).join(", ")}${input.status ? ", reviewed_at = UTC_TIMESTAMP()" : ""} WHERE id = ?`,
        [...columns.map((column) => changes[column]), banner.id],
      );
      await recordAudit(conn, {
        adminId,
        action: input.status ? AUDIT_ACTIONS[input.status] : "banner.update",
        targetType: "banner",
        targetId: banner.id,
        before: { status: banner.status, catatan: banner.catatan ?? null },
        after: { status: input.status ?? banner.status, catatan: changes.catatan ?? banner.catatan ?? null },
      });
    }
    return banner.id as number;
  });
  return loadBanner(id);
}
