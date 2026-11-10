import request from "supertest";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { uploadLimiter } from "../src/middleware/rateLimiter";
import { presignPut, r2Config, sigv4Query } from "../src/utils/r2";
import { R2_UJI, isiR2, siapkanToko } from "./helpers/toko";

describe("SigV4 (D11)", () => {
  test("vektor resmi AWS: GET test.txt presigned 86400 detik", () => {
    const url = sigv4Query({
      method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", region: "us-east-1", service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: new Date("2013-05-24T00:00:00Z"), expires: 86400, headers: {},
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z" +
        "&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  test("presignPut R2: host akun, path-style, 300 dtk, menandatangani ukuran & tipe, tanpa rahasia", () => {
    const cfg = { accountId: "acc", accessKeyId: "AKIDUJI", secretAccessKey: "rahasia/r2+uji", bucket: "bucket", publicUrl: "https://foto.test" };
    const key = "merchants/7/menu/0b9a4b7e-1f3e-4c55-9d1a-2f6a0e3c9b11.webp";
    const u = new URL(presignPut(cfg, { key, contentType: "image/webp", size: 1000, now: new Date("2026-11-01T00:00:00Z") }));
    expect(u.host).toBe("acc.r2.cloudflarestorage.com");
    expect(u.pathname).toBe(`/bucket/${key}`);
    expect(u.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(u.searchParams.get("X-Amz-Credential")).toBe("AKIDUJI/20261101/auto/s3/aws4_request");
    expect(u.search).toContain("X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    const s = u.toString();
    for (const bagian of ["rahasia", encodeURIComponent("rahasia/r2+uji")]) expect(s).not.toContain(bagian);
  });
});

describe("endpoint unggah (D12–D14)", () => {
  let tA: string, tB: string, tCust: string, idA: number;
  const up = (t: string | null, b: object, u = "/merchant/uploads") => {
    const r = request(app).post(`/api/v1${u}`).send(b);
    return t ? r.set("Authorization", `Bearer ${t}`) : r;
  };
  const MENU = { purpose: "menu", content_type: "image/webp", size: 1000 };

  beforeEach(async () => {
    ({ tA, tB, tCust, idA } = await siapkanToko());
    uploadLimiter.reset();
    isiR2();
  });
  afterEach(() => { isiR2(false); });

  test("R2 kosong → 503 di kedua endpoint", async () => {
    isiR2(false);
    expect(r2Config()).toBeNull();
    for (const [t, u, b] of [[tA, "/merchant/uploads", MENU], [tCust, "/me/avatar", { content_type: "image/png", size: 10 }]] as const) {
      const r = await up(t, b, u).expect(503);
      expect(r.body.error).toEqual({ code: "SERVICE_UNAVAILABLE", message: "Unggah foto belum tersedia. Coba lagi nanti." });
    }
  });

  test("penjual: kunci dibuat server di bawah awalan toko & purpose", async () => {
    const t0 = Date.now();
    const r = await up(tA, { ...MENU, key: "x/../../evil.webp", path: "/etc" }).expect(200);
    const { upload_url, public_url, expires_at } = r.body.data;
    expect(Object.keys(r.body.data).sort()).toEqual(["expires_at", "public_url", "upload_url"]);
    expect(public_url).toMatch(new RegExp(`^${R2_UJI.R2_PUBLIC_URL}/merchants/${idA}/menu/[0-9a-f-]{36}\\.webp$`));
    const key = public_url.slice(R2_UJI.R2_PUBLIC_URL.length + 1);
    expect(new URL(upload_url).pathname).toBe(`/bucket/${key}`);
    expect(upload_url).not.toContain(R2_UJI.R2_SECRET_ACCESS_KEY);
    const exp = Date.parse(expires_at);
    expect(exp).toBeGreaterThanOrEqual(t0 + 299_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 301_000);
    const lagi = await up(tA, MENU).expect(200);
    expect(lagi.body.data.public_url).not.toBe(public_url);
    expect((await up(tA, { ...MENU, purpose: "logo", content_type: "image/jpeg" }).expect(200)).body.data.public_url)
      .toMatch(new RegExp(`/merchants/${idA}/logo/[0-9a-f-]{36}\\.jpg$`));
  });

  test("validasi tipe, ukuran, purpose", async () => {
    const svg = await up(tA, { ...MENU, content_type: "image/svg+xml" }).expect(400);
    expect(svg.body.error.fields.content_type).toEqual(["Format foto harus JPG, PNG, atau WebP."]);
    const besar = await up(tA, { ...MENU, size: 5242881 }).expect(400);
    expect(besar.body.error.fields.size).toEqual(["Ukuran foto maksimal 5 MB."]);
    expect((await up(tA, { ...MENU, size: 0 }).expect(400)).body.error.fields.size).toBeDefined();
    expect((await up(tA, { ...MENU, purpose: "avatar" }).expect(400)).body.error.fields.purpose).toBeDefined();
    // F26: QRIS toko dihapus
    expect((await up(tA, { ...MENU, purpose: "qris" }).expect(400)).body.error.fields.purpose).toEqual(["Jenis foto tidak dikenal."]);
    await up(tA, { ...MENU, size: 5242880 }).expect(200);
  });

  test("peran: tanpa token 401, pembeli ke /merchant/uploads 403, pembeli ke /me/avatar 200", async () => {
    await up(null, MENU).expect(401);
    await up(null, { content_type: "image/png", size: 10 }, "/me/avatar").expect(401);
    await up(tCust, MENU).expect(403);
    const r = await up(tCust, { content_type: "image/png", size: 10 }, "/me/avatar").expect(200);
    const [[u]] = await db.query<any[]>("SELECT id FROM users WHERE email = 'budi@mail.com'");
    expect(r.body.data.public_url).toMatch(new RegExp(`^${R2_UJI.R2_PUBLIC_URL}/users/${u.id}/avatar/[0-9a-f-]{36}\\.png$`));
  });

  test("batas 20 per pengguna per 10 menit → 429; pengguna lain tetap 200", async () => {
    for (let i = 0; i < 20; i++) await up(tA, MENU).expect(200);
    const r = await up(tA, MENU).expect(429);
    expect(r.body.error).toEqual({ code: "RATE_LIMITED", message: "Terlalu banyak unggahan. Coba lagi beberapa menit lagi." });
    await up(tA, { content_type: "image/png", size: 10 }, "/me/avatar").expect(429);
    await up(tB, MENU).expect(200);
  });
});
