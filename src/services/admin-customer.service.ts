// Isi file: data pembeli untuk panel admin: daftar dengan pencarian, detail dengan ringkasan pesanan, dan membuat akun
// pembeli. Ubah dan nonaktifkan akun ada di admin-user.service. Alurnya routes/admin.ts →
// handlers/admin-customer.handler.ts → file ini → database.
import { RowDataPacket } from "mysql2";
import db from "../config/db";
import { RegisterCustomerInput } from "../dto/auth.dto";
import { AppError } from "../utils/errors";
import { recordAudit } from "./admin-audit.service";
import { escapeLike } from "./admin-merchant.service";
import { registerCustomer } from "./auth.service";

const notFound = () => new AppError(404, "NOT_FOUND", "Pembeli tidak ditemukan.");

/**
 * Membaca id pembeli dari URL. Id yang bukan bilangan bulat positif dianggap pembeli yang tidak ada.
 * @param value `req.params.id`
 * @returns id pembeli (users.id)
 * @throws 404 bila id tidak valid
 */
export const parseCustomerId = (value: unknown) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw notFound();
  return id;
};

/**
 * Daftar pembeli per halaman, terbaru dulu.
 * @param filter `q` = nama, nomor WA, atau email; `status` = `active`/`inactive`; `page` dan `limit` = halaman
 * @returns `{ data, meta: { page, limit, total } }`; tiap baris memuat jumlah pesanan dan waktu pesanan terakhir
 * @throws 400 status tidak dikenal
 */
export async function listCustomers(filter: { q?: string; status?: string; page: number; limit: number }) {
  // 1. Susun syarat dari filter yang diisi.
  const where = ["u.role = 'customer'"];
  const args: unknown[] = [];
  if (filter.status !== undefined) {
    if (filter.status !== "active" && filter.status !== "inactive")
      throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { status: ["Status tidak dikenal."] });
    where.push("u.is_active = ?");
    args.push(filter.status === "active");
  }
  if (filter.q) {
    where.push("(LOWER(u.full_name) LIKE LOWER(?) OR u.phone LIKE ? OR LOWER(u.email) LIKE LOWER(?))");
    const like = `%${escapeLike(filter.q)}%`;
    args.push(like, like, like);
  }
  // 2. Ambil satu halaman beserta jumlah pesanan, lalu hitung total dengan syarat yang sama.
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT u.id, u.full_name, u.phone, u.email, u.is_active, u.created_at,
            (SELECT COUNT(*) FROM orders o WHERE o.customer_id = u.id) AS order_count,
            (SELECT MAX(o.created_at) FROM orders o WHERE o.customer_id = u.id) AS last_order_at
     FROM users u ${whereSql} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
    [...args, filter.limit, (filter.page - 1) * filter.limit],
  );
  const [[count]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM users u ${whereSql}`, args);
  return {
    data: rows.map((row) => ({ ...row, is_active: Boolean(row.is_active), order_count: Number(row.order_count) })),
    meta: { page: filter.page, limit: filter.limit, total: Number(count.total) },
  };
}

/**
 * Detail satu pembeli: data akun dan ringkasan pesanannya.
 * @param id id pembeli yang sudah diperiksa
 * @returns akun pembeli beserta `orders` (`total`, `completed`, `cancelled`, `spent` = total belanja pesanan selesai
 *          dalam Rupiah, `last_order_at`)
 * @throws 404 pembeli tidak ada
 */
export async function getCustomerDetail(id: number) {
  const [[user]] = await db.query<RowDataPacket[]>(
    `SELECT id, full_name, phone, email, email_verified_at, is_active, created_at FROM users
     WHERE id = ? AND role = 'customer'`,
    [id],
  );
  if (!user) throw notFound();
  const [[orders]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'completed'), 0) AS completed,
            COALESCE(SUM(status IN ('cancelled', 'expired')), 0) AS cancelled,
            COALESCE(SUM(CASE WHEN status = 'completed' THEN total END), 0) AS spent,
            MAX(created_at) AS last_order_at
     FROM orders WHERE customer_id = ?`,
    [id],
  );
  const { email_verified_at: emailVerifiedAt, ...account } = user;
  return {
    ...account,
    is_active: Boolean(user.is_active),
    email_verified: Boolean(emailVerifiedAt),
    orders: {
      total: Number(orders.total),
      completed: Number(orders.completed),
      cancelled: Number(orders.cancelled),
      spent: Number(orders.spent),
      last_order_at: orders.last_order_at,
    },
  };
}

/**
 * Membuat akun pembeli atas nama admin, dengan aturan yang sama seperti pendaftaran dari aplikasi.
 * @param adminId id admin pembuat
 * @param input   nama, email, nomor WA, dan sandi awal yang sudah lolos registerCustomerSchema
 * @returns detail pembeli baru, sama dengan {@link getCustomerDetail}
 * @throws galat `ER_DUP_ENTRY` (dijawab 409) bila nomor atau email sudah terdaftar
 */
export async function createCustomerByAdmin(adminId: number, input: RegisterCustomerInput) {
  const user = await registerCustomer(input);
  await recordAudit(db, {
    adminId,
    action: "customer.create",
    targetType: "customer",
    targetId: user.id,
    after: { full_name: user.full_name, phone: user.phone, email: user.email },
  });
  return getCustomerDetail(user.id);
}
