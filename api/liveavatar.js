const LIVEAVATAR_BASE = 'https://api.liveavatar.com/v1';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.LIVEAVATAR_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing LIVEAVATAR_API_KEY in environment.' });
  }

  if (req.method === 'GET') {
    const action = req.query?.action || 'catalog';
    if (action === 'catalog') {
      try {
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
        return res.status(200).json({
          avatars: allAvatars,
          voices: vData?.data?.results || [],
        });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
    return res.status(400).json({ error: 'Unsupported GET action' });
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const {
        mode = 'CUSTOM',
        avatar_id = '3fb34e60-2665-4123-98f0-e2054ff243f1',
        voice_id = '8d7ca40c-5ee6-45f3-8b4a-e2b01df302a1',
        language = 'en',
        is_sandbox = false,
      } = body;

      const sessionMode = mode === 'FULL' ? 'FULL' : 'CUSTOM';
      const payload =
        sessionMode === 'CUSTOM'
          ? {
              mode: 'CUSTOM',
              is_sandbox: Boolean(is_sandbox),
              avatar_id,
            }
          : {
              mode: 'FULL',
              is_sandbox: Boolean(is_sandbox),
              avatar_id,
              avatar_persona: {
                language,
                ...(voice_id ? { voice_id } : {}),
              },
            };

      const tokenRes = await fetch(`${LIVEAVATAR_BASE}/sessions/token`, {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok) {
        return res.status(tokenRes.status).json({
          error: tokenData.message || 'Failed to mint LiveAvatar session token',
          details: tokenData,
        });
      }
      return res.status(200).json({
        mode: sessionMode,
        session_id: tokenData?.data?.session_id || '',
        session_token: tokenData?.data?.session_token || '',
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
