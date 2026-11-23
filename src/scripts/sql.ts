import "dotenv/config"; // harus pertama: env.ts (lewat db.ts) membaca process.env saat diimpor
import db from "../config/db";

// Jalankan SQL ke DATABASE_URL di .env (bisa production!): npm run sql -- "SELECT 1" ["UPDATE ..."]
// Tiap pernyataan bisa memakai koneksi pool berbeda, jadi `USE db` tidak terbawa; pakai nama lengkap db.tabel.
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
