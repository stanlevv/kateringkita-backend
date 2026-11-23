// Isi file: rate limiter, yaitu pembatas jumlah percobaan dalam rentang waktu tertentu (contoh 5 kali gagal login per
// menit), untuk menahan tebak-tebakan sandi, spam email, dan pemborosan layanan berbayar. Dipasang di routes tertentu
// sebelum handler: request masuk → middleware → routes (… → validate → limiter) → handlers → services → database.
// Penghitung disimpan per "bucket": satu Map berisi kunci (IP, akun, atau token) → jumlah percobaan dan waktu reset.
// Setiap limiter punya `reset()` untuk mengosongkan penghitungnya di test.
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { Request, RequestHandler } from "express";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { AuthedRequest } from "./auth";
import { normalizeIdentifier } from "../dto/auth.dto";

// shortcut: memori per proses, benar untuk 1 instance; pindah ke tabel/Redis bila API diskalakan >1 instance
// Login: hanya percobaan gagal (401) yang dihitung. Per IP klien+identifier: 5/menit; per akun (semua IP): 10/15 menit.
type Bucket = { max: number; windowMs: number; hits: Map<string, { count: number; resetAt: number }> };
const createBucket = (max: number, windowMs: number): Bucket => ({ max, windowMs, hits: new Map() });
const loginByIp = createBucket(5, 60_000);
const loginByAccount = createBucket(10, 15 * 60_000);

// Penuh = kunci ini sudah mencapai batas dan rentang waktunya belum berakhir.
const isFull = (bucket: Bucket, key: string, now: number) => {
  const entry = bucket.hits.get(key);
  return !!entry && entry.resetAt > now && entry.count >= bucket.max;
};
// Batas jumlah kunci per bucket; bila penuh, kunci tertua (urutan masuk Map) dibuang agar memori tidak tumbuh tanpa
// batas saat ada banjir permintaan dengan kunci berbeda-beda.
const MAX_KEYS = 50_000;
// Menambah satu hitungan untuk kunci. Sekalian membuang kunci yang rentang waktunya sudah berakhir.
const addHit = (bucket: Bucket, key: string, now: number) => {
  for (const [storedKey, storedEntry] of bucket.hits) if (storedEntry.resetAt <= now) bucket.hits.delete(storedKey);
  if (!bucket.hits.has(key) && bucket.hits.size >= MAX_KEYS) bucket.hits.delete(bucket.hits.keys().next().value!);
  const entry = bucket.hits.get(key) ?? { count: 0, resetAt: now + bucket.windowMs };
  entry.count++;
  bucket.hits.set(key, entry);
};

// Mengembalikan satu hitungan (untuk percobaan yang ternyata tidak perlu dihitung).
const removeHit = (bucket: Bucket, key: string) => {
  const entry = bucket.hits.get(key);
  if (entry && --entry.count <= 0) bucket.hits.delete(key);
};

// IP pengunjung asli dari header X-Client-IP hanya dipercaya bila dikirim server web (Next) yang membawa rahasia
// internal yang cocok; selain itu dipakai IP penghubung langsung (req.ip).
function getClientIp(req: Request): string | undefined {
  const secret = env.INTERNAL_API_SECRET;
  const sentSecret = req.get("x-internal-secret");
  const forwardedIp = req.get("x-client-ip");
  if (!secret || !sentSecret || !forwardedIp || !isIP(forwardedIp)) return req.ip;
  const secretBuffer = Buffer.from(secret);
  const sentBuffer = Buffer.from(sentSecret);
  return secretBuffer.length === sentBuffer.length && timingSafeEqual(secretBuffer, sentBuffer) ? forwardedIp : req.ip;
}

/**
 * Pembatas login: 5 kali gagal per menit untuk pasangan IP+akun, dan 10 kali gagal per 15 menit untuk satu akun dari
 * IP mana pun. Hanya login yang gagal (401) yang dihitung.
 * @throws 429 RATE_LIMITED (diteruskan ke errorHandler) bila batas sudah tercapai
 */
export const loginLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, res, next) => {
    const now = Date.now();
    // 1. Kunci akun = email (huruf beraksen dibuang, karena database juga mencocokkan email tanpa aksen, jadi variasi
    //    aksen dihitung sebagai akun yang sama) atau nomor HP.
    const rawIdentifier = req.body?.identifier;
    const identifier = normalizeIdentifier(typeof rawIdentifier === "string" ? rawIdentifier : "");
    const accountKey =
      "email" in identifier ? identifier.email.normalize("NFD").replace(/\p{M}|[^\x00-\x7f]/gu, "") : identifier.phone;
    const ipKey = `${getClientIp(req)}:${accountKey}`;
    // 2. Tolak bila salah satu batas sudah tercapai.
    if (isFull(loginByIp, ipKey, now) || isFull(loginByAccount, accountKey, now)) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak percobaan masuk. Coba lagi sebentar lagi."));
    }
    // 3. Jatah diambil sekarang juga (sebelum login diproses) supaya banyak permintaan bersamaan tidak lolos semua.
    addHit(loginByIp, ipKey, now);
    addHit(loginByAccount, accountKey, now);
    // 4. Setelah respons terkirim: bila login tidak gagal (bukan 401), jatahnya dikembalikan.
    res.on("finish", () => {
      if (res.statusCode !== 401) {
        removeHit(loginByIp, ipKey);
        removeHit(loginByAccount, accountKey);
      }
    });
    next();
  }) as RequestHandler,
  {
    reset: () => {
      loginByIp.hits.clear();
      loginByAccount.hits.clear();
    },
  },
);

// Ganti kata sandi: 5 kata sandi lama salah (400) per pengguna per menit.
const passwordByUser = createBucket(5, 60_000);

// Pendaftaran berhasil per sumber (IP klien): 60 per jam. Hanya yang berhasil dihitung, karena pendaftaran yang gagal
// validasi atau nomornya sudah terdaftar tidak sempat menjalankan hash sandi (pengacakan sandi satu arah sebelum
// disimpan, yang sengaja dibuat berat). Batasnya longgar karena satu WiFi kampus atau server web bisa berbagi satu IP.
const registerByIp = createBucket(60, 3600_000);

/**
 * Pembatas pendaftaran akun: 60 pendaftaran berhasil (201) per IP per jam.
 * @throws 429 RATE_LIMITED bila batas sudah tercapai
 */
export const registerLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, res, next) => {
    const key = String(getClientIp(req));
    if (isFull(registerByIp, key, Date.now())) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti."));
    }
    res.on("finish", () => {
      if (res.statusCode === 201) addHit(registerByIp, key, Date.now());
    });
    next();
  }) as RequestHandler,
  { reset: () => registerByIp.hits.clear() },
);

/**
 * Pembatas ganti kata sandi: 5 kali kata sandi lama salah per pengguna per menit.
 * @throws 429 RATE_LIMITED bila batas sudah tercapai
 */
export const passwordLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, res, next) => {
    // 1. Tolak bila batas pengguna ini sudah tercapai; bila belum, ambil jatahnya sekarang.
    const now = Date.now();
    const key = String((req as AuthedRequest).auth.userId);
    if (isFull(passwordByUser, key, now)) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak percobaan. Coba lagi sebentar lagi."));
    }
    addHit(passwordByUser, key, now);
    // 2. validate berjalan lebih dulu, jadi 400 di sini hanya berarti kata sandi lama salah; selain itu jatah
    //    dikembalikan.
    res.on("finish", () => {
      if (res.statusCode !== 400) removeHit(passwordByUser, key);
    });
    next();
  }) as RequestHandler,
  { reset: () => passwordByUser.hits.clear() },
);

// Unggah: 20 presigned URL per pengguna per 10 menit, karena tiap URL boleh mengisi 5 MB ke penyimpanan berbayar.
const uploadByUser = createBucket(20, 10 * 60_000);

/**
 * Pembatas permintaan alamat unggah foto: 20 per pengguna per 10 menit. Semua permintaan dihitung.
 * @throws 429 RATE_LIMITED bila batas sudah tercapai
 */
export const uploadLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, _res, next) => {
    const now = Date.now();
    const key = String((req as AuthedRequest).auth.userId);
    if (isFull(uploadByUser, key, now)) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak unggahan. Coba lagi beberapa menit lagi."));
    }
    addHit(uploadByUser, key, now);
    next();
  }) as RequestHandler,
  { reset: () => uploadByUser.hits.clear() },
);

// OTP lupa sandi: semua permintaan dihitung. Per rute+email 5 per 15 menit (mencegah spam email dan tebak kode),
// per IP 30 per 15 menit.
const otpByEmail = createBucket(5, 15 * 60_000);
const otpByIp = createBucket(30, 15 * 60_000);

/**
 * Pembatas permintaan kode OTP lupa sandi: 5 per rute+email dan 30 per IP, masing-masing per 15 menit.
 * @throws 429 RATE_LIMITED bila salah satu batas sudah tercapai
 */
export const otpLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, _res, next) => {
    const now = Date.now();
    // 1. Kunci email memakai pola rute (req.route.path), bukan path yang diketik, supaya /AUTH/… atau garis miring
    //    akhir tidak membuat penghitung baru. validate berjalan lebih dulu, jadi email sudah huruf kecil.
    const emailKey = `${req.route?.path ?? req.path.toLowerCase()}:${String(req.body.email)}`;
    const ipKey = String(getClientIp(req));
    // 2. Tolak bila salah satu batas sudah tercapai; bila belum, catat permintaan ini di kedua penghitung.
    if (isFull(otpByEmail, emailKey, now) || isFull(otpByIp, ipKey, now)) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak permintaan. Coba lagi beberapa menit lagi."));
    }
    addHit(otpByEmail, emailKey, now);
    addHit(otpByIp, ipKey, now);
    next();
  }) as RequestHandler,
  {
    reset: () => {
      otpByEmail.hits.clear();
      otpByIp.hits.clear();
    },
  },
);

// Asisten AI: setiap panggilan ke AI berbayar, jadi 10 pertanyaan per pengguna per 10 menit.
const assistantByUser = createBucket(10, 10 * 60_000);

/**
 * Pembatas pertanyaan ke asisten AI: 10 per pengguna per 10 menit. Semua pertanyaan dihitung.
 * @throws 429 RATE_LIMITED bila batas sudah tercapai
 */
export const assistantLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, _res, next) => {
    const now = Date.now();
    const key = String((req as AuthedRequest).auth.userId);
    if (isFull(assistantByUser, key, now)) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak pertanyaan. Coba lagi beberapa menit lagi."));
    }
    addHit(assistantByUser, key, now);
    next();
  }) as RequestHandler,
  { reset: () => assistantByUser.hits.clear() },
);

// Pesanan meja tanpa login: per meja (token di URL), 15 pesanan per 10 menit. Dihitung per meja, bukan per IP, karena
// permintaan datang lewat server web sehingga IP tamu tidak selalu terlihat.
const tableOrderByToken = createBucket(15, 10 * 60_000);

/**
 * Pembatas pesanan dari meja QR: 15 pesanan per token meja per 10 menit. `size()` mengembalikan jumlah kunci tersimpan
 * (dipakai test untuk memastikan token rusak tidak ikut tersimpan).
 * @throws 404 NOT_FOUND bila format token bukan 32 karakter hex, 429 RATE_LIMITED bila batas sudah tercapai
 */
export const tableOrderLimiter: RequestHandler & { reset: () => void; size: () => number } = Object.assign(
  ((req, _res, next) => {
    const now = Date.now();
    const key = String(req.params.token);
    // 1. Format token (32 karakter hex) dicek sebelum masuk Map, supaya token asal-asalan tidak memenuhi memori.
    //    Pesannya sama dengan pesan meja tidak ditemukan di table.service.
    if (!/^[0-9a-f]{32}$/.test(key))
      return next(new AppError(404, "NOT_FOUND", "Meja tidak ditemukan atau tidak aktif."));
    // 2. Tolak bila batas meja ini sudah tercapai; bila belum, catat pesanan ini.
    if (isFull(tableOrderByToken, key, now)) {
      return next(
        new AppError(429, "RATE_LIMITED", "Terlalu banyak pesanan dari meja ini. Coba lagi beberapa menit lagi."),
      );
    }
    addHit(tableOrderByToken, key, now);
    next();
  }) as RequestHandler,
  { reset: () => tableOrderByToken.hits.clear(), size: () => tableOrderByToken.hits.size },
);

// Tiket bantuan: 10 tiket baru per pembeli per jam. Hanya tiket yang jadi (201) yang dihitung.
const ticketByUser = createBucket(10, 60 * 60_000);

/**
 * Pembatas tiket bantuan baru: 10 tiket yang berhasil dibuat per pembeli per jam.
 * @throws 429 RATE_LIMITED bila batas sudah tercapai
 */
export const ticketLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, res, next) => {
    // 1. Tolak bila batas pembeli ini sudah tercapai.
    const now = Date.now();
    const key = String((req as AuthedRequest).auth.userId);
    if (isFull(ticketByUser, key, now)) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak tiket baru. Coba lagi dalam satu jam."));
    }
    // 2. Jatah diambil sekarang supaya banyak permintaan bersamaan tidak lolos semua; dikembalikan bila tiket tidak
    //    jadi dibuat (contoh 400 atau 409).
    addHit(ticketByUser, key, now);
    res.on("finish", () => {
      if (res.statusCode !== 201) removeHit(ticketByUser, key);
    });
    next();
  }) as RequestHandler,
  { reset: () => ticketByUser.hits.clear() },
);
