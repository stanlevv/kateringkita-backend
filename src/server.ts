import "dotenv/config";
import app from "./app";
import { env } from "./config/env";
import { mulaiJobKadaluarsa } from "./pesanan/kadaluarsa";

// Express 5 memanggil callback dengan galat bila port gagal dibuka; jangan jalankan job tanpa server
app.listen(env.PORT, (err?: Error) => {
  if (err) throw err;
  console.log(`Server KateringKita running on port ${env.PORT}`);
  mulaiJobKadaluarsa();
});
