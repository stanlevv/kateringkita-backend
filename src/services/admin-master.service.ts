import { RowDataPacket } from "mysql2";
import { z } from "zod";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { parse } from "../middleware/validate";
import { Conn, recordAudit, withTransaction, lockRow, withBooleanFlags } from "./admin-audit.service";

const nameField = (max: number) =>
  z
    .string({ error: "Nama wajib diisi." })
    .trim()
    .min(1, "Nama wajib diisi.")
    .max(max, `Nama maksimal ${max} karakter.`);
const sortOrder = z
  .number({ error: "Urutan harus angka." })
  .int("Urutan harus bilangan bulat.")
  .min(0, "Urutan tidak boleh negatif.");

// Per jenis data master: tabel, kolom yang boleh ditulis (hanya ini yang masuk SQL), urutan daftar.
const KINDS = {
  categories: {
    table: "categories",
    order: "sort_order, id",
    slug: true,
    create: z.object({ name: nameField(60), icon: z.string().trim().max(40, "Ikon maksimal 40 karakter.").nullish() }),
    update: z
      .object({
        name: nameField(60),
        icon: z.string().trim().max(40, "Ikon maksimal 40 karakter.").nullish(),
        sort_order: sortOrder,
      })
      .partial(),
  },
  "pickup-points": {
    table: "pickup_points",
    order: "name, id",
    slug: false,
    create: z.object({
      name: nameField(120),
      description: z.string().trim().max(255, "Deskripsi maksimal 255 karakter.").nullish(),
    }),
    update: z
      .object({
        name: nameField(120),
        description: z.string().trim().max(255, "Deskripsi maksimal 255 karakter.").nullish(),
      })
      .partial(),
  },
  "merchant-types": {
    table: "merchant_types",
    order: "sort_order, id",
    slug: false,
    create: z.object({ name: nameField(100) }),
    update: z.object({ name: nameField(100), sort_order: sortOrder }).partial(),
  },
} as const;
type Kind = keyof typeof KINDS;

const getKindConfig = (kind: string) => {
  if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) throw new AppError(404, "NOT_FOUND", "Data tidak ditemukan.");
  return KINDS[kind as Kind];
};
const rethrowDuplicateName = (error: unknown) => {
  if ((error as { code?: string })?.code === "ER_DUP_ENTRY") throw new AppError(409, "CONFLICT", "Nama sudah dipakai.");
  throw error;
};

export async function listMasterData(kind: string) {
  const config = getKindConfig(kind);
  const [rows] = await db.query<RowDataPacket[]>(`SELECT * FROM ${config.table} ORDER BY ${config.order}`);
  return rows.map(withBooleanFlags);
}

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "kategori";

export async function createMasterData(adminId: number, kind: string, body: unknown) {
  const config = getKindConfig(kind);
  const data: Record<string, unknown> = parse(config.create, body);
  try {
    return await withTransaction(async (conn) => {
      if (config.slug) {
        // slug dibuat sekali saat dibuat dan tidak berubah saat nama diganti (URL stabil untuk mobile)
        const base = slugify(String(data.name)).slice(0, 55).replace(/-+$/, ""); // sisakan ruang untuk "-N" (kolom 60)
        let slug = base;
        for (let suffix = 2; ; suffix++) {
          const [existing] = await conn.query<RowDataPacket[]>(`SELECT 1 FROM ${config.table} WHERE slug = ?`, [slug]);
          if (!existing.length) break;
          slug = `${base}-${suffix}`;
        }
        data.slug = slug;
      }
      if ("sort_order" in config.update.shape) {
        // item baru di urutan terakhir (default 0 akan tampil paling atas)
        const [maxRow] = await conn.query<RowDataPacket[]>(
          `SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM ${config.table}`,
        );
        data.sort_order = Number(maxRow[0].n);
      }
      const columns = Object.keys(data);
      const [insertResult] = await conn.query<any>(
        `INSERT INTO ${config.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        columns.map((column) => data[column] ?? null),
      );
      const [row] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${config.table} WHERE id = ?`, [
        insertResult.insertId,
      ]);
      await recordAudit(conn, {
        adminId,
        action: `master.${kind}.create`,
        targetType: kind,
        targetId: insertResult.insertId,
        after: withBooleanFlags(row[0]),
      });
      return withBooleanFlags(row[0]);
    });
  } catch (error) {
    return rethrowDuplicateName(error);
  }
}

export async function updateMasterData(adminId: number, kind: string, idRaw: unknown, body: unknown) {
  const config = getKindConfig(kind);
  const data: Record<string, unknown> = parse(config.update, body);
  const columns = Object.keys(data);
  if (!columns.length) throw new AppError(400, "VALIDATION_ERROR", "Tidak ada data yang diubah.");
  try {
    return await withTransaction(async (conn) => {
      const before = await lockRow(conn, config.table, idRaw);
      if (columns.every((column) => (data[column] ?? null) === before[column])) return withBooleanFlags(before); // tidak ada perubahan: tanpa log
      await conn.query(
        `UPDATE ${config.table} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`,
        [...columns.map((column) => data[column] ?? null), before.id],
      );
      const [after] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${config.table} WHERE id = ?`, [before.id]);
      const pick = (row: RowDataPacket) => Object.fromEntries(columns.map((column) => [column, row[column]]));
      await recordAudit(conn, {
        adminId,
        action: `master.${kind}.update`,
        targetType: kind,
        targetId: before.id,
        before: pick(before),
        after: pick(after[0]),
      });
      return withBooleanFlags(after[0]);
    });
  } catch (error) {
    return rethrowDuplicateName(error);
  }
}

// Menonaktifkan titik temu terakhir toko terverifikasi (pemilik aktif) → 409 dengan nama toko.
// Urutan kunci tetap (toko urut id -> titik temu) agar penonaktifan bersamaan terserialisasi tanpa deadlock.
async function guardLastPickupPoint(conn: Conn, idRaw: unknown) {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id < 1) throw new AppError(404, "NOT_FOUND", "Data tidak ditemukan.");
  // shortcut: tautan toko dibaca tanpa kunci; tautan yang masuk sebelum titik temu terkunci ditangkap pembacaan ulang di bawah (409 "coba lagi"). Sisa: gap lock InnoDB bisa memicu deadlock; terdeteksi MySQL dan muncul sebagai 500, jarang.
  const [links] = await conn.query<RowDataPacket[]>(
    "SELECT merchant_id FROM merchant_pickup_points WHERE pickup_point_id = ?",
    [id],
  );
  const merchantIds = links.map((link) => link.merchant_id).sort((left, right) => left - right);
  if (merchantIds.length)
    await conn.query("SELECT id FROM merchants WHERE id IN (?) ORDER BY id FOR UPDATE", [merchantIds]);
  const row = await lockRow(conn, "pickup_points", id);
  // titik temu sudah terkunci: tautan baru dari penjual tidak bisa masuk lagi, jadi baca ulang dan tolak bila ada toko yang terlewat
  // FOR UPDATE, bukan FOR SHARE: TiDB (production) menolak FOR SHARE (ER_NOT_SUPPORTED_YET)
  const [currentLinks] = await conn.query<RowDataPacket[]>(
    "SELECT merchant_id FROM merchant_pickup_points WHERE pickup_point_id = ? FOR UPDATE",
    [id],
  );
  if (currentLinks.some((link) => !merchantIds.includes(link.merchant_id)))
    throw new AppError(409, "CONFLICT", "Data titik temu berubah. Coba lagi.");
  if (!row.is_active || !merchantIds.length) return; // sudah nonaktif: setAktif membalas tanpa perubahan
  // Locking read setelah kunci toko: membaca data terbaru, bukan snapshot.
  const [merchants] = await conn.query<RowDataPacket[]>(
    `SELECT m.id, m.business_name FROM merchants m JOIN users u ON u.id = m.user_id
     WHERE m.id IN (?) AND m.verification_status = 'verified' AND u.is_active ORDER BY m.id FOR UPDATE`,
    [merchantIds],
  );
  if (!merchants.length) return;
  const [otherPoints] = await conn.query<RowDataPacket[]>(
    `SELECT DISTINCT o.merchant_id FROM merchant_pickup_points o JOIN pickup_points p ON p.id = o.pickup_point_id
     WHERE o.merchant_id IN (?) AND o.pickup_point_id <> ? AND p.is_active FOR UPDATE`,
    [merchants.map((merchant) => merchant.id), id],
  );
  const coveredIds = new Set(otherPoints.map((link) => link.merchant_id));
  const blocked = merchants.filter((merchant) => !coveredIds.has(merchant.id));
  if (blocked.length)
    throw new AppError(
      409,
      "CONFLICT",
      `Titik temu ini satu-satunya untuk toko: ${blocked.map((merchant) => merchant.business_name).join(", ")}.`,
    );
}

// Sudah dalam keadaan tujuan → 200 tanpa perubahan dan tanpa baris log (idempoten).
export async function setMasterActive(adminId: number, kind: string, idRaw: unknown, active: boolean) {
  const config = getKindConfig(kind);
  return withTransaction(async (conn) => {
    if (!active && kind === "pickup-points") await guardLastPickupPoint(conn, idRaw);
    const row = await lockRow(conn, config.table, idRaw);
    if (Boolean(row.is_active) === active) return withBooleanFlags(row);
    await conn.query(`UPDATE ${config.table} SET is_active = ? WHERE id = ?`, [active, row.id]);
    await recordAudit(conn, {
      adminId,
      action: `master.${kind}.${active ? "activate" : "deactivate"}`,
      targetType: kind,
      targetId: row.id,
      before: { is_active: Boolean(row.is_active) },
      after: { is_active: active },
    });
    return withBooleanFlags({ ...row, is_active: active } as RowDataPacket);
  });
}
