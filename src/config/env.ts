// Isi file: membaca dan memeriksa variabel lingkungan (env, isi file .env atau pengaturan server) sekali saat aplikasi
// mulai. Kalau ada yang salah, aplikasi berhenti dengan pesan jelas sebelum menerima request. Semua file lain membaca
// konfigurasi lewat objek `env` dari sini, bukan langsung dari `process.env`.
import { z } from "zod";

// Variabel yang ditulis kosong (`X=` di .env) dianggap tidak diisi.
const optional = <Schema extends z.ZodType>(fieldSchema: Schema) =>
  z.preprocess((value) => (value === "" ? undefined : value), fieldSchema.optional());

// Format masa berlaku token yang dipahami pustaka jsonwebtoken, contoh "15m", "12h", "1d".
const durationSchema = z.string().regex(/^\d+[smhd]$/, "format durasi mis. 15m, 12h, 1d");

const R2_KEYS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_URL"] as const;
const SMTP_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"] as const;

// Aturan setiap variabel. JWT = token login yang ditandatangani server dengan JWT_SECRET; masa berlakunya diatur
// JWT_TTL_WEB (browser) dan JWT_TTL_MOBILE (aplikasi HP).
const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(5000),
    DATABASE_URL: z.string().startsWith("mysql://", "harus diawali mysql://"),
    JWT_SECRET: z.string().min(32, "minimal 32 karakter"),
    JWT_TTL_WEB: durationSchema.default("1d"),
    JWT_TTL_MOBILE: durationSchema.default("30d"),
    // Rahasia bersama server web (Next) dan API. Hanya permintaan yang membawa rahasia ini yang boleh mengirim IP asli
    // pengunjung lewat header X-Client-IP. Kosong = fitur ini tidak dipakai.
    INTERNAL_API_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(32, "minimal 32 karakter").optional(),
    ),
    // Cloudflare R2 (penyimpanan file) untuk unggah foto. Kosong semua = unggah dimatikan (dijawab 503).
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
    // Server email (SMTP) untuk kode OTP lupa sandi. Kosong semua = kode hanya ditulis ke log (di production: 503).
    SMTP_HOST: optional(z.string()),
    SMTP_PORT: optional(z.coerce.number().int().positive()),
    SMTP_USER: optional(z.string()),
    SMTP_PASS: optional(z.string()),
    SMTP_FROM: optional(z.string()),
    // Gemini (AI Google) untuk asisten toko. Kosong = asisten dijawab 503.
    GEMINI_API_KEY: optional(z.string()),
    GEMINI_MODEL: z.preprocess((value) => (value === "" ? undefined : value), z.string().default("gemini-2.5-flash")),
    // Kunci Midtrans (penyedia pembayaran online: Virtual Account, QRIS, e-wallet). Kosong = pembayaran online mati.
    MIDTRANS_SERVER_KEY: optional(z.string()),
    // Sejak 28 Okt 2026 notifikasi Midtrans ditandatangani Signature Secret Key, bukan Server Key; kosong = pakai
    // Server Key (akun lama)
    MIDTRANS_SIGNATURE_KEY: optional(z.string()),
    // "true" = transaksi sungguhan (api.midtrans.com); bawaan sandbox agar key production yang salah pasang tidak
    // menarik uang
    MIDTRANS_IS_PRODUCTION: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.enum(["true", "false"]).default("false"),
    ),
    // Alamat web yang boleh memanggil API dari browser (CORS), dipisah koma; diubah menjadi daftar.
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

/** Bentuk konfigurasi yang sudah diperiksa: setiap variabel env dengan tipe dan nilai bawaannya. */
export type Env = z.infer<typeof envSchema>;

/**
 * Memeriksa sekumpulan variabel lingkungan terhadap aturan di atas dan mengisi nilai bawaan.
 * Variabel R2 yang hanya terisi sebagian tidak menggagalkan start: semuanya dikosongkan (unggah foto mati) dan
 * dicetak peringatan berisi NAMA variabel yang terisi dan yang kosong (tanpa nilainya), supaya salah pasang di
 * pengaturan server mudah dilacak.
 * @param source variabel lingkungan mentah, biasanya `process.env`
 * @returns konfigurasi yang sudah diperiksa
 * @throws Error berisi daftar variabel yang salah beserta alasannya, bila ada aturan yang dilanggar
 */
export function loadEnv(source: Record<string, string | undefined>): Env {
  // 1. Periksa semua variabel sekaligus; kumpulkan semua kesalahan dalam satu pesan.
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Konfigurasi .env tidak valid — ${details}`);
  }
  // 2. R2 terisi sebagian: beri peringatan lalu kosongkan semuanya supaya unggah foto mati dengan rapi.
  const filledR2Keys = R2_KEYS.filter((key) => result.data[key] !== undefined);
  if (filledR2Keys.length > 0 && filledR2Keys.length < R2_KEYS.length) {
    console.warn(
      `R2 terisi sebagian (${filledR2Keys.join(", ")}); kosong: ${R2_KEYS.filter((key) => !filledR2Keys.includes(key)).join(", ")}. Unggah foto dimatikan.`,
    );
    for (const key of R2_KEYS) result.data[key] = undefined;
  }
  return result.data;
}

/** Konfigurasi aplikasi yang dibaca dari `process.env` saat file ini pertama kali diimpor. */
export const env = loadEnv(process.env);
