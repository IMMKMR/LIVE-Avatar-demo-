import { LiveAvatarSession, SessionEvent, AgentEventsEnum } from '@heygen/liveavatar-web-sdk';
import { QUICK_TOPICS, SYSTEM_SCRIPTS, matchKnowledge } from './knowledge.js';

const CHANNEL_NAME = 'gavl_live_avatar';
const DEFAULT_NEUTRAL_AVATAR_ID = '3fb34e60-2665-4123-98f0-e2054ff243f1'; // Maya (Serious) — neutral corporate presenter
const DEFAULT_LIVEAVATAR_VOICE_ID = '8d7ca40c-5ee6-45f3-8b4a-e2b01df302a1'; // Maya LiveAvatar fallback voice
const DEFAULT_ELEVENLABS_VOICE_ID = 'hL2sW5Y3zbNy7yYtXwBo'; // Selected Godrej Agrovet Maya voice
const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_v4';

const urlParams = new URLSearchParams(window.location.search);
const forcedMode = urlParams.get('mode'); // 'offline' | 'live' | null

const ch = new BroadcastChannel(CHANNEL_NAME);

let session = null;
let isOfflineMode = false;
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

function getLang() {
  return currentLang || 'hi';
}

function broadcastState(extra = {}) {
  ch.postMessage({
    type: 'PORTAL_STATE',
    avatarStatus,
    modeLabel: currentModeLabel,
    avatarName: currentAvatarName,
    sessionMode: isOfflineMode ? 'OFFLINE' : sessionMode,
    ...extra,
  });
}

function updateUI() {
  const isConnected = avatarStatus === 'idle' || avatarStatus === 'speaking';

  if (statusPillEl && statusTextEl) {
    statusPillEl.dataset.state = avatarStatus;
    const labels = {
      offline: 'OFFLINE',
      connecting: 'CONNECTING...',
      idle: `LIVE • ${currentModeLabel || 'NEUTRAL'}`,
      speaking: `SPEAKING • ${currentModeLabel || 'RESPONDING'}`,
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
    btn.addEventListener('click', () => {
      unlockAudio(false);
      topicsGridEl.querySelectorAll('.topic-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const topic = QUICK_TOPICS.find((t) => t.id === btn.dataset.topicId);
      if (!topic) return;
      const lang = getLang();
      handleEmployeeQuery(topic.question[lang], {
        clipId: topic.id,
        answerText: topic.answer[lang],
        ref: topic.ref,
        modeLabel: topic.category.toUpperCase(),
      });
    });
  });
}

function updateUnmuteOverlay(forceShow = false) {
  if (!btnUnmuteOverlay) return;
  const isConnected = avatarStatus === 'idle' || avatarStatus === 'speaking';
  const show = isConnected && (forceShow || Boolean(pendingGreeting) || (!isOfflineMode && videoEl?.muted));
  btnUnmuteOverlay.style.display = show ? 'inline-flex' : 'none';
}

async function unlockAudio(triggerPendingGreeting = false) {
  if (videoEl) {
    videoEl.muted = false;
    videoEl.volume = 1.0;
    if (!isOfflineMode) {
      try {
        await videoEl.play();
      } catch (_) {}
    }
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
    appendMessage('assistant', g.text, { ref: 'GAVL-AI' });
    if (isOfflineMode) {
      playOfflineClip(g.clipId, g.text, 'GREETING');
    } else {
      speakText(g.text, 'GREETING');
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

  // Local dev server API check (only if JSON response)
  try {
    const res = await fetch('/api/offline-clips');
    if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
      const data = await res.json();
      for (const c of data.clips || []) {
        map.set(c.id, `${normalizedBase}offline/${c.file}`);
      }
      if (map.size > 0) return map;
    }
  } catch (_) {}

  // Static / GitHub Pages check using relative BASE_URL
  const knownIds = ['idle', 'welcome', 'leave', 'onboarding', 'it', 'payroll', 'hybrid', 'benefits', 'closing', 'fallback'];
  await Promise.all(
    knownIds.map(async (id) => {
      const url = `${normalizedBase}offline/${id}.webm`;
      try {
        const r = await fetch(url, { method: 'HEAD' });
        if (r.ok) map.set(id, url);
      } catch (_) {}
    })
  );
  return map;
}

async function startOfflineMode() {
  isOfflineMode = true;
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
    videoEl.onended = () => {
      videoEl.style.opacity = '0';
      avatarStatus = 'idle';
      currentModeLabel = 'NEUTRAL';
      updateUI();
      setTimeout(() => {
        if (avatarStatus === 'idle') setCaption('');
      }, 2400);
      broadcastState({ log: 'Offline clip finished → neutral idle loop.' });
    };
  }

  updateUI();
  broadcastState({ log: `Offline Mode active (${offlineClipMap.size} local clips loaded, 0 credits).` });

  // Attempt greeting immediately; if browser blocks unmuted autoplay, show Click to Enable Sound
  const welcomeText = SYSTEM_SCRIPTS[getLang()].welcome;
  if (offlineClipMap.has('welcome')) {
    const played = await playOfflineClip('welcome', welcomeText, 'GREETING', true);
    if (played) {
      appendMessage('assistant', welcomeText, { ref: 'GAVL-AI' });
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
    broadcastState({ log: `[OFFLINE • ${clipId}] Playing pre-recorded clip.` });
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

function resolveClipIdForText(queryText, matched) {
  const q = (queryText || '').toLowerCase().trim();
  for (const topic of QUICK_TOPICS) {
    if (topic.keywords.some((kw) => q.includes(kw))) return topic.id;
  }
  if (/^(hi|hello|hey|namaste|नमस्ते|good morning|good afternoon)/i.test(q)) return 'welcome';
  if (/(thank|thanks|धन्यवाद|bye|done|that's all)/i.test(q)) return 'closing';
  if (matched?.ref === 'GAVL-AI' && matched?.title === 'Greeting') return 'welcome';
  if (matched?.ref === 'GAVL-AI' && matched?.title === 'Wrap-up') return 'closing';
  return 'fallback';
}

// ---------- LIVE MODE (LIVEAVATAR + ELEVENLABS) ----------
async function startAvatarSession(config = {}) {
  isOfflineMode = false;
  if (idleVideoEl) idleVideoEl.style.display = 'none';
  if (videoEl) {
    videoEl.onended = null;
    videoEl.style.opacity = '1';
  }

  await stopAvatarSession(true);

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

  avatarStatus = 'connecting';
  currentModeLabel = 'CONNECTING';
  currentAvatarName = avatar_name;
  updateUI();
  broadcastState({
    log: `Starting LiveAvatar (${avatar_name}, mode=${sessionMode}, lang=${language}, sandbox=${is_sandbox})...`,
  });

  try {
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
      throw new Error(detailMsg || data.error || 'Failed to mint LiveAvatar session token');
    }

    session = new LiveAvatarSession(data.session_token, {
      autoKeepAlive: false,
      voiceChat: { defaultMuted: true },
    });

    session.on(SessionEvent.SESSION_STREAM_READY, async () => {
      let autoplayBlocked = false;
      if (videoEl && session) {
        session.attach(videoEl);
        videoEl.muted = false;
        videoEl.volume = 1.0;
        try {
          await videoEl.play();
        } catch (_) {
          autoplayBlocked = true;
          videoEl.muted = true;
          await videoEl.play().catch(() => {});
        }
      }
      avatarStatus = 'idle';
      currentModeLabel = 'NEUTRAL';
      updateUI();
      updateUnmuteOverlay(autoplayBlocked);
      broadcastState({
        log: `Stream ready (${avatar_name}) • Audio: ${sessionMode === 'CUSTOM' ? 'ElevenLabs 24kHz PCM' : 'LiveAvatar Voice'}${autoplayBlocked ? ' (muted until click)' : ''}.`,
      });

      if (config.autoGreet !== false) {
        const greeting = SYSTEM_SCRIPTS[language === 'hi' ? 'hi' : 'en'].welcome;
        if (autoplayBlocked) {
          pendingGreeting = { clipId: 'welcome', text: greeting };
          updateUnmuteOverlay(true);
        } else {
          pendingGreeting = null;
          setTimeout(() => {
            appendMessage('assistant', greeting, { ref: 'GAVL-AI' });
            speakText(greeting, 'GREETING');
          }, 650);
        }
      }
    });

    session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
      avatarStatus = 'speaking';
      updateUI();
      broadcastState();
    });

    session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
      avatarStatus = 'idle';
      currentModeLabel = 'NEUTRAL';
      updateUI();
      setTimeout(() => {
        if (avatarStatus === 'idle') setCaption('');
      }, 2600);
      broadcastState({ log: 'Maya returned to neutral idle pose.' });
    });

    session.on(SessionEvent.SESSION_DISCONNECTED, (reason) => {
      avatarStatus = 'offline';
      currentModeLabel = 'OFFLINE';
      session = null;
      updateUI();
      setCaption('');
      broadcastState({ log: `Session disconnected (${reason || 'closed'}).` });
    });

    await session.start();
  } catch (err) {
    console.error('LiveAvatar error:', err);
    avatarStatus = 'error';
    currentModeLabel = 'ERROR';
    updateUI();
    appendMessage('assistant', `Connection error: ${err.message}`, { ref: 'SYSTEM' });
    broadcastState({ error: err.message, log: `Error: ${err.message}` });
  }
}

async function stopAvatarSession(silent = false) {
  if (session) {
    try {
      await session.stop();
    } catch (_) {}
    session = null;
  }
  if (videoEl) {
    videoEl.srcObject = null;
  }
  avatarStatus = 'offline';
  currentModeLabel = 'OFFLINE';
  updateUI();
  setCaption('');
  if (!silent) broadcastState({ log: 'LiveAvatar session ended.' });
}

async function speakText(text, modeLabel = 'RESPONDING', clipId = null) {
  const clean = (text || '').trim();
  if (!clean) return;

  if (isOfflineMode) {
    await playOfflineClip(clipId || 'fallback', clean, modeLabel, false);
    return;
  }

  currentModeLabel = modeLabel;
  setCaption(clean);

  if (!session) {
    broadcastState({ log: `Offline preview only: "${clean.slice(0, 70)}"` });
    return;
  }

  try {
    if (sessionMode === 'CUSTOM') {
      avatarStatus = 'speaking';
      updateUI();
      broadcastState({ log: `[ElevenLabs → ${modeLabel}] Synthesizing 24kHz studio audio...` });

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
      broadcastState({
        log: `[ElevenLabs → ${modeLabel}] "${clean.slice(0, 85)}${clean.length > 85 ? '...' : ''}"`,
      });
    } else {
      session.repeat(clean);
      avatarStatus = 'speaking';
      updateUI();
      broadcastState({ log: `[${modeLabel}] "${clean.slice(0, 85)}${clean.length > 85 ? '...' : ''}"` });
    }
  } catch (err) {
    console.error('Speak error:', err);
    avatarStatus = 'idle';
    updateUI();
    appendMessage('assistant', `Audio synthesis error: ${err.message}`, { ref: 'AUDIO' });
    broadcastState({ error: err.message, log: `Speak error: ${err.message}` });
  }
}

function setNeutralIdle() {
  currentModeLabel = 'NEUTRAL';
  setCaption('');
  if (isOfflineMode) {
    if (videoEl) {
      videoEl.pause();
      videoEl.style.opacity = '0';
    }
    avatarStatus = 'idle';
    updateUI();
    broadcastState({ log: 'Returned Maya to neutral idle loop.' });
    return;
  }
  if (session) {
    try {
      session.interrupt();
    } catch (_) {}
    avatarStatus = 'idle';
  }
  updateUI();
  broadcastState({ log: 'Returned Maya to neutral idle pose.' });
}

function handleEmployeeQuery(questionText, precomputed = null) {
  const cleanQ = (questionText || '').trim();
  if (!cleanQ) return;

  pendingGreeting = null;
  updateUnmuteOverlay(false);
  appendMessage('employee', cleanQ);

  const response = precomputed
    ? {
        clipId: precomputed.clipId,
        text: precomputed.answerText,
        ref: precomputed.ref,
        modeLabel: precomputed.modeLabel || 'POLICY',
      }
    : (() => {
        const matched = matchKnowledge(cleanQ, getLang());
        return {
          clipId: resolveClipIdForText(cleanQ, matched),
          text: matched.text,
          ref: matched.ref,
          modeLabel: matched.category.toUpperCase(),
        };
      })();

  appendMessage('assistant', response.text, { ref: response.ref });
  speakText(response.text, response.modeLabel, response.clipId);
}

employeeFormEl?.addEventListener('submit', (e) => {
  e.preventDefault();
  unlockAudio(false);
  const val = employeeInputEl.value.trim();
  if (!val) return;
  employeeInputEl.value = '';
  handleEmployeeQuery(val);
});

btnUnmuteOverlay?.addEventListener('click', (e) => {
  e.stopPropagation();
  unlockAudio(true);
});

document.addEventListener('click', () => unlockAudio(false));
document.addEventListener('keydown', () => unlockAudio(false));

// Cleanly close any active live session on tab close/refresh to stop credit burn
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
      startAvatarSession(msg.payload || {});
      break;
    case 'PORTAL_STOP':
      stopAvatarSession(false);
      break;
    case 'PORTAL_SPEAK':
      if (msg.employeePrompt) {
        appendMessage('employee', msg.employeePrompt);
      }
      appendMessage('assistant', msg.text, { ref: msg.ref || 'GAVL-AI' });
      speakText(msg.text, msg.modeLabel || 'DEMO CUE', resolveClipIdForText(msg.employeePrompt || msg.text));
      break;
    case 'PORTAL_IDLE':
    case 'PORTAL_INTERRUPT':
      setNeutralIdle();
      break;
    case 'PORTAL_PING':
      broadcastState();
      break;
  }
};

// Boot: automatically use Offline Mode if pre-recorded clips exist (unless ?mode=live)
async function boot() {
  renderQuickTopics();
  updateUI();

  offlineClipMap = await detectOfflineClips();
  const hasOfflineClips = offlineClipMap.has('idle') && offlineClipMap.size >= 2;

  if (forcedMode === 'live') {
    startAvatarSession();
  } else if (hasOfflineClips || forcedMode === 'offline') {
    if (hasOfflineClips) {
      await startOfflineMode();
    } else {
      avatarStatus = 'offline';
      updateUI();
      appendMessage(
        'assistant',
        'No offline clips recorded yet. Open /record-offline.html once to capture Maya’s neutral idle and all Hindi topic clips, then reload for 100% offline zero-credit playback.',
        { ref: 'OFFLINE' }
      );
    }
  } else {
    startAvatarSession();
  }
}

boot();
