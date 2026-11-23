import { LiveAvatarSession, SessionEvent, AgentEventsEnum } from '@heygen/liveavatar-web-sdk';
import { QUICK_TOPICS, SYSTEM_SCRIPTS, matchKnowledge } from './knowledge.js';

const CHANNEL_NAME = 'gavl_live_avatar';
const DEFAULT_NEUTRAL_AVATAR_ID = '3fb34e60-2665-4123-98f0-e2054ff243f1'; // Maya (Serious) — neutral corporate presenter
const DEFAULT_LIVEAVATAR_VOICE_ID = '8d7ca40c-5ee6-45f3-8b4a-e2b01df302a1'; // Maya LiveAvatar fallback voice
const DEFAULT_ELEVENLABS_VOICE_ID = 'hL2sW5Y3zbNy7yYtXwBo'; // Selected Godrej Agrovet Maya voice
const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_v4';
const LIVE_IDLE_TIMEOUT_MS = 15000; // Auto-close Live Model 15s after speaking to save credits

const urlParams = new URLSearchParams(window.location.search);
const forcedMode = urlParams.get('mode'); // 'offline' | 'live' | null

const ch = new BroadcastChannel(CHANNEL_NAME);

let session = null;
let liveConnectPromise = null;
let liveIdleTimer = null;
let isOfflineMode = false; // True when offline clips are available (default 0-credit base)
let isLiveModelActive = false; // True ONLY while on-demand Live Model is connected/connecting
let offlineClipMap = new Map(); // clipId -> url
let sessionMode = 'CUSTOM'; // CUSTOM (ElevenLabs 24kHz PCM) | FULL (LiveAvatar built-in voice)
let currentLang = 'hi';
let elevenLabsVoiceId = DEFAULT_ELEVENLABS_VOICE_ID;
let elevenLabsModelId = DEFAULT_ELEVENLABS_MODEL_ID;
let avatarStatus = 'connecting'; // offline | connecting | idle | speaking | error
let currentModeLabel = 'CONNECTING';
let currentAvatarName = 'Maya';
const captionsEnabled = false;

// DOM references
const idleVideoEl = document.getElementById('avatar-idle-video');
const videoEl = document.getElementById('avatar-video');
const liveVideoEl = document.getElementById('avatar-live-video');
const placeholderEl = document.getElementById('avatar-placeholder');
const statusPillEl = document.getElementById('stage-status-pill');
const statusTextEl = document.getElementById('stage-status-text');
const waveEl = document.getElementById('speaking-wave');
const captionEl = document.getElementById('stage-caption');
const lowerThirdNameEl = document.getElementById('lower-third-name');
const btnUnmuteOverlay = document.getElementById('btn-unmute-overlay');

let pendingGreeting = null; // { clipId, text }

const topicsGridEl = document.getElementById('topics-grid');
const transcriptFeedEl = document.getElementById('transcript-feed');
const employeeFormEl = document.getElementById('employee-form');
const employeeInputEl = document.getElementById('employee-input');
const btnLiveSend = document.getElementById('btn-live-send');

function getLang() {
  return currentLang || 'hi';
}

function broadcastState(extra = {}) {
  ch.postMessage({
    type: 'PORTAL_STATE',
    avatarStatus,
    modeLabel: currentModeLabel,
    avatarName: currentAvatarName,
    sessionMode: isLiveModelActive ? `LIVE (${sessionMode})` : 'OFFLINE',
    ...extra,
  });
}

function updateUI() {
  const isConnected = isOfflineMode || avatarStatus === 'idle' || avatarStatus === 'speaking';

  if (statusPillEl && statusTextEl) {
    statusPillEl.dataset.state = avatarStatus;
    const prefix = isLiveModelActive ? 'LIVE MODEL' : 'OFFLINE';
    const labels = {
      offline: 'OFFLINE',
      connecting: isLiveModelActive ? 'LIVE MODEL • CONNECTING...' : 'LOADING...',
      idle: `${prefix} • ${currentModeLabel || 'NEUTRAL'}`,
      speaking: `${prefix} • ${currentModeLabel || 'SPEAKING'}`,
      error: 'CONNECTION ERROR',
    };
    statusTextEl.textContent = labels[avatarStatus] || labels.offline;
  }

  if (waveEl) {
    waveEl.style.opacity = avatarStatus === 'speaking' ? '1' : '0';
  }

  if (placeholderEl) {
    placeholderEl.style.display = isConnected ? 'none' : 'flex';
  }
}

function setCaption(text = '') {
  if (!captionEl) return;
  if (!text || !captionsEnabled) {
    captionEl.classList.remove('visible');
    return;
  }
  captionEl.textContent = text;
  captionEl.classList.add('visible');
}

function appendMessage(role, text, meta = {}) {
  if (!transcriptFeedEl || !text) return;
  const row = document.createElement('div');
  row.className = `msg-row ${role}`;

  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const metaEl = document.createElement('div');
  metaEl.className = 'msg-meta';

  if (role === 'employee') {
    metaEl.innerHTML = `<span>You</span><span>•</span><span>${ts}</span>`;
  } else {
    const refBadge = meta.ref ? `<span class="policy-pill">${meta.ref}</span>` : '';
    metaEl.innerHTML = `<span>Maya</span>${refBadge}<span>•</span><span>${ts}</span>`;
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;

  row.appendChild(metaEl);
  row.appendChild(bubble);
  transcriptFeedEl.appendChild(row);
  transcriptFeedEl.scrollTop = transcriptFeedEl.scrollHeight;
}

function clearLiveIdleTimer() {
  if (liveIdleTimer) {
    clearTimeout(liveIdleTimer);
    liveIdleTimer = null;
  }
}

function scheduleLiveAutoDisconnect() {
  clearLiveIdleTimer();
  if (!isOfflineMode || !session) return;
  liveIdleTimer = setTimeout(() => {
    stopLiveModel(false);
  }, LIVE_IDLE_TIMEOUT_MS);
}

function renderQuickTopics() {
  if (!topicsGridEl) return;
  topicsGridEl.innerHTML = QUICK_TOPICS.map(
    (t) => `
      <button type="button" class="topic-btn" data-topic-id="${t.id}">
        <div class="topic-meta">
          <span>${t.category}</span>
          <span class="topic-ref">${t.ref}</span>
        </div>
        <div class="topic-title">${t.title}</div>
      </button>
    `
  ).join('');

  topicsGridEl.querySelectorAll('.topic-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      unlockAudio(false);
      topicsGridEl.querySelectorAll('.topic-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const topic = QUICK_TOPICS.find((t) => t.id === btn.dataset.topicId);
      if (!topic) return;

      // Always return to 0-credit Offline Mode when clicking pre-recorded topic buttons
      if (isOfflineMode && (session || isLiveModelActive)) {
        await stopLiveModel(true);
      }

      const lang = getLang();
      pendingGreeting = null;
      updateUnmuteOverlay(false);
      appendMessage('employee', topic.question[lang]);
      appendMessage('assistant', topic.answer[lang], { ref: `${topic.ref} • OFFLINE` });

      if (isOfflineMode) {
        await playOfflineClip(topic.id, topic.answer[lang], topic.category.toUpperCase(), false);
      } else {
        await speakOnLiveModel(topic.answer[lang], topic.category.toUpperCase());
      }
    });
  });
}

function updateUnmuteOverlay(forceShow = false) {
  if (!btnUnmuteOverlay) return;
  const isConnected = isOfflineMode || avatarStatus === 'idle' || avatarStatus === 'speaking';
  const show = isConnected && (forceShow || Boolean(pendingGreeting));
  btnUnmuteOverlay.style.display = show ? 'inline-flex' : 'none';
}

async function unlockAudio(triggerPendingGreeting = false) {
  for (const el of [videoEl, liveVideoEl]) {
    if (!el) continue;
    el.muted = false;
    el.volume = 1.0;
  }
  try {
    if (session?.room?.startAudio) {
      await session.room.startAudio();
    }
  } catch (_) {}

  if (triggerPendingGreeting && pendingGreeting) {
    const g = pendingGreeting;
    pendingGreeting = null;
    updateUnmuteOverlay(false);
    appendMessage('assistant', g.text, { ref: 'GAVL-AI • OFFLINE' });
    if (isOfflineMode && !isLiveModelActive) {
      playOfflineClip(g.clipId, g.text, 'GREETING', false);
    } else {
      speakOnLiveModel(g.text, 'GREETING');
    }
    return;
  }

  updateUnmuteOverlay(false);
}

// ---------- OFFLINE MODE (ZERO CREDITS) ----------
async function detectOfflineClips() {
  const map = new Map();
  const baseUrl = import.meta.env.BASE_URL || './';
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  // Local dev server API check (prefers .mp4 over .webm)
  try {
    const res = await fetch('/api/offline-clips');
    if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
      const data = await res.json();
      const sorted = (data.clips || []).sort((a, b) => (a.file.endsWith('.mp4') ? 1 : -1));
      for (const c of sorted) {
        map.set(c.id, `${normalizedBase}offline/${c.file}`);
      }
      if (map.size > 0) return map;
    }
  } catch (_) {}

  // Static / GitHub Pages check
  const knownIds = ['idle', 'welcome', 'leave', 'onboarding', 'it', 'payroll', 'hybrid', 'benefits', 'closing', 'fallback'];
  await Promise.all(
    knownIds.map(async (id) => {
      for (const ext of ['mp4', 'webm']) {
        const url = `${normalizedBase}offline/${id}.${ext}`;
        try {
          const r = await fetch(url, { method: 'HEAD' });
          if (r.ok) {
            map.set(id, url);
            break;
          }
        } catch (_) {}
      }
    })
  );
  return map;
}

async function startOfflineMode() {
  isOfflineMode = true;
  isLiveModelActive = false;
  avatarStatus = 'idle';
  currentModeLabel = 'NEUTRAL';

  if (idleVideoEl && offlineClipMap.has('idle')) {
    idleVideoEl.src = offlineClipMap.get('idle');
    idleVideoEl.style.display = 'block';
    idleVideoEl.muted = true;
    idleVideoEl.loop = true;
    idleVideoEl.play().catch(() => {});
  }

  if (videoEl) {
    videoEl.style.opacity = '0';
    videoEl.ontimeupdate = () => {
      if (
        isOfflineMode &&
        !isLiveModelActive &&
        avatarStatus === 'speaking' &&
        videoEl.duration &&
        Number.isFinite(videoEl.duration) &&
        videoEl.duration - videoEl.currentTime <= 0.45
      ) {
        videoEl.style.opacity = '0';
      }
    };
    videoEl.onended = () => {
      videoEl.style.opacity = '0';
      if (!isLiveModelActive) {
        avatarStatus = 'idle';
        currentModeLabel = 'NEUTRAL';
        updateUI();
        broadcastState({ log: 'Offline clip finished → neutral idle loop.' });
      }
    };
  }

  updateUI();
  broadcastState({ log: `Offline Mode active (${offlineClipMap.size} clips, 0 credits). Live Model on-demand for chat.` });

  const welcomeText = SYSTEM_SCRIPTS[getLang()].welcome;
  if (offlineClipMap.has('welcome')) {
    const played = await playOfflineClip('welcome', welcomeText, 'GREETING', true);
    if (played) {
      appendMessage('assistant', welcomeText, { ref: 'GAVL-AI • OFFLINE' });
    } else {
      pendingGreeting = { clipId: 'welcome', text: welcomeText };
      updateUnmuteOverlay(true);
    }
  }
}

async function playOfflineClip(clipId, captionText, modeLabel = 'RESPONDING', isAutoGreeting = false) {
  const url = offlineClipMap.get(clipId) || offlineClipMap.get('fallback');
  currentModeLabel = modeLabel;
  setCaption(captionText);

  if (!url || !videoEl) {
    avatarStatus = 'idle';
    updateUI();
    return false;
  }

  videoEl.pause();
  videoEl.src = url;
  videoEl.currentTime = 0;
  videoEl.muted = false;
  videoEl.volume = 1.0;

  try {
    await videoEl.play();
    videoEl.style.opacity = '1';
    avatarStatus = 'speaking';
    updateUI();
    updateUnmuteOverlay(false);
    broadcastState({ log: `[OFFLINE • ${clipId}] Playing pre-recorded clip (0 credits).` });
    return true;
  } catch (_) {
    if (isAutoGreeting) {
      videoEl.style.opacity = '0';
      setCaption('');
      avatarStatus = 'idle';
      updateUI();
      return false;
    }
    return false;
  }
}

// ---------- ON-DEMAND LIVE MODEL (USES CREDITS ONLY FOR LIVE NAMES / CUSTOM CHAT) ----------
async function ensureLiveModelConnected(config = {}) {
  if (session && isLiveModelActive) {
    clearLiveIdleTimer();
    return session;
  }
  if (liveConnectPromise) {
    return liveConnectPromise;
  }

  liveConnectPromise = (async () => {
    clearLiveIdleTimer();
    if (videoEl) {
      videoEl.pause();
      videoEl.style.opacity = '0';
    }

    const avatar_id = config.avatar_id || DEFAULT_NEUTRAL_AVATAR_ID;
    const voice_id = config.voice_id !== undefined ? config.voice_id : DEFAULT_LIVEAVATAR_VOICE_ID;
    const language = config.language || getLang();
    const is_sandbox = config.is_sandbox !== undefined ? Boolean(config.is_sandbox) : false;
    const avatar_name = config.avatar_name || 'Maya';

    currentLang = language;
    sessionMode = config.audio_engine === 'liveavatar' ? 'FULL' : 'CUSTOM';
    elevenLabsVoiceId = config.elevenlabs_voice_id || DEFAULT_ELEVENLABS_VOICE_ID;
    elevenLabsModelId = config.elevenlabs_model_id || DEFAULT_ELEVENLABS_MODEL_ID;
    if (lowerThirdNameEl) lowerThirdNameEl.textContent = avatar_name.toUpperCase();

    isLiveModelActive = true;
    avatarStatus = 'connecting';
    currentModeLabel = 'CONNECTING';
    currentAvatarName = avatar_name;
    updateUI();
    broadcastState({ log: `Connecting Live Model on-demand (${avatar_name}, mode=${sessionMode})...` });

    const res = await fetch('/api/liveavatar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: sessionMode,
        avatar_id,
        voice_id,
        language,
        is_sandbox,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.session_token) {
      const detailMsg = Array.isArray(data.details?.data)
        ? data.details.data.map((d) => d.message).join('; ')
        : '';
      throw new Error(detailMsg || data.error || 'Failed to start Live Model session');
    }

    const s = new LiveAvatarSession(data.session_token, {
      autoKeepAlive: false,
      voiceChat: { defaultMuted: true },
    });

    const streamReady = new Promise((resolve) => {
      s.on(SessionEvent.SESSION_STREAM_READY, async () => {
        if (liveVideoEl && s) {
          s.attach(liveVideoEl);
          liveVideoEl.muted = false;
          liveVideoEl.volume = 1.0;
          try {
            await liveVideoEl.play();
          } catch (_) {
            liveVideoEl.muted = true;
            await liveVideoEl.play().catch(() => {});
          }
          liveVideoEl.style.opacity = '1';
        }
        avatarStatus = 'idle';
        currentModeLabel = 'READY';
        updateUI();
        broadcastState({ log: 'Live Model stream ready!' });
        resolve();
      });
    });

    s.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
      clearLiveIdleTimer();
      avatarStatus = 'speaking';
      updateUI();
      broadcastState();
    });

    s.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
      avatarStatus = 'idle';
      currentModeLabel = 'READY';
      updateUI();
      broadcastState({ log: 'Live Model finished speaking — auto-returning to Offline in 15s.' });
      scheduleLiveAutoDisconnect();
    });

    s.on(SessionEvent.SESSION_DISCONNECTED, (reason) => {
      clearLiveIdleTimer();
      session = null;
      isLiveModelActive = false;
      if (liveVideoEl) {
        liveVideoEl.style.opacity = '0';
        liveVideoEl.srcObject = null;
      }
      avatarStatus = isOfflineMode ? 'idle' : 'offline';
      currentModeLabel = isOfflineMode ? 'NEUTRAL' : 'OFFLINE';
      updateUI();
      broadcastState({ log: `Live Model disconnected (${reason || 'closed'}) → Offline Mode.` });
    });

    session = s;
    await s.start();
    await streamReady;
    return s;
  })();

  try {
    return await liveConnectPromise;
  } catch (err) {
    isLiveModelActive = false;
    session = null;
    if (liveVideoEl) {
      liveVideoEl.style.opacity = '0';
      liveVideoEl.srcObject = null;
    }
    avatarStatus = isOfflineMode ? 'idle' : 'error';
    currentModeLabel = isOfflineMode ? 'NEUTRAL' : 'ERROR';
    updateUI();
    throw err;
  } finally {
    liveConnectPromise = null;
  }
}

async function stopLiveModel(silent = false) {
  clearLiveIdleTimer();
  if (session) {
    const s = session;
    session = null;
    try {
      await s.stop();
    } catch (_) {}
  }
  isLiveModelActive = false;
  if (liveVideoEl) {
    liveVideoEl.style.opacity = '0';
    liveVideoEl.srcObject = null;
  }
  avatarStatus = isOfflineMode ? 'idle' : 'offline';
  currentModeLabel = isOfflineMode ? 'NEUTRAL' : 'OFFLINE';
  updateUI();
  if (!silent) {
    broadcastState({ log: 'Live Model stopped → back to 0-credit Offline Mode.' });
  }
}

async function speakOnLiveModel(text, modeLabel = 'LIVE REPLY') {
  const clean = (text || '').trim();
  if (!clean) return;
  clearLiveIdleTimer();
  currentModeLabel = modeLabel;

  const s = await ensureLiveModelConnected();
  if (!s) return;

  if (sessionMode === 'CUSTOM') {
    avatarStatus = 'speaking';
    updateUI();
    const ttsRes = await fetch('/api/elevenlabs-tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: clean,
        voice_id: elevenLabsVoiceId,
        model_id: elevenLabsModelId,
        language: getLang(),
      }),
    });
    const ttsData = await ttsRes.json();
    if (!ttsRes.ok || !ttsData.audio_base64) {
      throw new Error(ttsData.error || 'ElevenLabs synthesis failed');
    }
    if (!session) return;
    session.repeatAudio(ttsData.audio_base64);
    broadcastState({ log: `[LIVE MODEL • ${modeLabel}] "${clean.slice(0, 85)}"` });
  } else {
    session.repeat(clean);
    avatarStatus = 'speaking';
    updateUI();
    broadcastState({ log: `[LIVE MODEL • ${modeLabel}] "${clean.slice(0, 85)}"` });
  }
}

async function generatePersonalizedReply(userText) {
  try {
    const res = await fetch('/api/gemini-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userText, lang: getLang() }),
    });
    if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
      const data = await res.json();
      if (data.reply) return data.reply;
    }
  } catch (_) {}
  return matchKnowledge(userText, getLang()).text;
}

async function handleLiveChatSubmit(rawText) {
  const cleanQ = (rawText || '').trim();
  if (!cleanQ) return;

  pendingGreeting = null;
  updateUnmuteOverlay(false);
  topicsGridEl?.querySelectorAll('.topic-btn').forEach((b) => b.classList.remove('active'));
  appendMessage('employee', cleanQ);

  if (btnLiveSend) {
    btnLiveSend.disabled = true;
    btnLiveSend.textContent = 'Live...';
  }

  try {
    // Generate personalized Hindi response (with exact live name!) + connect Live Model in parallel
    const [replyText] = await Promise.all([
      generatePersonalizedReply(cleanQ),
      ensureLiveModelConnected(),
    ]);

    appendMessage('assistant', replyText, { ref: 'LIVE MODEL' });
    await speakOnLiveModel(replyText, 'LIVE NAME');
  } catch (err) {
    console.error('Live chat error:', err);
    appendMessage('assistant', `Live model unavailable (${err.message}). Playing offline response.`, { ref: 'OFFLINE' });
    if (isOfflineMode) {
      const fallback = matchKnowledge(cleanQ, getLang());
      await playOfflineClip('fallback', fallback.text, 'OFFLINE', false);
    }
  } finally {
    if (btnLiveSend) {
      btnLiveSend.disabled = false;
      btnLiveSend.textContent = 'Send Live';
    }
  }
}

employeeFormEl?.addEventListener('submit', (e) => {
  e.preventDefault();
  unlockAudio(false);
  const val = employeeInputEl.value.trim();
  if (!val) return;
  employeeInputEl.value = '';
  handleLiveChatSubmit(val);
});

btnUnmuteOverlay?.addEventListener('click', (e) => {
  e.stopPropagation();
  unlockAudio(true);
});

document.addEventListener('click', () => unlockAudio(false));
document.addEventListener('keydown', () => unlockAudio(false));

// Immediately close any active Live Model session on tab close/refresh so credits never leak
window.addEventListener('pagehide', () => {
  if (session) {
    try {
      session.stop();
    } catch (_) {}
  }
});

// Listen for remote commands from control.html
ch.onmessage = (ev) => {
  const msg = ev.data || {};
  switch (msg.type) {
    case 'PORTAL_START':
      ensureLiveModelConnected(msg.payload || {}).catch(() => {});
      break;
    case 'PORTAL_STOP':
      stopLiveModel(false);
      break;
    case 'PORTAL_SPEAK':
      if (msg.employeePrompt) appendMessage('employee', msg.employeePrompt);
      appendMessage('assistant', msg.text, { ref: msg.ref || 'LIVE MODEL' });
      speakOnLiveModel(msg.text, msg.modeLabel || 'LIVE CUE').catch(() => {});
      break;
    case 'PORTAL_IDLE':
    case 'PORTAL_INTERRUPT':
      if (session) {
        try {
          session.interrupt();
        } catch (_) {}
      }
      if (isOfflineMode && !isLiveModelActive && videoEl) {
        videoEl.pause();
        videoEl.style.opacity = '0';
      }
      avatarStatus = 'idle';
      currentModeLabel = 'NEUTRAL';
      updateUI();
      break;
    case 'PORTAL_PING':
      broadcastState();
      break;
  }
};

// Boot: Offline Mode by default (0 credits); Live Model activates ONLY when user sends a live chat message
async function boot() {
  renderQuickTopics();
  updateUI();

  offlineClipMap = await detectOfflineClips();
  const hasOfflineClips = offlineClipMap.has('idle') && offlineClipMap.size >= 2;

  if (forcedMode === 'live' || !hasOfflineClips) {
    try {
      await ensureLiveModelConnected();
      const welcomeText = SYSTEM_SCRIPTS[getLang()].welcome;
      appendMessage('assistant', welcomeText, { ref: 'LIVE MODEL' });
      await speakOnLiveModel(welcomeText, 'GREETING');
    } catch (err) {
      appendMessage('assistant', `Live connection error: ${err.message}`, { ref: 'SYSTEM' });
    }
  } else {
    await startOfflineMode();
  }
}

boot();
