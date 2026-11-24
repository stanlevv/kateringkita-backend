// Isi file: titik mulai server. Membaca .env, membuka port, lalu menyalakan job kedaluwarsa pesanan dan
// pembersih log server. Aplikasinya sendiri (middleware dan router) disusun di app.ts.
import "dotenv/config";
import app from "./app";
import { env } from "./config/env";
import { startExpiryJob } from "./services/order-expiry.service";
import { startLogCleanupJob } from "./services/server-log.service";

// Express 5 memanggil callback dengan galat bila port gagal dibuka; jangan jalankan job tanpa server
app.listen(env.PORT, (err?: Error) => {
  if (err) throw err;
  console.log(`Server KateringKita running on port ${env.PORT}`);
  startExpiryJob();
  startLogCleanupJob();
});
