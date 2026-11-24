// Isi file: handler HTTP pop-up promo aplikasi mobile. Rute publik ada di routes/catalog.ts, rute admin di
// routes/admin.ts. Isi permintaan diperiksa di popup.service (zod dan cek gambar sekaligus). Alurnya routes → file ini
// → services/popup.service.ts → database.
import { Request, RequestHandler } from "express";
import { AuthedRequest } from "../middleware/auth";
import { createPopup, listPopups, getPublicPopup, setPopupArchived, updatePopup } from "../services/popup.service";

// id admin yang login, sudah dipasang middleware requireAuth di rute.
const getUserId = (req: Request) => (req as AuthedRequest).auth.userId;
// Tanda `claimed` voucher hanya dihitung untuk sesi pembeli; tamu dan peran lain dianggap null.
const getCustomerId = (req: Request) => {
  const auth = (req as Partial<AuthedRequest>).auth;
  return auth?.role === "customer" ? auth.userId : null;
};

/**
 * `GET /popup`: pop-up yang sedang tayang. Boleh tanpa login.
 * @param req permintaan; token login opsional
 * @param res jawaban `{ data: pop-up atau null }`
 * @returns selesai setelah jawaban dikirim
 */
export const getPublicPopupHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getPublicPopup(getCustomerId(req)) });
};
/**
 * `GET /admin/popups`: 50 pop-up terbaru untuk admin; `?archived=true` untuk daftar arsip.
 * @param req permintaan; query `archived` opsional
 * @param res jawaban `{ data: [pop-up] }`
 * @returns selesai setelah jawaban dikirim
 */
export const listPopupsHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listPopups(req.query.archived === "true") });
};
/**
 * `POST /admin/popups`: admin membuat pop-up baru.
 * @param req permintaan berisi kolom pop-up
 * @param res jawaban 201 `{ data: pop-up }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 isian tidak valid
 */
export const createPopupHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createPopup(getUserId(req), req.body) });
};
/**
 * `PATCH /admin/popups/:id`: admin mengubah sebagian isi pop-up.
 * @param req permintaan dengan `:id` pop-up dan kolom yang diubah
 * @param res jawaban `{ data: pop-up }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 isian tidak valid, 404 pop-up tidak ada
 */
export const updatePopupHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updatePopup(getUserId(req), req.params.id, req.body) });
};
/**
 * Membuat handler `POST /admin/popups/:id/archive` (archive = true) atau `.../restore` (archive = false).
 * @param archive `true` untuk mengarsipkan, `false` untuk memulihkan
 * @returns handler yang menjawab `{ data: pop-up }`; galatnya 404 pop-up tidak ada atau 409 PROMO_ARCHIVED
 */
export const setPopupArchivedHandler =
  (archive: boolean): RequestHandler =>
  async (req, res) => {
    res.json({ data: await setPopupArchived(getUserId(req), req.params.id, archive) });
  };
