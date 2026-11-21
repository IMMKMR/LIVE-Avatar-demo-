import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'path';
import fs from 'fs';
import { listElevenLabsVoices, synthesizePcm24k } from './api/_elevenlabs.js';

const LIVEAVATAR_BASE = 'https://api.liveavatar.com/v1';
const OFFLINE_DIR = resolve(__dirname, 'public', 'offline');

function liveAvatarAndElevenLabsDevPlugin(env) {
  return {
    name: 'liveavatar-elevenlabs-dev-api',
    configureServer(server) {
      // Ensure server-side SDKs see keys loaded from .env.local without exposing them to browser
      if (env.ELEVENLABS_API_KEY && !process.env.ELEVENLABS_API_KEY) {
        process.env.ELEVENLABS_API_KEY = env.ELEVENLABS_API_KEY;
      }
      if (env.LIVEAVATAR_API_KEY && !process.env.LIVEAVATAR_API_KEY) {
        process.env.LIVEAVATAR_API_KEY = env.LIVEAVATAR_API_KEY;
      }

      // List available offline clips in public/offline/
      server.middlewares.use('/api/offline-clips', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        try {
          if (!fs.existsSync(OFFLINE_DIR)) {
            res.statusCode = 200;
            res.end(JSON.stringify({ clips: [] }));
            return;
          }
          const files = fs
            .readdirSync(OFFLINE_DIR)
            .filter((f) => /\.(webm|mp4)$/i.test(f))
            .map((f) => ({
              id: f.replace(/\.(webm|mp4)$/i, ''),
              file: f,
              url: `/offline/${f}`,
              bytes: fs.statSync(resolve(OFFLINE_DIR, f)).size,
            }));
          res.statusCode = 200;
          res.end(JSON.stringify({ clips: files }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      // Save recorded offline clip directly to public/offline/<name>.webm
      server.middlewares.use('/api/save-offline-clip', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        try {
          const urlObj = new URL(req.url, 'http://localhost');
          const rawName = (urlObj.searchParams.get('name') || '').replace(/[^a-zA-Z0-9_-]/g, '');
          if (!rawName) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Missing valid clip name' }));
            return;
          }
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const buf = Buffer.concat(chunks);
          fs.mkdirSync(OFFLINE_DIR, { recursive: true });
          const outPath = resolve(OFFLINE_DIR, `${rawName}.webm`);
          fs.writeFileSync(outPath, buf);
          res.statusCode = 200;
          res.end(JSON.stringify({ ok: true, id: rawName, url: `/offline/${rawName}.webm`, bytes: buf.length }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      server.middlewares.use('/api/elevenlabs-tts', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
          res.statusCode = 200;
          res.end();
          return;
        }

        try {
          if (req.method === 'GET') {
            const voices = await listElevenLabsVoices();
            res.statusCode = 200;
            res.end(JSON.stringify({ voices }));
            return;
          }

          if (req.method === 'POST') {
            let rawBody = '';
            for await (const chunk of req) rawBody += chunk;
            const body = JSON.parse(rawBody || '{}');
            const result = await synthesizePcm24k({
              text: body.text,
              voiceId: body.voice_id,
              modelId: body.model_id,
              language: body.language || 'en',
            });
            res.statusCode = 200;
            res.end(JSON.stringify(result));
            return;
          }

          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err?.message || 'ElevenLabs TTS error' }));
        }
      });

      server.middlewares.use('/api/liveavatar', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
          res.statusCode = 200;
          res.end();
          return;
        }

        const apiKey = process.env.LIVEAVATAR_API_KEY || env.LIVEAVATAR_API_KEY || '';
        if (!apiKey) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Missing LIVEAVATAR_API_KEY in .env.local' }));
          return;
        }

        try {
          if (req.method === 'GET') {
            const allAvatars = [];
            for (let page = 1; page <= 5; page++) {
              const aRes = await fetch(`${LIVEAVATAR_BASE}/avatars/public?page=${page}&page_size=100`, {
                headers: { 'X-API-KEY': apiKey, Accept: 'application/json' },
              });
              const aData = await aRes.json();
              if (Array.isArray(aData?.data?.results)) {
                allAvatars.push(...aData.data.results);
              }
              if (!aData?.data?.next) break;
            }
            const vRes = await fetch(`${LIVEAVATAR_BASE}/voices?page_size=100`, {
              headers: { 'X-API-KEY': apiKey, Accept: 'application/json' },
            });
            const vData = await vRes.json();
            res.statusCode = 200;
            res.end(
              JSON.stringify({
                avatars: allAvatars,
                voices: vData?.data?.results || [],
              })
            );
            return;
          }

          if (req.method === 'POST') {
            let rawBody = '';
            for await (const chunk of req) rawBody += chunk;
            const body = JSON.parse(rawBody || '{}');
            const sessionMode = body.mode === 'FULL' ? 'FULL' : 'CUSTOM';
            const payload =
              sessionMode === 'CUSTOM'
                ? {
                    mode: 'CUSTOM',
                    is_sandbox: Boolean(body.is_sandbox),
                    avatar_id: body.avatar_id || '3fb34e60-2665-4123-98f0-e2054ff243f1',
                  }
                : {
                    mode: 'FULL',
                    is_sandbox: Boolean(body.is_sandbox),
                    avatar_id: body.avatar_id || '3fb34e60-2665-4123-98f0-e2054ff243f1',
                    avatar_persona: {
                      language: body.language || 'en',
                      ...(body.voice_id ? { voice_id: body.voice_id } : {}),
                    },
                  };

            const tRes = await fetch(`${LIVEAVATAR_BASE}/sessions/token`, {
              method: 'POST',
              headers: {
                'X-API-KEY': apiKey,
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
              body: JSON.stringify(payload),
            });
            const tData = await tRes.json();
            res.statusCode = tRes.status;
            res.end(
              JSON.stringify(
                tRes.ok
                  ? {
                      mode: sessionMode,
                      session_id: tData?.data?.session_id || '',
                      session_token: tData?.data?.session_token || '',
                    }
                  : { error: tData.message || 'Failed to mint LiveAvatar session token', details: tData }
              )
            );
            return;
          }

          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: './',
    plugins: [liveAvatarAndElevenLabsDevPlugin(env)],
    server: {
      port: 5173,
    },
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          control: resolve(__dirname, 'control.html'),
          recorder: resolve(__dirname, 'record-offline.html'),
        },
      },
    },
  };
});
