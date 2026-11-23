import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config({ ignores: ["dist/"] }, js.configs.recommended, ...tseslint.configs.recommended, {
  rules: {
    // awalan _ menandai parameter/variabel sengaja tak dipakai (mis. _next pada error handler Express)
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    // pola `a, b` (sequence) dipakai di beberapa service; menulis ulang menyentuh kode logika
    "@typescript-eslint/no-unused-expressions": "warn",
    // regex pembersih karakter non-ASCII di rate-limiter sengaja memuat karakter kontrol NUL
    "no-control-regex": "warn",
    // migrate.ts memuat env secara lazy saat dijalankan langsung (require.main)
    "@typescript-eslint/no-require-imports": "warn",
    // mengganti any dengan tipe sebenarnya (terutama di test) butuh perubahan tipe, bukan format
    "@typescript-eslint/no-explicit-any": "warn",
    // menambah { cause } mengubah objek error yang dilempar
    "preserve-caught-error": "warn",
  },
});
