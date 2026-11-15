// Vercel entry point. All routes are rewritten to /api (see vercel.json) and handled by the same app as server.js.
import handler from '../server.js';
export default handler;
