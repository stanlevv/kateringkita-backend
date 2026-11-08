import { Request, RequestHandler } from "express";
import { halamanSchema, katalogQuerySchema } from "../dto/katalog.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { daftarFavorit, hapusFavorit, simpanFavorit } from "../services/katalog-favorit.service";
import { daftarKatalog, detailMenu, profilToko, ulasanMenu } from "../services/katalog.service";

// D14: is_favorite hanya untuk sesi pembeli; tanpa token/peran lain → null
const pembeli = (req: Request) => {
  const auth = (req as Partial<AuthedRequest>).auth;
  return auth?.role === "customer" ? auth.userId : null;
};
const uid = (req: Request) => (req as AuthedRequest).auth.userId;

export const daftarKatalogHandler: RequestHandler = async (req, res) => {
  res.json(await daftarKatalog(parse(katalogQuerySchema, req.query), pembeli(req)));
};

export const detailMenuHandler: RequestHandler = async (req, res) => {
  res.json({ data: await detailMenu(req.params.id, pembeli(req)) });
};

export const ulasanMenuHandler: RequestHandler = async (req, res) => {
  res.json(await ulasanMenu(req.params.id, parse(halamanSchema, req.query)));
};

// Tipe params sama dengan yang diturunkan Express dari path "/merchants/:slug"
export const profilTokoHandler: RequestHandler<{ slug: string }> = async (req, res) => {
  res.json({ data: await profilToko(req.params.slug) });
};

export const daftarFavoritHandler: RequestHandler = async (req, res) => {
  res.json(await daftarFavorit(uid(req), parse(halamanSchema, req.query)));
};

export const simpanFavoritHandler: RequestHandler = async (req, res) => {
  await simpanFavorit(uid(req), req.params.menuId);
  res.status(204).end();
};

export const hapusFavoritHandler: RequestHandler = async (req, res) => {
  await hapusFavorit(uid(req), req.params.menuId);
  res.status(204).end();
};
