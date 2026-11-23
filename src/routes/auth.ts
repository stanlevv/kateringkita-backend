import { Router } from "express";
import {
  changePasswordSchema,
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
import { loginLimiter, otpLimiter, passwordLimiter, registerLimiter, uploadLimiter } from "../middleware/rate-limiter";
import { validate } from "../middleware/validate";

export const auth = Router();

auth.post("/auth/customer/register", registerLimiter, validate(registerCustomerSchema), registerCustomerHandler);

auth.post("/auth/merchant/register", registerLimiter, validate(registerMerchantSchema), registerMerchantHandler);

auth.post("/auth/login", validate(loginSchema), loginLimiter, loginHandler);

auth.post("/auth/logout", requireAuth, logoutHandler);

auth.get("/me", requireAuth, getMeHandler);

auth.patch("/me", requireAuth, validate(updateMeSchema), passwordLimiter, updateMeHandler);

auth.put("/me/password", requireAuth, validate(changePasswordSchema), passwordLimiter, changePasswordHandler);

// Semua peran (D12); awalan kunci selalu dari token
auth.post("/me/avatar", requireAuth, validate(uploadSchema), uploadLimiter, uploadAvatarHandler);

// F11 lupa sandi: OTP lewat email
auth.post("/auth/password/forgot", validate(forgotPasswordSchema), otpLimiter, forgotPasswordHandler);

auth.post("/auth/password/verify", validate(verifyOtpSchema), otpLimiter, verifyOtpHandler);

auth.post("/auth/password/reset", validate(resetPasswordSchema), otpLimiter, resetPasswordHandler);
