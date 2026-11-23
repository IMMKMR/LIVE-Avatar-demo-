const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const SYSTEM_PROMPT = `You are Maya, a warm, calm, and polite Indian female HR assistant at Godrej Agrovet Ltd (GAVL).
Rules:
- Always reply in natural, soft, conversational Devanagari Hindi (2 short sentences maximum, under 35 words total).
- If the employee mentions their name or asks you to greet/address someone by name, warmly greet them using that exact name in Hindi.
- Answer HR, leave (24 privilege leaves, 10 sick leaves, 10 carry-forward), onboarding, IT/VPN, payroll (second-last working day), hybrid work (Tue-Thu), or health benefits accurately for Godrej Agrovet Ltd.
- Do not use markdown, bullet points, emojis, or quotation marks — write clean spoken Hindi only.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const message = (body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(200).json({
        reply: `नमस्ते! मैंने आपका मैसेज नोट कर लिया है। बताइए, गोदरेज एग्रोवेट में आज मैं आपकी क्या मदद कर सकती हूँ?`,
        source: 'fallback',
      });
    }

    const gRes = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: message }] }],
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 120,
        },
      }),
    });

    const gData = await gRes.json();
    const reply = gData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!gRes.ok || !reply) {
      throw new Error(gData?.error?.message || 'Gemini reply failed');
    }

    return res.status(200).json({ reply, source: 'gemini-2.5-flash' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
