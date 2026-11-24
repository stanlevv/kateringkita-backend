import { expect, test } from "vitest";
import db from "../src/config/db";

test("koneksi pool berzona waktu UTC; CURRENT_TIMESTAMP = UTC_TIMESTAMP()", async () => {
  const conns = await Promise.all([db.getConnection(), db.getConnection()]);
  try {
    for (const connection of conns) {
      const [result] = await connection.query<any[]>(
        "SELECT @@session.time_zone AS tz, ABS(TIMESTAMPDIFF(SECOND, CURRENT_TIMESTAMP, UTC_TIMESTAMP())) AS d",
      );
      expect(result[0].tz).toBe("+00:00");
      expect(Number(result[0].d)).toBeLessThanOrEqual(2);
    }
    await conns[0].query("CREATE TEMPORARY TABLE tz_t (id INT, at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    await conns[0].query("INSERT INTO tz_t (id) VALUES (1)");
    const [rows] = await conns[0].query<any[]>("SELECT ABS(TIMESTAMPDIFF(SECOND, at, UTC_TIMESTAMP())) AS d FROM tz_t");
    expect(Number(rows[0].d)).toBeLessThanOrEqual(3);
  } finally {
    conns.forEach((conn) => conn.release());
  }
});
