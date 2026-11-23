import request from "supertest";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { uploadLimiter } from "../src/middleware/rate-limiter";
import { presignPut, getR2Config, presignSigV4Url } from "../src/utils/r2";
import { TEST_R2_ENV, setR2Env, prepareMerchants } from "./helpers/merchant";

describe("SigV4 (D11)", () => {
  test("vektor resmi AWS: GET test.txt presigned 86400 detik", () => {
    const url = presignSigV4Url({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: new Date("2013-05-24T00:00:00Z"),
      expires: 86400,
      headers: {},
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z" +
        "&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  test("presignPut R2: host akun, path-style, 300 dtk, menandatangani ukuran & tipe, tanpa rahasia", () => {
    const config = {
      accountId: "acc",
      accessKeyId: "AKIDUJI",
      secretAccessKey: "rahasia/r2+uji",
      bucket: "bucket",
      publicUrl: "https://foto.test",
    };
    const key = "merchants/7/menu/0b9a4b7e-1f3e-4c55-9d1a-2f6a0e3c9b11.webp";
    const presignedUrl = new URL(
      presignPut(config, { key, contentType: "image/webp", size: 1000, now: new Date("2026-11-01T00:00:00Z") }),
    );
    expect(presignedUrl.host).toBe("acc.r2.cloudflarestorage.com");
    expect(presignedUrl.pathname).toBe(`/bucket/${key}`);
    expect(presignedUrl.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(presignedUrl.searchParams.get("X-Amz-Credential")).toBe("AKIDUJI/20261101/auto/s3/aws4_request");
    expect(presignedUrl.search).toContain("X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost");
    expect(presignedUrl.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    const urlText = presignedUrl.toString();
    for (const bagian of ["rahasia", encodeURIComponent("rahasia/r2+uji")]) expect(urlText).not.toContain(bagian);
  });
});

describe("endpoint unggah (D12–D14)", () => {
  let tokenA: string, tokenB: string, customerToken: string, idA: number;
  const requestUpload = (token: string | null, body: object, path = "/merchant/uploads") => {
    const req = request(app).post(`/api/v1${path}`).send(body);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };
  const MENU = { purpose: "menu", content_type: "image/webp", size: 1000 };

  beforeEach(async () => {
    ({ tokenA, tokenB, customerToken, idA } = await prepareMerchants());
    uploadLimiter.reset();
    setR2Env();
  });
  afterEach(() => {
    setR2Env(false);
  });

  test("R2 kosong → 503 di kedua endpoint", async () => {
    setR2Env(false);
    expect(getR2Config()).toBeNull();
    for (const [token, path, body] of [
      [tokenA, "/merchant/uploads", MENU],
      [customerToken, "/me/avatar", { content_type: "image/png", size: 10 }],
    ] as const) {
      const res = await requestUpload(token, body, path).expect(503);
      expect(res.body.error).toEqual({
        code: "SERVICE_UNAVAILABLE",
        message: "Unggah foto belum tersedia. Coba lagi nanti.",
      });
    }
  });

  test("penjual: kunci dibuat server di bawah awalan toko & purpose", async () => {
    const startMs = Date.now();
    const res = await requestUpload(tokenA, { ...MENU, key: "x/../../evil.webp", path: "/etc" }).expect(200);
    const { upload_url, public_url, expires_at } = res.body.data;
    expect(Object.keys(res.body.data).sort()).toEqual(["expires_at", "public_url", "upload_url"]);
    expect(public_url).toMatch(new RegExp(`^${TEST_R2_ENV.R2_PUBLIC_URL}/merchants/${idA}/menu/[0-9a-f-]{36}\\.webp$`));
    const key = public_url.slice(TEST_R2_ENV.R2_PUBLIC_URL.length + 1);
    expect(new URL(upload_url).pathname).toBe(`/bucket/${key}`);
    expect(upload_url).not.toContain(TEST_R2_ENV.R2_SECRET_ACCESS_KEY);
    const exp = Date.parse(expires_at);
    expect(exp).toBeGreaterThanOrEqual(startMs + 299_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 301_000);
    const lagi = await requestUpload(tokenA, MENU).expect(200);
    expect(lagi.body.data.public_url).not.toBe(public_url);
    expect(
      (await requestUpload(tokenA, { ...MENU, purpose: "logo", content_type: "image/jpeg" }).expect(200)).body.data
        .public_url,
    ).toMatch(new RegExp(`/merchants/${idA}/logo/[0-9a-f-]{36}\\.jpg$`));
  });

  test("validasi tipe, ukuran, purpose", async () => {
    const svg = await requestUpload(tokenA, { ...MENU, content_type: "image/svg+xml" }).expect(400);
    expect(svg.body.error.fields.content_type).toEqual(["Format foto harus JPG, PNG, atau WebP."]);
    const besar = await requestUpload(tokenA, { ...MENU, size: 5242881 }).expect(400);
    expect(besar.body.error.fields.size).toEqual(["Ukuran foto maksimal 5 MB."]);
    expect((await requestUpload(tokenA, { ...MENU, size: 0 }).expect(400)).body.error.fields.size).toBeDefined();
    expect(
      (await requestUpload(tokenA, { ...MENU, purpose: "avatar" }).expect(400)).body.error.fields.purpose,
    ).toBeDefined();
    // F26: QRIS toko dihapus
    expect((await requestUpload(tokenA, { ...MENU, purpose: "qris" }).expect(400)).body.error.fields.purpose).toEqual([
      "Jenis foto tidak dikenal.",
    ]);
    await requestUpload(tokenA, { ...MENU, size: 5242880 }).expect(200);
  });

  test("peran: tanpa token 401, pembeli ke /merchant/uploads 403, pembeli ke /me/avatar 200", async () => {
    await requestUpload(null, MENU).expect(401);
    await requestUpload(null, { content_type: "image/png", size: 10 }, "/me/avatar").expect(401);
    await requestUpload(customerToken, MENU).expect(403);
    const res = await requestUpload(customerToken, { content_type: "image/png", size: 10 }, "/me/avatar").expect(200);
    const [[user]] = await db.query<any[]>("SELECT id FROM users WHERE email = 'budi@mail.com'");
    expect(res.body.data.public_url).toMatch(
      new RegExp(`^${TEST_R2_ENV.R2_PUBLIC_URL}/users/${user.id}/avatar/[0-9a-f-]{36}\\.png$`),
    );
  });

  test("batas 20 per pengguna per 10 menit → 429; pengguna lain tetap 200", async () => {
    for (let i = 0; i < 20; i++) await requestUpload(tokenA, MENU).expect(200);
    const res = await requestUpload(tokenA, MENU).expect(429);
    expect(res.body.error).toEqual({
      code: "RATE_LIMITED",
      message: "Terlalu banyak unggahan. Coba lagi beberapa menit lagi.",
    });
    await requestUpload(tokenA, { content_type: "image/png", size: 10 }, "/me/avatar").expect(429);
    await requestUpload(tokenB, MENU).expect(200);
  });
});
