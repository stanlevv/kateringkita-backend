// Isi file: skrip bantu untuk menjalankan perintah SQL ke DATABASE_URL di .env (bisa production, hati-hati!):
// `npm run sql -- "SELECT 1" ["UPDATE ..."]`. Hasil SELECT dicetak sebagai tabel.
import "dotenv/config"; // harus pertama: env.ts (lewat db.ts) membaca process.env saat diimpor
import db from "../config/db";

// Menjalankan setiap perintah berurutan. Tiap perintah bisa memakai sambungan pool yang berbeda, jadi `USE nama_db`
// tidak terbawa ke perintah berikutnya; tulis nama lengkap `db.tabel`.
async function runStatements(statements: string[]): Promise<void> {
  if (!statements.length) throw new Error('Pemakaian: npm run sql -- "SELECT ..." ["..."]');
  for (const sql of statements) {
    const [result] = await db.query(sql);
    console.log(`> ${sql}`);
    if (Array.isArray(result)) console.table(result);
    else console.log(result);
  }
}

runStatements(process.argv.slice(2))
  .catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
