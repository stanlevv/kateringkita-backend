import { beforeAll, describe, expect, test } from "vitest";
import db from "../src/config/db";
import { siapkanToko } from "./helpers/toko";

// F06 Task 1 (BE-03, D17): orders.stock_date + tabel idempotensi per pengguna
describe("migrasi 003_checkout", () => {
  let budi: number;
  let siti: number;

  beforeAll(async () => {
    await siapkanToko();
    const [u] = await db.query<any[]>("SELECT id, full_name FROM users WHERE full_name IN ('Budi','Siti')");
    budi = u.find((r) => r.full_name === "Budi").id;
    siti = u.find((r) => r.full_name === "Siti").id;
  });

  test("orders.stock_date DATE NULL", async () => {
    const [rows] = await db.query<any[]>("SHOW COLUMNS FROM orders LIKE 'stock_date'");
    expect(rows[0]).toMatchObject({ Type: "date", Null: "YES" });
  });

  test("order_idempotency: kunci unik per (pengguna, kunci)", async () => {
    const sisip = (uid: number) =>
      db.query("INSERT INTO order_idempotency (customer_id, idem_key, request_hash) VALUES (?, 'k1', ?)", [uid, "a".repeat(64)]);
    await sisip(budi);
    await expect(sisip(budi)).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    await expect(sisip(siti)).resolves.toBeDefined();
  });

  test("schema_migrations memuat 003_checkout.sql", async () => {
    const [rows] = await db.query<any[]>("SELECT name FROM schema_migrations WHERE name = '003_checkout.sql'");
    expect(rows).toHaveLength(1);
  });
});
