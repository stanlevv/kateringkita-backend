import { expect, test } from "vitest";
import db from "../src/config/db";
import { hariIniWib, segarkanKuota } from "../src/services/merchant-kuota.service";
import { menuRow, siapkanToko, sisipMenu } from "./helpers/toko";

test("hariIniWib: tanggal di zona Asia/Jakarta (UTC+7)", () => {
  expect(hariIniWib(new Date("2026-10-31T17:30:00Z"))).toBe("2026-11-01");
  expect(hariIniWib(new Date("2026-10-31T16:59:59Z"))).toBe("2026-10-31");
});

test("tengah malam: permintaan yang masih membawa tanggal kemarin tidak me-reset mundur", async () => {
  const { idA } = await siapkanToko();
  const id = await sisipMenu(idA, { stock_date: "2026-11-02", daily_quota: 20, quota_today: 10, sold_today: 5, held_today: 2 });
  await segarkanKuota(db, idA, "2026-11-01");
  const [[r]] = await db.query<any[]>("SELECT DATE_FORMAT(stock_date, '%Y-%m-%d') AS s FROM menus WHERE id = ?", [id]);
  expect(r.s).toBe("2026-11-02");
  expect(await menuRow(id)).toMatchObject({ quota_today: 10, sold_today: 5, held_today: 2 });
  await segarkanKuota(db, idA, "2026-11-03"); // maju tetap me-reset
  expect(await menuRow(id)).toMatchObject({ quota_today: 20, sold_today: 0, held_today: 0 });
});
