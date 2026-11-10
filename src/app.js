import express from 'express';
import cors from 'cors';
import qaRoutes from './routes/qa.routes.js';
import { errorMiddleware, notFoundMiddleware } from './middleware/error.middleware.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'amber-rag-qa-api' });
});

app.use('/api', qaRoutes);

app.use(notFoundMiddleware);
app.use(errorMiddleware);

export default app;

