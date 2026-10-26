import express, { Application } from 'express';
import cors from 'cors';
import authRoutes from './routes/authRoutes';
import menuRoutes from './routes/menuRoutes';

const app: Application = express();

app.use(cors());
app.use(express.json());

// Main API Routes
app.use('/api/auth', authRoutes);
app.use('/api/menus', menuRoutes);

export default app;