import { QUICK_TOPICS, SYSTEM_SCRIPTS } from './knowledge.js';

const ch = new BroadcastChannel('gavl_live_avatar');

let catalogAvatars = [];
let elevenLabsVoices = [];

const selAvatar = document.getElementById('sel-avatar');
const selAudioEngine = document.getElementById('sel-audio-engine');
const selElVoice = document.getElementById('sel-el-voice');
const selElModel = document.getElementById('sel-el-model');
const elOptionsBox = document.getElementById('elevenlabs-options');
const selLang = document.getElementById('sel-lang');
const chkSandbox = document.getElementById('chk-sandbox');
const chkAutogreet = document.getElementById('chk-autogreet');
const previewImg = document.getElementById('avatar-preview-img');
const previewName = document.getElementById('avatar-preview-name');
const previewMeta = document.getElementById('avatar-preview-meta');
const studioLog = document.getElementById('studio-log');
const chipPortal = document.getElementById('chip-portal');
const chipAvatar = document.getElementById('chip-avatar');
const cueGrid = document.getElementById('cue-grid');

const simQuestionInput = document.getElementById('sim-question');
const teleprompterInput = document.getElementById('teleprompter-text');

function log(msg) {
  if (!studioLog) return;
  const ts = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.textContent = `[${ts}] ${msg}`;
  studioLog.prepend(line);
}

function getLang() {
  return selLang?.value || 'en';
}

async function loadCatalog() {
  try {
    const [laRes, elRes] = await Promise.all([
      fetch('/api/liveavatar?action=catalog'),
      fetch('/api/elevenlabs-tts?action=voices'),
    ]);

    const laData = await laRes.json();
    if (!laRes.ok) throw new Error(laData.error || 'Failed to load LiveAvatar catalog');
    catalogAvatars = laData.avatars || [];

    selAvatar.innerHTML = catalogAvatars
      .map((a) => `<option value="${a.id}">${a.name}${a.is_1080p ? ' (1080p)' : ''}</option>`)
      .join('');

    const preferred =
      catalogAvatars.find((a) => /maya\s*\(serious\)/i.test(a.name || '')) ||
      catalogAvatars.find((a) => /maya/i.test(a.name || '')) ||
      catalogAvatars[0];
    if (preferred) selAvatar.value = preferred.id;
    onAvatarChange();

    const PREFERRED_EL_VOICE_ID = 'hL2sW5Y3zbNy7yYtXwBo';
    if (elRes.ok) {
      const elData = await elRes.json();
      elevenLabsVoices = elData.voices || [];
      const hasPreferred = elevenLabsVoices.some((v) => v.id === PREFERRED_EL_VOICE_ID);
      if (!hasPreferred) {
        elevenLabsVoices.unshift({
          id: PREFERRED_EL_VOICE_ID,
          name: 'Selected GAVL Voice (Default)',
          gender: '',
          accent: '',
        });
      }
      if (elevenLabsVoices.length > 0) {
        selElVoice.innerHTML = elevenLabsVoices
          .map(
            (v) =>
              `<option value="${v.id}">${v.name}${v.gender || v.accent ? ` (${[v.gender, v.accent].filter(Boolean).join(', ')})` : ''}</option>`
          )
          .join('');
        selElVoice.value = PREFERRED_EL_VOICE_ID;
      }
      log(`Loaded ${catalogAvatars.length} avatars & ${elevenLabsVoices.length} ElevenLabs voices.`);
    } else {
      log(`Loaded ${catalogAvatars.length} avatars (using ElevenLabs voice ${PREFERRED_EL_VOICE_ID}).`);
    }
  } catch (err) {
    log(`Catalog error: ${err.message}`);
  }
}

function onAvatarChange() {
  const av = catalogAvatars.find((a) => a.id === selAvatar.value);
  if (!av) return;
  previewImg.src = av.preview_url || '';
  previewName.textContent = av.name;
  previewMeta.textContent = `1080p LiveAvatar • Studio Audio Sync`;
}

function renderCueButtons() {
  const topicCues = QUICK_TOPICS.map(
    (t) => `
      <button class="cue-btn" data-topic="${t.id}">
        <span>${t.title}</span>
        <small>${t.category} • ${t.ref}</small>
      </button>
    `
  ).join('');

  cueGrid.innerHTML = `
    <button class="cue-btn accent" data-action="welcome">
      <span>Welcome Greeting</span>
      <small>Greet employee &amp; introduce GAVL AI Desk</small>
    </button>
    <button class="cue-btn" data-action="idle">
      <span>Neutral Idle Pose</span>
      <small>Stop speaking &amp; hold calm attentive pose</small>
    </button>
    ${topicCues}
    <button class="cue-btn" data-action="closing">
      <span>Closing Sign-off</span>
      <small>Wrap up internal support session</small>
    </button>
    <button class="cue-btn danger" data-action="interrupt">
      <span>Interrupt / Silence</span>
      <small>Cut audio immediately</small>
    </button>
  `;

  cueGrid.querySelectorAll('.cue-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lang = getLang();
      const action = btn.dataset.action;
      const topicId = btn.dataset.topic;

      if (action === 'welcome') {
        ch.postMessage({
          type: 'PORTAL_SPEAK',
          text: SYSTEM_SCRIPTS[lang].welcome,
          ref: 'GAVL-AI',
          modeLabel: 'GREETING',
        });
        log('Triggered Welcome Greeting.');
      } else if (action === 'closing') {
        ch.postMessage({
          type: 'PORTAL_SPEAK',
          text: SYSTEM_SCRIPTS[lang].closing,
          ref: 'GAVL-AI',
          modeLabel: 'SIGN-OFF',
        });
        log('Triggered Closing Sign-off.');
      } else if (action === 'idle' || action === 'interrupt') {
        ch.postMessage({ type: 'PORTAL_IDLE' });
        log('Triggered Neutral Idle / Interrupt.');
      } else if (topicId) {
        const topic = QUICK_TOPICS.find((t) => t.id === topicId);
        if (!topic) return;
        ch.postMessage({
          type: 'PORTAL_SPEAK',
          employeePrompt: topic.question[lang],
          text: topic.answer[lang],
          ref: topic.ref,
          modeLabel: topic.category.toUpperCase(),
        });
        log(`Triggered topic cue: ${topic.title} (${topic.ref}).`);
      }
    });
  });
}

selAvatar?.addEventListener('change', onAvatarChange);
selAudioEngine?.addEventListener('change', () => {
  if (elOptionsBox) {
    elOptionsBox.style.display = selAudioEngine.value === 'elevenlabs' ? 'block' : 'none';
  }
});

document.getElementById('btn-start')?.addEventListener('click', () => {
  const avatar_id = selAvatar.value;
  const av = catalogAvatars.find((a) => a.id === avatar_id);
  const language = getLang();
  const is_sandbox = Boolean(chkSandbox.checked);
  const autoGreet = Boolean(chkAutogreet.checked);
  const audio_engine = selAudioEngine.value;

  ch.postMessage({
    type: 'PORTAL_START',
    payload: {
      avatar_id,
      voice_id: av?.default_voice?.id || '',
      audio_engine,
      elevenlabs_voice_id: selElVoice.value,
      elevenlabs_model_id: selElModel.value,
      language,
      is_sandbox,
      autoGreet,
      avatar_name: 'Maya',
    },
  });
  log(`Sent START → ${av?.name || avatar_id} (audio=${audio_engine}, sandbox=${is_sandbox})`);
});

document.getElementById('btn-stop')?.addEventListener('click', () => {
  ch.postMessage({ type: 'PORTAL_STOP' });
  log('Sent STOP command.');
});

document.getElementById('btn-speak-custom')?.addEventListener('click', () => {
  const text = (teleprompterInput.value || '').trim();
  if (!text) return;
  const employeePrompt = (simQuestionInput.value || '').trim();
  ch.postMessage({
    type: 'PORTAL_SPEAK',
    employeePrompt: employeePrompt || undefined,
    text,
    ref: 'GAVL-AI',
    modeLabel: 'TELEPROMPTER',
  });
  log(`Sent teleprompter line: "${text.slice(0, 70)}"`);
});

document.getElementById('btn-clear-custom')?.addEventListener('click', () => {
  simQuestionInput.value = '';
  teleprompterInput.value = '';
});

ch.onmessage = (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'PORTAL_STATE') {
    chipPortal.textContent = 'Portal: Connected';
    chipPortal.className = 'chip green';

    const st = (msg.avatarStatus || 'offline').toLowerCase();
    chipAvatar.textContent = `Avatar: ${st.toUpperCase()}`;
    chipAvatar.className =
      st === 'speaking'
        ? 'chip blue'
        : st === 'idle'
          ? 'chip green'
          : st === 'connecting'
            ? 'chip amber'
            : st === 'error'
              ? 'chip red'
              : 'chip';

    if (msg.log) log(msg.log);
  }
};

renderCueButtons();
loadCatalog();
setInterval(() => ch.postMessage({ type: 'PORTAL_PING' }), 4000);
ch.postMessage({ type: 'PORTAL_PING' });
