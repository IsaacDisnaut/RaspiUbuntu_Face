#!/bin/bash
# ================================================================
#  DeepDarkFantasy — Update & Restart
#  Run this every time you push new code to GitHub:
#    bash /var/www/deepdark/deploy/deploy.sh
# ================================================================
set -e

APP_DIR="/var/www/deepdark"
cd "$APP_DIR"

echo "[1/4] Pulling latest code..."
git pull origin main
git submodule update --remote --merge

echo "[2/4] Installing dependencies..."
cd videocall && npm install --omit=dev && cd ..

echo "[3/4] Creating log directory..."
mkdir -p /var/log/deepdark

echo "[4/4] Restarting server..."
pm2 restart deepdark || pm2 start deploy/ecosystem.config.js

echo ""
echo "✓ Deploy complete!  $(date '+%Y-%m-%d %H:%M:%S')"
pm2 status deepdark
