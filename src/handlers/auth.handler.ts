import { RequestHandler } from "express";
import { AuthedRequest } from "../middleware/auth";
import { changePassword, getMe, login, logout, registerCustomer, registerMerchant, updateMe } from "../services/auth.service";
import { cekOtp, mintaOtp, resetSandi } from "../services/lupa-sandi.service";
import { buatUnggahan } from "../services/upload.service";

export const registerCustomerHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: { user: await registerCustomer(req.body) } });
};

export const registerMerchantHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await registerMerchant(req.body) });
};

export const loginHandler: RequestHandler = async (req, res) => {
  res.json({ data: await login(req.body, req.get("user-agent")) });
};

export const logoutHandler: RequestHandler = async (req, res) => {
  await logout((req as AuthedRequest).auth.jti);
  res.status(204).end();
};

export const getMeHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMe((req as AuthedRequest).auth.userId) });
};

export const updateMeHandler: RequestHandler = async (req, res) => {
  const { userId, role } = (req as AuthedRequest).auth;
  res.json({ data: await updateMe(userId, role, req.body) });
};

export const changePasswordHandler: RequestHandler = async (req, res) => {
  const { userId, jti } = (req as AuthedRequest).auth;
  await changePassword(userId, jti, req.body);
  res.status(204).end();
};

// Semua peran (D12); awalan kunci selalu dari token
export const uploadAvatarHandler: RequestHandler = (req, res) => {
  res.json({ data: buatUnggahan(`users/${(req as AuthedRequest).auth.userId}/avatar/`, req.body) });
};

// F11: jawaban sama untuk email terdaftar atau tidak (anti-enumerasi)
export const forgotPasswordHandler: RequestHandler = async (req, res) => {
  await mintaOtp(req.body.email);
  res.json({ data: { message: "Jika email terdaftar, kode verifikasi sudah dikirim." } });
};

export const verifyOtpHandler: RequestHandler = async (req, res) => {
  await cekOtp(req.body.email, req.body.code);
  res.json({ data: { valid: true } });
};

export const resetPasswordHandler: RequestHandler = async (req, res) => {
  await resetSandi(req.body);
  res.json({ data: { ok: true } });
};
