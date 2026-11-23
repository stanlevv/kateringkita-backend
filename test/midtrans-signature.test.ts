import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { env } from "../src/config/env";
import { isValidNotification } from "../src/utils/midtrans";

// Sejak 28 Okt 2026 Midtrans menandatangani notifikasi dengan Signature Secret Key, terpisah dari Server Key
const tanda = (key: string) => {
  const n = { order_id: "KK-UJI-1", status_code: "200", gross_amount: "30000.00" };
  return {
    ...n,
    signature_key: createHash("sha512").update(`${n.order_id}${n.status_code}${n.gross_amount}${key}`).digest("hex"),
  };
};

describe("isValidNotification", () => {
  afterEach(() => {
    env.MIDTRANS_SERVER_KEY = undefined;
    env.MIDTRANS_SIGNATURE_KEY = undefined;
  });

  test("Signature Secret Key diisi → dipakai; signature dari Server Key ditolak", () => {
    env.MIDTRANS_SERVER_KEY = "SB-Mid-server-baru";
    env.MIDTRANS_SIGNATURE_KEY = "rahasia-tanda-tangan";
    expect(isValidNotification(tanda("rahasia-tanda-tangan"))).toBe(true);
    expect(isValidNotification(tanda("SB-Mid-server-baru"))).toBe(false);
  });

  test("tanpa Signature Secret Key → pakai Server Key (akun lama)", () => {
    env.MIDTRANS_SERVER_KEY = "SB-Mid-server-lama";
    expect(isValidNotification(tanda("SB-Mid-server-lama"))).toBe(true);
    expect(isValidNotification(tanda("lain"))).toBe(false);
  });

  test("tanpa kunci sama sekali → ditolak", () => {
    expect(isValidNotification(tanda(""))).toBe(false);
  });
});
