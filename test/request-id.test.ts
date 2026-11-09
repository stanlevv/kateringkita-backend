import express from "express";
import request from "supertest";
import { describe, expect, test } from "vitest";
import { requestId } from "../src/middleware/requestLogger";

const app = express().use(requestId).get("/x", (_req, res) => { res.json({}); });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("X-Request-Id", () => {
  test("tanpa header -> UUID baru", async () => {
    expect((await request(app).get("/x")).headers["x-request-id"]).toMatch(UUID);
  });
  test("header aman dipakai ulang", async () => {
    expect((await request(app).get("/x").set("X-Request-Id", "sin1::abc-123")).headers["x-request-id"]).toBe("sin1::abc-123");
  });
  test("header berbahaya atau terlalu panjang diganti", async () => {
    for (const v of ["a b<script>", "x".repeat(129)]) {
      expect((await request(app).get("/x").set("X-Request-Id", v)).headers["x-request-id"]).toMatch(UUID);
    }
  });
});
