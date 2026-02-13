#!/bin/bash
# Start Stark proxy services + Cloudflare tunnels
# Run this on boot or after restart

PROXY_DIR="$(cd "$(dirname "$0")" && pwd)"
TUNNEL_FILE="$PROXY_DIR/tunnels.json"

echo "⚡ Starting Stark services..."

# Kill existing processes
/usr/sbin/lsof -i:8013 -t 2>/dev/null | xargs kill -9 2>/dev/null
/usr/sbin/lsof -i:8014 -t 2>/dev/null | xargs kill -9 2>/dev/null
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

# Start Cloudflare tunnels
nohup /opt/homebrew/bin/cloudflared tunnel --url http://127.0.0.1:18789 > /tmp/cloudflared-gateway.log 2>&1 &
GW_PID=$!
echo "  Gateway tunnel: PID $GW_PID"

nohup /opt/homebrew/bin/cloudflared tunnel --url http://127.0.0.1:8014 > /tmp/cloudflared-logger.log 2>&1 &
LOG_PID=$!
echo "  Logger tunnel: PID $LOG_PID"

# Wait for tunnels to establish
sleep 6

GW_URL=$(grep -o 'https://[^ ]*\.trycloudflare\.com' /tmp/cloudflared-gateway.log | head -1)
LOG_URL=$(grep -o 'https://[^ ]*\.trycloudflare\.com' /tmp/cloudflared-logger.log | head -1)

echo ""
echo "🌐 Tunnel URLs:"
echo "  Gateway: $GW_URL"
echo "  Logger:  $LOG_URL"
echo ""
echo "📋 StarkChrome config:"
echo "  OpenClaw webhook: $GW_URL/hooks/agent"
echo "  Logger endpoint:  $LOG_URL/events"
echo "  Token: 25b8d60afe0d8fa0141d833affca1b023d45d9f45d174e86"

# Save URLs to file for reference
cat > "$TUNNEL_FILE" << EOF
{
  "gateway": "$GW_URL",
  "logger": "$LOG_URL",
  "gatewayWebhook": "$GW_URL/hooks/agent",
  "loggerEndpoint": "$LOG_URL/events",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo ""
echo "✅ All services started. URLs saved to tunnels.json"
