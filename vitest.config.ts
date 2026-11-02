import "dotenv/config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // test DB berbagi satu database uji; jalankan berurutan agar reset tidak saling tabrak
    fileParallelism: false,
    // reset DB (DROP/CREATE + migrasi) bisa >10 dtk saat suite panjang; bawaan 5/10 dtk membuat gagal acak
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "mysql://root:root@127.0.0.1:3306/kateringkita_test",
      JWT_SECRET: "test-secret-yang-panjangnya-minimal-32-karakter",
      CORS_ORIGIN: "http://localhost:3000",
    },
  },
});
