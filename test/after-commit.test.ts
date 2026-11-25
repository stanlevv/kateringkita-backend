import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import db from "../src/config/db";
import { afterCommit, withTransaction } from "../src/services/admin-audit.service";

// Kait afterCommit: tugas jalan setelah commit, dibuang saat rollback, galatnya tidak merembet.
beforeAll(async () => {
  await db.query("CREATE TABLE IF NOT EXISTS after_commit_probe (id INT PRIMARY KEY)");
  await db.query("DELETE FROM after_commit_probe");
});
afterAll(async () => {
  await db.query("DROP TABLE IF EXISTS after_commit_probe");
  await db.end();
});

describe("afterCommit", () => {
  test("tugas jalan setelah commit, bukan sebelum", async () => {
    let seen = -1;
    await withTransaction(async (conn) => {
      await conn.query("INSERT INTO after_commit_probe (id) VALUES (1)");
      afterCommit(conn, async () => {
        const [rows] = await db.query<any[]>("SELECT COUNT(*) AS n FROM after_commit_probe WHERE id = 1");
        seen = Number(rows[0].n);
      });
    });
    await vi.waitFor(() => expect(seen).toBe(1));
  });

  test("rollback → tugas tidak jalan", async () => {
    const task = vi.fn(async () => {});
    await expect(
      withTransaction(async (conn) => {
        afterCommit(conn, task);
        throw new Error("gagal");
      }),
    ).rejects.toThrow("gagal");
    expect(task).not.toHaveBeenCalled();
  });

  test("tugas melempar → hasil withTransaction tetap, galat hanya di log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await withTransaction(async (conn) => {
      afterCommit(conn, async () => {
        throw new Error("push gagal");
      });
      return "ok";
    });
    expect(result).toBe("ok");
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    spy.mockRestore();
  });

  test("conn di luar withTransaction → diabaikan", () => {
    const task = vi.fn(async () => {});
    expect(() => afterCommit(db, task)).not.toThrow();
    expect(task).not.toHaveBeenCalled();
  });
});
