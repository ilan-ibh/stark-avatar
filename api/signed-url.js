/**
 * Vercel serverless function — generates a signed WebSocket URL
 * for the ElevenLabs conversational agent.
 * 
 * API key stays server-side, never exposed to the client.
 */
export default async function handler(req, res) {
  // CORS headers for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!agentId || !apiKey) {
    return res.status(500).json({ error: 'Missing ElevenLabs configuration' });
  }

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`,
      {
        method: 'GET',
        headers: {
          'xi-api-key': apiKey,
        },
      }
    );

    if (!response.ok) {
      const body = await response.text();
      console.error('ElevenLabs API error:', response.status, body);
      return res.status(response.status).json({ error: 'Failed to get signed URL' });
    }

    const data = await response.json();
    return res.status(200).json({ signed_url: data.signed_url });
  } catch (err) {
    console.error('Signed URL error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
