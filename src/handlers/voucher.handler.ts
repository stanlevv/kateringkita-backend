// Isi file: handler HTTP voucher untuk pembeli (daftar voucher platform, klaim, dan "Voucher Saya"). Handler membaca
// alamat dan query, memanggil voucher.service, lalu mengirim JSON. Alurnya routes/catalog.ts → file ini →
// services/voucher.service.ts → database.
import { Request, RequestHandler } from "express";
import { myVouchersSchema } from "../dto/voucher.dto";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { clock } from "../services/catalog.service";
import { claimVoucher, listPlatformVouchers, listMyVouchers } from "../services/voucher.service";

// id pengguna yang login, sudah dipasang middleware requireAuth di rute.
const getUserId = (req: Request) => (req as AuthedRequest).auth.userId;
// Tanda `claimed` hanya dihitung untuk sesi pembeli; tamu dan peran lain dianggap null.
const getCustomerId = (req: Request) => {
  const auth = (req as Partial<AuthedRequest>).auth;
  return auth?.role === "customer" ? auth.userId : null;
};

/**
 * `GET /vouchers/platform`: voucher platform yang sedang tersedia. Boleh tanpa login.
 * @param req permintaan; token login opsional
 * @param res jawaban `{ data: [kartu voucher] }`
 * @returns selesai setelah jawaban dikirim
 */
export const listPlatformVouchersHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listPlatformVouchers(getCustomerId(req), clock.now()) });
};

/**
 * `POST /me/vouchers/:id/claim`: pembeli mengklaim voucher ke "Voucher Saya".
 * @param req permintaan dengan `:id` voucher
 * @param res jawaban `{ data: kartu voucher }` dengan `claimed: true`
 * @returns selesai setelah jawaban dikirim
 * @throws 404 voucher tidak ada, 409 voucher tidak tersedia atau kuota habis
 */
export const claimVoucherHandler: RequestHandler = async (req, res) => {
  res.json({ data: await claimVoucher(getUserId(req), req.params.id) });
};

/**
 * `GET /me/vouchers`: "Voucher Saya" milik pembeli, dengan tanda bisa dipakai untuk keranjang bila filter dikirim.
 * @param req permintaan; query diperiksa myVouchersSchema
 * @param res jawaban `{ data: [kartu voucher + usable + reason] }`
 * @returns selesai setelah jawaban dikirim
 * @throws 400 query tidak valid
 */
export const listMyVouchersHandler: RequestHandler = async (req, res) => {
  res.json({ data: await listMyVouchers(getUserId(req), parse(myVouchersSchema, req.query)) });
};
