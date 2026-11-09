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
const newBucket = (max: number, windowMs: number): Bucket => ({ max, windowMs, hits: new Map() });
const perIp = newBucket(5, 60_000);
const perAccount = newBucket(10, 15 * 60_000);

const full = (b: Bucket, key: string, now: number) => {
  const e = b.hits.get(key);
  return !!e && e.resetAt > now && e.count >= b.max;
};
const hit = (b: Bucket, key: string, now: number) => {
  for (const [k, v] of b.hits) if (v.resetAt <= now) b.hits.delete(k);
  const e = b.hits.get(key) ?? { count: 0, resetAt: now + b.windowMs };
  e.count++;
  b.hits.set(key, e);
};

const unhit = (b: Bucket, key: string) => {
  const e = b.hits.get(key);
  if (e && --e.count <= 0) b.hits.delete(key);
};

// IP pengunjung dari server Next hanya dipercaya bila rahasia internal cocok
function clientIp(req: Request): string | undefined {
  const secret = env.INTERNAL_API_SECRET;
  const sent = req.get("x-internal-secret");
  const ip = req.get("x-client-ip");
  if (!secret || !sent || !ip || !isIP(ip)) return req.ip;
  const a = Buffer.from(secret);
  const b = Buffer.from(sent);
  return a.length === b.length && timingSafeEqual(a, b) ? ip : req.ip;
}

export const loginLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, res, next) => {
    const now = Date.now();
    const raw = req.body?.identifier;
    const id = normalizeIdentifier(typeof raw === "string" ? raw : "");
    // lipat aksen (DB mencocokkan email tanpa aksen) agar varian aksen berbagi satu bucket
    const ident = "email" in id ? id.email.normalize("NFD").replace(/\p{M}|[^\x00-\x7f]/gu, "") : id.phone;
    const ipKey = `${clientIp(req)}:${ident}`;
    if (full(perIp, ipKey, now) || full(perAccount, ident, now)) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak percobaan masuk. Coba lagi sebentar lagi."));
    }
    // jatah diambil sinkron agar permintaan paralel tidak lolos; dikembalikan bila bukan 401 (E1)
    hit(perIp, ipKey, now);
    hit(perAccount, ident, now);
    res.on("finish", () => {
      if (res.statusCode !== 401) {
        unhit(perIp, ipKey);
        unhit(perAccount, ident);
      }
    });
    next();
  }) as RequestHandler,
  { reset: () => { perIp.hits.clear(); perAccount.hits.clear(); } },
);

// Ganti kata sandi: 5 kata sandi lama salah (400) per pengguna per menit; pola jatah sama dengan loginLimiter
const perUser = newBucket(5, 60_000);

export const passwordLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, res, next) => {
    const now = Date.now();
    const key = String((req as AuthedRequest).auth.userId);
    if (full(perUser, key, now)) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak percobaan. Coba lagi sebentar lagi."));
    }
    hit(perUser, key, now);
    // validate berjalan lebih dulu, jadi 400 di sini hanya berarti kata sandi lama salah
    res.on("finish", () => {
      if (res.statusCode !== 400) unhit(perUser, key);
    });
    next();
  }) as RequestHandler,
  { reset: () => perUser.hits.clear() },
);

// Unggah: 20 URL presign per pengguna per 10 menit (D14); tiap URL boleh mengisi 5 MB ke bucket berbayar
const perUpload = newBucket(20, 10 * 60_000);

export const uploadLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, _res, next) => {
    const now = Date.now();
    const key = String((req as AuthedRequest).auth.userId);
    if (full(perUpload, key, now)) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak unggahan. Coba lagi beberapa menit lagi."));
    }
    hit(perUpload, key, now);
    next();
  }) as RequestHandler,
  { reset: () => perUpload.hits.clear() },
);

// F11 OTP lupa sandi: semua permintaan dihitung. Per rute+email 5/15 menit (spam email, tebak kode), per IP 30/15 menit.
const otpEmail = newBucket(5, 15 * 60_000);
const otpIp = newBucket(30, 15 * 60_000);

export const otpLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, _res, next) => {
    const now = Date.now();
    // validate berjalan lebih dulu: email sudah dirapikan huruf kecil
    const email = `${req.path}:${String(req.body.email)}`;
    const ip = String(clientIp(req));
    if (full(otpEmail, email, now) || full(otpIp, ip, now)) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak permintaan. Coba lagi beberapa menit lagi."));
    }
    hit(otpEmail, email, now);
    hit(otpIp, ip, now);
    next();
  }) as RequestHandler,
  { reset: () => { otpEmail.hits.clear(); otpIp.hits.clear(); } },
);

// F17 asisten AI: setiap panggilan Gemini berbayar → 10 pertanyaan per toko per 10 menit
const perAsisten = newBucket(10, 10 * 60_000);

export const asistenLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, _res, next) => {
    const now = Date.now();
    const key = String((req as AuthedRequest).auth.userId);
    if (full(perAsisten, key, now)) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak pertanyaan. Coba lagi beberapa menit lagi."));
    }
    hit(perAsisten, key, now);
    next();
  }) as RequestHandler,
  { reset: () => perAsisten.hits.clear() },
);

// F21 pesanan meja tanpa login: per meja (token di URL), 15 pesanan per 10 menit. Per meja, bukan per IP:
// permintaan datang lewat server web sehingga IP tamu tidak selalu terlihat.
const perMeja = newBucket(15, 10 * 60_000);

export const mejaLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, _res, next) => {
    const now = Date.now();
    const key = String(req.params.token);
    if (full(perMeja, key, now)) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak pesanan dari meja ini. Coba lagi beberapa menit lagi."));
    }
    hit(perMeja, key, now);
    next();
  }) as RequestHandler,
  { reset: () => perMeja.hits.clear() },
);
