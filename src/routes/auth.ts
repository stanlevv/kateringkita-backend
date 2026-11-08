import { Router } from "express";
import { changePasswordSchema, loginSchema, registerCustomerSchema, registerMerchantSchema, updateMeSchema } from "../dto/auth.dto";
import { uploadSchema } from "../dto/upload.dto";
import {
  changePasswordHandler, getMeHandler, loginHandler, logoutHandler, registerCustomerHandler, registerMerchantHandler, updateMeHandler,
  uploadAvatarHandler,
} from "../handlers/auth.handler";
import { requireAuth } from "../middleware/auth";
import { loginLimiter, passwordLimiter, uploadLimiter } from "../middleware/rateLimiter";
import { validate } from "../middleware/validate";

export const v1 = Router();

v1.post("/auth/customer/register", validate(registerCustomerSchema), registerCustomerHandler);

v1.post("/auth/merchant/register", validate(registerMerchantSchema), registerMerchantHandler);

v1.post("/auth/login", validate(loginSchema), loginLimiter, loginHandler);

v1.post("/auth/logout", requireAuth, logoutHandler);

v1.get("/me", requireAuth, getMeHandler);

v1.patch("/me", requireAuth, validate(updateMeSchema), passwordLimiter, updateMeHandler);

v1.put("/me/password", requireAuth, validate(changePasswordSchema), passwordLimiter, changePasswordHandler);

// Semua peran (D12); awalan kunci selalu dari token
v1.post("/me/avatar", requireAuth, validate(uploadSchema), uploadLimiter, uploadAvatarHandler);
