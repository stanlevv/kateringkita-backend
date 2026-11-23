import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";
import db from "../config/db";
import { AppError } from "../utils/errors";
import jwt, { JwtPayload, SignOptions } from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { env } from "../config/env";
import { validateImageUrl } from "./upload.service";
import {
  ChangePasswordInput,
  LoginInput,
  normalizeIdentifier,
  RegisterCustomerInput,
  RegisterMerchantInput,
  UpdateMeInput,
} from "../dto/auth.dto";

export type PublicUser = {
  id: number;
  role: "admin" | "merchant" | "customer";
  full_name: string;
  email: string | null;
  phone: string;
  avatar_url: string | null;
  favorite_pickup_point_id: number | null;
  admin_level?: "super" | "ops" | "support" | null; // hanya untuk role admin
  must_change_password?: boolean;
};

export type PublicMerchant = {
  id: number;
  business_name: string;
  slug: string;
  merchant_type_id: number;
  address: string;
  wa_number: string;
  verification_status?: "pending" | "needs_fix" | "verified" | "suspended";
  verification_note?: string | null;
  suspended_reason?: string | null;
};

const BCRYPT_COST = 10;
const DUMMY_HASH = bcrypt.hashSync("tidak-dipakai", BCRYPT_COST);

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export async function insertUser(
  conn: Pick<PoolConnection, "query">,
  role: PublicUser["role"],
  input: { full_name: string; email?: string; phone: string; password: string },
): Promise<PublicUser> {
  const email = input.email ?? null;
  // AUD-37: nomor/email terdaftar ditolak sebelum bcrypt. Bentuknya sama dengan ER_DUP_ENTRY (yang tetap menjaga race)
  // agar semua penanganan duplikat yang ada (errorHandler, admin-akun) tetap berlaku
  const [existingUsers] = await conn.query<RowDataPacket[]>(
    "SELECT 1 FROM users WHERE phone = ? OR email = ? LIMIT 1",
    [input.phone, email],
  );
  if (existingUsers.length)
    throw Object.assign(new Error("Duplicate entry (dicek sebelum bcrypt)"), { code: "ER_DUP_ENTRY" });
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  const [result] = await conn.query<ResultSetHeader>(
    "INSERT INTO users (role, full_name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?)",
    [role, input.full_name, email, input.phone, passwordHash],
  );
  return {
    id: result.insertId,
    role,
    full_name: input.full_name,
    email,
    phone: input.phone,
    avatar_url: null,
    favorite_pickup_point_id: null,
  };
}

export const registerCustomer = (input: RegisterCustomerInput) => insertUser(db, "customer", input);

export async function registerMerchant(
  input: RegisterMerchantInput,
): Promise<{ user: PublicUser; merchant: PublicMerchant }> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [merchantTypes] = await conn.query<RowDataPacket[]>(
      "SELECT id FROM merchant_types WHERE id = ? AND is_active",
      [input.merchant_type_id],
    );
    if (merchantTypes.length === 0) {
      throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", {
        merchant_type_id: ["Jenis usaha tidak dikenal."],
      });
    }
    const user = await insertUser(conn, "merchant", input);
    const slug = `${slugify(input.business_name)}-${randomBytes(2).toString("hex")}`;
    const [result] = await conn.query<ResultSetHeader>(
      "INSERT INTO merchants (user_id, merchant_type_id, business_name, slug, address, wa_number) VALUES (?, ?, ?, ?, ?, ?)",
      [user.id, input.merchant_type_id, input.business_name, slug, input.address, input.phone],
    );
    await conn.commit();
    return {
      user,
      merchant: {
        id: result.insertId,
        business_name: input.business_name,
        slug,
        merchant_type_id: input.merchant_type_id,
        address: input.address,
        wa_number: input.phone,
      },
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

const toPublicUser = (row: RowDataPacket): PublicUser => ({
  id: row.id,
  role: row.role,
  full_name: row.full_name,
  email: row.email,
  phone: row.phone,
  avatar_url: row.avatar_url,
  favorite_pickup_point_id: row.favorite_pickup_point_id,
  ...(row.role === "admin" && {
    admin_level: row.admin_level ?? null,
    must_change_password: Boolean(row.must_change_password),
  }),
});

export async function getMe(userId: number): Promise<{ user: PublicUser; merchant: PublicMerchant | null }> {
  const [users] = await db.query<RowDataPacket[]>("SELECT * FROM users WHERE id = ?", [userId]);
  const [merchants] = await db.query<RowDataPacket[]>(
    "SELECT id, business_name, slug, merchant_type_id, address, wa_number, verification_status, verification_note, suspended_reason FROM merchants WHERE user_id = ?",
    [userId],
  );
  return { user: toPublicUser(users[0]), merchant: (merchants[0] as PublicMerchant | undefined) ?? null };
}

export async function updateMe(
  userId: number,
  role: PublicUser["role"],
  input: UpdateMeInput,
): Promise<{ user: PublicUser; merchant: PublicMerchant | null }> {
  const { email, favorite_pickup_point_id: pickupPointId, full_name, phone, current_password, avatar_url } = input;
  const columnValues: Record<string, string | number | null> = {};
  if (full_name !== undefined) columnValues.full_name = full_name;
  if (phone !== undefined) columnValues.phone = phone;
  if (email !== undefined) {
    if (email === "" && role === "customer") {
      throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { email: ["Email wajib diisi."] });
    }
    columnValues.email = email === "" ? null : email;
  }
  // email/nomor adalah pengenal masuk: perubahannya wajib dikonfirmasi dengan kata sandi
  if ("email" in columnValues || "phone" in columnValues) {
    const [rows] = await db.query<RowDataPacket[]>("SELECT email, phone, password_hash FROM users WHERE id = ?", [
      userId,
    ]);
    const identifierChanged =
      ("email" in columnValues && columnValues.email !== rows[0].email) ||
      ("phone" in columnValues && columnValues.phone !== rows[0].phone);
    if (identifierChanged) {
      if (current_password === undefined) {
        throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", {
          current_password: ["Masukkan kata sandi saat ini untuk mengubah email atau nomor."],
        });
      }
      await assertPassword(current_password, rows[0].password_hash);
    }
  }
  if (avatar_url !== undefined) {
    const [rows] = await db.query<RowDataPacket[]>("SELECT avatar_url FROM users WHERE id = ?", [userId]);
    validateImageUrl(avatar_url, rows[0].avatar_url, `users/${userId}/avatar/`, "avatar_url");
    columnValues.avatar_url = avatar_url;
  }
  if (pickupPointId !== undefined) {
    if (pickupPointId !== null) {
      const [activePickupPoints] = await db.query<RowDataPacket[]>(
        "SELECT id FROM pickup_points WHERE id = ? AND is_active",
        [pickupPointId],
      );
      if (activePickupPoints.length === 0) {
        throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", {
          favorite_pickup_point_id: ["Titik temu tidak tersedia."],
        });
      }
    }
    columnValues.favorite_pickup_point_id = pickupPointId;
  }
  const columns = Object.keys(columnValues);
  if (columns.length > 0) {
    await db.query(`UPDATE users SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`, [
      ...Object.values(columnValues),
      userId,
    ]);
  }
  return getMe(userId);
}

export const logout = (jti: string) =>
  db.query("UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP() WHERE jti = ?", [jti]);

export async function login(input: LoginInput, userAgent?: string) {
  const identifier = normalizeIdentifier(input.identifier);
  // email dibandingkan biner: collation default mengabaikan aksen & karakter kontrol sehingga varian tak kasatmata ikut cocok
  const [users] = await db.query<RowDataPacket[]>(
    `SELECT * FROM users WHERE ${"email" in identifier ? "email = ? COLLATE utf8mb4_bin" : "phone = ?"} AND is_active = TRUE`,
    ["email" in identifier ? identifier.email : identifier.phone],
  );
  const user = users[0];
  // selalu satu bcrypt.compare agar waktu respons tidak membocorkan keberadaan akun
  const passwordMatches = await bcrypt.compare(input.password, user?.password_hash ?? DUMMY_HASH);
  // admin hanya boleh masuk dari web (K5): dari mobile diperlakukan persis seperti sandi salah
  if (!user || !passwordMatches || (user.role === "admin" && input.client === "mobile")) {
    throw new AppError(401, "UNAUTHENTICATED", "Email/WA atau password salah.");
  }

  const jti = randomUUID();
  const expiresIn = (input.client === "web" ? env.JWT_TTL_WEB : env.JWT_TTL_MOBILE) as SignOptions["expiresIn"];
  const token = jwt.sign({ sub: String(user.id), role: user.role }, env.JWT_SECRET, { jwtid: jti, expiresIn });
  const expiresAt = new Date((jwt.decode(token) as JwtPayload).exp! * 1000);
  // AUD-29: sesi hanya dibuat bila hash di DB masih hash yang tadi dicocokkan. Sandi diganti di antara compare dan INSERT
  // → 0 baris; INSERT sebelum hash baru ditulis → ikut dicabut, karena ganti/reset sandi mencabut sesi setelah menulis hash
  const [sessionInsert] = await db.query<ResultSetHeader>(
    "INSERT INTO auth_sessions (user_id, jti, client, user_agent, expires_at) SELECT id, ?, ?, ?, ? FROM users WHERE id = ? AND password_hash = ?",
    [jti, input.client, userAgent?.slice(0, 255) ?? null, expiresAt, user.id, user.password_hash],
  );
  if (!sessionInsert.affectedRows) throw new AppError(401, "UNAUTHENTICATED", "Email/WA atau password salah.");
  return { token, expires_at: expiresAt.toISOString(), user: toPublicUser(user) };
}

async function assertPassword(plainPassword: string, passwordHash: string): Promise<void> {
  if (!(await bcrypt.compare(plainPassword, passwordHash))) {
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { current_password: ["Kata sandi lama salah."] });
  }
}

export async function changePassword(userId: number, currentJti: string, input: ChangePasswordInput): Promise<void> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT password_hash FROM users WHERE id = ?", [userId]);
  await assertPassword(input.current_password, rows[0].password_hash);
  const newPasswordHash = await bcrypt.hash(input.new_password, BCRYPT_COST);
  // AUD-29: hash baru ditulis lebih dulu, lalu sesi lain dicabut, agar login yang sedang berjalan dengan sandi lama tidak lolos
  // (lihat login). Bila pencabutan gagal, mengganti sandi sekali lagi (dengan sandi baru) mencabutnya.
  await db.query("UPDATE users SET password_hash = ?, must_change_password = FALSE WHERE id = ?", [
    newPasswordHash,
    userId,
  ]);
  await db.query(
    "UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND jti <> ? AND revoked_at IS NULL",
    [userId, currentJti],
  );
}
