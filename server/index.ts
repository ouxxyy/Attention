import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRouter } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 8787;

app.use(express.json());
app.use(createRouter());

if (process.env.NODE_ENV === 'production') {
  const clientDist = path.resolve(__dirname, '../dist/client');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`服务器已启动: http://localhost:${PORT}`);
});
