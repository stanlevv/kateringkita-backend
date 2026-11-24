// Isi file: perubahan akun penjual dan pembeli oleh admin: ubah nama/nomor WA/email, serta nonaktifkan dan aktifkan
// lagi. Dipakai admin-merchant-edit.service (pemilik toko) dan admin-customer.service (pembeli). Alurnya
// routes/admin.ts → handlers/admin-*.handler.ts → file ini → database.
// "Nonaktifkan" tidak menghapus data: akun tidak bisa masuk (sesi dicabut, login menolak akun nonaktif) dan toko
// hilang dari katalog, tetapi riwayat pesanan, ulasan, dan keuangan tetap utuh.
import { RowDataPacket } from "mysql2";
import { AdminAccountUpdateInput } from "../dto/admin-user.dto";
import { AppError } from "../utils/errors";
import { Conn, recordAudit, withTransaction } from "./admin-audit.service";

/** Peran akun yang boleh diubah lewat file ini; akun admin dikelola admin-account.service. */
export type ManagedRole = "merchant" | "customer";

/** Ke mana perubahan dicatat di log audit (misalnya `{ targetType: "merchant", targetId: <id toko> }`). */
export type AuditTarget = { targetType: string; targetId: number };

const ACCOUNT_COLUMNS = "id, full_name, phone, email, is_active";
const notFound = (role: ManagedRole) =>
  new AppError(404, "NOT_FOUND", role === "merchant" ? "Penjual tidak ditemukan." : "Pembeli tidak ditemukan.");
const toAccount = (row: RowDataPacket) => ({
  id: row.id as number,
  full_name: row.full_name as string,
  phone: row.phone as string,
  email: (row.email as string | null) ?? null,
  is_active: Boolean(row.is_active),
});

// Mengunci baris akun dengan peran yang diharapkan sampai transaksi selesai; peran lain dianggap tidak ada.
async function lockAccount(conn: Conn, userId: number, role: ManagedRole) {
  const [[row]] = await conn.query<RowDataPacket[]>(
    `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = ? AND role = ? FOR UPDATE`,
    [userId, role],
  );
  if (!row) throw notFound(role);
  return toAccount(row);
}

/**
 * Mengubah nama, nomor WA, dan/atau email sebuah akun. Admin tidak perlu sandi pemilik akun. Email yang berganti
 * kembali berstatus belum terverifikasi.
 * @param adminId id admin yang mengubah
 * @param userId  id akun (users.id)
 * @param role    peran akun yang diharapkan
 * @param input   kolom yang diubah; email `""` berarti dikosongkan (hanya penjual)
 * @param audit   tujuan catatan di log audit
 * @returns data akun sesudah diubah
 * @throws 400 VALIDATION_ERROR bila tidak ada kolom yang diubah atau email pembeli dikosongkan; 404 akun tidak ada;
 *         galat `ER_DUP_ENTRY` (dijawab 409) bila nomor/email sudah dipakai akun lain
 */
export function updateAccountByAdmin(
  adminId: number,
  userId: number,
  role: ManagedRole,
  input: AdminAccountUpdateInput,
  audit: AuditTarget,
) {
  return withTransaction(async (conn) => {
    // 1. Kumpulkan kolom yang dikirim. Pembeli wajib punya email karena dipakai untuk lupa sandi.
    const columnValues: Record<string, string | null> = {};
    if (input.full_name !== undefined) columnValues.full_name = input.full_name;
    if (input.phone !== undefined) columnValues.phone = input.phone;
    if (input.email !== undefined) {
      if (input.email === "" && role === "customer")
        throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { email: ["Email wajib diisi."] });
      columnValues.email = input.email === "" ? null : input.email;
    }
    if (Object.keys(columnValues).length === 0)
      throw new AppError(400, "VALIDATION_ERROR", "Tidak ada data yang diubah.");
    // 2. Kunci akun, lalu simpan. Email yang benar-benar berganti belum dibuktikan dengan kode OTP.
    const before = await lockAccount(conn, userId, role);
    const changes: Record<string, string | null> = { ...columnValues };
    if ("email" in columnValues && columnValues.email !== before.email) changes.email_verified_at = null;
    await conn.query(
      `UPDATE users SET ${Object.keys(changes)
        .map((column) => `${column} = ?`)
        .join(", ")} WHERE id = ?`,
      [...Object.values(changes), userId],
    );
    // 3. Catat sebelum dan sesudahnya di log audit.
    const after = await lockAccount(conn, userId, role);
    await recordAudit(conn, { adminId, action: `${role}.account.update`, ...audit, before, after });
    return after;
  });
}

/**
 * Menonaktifkan atau mengaktifkan lagi sebuah akun. Saat dinonaktifkan, semua sesi login akun itu dicabut.
 * @param adminId id admin yang mengubah
 * @param userId  id akun (users.id)
 * @param role    peran akun yang diharapkan
 * @param active  `true` untuk mengaktifkan, `false` untuk menonaktifkan
 * @param audit   tujuan catatan di log audit
 * @returns data akun sesudah diubah
 * @throws 404 akun tidak ada; 409 CONFLICT bila akun sudah dalam keadaan itu
 */
export function setAccountActive(
  adminId: number,
  userId: number,
  role: ManagedRole,
  active: boolean,
  audit: AuditTarget,
) {
  return withTransaction(async (conn) => {
    // 1. Kunci akun; mengubah ke keadaan yang sama dianggap konflik supaya admin tahu tidak ada yang berubah.
    const before = await lockAccount(conn, userId, role);
    if (before.is_active === active)
      throw new AppError(409, "CONFLICT", active ? "Akun sudah aktif." : "Akun sudah nonaktif.");
    // 2. Ubah status; sesi dicabut supaya tidak hidup lagi saat akun diaktifkan ulang.
    await conn.query("UPDATE users SET is_active = ? WHERE id = ?", [active, userId]);
    if (!active)
      await conn.query(
        "UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL",
        [userId],
      );
    // 3. Catat di log audit.
    const after = { ...before, is_active: active };
    await recordAudit(conn, {
      adminId,
      action: `${role}.account.${active ? "activate" : "deactivate"}`,
      ...audit,
      before,
      after,
    });
    return after;
  });
}
