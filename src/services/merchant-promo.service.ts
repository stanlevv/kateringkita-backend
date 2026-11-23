import { ResultSetHeader, RowDataPacket } from "mysql2";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { dalamTransaksi, kunci, withBool } from "./admin-audit.service";
import { FIELD, kodeGanda, kodeSkema, nilai, publikDari, rapikan } from "./admin-promo.service";
import { getMerchantId } from "./merchant-menu.service";
import { kabariPromoToko } from "./admin-pengumuman.service";

// F12 promo toko: aturan isian sama dengan promo platform (rapikan); kode unik di seluruh tabel promos.
// Berbeda dengan admin: kode boleh diubah, status lewat PATCH is_active, boleh dihapus selama belum dipakai, tanpa log audit admin.
const isDuplicateKey = (error: unknown) => (error as { code?: string } | null)?.code === "ER_DUP_ENTRY";
const toObject = (body: unknown) =>
  (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
const invalidField = (field: string, message: string) =>
  new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { [field]: [message] });

function readIsActive(body: Record<string, unknown>): boolean | undefined {
  if (!("is_active" in body)) return undefined;
  if (typeof body.is_active !== "boolean") throw invalidField("is_active", "Status promo tidak valid.");
  return body.is_active;
}

// merchantId berasal dari DB (bilangan bulat), aman disisipkan ke klausa where milik kunci()
const lockMerchantPromo = (conn: Parameters<typeof kunci>[0], merchantId: number, idRaw: unknown) =>
  kunci(conn, "promos", idRaw, { where: `merchant_id = ${Number(merchantId)}`, notFound: "Promo tidak ditemukan." });

export async function listMerchantPromos(userId: number) {
  const [rows] = await db.query<RowDataPacket[]>("SELECT * FROM promos WHERE merchant_id = ? ORDER BY id DESC", [
    await getMerchantId(userId),
  ]);
  return rows.map(withBool);
}

// C2: biaya layanan milik platform, jadi voucher toko hanya potongan persen / nominal (promo lama jenis itu tetap berlaku)
const rejectFreeServiceFee = (type: unknown) => {
  if (type === "free_service_fee") throw invalidField("type", "Promo toko hanya potongan persen atau nominal.");
};

export async function createMerchantPromo(userId: number, body: unknown) {
  const input = toObject(body);
  const isActive = readIsActive(input) ?? true;
  const isPublic = publikDari(input) ?? true;
  const { code, data } = rapikan(input, 0, true);
  rejectFreeServiceFee(data.type);
  const merchantId = await getMerchantId(userId);
  try {
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
    const [[row]] = await db.query<RowDataPacket[]>("SELECT * FROM promos WHERE id = ?", [insertResult.insertId]);
    await kabariPromoToko(row);
    return withBool(row);
  } catch (error) {
    if (isDuplicateKey(error)) throw kodeGanda();
    throw error;
  }
}

// PATCH sebagian: field yang tak dikirim memakai nilai tersimpan (pola ubahPromo admin)
export async function updateMerchantPromo(userId: number, idRaw: unknown, body: unknown) {
  const merchantId = await getMerchantId(userId);
  const input = toObject(body);
  const isActive = readIsActive(input);
  const isPublic = publikDari(input);
  try {
    const { after, activated } = await dalamTransaksi(async (conn) => {
      const before = await lockMerchantPromo(conn, merchantId, idRaw);
      // C2: promo toko lama "free_service_fee" tetap berlaku & bisa diubah; yang dilarang hanya mengganti jenis ke sana
      if ("type" in input && input.type !== before.type) rejectFreeServiceFee(input.type);
      const merged = {
        ...Object.fromEntries(
          FIELD.map((field) => [
            field,
            before[field] instanceof Date ? (before[field] as Date).toISOString() : before[field],
          ]),
        ),
        ...Object.fromEntries(FIELD.filter((field) => field in input).map((field) => [field, input[field]])),
      };
      const updated: Record<string, unknown> = { ...rapikan(merged, before.used_count).data };
      if ("code" in input) {
        const parsedCode = kodeSkema.safeParse(input.code);
        if (!parsedCode.success) throw invalidField("code", parsedCode.error.issues[0].message);
        updated.code = parsedCode.data;
      }
      if (isActive !== undefined) updated.is_active = isActive;
      if (isPublic !== undefined) updated.is_public = isPublic;
      const previous = withBool(before) as Record<string, unknown>;
      const columns = Object.keys(updated).filter((column) => nilai(updated[column]) !== nilai(previous[column]));
      if (columns.length) {
        await conn.query(`UPDATE promos SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`, [
          ...columns.map((column) => updated[column]),
          before.id,
        ]);
      }
      const [[after]] = await conn.query<RowDataPacket[]>("SELECT * FROM promos WHERE id = ?", [before.id]);
      return { after, activated: !previous.is_active && Boolean(after.is_active) };
    });
    if (activated) await kabariPromoToko(after);
    return withBool(after);
  } catch (error) {
    if (isDuplicateKey(error)) throw kodeGanda();
    throw error;
  }
}

export async function deleteMerchantPromo(userId: number, idRaw: unknown) {
  const merchantId = await getMerchantId(userId);
  return dalamTransaksi(async (conn) => {
    const promo = await lockMerchantPromo(conn, merchantId, idRaw);
    if (promo.used_count > 0) throw new AppError(409, "CONFLICT", "Promo sudah dipakai. Nonaktifkan saja.");
    await conn.query("DELETE FROM promos WHERE id = ?", [promo.id]);
    return { id: promo.id as number };
  });
}
