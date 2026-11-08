import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { dalamTransaksi, kunci, withBool } from "./admin-audit.service";
import { FIELD, kodeGanda, kodeSkema, nilai, rapikan } from "./admin-promo.service";
import { idToko } from "./merchant-menu.service";

// F12 promo toko: aturan isian sama dengan promo platform (rapikan); kode unik di seluruh tabel promos.
// Berbeda dengan admin: kode boleh diubah, status lewat PATCH is_active, boleh dihapus selama belum dipakai, tanpa log audit admin.
const dup = (e: unknown) => (e as { code?: string } | null)?.code === "ER_DUP_ENTRY";
const objek = (b: unknown) => (typeof b === "object" && b !== null && !Array.isArray(b) ? b : {}) as Record<string, unknown>;
const tidakValid = (field: string, pesan: string) => new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { [field]: [pesan] });

function aktifDari(b: Record<string, unknown>): boolean | undefined {
  if (!("is_active" in b)) return undefined;
  if (typeof b.is_active !== "boolean") throw tidakValid("is_active", "Status promo tidak valid.");
  return b.is_active;
}

// merchantId berasal dari DB (bilangan bulat), aman disisipkan ke klausa where milik kunci()
const kunciPromoToko = (conn: Parameters<typeof kunci>[0], merchantId: number, idRaw: unknown) =>
  kunci(conn, "promos", idRaw, { where: `merchant_id = ${Number(merchantId)}`, notFound: "Promo tidak ditemukan." });

export async function daftarPromoToko(userId: number) {
  const [rows] = await db.query<RowDataPacket[]>("SELECT * FROM promos WHERE merchant_id = ? ORDER BY id DESC", [await idToko(userId)]);
  return rows.map(withBool);
}

export async function buatPromoToko(userId: number, body: unknown) {
  const b = objek(body);
  const aktif = aktifDari(b) ?? true;
  const { code, data } = rapikan(b, 0, true);
  const merchantId = await idToko(userId);
  try {
    const [ins] = await db.query<ResultSetHeader>(
      `INSERT INTO promos (merchant_id, code, description, type, value, max_discount, min_subtotal, quota, per_user_limit, starts_at, ends_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [merchantId, code, data.description, data.type, data.value, data.max_discount, data.min_subtotal, data.quota, data.per_user_limit,
        data.starts_at, data.ends_at, aktif],
    );
    const [[row]] = await db.query<RowDataPacket[]>("SELECT * FROM promos WHERE id = ?", [ins.insertId]);
    return withBool(row);
  } catch (e) {
    if (dup(e)) throw kodeGanda();
    throw e;
  }
}

// PATCH sebagian: field yang tak dikirim memakai nilai tersimpan (pola ubahPromo admin)
export async function ubahPromoToko(userId: number, idRaw: unknown, body: unknown) {
  const merchantId = await idToko(userId);
  const b = objek(body);
  const aktif = aktifDari(b);
  try {
    return await dalamTransaksi(async (conn) => {
      const before = await kunciPromoToko(conn, merchantId, idRaw);
      const merged = {
        ...Object.fromEntries(FIELD.map((k) => [k, before[k] instanceof Date ? (before[k] as Date).toISOString() : before[k]])),
        ...Object.fromEntries(FIELD.filter((k) => k in b).map((k) => [k, b[k]])),
      };
      const baru: Record<string, unknown> = { ...rapikan(merged, before.used_count).data };
      if ("code" in b) {
        const c = kodeSkema.safeParse(b.code);
        if (!c.success) throw tidakValid("code", c.error.issues[0].message);
        baru.code = c.data;
      }
      if (aktif !== undefined) baru.is_active = aktif;
      const lama = withBool(before) as Record<string, unknown>;
      const cols = Object.keys(baru).filter((c) => nilai(baru[c]) !== nilai(lama[c]));
      if (cols.length) {
        await conn.query(`UPDATE promos SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...cols.map((c) => baru[c]), before.id]);
      }
      const [[after]] = await conn.query<RowDataPacket[]>("SELECT * FROM promos WHERE id = ?", [before.id]);
      return withBool(after);
    });
  } catch (e) {
    if (dup(e)) throw kodeGanda();
    throw e;
  }
}

export async function hapusPromoToko(userId: number, idRaw: unknown) {
  const merchantId = await idToko(userId);
  return dalamTransaksi(async (conn) => {
    const p = await kunciPromoToko(conn, merchantId, idRaw);
    if (p.used_count > 0) throw new AppError(409, "CONFLICT", "Promo sudah dipakai. Nonaktifkan saja.");
    await conn.query("DELETE FROM promos WHERE id = ?", [p.id]);
    return { id: p.id as number };
  });
}
