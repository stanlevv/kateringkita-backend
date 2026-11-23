import { z } from "zod";
import { imageUrlSchema } from "./upload.dto";

export const fullNameSchema = z
  .string("Nama lengkap wajib diisi.")
  .trim()
  .min(1, "Nama lengkap wajib diisi.")
  .max(150, "Nama lengkap maksimal 150 karakter.");
const emailSchema = z.string("Email wajib diisi.").trim().toLowerCase().pipe(z.email("Format email tidak valid."));
export const phoneSchema = z
  .string("Nomor HP wajib diisi.")
  .regex(/^08\d{8,11}$/, "Nomor HP harus diawali 08 dan 10–13 digit.");
export const passwordSchema = z
  .string("Kata sandi wajib diisi.")
  .min(8, "Kata sandi minimal 8 karakter.")
  .max(72, "Kata sandi maksimal 72 karakter.")
  .regex(/[A-Za-z]/, "Kata sandi harus mengandung huruf.")
  .regex(/\d/, "Kata sandi harus mengandung angka.");

export const registerCustomerSchema = z.object({
  full_name: fullNameSchema,
  email: emailSchema,
  phone: phoneSchema,
  password: passwordSchema,
});

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

// "" berarti "kosongkan email"; aturan per peran ada di service.updateMe
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

export const changePasswordSchema = z.object({
  current_password: z
    .string("Kata sandi lama wajib diisi.")
    .min(1, "Kata sandi lama wajib diisi.")
    .max(72, "Kata sandi maksimal 72 karakter."),
  new_password: passwordSchema,
});

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

export const normalizeIdentifier = (raw: string): { email: string } | { phone: string } =>
  raw.includes("@") ? { email: raw.trim().toLowerCase() } : { phone: raw.replace(/\D/g, "") };

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterCustomerInput = z.infer<typeof registerCustomerSchema>;
export type RegisterMerchantInput = z.infer<typeof registerMerchantSchema>;

// F11 lupa sandi (OTP email)
const OTP_CODE_MSG = "Kode berisi 6 angka.";
const otpCodeSchema = z.string(OTP_CODE_MSG).regex(/^\d{6}$/, OTP_CODE_MSG);
export const forgotPasswordSchema = z.object({ email: emailSchema });
export const verifyOtpSchema = z.object({ email: emailSchema, code: otpCodeSchema });
export const resetPasswordSchema = z.object({ email: emailSchema, code: otpCodeSchema, password: passwordSchema });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
