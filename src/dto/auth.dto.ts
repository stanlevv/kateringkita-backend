// Isi file: skema zod untuk isi permintaan rute akun: daftar, login, ubah profil, ganti sandi, dan lupa sandi.
// zod adalah pustaka validasi: skema menuliskan aturan bentuk data (wajib/opsional, panjang, format), lalu
// middleware validate di routes/auth.ts memeriksa isi permintaan dengan skema ini sebelum handler berjalan.
// Isi yang tidak lolos dijawab 400 beserta pesan per kolom. Nama kunci di sini adalah kontrak JSON dengan aplikasi.
import { z } from "zod";
import { imageUrlSchema } from "./upload.dto";

/** Aturan nama lengkap: teks 1–150 karakter, spasi di ujung dibuang. Dipakai juga di admin.dto dan create-admin. */
export const fullNameSchema = z
  .string("Nama lengkap wajib diisi.")
  .trim()
  .min(1, "Nama lengkap wajib diisi.")
  .max(150, "Nama lengkap maksimal 150 karakter.");
// Aturan email: spasi di ujung dibuang dan diubah ke huruf kecil dulu, baru format emailnya diperiksa.
const emailSchema = z.string("Email wajib diisi.").trim().toLowerCase().pipe(z.email("Format email tidak valid."));
/**
 * Aturan nomor HP: diawali 08, total 10–13 angka, tanpa spasi atau tanda lain. Dipakai juga di admin.dto dan
 * create-admin.
 */
export const phoneSchema = z
  .string("Nomor HP wajib diisi.")
  .regex(/^08\d{8,11}$/, "Nomor HP harus diawali 08 dan 10–13 digit.");
/**
 * Aturan kata sandi baru: 8–72 karakter, berisi minimal satu huruf dan satu angka. Batas 72 karena bcrypt hanya
 * membaca 72 byte pertama. Dipakai juga skrip create-admin dan seed-demo.
 */
export const passwordSchema = z
  .string("Kata sandi wajib diisi.")
  .min(8, "Kata sandi minimal 8 karakter.")
  .max(72, "Kata sandi maksimal 72 karakter.")
  .regex(/[A-Za-z]/, "Kata sandi harus mengandung huruf.")
  .regex(/\d/, "Kata sandi harus mengandung angka.");

/** Isi `POST /auth/customer/register`: pembeli wajib mengisi nama, email, nomor HP, dan kata sandi. */
export const registerCustomerSchema = z.object({
  full_name: fullNameSchema,
  email: emailSchema,
  phone: phoneSchema,
  password: passwordSchema,
});

/**
 * Isi `POST /auth/merchant/register`: data pemilik (email boleh kosong; teks kosong dianggap tidak diisi) dan data
 * toko (nama usaha, jenis usaha, alamat).
 */
export const registerMerchantSchema = z.object({
  full_name: fullNameSchema,
  phone: phoneSchema,
  email: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    emailSchema.optional(),
  ),
  password: passwordSchema,
  business_name: z
    .string("Nama usaha wajib diisi.")
    .trim()
    .min(1, "Nama usaha wajib diisi.")
    .max(150, "Nama usaha maksimal 150 karakter."),
  merchant_type_id: z.number("Jenis usaha wajib dipilih.").int("Jenis usaha wajib dipilih."),
  address: z
    .string("Alamat wajib diisi.")
    .trim()
    .min(1, "Alamat wajib diisi.")
    .max(255, "Alamat maksimal 255 karakter."),
});

/**
 * Isi `PATCH /me`: semua kolom opsional. Email `null` atau teks kosong diubah menjadi `""`, yang berarti "kosongkan
 * email"; boleh tidaknya ditentukan per peran di auth.service updateMe. `current_password` wajib bila email atau nomor
 * HP berubah (juga dicek di service).
 */
export const updateMeSchema = z.object({
  full_name: fullNameSchema.optional(),
  phone: phoneSchema.optional(),
  email: z
    .preprocess(
      (value) => (value === null || (typeof value === "string" && value.trim() === "") ? "" : value),
      z.union([z.literal(""), emailSchema], "Format email tidak valid."),
    )
    .optional(),
  avatar_url: imageUrlSchema,
  favorite_pickup_point_id: z
    .number("Titik temu tidak tersedia.")
    .int("Titik temu tidak tersedia.")
    .nullable()
    .optional(),
  current_password: z
    .string("Kata sandi lama wajib diisi.")
    .min(1, "Kata sandi lama wajib diisi.")
    .max(72, "Kata sandi maksimal 72 karakter.")
    .optional(),
});

/** Isi `PUT /me/password`: kata sandi lama (hanya dicek tidak kosong) dan kata sandi baru yang memenuhi aturan. */
export const changePasswordSchema = z.object({
  current_password: z
    .string("Kata sandi lama wajib diisi.")
    .min(1, "Kata sandi lama wajib diisi.")
    .max(72, "Kata sandi maksimal 72 karakter."),
  new_password: passwordSchema,
});

/**
 * Isi `POST /auth/login`: email atau nomor HP/WA di satu kolom `identifier`, kata sandi, dan jenis klien (`web` atau
 * `mobile`). Kata sandi cukup tidak kosong; aturan kekuatan sandi hanya berlaku saat membuat sandi baru.
 */
export const loginSchema = z.object({
  identifier: z
    .string("Email atau nomor WA wajib diisi.")
    .trim()
    .min(1, "Email atau nomor WA wajib diisi.")
    .max(255, "Email atau nomor WA terlalu panjang."),
  password: z
    .string("Kata sandi wajib diisi.")
    .min(1, "Kata sandi wajib diisi.")
    .max(72, "Kata sandi maksimal 72 karakter."),
  client: z.enum(["web", "mobile"], "Jenis klien tidak valid."),
});

/**
 * Menentukan apakah teks login adalah email atau nomor HP. Ada "@" berarti email (spasi di awal dan akhir dibuang,
 * huruf kecil);
 * selain itu nomor HP (semua selain angka dibuang, contoh "0812-3456" → "08123456").
 * @param raw teks yang diketik di kolom login
 * @returns `{ email }` atau `{ phone }`
 */
export const normalizeIdentifier = (raw: string): { email: string } | { phone: string } =>
  raw.includes("@") ? { email: raw.trim().toLowerCase() } : { phone: raw.replace(/\D/g, "") };

/** Isi ganti sandi yang sudah lolos {@link changePasswordSchema}. */
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
/** Isi ubah profil yang sudah lolos {@link updateMeSchema}. */
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
/** Isi login yang sudah lolos {@link loginSchema}. */
export type LoginInput = z.infer<typeof loginSchema>;
/** Isi daftar pembeli yang sudah lolos {@link registerCustomerSchema}. */
export type RegisterCustomerInput = z.infer<typeof registerCustomerSchema>;
/** Isi daftar penjual yang sudah lolos {@link registerMerchantSchema}. */
export type RegisterMerchantInput = z.infer<typeof registerMerchantSchema>;

// Lupa sandi lewat kode OTP (kode 6 angka sekali pakai) yang dikirim ke email.
const OTP_CODE_MSG = "Kode berisi 6 angka.";
const otpCodeSchema = z.string(OTP_CODE_MSG).regex(/^\d{6}$/, OTP_CODE_MSG);
/**
 * Isi `POST /me/email/otp`: tanpa `email` (atau email yang sama) berarti verifikasi email akun sekarang; email lain
 * berarti ganti email, dan `current_password` wajib (dicek di service).
 */
export const emailOtpSchema = z.object({
  email: emailSchema.optional(),
  current_password: z
    .string("Kata sandi lama wajib diisi.")
    .min(1, "Kata sandi lama wajib diisi.")
    .max(72, "Kata sandi maksimal 72 karakter.")
    .optional(),
});
/** Isi `POST /me/email/otp` yang sudah lolos {@link emailOtpSchema}. */
export type EmailOtpInput = z.infer<typeof emailOtpSchema>;
/** Isi `POST /me/email/verify`: kode 6 angka dari email. */
export const emailVerifySchema = z.object({ code: otpCodeSchema });
/** Isi `POST /auth/password/forgot`: email tujuan kode. */
export const forgotPasswordSchema = z.object({ email: emailSchema });
/** Isi `POST /auth/password/verify`: email dan kode 6 angka. */
export const verifyOtpSchema = z.object({ email: emailSchema, code: otpCodeSchema });
/** Isi `POST /auth/password/reset`: email, kode 6 angka, dan kata sandi baru yang memenuhi aturan. */
export const resetPasswordSchema = z.object({ email: emailSchema, code: otpCodeSchema, password: passwordSchema });
/** Isi reset sandi yang sudah lolos {@link resetPasswordSchema}. */
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
