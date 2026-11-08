import request from "supertest";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { createAdmin } from "../src/scripts/create-admin";
import { login, pembeliBaru, siapkanToko, sisipMenu } from "./helpers/toko";

// Broadcast pengumuman admin, notifikasi promo toko ke pemfavorit, dan kontak CS
let s: Awaited<ReturnType<typeof siapkanToko>>;
let tAdmin: string;
let tLain: string;
const H = (t: string) => ({ Authorization: `Bearer ${t}` });
const notif = async (token: string) => (await request(app).get("/api/v1/me/notifications").set(H(token)).expect(200)).body.data as { type: string; title: string; body: string }[];

beforeAll(async () => {
  s = await siapkanToko();
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  tAdmin = await login("081300000009");
  tLain = await pembeliBaru(1);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("pengumuman", () => {
  test("audience customer: hanya pembeli aktif; all: pembeli + penjual; tercatat audit", async () => {
    await db.query("UPDATE users SET is_active = FALSE WHERE email = 'pembeli1@mail.com'");
    const r = await request(app).post("/api/v1/admin/broadcasts").set(H(tAdmin)).send({ audience: "customer", title: " Libur ", body: "Kampus libur 17 Agustus." }).expect(201);
    expect(r.body.data).toEqual({ sent: 1 });
    expect((await notif(s.tCust))[0]).toMatchObject({ type: "info", title: "Libur", body: "Kampus libur 17 Agustus." });
    expect(await notif(s.tA)).toEqual([]);
    await db.query("UPDATE users SET is_active = TRUE WHERE email = 'pembeli1@mail.com'");
    expect((await request(app).post("/api/v1/admin/broadcasts").set(H(tAdmin)).send({ audience: "all", title: "Info", body: "Halo semua" }).expect(201)).body.data)
      .toEqual({ sent: 4 });
    const [[l]] = await db.query<any[]>("SELECT COUNT(*) AS n FROM admin_audit_logs WHERE action = 'notification.broadcast'");
    expect(Number(l.n)).toBe(2);
  });

  test("validasi & hanya admin", async () => {
    expect((await request(app).post("/api/v1/admin/broadcasts").set(H(tAdmin)).send({ audience: "semua", title: "", body: "x" }).expect(400)).body.error.fields)
      .toMatchObject({ audience: ["Pilih penerima pengumuman."], title: ["Judul wajib diisi."] });
    await request(app).post("/api/v1/admin/broadcasts").set(H(s.tA)).send({ audience: "all", title: "x", body: "y" }).expect(403);
  });
});

describe("notifikasi promo toko", () => {
  test("promo aktif → pembeli pemfavorit menu toko; nonaktif tidak; menyala lagi → dikirim", async () => {
    const menu = await sisipMenu(s.idA);
    await db.query("INSERT INTO favorites (user_id, menu_id) SELECT id, ? FROM users WHERE email = 'budi@mail.com'", [menu]);
    const isi = { type: "fixed", value: 1000, min_subtotal: 0, per_user_limit: 1, starts_at: "2020-01-01T00:00:00Z", ends_at: "2099-01-01T00:00:00Z" };
    const r = await request(app).post("/api/v1/merchant/promos").set(H(s.tA)).send({ ...isi, code: "HEMAT1K", description: "Potong Rp 1.000" }).expect(201);
    expect((await notif(s.tCust)).filter((n) => n.type === "promo")).toEqual([
      expect.objectContaining({ title: "Promo baru dari Dapur Siti", body: "Pakai kode HEMAT1K: Potong Rp 1.000" }),
    ]);
    expect((await notif(tLain)).filter((n) => n.type === "promo")).toEqual([]);
    const mati = await request(app).post("/api/v1/merchant/promos").set(H(s.tA)).send({ ...isi, code: "DIAM", is_active: false }).expect(201);
    expect((await notif(s.tCust)).filter((n) => n.type === "promo")).toHaveLength(1);
    await request(app).patch(`/api/v1/merchant/promos/${mati.body.data.id}`).set(H(s.tA)).send({ is_active: true }).expect(200);
    await request(app).patch(`/api/v1/merchant/promos/${r.body.data.id}`).set(H(s.tA)).send({ value: 1500 }).expect(200);
    expect((await notif(s.tCust)).filter((n) => n.type === "promo")).toHaveLength(2);
  });
});

describe("kontak CS", () => {
  test("admin mengatur; keluar di /meta/settings; kosongkan; validasi", async () => {
    expect((await request(app).put("/api/v1/admin/settings/cs-contact").set(H(tAdmin)).send({ wa_number: "085852157352" }).expect(200)).body.data)
      .toEqual({ cs_whatsapp: "085852157352" });
    expect((await request(app).get("/api/v1/meta/settings").expect(200)).body.data.cs_whatsapp).toBe("085852157352");
    expect((await request(app).get("/api/v1/admin/settings").set(H(tAdmin)).expect(200)).body.data).toMatchObject({ cs_whatsapp: "085852157352" });
    await request(app).put("/api/v1/admin/settings/cs-contact").set(H(tAdmin)).send({ wa_number: "12345" }).expect(400);
    expect((await request(app).put("/api/v1/admin/settings/cs-contact").set(H(tAdmin)).send({ wa_number: "" }).expect(200)).body.data).toEqual({ cs_whatsapp: null });
    const [[l]] = await db.query<any[]>("SELECT COUNT(*) AS n FROM admin_audit_logs WHERE action = 'settings.cs_whatsapp'");
    expect(Number(l.n)).toBe(2);
  });
});
