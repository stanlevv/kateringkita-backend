import { Request, Router } from "express";
import { AuthedRequest, authOpsional, requireAuth, requireRole } from "../auth/middleware";
import { parse } from "../http/validate";
import { daftarFavorit, hapusFavorit, simpanFavorit } from "./favorit";
import { daftarKatalog, detailMenu, profilToko, ulasanMenu } from "./menus";
import { halamanSchema, katalogQuerySchema } from "./schemas";

// Katalog publik (C-05, C-06, C-07) + favorit (C-19); dipasang di /api/v1 sebelum v1
export const katalog = Router();

// D14: is_favorite hanya untuk sesi pembeli; tanpa token/peran lain → null
const pembeli = (req: Request) => {
  const auth = (req as Partial<AuthedRequest>).auth;
  return auth?.role === "customer" ? auth.userId : null;
};
const uid = (req: Request) => (req as AuthedRequest).auth.userId;

katalog.get("/menus", authOpsional, async (req, res) => {
  res.json(await daftarKatalog(parse(katalogQuerySchema, req.query), pembeli(req)));
});

katalog.get("/menus/:id", authOpsional, async (req, res) => {
  res.json({ data: await detailMenu(req.params.id, pembeli(req)) });
});

katalog.get("/menus/:id/reviews", async (req, res) => {
  res.json(await ulasanMenu(req.params.id, parse(halamanSchema, req.query)));
});

katalog.get("/merchants/:slug", async (req, res) => {
  res.json({ data: await profilToko(req.params.slug) });
});

katalog.get("/me/favorites", requireAuth, requireRole("customer"), async (req, res) => {
  res.json(await daftarFavorit(uid(req), parse(halamanSchema, req.query)));
});

katalog.put("/me/favorites/:menuId", requireAuth, requireRole("customer"), async (req, res) => {
  await simpanFavorit(uid(req), req.params.menuId);
  res.status(204).end();
});

katalog.delete("/me/favorites/:menuId", requireAuth, requireRole("customer"), async (req, res) => {
  await hapusFavorit(uid(req), req.params.menuId);
  res.status(204).end();
});
