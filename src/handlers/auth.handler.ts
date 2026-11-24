// Isi file: handler HTTP untuk akun: daftar, masuk, keluar, profil sendiri, ganti sandi, unggah foto profil, dan lupa
// sandi, serta verifikasi/ganti email. Lapisan kedua dari alur routes → handlers → services → database: isi permintaan sudah diperiksa skema zod di
// routes/auth.ts, lalu handler memanggil auth.service, password-reset.service, email-verification.service, atau upload.service dan mengirim
// jawabannya sebagai JSON `{ data: ... }`. Data pengguna yang login dibaca dari `req.auth` (diisi requireAuth).
import { RequestHandler } from "express";
import { AuthedRequest } from "../middleware/auth";
import {
  changePassword,
  getMe,
  login,
  logout,
  registerCustomer,
  registerMerchant,
  updateMe,
} from "../services/auth.service";
import { requestEmailOtp, verifyEmailOtp } from "../services/email-verification.service";
import { verifyOtp, requestOtp, resetPassword } from "../services/password-reset.service";
import { createUpload } from "../services/upload.service";

/** `POST /auth/customer/register`: mendaftarkan pembeli baru. Dijawab 201 dengan `{ user }`. */
export const registerCustomerHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: { user: await registerCustomer(req.body) } });
};

/** `POST /auth/merchant/register`: mendaftarkan penjual beserta tokonya. Dijawab 201 dengan `{ user, merchant }`. */
export const registerMerchantHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await registerMerchant(req.body) });
};

/**
 * `POST /auth/login`: masuk dan mendapat token. Header User-Agent ikut disimpan di sesi supaya pengguna bisa mengenali
 * perangkatnya.
 */
export const loginHandler: RequestHandler = async (req, res) => {
  res.json({ data: await login(req.body, req.get("user-agent")) });
};

/** `POST /auth/logout`: mencabut sesi yang sedang dipakai. Dijawab 204 tanpa isi. */
export const logoutHandler: RequestHandler = async (req, res) => {
  await logout((req as AuthedRequest).auth.jti);
  res.status(204).end();
};

/** `GET /me`: profil pengguna yang login beserta tokonya (bila penjual). */
export const getMeHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMe((req as AuthedRequest).auth.userId) });
};

/** `PATCH /me`: mengubah profil sendiri; dijawab dengan profil terbaru. */
export const updateMeHandler: RequestHandler = async (req, res) => {
  const { userId, role } = (req as AuthedRequest).auth;
  res.json({ data: await updateMe(userId, role, req.body) });
};

/** `PUT /me/password`: mengganti kata sandi; sesi lain dicabut, sesi ini tetap. Dijawab 204 tanpa isi. */
export const changePasswordHandler: RequestHandler = async (req, res) => {
  const { userId, jti } = (req as AuthedRequest).auth;
  await changePassword(userId, jti, req.body);
  res.status(204).end();
};

/**
 * `POST /me/avatar`: membuat alamat unggah foto profil; boleh untuk semua peran. Folder tujuan selalu dibentuk dari
 * id pengguna di token, sehingga pengguna tidak bisa mengunggah ke folder orang lain.
 */
export const uploadAvatarHandler: RequestHandler = (req, res) => {
  res.json({ data: createUpload(`users/${(req as AuthedRequest).auth.userId}/avatar/`, req.body) });
};

/**
 * `POST /auth/password/forgot`: meminta kode OTP lupa sandi. Bila email berhasil dikirim, jawabannya sama untuk email
 * terdaftar maupun tidak, supaya fitur ini tidak bisa dipakai untuk mengecek email mana yang terdaftar. Pengecualian:
 * di production tanpa SMTP (atau saat server email gagal), hanya email terdaftar yang berakhir galat (503 bila SMTP
 * belum diatur), karena email hanya dikirim untuk akun yang ada.
 */
export const forgotPasswordHandler: RequestHandler = async (req, res) => {
  await requestOtp(req.body.email);
  res.json({ data: { message: "Jika email terdaftar, kode verifikasi sudah dikirim." } });
};

/**
 * `POST /auth/password/verify`: memeriksa kode OTP sebelum aplikasi menampilkan isian sandi baru. Memakai satu jatah
 * percobaan, tetapi kodenya belum hangus.
 */
export const verifyOtpHandler: RequestHandler = async (req, res) => {
  await verifyOtp(req.body.email, req.body.code);
  res.json({ data: { valid: true } });
};

/** `POST /auth/password/reset`: mengganti kata sandi dengan kode OTP; semua sesi pengguna itu dicabut. */
export const resetPasswordHandler: RequestHandler = async (req, res) => {
  await resetPassword(req.body);
  res.json({ data: { ok: true } });
};

/**
 * `POST /me/email/otp`: mengirim kode verifikasi ke email akun, atau ke email baru bila pengguna ingin ganti email.
 * Dijawab `{ email }` (alamat yang dikirimi kode).
 */
export const requestEmailOtpHandler: RequestHandler = async (req, res) => {
  res.json({ data: await requestEmailOtp((req as AuthedRequest).auth.userId, req.body) });
};

/** `POST /me/email/verify`: memeriksa kode; bila benar email terverifikasi (dan diganti). Dijawab seperti `GET /me`. */
export const verifyEmailOtpHandler: RequestHandler = async (req, res) => {
  res.json({ data: await verifyEmailOtp((req as AuthedRequest).auth.userId, req.body.code) });
};
