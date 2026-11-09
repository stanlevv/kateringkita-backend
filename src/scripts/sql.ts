import "dotenv/config"; // harus pertama: env.ts (lewat db.ts) membaca process.env saat diimpor
import db from "../config/db";

// Jalankan SQL ke DATABASE_URL di .env (bisa production!): npm run sql -- "SELECT 1" ["UPDATE ..."]
// Tiap pernyataan bisa memakai koneksi pool berbeda, jadi `USE db` tidak terbawa; pakai nama lengkap db.tabel.
async function jalankan(pernyataan: string[]): Promise<void> {
  if (!pernyataan.length) throw new Error('Pemakaian: npm run sql -- "SELECT ..." ["..."]');
  for (const sql of pernyataan) {
    const [hasil] = await db.query(sql);
    console.log(`> ${sql}`);
    if (Array.isArray(hasil)) console.table(hasil);
    else console.log(hasil);
  }
}

jalankan(process.argv.slice(2))
  .catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
