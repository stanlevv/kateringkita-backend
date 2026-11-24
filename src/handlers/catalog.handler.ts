// Isi file: handler katalog, favorit, dan rekomendasi AI. Handler membaca request (path, query, body, data login),
// memanggil service, lalu mengirim JSON. Alurnya routes/catalog.ts → file ini → catalog, catalog-favorite, dan
// recommendation service.
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

// Id pembeli untuk tanda favorit dan voucher. Hanya diisi untuk sesi pembeli; tamu, penjual, dan admin mendapat null.
const getCustomerId = (req: Request) => {
  const auth = (req as Partial<AuthedRequest>).auth;
  return auth?.role === "customer" ? auth.userId : null;
};
// Id pengguna yang login. Hanya dipakai di route yang sudah dijaga requireAuth, jadi `auth` pasti ada.
const getUserId = (req: Request) => (req as AuthedRequest).auth.userId;

/**
 * GET /menus: daftar dan pencarian menu katalog per halaman.
 * @param req request dengan query filter (lihat catalogQuerySchema); login opsional
 * @param res respons `{ data, meta }`
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const listCatalogHandler: RequestHandler = async (req, res) => {
  res.json(await listCatalog(parse(catalogQuerySchema, req.query), getCustomerId(req)));
};

/**
 * GET /menus/:id: detail satu menu.
 * @param req request dengan `id` menu di path; login opsional
 * @param res respons `{ data }` berisi detail menu, atau 404 bila menu tidak tampil
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const getMenuDetailHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMenuDetail(req.params.id, getCustomerId(req)) });
};

/**
 * GET /menus/:id/reviews: ulasan satu menu per halaman.
 * @param req request dengan `id` menu di path dan `page`/`limit` di query
 * @param res respons `{ data, meta }`, atau 404 bila menu tidak tampil
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const listMenuReviewsHandler: RequestHandler = async (req, res) => {
  res.json(await listMenuReviews(req.params.id, parse(paginationSchema, req.query)));
};

/**
 * GET /merchants/:slug: profil toko publik. Tipe params ditulis sama dengan yang diturunkan Express dari path itu.
 * @param req request dengan `slug` toko di path; login opsional
 * @param res respons `{ data }` berisi profil toko, atau 404 bila toko tidak tampil
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const getMerchantProfileHandler: RequestHandler<{ slug: string }> = async (req, res) => {
  res.json({ data: await getMerchantProfile(req.params.slug, getCustomerId(req)) });
};

/**
 * GET /me/favorites: menu favorit pembeli per halaman.
 * @param req request pembeli yang login, dengan `page`/`limit` di query
 * @param res respons `{ data, meta }`
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const listFavoritesHandler: RequestHandler = async (req, res) => {
  res.json(await listFavorites(getUserId(req), parse(paginationSchema, req.query)));
};

/**
 * PUT /me/favorites/:menuId: simpan menu ke favorit.
 * @param req request pembeli yang login, dengan `menuId` di path
 * @param res respons 204 tanpa isi, atau 404 bila menu tidak tampil
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const saveFavoriteHandler: RequestHandler = async (req, res) => {
  await saveFavorite(getUserId(req), req.params.menuId);
  res.status(204).end();
};

/**
 * DELETE /me/favorites/:menuId: hapus menu dari favorit.
 * @param req request pembeli yang login, dengan `menuId` di path
 * @param res respons 204 tanpa isi
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const deleteFavoriteHandler: RequestHandler = async (req, res) => {
  await deleteFavorite(getUserId(req), req.params.menuId);
  res.status(204).end();
};

/**
 * GET /me/favorite-merchants: toko favorit ("Dapur Favorit") pembeli per halaman.
 * @param req request pembeli yang login, dengan `page`/`limit` di query
 * @param res respons `{ data, meta }`
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const listFavoriteMerchantsHandler: RequestHandler = async (req, res) => {
  res.json(await listFavoriteMerchants(getUserId(req), parse(paginationSchema, req.query)));
};

/**
 * PUT /me/favorite-merchants/:merchantId: simpan toko ke favorit.
 * @param req request pembeli yang login, dengan `merchantId` di path
 * @param res respons 204 tanpa isi, atau 404 bila toko tidak tampil
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const saveFavoriteMerchantHandler: RequestHandler = async (req, res) => {
  await saveFavoriteMerchant(getUserId(req), req.params.merchantId);
  res.status(204).end();
};

/**
 * DELETE /me/favorite-merchants/:merchantId: hapus toko dari favorit.
 * @param req request pembeli yang login, dengan `merchantId` di path
 * @param res respons 204 tanpa isi
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const deleteFavoriteMerchantHandler: RequestHandler = async (req, res) => {
  await deleteFavoriteMerchant(getUserId(req), req.params.merchantId);
  res.status(204).end();
};

/**
 * POST /assistant/recommendations: rekomendasi menu dengan AI. Body sudah diperiksa recommendationSchema di route.
 * @param req request pembeli yang login, dengan body kebutuhan dan batasan
 * @param res respons `{ data }` berisi hasil rekomendasi
 * @returns tidak ada; hasil dikirim lewat `res`
 */
export const recommendMenusHandler: RequestHandler = async (req, res) => {
  res.json({ data: await recommendMenus(getUserId(req), req.body) });
};
