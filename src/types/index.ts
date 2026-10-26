import { RowDataPacket } from "mysql2";

export interface User {
  user_id?: number;
  role_id: number;
  nama_lengkap: string;
  email?: string | null;
  no_whatsapp: string;
  password?: string;
  nama_role?: string;
  nama_usaha?: string;
}

export interface UserRow extends User, RowDataPacket {}

export interface Merchant {
  merchant_id?: number;
  user_id: number;
  type_id: number;
  nama_usaha: string;
  alamat_usaha: string;
}

export interface MerchantType {
  type_id: number;
  nama_jenis: string;
}

export interface MerchantTypeRow extends MerchantType, RowDataPacket {}

export interface MenuItem {
  menu_id?: number;
  id?: number;
  user_id?: number;
  name: string;
  cat: string;
  desc?: string;
  img?: string;
  hpp: number;
  price: number;
  stock: number;
  est: string;
  hold?: number;
  sold?: number;
  is_active?: boolean;
}

export interface MenuItemRow extends MenuItem, RowDataPacket {}

