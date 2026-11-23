import { z } from "zod";

// "" di .env = tidak diisi
const optional = <T extends z.ZodType>(fieldSchema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), fieldSchema.optional());

// format durasi jsonwebtoken, mis. "15m", "1d"
const durationSchema = z.string().regex(/^\d+[smhd]$/, "format durasi mis. 15m, 12h, 1d");

const R2_KEYS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_URL"] as const;
const SMTP_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"] as const;

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(5000),
    DATABASE_URL: z.string().startsWith("mysql://", "harus diawali mysql://"),
    JWT_SECRET: z.string().min(32, "minimal 32 karakter"),
    JWT_TTL_WEB: durationSchema.default("1d"),
    JWT_TTL_MOBILE: durationSchema.default("30d"),
    // rahasia server-ke-server (Next → API) agar X-Client-IP dipercaya; kosong = tidak dipakai
    INTERNAL_API_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(32, "minimal 32 karakter").optional(),
    ),
    // Cloudflare R2 untuk unggah foto (D13); kosong semua = unggah dimatikan (503)
    R2_ACCOUNT_ID: optional(z.string()),
    R2_ACCESS_KEY_ID: optional(z.string()),
    R2_SECRET_ACCESS_KEY: optional(z.string()),
    R2_BUCKET: optional(z.string()),
    R2_PUBLIC_URL: optional(
      z
        .string()
        .regex(/^https:\/\/[^/?#]+(\/[^?#]*)?$/, "harus URL https://")
        .transform((url) => url.replace(/\/+$/, "")),
    ),
    // F11: SMTP untuk OTP lupa sandi; kosong semua = kode ditulis ke log (production: 503)
    SMTP_HOST: optional(z.string()),
    SMTP_PORT: optional(z.coerce.number().int().positive()),
    SMTP_USER: optional(z.string()),
    SMTP_PASS: optional(z.string()),
    SMTP_FROM: optional(z.string()),
    // F17: Gemini untuk asisten toko; kosong = asisten 503
    GEMINI_API_KEY: optional(z.string()),
    GEMINI_MODEL: z.preprocess((value) => (value === "" ? undefined : value), z.string().default("gemini-2.5-flash")),
    // F10: VA lewat Midtrans Core API; kosong = VA dimatikan (checkout VA → 409)
    MIDTRANS_SERVER_KEY: optional(z.string()),
    // Sejak 28 Okt 2026 notifikasi Midtrans ditandatangani Signature Secret Key, bukan Server Key; kosong = pakai Server Key (akun lama)
    MIDTRANS_SIGNATURE_KEY: optional(z.string()),
    // "true" = transaksi sungguhan (api.midtrans.com); bawaan sandbox agar key production yang salah pasang tidak menarik uang
    MIDTRANS_IS_PRODUCTION: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["true", "false"]).default("false"),
    ),
    CORS_ORIGIN: z
      .string()
      .optional()
      .transform((rawOrigins) =>
        rawOrigins
          ? rawOrigins
              .split(",")
              .map((originUrl) => originUrl.trim())
              .filter(Boolean)
          : [],
      ),
  })
  .refine((config) => config.NODE_ENV !== "production" || config.CORS_ORIGIN.length > 0, {
    path: ["CORS_ORIGIN"],
    message: "wajib diisi di production",
  })
  .refine((config) => new Set(SMTP_KEYS.map((key) => config[key] === undefined)).size === 1, {
    path: ["SMTP"],
    message: "SMTP_* harus diisi semua atau dikosongkan semua",
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Konfigurasi .env tidak valid — ${details}`);
  }
  // R2 terisi sebagian tidak menggagalkan start/release (unggah foto saja yang mati, lihat utils/r2.ts);
  // cukup peringatan berisi NAMA variabel (tanpa nilai) supaya salah pasang di Config Vars mudah dilacak.
  const filledR2Keys = R2_KEYS.filter((key) => result.data[key] !== undefined);
  if (filledR2Keys.length > 0 && filledR2Keys.length < R2_KEYS.length) {
    console.warn(
      `R2 terisi sebagian (${filledR2Keys.join(", ")}); kosong: ${R2_KEYS.filter((key) => !filledR2Keys.includes(key)).join(", ")}. Unggah foto dimatikan.`,
    );
    for (const key of R2_KEYS) result.data[key] = undefined;
  }
  return result.data;
}

export const env = loadEnv(process.env);
