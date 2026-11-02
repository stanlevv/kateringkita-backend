import express from "express";
import request from "supertest";
import { describe, expect, test, vi } from "vitest";
import { AppError } from "../src/http/errors";
import { errorHandler, notFoundHandler } from "../src/http/errorHandler";
import app from "../src/app";

function makeApp() {
  const a = express();
  a.use(express.json());
  a.get("/conflict", () => {
    throw new AppError(409, "CONFLICT", "Email sudah terdaftar.", { email: ["Sudah dipakai."] });
  });
  a.get("/boom", async () => {
    throw new Error("ER_NO_SUCH_TABLE: Table 'kk.menus' doesn't exist");
  });
  a.get("/dup", () => {
    throw Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" });
  });
  a.get("/sql", () => {
    throw Object.assign(new Error("Check constraint 'menus_chk_2' is violated."), {
      code: "ER_CHECK_CONSTRAINT_VIOLATED", errno: 3819, sql: "INSERT INTO orders (customer_phone) VALUES ('081234567890')",
    });
  });
  a.post("/echo", (req, res) => {
    res.json({ data: req.body });
  });
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
}

describe("error terpusat", () => {
  test("AppError memakai status & bentuk {error}", async () => {
    const res = await request(makeApp()).get("/conflict");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: { code: "CONFLICT", message: "Email sudah terdaftar.", fields: { email: ["Sudah dipakai."] } },
    });
  });

  test("ER_DUP_ENTRY → 409 CONFLICT", async () => {
    const res = await request(makeApp()).get("/dup");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(JSON.stringify(res.body)).not.toContain("Duplicate entry");
  });

  test("error tak terduga → 500 tanpa detail teknis", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(makeApp()).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(res.body)).not.toContain("ER_NO_SUCH_TABLE");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("galat mysql2 dicatat tanpa SQL (berisi data pembeli), hanya kode + pesan", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await request(makeApp()).get("/sql").expect(500);
    const args = spy.mock.calls.flat();
    expect(args.some((x) => typeof x === "object" && x !== null)).toBe(false);
    const log = args.join(" ");
    expect(log).toContain("ER_CHECK_CONSTRAINT_VIOLATED");
    expect(log).not.toContain("081234567890");
    spy.mockRestore();
  });

  test("JSON rusak → 400 VALIDATION_ERROR", async () => {
    const res = await request(makeApp()).post("/echo").set("Content-Type", "application/json").send("{rusak");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("body terlalu besar → 413, bukan 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(makeApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ a: "x".repeat(200_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("route tak dikenal di app → 404 NOT_FOUND", async () => {
    const res = await request(app).get("/api/v1/tidak-ada");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
