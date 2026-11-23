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
// AUD-45: batas isi per bucket; yang tertua (urutan sisip Map) dibuang agar memori tidak tumbuh tanpa batas
const MAKS_KUNCI = 50_000;
const hit = (b: Bucket, key: string, now: number) => {
  for (const [k, v] of b.hits) if (v.resetAt <= now) b.hits.delete(k);
  if (!b.hits.has(key) && b.hits.size >= MAKS_KUNCI) b.hits.delete(b.hits.keys().next().value!);
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
  {
    reset: () => {
      perIp.hits.clear();
      perAccount.hits.clear();
    },
  },
);

// Ganti kata sandi: 5 kata sandi lama salah (400) per pengguna per menit; pola jatah sama dengan loginLimiter
const perUser = newBucket(5, 60_000);

// AUD-37: pendaftaran berhasil per sumber (IP klien) 60/jam. Hanya yang berhasil dihitung: gagal validasi atau nomor
// terdaftar tidak menjalankan bcrypt. Longgar karena satu WiFi kampus / proxy web bisa berbagi satu IP.
const perDaftar = newBucket(60, 3600_000);

export const registerLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, res, next) => {
    const key = String(clientIp(req));
    if (full(perDaftar, key, Date.now())) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti."));
    }
    res.on("finish", () => {
      if (res.statusCode === 201) hit(perDaftar, key, Date.now());
    });
    next();
  }) as RequestHandler,
  { reset: () => perDaftar.hits.clear() },
);

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
    // AUD-28: pola rute (req.route.path), bukan req.path: /AUTH/... atau garis miring akhir tidak boleh membuat bucket baru
    const email = `${req.route?.path ?? req.path.toLowerCase()}:${String(req.body.email)}`;
    const ip = String(clientIp(req));
    if (full(otpEmail, email, now) || full(otpIp, ip, now)) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak permintaan. Coba lagi beberapa menit lagi."));
    }
    hit(otpEmail, email, now);
    hit(otpIp, ip, now);
    next();
  }) as RequestHandler,
  {
    reset: () => {
      otpEmail.hits.clear();
      otpIp.hits.clear();
    },
  },
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

export const mejaLimiter: RequestHandler & { reset: () => void; ukuran: () => number } = Object.assign(
  ((req, _res, next) => {
    const now = Date.now();
    const key = String(req.params.token);
    // AUD-45: format token (32 hex) dicek sebelum masuk Map, sama dengan pesan mejaAktif
    if (!/^[0-9a-f]{32}$/.test(key))
      return next(new AppError(404, "NOT_FOUND", "Meja tidak ditemukan atau tidak aktif."));
    if (full(perMeja, key, now)) {
      return next(
        new AppError(429, "RATE_LIMITED", "Terlalu banyak pesanan dari meja ini. Coba lagi beberapa menit lagi."),
      );
    }
    hit(perMeja, key, now);
    next();
  }) as RequestHandler,
  { reset: () => perMeja.hits.clear(), ukuran: () => perMeja.hits.size },
);

// Tiket bantuan: 10 tiket baru per pembeli per jam. Hanya tiket yang jadi (201) dihitung; pola jatah sama dengan loginLimiter.
const perTiket = newBucket(10, 60 * 60_000);

export const tiketLimiter: RequestHandler & { reset: () => void } = Object.assign(
  ((req, res, next) => {
    const now = Date.now();
    const key = String((req as AuthedRequest).auth.userId);
    if (full(perTiket, key, now)) {
      return next(new AppError(429, "RATE_LIMITED", "Terlalu banyak tiket baru. Coba lagi dalam satu jam."));
    }
    // jatah diambil sinkron agar permintaan paralel tidak lolos; dikembalikan bila tiket tidak jadi (400, 409)
    hit(perTiket, key, now);
    res.on("finish", () => {
      if (res.statusCode !== 201) unhit(perTiket, key);
    });
    next();
  }) as RequestHandler,
  { reset: () => perTiket.hits.clear() },
);
