// Isi file: daftar alamat (rute) akun di /api/v1: daftar, masuk, keluar, profil sendiri (/me), ganti sandi, unggah
// foto profil, lupa sandi, dan verifikasi/ganti email. Lapisan pertama dari alur routes → handlers (auth.handler) → services (auth.service,
// password-reset.service, upload.service) → database. Tiap rute menentukan urutan middleware: wajib login
// (requireAuth), pemeriksa isi permintaan dengan skema zod (validate), dan pembatas jumlah percobaan (rate limit:
// batas berapa kali sebuah aksi boleh diulang dalam waktu tertentu, untuk menahan tebak sandi dan spam).
// validate dipasang sebelum limiter login, ubah profil, dan OTP, supaya limiter membaca isi yang sudah dirapikan.
import { Router } from "express";
import {
  changePasswordSchema,
  emailOtpSchema,
  emailVerifySchema,
  forgotPasswordSchema,
  loginSchema,
  registerCustomerSchema,
  registerMerchantSchema,
  resetPasswordSchema,
  updateMeSchema,
  verifyOtpSchema,
} from "../dto/auth.dto";
import { uploadSchema } from "../dto/upload.dto";
import {
  changePasswordHandler,
  requestEmailOtpHandler,
  verifyEmailOtpHandler,
  forgotPasswordHandler,
  getMeHandler,
  loginHandler,
  logoutHandler,
  registerCustomerHandler,
  registerMerchantHandler,
  resetPasswordHandler,
  updateMeHandler,
  verifyOtpHandler,
  uploadAvatarHandler,
} from "../handlers/auth.handler";
import { requireAuth } from "../middleware/auth";
import {
  emailOtpLimiter,
  loginLimiter,
  otpLimiter,
  passwordLimiter,
  registerLimiter,
  uploadLimiter,
} from "../middleware/rate-limiter";
import { validate } from "../middleware/validate";

/**
 * Router akun; dipasang di /api/v1. Rute daftar, login, dan lupa sandi terbuka tanpa login; rute /me dan logout
 * wajib login.
 */
export const auth = Router();

auth.post("/auth/customer/register", registerLimiter, validate(registerCustomerSchema), registerCustomerHandler);

auth.post("/auth/merchant/register", registerLimiter, validate(registerMerchantSchema), registerMerchantHandler);

auth.post("/auth/login", validate(loginSchema), loginLimiter, loginHandler);

auth.post("/auth/logout", requireAuth, logoutHandler);

auth.get("/me", requireAuth, getMeHandler);

auth.patch("/me", requireAuth, validate(updateMeSchema), passwordLimiter, updateMeHandler);

auth.put("/me/password", requireAuth, validate(changePasswordSchema), passwordLimiter, changePasswordHandler);

// Semua peran boleh mengunggah foto profil; folder tujuan selalu dibentuk dari id pengguna di token.
auth.post("/me/avatar", requireAuth, validate(uploadSchema), uploadLimiter, uploadAvatarHandler);

// Lupa sandi: minta kode OTP ke email, periksa kode, lalu ganti sandi dengan kode itu.
auth.post("/auth/password/forgot", validate(forgotPasswordSchema), otpLimiter, forgotPasswordHandler);

auth.post("/auth/password/verify", validate(verifyOtpSchema), otpLimiter, verifyOtpHandler);

auth.post("/auth/password/reset", validate(resetPasswordSchema), otpLimiter, resetPasswordHandler);

// Verifikasi email dan ganti email: minta kode ke email (akun sekarang atau email baru), lalu masukkan kodenya.
// Jumlah percobaan kode dibatasi per kode di service, jadi pembatas hanya dipasang di permintaan kirim kode.
auth.post("/me/email/otp", requireAuth, validate(emailOtpSchema), emailOtpLimiter, requestEmailOtpHandler);

auth.post("/me/email/verify", requireAuth, validate(emailVerifySchema), verifyEmailOtpHandler);
