// Isi file: jenis galat (error) aplikasi. Service melempar AppError, lalu middleware/error-handler.ts mengubahnya
// menjadi respons JSON `{ error: { code, message, fields } }` dengan kode status HTTP yang sesuai.

/** Galat yang sengaja dilempar kode aplikasi, membawa kode status HTTP dan pesan yang aman ditampilkan ke pengguna. */
export class AppError extends Error {
  /**
   * @param status  kode status HTTP, contoh 400 data salah, 404 tidak ditemukan, 409 bentrok, 503 layanan mati
   * @param code    kode galat untuk aplikasi klien, contoh `"NOT_FOUND"`, `"VALIDATION_ERROR"`
   * @param message pesan untuk pengguna (bahasa Indonesia)
   * @param fields  pesan per kolom formulir, contoh `{ "items.0.qty": ["Sisa 3 porsi."] }`; boleh kosong
   */
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string[]>,
  ) {
    super(message);
  }
}
