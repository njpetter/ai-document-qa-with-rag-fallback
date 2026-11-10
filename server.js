import app from './src/app.js';
import { env } from './src/config/env.js';

const server = app.listen(env.port, () => {
  console.log(`Amber Document Q&A API running on http://localhost:${env.port}`);
  if (!env.geminiApiKey) {
    console.log(
      '[Notice] GEMINI_API_KEY is not set. Running with local deterministic embedding & grounded extraction fallback. Set GEMINI_API_KEY in .env to use live Gemini API.'
    );
  }
});

export default server;

