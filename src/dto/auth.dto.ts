import { z } from "zod";
import { urlFoto } from "./upload.dto";

export const fullName = z.string("Nama lengkap wajib diisi.").trim().min(1, "Nama lengkap wajib diisi.").max(150, "Nama lengkap maksimal 150 karakter.");
const email = z.string("Email wajib diisi.").trim().toLowerCase().pipe(z.email("Format email tidak valid."));
export const phone = z.string("Nomor HP wajib diisi.").regex(/^08\d{8,11}$/, "Nomor HP harus diawali 08 dan 10–13 digit.");
export const password = z
  .string("Kata sandi wajib diisi.")
  .min(8, "Kata sandi minimal 8 karakter.")
  .max(72, "Kata sandi maksimal 72 karakter.")
  .regex(/[A-Za-z]/, "Kata sandi harus mengandung huruf.")
  .regex(/\d/, "Kata sandi harus mengandung angka.");

export const registerCustomerSchema = z.object({ full_name: fullName, email, phone, password });

export const registerMerchantSchema = z.object({
  full_name: fullName,
  phone,
  email: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), email.optional()),
  password,
  business_name: z.string("Nama usaha wajib diisi.").trim().min(1, "Nama usaha wajib diisi.").max(150, "Nama usaha maksimal 150 karakter."),
  merchant_type_id: z.number("Jenis usaha wajib dipilih.").int("Jenis usaha wajib dipilih."),
  address: z.string("Alamat wajib diisi.").trim().min(1, "Alamat wajib diisi.").max(255, "Alamat maksimal 255 karakter."),
});

// "" berarti "kosongkan email"; aturan per peran ada di service.updateMe
export const updateMeSchema = z.object({
  full_name: fullName.optional(),
  phone: phone.optional(),
  email: z
    .preprocess((v) => (v === null || (typeof v === "string" && v.trim() === "") ? "" : v), z.union([z.literal(""), email], "Format email tidak valid."))
    .optional(),
  avatar_url: urlFoto,
  favorite_pickup_point_id: z.number("Titik temu tidak tersedia.").int("Titik temu tidak tersedia.").nullable().optional(),
  current_password: z.string("Kata sandi lama wajib diisi.").min(1, "Kata sandi lama wajib diisi.").max(72, "Kata sandi maksimal 72 karakter.").optional(),
});

export const changePasswordSchema = z.object({
  current_password: z.string("Kata sandi lama wajib diisi.").min(1, "Kata sandi lama wajib diisi.").max(72, "Kata sandi maksimal 72 karakter."),
  new_password: password,
});

export const loginSchema = z.object({
  identifier: z.string("Email atau nomor WA wajib diisi.").trim().min(1, "Email atau nomor WA wajib diisi.").max(255, "Email atau nomor WA terlalu panjang."),
  password: z.string("Kata sandi wajib diisi.").min(1, "Kata sandi wajib diisi.").max(72, "Kata sandi maksimal 72 karakter."),
  client: z.enum(["web", "mobile"], "Jenis klien tidak valid."),
});

export const normalizeIdentifier = (raw: string): { email: string } | { phone: string } =>
  raw.includes("@") ? { email: raw.trim().toLowerCase() } : { phone: raw.replace(/\D/g, "") };

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterCustomerInput = z.infer<typeof registerCustomerSchema>;
export type RegisterMerchantInput = z.infer<typeof registerMerchantSchema>;
