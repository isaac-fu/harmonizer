import { createApp } from './server.js';

const { app, dispose } = await createApp();
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
const server = app.listen(port, host, () => console.log(`Harmonizer API: http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { dispose(); server.close(() => process.exit(0)); });
}
