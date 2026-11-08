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
    CORS_ORIGIN: z
      .string()
      .optional()
      .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [])),
  })
  .refine((e) => e.NODE_ENV !== "production" || e.CORS_ORIGIN.length > 0, {
    path: ["CORS_ORIGIN"],
    message: "wajib diisi di production",
  })
  .refine((e) => new Set(R2_KEYS.map((k) => e[k] === undefined)).size === 1, {
    path: ["R2"],
    message: "R2_* harus diisi semua atau dikosongkan semua",
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
  return result.data;
}

export const env = loadEnv(process.env);
