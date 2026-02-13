/**
 * Vercel serverless function — generates a conversation token
 * for the ElevenLabs conversational agent (WebRTC connection).
 *
 * The API key stays server-side and is never exposed to the client.
 */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!agentId || !apiKey) {
    return res.status(500).json({ error: 'Server is missing ElevenLabs configuration' });
  }

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${agentId}`,
      {
        method: 'GET',
        headers: { 'xi-api-key': apiKey },
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`ElevenLabs API error (${response.status}):`, body);
      return res.status(502).json({ error: 'Upstream API error' });
    }

    const data = await response.json();
    return res.status(200).json({ token: data.token });
  } catch (err) {
    console.error('Token error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
