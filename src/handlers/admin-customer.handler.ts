// Isi file: handler HTTP panel admin untuk data pembeli: daftar, detail, tambah, ubah, serta nonaktifkan/aktifkan.
// Lapisan kedua dari alur routes/admin.ts → handlers → services (admin-customer.service, admin-user.service) →
// database. Isi permintaan sudah diperiksa skema zod di routes/admin.ts; id admin dibaca dari `req.auth`.
import { RequestHandler } from "express";
import { AuthedRequest } from "../middleware/auth";
import {
  createCustomerByAdmin,
  getCustomerDetail,
  listCustomers,
  parseCustomerId,
} from "../services/admin-customer.service";
import { setAccountActive, updateAccountByAdmin } from "../services/admin-user.service";

// Angka halaman/batas dari query: dibulatkan ke bawah dan dibatasi `max`; tidak valid atau kurang dari 1 = `fallback`.
const toPositiveInt = (value: unknown, fallback: number, max: number) => {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, max) : fallback;
};
const asString = (value: unknown) => (typeof value === "string" ? value : undefined);
const getAdminId = (req: unknown) => (req as AuthedRequest).auth.userId;

/** `GET /admin/customers`: daftar pembeli; query `q`, `status` (active/inactive), `page`, `limit`. */
export const listCustomersHandler: RequestHandler = async (req, res) => {
  res.json(
    await listCustomers({
      q: asString(req.query.q)?.trim(),
      status: asString(req.query.status),
      page: toPositiveInt(req.query.page, 1, 1e6),
      limit: toPositiveInt(req.query.limit, 20, 100),
    }),
  );
};

/** `GET /admin/customers/:id`: detail pembeli dan ringkasan pesanannya. */
export const getCustomerDetailHandler: RequestHandler = async (req, res) => {
  res.json({ data: await getCustomerDetail(parseCustomerId(req.params.id)) });
};

/** `POST /admin/customers`: membuat akun pembeli (body sudah lolos registerCustomerSchema). Dijawab 201. */
export const createCustomerHandler: RequestHandler = async (req, res) => {
  res.status(201).json({ data: await createCustomerByAdmin(getAdminId(req), req.body) });
};

/** `PATCH /admin/customers/:id`: mengubah nama, nomor WA, dan/atau email pembeli. */
export const updateCustomerHandler: RequestHandler = async (req, res) => {
  const id = parseCustomerId(req.params.id);
  await updateAccountByAdmin(getAdminId(req), id, "customer", req.body, { targetType: "customer", targetId: id });
  res.json({ data: await getCustomerDetail(id) });
};

/**
 * Membuat handler `POST /admin/customers/:id/activate` atau `/deactivate`.
 * @param active `true` untuk mengaktifkan, `false` untuk menonaktifkan
 * @returns handler yang menjawab `{ data }` berisi detail pembeli sesudah diubah
 */
export const setCustomerActiveHandler =
  (active: boolean): RequestHandler =>
  async (req, res) => {
    const id = parseCustomerId(req.params.id);
    await setAccountActive(getAdminId(req), id, "customer", active, { targetType: "customer", targetId: id });
    res.json({ data: await getCustomerDetail(id) });
  };
