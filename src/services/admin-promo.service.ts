import { RowDataPacket } from "mysql2";
import { z } from "zod";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { fieldsDari, parse } from "../middleware/validate";
import { Conn, catat, dalamTransaksi, kunci, withBool } from "./admin-audit.service";

const bulat = (label: string, min: number) =>
  z.number({ error: `${label} wajib diisi.` }).int(`${label} harus bilangan bulat.`).min(min, `${label} minimal ${min}.`);
// ISO 8601 dengan "Z" atau offset eksplisit; string longgar ("1", "March 7") ditolak.
const waktu = (pesan: string) =>
  z.string({ error: pesan }).pipe(z.iso.datetime({ offset: true, error: pesan })).transform((s) => new Date(s));

// Aturan sama dengan fe/lib/schemas.ts cekPromo/bersihkanPromo; backend sumber kebenaran.
const skema = (terpakai: number) =>
  z
    .object({
      description: z.string({ error: "Deskripsi tidak valid." }).trim().max(255, "Maksimal 255 karakter.").nullish(),
      type: z.enum(["percent", "fixed", "free_service_fee"], { error: "Pilih jenis promo." }),
      value: z.number({ error: "Nilai wajib diisi." }).int("Nilai harus bilangan bulat."),
      max_discount: bulat("Maks potongan", 1).nullish(),
      min_subtotal: bulat("Min belanja", 0),
      quota: bulat("Kuota", 1).nullish(),
      per_user_limit: bulat("Batas per pembeli", 1),
      starts_at: waktu("Waktu mulai wajib diisi."),
      ends_at: waktu("Waktu selesai wajib diisi."),
    })
    .superRefine((d, ctx) => {
      const err = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
      if (d.type !== "free_service_fee") {
        if (d.value < 1) err("value", "Nilai minimal 1.");
        else if (d.type === "percent" && d.value > 100) err("value", "Persen maksimal 100.");
      }
      if (d.quota != null && d.quota < terpakai) err("quota", `Kuota tidak boleh di bawah yang sudah terpakai (${terpakai}).`);
      if (d.ends_at <= d.starts_at) err("ends_at", "Waktu selesai harus setelah waktu mulai.");
    });

export const kodeSkema = z.string({ error: "Kode wajib diisi." }).trim().toUpperCase().regex(/^[A-Z0-9]{3,30}$/, "Kode 3–30 huruf besar atau angka.");
export const FIELD = ["description", "type", "value", "max_discount", "min_subtotal", "quota", "per_user_limit", "starts_at", "ends_at"] as const;

// F12: dipakai juga promo toko (merchant-promo.service)
export function rapikan(input: unknown, terpakai: number, cekKode = false) {
  const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const pick = Object.fromEntries(FIELD.filter((k) => k in body).map((k) => [k, body[k]]));
  const fields: Record<string, string[]> = {};
  let kode: string | undefined;
  if (cekKode) {
    const c = kodeSkema.safeParse(body.code);
    if (c.success) kode = c.data; else fields.code = c.error.issues.map((i) => i.message);
  }
  const r = skema(terpakai).safeParse(pick);
  if (!r.success) Object.assign(fields, fieldsDari(r.error.issues));
  if (Object.keys(fields).length || !r.success) throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", fields);
  const d = r.data;
  return {
    code: kode,
    data: {
      description: d.description || null,
      type: d.type,
      value: d.type === "free_service_fee" ? 0 : d.value,
      max_discount: d.type === "percent" ? d.max_discount ?? null : null,
      min_subtotal: d.min_subtotal,
      quota: d.quota ?? null,
      per_user_limit: d.per_user_limit,
      starts_at: d.starts_at,
      ends_at: d.ends_at,
    },
  };
}

export const nilai = (v: unknown) => (v instanceof Date ? v.getTime() : v ?? null);
export const kodeGanda = () => new AppError(409, "CONFLICT", "Kode sudah dipakai.", { code: ["Kode sudah dipakai."] });

export async function daftarPromo() {
  const [rows] = await db.query<RowDataPacket[]>("SELECT * FROM promos WHERE merchant_id IS NULL ORDER BY id DESC");
  return rows.map(withBool);
}

export async function buatPromo(adminId: number, body: unknown) {
  const { code, data } = rapikan(body, 0, true);
  try {
    return await dalamTransaksi(async (conn) => {
      const [ins] = await conn.query<any>(
        "INSERT INTO promos (merchant_id, code, description, type, value, max_discount, min_subtotal, quota, per_user_limit, starts_at, ends_at) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [code, data.description, data.type, data.value, data.max_discount, data.min_subtotal, data.quota, data.per_user_limit, data.starts_at, data.ends_at],
      );
      const [row] = await conn.query<RowDataPacket[]>("SELECT * FROM promos WHERE id = ?", [ins.insertId]);
      await catat(conn, { adminId, action: "promo.create", targetType: "promo", targetId: ins.insertId, after: withBool(row[0]) });
      return withBool(row[0]);
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "ER_DUP_ENTRY") throw kodeGanda();
    throw e;
  }
}

const kunciPromo = (conn: Conn, idRaw: unknown) =>
  kunci(conn, "promos", idRaw, { where: "merchant_id IS NULL", notFound: "Promo tidak ditemukan." });

// PATCH sebagian: field yang tak dikirim memakai nilai tersimpan; kode & status tidak bisa diubah di sini.
export async function ubahPromo(adminId: number, idRaw: unknown, body: unknown) {
  return dalamTransaksi(async (conn) => {
    const before = await kunciPromo(conn, idRaw);
    const patch = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const merged = { ...Object.fromEntries(FIELD.map((k) => [k, before[k] instanceof Date ? (before[k] as Date).toISOString() : before[k]])), ...Object.fromEntries(FIELD.filter((k) => k in patch).map((k) => [k, patch[k]])) };
    const { data } = rapikan(merged, before.used_count);
    const cols = FIELD.filter((c) => nilai(data[c]) !== nilai(before[c]));
    if (!cols.length) return withBool(before); // tidak ada perubahan: tanpa log
    await conn.query(`UPDATE promos SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...cols.map((c) => data[c]), before.id]);
    const [after] = await conn.query<RowDataPacket[]>("SELECT * FROM promos WHERE id = ?", [before.id]);
    const pick = (r: Record<string, unknown>) => Object.fromEntries(cols.map((c) => [c, r[c]]));
    await catat(conn, { adminId, action: "promo.update", targetType: "promo", targetId: before.id, before: pick(before), after: pick(after[0]) });
    return withBool(after[0]);
  });
}

// Sudah dalam keadaan tujuan → 200 tanpa log (idempoten).
export async function setAktifPromo(adminId: number, idRaw: unknown, aktif: boolean) {
  return dalamTransaksi(async (conn) => {
    const row = await kunciPromo(conn, idRaw);
    if (Boolean(row.is_active) === aktif) return withBool(row);
    await conn.query("UPDATE promos SET is_active = ? WHERE id = ?", [aktif, row.id]);
    await catat(conn, { adminId, action: `promo.${aktif ? "activate" : "deactivate"}`, targetType: "promo", targetId: row.id, before: { is_active: !aktif }, after: { is_active: aktif } });
    return withBool({ ...row, is_active: aktif } as RowDataPacket);
  });
}

// --- Biaya layanan (app_settings.service_fee) ---
const biaya = z.object({
  value: z.number({ error: "Biaya wajib diisi." }).int("Biaya harus bilangan bulat.").min(0, "Biaya tidak boleh negatif.").max(100000, "Biaya maksimal 100.000."),
});

export async function ambilBiaya(conn: Pick<typeof db, "query"> = db): Promise<number> {
  const [rows] = await conn.query<RowDataPacket[]>("SELECT setting_value FROM app_settings WHERE setting_key = 'service_fee'");
  const n = parseInt(rows[0]?.setting_value ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
}

export async function ubahBiaya(adminId: number, body: unknown) {
  const { value } = parse(biaya, body, "value");
  return dalamTransaksi(async (conn) => {
    await conn.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('service_fee', '0')");
    await conn.query("SELECT setting_key FROM app_settings WHERE setting_key = 'service_fee' FOR UPDATE");
    const lama = await ambilBiaya(conn);
    if (lama === value) return { service_fee: lama };
    await conn.query("UPDATE app_settings SET setting_value = ? WHERE setting_key = 'service_fee'", [String(value)]);
    await catat(conn, { adminId, action: "settings.service_fee", targetType: "settings", targetId: "service_fee", before: { value: lama }, after: { value } });
    return { service_fee: value };
  });
}
