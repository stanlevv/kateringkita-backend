import express from "express";
import request from "supertest";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { validate } from "../src/middleware/validate";
import { errorHandler } from "../src/middleware/errorHandler";

function makeApp(schema: z.ZodType) {
  const a = express();
  a.use(express.json());
  a.post("/x", validate(schema), (req, res) => {
    res.json({ data: req.body });
  });
  a.use(errorHandler);
  return a;
}

describe("validate()", () => {
  test("gagal → 400 VALIDATION_ERROR dengan fields per path", async () => {
    const app = makeApp(z.object({ name: z.string().min(3, "Minimal 3 karakter") }));
    const res = await request(app).post("/x").send({ name: "ab" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.fields.name).toEqual(["Minimal 3 karakter"]);
  });

  test("berhasil → req.body diganti hasil parse (trim)", async () => {
    const app = makeApp(z.object({ name: z.string().trim().min(3) }));
    const res = await request(app).post("/x").send({ name: "  abcd " });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ name: "abcd" });
  });
});
