import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import app from "../src/app";
import db from "../src/config/db";
import { hariIniWib } from "../src/services/merchant-kuota.service";
import { menuRow, pesanDulu, siapCheckout } from "./helpers/toko";

// F07 Task 4: POST /merchant/orders/:code/:aksi + balapan (M-04, M-08; D1, D4–D8)
let s: Awaited<ReturnType<typeof siapCheckout>>;

const aksi = (code: string, a: string, body?: unknown, token = s.tA) => {
  const r = request(app).post(`/api/v1/merchant/orders/${code}/${a}`).set("Authorization", `Bearer ${token}`);
  return body === undefined ? r : r.send(body as object);
};
const batal = (code: string) => request(app).post(`/api/v1/orders/${code}/cancel`).set("Authorization", `Bearer ${s.tCust}`);
const status = async (code: string) => ((await db.query<any[]>("SELECT status FROM orders WHERE code = ?", [code]))[0] as any[])[0].status;
const log = async (code: string) => ((await db.query<any[]>(
  "SELECT l.from_status, l.to_status FROM order_status_logs l JOIN orders o ON o.id = l.order_id WHERE o.code = ? ORDER BY l.id", [code],
))[0] as any[]).map((r) => `${r.from_status}→${r.to_status}`);
const stok = async () => {
  const m = await menuRow(s.menu);
  return { held: m.held_today, sold: m.sold_today };
};

beforeAll(async () => {
  s = await siapCheckout();
});
afterEach(async () => {
  await db.query("UPDATE orders SET status = 'expired' WHERE status = 'holding'");
  await db.query("UPDATE menus SET held_today = 0, sold_today = 0, sold_total = 0, stock_date = ?", [hariIniWib()]);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("alur & transisi", () => {
  test("confirm → cook → ready → complete: 200, *_at terisi, paid, 5 log, stok terjual", async () => {
    const code = await pesanDulu(s.tCust, s.menu, 2);
    for (const [a, st, kol] of [["confirm", "confirmed", "confirmed_at"], ["cook", "cooking", "cooking_at"],
      ["ready", "ready", "ready_at"], ["complete", "completed", "completed_at"]] as const) {
      const r = await aksi(code, a).expect(200);
      expect(r.body.data).toMatchObject({ code, status: st, customer_name: "Budi" });
      expect(r.body.data[kol]).not.toBeNull();
    }
    expect((await aksi(code, "cook").expect(409)).body.error.message).toBe("Pesanan sudah berubah status.");
    expect((await request(app).get(`/api/v1/merchant/orders/${code}`).set("Authorization", `Bearer ${s.tA}`)).body.data.payment_status)
      .toBe("paid");
    expect(await log(code)).toEqual(["null→holding", "holding→confirmed", "confirmed→cooking", "cooking→ready", "ready→completed"]);
    expect(await stok()).toEqual({ held: 0, sold: 2 });
  });

  test("cook dari holding → 409; confirm diulang → 409; aksi tak dikenal → 404", async () => {
    const code = await pesanDulu(s.tCust, s.menu);
    await aksi(code, "cook").expect(409);
    await aksi(code, "confirm").expect(200);
    expect((await aksi(code, "confirm").expect(409)).body.error).toMatchObject({ code: "CONFLICT", message: "Pesanan sudah berubah status." });
    await aksi(code, "cancel").expect(404);
    await aksi(code, "expire").expect(404);
  });
});

describe("body diabaikan selain reject (review)", () => {
  test("confirm dengan reason > 255 → 200", async () => {
    const code = await pesanDulu(s.tCust, s.menu);
    await aksi(code, "confirm", { reason: "a".repeat(256) }).expect(200);
  });
});

describe("reject (D8)", () => {
  test("tanpa alasan / spasi → 400, status tetap", async () => {
    const code = await pesanDulu(s.tCust, s.menu);
    for (const body of [undefined, {}, { reason: "  " }]) {
      const r = await aksi(code, "reject", body).expect(400);
      expect(r.body.error).toMatchObject({ code: "VALIDATION_ERROR", fields: { reason: ["Pilih alasan penolakan."] } });
    }
    expect((await aksi(code, "reject", { reason: "a".repeat(256) }).expect(400)).body.error.fields)
      .toEqual({ reason: ["Alasan maksimal 255 karakter."] });
    expect(await status(code)).toBe("holding");
  });

  test("dari holding → 200 cancelled_by merchant; dari confirmed → sold kembali; dari cooking → 409", async () => {
    const a = await pesanDulu(s.tCust, s.menu, 2);
    const r = await aksi(a, "reject", { reason: "Stok habis" }).expect(200);
    expect(r.body.data).toMatchObject({ status: "cancelled", cancelled_by: "merchant", cancel_reason: "Stok habis" });
    expect(r.body.data.cancelled_at).not.toBeNull();
    expect(await stok()).toEqual({ held: 0, sold: 0 });

    const b = await pesanDulu(s.tCust, s.menu, 2);
    await aksi(b, "confirm").expect(200);
    expect(await stok()).toEqual({ held: 0, sold: 2 });
    await aksi(b, "reject", { reason: "Tutup" }).expect(200);
    expect(await stok()).toEqual({ held: 0, sold: 0 });

    const c = await pesanDulu(s.tCust, s.menu);
    await db.query("UPDATE orders SET status = 'cooking' WHERE code = ?", [c]);
    await aksi(c, "reject", { reason: "Tutup" }).expect(409);
  });
});

describe("kepemilikan", () => {
  test("toko B → 404 semua aksi, status tetap; pembeli → 403", async () => {
    const code = await pesanDulu(s.tCust, s.menu);
    for (const a of ["confirm", "cook", "ready", "complete", "reject"]) {
      expect((await aksi(code, a, { reason: "x" }, s.tB).expect(404)).body.error.message).toBe("Pesanan tidak ditemukan.");
    }
    await aksi(code, "confirm", undefined, s.tCust).expect(403);
    expect(await status(code)).toBe("holding");
  });
});

describe("balapan (D5, D6)", () => {
  // Pesanan online lunas: tunai yang sudah dikonfirmasi masih boleh dibatalkan pembeli (D1), jadi pada tunai keduanya bisa 200
  // secara berurutan. Online lunas membuat kedua urutan saling meniadakan → tepat satu 200.
  test.each([1, 2, 3])("putaran %i: konfirmasi penjual vs batal pembeli → tepat satu 200", async () => {
    const code = await pesanDulu(s.tCust, s.menu, 2);
    await db.query("UPDATE orders SET payment_method = 'qris', payment_status = 'paid' WHERE code = ?", [code]);
    const [c, b] = await Promise.all([aksi(code, "confirm"), batal(code)]);
    expect([c.status, b.status].sort()).toEqual([200, 409]);
    expect(await stok()).toEqual(c.status === 200 ? { held: 0, sold: 2 } : { held: 0, sold: 0 });
    expect(await log(code)).toHaveLength(2);
  });

  test.each([1, 2, 3])("putaran %i: tiga konfirmasi paralel → satu 200, stok sekali", async () => {
    const code = await pesanDulu(s.tCust, s.menu, 2);
    const r = await Promise.all([aksi(code, "confirm"), aksi(code, "confirm"), aksi(code, "confirm")]);
    expect(r.map((x) => x.status).sort()).toEqual([200, 409, 409]);
    expect(await stok()).toEqual({ held: 0, sold: 2 });
    expect(await log(code)).toHaveLength(2);
  });
});
