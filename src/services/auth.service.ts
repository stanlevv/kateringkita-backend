import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { PoolConnection } from "mysql2/promise";
import db from "../config/db";
import { AppError } from "../utils/errors";
import jwt, { JwtPayload, SignOptions } from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { env } from "../config/env";
import { cekUrlGambar } from "./upload.service";
import { ChangePasswordInput, LoginInput, normalizeIdentifier, RegisterCustomerInput, RegisterMerchantInput, UpdateMeInput } from "../dto/auth.dto";

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

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export async function insertUser(
  conn: Pick<PoolConnection, "query">,
  role: PublicUser["role"],
  input: { full_name: string; email?: string; phone: string; password: string },
): Promise<PublicUser> {
  const hash = await bcrypt.hash(input.password, BCRYPT_COST);
  const email = input.email ?? null;
  const [result] = await conn.query<ResultSetHeader>(
    "INSERT INTO users (role, full_name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?)",
    [role, input.full_name, email, input.phone, hash],
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
    const [types] = await conn.query<RowDataPacket[]>("SELECT id FROM merchant_types WHERE id = ? AND is_active", [
      input.merchant_type_id,
    ]);
    if (types.length === 0) {
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
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

const toPublicUser = (r: RowDataPacket): PublicUser => ({
  id: r.id,
  role: r.role,
  full_name: r.full_name,
  email: r.email,
  phone: r.phone,
  avatar_url: r.avatar_url,
  favorite_pickup_point_id: r.favorite_pickup_point_id,
  ...(r.role === "admin" && { admin_level: r.admin_level ?? null, must_change_password: Boolean(r.must_change_password) }),
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
  const { email, favorite_pickup_point_id: pickup, full_name, phone, current_password, avatar_url } = input;
  const sets: Record<string, string | number | null> = {};
  if (full_name !== undefined) sets.full_name = full_name;
  if (phone !== undefined) sets.phone = phone;
  if (email !== undefined) {
    if (email === "" && role === "customer") {
      throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { email: ["Email wajib diisi."] });
    }
    sets.email = email === "" ? null : email;
  }
  // email/nomor adalah pengenal masuk: perubahannya wajib dikonfirmasi dengan kata sandi
  if ("email" in sets || "phone" in sets) {
    const [rows] = await db.query<RowDataPacket[]>("SELECT email, phone, password_hash FROM users WHERE id = ?", [userId]);
    const changed = ("email" in sets && sets.email !== rows[0].email) || ("phone" in sets && sets.phone !== rows[0].phone);
    if (changed) {
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
    cekUrlGambar(avatar_url, rows[0].avatar_url, `users/${userId}/avatar/`, "avatar_url");
    sets.avatar_url = avatar_url;
  }
  if (pickup !== undefined) {
    if (pickup !== null) {
      const [pts] = await db.query<RowDataPacket[]>("SELECT id FROM pickup_points WHERE id = ? AND is_active", [pickup]);
      if (pts.length === 0) {
        throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", {
          favorite_pickup_point_id: ["Titik temu tidak tersedia."],
        });
      }
    }
    sets.favorite_pickup_point_id = pickup;
  }
  const cols = Object.keys(sets);
  if (cols.length > 0) {
    await db.query(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [
      ...Object.values(sets),
      userId,
    ]);
  }
  return getMe(userId);
}

export const logout = (jti: string) =>
  db.query("UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP() WHERE jti = ?", [jti]);

export async function login(input: LoginInput, userAgent?: string) {
  const id = normalizeIdentifier(input.identifier);
  // email dibandingkan biner: collation default mengabaikan aksen & karakter kontrol sehingga varian tak kasatmata ikut cocok
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT * FROM users WHERE ${"email" in id ? "email = ? COLLATE utf8mb4_bin" : "phone = ?"} AND is_active = TRUE`,
    ["email" in id ? id.email : id.phone],
  );
  const row = rows[0];
  // selalu satu bcrypt.compare agar waktu respons tidak membocorkan keberadaan akun
  const ok = await bcrypt.compare(input.password, row?.password_hash ?? DUMMY_HASH);
  // admin hanya boleh masuk dari web (K5): dari mobile diperlakukan persis seperti sandi salah
  if (!row || !ok || (row.role === "admin" && input.client === "mobile")) {
    throw new AppError(401, "UNAUTHENTICATED", "Email/WA atau password salah.");
  }

  const jti = randomUUID();
  const expiresIn = (input.client === "web" ? env.JWT_TTL_WEB : env.JWT_TTL_MOBILE) as SignOptions["expiresIn"];
  const token = jwt.sign({ sub: String(row.id), role: row.role }, env.JWT_SECRET, { jwtid: jti, expiresIn });
  const expiresAt = new Date((jwt.decode(token) as JwtPayload).exp! * 1000);
  await db.query("INSERT INTO auth_sessions (user_id, jti, client, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)", [
    row.id,
    jti,
    input.client,
    userAgent?.slice(0, 255) ?? null,
    expiresAt,
  ]);
  return { token, expires_at: expiresAt.toISOString(), user: toPublicUser(row) };
}

async function assertPassword(plain: string, hash: string): Promise<void> {
  if (!(await bcrypt.compare(plain, hash))) {
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { current_password: ["Kata sandi lama salah."] });
  }
}

export async function changePassword(userId: number, currentJti: string, input: ChangePasswordInput): Promise<void> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT password_hash FROM users WHERE id = ?", [userId]);
  await assertPassword(input.current_password, rows[0].password_hash);
  const hash = await bcrypt.hash(input.new_password, BCRYPT_COST);
  // sesi lain dicabut lebih dulu: bila langkah kedua gagal, pengguna keluar di tempat lain dan sandi tetap lama, jadi ulang aman
  await db.query(
    "UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND jti <> ? AND revoked_at IS NULL",
    [userId, currentJti],
  );
  await db.query("UPDATE users SET password_hash = ?, must_change_password = FALSE WHERE id = ?", [hash, userId]);
}
