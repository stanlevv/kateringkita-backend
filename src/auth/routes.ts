import { Router } from "express";
import { validate } from "../http/validate";
import { buatUnggahan, uploadSchema } from "../upload/service";
import { loginLimiter, passwordLimiter, uploadLimiter } from "./rateLimit";
import { changePasswordSchema, loginSchema, registerCustomerSchema, registerMerchantSchema, updateMeSchema } from "./schemas";
import { AuthedRequest, requireAuth } from "./middleware";
import { changePassword, getMe, login, logout, registerCustomer, registerMerchant, updateMe } from "./service";

export const v1 = Router();

v1.post("/auth/customer/register", validate(registerCustomerSchema), async (req, res) => {
  res.status(201).json({ data: { user: await registerCustomer(req.body) } });
});

v1.post("/auth/merchant/register", validate(registerMerchantSchema), async (req, res) => {
  res.status(201).json({ data: await registerMerchant(req.body) });
});

v1.post("/auth/login", validate(loginSchema), loginLimiter, async (req, res) => {
  res.json({ data: await login(req.body, req.get("user-agent")) });
});

v1.post("/auth/logout", requireAuth, async (req, res) => {
  await logout((req as AuthedRequest).auth.jti);
  res.status(204).end();
});

v1.get("/me", requireAuth, async (req, res) => {
  res.json({ data: await getMe((req as AuthedRequest).auth.userId) });
});

v1.patch("/me", requireAuth, validate(updateMeSchema), passwordLimiter, async (req, res) => {
  const { userId, role } = (req as AuthedRequest).auth;
  res.json({ data: await updateMe(userId, role, req.body) });
});

v1.put("/me/password", requireAuth, validate(changePasswordSchema), passwordLimiter, async (req, res) => {
  const { userId, jti } = (req as AuthedRequest).auth;
  await changePassword(userId, jti, req.body);
  res.status(204).end();
});

// Semua peran (D12); awalan kunci selalu dari token
v1.post("/me/avatar", requireAuth, validate(uploadSchema), uploadLimiter, (req, res) => {
  res.json({ data: buatUnggahan(`users/${(req as AuthedRequest).auth.userId}/avatar/`, req.body) });
});
