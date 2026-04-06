#!/bin/bash
set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
log() { echo -e "${GREEN}[SETUP]${NC} $1"; }
err() { echo -e "${RED}[ERRO]${NC} $1"; exit 1; }

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$BASE_DIR/.env"

log "Iniciando setup do Claude Chat..."

# --- 1. Node.js ---
if command -v node &>/dev/null; then
    NODE_VER=$(node -v)
    log "Node.js ja instalado: $NODE_VER"
else
    log "Instalando Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    log "Node.js instalado: $(node -v)"
fi

# --- 2. Redis ---
if command -v redis-server &>/dev/null; then
    log "Redis ja instalado"
else
    log "Instalando Redis..."
    apt-get update -qq
    apt-get install -y redis-server
    log "Redis instalado"
fi

# --- 3. Build tools for node-pty ---
log "Instalando build tools para node-pty..."
apt-get install -y make gcc g++ python3 2>/dev/null || true

# --- 4. Configure Redis with password ---
REDIS_PASS=$(openssl rand -hex 16)

# Set Redis password
REDIS_CONF="/etc/redis/redis.conf"
if [ -f "$REDIS_CONF" ]; then
    sed -i "s/^# requirepass .*/requirepass $REDIS_PASS/" "$REDIS_CONF"
    sed -i "s/^requirepass .*/requirepass $REDIS_PASS/" "$REDIS_CONF"
    if ! grep -q "^requirepass" "$REDIS_CONF"; then
        echo "requirepass $REDIS_PASS" >> "$REDIS_CONF"
    fi
    systemctl restart redis-server 2>/dev/null || redis-server --daemonize yes 2>/dev/null || true
    log "Redis configurado com senha"
else
    log "Redis config nao encontrada, iniciando sem senha"
    REDIS_PASS=""
    redis-server --daemonize yes 2>/dev/null || true
fi

# --- 5. Create .env ---
JWT_SECRET=$(openssl rand -hex 32)

if [ -n "$REDIS_PASS" ]; then
    REDIS_URL="redis://:${REDIS_PASS}@127.0.0.1:6379"
else
    REDIS_URL="redis://127.0.0.1:6379"
fi

cat > "$ENV_FILE" << EOF
PORT=3000
JWT_SECRET=${JWT_SECRET}
LOGIN_USER=daniellbaptistta
LOGIN_PASS=248513
REDIS_URL=${REDIS_URL}
UPLOAD_DIR=${BASE_DIR}/uploads
EOF
log ".env criado"

# --- 6. npm install ---
log "Instalando dependencias..."
cd "$BASE_DIR"
npm install --production 2>&1 | tail -5
log "Dependencias instaladas"

# --- 7. Create uploads dir ---
mkdir -p "$BASE_DIR/uploads"

# --- 8. Create systemd service ---
cat > /etc/systemd/system/claude-chat.service << EOF
[Unit]
Description=Claude Chat Web Interface
After=network.target redis-server.service

[Service]
Type=simple
User=root
WorkingDirectory=${BASE_DIR}
ExecStart=$(which node) ${BASE_DIR}/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable claude-chat.service
systemctl start claude-chat.service
log "Servico claude-chat criado e iniciado"

# --- 9. Final ---
VPS_IP=$(curl -s -4 ifconfig.me 2>/dev/null || echo "SEU_IP")

echo ""
log "============================================"
log "Claude Chat instalado com sucesso!"
log "============================================"
echo ""
echo "  Acesse: http://${VPS_IP}:3000"
echo "  Usuario: daniellbaptistta"
echo "  Senha: 248513"
echo ""
echo "  Comandos uteis:"
echo "    systemctl status claude-chat"
echo "    systemctl restart claude-chat"
echo "    journalctl -u claude-chat -f"
echo ""
