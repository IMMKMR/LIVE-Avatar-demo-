import { listElevenLabsVoices, synthesizePcm24k } from './_elevenlabs.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const voices = await listElevenLabsVoices();
      return res.status(200).json({ voices });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const result = await synthesizePcm24k({
        text: body.text,
        voiceId: body.voice_id,
        modelId: body.model_id,
        language: body.language || 'en',
      });
      return res.status(200).json(result);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'ElevenLabs TTS error' });
  }
}
