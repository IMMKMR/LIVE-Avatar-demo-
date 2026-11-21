import { LiveAvatarSession, SessionEvent, AgentEventsEnum } from '@heygen/liveavatar-web-sdk';
import { QUICK_TOPICS, SYSTEM_SCRIPTS } from './knowledge.js';

const AVATAR_ID = '3fb34e60-2665-4123-98f0-e2054ff243f1'; // Maya (Serious)
const ELEVENLABS_VOICE_ID = 'hL2sW5Y3zbNy7yYtXwBo';
const ELEVENLABS_MODEL_ID = 'eleven_v4';
const IDLE_DURATION_MS = 15000; // 15 full seconds for natural, seamless neutral idle loop

const CLIPS = [
  { id: 'idle', label: 'Neutral Idle Loop (15s)', type: 'idle', text: '15-second calm neutral pose with natural blinking & breathing' },
  { id: 'welcome', label: 'Intro / Welcome Greeting', type: 'speak', text: SYSTEM_SCRIPTS.hi.welcome },
  ...QUICK_TOPICS.map((t) => ({
    id: t.id,
    label: `${t.title} (${t.ref})`,
    type: 'speak',
    text: t.answer.hi,
  })),
  { id: 'closing', label: 'Closing Sign-off', type: 'speak', text: SYSTEM_SCRIPTS.hi.closing },
  {
    id: 'fallback',
    label: 'General Inquiry Fallback',
    type: 'speak',
    text: 'मैंने आपका सवाल नोट कर लिया है। इसके बारे में पूरी जानकारी के लिए आप हमारा इंट्रानेट पोर्टल देख सकते हैं, या फिर पीपल ऑपरेशंस टीम को एक छोटा सा मैसेज भेज दीजिए, वो आज ही मदद कर देंगे।',
  },
];

const videoEl = document.getElementById('rec-video');
const recBadge = document.getElementById('rec-badge');
const btnRecordRemaining = document.getElementById('btn-record-remaining');
const btnRecordAll = document.getElementById('btn-record-all');
const btnAbort = document.getElementById('btn-abort');
const clipListEl = document.getElementById('clip-list');
const recLogEl = document.getElementById('rec-log');

let session = null;
let aborted = false;
let latestExistingMap = new Map();
let speakStartResolver = null;
let speakEndResolver = null;

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.textContent = `[${ts}] ${msg}`;
  recLogEl.prepend(div);
}

function setClipStatus(id, state, label) {
  const el = document.getElementById(`status-${id}`);
  if (!el) return;
  el.className = `clip-status ${state}`;
  el.textContent = label;
}

function renderClipList(existingMap = new Map()) {
  clipListEl.innerHTML = CLIPS.map((c) => {
    const info = existingMap.get(c.id);
    const savedLabel = info ? `SAVED (${(info.bytes / (1024 * 1024)).toFixed(1)} MB)` : 'PENDING';
    return `
      <div class="clip-row">
        <div style="flex:1;min-width:0;">
          <div class="clip-name">${c.label} <code>${c.id}.webm</code></div>
          <div class="clip-text">${c.text}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          ${info ? `<a href="/offline/${c.id}.webm?t=${Date.now()}" target="_blank" class="btn btn-slate" style="padding:4px 9px;font-size:11px;">Preview</a>` : ''}
          <span class="clip-status ${info ? 'saved' : ''}" id="status-${c.id}">${savedLabel}</span>
        </div>
      </div>
    `;
  }).join('');
}

async function checkExistingClips() {
  try {
    const res = await fetch('/api/offline-clips');
    const data = await res.json();
    latestExistingMap = new Map((data.clips || []).map((c) => [c.id, c]));
    renderClipList(latestExistingMap);
    const remaining = CLIPS.filter((c) => (latestExistingMap.get(c.id)?.bytes || 0) < 2 * 1024 * 1024);
    if (btnRecordRemaining) {
      btnRecordRemaining.textContent =
        remaining.length > 0
          ? `Record Remaining ${remaining.length} Clip${remaining.length === 1 ? '' : 's'} Only`
          : 'All 10 Clips Ready!';
    }
    if (latestExistingMap.size > 0) {
      log(`Found ${latestExistingMap.size}/${CLIPS.length} files (${CLIPS.length - remaining.length} full HD, ${remaining.length} remaining).`);
    }
  } catch (_) {
    renderClipList();
  }
}

function getRecordStream() {
  const tracks = [];
  if (session?._remoteVideoTrack?.mediaStreamTrack) {
    tracks.push(session._remoteVideoTrack.mediaStreamTrack);
  }
  if (session?._remoteAudioTrack?.mediaStreamTrack) {
    tracks.push(session._remoteAudioTrack.mediaStreamTrack);
  }
  if (tracks.length > 0) {
    return new MediaStream(tracks);
  }
  if (videoEl?.captureStream) {
    return videoEl.captureStream(30);
  }
  return videoEl?.srcObject;
}

function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

function startRecorder() {
  const stream = getRecordStream();
  if (!stream) throw new Error('No live video stream available to record.');
  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(
    stream,
    mimeType
      ? { mimeType, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 192_000 }
      : { videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 192_000 }
  );
  const chunks = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
  });
  recorder.start(250);
  return {
    stop: () => {
      if (recorder.state !== 'inactive') recorder.stop();
      return stopped;
    },
  };
}

async function saveClipBlob(id, blob) {
  const res = await fetch(`/api/save-offline-clip?name=${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'video/webm' },
    body: blob,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Failed to save ${id}.webm`);
  return data;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForSpeakStart(timeoutMs = 8000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      speakStartResolver = null;
      resolve(false);
    }, timeoutMs);
    speakStartResolver = () => {
      clearTimeout(t);
      speakStartResolver = null;
      resolve(true);
    };
  });
}

function waitForSpeakEnd(timeoutMs = 60000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      speakEndResolver = null;
      resolve(false);
    }, timeoutMs);
    speakEndResolver = () => {
      clearTimeout(t);
      speakEndResolver = null;
      resolve(true);
    };
  });
}

async function stopSession() {
  if (session) {
    try {
      await session.stop();
    } catch (_) {}
    session = null;
  }
  if (videoEl) videoEl.srcObject = null;
  recBadge.className = 'rec-badge';
  recBadge.textContent = 'SESSION STOPPED';
}

async function recordClips(clipsToRecord = CLIPS) {
  if (!clipsToRecord.length) {
    log('All clips are already recorded in full HD!');
    return;
  }
  aborted = false;
  if (btnRecordRemaining) btnRecordRemaining.disabled = true;
  btnRecordAll.disabled = true;
  btnAbort.disabled = false;
  recBadge.className = 'rec-badge';
  recBadge.textContent = 'CONNECTING MAYA...';
  log(`Starting LiveAvatar CUSTOM session for ${clipsToRecord.length} clip(s)...`);

  try {
    const tokRes = await fetch('/api/liveavatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'CUSTOM',
        avatar_id: AVATAR_ID,
        is_sandbox: false,
      }),
    });
    const tokData = await tokRes.json();
    if (!tokRes.ok || !tokData.session_token) {
      throw new Error(tokData.error || 'Failed to get LiveAvatar token');
    }

    session = new LiveAvatarSession(tokData.session_token, {
      autoKeepAlive: true,
      voiceChat: { defaultMuted: true },
    });

    const streamReady = new Promise((resolve) => {
      session.on(SessionEvent.SESSION_STREAM_READY, () => {
        session.attach(videoEl);
        videoEl.muted = false;
        videoEl.play().catch(() => {
          videoEl.muted = true;
          videoEl.play().catch(() => {});
        });
        resolve();
      });
    });

    session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
      if (speakStartResolver) speakStartResolver();
    });

    session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
      if (speakEndResolver) speakEndResolver();
    });

    session.on(SessionEvent.SESSION_DISCONNECTED, (reason) => {
      log(`LiveAvatar session disconnected (${reason || 'timeout/limit'}).`);
      aborted = true;
      if (speakEndResolver) speakEndResolver();
    });

    await session.start();
    await streamReady;
    log('Maya stream ready! Waiting 3s for video bitrate to sharpen to full 1080p...');
    await wait(3000);

    for (const clip of clipsToRecord) {
      if (aborted) break;
      setClipStatus(clip.id, 'active', 'RECORDING...');
      recBadge.className = 'rec-badge recording';
      recBadge.textContent = `REC • ${clip.id.toUpperCase()}`;

      if (clip.type === 'idle') {
        log(`Recording ${IDLE_DURATION_MS / 1000}s high-quality neutral idle loop...`);
        const rec = startRecorder();
        await wait(IDLE_DURATION_MS);
        const blob = await rec.stop();
        const saved = await saveClipBlob(clip.id, blob);
        setClipStatus(clip.id, 'saved', `SAVED (${(saved.bytes / (1024 * 1024)).toFixed(1)} MB)`);
        log(`Saved public/offline/${clip.id}.webm (${(saved.bytes / (1024 * 1024)).toFixed(1)} MB)`);
        await wait(1000);
      } else {
        log(`Synthesizing ElevenLabs v4 Hindi audio for "${clip.id}"...`);
        const ttsRes = await fetch('/api/elevenlabs-tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: clip.text,
            voice_id: ELEVENLABS_VOICE_ID,
            model_id: ELEVENLABS_MODEL_ID,
            language: 'hi',
          }),
        });
        const ttsData = await ttsRes.json();
        if (!ttsRes.ok || !ttsData.audio_base64) {
          throw new Error(ttsData.error || `TTS failed for ${clip.id}`);
        }

        // Exact audio duration from 24kHz 16-bit mono PCM (48,000 bytes/sec)
        const exactAudioMs = Math.ceil((ttsData.bytes / 48000) * 1000);
        const minRecordMs = exactAudioMs + 1800; // Full audio + 1.8s WebRTC/settle buffer
        log(`Audio length for "${clip.id}": ${(exactAudioMs / 1000).toFixed(1)}s → recording at least ${(minRecordMs / 1000).toFixed(1)}s...`);

        const startPromise = waitForSpeakStart(6000);
        const endPromise = waitForSpeakEnd(minRecordMs + 15000);

        const rec = startRecorder();
        await wait(250);
        session.repeatAudio(ttsData.audio_base64);

        await startPromise;
        // Wait for BOTH the exact PCM duration + buffer AND the avatar speak_ended event
        await Promise.all([wait(minRecordMs), endPromise]);
        await wait(500);

        const blob = await rec.stop();
        const saved = await saveClipBlob(clip.id, blob);
        setClipStatus(clip.id, 'saved', `SAVED (${(saved.bytes / (1024 * 1024)).toFixed(1)} MB)`);
        log(`Saved public/offline/${clip.id}.webm (${(saved.bytes / (1024 * 1024)).toFixed(1)} MB)`);
        await wait(1200); // Clean pause between clips so Maya returns to neutral
      }
    }

    log(aborted ? 'Recording aborted by user.' : 'ALL 10 CLIPS SAVED IN FULL! Closing LiveAvatar session now.');
    await checkExistingClips();
  } catch (err) {
    log(`ERROR: ${err.message}`);
  } finally {
    await stopSession();
    if (btnRecordRemaining) btnRecordRemaining.disabled = false;
    btnRecordAll.disabled = false;
    btnAbort.disabled = true;
  }
}

btnRecordRemaining?.addEventListener('click', () => {
  const remaining = CLIPS.filter((c) => (latestExistingMap.get(c.id)?.bytes || 0) < 2 * 1024 * 1024);
  recordClips(remaining);
});
btnRecordAll?.addEventListener('click', () => recordClips(CLIPS));
btnAbort?.addEventListener('click', async () => {
  aborted = true;
  log('Aborting and closing session...');
  await stopSession();
});

window.addEventListener('pagehide', () => {
  if (session) {
    try {
      session.stop();
    } catch (_) {}
  }
});

checkExistingClips();
