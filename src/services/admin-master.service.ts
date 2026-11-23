// Isi file: kelola data master oleh admin (super dan ops) lewat /admin/master/:kind. Data master = daftar pilihan
// yang dipakai seluruh aplikasi: kategori menu (`categories`), titik temu atau tempat ambil pesanan (`pickup-points`),
// dan jenis usaha toko (`merchant-types`). Alurnya routes/admin.ts → handlers/admin.handler.ts → file ini → database.
// Data master tidak dihapus, hanya dinonaktifkan. Setiap perubahan dicatat di log audit (`master.<kind>.<aksi>`).
import { RowDataPacket } from "mysql2";
import { z } from "zod";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { parse } from "../middleware/validate";
import { Conn, recordAudit, withTransaction, lockRow, withBooleanFlags } from "./admin-audit.service";

// Aturan kolom nama: wajib, spasi di ujung dibuang, panjang maksimal sesuai kolom tabel.
const nameField = (max: number) =>
  z
    .string({ error: "Nama wajib diisi." })
    .trim()
    .min(1, "Nama wajib diisi.")
    .max(max, `Nama maksimal ${max} karakter.`);
// Urutan tampil: bilangan bulat 0 atau lebih (kecil tampil lebih dulu).
const sortOrder = z
  .number({ error: "Urutan harus angka." })
  .int("Urutan harus bilangan bulat.")
  .min(0, "Urutan tidak boleh negatif.");

// Per jenis data master: nama tabel, urutan daftar, perlu slug atau tidak, dan skema zod untuk buat dan ubah. Hanya
// kolom yang ada di skema yang bisa masuk SQL, jadi nama kolom tidak pernah datang dari input pengguna.
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

// Jenis data master dari URL; jenis yang tidak dikenal dijawab 404.
const getKindConfig = (kind: string) => {
  if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) throw new AppError(404, "NOT_FOUND", "Data tidak ditemukan.");
  return KINDS[kind as Kind];
};
// Galat MySQL "nilai kembar" (nama atau slug sudah ada) diubah menjadi 409; galat lain diteruskan.
const rethrowDuplicateName = (error: unknown) => {
  if ((error as { code?: string })?.code === "ER_DUP_ENTRY") throw new AppError(409, "CONFLICT", "Nama sudah dipakai.");
  throw error;
};

/**
 * Daftar semua data master satu jenis, termasuk yang nonaktif.
 * @param kind jenis dari URL: `categories`, `pickup-points`, atau `merchant-types`
 * @returns semua baris tabel itu, `is_active` berupa boolean
 * @throws 404 jenis tidak dikenal
 */
export async function listMasterData(kind: string) {
  const config = getKindConfig(kind);
  const [rows] = await db.query<RowDataPacket[]>(`SELECT * FROM ${config.table} ORDER BY ${config.order}`);
  return rows.map(withBooleanFlags);
}

// Nama menjadi slug untuk URL: huruf kecil, selain huruf/angka diganti "-" (contoh "Nasi Kotak!" → "nasi-kotak").
const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "kategori";

/**
 * Menambah satu data master. Kategori mendapat slug unik (ditambah "-2", "-3", ... bila sudah dipakai); jenis yang
 * punya urutan ditaruh di urutan terakhir. Dicatat di log audit `master.<kind>.create`.
 * @param adminId id admin yang menambah
 * @param kind    jenis data master dari URL
 * @param body    isi permintaan, diperiksa skema `create` jenis itu
 * @returns baris baru
 * @throws 400 isi tidak valid, 404 jenis tidak dikenal, 409 nama sudah dipakai
 */
export async function createMasterData(adminId: number, kind: string, body: unknown) {
  // 1. Periksa jenis dan isi permintaan.
  const config = getKindConfig(kind);
  const data: Record<string, unknown> = parse(config.create, body);
  try {
    return await withTransaction(async (conn) => {
      // 2. Kategori: buat slug unik. Slug dibuat sekali dan tidak ikut berubah saat nama diganti (URL stabil
      //    untuk aplikasi mobile).
      if (config.slug) {
        const base = slugify(String(data.name)).slice(0, 55).replace(/-+$/, ""); // sisakan ruang untuk "-N" (kolom 60)
        let slug = base;
        for (let suffix = 2; ; suffix++) {
          const [existing] = await conn.query<RowDataPacket[]>(`SELECT 1 FROM ${config.table} WHERE slug = ?`, [slug]);
          if (!existing.length) break;
          slug = `${base}-${suffix}`;
        }
        data.slug = slug;
      }
      // 3. Jenis yang punya urutan: data baru di urutan terakhir (bawaan 0 akan tampil paling atas).
      if ("sort_order" in config.update.shape) {
        const [maxRow] = await conn.query<RowDataPacket[]>(
          `SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM ${config.table}`,
        );
        data.sort_order = Number(maxRow[0].n);
      }
      // 4. Simpan, baca ulang barisnya, lalu catat di log audit.
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

/**
 * Mengubah sebagian kolom satu data master (slug kategori tidak ikut berubah). Bila nilainya sama dengan yang
 * tersimpan, tidak ada yang ditulis dan tidak ada log. Log audit `master.<kind>.update` hanya memuat kolom yang
 * dikirim.
 * @param adminId id admin yang mengubah
 * @param kind    jenis data master dari URL
 * @param idRaw   id data dari URL
 * @param body    isi permintaan, diperiksa skema `update` jenis itu
 * @returns baris sesudah diubah
 * @throws 400 isi tidak valid atau kosong, 404 jenis atau data tidak ada, 409 nama sudah dipakai
 */
export async function updateMasterData(adminId: number, kind: string, idRaw: unknown, body: unknown) {
  // 1. Periksa isi; minimal satu kolom harus dikirim.
  const config = getKindConfig(kind);
  const data: Record<string, unknown> = parse(config.update, body);
  const columns = Object.keys(data);
  if (!columns.length) throw new AppError(400, "VALIDATION_ERROR", "Tidak ada data yang diubah.");
  try {
    return await withTransaction(async (conn) => {
      // 2. Kunci barisnya; bila semua nilai sama dengan yang tersimpan, selesai tanpa menulis dan tanpa log.
      const before = await lockRow(conn, config.table, idRaw);
      if (columns.every((column) => (data[column] ?? null) === before[column])) return withBooleanFlags(before);
      // 3. Simpan perubahan, lalu catat nilai lama dan baru kolom yang dikirim di log audit.
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

// Penjaga sebelum titik temu dinonaktifkan: tolak 409 (dengan nama tokonya) bila titik temu ini satu-satunya titik
// temu aktif bagi toko terverifikasi yang pemiliknya aktif, karena pembeli toko itu jadi tidak punya tempat ambil.
// Urutan kunci selalu sama (toko urut id, lalu titik temu) supaya penonaktifan bersamaan antre tanpa saling mengunci
// (deadlock).
async function guardLastPickupPoint(conn: Conn, idRaw: unknown) {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id < 1) throw new AppError(404, "NOT_FOUND", "Data tidak ditemukan.");
  // 1. Baca toko yang memakai titik temu ini, lalu kunci toko-toko itu urut id.
  // shortcut: tautan toko dibaca tanpa kunci; tautan yang masuk sebelum titik temu terkunci ditangkap pembacaan ulang
  // di bawah (409 "coba lagi"). Sisa: gap lock InnoDB bisa memicu deadlock; terdeteksi MySQL dan muncul sebagai 500,
  // jarang.
  const [links] = await conn.query<RowDataPacket[]>(
    "SELECT merchant_id FROM merchant_pickup_points WHERE pickup_point_id = ?",
    [id],
  );
  const merchantIds = links.map((link) => link.merchant_id).sort((left, right) => left - right);
  if (merchantIds.length)
    await conn.query("SELECT id FROM merchants WHERE id IN (?) ORDER BY id FOR UPDATE", [merchantIds]);
  // 2. Kunci titik temunya. Setelah ini tautan baru dari penjual tidak bisa masuk lagi, jadi tautan dibaca ulang dan
  //    permintaan ditolak bila ada toko yang terlewat di langkah 1. Memakai FOR UPDATE, bukan FOR SHARE, karena
  //    TiDB (database production) menolak FOR SHARE.
  const row = await lockRow(conn, "pickup_points", id);
  const [currentLinks] = await conn.query<RowDataPacket[]>(
    "SELECT merchant_id FROM merchant_pickup_points WHERE pickup_point_id = ? FOR UPDATE",
    [id],
  );
  if (currentLinks.some((link) => !merchantIds.includes(link.merchant_id)))
    throw new AppError(409, "CONFLICT", "Data titik temu berubah. Coba lagi.");
  // 3. Sudah nonaktif atau tidak dipakai toko mana pun: tidak ada yang perlu dijaga.
  if (!row.is_active || !merchantIds.length) return;
  // 4. Ambil toko terverifikasi dengan pemilik aktif. Pembacaan berkunci membaca data terbaru, bukan salinan lama.
  const [merchants] = await conn.query<RowDataPacket[]>(
    `SELECT m.id, m.business_name FROM merchants m JOIN users u ON u.id = m.user_id
     WHERE m.id IN (?) AND m.verification_status = 'verified' AND u.is_active ORDER BY m.id FOR UPDATE`,
    [merchantIds],
  );
  if (!merchants.length) return;
  // 5. Cari toko yang masih punya titik temu aktif lain; toko yang tidak punya membuat permintaan ditolak.
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

/**
 * Mengaktifkan atau menonaktifkan satu data master. Bila sudah dalam keadaan tujuan, dijawab 200 tanpa perubahan dan
 * tanpa log (idempoten: diulang berkali-kali hasilnya sama). Dicatat di log audit `master.<kind>.activate` atau
 * `master.<kind>.deactivate`.
 * @param adminId id admin yang mengubah
 * @param kind    jenis data master dari URL
 * @param idRaw   id data dari URL
 * @param active  `true` untuk mengaktifkan, `false` untuk menonaktifkan
 * @returns baris sesudah diubah
 * @throws 404 jenis atau data tidak ada, 409 titik temu terakhir bagi toko terverifikasi atau tautannya baru berubah
 */
export async function setMasterActive(adminId: number, kind: string, idRaw: unknown, active: boolean) {
  const config = getKindConfig(kind);
  return withTransaction(async (conn) => {
    // 1. Menonaktifkan titik temu: jalankan penjaga titik temu terakhir dulu.
    if (!active && kind === "pickup-points") await guardLastPickupPoint(conn, idRaw);
    // 2. Kunci barisnya; sudah dalam keadaan tujuan berarti selesai tanpa log.
    const row = await lockRow(conn, config.table, idRaw);
    if (Boolean(row.is_active) === active) return withBooleanFlags(row);
    // 3. Simpan dan catat di log audit.
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
