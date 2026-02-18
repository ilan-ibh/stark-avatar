#!/bin/bash
# Start Stark proxy services + named Cloudflare tunnel
# Tunnel: "stark" — permanent subdomains on ilandev.com
#   gateway.ilandev.com  → OpenClaw (18789)
#   logger.ilandev.com   → Chrome logger (8014)
#   proxy.ilandev.com    → Voice proxy (8013)

PROXY_DIR="$(cd "$(dirname "$0")" && pwd)"
TUNNEL_FILE="$PROXY_DIR/tunnels.json"

echo "⚡ Starting Stark services..."

# Kill existing processes
/usr/sbin/lsof -i:8013 -t 2>/dev/null | xargs kill -9 2>/dev/null
/usr/sbin/lsof -i:8014 -t 2>/dev/null | xargs kill -9 2>/dev/null
pkill -f "cloudflared tunnel run" 2>/dev/null
pkill -f "cloudflared tunnel --url" 2>/dev/null
sleep 2

# Start voice proxy (port 8013)
cd "$PROXY_DIR"
nohup node server.js > /tmp/stark-proxy.log 2>&1 &
echo "  Voice proxy: PID $! (port 8013)"

# Start chrome logger (port 8014)
nohup node chrome-logger.js > /tmp/chrome-logger.log 2>&1 &
echo "  Chrome logger: PID $! (port 8014)"

sleep 2

# Start named Cloudflare tunnel (permanent URLs)
nohup /opt/homebrew/bin/cloudflared tunnel run stark > /tmp/cloudflared-stark.log 2>&1 &
TUNNEL_PID=$!
echo "  Cloudflare tunnel 'stark': PID $TUNNEL_PID"

sleep 3

echo ""
echo "🌐 Permanent tunnel URLs (ilandev.com):"
echo "  Gateway:  https://gateway.ilandev.com"
echo "  Logger:   https://logger.ilandev.com"
echo "  Proxy:    https://proxy.ilandev.com"
echo ""
echo "📋 StarkChrome config:"
echo "  OpenClaw webhook: https://gateway.ilandev.com/hooks/agent"
echo "  Logger endpoint:  https://logger.ilandev.com/events"
echo "  Token: 25b8d60afe0d8fa0141d833affca1b023d45d9f45d174e86"

# Save permanent URLs to file
cat > "$TUNNEL_FILE" << EOF
{
  "gateway": "https://gateway.ilandev.com",
  "logger": "https://logger.ilandev.com",
  "proxy": "https://proxy.ilandev.com",
  "gatewayWebhook": "https://gateway.ilandev.com/hooks/agent",
  "loggerEndpoint": "https://logger.ilandev.com/events",
  "tunnelName": "stark",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo ""
echo "✅ All services started. Permanent URLs — no update needed after restart."
