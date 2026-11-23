import { Request, RequestHandler } from "express";
import { paginationSchema, catalogQuerySchema } from "../dto/catalog.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import {
  listFavorites,
  listFavoriteMerchants,
  deleteFavorite,
  deleteFavoriteMerchant,
  saveFavorite,
  saveFavoriteMerchant,
} from "../services/catalog-favorite.service";
import { listCatalog, getMenuDetail, getMerchantProfile, listMenuReviews } from "../services/catalog.service";
import { recommendMenus } from "../services/recommendation.service";

// D14: is_favorite hanya untuk sesi pembeli; tanpa token/peran lain → null
const getCustomerId = (req: Request) => {
  const auth = (req as Partial<AuthedRequest>).auth;
  return auth?.role === "customer" ? auth.userId : null;
};
const getUserId = (req: Request) => (req as AuthedRequest).auth.userId;

export const listCatalogHandler: RequestHandler = async (req, res) => {
  res.json(await listCatalog(parse(catalogQuerySchema, req.query), getCustomerId(req)));
};

export const getMenuDetailHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMenuDetail(req.params.id, getCustomerId(req)) });
};

export const listMenuReviewsHandler: RequestHandler = async (req, res) => {
  res.json(await listMenuReviews(req.params.id, parse(paginationSchema, req.query)));
};

// Tipe params sama dengan yang diturunkan Express dari path "/merchants/:slug"; is_favorite hanya sesi pembeli (D14)
export const getMerchantProfileHandler: RequestHandler<{ slug: string }> = async (req, res) => {
  res.json({ data: await getMerchantProfile(req.params.slug, getCustomerId(req)) });
};

export const listFavoritesHandler: RequestHandler = async (req, res) => {
  res.json(await listFavorites(getUserId(req), parse(paginationSchema, req.query)));
};

export const saveFavoriteHandler: RequestHandler = async (req, res) => {
  await saveFavorite(getUserId(req), req.params.menuId);
  res.status(204).end();
};

export const deleteFavoriteHandler: RequestHandler = async (req, res) => {
  await deleteFavorite(getUserId(req), req.params.menuId);
  res.status(204).end();
};

// F05 favorit toko ("Dapur Favorit")
export const listFavoriteMerchantsHandler: RequestHandler = async (req, res) => {
  res.json(await listFavoriteMerchants(getUserId(req), parse(paginationSchema, req.query)));
};

export const saveFavoriteMerchantHandler: RequestHandler = async (req, res) => {
  await saveFavoriteMerchant(getUserId(req), req.params.merchantId);
  res.status(204).end();
};

export const deleteFavoriteMerchantHandler: RequestHandler = async (req, res) => {
  await deleteFavoriteMerchant(getUserId(req), req.params.merchantId);
  res.status(204).end();
};

// F24: body sudah divalidasi recommendationSchema di rute
export const recommendMenusHandler: RequestHandler = async (req, res) => {
  res.json({ data: await recommendMenus(getUserId(req), req.body) });
};
