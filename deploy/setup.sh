#!/bin/bash
# ================================================================
#  DeepDarkFantasy — VPS Initial Setup
#  Run once on a fresh Ubuntu 22.04 server as root:
#    bash setup.sh yourdomain.com
# ================================================================
set -e

DOMAIN="${1:-}"
REPO="https://github.com/IsaacDisnaut/Webtester.git"
APP_DIR="/var/www/deepdark"

if [ -z "$DOMAIN" ]; then
  echo "Usage: bash setup.sh yourdomain.com"
  exit 1
fi

echo ""
echo "==================================================="
echo "  Setting up DeepDarkFantasy on $DOMAIN"
echo "==================================================="
echo ""

# ── System packages ──────────────────────────────────
echo "[1/7] Updating system..."
apt-get update -qq && apt-get upgrade -y -qq

echo "[2/7] Installing Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | bash - >/dev/null
apt-get install -y nodejs git nginx certbot python3-certbot-nginx >/dev/null

echo "[3/7] Installing PM2..."
npm install -g pm2 >/dev/null

# ── Clone repo ───────────────────────────────────────
echo "[4/7] Cloning repository..."
mkdir -p /var/www
if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR" && git pull origin main
else
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
git submodule update --init --recursive
cd videocall && npm install --omit=dev && cd ..

# ── Nginx config ─────────────────────────────────────
echo "[5/7] Configuring Nginx..."
sed "s/YOUR_DOMAIN/$DOMAIN/g" /var/www/deepdark/deploy/nginx.conf \
  > /etc/nginx/sites-available/deepdark
ln -sf /etc/nginx/sites-available/deepdark /etc/nginx/sites-enabled/deepdark
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ── SSL certificate ──────────────────────────────────
echo "[6/7] Getting SSL certificate from Let's Encrypt..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN"

# ── PM2 ─────────────────────────────────────────────
echo "[7/7] Starting app with PM2..."
pm2 start "$APP_DIR/deploy/ecosystem.config.js"
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash

echo ""
echo "==================================================="
echo "  Done!  Visit https://$DOMAIN"
echo "==================================================="
echo ""
echo "IMPORTANT: Create the API keys file:"
echo "  nano $APP_DIR/apikey"
echo ""
echo "Format:"
echo "  Groq: gsk_..."
echo "  Gemini: AIza..."
echo "  Openrouter: sk-or-..."
echo ""
echo "Then restart: pm2 restart deepdark"
