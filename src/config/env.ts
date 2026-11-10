import { z } from "zod";

// "" di .env = tidak diisi
const opsional = <T extends z.ZodType>(t: T) => z.preprocess((v) => (v === "" ? undefined : v), t.optional());

// format durasi jsonwebtoken, mis. "15m", "1d"
const ttl = z.string().regex(/^\d+[smhd]$/, "format durasi mis. 15m, 12h, 1d");

const R2_KEYS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_URL"] as const;
const SMTP_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"] as const;

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(5000),
    DATABASE_URL: z.string().startsWith("mysql://", "harus diawali mysql://"),
    JWT_SECRET: z.string().min(32, "minimal 32 karakter"),
    JWT_TTL_WEB: ttl.default("1d"),
    JWT_TTL_MOBILE: ttl.default("30d"),
    // rahasia server-ke-server (Next → API) agar X-Client-IP dipercaya; kosong = tidak dipakai
    INTERNAL_API_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(32, "minimal 32 karakter").optional()),
    // Cloudflare R2 untuk unggah foto (D13); kosong semua = unggah dimatikan (503)
    R2_ACCOUNT_ID: opsional(z.string()),
    R2_ACCESS_KEY_ID: opsional(z.string()),
    R2_SECRET_ACCESS_KEY: opsional(z.string()),
    R2_BUCKET: opsional(z.string()),
    R2_PUBLIC_URL: opsional(z.string().regex(/^https:\/\/[^/?#]+(\/[^?#]*)?$/, "harus URL https://").transform((v) => v.replace(/\/+$/, ""))),
    // F11: SMTP untuk OTP lupa sandi; kosong semua = kode ditulis ke log (production: 503)
    SMTP_HOST: opsional(z.string()),
    SMTP_PORT: opsional(z.coerce.number().int().positive()),
    SMTP_USER: opsional(z.string()),
    SMTP_PASS: opsional(z.string()),
    SMTP_FROM: opsional(z.string()),
    // F17: Gemini untuk asisten toko; kosong = asisten 503
    GEMINI_API_KEY: opsional(z.string()),
    GEMINI_MODEL: z.preprocess((v) => (v === "" ? undefined : v), z.string().default("gemini-2.5-flash")),
    // F10: VA lewat Midtrans Core API; kosong = VA dimatikan (checkout VA → 409)
    MIDTRANS_SERVER_KEY: opsional(z.string()),
    // "true" = transaksi sungguhan (api.midtrans.com); bawaan sandbox agar key production yang salah pasang tidak menarik uang
    MIDTRANS_IS_PRODUCTION: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["true", "false"]).default("false")),
    CORS_ORIGIN: z
      .string()
      .optional()
      .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [])),
  })
  .refine((e) => e.NODE_ENV !== "production" || e.CORS_ORIGIN.length > 0, {
    path: ["CORS_ORIGIN"],
    message: "wajib diisi di production",
  })
  .refine((e) => new Set(SMTP_KEYS.map((k) => e[k] === undefined)).size === 1, {
    path: ["SMTP"],
    message: "SMTP_* harus diisi semua atau dikosongkan semua",
  });

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Konfigurasi .env tidak valid — ${details}`);
  }
  // R2 terisi sebagian tidak menggagalkan start/release (unggah foto saja yang mati, lihat utils/r2.ts);
  // cukup peringatan berisi NAMA variabel (tanpa nilai) supaya salah pasang di Config Vars mudah dilacak.
  const r2Ada = R2_KEYS.filter((k) => result.data[k] !== undefined);
  if (r2Ada.length > 0 && r2Ada.length < R2_KEYS.length) {
    console.warn(`R2 terisi sebagian (${r2Ada.join(", ")}); kosong: ${R2_KEYS.filter((k) => !r2Ada.includes(k)).join(", ")}. Unggah foto dimatikan.`);
    for (const k of R2_KEYS) result.data[k] = undefined;
  }
  return result.data;
}

export const env = loadEnv(process.env);
