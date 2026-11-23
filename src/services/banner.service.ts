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
import { catat, dalamTransaksi, kunci } from "./admin-audit.service";
import { clock } from "./catalog.service";
import { getMerchantId } from "./merchant-menu.service";
import { validateImageUrl } from "./upload.service";
import { VoucherCard, getAvailableVoucher } from "./voucher.service";

// Banner beranda mobile (rancangan voucher 2026-11-16 §5.4). Penjual mengajukan (1 banner aktif per toko, tampil setelah
// disetujui admin); admin membuat banner platform (langsung tayang), menyetujui / menolak / menonaktifkan. Publik maks 8.
export const MAX_PUBLIC_BANNERS = 8;
const PLATFORM_PREFIX = "platform/banner/";
const merchantPrefix = (merchantId: number) => `merchants/${merchantId}/banner/`;

const BANNER_COLUMNS = `b.id, b.merchant_id, b.title, b.image_url, b.target, b.promo_id, b.status, b.catatan, b.starts_at, b.ends_at, b.sort_order,
  b.reviewed_at, b.created_at, p.code AS promo_code, m.slug, m.business_name`;
const BANNER_FROM_SQL =
  "banners b LEFT JOIN promos p ON p.id = b.promo_id LEFT JOIN merchants m ON m.id = b.merchant_id";

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

/** zod + cek gambar sekaligus, agar semua galat kolom keluar dalam satu respons. */
export function parseBodyWithImage<S extends z.ZodType>(schema: S, body: unknown, prefix: string): z.infer<S> {
  const parsed = schema.safeParse(body);
  const fields: Record<string, string[]> = {};
  if (!parsed.success)
    for (const issue of parsed.error.issues) (fields[issue.path.join(".") || "body"] ??= []).push(issue.message);
  const url = (body as { image_url?: unknown } | null)?.image_url;
  if (typeof url === "string" && url.trim()) {
    try {
      validateImageUrl(url.trim(), null, prefix, "image_url");
    } catch (error) {
      if (error instanceof AppError && error.fields) Object.assign(fields, error.fields);
      else throw error;
    }
  }
  if (Object.keys(fields).length || !parsed.success) throw invalidFields(fields);
  return parsed.data;
}

const loadBanner = async (id: number) => {
  const [[row]] = await db.query<RowDataPacket[]>(`SELECT ${BANNER_COLUMNS} FROM ${BANNER_FROM_SQL} WHERE b.id = ?`, [
    id,
  ]);
  return mapBanner(row);
};

// ---------------- publik ----------------
export type PublicBanner = {
  id: number;
  title: string;
  image_url: string;
  target: string;
  promo: VoucherCard | null;
  merchant: { id: number; slug: string; business_name: string } | null;
};

/** Maks 8 banner disetujui dalam periode: admin dulu (sort_order), lalu penjual (terbaru disetujui). */
export async function listPublicBanners(userId: number | null): Promise<PublicBanner[]> {
  const nowMs = clock.now();
  const now = new Date(nowMs);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${BANNER_COLUMNS} FROM ${BANNER_FROM_SQL} LEFT JOIN users u ON u.id = m.user_id
     WHERE b.status = 'disetujui' AND b.starts_at <= ? AND b.ends_at > ?
       AND (b.merchant_id IS NULL OR (m.verification_status = 'verified' AND u.is_active))
     ORDER BY b.merchant_id IS NULL DESC, b.sort_order, b.reviewed_at DESC, b.id LIMIT 40`,
    [now, now],
  );
  const banners: PublicBanner[] = [];
  for (const row of rows) {
    if (banners.length >= MAX_PUBLIC_BANNERS) break;
    let promo: VoucherCard | null = null;
    if (row.target === "promo") {
      // promo target mati / kedaluwarsa / disembunyikan → banner tidak tayang
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
export async function listMerchantBanners(userId: number) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${BANNER_COLUMNS} FROM ${BANNER_FROM_SQL} WHERE b.merchant_id = ? ORDER BY b.id DESC`,
    [await getMerchantId(userId)],
  );
  return rows.map(mapBanner);
}

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

async function ensureSingleActive(merchantId: number, excludeId: number | null) {
  const [[countRow]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM banners WHERE merchant_id = ? AND status IN ('menunggu', 'disetujui') AND ends_at > UTC_TIMESTAMP() AND id <> ?`,
    [merchantId, excludeId ?? 0],
  );
  if (Number(countRow.n) > 0) throw new AppError(409, "CONFLICT", "Toko ini sudah punya banner aktif.");
}

export async function createMerchantBanner(userId: number, body: unknown) {
  const merchantId = await getMerchantId(userId);
  const input: MerchantBannerInput = parseBodyWithImage(merchantBannerSchema, body, merchantPrefix(merchantId));
  const promoId = await validateMerchantPromo(merchantId, input.target, input.promo_id);
  await ensureSingleActive(merchantId, null);
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

/** Setiap perubahan oleh penjual mengembalikan banner ke antrean persetujuan admin. */
export async function updateMerchantBanner(userId: number, idRaw: unknown, body: unknown) {
  const merchantId = await getMerchantId(userId);
  const id = Number(idRaw);
  const [[banner]] =
    Number.isInteger(id) && id > 0
      ? await db.query<RowDataPacket[]>("SELECT * FROM banners WHERE id = ? AND merchant_id = ?", [id, merchantId])
      : [[]];
  if (!banner) throw bannerNotFound();
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
  if (banner.status === "ditolak" || banner.status === "nonaktif") await ensureSingleActive(merchantId, banner.id);
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
export async function listAdminBanners(status?: string) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${BANNER_COLUMNS} FROM ${BANNER_FROM_SQL} ${status ? "WHERE b.status = ?" : ""}
     ORDER BY b.status = 'menunggu' DESC, b.merchant_id IS NULL DESC, b.sort_order, b.id DESC`,
    status ? [status] : [],
  );
  return rows.map(mapBanner);
}

export async function createAdminBanner(adminId: number, body: unknown) {
  const input: AdminBannerInput = parseBodyWithImage(adminBannerSchema, body, PLATFORM_PREFIX);
  if (input.target === "promo") {
    const [[promo]] = input.promo_id
      ? await db.query<RowDataPacket[]>("SELECT id FROM promos WHERE id = ?", [input.promo_id])
      : [[]];
    if (!promo) throw invalidFields({ promo_id: ["Pilih voucher."] });
  }
  return dalamTransaksi(async (conn) => {
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
    await catat(conn, {
      adminId,
      action: "banner.create",
      targetType: "banner",
      targetId: result.insertId,
      after: { title: input.title, target: input.target },
    });
    return result.insertId;
  }).then(loadBanner);
}

const AUDIT_ACTIONS: Record<string, string> = {
  disetujui: "banner.approve",
  ditolak: "banner.reject",
  nonaktif: "banner.deactivate",
};
// masa berlaku presign + 1 menit toleransi selisih jam
const APPROVE_DELAY_SECONDS = PRESIGN_SECONDS + 60;

/** Status (setujui / tolak + alasan / nonaktifkan) & urutan untuk semua banner; isi hanya untuk banner platform. */
export async function reviewBanner(adminId: number, idRaw: unknown, body: unknown) {
  const parsed = reviewBannerSchema.safeParse(body);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) (fields[issue.path.join(".") || "body"] ??= []).push(issue.message);
    throw invalidFields(fields);
  }
  const input: ReviewBannerInput = parsed.data;
  const id = await dalamTransaksi(async (conn) => {
    const banner = await kunci(conn, "banners", idRaw, { notFound: "Banner tidak ditemukan." });
    // AUD-36: URL unggah (presign PUT) bisa dipakai ulang selama berlaku, jadi isi gambar pengajuan penjual baru pasti
    // setelah URL itu kedaluwarsa; pengajuan/ubahan penjual memperbarui updated_at
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
    const columns = Object.keys(changes);
    if (columns.length) {
      await conn.query(
        `UPDATE banners SET ${columns.map((column) => `${column} = ?`).join(", ")}${input.status ? ", reviewed_at = UTC_TIMESTAMP()" : ""} WHERE id = ?`,
        [...columns.map((column) => changes[column]), banner.id],
      );
      await catat(conn, {
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
