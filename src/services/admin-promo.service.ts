import { RowDataPacket } from "mysql2";
import { z } from "zod";
import db from "../config/db";
import { AppError } from "../utils/errors";
import { fieldsFromIssues, parse } from "../middleware/validate";
import { Conn, recordAudit, withTransaction, lockRow, withBooleanFlags } from "./admin-audit.service";

const integerField = (label: string, min: number) =>
  z
    .number({ error: `${label} wajib diisi.` })
    .int(`${label} harus bilangan bulat.`)
    .min(min, `${label} minimal ${min}.`);
// ISO 8601 dengan "Z" atau offset eksplisit; string longgar ("1", "March 7") ditolak.
const dateTimeField = (message: string) =>
  z
    .string({ error: message })
    .pipe(z.iso.datetime({ offset: true, error: message }))
    .transform((text) => new Date(text));

// Aturan sama dengan fe/lib/schemas.ts cekPromo/bersihkanPromo; backend sumber kebenaran.
const promoSchema = (usedCount: number) =>
  z
    .object({
      description: z.string({ error: "Deskripsi tidak valid." }).trim().max(255, "Maksimal 255 karakter.").nullish(),
      type: z.enum(["percent", "fixed", "free_service_fee"], { error: "Pilih jenis promo." }),
      value: z.number({ error: "Nilai wajib diisi." }).int("Nilai harus bilangan bulat."),
      max_discount: integerField("Maks potongan", 1).nullish(),
      min_subtotal: integerField("Min belanja", 0),
      quota: integerField("Kuota", 1).nullish(),
      per_user_limit: integerField("Batas per pembeli", 1),
      starts_at: dateTimeField("Waktu mulai wajib diisi."),
      ends_at: dateTimeField("Waktu selesai wajib diisi."),
    })
    .superRefine((promo, context) => {
      const addError = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
      if (promo.type !== "free_service_fee") {
        if (promo.value < 1) addError("value", "Nilai minimal 1.");
        else if (promo.type === "percent" && promo.value > 100) addError("value", "Persen maksimal 100.");
      }
      if (promo.quota != null && promo.quota < usedCount)
        addError("quota", `Kuota tidak boleh di bawah yang sudah terpakai (${usedCount}).`);
      if (promo.ends_at <= promo.starts_at) addError("ends_at", "Waktu selesai harus setelah waktu mulai.");
    });

export const promoCodeSchema = z
  .string({ error: "Kode wajib diisi." })
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{3,30}$/, "Kode 3–30 huruf besar atau angka.");
export const PROMO_FIELDS = [
  "description",
  "type",
  "value",
  "max_discount",
  "min_subtotal",
  "quota",
  "per_user_limit",
  "starts_at",
  "ends_at",
] as const;

// F12: dipakai juga promo toko (merchant-promo.service)
export function parsePromoInput(input: unknown, usedCount: number, checkCode = false) {
  const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const picked = Object.fromEntries(PROMO_FIELDS.filter((key) => key in body).map((key) => [key, body[key]]));
  const fields: Record<string, string[]> = {};
  let code: string | undefined;
  if (checkCode) {
    const codeResult = promoCodeSchema.safeParse(body.code);
    if (codeResult.success) code = codeResult.data;
    else fields.code = codeResult.error.issues.map((issue) => issue.message);
  }
  const result = promoSchema(usedCount).safeParse(picked);
  if (!result.success) Object.assign(fields, fieldsFromIssues(result.error.issues));
  if (Object.keys(fields).length || !result.success)
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", fields);
  const parsed = result.data;
  return {
    code,
    data: {
      description: parsed.description || null,
      type: parsed.type,
      value: parsed.type === "free_service_fee" ? 0 : parsed.value,
      max_discount: parsed.type === "percent" ? (parsed.max_discount ?? null) : null,
      min_subtotal: parsed.min_subtotal,
      quota: parsed.quota ?? null,
      per_user_limit: parsed.per_user_limit,
      starts_at: parsed.starts_at,
      ends_at: parsed.ends_at,
    },
  };
}

export const comparableValue = (value: unknown) => (value instanceof Date ? value.getTime() : (value ?? null));

/** is_public (voucher tampil & bisa diklaim): undefined bila tidak dikirim; selain boolean → 400. */
export function parseIsPublic(body: unknown): boolean | undefined {
  const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (!("is_public" in input)) return undefined;
  if (typeof input.is_public !== "boolean") {
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", {
      is_public: ["Pilihan tampil di halaman toko tidak valid."],
    });
  }
  return input.is_public;
}
export const duplicateCodeError = () =>
  new AppError(409, "CONFLICT", "Kode sudah dipakai.", { code: ["Kode sudah dipakai."] });

export async function listPromos() {
  const [rows] = await db.query<RowDataPacket[]>("SELECT * FROM promos WHERE merchant_id IS NULL ORDER BY id DESC");
  return rows.map(withBooleanFlags);
}

export async function createPromo(adminId: number, body: unknown) {
  const { code, data } = parsePromoInput(body, 0, true);
  const isPublic = parseIsPublic(body) ?? true;
  try {
    return await withTransaction(async (conn) => {
      const [insertResult] = await conn.query<any>(
        "INSERT INTO promos (merchant_id, code, description, type, value, max_discount, min_subtotal, quota, per_user_limit, starts_at, ends_at, is_public) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
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
          isPublic,
        ],
      );
      const [row] = await conn.query<RowDataPacket[]>("SELECT * FROM promos WHERE id = ?", [insertResult.insertId]);
      await recordAudit(conn, {
        adminId,
        action: "promo.create",
        targetType: "promo",
        targetId: insertResult.insertId,
        after: withBooleanFlags(row[0]),
      });
      return withBooleanFlags(row[0]);
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "ER_DUP_ENTRY") throw duplicateCodeError();
    throw error;
  }
}

const lockPromo = (conn: Conn, idRaw: unknown) =>
  lockRow(conn, "promos", idRaw, { where: "merchant_id IS NULL", notFound: "Promo tidak ditemukan." });

// PATCH sebagian: field yang tak dikirim memakai nilai tersimpan; kode & status tidak bisa diubah di sini.
export async function updatePromo(adminId: number, idRaw: unknown, body: unknown) {
  return withTransaction(async (conn) => {
    const before = await lockPromo(conn, idRaw);
    const patch = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const merged = {
      ...Object.fromEntries(
        PROMO_FIELDS.map((key) => [
          key,
          before[key] instanceof Date ? (before[key] as Date).toISOString() : before[key],
        ]),
      ),
      ...Object.fromEntries(PROMO_FIELDS.filter((key) => key in patch).map((key) => [key, patch[key]])),
    };
    const isPublic = parseIsPublic(patch);
    const data: Record<string, unknown> = {
      ...parsePromoInput(merged, before.used_count).data,
      ...(isPublic === undefined ? {} : { is_public: isPublic }),
    };
    const columns = [...PROMO_FIELDS, "is_public" as const].filter(
      (column) =>
        column in data &&
        comparableValue(data[column]) !==
          comparableValue(column === "is_public" ? Boolean(before[column]) : before[column]),
    );
    if (!columns.length) return withBooleanFlags(before); // tidak ada perubahan: tanpa log
    await conn.query(`UPDATE promos SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`, [
      ...columns.map((column) => data[column]),
      before.id,
    ]);
    const [after] = await conn.query<RowDataPacket[]>("SELECT * FROM promos WHERE id = ?", [before.id]);
    const pick = (row: Record<string, unknown>) => Object.fromEntries(columns.map((column) => [column, row[column]]));
    await recordAudit(conn, {
      adminId,
      action: "promo.update",
      targetType: "promo",
      targetId: before.id,
      before: pick(before),
      after: pick(after[0]),
    });
    return withBooleanFlags(after[0]);
  });
}

// Sudah dalam keadaan tujuan → 200 tanpa log (idempoten).
export async function setPromoActive(adminId: number, idRaw: unknown, active: boolean) {
  return withTransaction(async (conn) => {
    const row = await lockPromo(conn, idRaw);
    if (Boolean(row.is_active) === active) return withBooleanFlags(row);
    await conn.query("UPDATE promos SET is_active = ? WHERE id = ?", [active, row.id]);
    await recordAudit(conn, {
      adminId,
      action: `promo.${active ? "activate" : "deactivate"}`,
      targetType: "promo",
      targetId: row.id,
      before: { is_active: !active },
      after: { is_active: active },
    });
    return withBooleanFlags({ ...row, is_active: active } as RowDataPacket);
  });
}

// --- Biaya layanan (app_settings.service_fee) ---
const serviceFeeSchema = z.object({
  value: z
    .number({ error: "Biaya wajib diisi." })
    .int("Biaya harus bilangan bulat.")
    .min(0, "Biaya tidak boleh negatif.")
    .max(100000, "Biaya maksimal 100.000."),
});

export async function getServiceFee(conn: Pick<typeof db, "query"> = db): Promise<number> {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT setting_value FROM app_settings WHERE setting_key = 'service_fee'",
  );
  const fee = parseInt(rows[0]?.setting_value ?? "0", 10);
  return Number.isFinite(fee) ? fee : 0;
}

export async function updateServiceFee(adminId: number, body: unknown) {
  const { value } = parse(serviceFeeSchema, body, "value");
  return withTransaction(async (conn) => {
    await conn.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('service_fee', '0')");
    await conn.query("SELECT setting_key FROM app_settings WHERE setting_key = 'service_fee' FOR UPDATE");
    const previous = await getServiceFee(conn);
    if (previous === value) return { service_fee: previous };
    await conn.query("UPDATE app_settings SET setting_value = ? WHERE setting_key = 'service_fee'", [String(value)]);
    await recordAudit(conn, {
      adminId,
      action: "settings.service_fee",
      targetType: "settings",
      targetId: "service_fee",
      before: { value: previous },
      after: { value },
    });
    return { service_fee: value };
  });
}

// --- Kontak CS (app_settings.cs_whatsapp); "" = belum diatur ---
export async function getCsContact(): Promise<string | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT setting_value FROM app_settings WHERE setting_key = 'cs_whatsapp'",
  );
  return rows[0]?.setting_value || null;
}

export async function updateCsContact(adminId: number, waNumber: string) {
  return withTransaction(async (conn) => {
    await conn.query("INSERT IGNORE INTO app_settings (setting_key, setting_value) VALUES ('cs_whatsapp', '')");
    const [[row]] = await conn.query<RowDataPacket[]>(
      "SELECT setting_value FROM app_settings WHERE setting_key = 'cs_whatsapp' FOR UPDATE",
    );
    const previous = row.setting_value || null;
    const updated = waNumber || null;
    if (previous === updated) return { cs_whatsapp: previous };
    await conn.query("UPDATE app_settings SET setting_value = ? WHERE setting_key = 'cs_whatsapp'", [waNumber]);
    await recordAudit(conn, {
      adminId,
      action: "settings.cs_whatsapp",
      targetType: "settings",
      targetId: "cs_whatsapp",
      before: { value: previous },
      after: { value: updated },
    });
    return { cs_whatsapp: updated };
  });
}
