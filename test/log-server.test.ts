import express from "express";
import request from "supertest";
import { beforeAll, describe, expect, test } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { errorHandler } from "../src/middleware/errorHandler";
import { catatLogServer, requestId } from "../src/middleware/requestLogger";
import { createAdmin } from "../src/scripts/create-admin";
import { bersihkanLog } from "../src/services/log-server.service";
import { AppError } from "../src/utils/errors";
import { login, siapkanToko } from "./helpers/toko";

// F23 log server: 5xx & request lambat tercatat (fire-and-forget), dashboard admin, pembersihan > 30 hari
let s: Awaited<ReturnType<typeof siapkanToko>>;
let tAdmin = "";
const uji = express()
  .use(requestId, catatLogServer)
  .get("/rusak", () => {
    throw new Error("kode pesanan bentrok");
  })
  .get("/upstream", () => {
    throw new AppError(502, "BAD_GATEWAY", "Penyedia tidak menjawab.");
  })
  .get("/lambat", async (_req, res) => {
    await new Promise((r) => setTimeout(r, 2100));
    res.json({ ok: true });
  })
  .get("/tidak-ada", () => {
    throw new AppError(404, "NOT_FOUND", "x");
  })
  .use(errorHandler);
// pencatatan berjalan setelah respons selesai → tunggu barisnya muncul
async function tungguLog(rid: string) {
  for (let i = 0; i < 50; i++) {
    const [[r]] = await db.query<any[]>("SELECT * FROM server_logs WHERE request_id = ?", [rid]);
    if (r) return r;
    await new Promise((x) => setTimeout(x, 100));
  }
  return null;
}

beforeAll(async () => {
  s = await siapkanToko();
  await createAdmin({ phone: "081300000009", fullName: "Admin Uji", password: "rahasia123" });
  tAdmin = await login("081300000009");
});

describe("pencatatan", () => {
  test("500 & 502 tercatat dengan request ID, path tanpa query, pesan; 404 tidak", async () => {
    await request(uji).get("/rusak?token=rahasia").set("X-Request-Id", "uji-500").expect(500);
    expect(await tungguLog("uji-500")).toMatchObject({ level: "error", method: "GET", path: "/rusak", status: 500, message: "kode pesanan bentrok" });
    await request(uji).get("/upstream").set("X-Request-Id", "uji-502").expect(502);
    expect(await tungguLog("uji-502")).toMatchObject({ level: "error", status: 502, message: "BAD_GATEWAY: Penyedia tidak menjawab." });
    await request(uji).get("/tidak-ada").set("X-Request-Id", "uji-404").expect(404);
    await new Promise((x) => setTimeout(x, 300));
    expect(await db.query<any[]>("SELECT id FROM server_logs WHERE request_id = 'uji-404'").then(([r]) => r)).toHaveLength(0);
  });

  test("request lebih dari 2 detik tercatat sebagai lambat", async () => {
    await request(uji).get("/lambat").set("X-Request-Id", "uji-lambat").expect(200);
    const r = await tungguLog("uji-lambat");
    expect(r).toMatchObject({ level: "slow", status: 200 });
    expect(r.duration_ms).toBeGreaterThanOrEqual(2000);
  });
});

describe("dashboard admin", () => {
  test("daftar + cari request ID/path + filter level; status server 24 jam; penjual 403", async () => {
    const cari = (qs: string) => request(app).get(`/api/v1/admin/server-logs?${qs}`).set("Authorization", `Bearer ${tAdmin}`).expect(200);
    expect((await cari("q=uji-500")).body.data.map((r: { request_id: string }) => r.request_id)).toEqual(["uji-500"]);
    expect((await cari("q=lamb")).body.data[0].request_id).toBe("uji-lambat");
    expect((await cari("level=slow")).body.data.every((r: { level: string }) => r.level === "slow")).toBe(true);
    await request(app).get("/api/v1/admin/server-logs?level=info").set("Authorization", `Bearer ${tAdmin}`).expect(400);
    const st = (await request(app).get("/api/v1/admin/server-status").set("Authorization", `Bearer ${tAdmin}`).expect(200)).body.data;
    expect(st.db.ok).toBe(true);
    expect(st.db.migrasi_terakhir).toMatch(/^\d{3}_.+\.sql$/);
    expect(st.per_jam).toHaveLength(24);
    expect(st.ringkas_24j.error).toBeGreaterThanOrEqual(2);
    expect(st.ringkas_24j.lambat).toBeGreaterThanOrEqual(1);
    await request(app).get("/api/v1/admin/server-status").set("Authorization", `Bearer ${s.tA}`).expect(403);
  });

  test("urut waktu terbaru dulu, bukan id (AUTO_INCREMENT TiDB tidak urut antar-node)", async () => {
    const sisip = (rid: string, menit: number) =>
      db.query("INSERT INTO server_logs (request_id, level, method, path, status, duration_ms, created_at) VALUES (?, 'slow', 'GET', '/urut-uji', 200, 2500, UTC_TIMESTAMP() - INTERVAL ? MINUTE)", [rid, menit]);
    await sisip("urut-baru", 5);
    await sisip("urut-lama", 180); // id lebih besar, waktu lebih tua
    const res = await request(app).get("/api/v1/admin/server-logs?q=/urut-uji").set("Authorization", `Bearer ${tAdmin}`).expect(200);
    expect(res.body.data.map((r: { request_id: string }) => r.request_id)).toEqual(["urut-baru", "urut-lama"]);
  });

  test("pembersihan menghapus log lebih dari 30 hari saja", async () => {
    await db.query("INSERT INTO server_logs (request_id, level, method, path, status, duration_ms, created_at) VALUES ('tua', 'error', 'GET', '/x', 500, 1, UTC_TIMESTAMP() - INTERVAL 31 DAY)");
    await bersihkanLog();
    expect((await db.query<any[]>("SELECT request_id FROM server_logs WHERE request_id IN ('tua', 'uji-500')"))[0]).toEqual([{ request_id: "uji-500" }]);
  });
});
