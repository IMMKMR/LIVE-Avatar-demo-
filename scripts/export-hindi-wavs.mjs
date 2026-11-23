import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { QUICK_TOPICS, SYSTEM_SCRIPTS } from '../src/knowledge.js';
import { synthesizePcm24k } from '../api/_elevenlabs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'colab_assets', 'audio');
fs.mkdirSync(OUT_DIR, { recursive: true });

function pcmToWavBuffer(pcmBuf, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuf.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20);  // AudioFormat = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuf.length, 40);
  return Buffer.concat([header, pcmBuf]);
}

const ITEMS = [
  { id: 'welcome', text: SYSTEM_SCRIPTS.hi.welcome },
  ...QUICK_TOPICS.map((t) => ({ id: t.id, text: t.answer.hi })),
  { id: 'closing', text: SYSTEM_SCRIPTS.hi.closing },
  {
    id: 'fallback',
    text: 'मैंने आपका सवाल नोट कर लिया है। इसके बारे में पूरी जानकारी के लिए आप हमारा इंट्रानेट पोर्टल देख सकते हैं, या फिर पीपल ऑपरेशंस टीम को एक छोटा सा मैसेज भेज दीजिए, वो आज ही मदद कर देंगे।',
  },
];

async function main() {
  // 1. Write 10-second silent idle.wav (24kHz, 16-bit mono = 480,000 bytes)
  const silentPcm = Buffer.alloc(24000 * 2 * 10, 0);
  fs.writeFileSync(path.join(OUT_DIR, 'idle.wav'), pcmToWavBuffer(silentPcm));
  console.log('Saved idle.wav (10.0s silence)');

  // 2. Synthesize all 9 Hindi ElevenLabs v4 clips
  for (const item of ITEMS) {
    process.stdout.write(`Synthesizing ${item.id}.wav ... `);
    const res = await synthesizePcm24k({
      text: item.text,
      voiceId: 'hL2sW5Y3zbNy7yYtXwBo',
      modelId: 'eleven_v4',
      language: 'hi',
    });
    const pcmBuf = Buffer.from(res.audio_base64, 'base64');
    const wavBuf = pcmToWavBuffer(pcmBuf, 24000, 1, 16);
    fs.writeFileSync(path.join(OUT_DIR, `${item.id}.wav`), wavBuf);
    const secs = (pcmBuf.length / 48000).toFixed(1);
    console.log(`OK (${secs}s, ${(wavBuf.length / 1024).toFixed(0)} KB)`);
  }
  console.log(`\nAll 10 WAV files saved to: ${OUT_DIR}`);
}

main().catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});
