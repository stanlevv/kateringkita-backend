# 🍱 KateringKita - Backend REST API

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg?logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg?logo=node.js)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5.2-lightgrey.svg?logo=express)](https://expressjs.com/)
[![MySQL2](https://img.shields.io/badge/MySQL2-Pool-orange.svg?logo=mysql)](https://github.com/sidorares/node-mysql2)
[![TiDB Cloud](https://img.shields.io/badge/TiDB%20Cloud-Serverless-brightgreen.svg?logo=pingcap)](https://tidbcloud.com/)
[![Heroku](https://img.shields.io/badge/Deploy-Heroku-purple.svg?logo=heroku)](https://ketring-45f82aef1ca0.herokuapp.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Backend RESTful API performa tinggi untuk platform manajemen katering **KateringKita**, dibangun dengan arsitektur berlapis **MVC (Model-View-Controller)** menggunakan TypeScript, Express.js 5, dan koneksi database relasional MySQL/TiDB Cloud.

[🌐 Live Backend API](https://ketring-45f82aef1ca0.herokuapp.com/) • [📱 Live Frontend Web](https://ketringkita.edufin.app/) • [⚡ Alternative Vercel](https://ketringkita-frontend.vercel.app/)

</div>

---

## 📌 Ringkasan Proyek

Backend **KateringKita** menangani seluruh logika bisnis, otentikasi berbasis JWT, otorisasi peran (Role-Based Access Control / RBAC), serta manajemen data transaksi dan katalog menu merchant secara real-time.

### ✨ Fitur Unggulan
- **Dual Database Environment Resilience:** Berjalan mulus di database lokal (Laragon/XAMPP) maupun Cloud Database (TiDB Cloud Serverless) dengan penanganan TLSv1.2 SSL otomatis.
- **RESTful Menu CRUD Engine (Lab 10):** Manajemen katalog menu makanan/minuman dengan penanganan status stok, estimasi waktu penyajian, HPP, dan harga jual.
- **Secure Authentication & RBAC (Lab 9):** Registrasi dan login aman dengan enkripsi password standar industri **Bcrypt** serta token otentikasi **JSON Web Token (JWT)**.
- **Enterprise-Ready Deployment:** Terkonfigurasi untuk deployment instan ke platform PaaS seperti Heroku via `Procfile` dan engine declaration Node.js `>=20.0.0`.

---

## 🏗️ Arsitektur Sistem (Layered MVC)

```text
HTTP Request
     │
     ▼
[ src/server.ts ] ──► Bootstrap & Port Listener
     │
     ▼
[  src/app.ts   ] ──► Express 5 Engine & CORS Middleware
     │
     ├──► [ /api/auth ]  ──► authRoutes ──► authController ──► userModel & merchantModel
     │                                                               │
     └──► [ /api/menus ] ──► menuRoutes ──► menuController ──► menuModel
                                                                     │
                                                                     ▼
                                                          [ src/config/db.ts ]
                                                          (MySQL2 Connection Pool)
                                                                     │
                                             ┌───────────────────────┴───────────────────────┐
                                             ▼                                               ▼
                                  [ Local MySQL (Port 3306) ]                     [ TiDB Cloud (TLSv1.2 SSL) ]
```

---

## 🗄️ Skema Database & Relasi Tabel

Skema database lengkap tersedia pada file [`src/config/schema.sql`](src/config/schema.sql).

```text
+----------------+          +----------------+
|     roles      |          | merchant_types |
+----------------+          +----------------+
| role_id (PK)   |          | type_id (PK)   |
| nama_role      |          | nama_jenis     |
+-------+--------+          +-------+--------+
        │ 1                         │ 1
        │ N                         │ N
+-------v--------+          +-------v--------+
|     users      | 1      1 |   merchants    |
+----------------+----------+----------------+
| user_id (PK)   |<─────────| merchant_id(PK)|
| role_id (FK)   |          | user_id (FK/UQ)|
| nama_lengkap   |          | type_id (FK)   |
| email          |          | nama_usaha     |
| no_whatsapp    |          | alamat_usaha   |
| password (hash)|          +----------------+
+-------+--------+
        │ 1
        │ N
+-------v--------+
|     menus      | (CRUD Lab Pertemuan 10)
+----------------+
| id (PK)        |
| user_id (FK)   |
| name           |
| cat (ENUM)     | -> 'Nasi Box', 'Snack', 'Minuman', 'Paket Custom'
| desc           |
| img            |
| hpp            |
| price          |
| stock          |
| hold           |
| sold           |
| est            |
| is_active      |
+----------------+
```

---

## 📡 Dokumentasi Endpoint REST API

### 1. Autentikasi (`/api/auth`)
| Method | Endpoint | Deskripsi | Auth Required |
| :--- | :--- | :--- | :---: |
| `POST` | `/api/auth/register` | Mendaftarkan akun merchant baru beserta detail usaha | ❌ |
| `POST` | `/api/auth/login` | Login menggunakan email / no WhatsApp & password | ❌ |
| `GET` | `/api/auth/profile` | Mengambil detail profil user yang sedang login | ✅ Bearer |

### 2. Manajemen Menu (`/api/menus`)
| Method | Endpoint | Deskripsi | Status Code |
| :--- | :--- | :--- | :---: |
| `GET` | `/api/menus` | Mengambil seluruh daftar menu aktif | `200 OK` |
| `GET` | `/api/menus/:id` | Mengambil detail menu berdasarkan ID | `200 OK` / `404 Not Found` |
| `POST` | `/api/menus` | Menambahkan item menu baru | `201 Created` / `400 Bad Request` |
| `PUT` | `/api/menus/:id` | Memperbarui seluruh data / stok menu | `200 OK` / `404 Not Found` |
| `DELETE` | `/api/menus/:id` | Menghapus item menu dari database | `200 OK` / `404 Not Found` |

#### Contoh Payload `POST /api/menus`:
```json
{
  "name": "Nasi Ayam Bakar Madu Komplit",
  "cat": "Nasi Box",
  "desc": "Nasi pulen, paha ayam bakar madu, sambal terasi & lalapan fresh",
  "img": "/menu/1.png",
  "hpp": 12000,
  "price": 18000,
  "stock": 25,
  "est": "15 Mnt"
}
```

---

## 🚀 Panduan Memulai (Quick Start)

### 1. Prasyarat Sistem
- **Node.js** `>= 20.0.0`
- **npm** `>= 10.0.0`
- **MySQL Database** (Laragon / XAMPP / Docker / TiDB Cloud)

### 2. Instalasi
Clone repositori dan install dependensi:
```bash
git clone https://github.com/stanlevv/kateringkita-backend.git
cd kateringkita-backend
npm install
```

### 3. Konfigurasi Environment Variable
Salin file template `.env.example` ke `.env`:
```bash
cp .env.example .env
```
Sesuaikan konfigurasi koneksi database Anda pada file `.env`.

### 4. Eksekusi Skema Database
Import file `src/config/schema.sql` ke database MySQL Anda:
```bash
mysql -u root -p kateringkita_db < src/config/schema.sql
```

### 5. Menjalankan Server
```bash
# Mode Pengembangan (Watch Mode via TSX)
npm run dev

# Kompilasi Production (TypeScript -> JS)
npm run build

# Menjalankan Bundle Production
npm start
```
Server akan aktif pada: `http://localhost:5000`

---

## 🌐 Kredensial & Lingkungan Deployment

- **Live Base URL:** `https://ketring-45f82aef1ca0.herokuapp.com/`
- **Koneksi TiDB Cloud:** Terenkripsi dengan sertifikat root CA publik dan protokol TLSv1.2.
- **Deployment Process:** Terotomasi via Heroku Git dengan buildpack `heroku/nodejs`.

---

## 👥 Tim Pengembang

Platform **KateringKita** dikembangkan dengan dedikasi untuk digitalisasi ekosistem katering lokal.

---

## 📄 Lisensi

Proyek ini dilisensikan di bawah [MIT License](LICENSE).
