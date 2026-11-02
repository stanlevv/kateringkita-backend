import { expect, test } from "vitest";
import db from "../src/config/db";

test("koneksi pool berzona waktu UTC; CURRENT_TIMESTAMP = UTC_TIMESTAMP()", async () => {
  const conns = await Promise.all([db.getConnection(), db.getConnection()]);
  try {
    for (const c of conns) {
      const [r] = await c.query<any[]>("SELECT @@session.time_zone AS tz, ABS(TIMESTAMPDIFF(SECOND, CURRENT_TIMESTAMP, UTC_TIMESTAMP())) AS d");
      expect(r[0].tz).toBe("+00:00");
      expect(Number(r[0].d)).toBeLessThanOrEqual(2);
    }
    await conns[0].query("CREATE TEMPORARY TABLE tz_t (id INT, at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    await conns[0].query("INSERT INTO tz_t (id) VALUES (1)");
    const [r] = await conns[0].query<any[]>("SELECT ABS(TIMESTAMPDIFF(SECOND, at, UTC_TIMESTAMP())) AS d FROM tz_t");
    expect(Number(r[0].d)).toBeLessThanOrEqual(3);
  } finally {
    conns.forEach((c) => c.release());
  }
});
