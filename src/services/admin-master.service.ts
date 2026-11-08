import { RowDataPacket } from "mysql2";
import { z } from "zod";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { parse } from "../middleware/validate";
import { Conn, catat, dalamTransaksi, kunci, withBool } from "./admin-audit.service";

const name = (max: number) => z.string({ error: "Nama wajib diisi." }).trim().min(1, "Nama wajib diisi.").max(max, `Nama maksimal ${max} karakter.`);
const sortOrder = z.number({ error: "Urutan harus angka." }).int("Urutan harus bilangan bulat.").min(0, "Urutan tidak boleh negatif.");

// Per jenis data master: tabel, kolom yang boleh ditulis (hanya ini yang masuk SQL), urutan daftar.
const KINDS = {
  categories: {
    table: "categories", order: "sort_order, id", slug: true,
    create: z.object({ name: name(60), icon: z.string().trim().max(40, "Ikon maksimal 40 karakter.").nullish() }),
    update: z.object({ name: name(60), icon: z.string().trim().max(40, "Ikon maksimal 40 karakter.").nullish(), sort_order: sortOrder }).partial(),
  },
  "pickup-points": {
    table: "pickup_points", order: "name, id", slug: false,
    create: z.object({ name: name(120), description: z.string().trim().max(255, "Deskripsi maksimal 255 karakter.").nullish() }),
    update: z.object({ name: name(120), description: z.string().trim().max(255, "Deskripsi maksimal 255 karakter.").nullish() }).partial(),
  },
  "merchant-types": {
    table: "merchant_types", order: "sort_order, id", slug: false,
    create: z.object({ name: name(100) }),
    update: z.object({ name: name(100), sort_order: sortOrder }).partial(),
  },
} as const;
type Kind = keyof typeof KINDS;

const kindOf = (k: string) => {
  if (!Object.prototype.hasOwnProperty.call(KINDS, k)) throw new AppError(404, "NOT_FOUND", "Data tidak ditemukan.");
  return KINDS[k as Kind];
};
const duplikat = (e: unknown) => {
  if ((e as { code?: string })?.code === "ER_DUP_ENTRY") throw new AppError(409, "CONFLICT", "Nama sudah dipakai.");
  throw e;
};

export async function daftarMaster(kind: string) {
  const k = kindOf(kind);
  const [rows] = await db.query<RowDataPacket[]>(`SELECT * FROM ${k.table} ORDER BY ${k.order}`);
  return rows.map(withBool);
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "kategori";

export async function buatMaster(adminId: number, kind: string, body: unknown) {
  const k = kindOf(kind);
  const data: Record<string, unknown> = parse(k.create, body);
  try {
    return await dalamTransaksi(async (conn) => {
      if (k.slug) {
        // slug dibuat sekali saat dibuat dan tidak berubah saat nama diganti (URL stabil untuk mobile)
        const base = slugify(String(data.name)).slice(0, 55).replace(/-+$/, ""); // sisakan ruang untuk "-N" (kolom 60)
        let slug = base;
        for (let n = 2; ; n++) {
          const [hit] = await conn.query<RowDataPacket[]>(`SELECT 1 FROM ${k.table} WHERE slug = ?`, [slug]);
          if (!hit.length) break;
          slug = `${base}-${n}`;
        }
        data.slug = slug;
      }
      if ("sort_order" in k.update.shape) {
        // item baru di urutan terakhir (default 0 akan tampil paling atas)
        const [mx] = await conn.query<RowDataPacket[]>(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM ${k.table}`);
        data.sort_order = Number(mx[0].n);
      }
      const cols = Object.keys(data);
      const [ins] = await conn.query<any>(`INSERT INTO ${k.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => data[c] ?? null));
      const [row] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${k.table} WHERE id = ?`, [ins.insertId]);
      await catat(conn, { adminId, action: `master.${kind}.create`, targetType: kind, targetId: ins.insertId, after: withBool(row[0]) });
      return withBool(row[0]);
    });
  } catch (e) {
    return duplikat(e);
  }
}

export async function ubahMaster(adminId: number, kind: string, idRaw: unknown, body: unknown) {
  const k = kindOf(kind);
  const data: Record<string, unknown> = parse(k.update, body);
  const cols = Object.keys(data);
  if (!cols.length) throw new AppError(400, "VALIDATION_ERROR", "Tidak ada data yang diubah.");
  try {
    return await dalamTransaksi(async (conn) => {
      const before = await kunci(conn, k.table, idRaw);
      if (cols.every((c) => (data[c] ?? null) === before[c])) return withBool(before); // tidak ada perubahan: tanpa log
      await conn.query(`UPDATE ${k.table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...cols.map((c) => data[c] ?? null), before.id]);
      const [after] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${k.table} WHERE id = ?`, [before.id]);
      const pick = (r: RowDataPacket) => Object.fromEntries(cols.map((c) => [c, r[c]]));
      await catat(conn, { adminId, action: `master.${kind}.update`, targetType: kind, targetId: before.id, before: pick(before), after: pick(after[0]) });
      return withBool(after[0]);
    });
  } catch (e) {
    return duplikat(e);
  }
}

// Menonaktifkan titik temu terakhir toko terverifikasi (pemilik aktif) → 409 dengan nama toko.
// Urutan kunci tetap (toko urut id -> titik temu) agar penonaktifan bersamaan terserialisasi tanpa deadlock.
async function cekTitikTemuTerakhir(conn: Conn, idRaw: unknown) {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id < 1) throw new AppError(404, "NOT_FOUND", "Data tidak ditemukan.");
  // shortcut: tautan toko dibaca tanpa kunci; tautan yang masuk sebelum titik temu terkunci ditangkap pembacaan ulang di bawah (409 "coba lagi"). Sisa: gap lock InnoDB bisa memicu deadlock; terdeteksi MySQL dan muncul sebagai 500, jarang.
  const [links] = await conn.query<RowDataPacket[]>("SELECT merchant_id FROM merchant_pickup_points WHERE pickup_point_id = ?", [id]);
  const tokoIds = links.map((l) => l.merchant_id).sort((a, b) => a - b);
  if (tokoIds.length) await conn.query("SELECT id FROM merchants WHERE id IN (?) ORDER BY id FOR UPDATE", [tokoIds]);
  const row = await kunci(conn, "pickup_points", id);
  // titik temu sudah terkunci: tautan baru dari penjual tidak bisa masuk lagi, jadi baca ulang dan tolak bila ada toko yang terlewat
  const [terkini] = await conn.query<RowDataPacket[]>("SELECT merchant_id FROM merchant_pickup_points WHERE pickup_point_id = ? FOR SHARE", [id]);
  if (terkini.some((l) => !tokoIds.includes(l.merchant_id))) throw new AppError(409, "CONFLICT", "Data titik temu berubah. Coba lagi.");
  if (!row.is_active || !tokoIds.length) return; // sudah nonaktif: setAktif membalas tanpa perubahan
  // Locking read setelah kunci toko: membaca data terbaru, bukan snapshot.
  const [toko] = await conn.query<RowDataPacket[]>(
    `SELECT m.id, m.business_name FROM merchants m JOIN users u ON u.id = m.user_id
     WHERE m.id IN (?) AND m.verification_status = 'verified' AND u.is_active ORDER BY m.id FOR UPDATE`,
    [tokoIds],
  );
  if (!toko.length) return;
  const [cadangan] = await conn.query<RowDataPacket[]>(
    `SELECT DISTINCT o.merchant_id FROM merchant_pickup_points o JOIN pickup_points p ON p.id = o.pickup_point_id
     WHERE o.merchant_id IN (?) AND o.pickup_point_id <> ? AND p.is_active FOR UPDATE`,
    [toko.map((t) => t.id), id],
  );
  const aman = new Set(cadangan.map((c) => c.merchant_id));
  const blok = toko.filter((t) => !aman.has(t.id));
  if (blok.length) throw new AppError(409, "CONFLICT", `Titik temu ini satu-satunya untuk toko: ${blok.map((b) => b.business_name).join(", ")}.`);
}

// Sudah dalam keadaan tujuan → 200 tanpa perubahan dan tanpa baris log (idempoten).
export async function setAktif(adminId: number, kind: string, idRaw: unknown, aktif: boolean) {
  const k = kindOf(kind);
  return dalamTransaksi(async (conn) => {
    if (!aktif && kind === "pickup-points") await cekTitikTemuTerakhir(conn, idRaw);
    const row = await kunci(conn, k.table, idRaw);
    if (Boolean(row.is_active) === aktif) return withBool(row);
    await conn.query(`UPDATE ${k.table} SET is_active = ? WHERE id = ?`, [aktif, row.id]);
    await catat(conn, { adminId, action: `master.${kind}.${aktif ? "activate" : "deactivate"}`, targetType: kind, targetId: row.id, before: { is_active: Boolean(row.is_active) }, after: { is_active: aktif } });
    return withBool({ ...row, is_active: aktif } as RowDataPacket);
  });
}
