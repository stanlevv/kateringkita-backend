import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { Request, RequestHandler } from "express";
import { env } from "../config/env";
import { AppError } from "../utils/errors";
import { AuthedRequest } from "./auth";
import { normalizeIdentifier } from "../dto/auth.dto";

// shortcut: memori per proses, benar untuk 1 instance; pindah ke tabel/Redis bila API diskalakan >1 instance
// Hanya percobaan gagal (401) yang dihitung. Per IP klien+identifier: 5/menit; per akun (semua IP): 10/15 menit.
type Bucket = { max: number; windowMs: number; hits: Map<string, { count: number; resetAt: number }> };
const createBucket = (max: number, windowMs: number): Bucket => ({ max, windowMs, hits: new Map() });
const loginByIp = createBucket(5, 60_000);
const loginByAccount = createBucket(10, 15 * 60_000);

const isFull = (bucket: Bucket, key: string, now: number) => {
  const entry = bucket.hits.get(key);
  return !!entry && entry.resetAt > now && entry.count >= bucket.max;
};
// AUD-45: batas isi per bucket; yang tertua (urutan sisip Map) dibuang agar memori tidak tumbuh tanpa batas
const MAX_KEYS = 50_000;
const addHit = (bucket: Bucket, key: string, now: number) => {
  for (const [storedKey, storedEntry] of bucket.hits) if (storedEntry.resetAt <= now) bucket.hits.delete(storedKey);
  if (!bucket.hits.has(key) && bucket.hits.size >= MAX_KEYS) bucket.hits.delete(bucket.hits.keys().next().value!);
  const entry = bucket.hits.get(key) ?? { count: 0, resetAt: now + bucket.windowMs };
  entry.count++;
  bucket.hits.set(key, entry);
};

const removeHit = (bucket: Bucket, key: string) => {
  const entry = bucket.hits.get(key);
  if (entry && --entry.count <= 0) bucket.hits.delete(key);
};

// IP pengunjung dari server Next hanya dipercaya bila rahasia internal cocok
function getClientIp(req: Request): string | undefined {
  const secret = env.INTERNAL_API_SECRET;
  const sentSecret = req.get("x-internal-secret");
  const ip = req.get("x-client-ip");
  if (!secret || !sentSecret || !ip || !isIP(ip)) return req.ip;
  const secretBuffer = Buffer.from(secret);
  const sentBuffer = Buffer.from(sentSecret);
  return secretBuffer.length === sentBuffer.length && timingSafeEqual(secretBuffer, sentBuffer) ? ip : req.ip;
}

export const loginLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, res, next) => {
    const now = Date.now();
    const rawIdentifier = req.body?.identifier;
    const identifier = normalizeIdentifier(typeof rawIdentifier === "string" ? rawIdentifier : "");
    // lipat aksen (DB mencocokkan email tanpa aksen) agar varian aksen berbagi satu bucket
    const accountKey =
      "email" in identifier ? identifier.email.normalize("NFD").replace(/\p{M}|[^\x00-\x7f]/gu, "") : identifier.phone;
    const ipKey = `${getClientIp(req)}:${accountKey}`;
    if (isFull(loginByIp, ipKey, now) || isFull(loginByAccount, accountKey, now)) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak percobaan masuk. Coba lagi sebentar lagi."));
    }
    // jatah diambil sinkron agar permintaan paralel tidak lolos; dikembalikan bila bukan 401 (E1)
    addHit(loginByIp, ipKey, now);
    addHit(loginByAccount, accountKey, now);
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

// Ganti kata sandi: 5 kata sandi lama salah (400) per pengguna per menit; pola jatah sama dengan loginLimiter
const passwordByUser = createBucket(5, 60_000);

// AUD-37: pendaftaran berhasil per sumber (IP klien) 60/jam. Hanya yang berhasil dihitung: gagal validasi atau nomor
// terdaftar tidak menjalankan bcrypt. Longgar karena satu WiFi kampus / proxy web bisa berbagi satu IP.
const registerByIp = createBucket(60, 3600_000);

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

export const passwordLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, res, next) => {
    const now = Date.now();
    const key = String((req as AuthedRequest).auth.userId);
    if (isFull(passwordByUser, key, now)) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak percobaan. Coba lagi sebentar lagi."));
    }
    addHit(passwordByUser, key, now);
    // validate berjalan lebih dulu, jadi 400 di sini hanya berarti kata sandi lama salah
    res.on("finish", () => {
      if (res.statusCode !== 400) removeHit(passwordByUser, key);
    });
    next();
  }) as RequestHandler,
  { reset: () => passwordByUser.hits.clear() },
);

// Unggah: 20 URL presign per pengguna per 10 menit (D14); tiap URL boleh mengisi 5 MB ke bucket berbayar
const uploadByUser = createBucket(20, 10 * 60_000);

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

// F11 OTP lupa sandi: semua permintaan dihitung. Per rute+email 5/15 menit (spam email, tebak kode), per IP 30/15 menit.
const otpByEmail = createBucket(5, 15 * 60_000);
const otpByIp = createBucket(30, 15 * 60_000);

export const otpLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, _res, next) => {
    const now = Date.now();
    // validate berjalan lebih dulu: email sudah dirapikan huruf kecil
    // AUD-28: pola rute (req.route.path), bukan req.path: /AUTH/... atau garis miring akhir tidak boleh membuat bucket baru
    const emailKey = `${req.route?.path ?? req.path.toLowerCase()}:${String(req.body.email)}`;
    const ipKey = String(getClientIp(req));
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

// F17 asisten AI: setiap panggilan Gemini berbayar → 10 pertanyaan per toko per 10 menit
const assistantByUser = createBucket(10, 10 * 60_000);

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

// F21 pesanan meja tanpa login: per meja (token di URL), 15 pesanan per 10 menit. Per meja, bukan per IP:
// permintaan datang lewat server web sehingga IP tamu tidak selalu terlihat.
const tableOrderByToken = createBucket(15, 10 * 60_000);

export const tableOrderLimiter: RequestHandler & { reset: () => void; size: () => number } = Object.assign(
  ((req, _res, next) => {
    const now = Date.now();
    const key = String(req.params.token);
    // AUD-45: format token (32 hex) dicek sebelum masuk Map, sama dengan pesan getActiveTable
    if (!/^[0-9a-f]{32}$/.test(key))
      return next(new AppError(404, "NOT_FOUND", "Meja tidak ditemukan atau tidak aktif."));
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

// Tiket bantuan: 10 tiket baru per pembeli per jam. Hanya tiket yang jadi (201) dihitung; pola jatah sama dengan loginLimiter.
const ticketByUser = createBucket(10, 60 * 60_000);

export const ticketLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, res, next) => {
    const now = Date.now();
    const key = String((req as AuthedRequest).auth.userId);
    if (isFull(ticketByUser, key, now)) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak tiket baru. Coba lagi dalam satu jam."));
    }
    // jatah diambil sinkron agar permintaan paralel tidak lolos; dikembalikan bila tiket tidak jadi (400, 409)
    addHit(ticketByUser, key, now);
    res.on("finish", () => {
      if (res.statusCode !== 201) removeHit(ticketByUser, key);
    });
    next();
  }) as RequestHandler,
  { reset: () => ticketByUser.hits.clear() },
);
