// ═══════════════════════════════════════════════════════════════
// Forked AI — entry point.
//   • node server.js            → local / Railway / Render / Docker (listens on PORT)
//   • Vercel                    → api/index.js imports the default export (no listener)
// ═══════════════════════════════════════════════════════════════
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { config } from './src/config.js';
import { buildApp, VERSION } from './src/app.js';

const { deps, handler } = buildApp(config);
export default handler;

process.on('unhandledRejection', (e) => console.error('[forked-ai] unhandledRejection', e));
process.on('uncaughtException', (e) => console.error('[forked-ai] uncaughtException', e));

void deps.registry.ensureDiscovered(0); // warm model discovery without blocking start-up

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain && !config.isVercel) {
  const server = http.createServer(handler);
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.listen(config.port, () => {
    console.log(`Forked AI API v${VERSION} on http://localhost:${config.port}  (auth: ${config.auth.mode}, providers: ${config.providers.map((p) => `${p.id}×${p.keys.length}`).join(', ') || 'NONE'})`);
    if (!config.providers.length) console.warn('No AI provider keys configured — add GROQ_API_KEYS / DEEPSEEK_API_KEYS / … to .env');
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
