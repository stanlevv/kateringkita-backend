// Isi file: handler HTTP pencairan dana dan refund. Sisi penjual (halaman pencairan, ubah rekening) dipasang di
// routes/merchant.ts; sisi admin (saldo, catat pencairan, riwayat, refund) di routes/admin.ts, dengan tingkat admin
// yang boleh masuk diatur middleware/admin-access.ts. Isi permintaan sudah diperiksa skema di rute. Alurnya routes →
// file ini → services/payout.service.ts → database.
import { Request, RequestHandler } from "express";
import { AuthedRequest } from "../middleware/auth";
import { parse } from "../middleware/validate";
import { pageSchema } from "../dto/payout.dto";
import {
  recordPayout,
  listRefunds,
  listBalances,
  getMyPayouts,
  listPayoutHistory,
  markRefunded,
  updateBankAccount,
} from "../services/payout.service";

// id pengguna yang login (penjual atau admin), sudah dipasang middleware requireAuth di rute.
const getUserId = (req: Request) => (req as AuthedRequest).auth.userId;

/**
 * `GET /merchant/payouts`: halaman pencairan penjual (bank, rekening, saldo, riwayat).
 * @param req permintaan dari penjual yang login
 * @param res jawaban `{ data: { banks, account, balance, payouts } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 404 pengguna tidak punya toko
 */
export const getMyPayoutsHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getMyPayouts(getUserId(req)) });
};
/**
 * `PUT /merchant/payout-account`: menyimpan rekening pencairan; isi sudah lolos bankAccountSchema di rute.
 * @param req permintaan berisi `bank`, `account_number`, `account_name`, `password`
 * @param res jawaban `{ data }` berisi halaman pencairan terbaru
 * @returns selesai setelah jawaban dikirim
 * @throws 400 kata sandi salah, 404 pengguna tidak punya toko
 */
export const updateBankAccountHandler: RequestHandler = async (req, res) => {
  res.json({ data: await updateBankAccount(getUserId(req), req.body) });
};

/**
 * `GET /admin/payouts/balances`: saldo semua toko yang siap dicairkan.
 * @param _req permintaan (tidak dibaca)
 * @param res  jawaban `{ data: { as_of, rows } }`
 * @returns selesai setelah jawaban dikirim
 */
export const listBalancesHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await listBalances() });
};
/**
 * `POST /admin/payouts`: mencatat pencairan yang sudah ditransfer; isi sudah lolos payoutSchema di rute.
 * @param req permintaan berisi `merchant_id`, `amount`, `until`, `reference`, `note`, `account_updated_at`
 * @param res jawaban 201 `{ data }` berisi baris riwayat pencairan baru
 * @returns selesai setelah jawaban dikirim
 * @throws 404 toko tidak ada, 409 rekening belum diisi / berubah, tidak ada saldo, atau saldo berbeda
 */
export const recordPayoutHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await recordPayout(getUserId(req), req.body) });
};
/**
 * `GET /admin/payouts`: riwayat pencairan semua toko per halaman.
 * @param req permintaan; query `page` diperiksa pageSchema
 * @param res jawaban `{ data, meta: { page, limit, total } }`
 * @returns selesai setelah jawaban dikirim
 */
export const listPayoutHistoryHandler: RequestHandler = async (req, res) => {
  res.json(await listPayoutHistory(parse(pageSchema, req.query).page));
};
/**
 * `GET /admin/refunds`: antrean pembayaran yang dananya perlu dikembalikan ke pembeli.
 * @param _req permintaan (tidak dibaca)
 * @param res  jawaban `{ data: [...] }`
 * @returns selesai setelah jawaban dikirim
 */
export const listRefundsHandler: RequestHandler = async (_req, res) => {
  res.json({ data: await listRefunds() });
};
/**
 * `POST /admin/refunds/:code`: menandai dana pesanan sudah dikembalikan; isi sudah lolos refundSchema di rute.
 * @param req permintaan dengan `:code` pesanan dan isi `reference`
 * @param res jawaban `{ data: { code, amount, reference } }`
 * @returns selesai setelah jawaban dikirim
 * @throws 404 pesanan tidak ada di antrean refund
 */
export const markRefundedHandler: RequestHandler = async (req, res) => {
  res.json({ data: await markRefunded(getUserId(req), String(req.params.code), req.body) });
};
