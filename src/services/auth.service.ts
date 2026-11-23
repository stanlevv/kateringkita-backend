// Isi file: urusan akun pengguna, yaitu daftar (pembeli dan penjual), masuk (login), keluar (logout), baca dan ubah
// profil sendiri, serta ganti kata sandi. Alurnya routes/auth.ts → handlers/auth.handler.ts → file ini → database.
// insertUser juga dipakai admin-akun.service dan skrip seed-demo untuk membuat akun.
// Kata sandi tidak pernah disimpan apa adanya. Yang disimpan adalah hash bcrypt: hasil acakan satu arah yang tidak bisa
// dibalik menjadi sandi aslinya. Saat login, sandi yang diketik di-hash ulang lalu dicocokkan dengan bcrypt.compare.
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

/**
 * Data pengguna yang boleh dikirim ke aplikasi. Hash kata sandi dan kolom internal lain sengaja tidak ada di sini.
 * `admin_level` dan `must_change_password` hanya diisi untuk admin.
 */
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

/**
 * Data toko milik penjual yang dikirim ke aplikasi bersama data pengguna. Status verifikasi dan catatannya hanya ada
 * saat dibaca ulang dari database (getMe), tidak saat toko baru didaftarkan.
 */
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

// Tingkat kerja bcrypt: 10 berarti 2^10 putaran. Makin besar makin lambat ditebak, tetapi makin berat untuk server.
const BCRYPT_COST = 10;
// Hash cadangan untuk login dengan akun yang tidak ada, supaya bcrypt.compare tetap berjalan (lihat login).
const DUMMY_HASH = bcrypt.hashSync("tidak-dipakai", BCRYPT_COST);

// Mengubah teks menjadi slug: huruf kecil, selain huruf/angka diganti "-", tanpa "-" di ujung. Contoh "Dapur Bu Ani!" →
// "dapur-bu-ani". Slug dipakai sebagai bagian alamat toko.
const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Menyimpan pengguna baru dengan kata sandi yang sudah di-hash.
 * @param conn  koneksi database; bisa pool biasa atau koneksi di dalam transaksi pemanggil
 * @param role  peran akun: `customer`, `merchant`, atau `admin`
 * @param input nama lengkap, email (boleh kosong), nomor HP, dan kata sandi asli
 * @returns data publik pengguna yang baru dibuat
 * @throws galat berkode `ER_DUP_ENTRY` bila nomor HP atau email sudah terdaftar; errorHandler menjawabnya 409
 *         CONFLICT
 */
export async function insertUser(
  conn: Pick<PoolConnection, "query">,
  role: PublicUser["role"],
  input: { full_name: string; email?: string; phone: string; password: string },
): Promise<PublicUser> {
  const email = input.email ?? null;
  // 1. Tolak nomor/email yang sudah terdaftar sebelum menjalankan bcrypt yang berat. Galatnya dibuat sama bentuknya
  //    dengan galat MySQL ER_DUP_ENTRY, supaya penanganan duplikat yang sudah ada (errorHandler, admin-akun) tetap
  //    berlaku. Dua pendaftaran bersamaan tetap dijaga indeks unik database, yang melempar ER_DUP_ENTRY asli.
  const [existingUsers] = await conn.query<RowDataPacket[]>(
    "SELECT 1 FROM users WHERE phone = ? OR email = ? LIMIT 1",
    [input.phone, email],
  );
  if (existingUsers.length)
    throw Object.assign(new Error("Duplicate entry (dicek sebelum bcrypt)"), { code: "ER_DUP_ENTRY" });
  // 2. Hash kata sandi, lalu simpan pengguna.
  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
  const [result] = await conn.query<ResultSetHeader>(
    "INSERT INTO users (role, full_name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?)",
    [role, input.full_name, email, input.phone, passwordHash],
  );
  // 3. Kembalikan data publik; foto profil dan titik temu favorit masih kosong untuk akun baru.
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

/**
 * Mendaftarkan akun pembeli baru.
 * @param input nama lengkap, email, nomor HP, dan kata sandi yang sudah lolos registerCustomerSchema
 * @returns data publik pembeli yang baru dibuat
 * @throws galat `ER_DUP_ENTRY` (dijawab 409) bila nomor HP atau email sudah terdaftar
 */
export const registerCustomer = (input: RegisterCustomerInput) => insertUser(db, "customer", input);

/**
 * Mendaftarkan akun penjual sekaligus tokonya. Keduanya disimpan dalam satu transaksi: rangkaian perubahan database
 * yang disimpan semua atau dibatalkan semua, sehingga tidak pernah ada akun penjual tanpa toko.
 * @param input data pemilik (nama, nomor HP, email opsional, kata sandi) dan data toko (nama usaha, jenis usaha,
 *              alamat)
 * @returns data publik pengguna dan toko yang baru dibuat
 * @throws 400 VALIDATION_ERROR bila jenis usaha tidak ada atau nonaktif; galat `ER_DUP_ENTRY` (dijawab 409) bila nomor
 *         HP atau email sudah terdaftar
 */
export async function registerMerchant(
  input: RegisterMerchantInput,
): Promise<{ user: PublicUser; merchant: PublicMerchant }> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    // 1. Jenis usaha harus ada dan masih aktif.
    const [merchantTypes] = await conn.query<RowDataPacket[]>(
      "SELECT id FROM merchant_types WHERE id = ? AND is_active",
      [input.merchant_type_id],
    );
    if (merchantTypes.length === 0) {
      throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", {
        merchant_type_id: ["Jenis usaha tidak dikenal."],
      });
    }
    // 2. Buat akun penjual.
    const user = await insertUser(conn, "merchant", input);
    // 3. Buat toko. Slug = nama usaha + 4 karakter acak supaya dua toko bernama sama tetap punya alamat berbeda.
    //    Nomor WhatsApp toko awalnya sama dengan nomor HP pemilik.
    const slug = `${slugify(input.business_name)}-${randomBytes(2).toString("hex")}`;
    const [result] = await conn.query<ResultSetHeader>(
      "INSERT INTO merchants (user_id, merchant_type_id, business_name, slug, address, wa_number) VALUES (?, ?, ?, ?, ?, ?)",
      [user.id, input.merchant_type_id, input.business_name, slug, input.address, input.phone],
    );
    // 4. Simpan semuanya; bila ada langkah yang gagal, semua perubahan dibatalkan (rollback).
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

// Mengubah baris tabel users menjadi PublicUser. Kolom khusus admin hanya ditambahkan bila perannya admin.
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

/**
 * Membaca profil pengguna yang login beserta tokonya (bila penjual).
 * @param userId id pengguna yang login
 * @returns data publik pengguna, dan data toko atau `null` bila pengguna tidak punya toko
 */
export async function getMe(userId: number): Promise<{ user: PublicUser; merchant: PublicMerchant | null }> {
  const [users] = await db.query<RowDataPacket[]>("SELECT * FROM users WHERE id = ?", [userId]);
  const [merchants] = await db.query<RowDataPacket[]>(
    "SELECT id, business_name, slug, merchant_type_id, address, wa_number, verification_status, verification_note, suspended_reason FROM merchants WHERE user_id = ?",
    [userId],
  );
  return { user: toPublicUser(users[0]), merchant: (merchants[0] as PublicMerchant | undefined) ?? null };
}

/**
 * Mengubah profil pengguna yang login. Hanya kolom yang dikirim yang diubah.
 * Email kosong (`""`) berarti menghapus email; ini tidak boleh untuk pembeli, karena pembeli wajib punya email.
 * Email dan nomor HP dipakai untuk login, jadi mengubahnya wajib disertai kata sandi saat ini.
 * @param userId id pengguna yang login
 * @param role   peran pengguna yang login (menentukan boleh tidaknya email dikosongkan)
 * @param input  kolom yang ingin diubah: nama, nomor HP, email, foto profil, titik temu favorit, dan kata sandi saat
 *               ini (wajib bila email/nomor HP berubah)
 * @returns profil terbaru setelah diubah, sama bentuknya dengan {@link getMe}
 * @throws 400 VALIDATION_ERROR bila pembeli mengosongkan email, kata sandi saat ini tidak dikirim atau salah, foto
 *         bukan unggahan milik pengguna ini, atau titik temu tidak tersedia; galat `ER_DUP_ENTRY` (dijawab 409) bila
 *         email/nomor HP baru sudah dipakai akun lain
 */
export async function updateMe(
  userId: number,
  role: PublicUser["role"],
  input: UpdateMeInput,
): Promise<{ user: PublicUser; merchant: PublicMerchant | null }> {
  const { email, favorite_pickup_point_id: pickupPointId, full_name, phone, current_password, avatar_url } = input;
  // 1. Kumpulkan kolom yang akan diubah. Nama kolom ditulis di kode ini, bukan diambil dari isi permintaan.
  const columnValues: Record<string, string | number | null> = {};
  if (full_name !== undefined) columnValues.full_name = full_name;
  if (phone !== undefined) columnValues.phone = phone;
  if (email !== undefined) {
    if (email === "" && role === "customer") {
      throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { email: ["Email wajib diisi."] });
    }
    columnValues.email = email === "" ? null : email;
  }
  // 2. Email/nomor HP adalah pengenal login: bila nilainya benar-benar berubah, wajib dikonfirmasi dengan kata sandi.
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
  // 3. Foto profil hanya boleh hasil unggahan pengguna ini sendiri (folder users/<id>/avatar/).
  if (avatar_url !== undefined) {
    const [rows] = await db.query<RowDataPacket[]>("SELECT avatar_url FROM users WHERE id = ?", [userId]);
    validateImageUrl(avatar_url, rows[0].avatar_url, `users/${userId}/avatar/`, "avatar_url");
    columnValues.avatar_url = avatar_url;
  }
  // 4. Titik temu favorit harus masih aktif; `null` berarti menghapus pilihan.
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
  // 5. Simpan semua perubahan dalam satu UPDATE, lalu kirim profil terbaru.
  const columns = Object.keys(columnValues);
  if (columns.length > 0) {
    await db.query(`UPDATE users SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`, [
      ...Object.values(columnValues),
      userId,
    ]);
  }
  return getMe(userId);
}

/**
 * Keluar: menandai sesi sebagai dicabut, sehingga tokennya langsung tidak berlaku walaupun belum kedaluwarsa.
 * @param jti id sesi dari token yang sedang dipakai (klaim `jti` di JWT, sama dengan kolom auth_sessions.jti)
 * @returns hasil perintah UPDATE dari database (tidak dipakai pemanggil)
 */
export const logout = (jti: string) =>
  db.query("UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP() WHERE jti = ?", [jti]);

/**
 * Masuk dengan email atau nomor HP dan kata sandi, lalu membuat sesi baru.
 * JWT (JSON Web Token) adalah teks yang ditandatangani server dengan JWT_SECRET sehingga tidak bisa dipalsukan.
 * Isinya id pengguna (`sub`), peran, id sesi (`jti`), dan waktu kedaluwarsa (`exp`). Setiap sesi juga dicatat di tabel
 * auth_sessions supaya bisa dicabut sebelum waktunya (logout, ganti sandi).
 * @param input     email atau nomor HP, kata sandi, dan jenis klien (`web` atau `mobile`)
 * @param userAgent keterangan perangkat/browser dari header User-Agent, disimpan paling banyak 255 karakter
 * @returns token JWT, waktu kedaluwarsanya (`expires_at`, format ISO), dan data publik pengguna
 * @throws 401 UNAUTHENTICATED bila akun tidak ada/nonaktif, kata sandi salah, admin masuk lewat klien mobile, atau
 *         kata sandi diganti tepat saat login berlangsung
 */
export async function login(input: LoginInput, userAgent?: string) {
  // 1. Cari akun aktif berdasarkan email atau nomor HP. Email dibandingkan biner (COLLATE utf8mb4_bin), karena
  //    perbandingan bawaan mengabaikan aksen dan karakter kontrol sehingga email yang tampak sama bisa ikut cocok.
  const identifier = normalizeIdentifier(input.identifier);
  const [users] = await db.query<RowDataPacket[]>(
    `SELECT * FROM users WHERE ${"email" in identifier ? "email = ? COLLATE utf8mb4_bin" : "phone = ?"} AND is_active = TRUE`,
    ["email" in identifier ? identifier.email : identifier.phone],
  );
  const user = users[0];
  // 2. Selalu jalankan tepat satu bcrypt.compare, juga saat akun tidak ada (memakai DUMMY_HASH), supaya lama waktu
  //    jawaban tidak membocorkan apakah sebuah akun terdaftar.
  const passwordMatches = await bcrypt.compare(input.password, user?.password_hash ?? DUMMY_HASH);
  // 3. Admin hanya boleh masuk lewat web. Permintaan dengan `client: "mobile"` dijawab sama persis dengan sandi salah.
  if (!user || !passwordMatches || (user.role === "admin" && input.client === "mobile")) {
    throw new AppError(401, "UNAUTHENTICATED", "Email/WA atau password salah.");
  }

  // 4. Buat token: masa berlakunya berbeda untuk web dan mobile (JWT_TTL_WEB / JWT_TTL_MOBILE).
  const jti = randomUUID();
  const expiresIn = (input.client === "web" ? env.JWT_TTL_WEB : env.JWT_TTL_MOBILE) as SignOptions["expiresIn"];
  const token = jwt.sign({ sub: String(user.id), role: user.role }, env.JWT_SECRET, { jwtid: jti, expiresIn });
  const expiresAt = new Date((jwt.decode(token) as JwtPayload).exp! * 1000);
  // 5. Catat sesi, tetapi hanya bila hash sandi di database masih sama dengan yang tadi dicocokkan. Bila sandi diganti
  //    di antara langkah 2 dan langkah ini, tidak ada baris yang tersimpan dan login ditolak. Bila sesi tersimpan
  //    sebelum hash baru ditulis, sesi itu ikut dicabut, karena ganti/reset sandi mencabut sesi setelah menulis hash.
  const [sessionInsert] = await db.query<ResultSetHeader>(
    "INSERT INTO auth_sessions (user_id, jti, client, user_agent, expires_at) SELECT id, ?, ?, ?, ? FROM users WHERE id = ? AND password_hash = ?",
    [jti, input.client, userAgent?.slice(0, 255) ?? null, expiresAt, user.id, user.password_hash],
  );
  if (!sessionInsert.affectedRows) throw new AppError(401, "UNAUTHENTICATED", "Email/WA atau password salah.");
  return { token, expires_at: expiresAt.toISOString(), user: toPublicUser(user) };
}

// Memastikan kata sandi yang diketik cocok dengan hash tersimpan; bila tidak, galat 400 di kolom current_password.
async function assertPassword(plainPassword: string, passwordHash: string): Promise<void> {
  if (!(await bcrypt.compare(plainPassword, passwordHash))) {
    throw new AppError(400, "VALIDATION_ERROR", "Data tidak valid.", { current_password: ["Kata sandi lama salah."] });
  }
}

/**
 * Mengganti kata sandi pengguna yang login, lalu mencabut semua sesinya yang lain (perangkat lain harus login ulang).
 * Sesi yang sedang dipakai tetap berlaku. Tanda wajib ganti sandi (`must_change_password`) ikut dimatikan.
 * @param userId     id pengguna yang login
 * @param currentJti id sesi yang sedang dipakai; sesi ini tidak dicabut
 * @param input      kata sandi lama dan kata sandi baru
 * @throws 400 VALIDATION_ERROR bila kata sandi lama salah
 */
export async function changePassword(userId: number, currentJti: string, input: ChangePasswordInput): Promise<void> {
  // 1. Cocokkan kata sandi lama.
  const [rows] = await db.query<RowDataPacket[]>("SELECT password_hash FROM users WHERE id = ?", [userId]);
  await assertPassword(input.current_password, rows[0].password_hash);
  // 2. Tulis hash baru lebih dulu, baru cabut sesi lain, supaya login yang sedang berjalan dengan sandi lama tidak
  //    lolos (lihat langkah 5 di login). Bila pencabutan gagal, mengganti sandi sekali lagi (dengan sandi baru)
  //    mencabutnya.
  const newPasswordHash = await bcrypt.hash(input.new_password, BCRYPT_COST);
  await db.query("UPDATE users SET password_hash = ?, must_change_password = FALSE WHERE id = ?", [
    newPasswordHash,
    userId,
  ]);
  // 3. Cabut semua sesi aktif lain milik pengguna ini.
  await db.query(
    "UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND jti <> ? AND revoked_at IS NULL",
    [userId, currentJti],
  );
}
