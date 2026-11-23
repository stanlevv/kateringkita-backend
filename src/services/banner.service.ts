import { ResultSetHeader, RowDataPacket } from "mysql2";
import { z } from "zod";
import db from "../config/db";
import {
  BannerAdmin,
  BannerToko,
  TinjauBanner,
  UbahBannerToko,
  bannerAdminSchema,
  bannerTokoSchema,
  tinjauBannerSchema,
  ubahBannerTokoSchema,
} from "../dto/banner.dto";
import { AppError } from "../utils/errors";
import { PRESIGN_SECONDS } from "../utils/r2";
import { catat, dalamTransaksi, kunci } from "./admin-audit.service";
import { jam } from "./catalog.service";
import { idToko } from "./merchant-menu.service";
import { validateImageUrl } from "./upload.service";
import { VoucherKartu, voucherTersedia } from "./voucher.service";

// Banner beranda mobile (rancangan voucher 2026-11-16 §5.4). Penjual mengajukan (1 banner aktif per toko, tampil setelah
// disetujui admin); admin membuat banner platform (langsung tayang), menyetujui / menolak / menonaktifkan. Publik maks 8.
export const MAKS_BANNER = 8;
const PREFIX_PLATFORM = "platform/banner/";
const prefixToko = (merchantId: number) => `merchants/${merchantId}/banner/`;

const KOLOM = `b.id, b.merchant_id, b.title, b.image_url, b.target, b.promo_id, b.status, b.catatan, b.starts_at, b.ends_at, b.sort_order,
  b.reviewed_at, b.created_at, p.code AS promo_code, m.slug, m.business_name`;
const DARI = "banners b LEFT JOIN promos p ON p.id = b.promo_id LEFT JOIN merchants m ON m.id = b.merchant_id";

const peta = (r: RowDataPacket) => ({
  id: r.id as number,
  title: r.title as string,
  image_url: r.image_url as string,
  target: r.target as string,
  promo: r.promo_id ? { id: r.promo_id as number, code: r.promo_code as string } : null,
  merchant: r.merchant_id
    ? { id: r.merchant_id as number, slug: r.slug as string, business_name: r.business_name as string }
    : null,
  status: r.status as string,
  catatan: (r.catatan as string | null) ?? null,
  starts_at: r.starts_at,
  ends_at: r.ends_at,
  sort_order: r.sort_order as number,
  reviewed_at: r.reviewed_at,
  created_at: r.created_at,
});

const tidakAda = () => new AppError(404, "NOT_FOUND", "Banner tidak ditemukan.");
const tidakValid = (fields: Record<string, string[]>) =>
  new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", fields);

/** zod + cek gambar sekaligus, agar semua galat kolom keluar dalam satu respons. */
export function rapikan<S extends z.ZodType>(skema: S, body: unknown, prefix: string): z.infer<S> {
  const r = skema.safeParse(body);
  const fields: Record<string, string[]> = {};
  if (!r.success) for (const i of r.error.issues) (fields[i.path.join(".") || "body"] ??= []).push(i.message);
  const url = (body as { image_url?: unknown } | null)?.image_url;
  if (typeof url === "string" && url.trim()) {
    try {
      validateImageUrl(url.trim(), null, prefix, "image_url");
    } catch (e) {
      if (e instanceof AppError && e.fields) Object.assign(fields, e.fields);
      else throw e;
    }
  }
  if (Object.keys(fields).length || !r.success) throw tidakValid(fields);
  return r.data;
}

const baris = async (id: number) => {
  const [[r]] = await db.query<RowDataPacket[]>(`SELECT ${KOLOM} FROM ${DARI} WHERE b.id = ?`, [id]);
  return peta(r);
};

// ---------------- publik ----------------
export type BannerPublik = {
  id: number;
  title: string;
  image_url: string;
  target: string;
  promo: VoucherKartu | null;
  merchant: { id: number; slug: string; business_name: string } | null;
};

/** Maks 8 banner disetujui dalam periode: admin dulu (sort_order), lalu penjual (terbaru disetujui). */
export async function bannerPublik(userId: number | null): Promise<BannerPublik[]> {
  const ms = jam.sekarang();
  const now = new Date(ms);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${KOLOM} FROM ${DARI} LEFT JOIN users u ON u.id = m.user_id
     WHERE b.status = 'disetujui' AND b.starts_at <= ? AND b.ends_at > ?
       AND (b.merchant_id IS NULL OR (m.verification_status = 'verified' AND u.is_active))
     ORDER BY b.merchant_id IS NULL DESC, b.sort_order, b.reviewed_at DESC, b.id LIMIT 40`,
    [now, now],
  );
  const hasil: BannerPublik[] = [];
  for (const r of rows) {
    if (hasil.length >= MAKS_BANNER) break;
    let promo: VoucherKartu | null = null;
    if (r.target === "promo") {
      // promo target mati / kedaluwarsa / disembunyikan → banner tidak tayang
      if (!r.promo_id || !(promo = await voucherTersedia(r.promo_id, userId, ms))) continue;
    }
    const p = peta(r);
    hasil.push({ id: p.id, title: p.title, image_url: p.image_url, target: p.target, promo, merchant: p.merchant });
  }
  return hasil;
}

// ---------------- penjual ----------------
export async function daftarBannerToko(userId: number) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${KOLOM} FROM ${DARI} WHERE b.merchant_id = ? ORDER BY b.id DESC`,
    [await idToko(userId)],
  );
  return rows.map(peta);
}

async function cekPromoToko(merchantId: number, target: string | undefined, promoId: number | null | undefined) {
  if (target !== "promo") return null;
  const [[p]] = promoId
    ? await db.query<RowDataPacket[]>("SELECT id FROM promos WHERE id = ? AND merchant_id = ?", [promoId, merchantId])
    : [[]];
  if (!p) throw tidakValid({ promo_id: ["Pilih voucher milik tokomu."] });
  return promoId as number;
}

async function cekSatuAktif(merchantId: number, kecuali: number | null) {
  const [[n]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM banners WHERE merchant_id = ? AND status IN ('menunggu', 'disetujui') AND ends_at > UTC_TIMESTAMP() AND id <> ?`,
    [merchantId, kecuali ?? 0],
  );
  if (Number(n.n) > 0) throw new AppError(409, "CONFLICT", "Toko ini sudah punya banner aktif.");
}

export async function buatBannerToko(userId: number, body: unknown) {
  const merchantId = await idToko(userId);
  const d: BannerToko = rapikan(bannerTokoSchema, body, prefixToko(merchantId));
  const promoId = await cekPromoToko(merchantId, d.target, d.promo_id);
  await cekSatuAktif(merchantId, null);
  const [r] = await db.query<ResultSetHeader>(
    `INSERT INTO banners (merchant_id, title, image_url, target, promo_id, status, starts_at, ends_at, created_by)
     VALUES (?, ?, ?, ?, ?, 'menunggu', ?, ?, ?)`,
    [merchantId, d.title, d.image_url, d.target, promoId, new Date(d.starts_at), new Date(d.ends_at), userId],
  );
  return baris(r.insertId);
}

/** Setiap perubahan oleh penjual mengembalikan banner ke antrean persetujuan admin. */
export async function ubahBannerToko(userId: number, idRaw: unknown, body: unknown) {
  const merchantId = await idToko(userId);
  const id = Number(idRaw);
  const [[b]] =
    Number.isInteger(id) && id > 0
      ? await db.query<RowDataPacket[]>("SELECT * FROM banners WHERE id = ? AND merchant_id = ?", [id, merchantId])
      : [[]];
  if (!b) throw tidakAda();
  const d: UbahBannerToko = rapikan(ubahBannerTokoSchema, body, prefixToko(merchantId));
  const target = d.target ?? b.target;
  const promoId = await cekPromoToko(merchantId, target, d.promo_id === undefined ? b.promo_id : d.promo_id);
  if (b.status === "ditolak" || b.status === "nonaktif") await cekSatuAktif(merchantId, b.id);
  await db.query(
    `UPDATE banners SET title = ?, image_url = ?, target = ?, promo_id = ?, starts_at = ?, ends_at = ?, status = 'menunggu', catatan = NULL,
       reviewed_by = NULL, reviewed_at = NULL WHERE id = ?`,
    [
      d.title ?? b.title,
      d.image_url ?? b.image_url,
      target,
      promoId,
      d.starts_at ? new Date(d.starts_at) : b.starts_at,
      d.ends_at ? new Date(d.ends_at) : b.ends_at,
      b.id,
    ],
  );
  return baris(b.id);
}

export async function hapusBannerToko(userId: number, idRaw: unknown) {
  const merchantId = await idToko(userId);
  const id = Number(idRaw);
  const [r] =
    Number.isInteger(id) && id > 0
      ? await db.query<ResultSetHeader>("DELETE FROM banners WHERE id = ? AND merchant_id = ?", [id, merchantId])
      : [{ affectedRows: 0 }];
  if (!r.affectedRows) throw tidakAda();
  return { id };
}

// ---------------- admin ----------------
export async function daftarBannerAdmin(status?: string) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${KOLOM} FROM ${DARI} ${status ? "WHERE b.status = ?" : ""}
     ORDER BY b.status = 'menunggu' DESC, b.merchant_id IS NULL DESC, b.sort_order, b.id DESC`,
    status ? [status] : [],
  );
  return rows.map(peta);
}

export async function buatBannerAdmin(adminId: number, body: unknown) {
  const d: BannerAdmin = rapikan(bannerAdminSchema, body, PREFIX_PLATFORM);
  if (d.target === "promo") {
    const [[p]] = d.promo_id
      ? await db.query<RowDataPacket[]>("SELECT id FROM promos WHERE id = ?", [d.promo_id])
      : [[]];
    if (!p) throw tidakValid({ promo_id: ["Pilih voucher."] });
  }
  return dalamTransaksi(async (conn) => {
    const [r] = await conn.query<ResultSetHeader>(
      `INSERT INTO banners (merchant_id, title, image_url, target, promo_id, status, starts_at, ends_at, sort_order, created_by, reviewed_by, reviewed_at)
       VALUES (NULL, ?, ?, ?, ?, 'disetujui', ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
      [
        d.title,
        d.image_url,
        d.target,
        d.target === "promo" ? d.promo_id : null,
        new Date(d.starts_at),
        new Date(d.ends_at),
        d.sort_order,
        adminId,
        adminId,
      ],
    );
    await catat(conn, {
      adminId,
      action: "banner.create",
      targetType: "banner",
      targetId: r.insertId,
      after: { title: d.title, target: d.target },
    });
    return r.insertId;
  }).then(baris);
}

const AKSI: Record<string, string> = {
  disetujui: "banner.approve",
  ditolak: "banner.reject",
  nonaktif: "banner.deactivate",
};
// masa berlaku presign + 1 menit toleransi selisih jam
const JEDA_SETUJUI_DETIK = PRESIGN_SECONDS + 60;

/** Status (setujui / tolak + alasan / nonaktifkan) & urutan untuk semua banner; isi hanya untuk banner platform. */
export async function tinjauBanner(adminId: number, idRaw: unknown, body: unknown) {
  const r = tinjauBannerSchema.safeParse(body);
  if (!r.success) {
    const fields: Record<string, string[]> = {};
    for (const i of r.error.issues) (fields[i.path.join(".") || "body"] ??= []).push(i.message);
    throw tidakValid(fields);
  }
  const d: TinjauBanner = r.data;
  const id = await dalamTransaksi(async (conn) => {
    const b = await kunci(conn, "banners", idRaw, { notFound: "Banner tidak ditemukan." });
    // AUD-36: URL unggah (presign PUT) bisa dipakai ulang selama berlaku, jadi isi gambar pengajuan penjual baru pasti
    // setelah URL itu kedaluwarsa; pengajuan/ubahan penjual memperbarui updated_at
    if (d.status === "disetujui" && b.merchant_id !== null && b.status === "menunggu") {
      const [[u]] = await conn.query<RowDataPacket[]>(
        "SELECT TIMESTAMPDIFF(SECOND, updated_at, CURRENT_TIMESTAMP) AS umur FROM banners WHERE id = ?",
        [b.id],
      );
      if (Number(u.umur) < JEDA_SETUJUI_DETIK) {
        throw new AppError(
          409,
          "CONFLICT",
          `Gambar banner baru saja diunggah. Setujui setelah ${JEDA_SETUJUI_DETIK / 60} menit.`,
        );
      }
    }
    const isi =
      b.merchant_id === null
        ? {
            title: d.title,
            image_url: d.image_url,
            starts_at: d.starts_at && new Date(d.starts_at),
            ends_at: d.ends_at && new Date(d.ends_at),
          }
        : {};
    if (b.merchant_id === null && d.image_url) validateImageUrl(d.image_url, b.image_url, PREFIX_PLATFORM, "image_url");
    const ubah: Record<string, unknown> = Object.fromEntries(
      Object.entries({ ...isi, sort_order: d.sort_order }).filter(([, v]) => v !== undefined),
    );
    if (d.status)
      Object.assign(ubah, {
        status: d.status,
        catatan: d.status === "ditolak" ? d.catatan : (d.catatan ?? null),
        reviewed_by: adminId,
      });
    const cols = Object.keys(ubah);
    if (cols.length) {
      await conn.query(
        `UPDATE banners SET ${cols.map((c) => `${c} = ?`).join(", ")}${d.status ? ", reviewed_at = UTC_TIMESTAMP()" : ""} WHERE id = ?`,
        [...cols.map((c) => ubah[c]), b.id],
      );
      await catat(conn, {
        adminId,
        action: d.status ? AKSI[d.status] : "banner.update",
        targetType: "banner",
        targetId: b.id,
        before: { status: b.status, catatan: b.catatan ?? null },
        after: { status: d.status ?? b.status, catatan: ubah.catatan ?? b.catatan ?? null },
      });
    }
    return b.id as number;
  });
  return baris(id);
}
