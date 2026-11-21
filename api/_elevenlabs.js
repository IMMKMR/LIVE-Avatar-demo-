import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

export const DEFAULT_ELEVENLABS_VOICE_ID = 'hL2sW5Y3zbNy7yYtXwBo'; // Selected Godrej Agrovet Maya voice
export const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_v4'; // Most human, soft, natural Hindi & English speech

function getClient() {
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error('Missing ELEVENLABS_API_KEY in environment.');
  }
  return new ElevenLabsClient();
}

export async function listElevenLabsVoices() {
  const client = getClient();
  const res = await client.voices.getAll();
  const all = res?.voices || [];
  // Prefer premade & cloned/generated user voices so all plans work cleanly
  const usable = all.filter((v) => !v.category || v.category === 'premade' || v.category === 'cloned' || v.category === 'generated');
  const source = usable.length > 0 ? usable : all;
  return source.map((v) => ({
    id: v.voiceId || v.voice_id,
    name: v.name,
    category: v.category || 'premade',
    gender: v.labels?.gender || '',
    accent: v.labels?.accent || '',
  }));
}

export async function synthesizePcm24k({
  text,
  voiceId = DEFAULT_ELEVENLABS_VOICE_ID,
  modelId = DEFAULT_ELEVENLABS_MODEL_ID,
  language = 'hi',
}) {
  const cleanText = (text || '').trim();
  if (!cleanText) {
    throw new Error('Text is required for speech synthesis.');
  }

  const client = getClient();
  const safeVoiceId = voiceId || DEFAULT_ELEVENLABS_VOICE_ID;
  const safeModelId = modelId || DEFAULT_ELEVENLABS_MODEL_ID;

  const isV4 = safeModelId.startsWith('eleven_v4');
  const opts = {
    text: cleanText,
    modelId: safeModelId,
    outputFormat: 'pcm_24000',
    voiceSettings: isV4
      ? {
          stability: 0.48,       // Natural human warmth, breath, and soft conversational flow
          similarityBoost: 0.72, // Clean, authentic timbre without metallic sharpness
          speed: 0.86,           // Slow, calm, and clear delivery
        }
      : {
          stability: 0.48,
          similarityBoost: 0.70,
          style: 0.15,
          speed: 0.86,
          useSpeakerBoost: false,
        },
  };

  // Language enforcement supported on flash_v2_5 and eleven_v4
  if (safeModelId !== 'eleven_multilingual_v2') {
    opts.languageCode = language === 'hi' ? 'hi' : 'en';
  }

  const audioStream = await client.textToSpeech.convert(safeVoiceId, opts);

  const chunks = [];
  if (audioStream && typeof audioStream.getReader === 'function') {
    const reader = audioStream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
  } else if (audioStream && Symbol.asyncIterator in audioStream) {
    for await (const chunk of audioStream) {
      chunks.push(Buffer.from(chunk));
    }
  } else {
    throw new Error('Unexpected audio stream format from ElevenLabs SDK.');
  }

  const pcmBuffer = Buffer.concat(chunks);
  return {
    audio_base64: pcmBuffer.toString('base64'),
    format: 'pcm_24000',
    bytes: pcmBuffer.length,
    voice_id: safeVoiceId,
    model_id: safeModelId,
  };
}
