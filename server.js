require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const { createClient } = require('redis');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const { Bot } = require('grammy');

// --- Config ---
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
const LOGIN_USER = process.env.LOGIN_USER || 'admin';
const LOGIN_PASS = process.env.LOGIN_PASS || 'admin';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7579372831';
const SESSION_KEY = 'claude-chat:session';
const MAX_HISTORY = 200;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- Session maps ---
// wsSessionId -> { claudeSessionId, isProcessing, queue, ws, uploadDir, token }
const sessions = new Map();

// token -> wsSessionId (for /api/reset lookup)
const tokenToSessionId = new Map();

// Telegram has its own persistent session
const telegramSession = { claudeSessionId: null, isProcessing: false, queue: [] };

// --- Redis ---
const redis = createClient({ url: REDIS_URL });
redis.on('error', (err) => console.error('[Redis]', err.message));

// --- Express ---
const app = express();
const server = http.createServer(app);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      connectSrc: ["'self'", "ws:", "wss:"],
      imgSrc: ["'self'", "data:", "blob:"],
    }
  }
}));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth ---
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// --- Routes ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === LOGIN_USER && password === LOGIN_PASS) {
    const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: '30d' });
    redis.set(SESSION_KEY, token, { EX: 30 * 24 * 3600 }).catch(() => {});
    return res.json({ ok: true, token });
  }
  res.status(401).json({ ok: false, error: 'Credenciais invalidas' });
});

app.post('/api/upload', (req, res) => {
  const auth = req.headers.authorization;
  const token = auth ? auth.replace('Bearer ', '') : null;
  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: 'Nao autorizado' });
  }

  // Find session upload dir for this token
  const wsSessionId = tokenToSessionId.get(token);
  const sessionUploadDir = wsSessionId
    ? path.join(UPLOAD_DIR, wsSessionId)
    : UPLOAD_DIR;

  if (!fs.existsSync(sessionUploadDir)) fs.mkdirSync(sessionUploadDir, { recursive: true });

  const sessionStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, sessionUploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${ext}`);
    }
  });
  const sessionUpload = multer({
    storage: sessionStorage,
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf',
        'text/plain', 'text/csv', 'application/json', 'application/zip'];
      cb(null, allowed.includes(file.mimetype));
    }
  });

  sessionUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    res.json({ ok: true, path: req.file.path, name: req.file.originalname });
  });
});

app.get('/api/history', async (req, res) => {
  const auth = req.headers.authorization;
  const token = auth ? auth.replace('Bearer ', '') : null;
  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: 'Nao autorizado' });
  }
  try {
    const wsSessionId = tokenToSessionId.get(token);
    const historyKey = wsSessionId
      ? `claude-chat:history:${wsSessionId}`
      : 'claude-chat:history';
    const raw = await redis.lRange(historyKey, -50, -1);
    const messages = raw.map(r => JSON.parse(r));
    res.json({ ok: true, messages });
  } catch {
    res.json({ ok: true, messages: [] });
  }
});

// Reset session endpoint - resets only the caller's session
app.post('/api/reset', (req, res) => {
  const auth = req.headers.authorization;
  const token = auth ? auth.replace('Bearer ', '') : null;
  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: 'Nao autorizado' });
  }
  const wsSessionId = tokenToSessionId.get(token);
  if (wsSessionId && sessions.has(wsSessionId)) {
    sessions.get(wsSessionId).claudeSessionId = null;
    console.log(`[Claude] Session reset for wsSessionId=${wsSessionId}`);
  }
  res.json({ ok: true });
});

// --- Redis helper ---
async function saveMessage(role, content, source = 'web', wsSessionId = null) {
  const msg = { role, content, source, ts: Date.now() };
  const historyKey = wsSessionId
    ? `claude-chat:history:${wsSessionId}`
    : 'claude-chat:history';
  try {
    await redis.rPush(historyKey, JSON.stringify(msg));
    await redis.lTrim(historyKey, -MAX_HISTORY, -1);
  } catch {}
  return msg;
}

// --- Telegram Bot ---
let bot = null;
if (TELEGRAM_TOKEN) {
  bot = new Bot(TELEGRAM_TOKEN);
  console.log('[Telegram] Bot initialized');
} else {
  console.warn('[Telegram] No token found, bot disabled');
}

// --- Broadcast to all WebSocket clients ---
function broadcastWeb(msg) {
  const payload = JSON.stringify(msg);
  sessions.forEach(sess => {
    if (sess.ws && sess.ws.readyState === 1) sess.ws.send(payload);
  });
}

// --- Claude Code integration: per-session ---
function sendToClaude(text, wsSessionId, source = 'web') {
  // Resolve session context: 'telegram' uses telegramSession, others use sessions Map
  const isTelegram = wsSessionId === 'telegram';
  const sessCtx = isTelegram ? telegramSession : sessions.get(wsSessionId);

  if (!sessCtx) {
    console.error(`[Claude] No session context for wsSessionId=${wsSessionId}`);
    return Promise.reject(new Error('Session not found'));
  }

  return new Promise((resolve, reject) => {
    if (sessCtx.isProcessing) {
      sessCtx.queue.push({ text, resolve, reject });
      return;
    }

    sessCtx.isProcessing = true;
    let fullResponse = '';
    let buffer = '';

    // Send typing indicator only to the relevant ws (or broadcast for telegram)
    const sendToSession = (msg) => {
      if (isTelegram) {
        broadcastWeb(msg);
      } else if (sessCtx.ws && sessCtx.ws.readyState === 1) {
        sessCtx.ws.send(JSON.stringify(msg));
      }
    };

    sendToSession({ type: 'typing', active: true, source });
    console.log(`[Claude] Processing wsSessionId=${wsSessionId} (${source}): ${text.substring(0, 80)}...`);

    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (sessCtx.claudeSessionId) {
      args.push('--resume', sessCtx.claudeSessionId);
    }

    console.log(`[Claude] Session: ${sessCtx.claudeSessionId || 'new'}`);
    const proc = spawn('claude', args, {
      cwd: '/root',
      env: { ...process.env, HOME: '/root' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    proc.stdin.write(text);
    proc.stdin.end();

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          if (event.session_id && !sessCtx.claudeSessionId) {
            sessCtx.claudeSessionId = event.session_id;
            console.log(`[Claude] Got session: ${sessCtx.claudeSessionId}`);
          }

          if (event.type === 'assistant' && event.message) {
            const texts = (event.message.content || [])
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('');
            if (texts && texts !== fullResponse) {
              const newPart = texts.substring(fullResponse.length);
              if (newPart) {
                fullResponse = texts;
                sendToSession({ type: 'stream', content: newPart });
              }
            }
          } else if (event.type === 'result') {
            if (event.session_id) {
              sessCtx.claudeSessionId = event.session_id;
              console.log(`[Claude] Captured session: ${sessCtx.claudeSessionId}`);
            }
            if (event.result && event.result !== fullResponse) {
              const newPart = event.result.substring(fullResponse.length);
              if (newPart) {
                fullResponse = event.result;
                sendToSession({ type: 'stream', content: newPart });
              }
            }
          }
        } catch {
          // skip non-JSON lines
        }
      }
    });

    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });

    proc.on('close', (code) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === 'result' && event.result && !fullResponse) {
            fullResponse = event.result;
            sendToSession({ type: 'stream', content: event.result });
          }
        } catch {}
      }

      if (!fullResponse && stderrBuf) {
        console.error('[Claude] stderr:', stderrBuf.substring(0, 500));
      }

      if (!fullResponse) {
        fullResponse = 'Desculpe, nao consegui processar. Tente novamente.';
        sendToSession({ type: 'stream', content: fullResponse });
      }

      sendToSession({ type: 'response_end' });

      // Save response
      saveMessage('assistant', fullResponse, 'claude', isTelegram ? null : wsSessionId);

      // Mirror to Telegram (only if message came from web)
      if (bot && TELEGRAM_CHAT_ID && source === 'web') {
        const telegramText = fullResponse.substring(0, 4000);
        if (telegramText.length > 0) {
          bot.api.sendMessage(TELEGRAM_CHAT_ID, '[Web] ' + telegramText).catch(err => {
            console.error('[Telegram] Send error:', err.message);
          });
        }
      }

      console.log(`[Claude] Done (${code}): ${fullResponse.substring(0, 80)}...`);
      sessCtx.isProcessing = false;
      resolve(fullResponse);

      // Process next in queue
      if (sessCtx.queue.length > 0) {
        const next = sessCtx.queue.shift();
        sendToClaude(next.text, wsSessionId, source).then(next.resolve).catch(next.reject);
      }
    });

    proc.on('error', (err) => {
      console.error('[Claude] Spawn error:', err.message);
      sessCtx.isProcessing = false;
      sendToSession({ type: 'response_end' });
      reject(err);
    });

    // Timeout after 10 minutes
    const timeoutId = setTimeout(() => {
      if (sessCtx.isProcessing) {
        try { proc.kill(); } catch {}
        sessCtx.isProcessing = false;
        sendToSession({ type: 'response_end' });
      }
    }, 600000);

    proc.on('close', () => clearTimeout(timeoutId));
  });
}

// --- Telegram message handler ---
if (bot) {
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const userName = ctx.from.first_name || 'User';

    console.log(`[Telegram] ${userName}: ${text}`);
    await saveMessage('user', text, 'telegram', null);
    broadcastWeb({ type: 'telegram_message', content: text, user: userName });

    sendToClaude(text, 'telegram', 'telegram').catch(err => {
      console.error('[Telegram] Claude error:', err.message);
      ctx.reply('Erro ao processar mensagem.').catch(() => {});
    });
  });

  bot.on('message:photo', async (ctx) => {
    const caption = ctx.message.caption || 'Analise esta imagem';
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    try {
      const file = await ctx.api.getFile(photo.file_id);
      const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
      const fetch = require('node-fetch');
      const res = await fetch(url);
      const arrayBuf = await res.buffer();
      const filePath = path.join(UPLOAD_DIR, `tg-${Date.now()}.jpg`);
      fs.writeFileSync(filePath, arrayBuf);

      await saveMessage('user', `[Foto] ${caption}`, 'telegram', null);
      broadcastWeb({ type: 'telegram_message', content: `[Foto] ${caption}`, user: ctx.from.first_name });
      sendToClaude(`Read the image at ${filePath} and: ${caption}`, 'telegram', 'telegram');
    } catch (err) {
      console.error('[Telegram] Photo error:', err.message);
    }
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const caption = ctx.message.caption || `Analise o arquivo ${doc.file_name}`;
    try {
      const file = await ctx.api.getFile(doc.file_id);
      const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
      const fetch = require('node-fetch');
      const res = await fetch(url);
      const arrayBuf = await res.buffer();
      const filePath = path.join(UPLOAD_DIR, `tg-${Date.now()}-${doc.file_name}`);
      fs.writeFileSync(filePath, arrayBuf);

      await saveMessage('user', `[${doc.file_name}] ${caption}`, 'telegram', null);
      broadcastWeb({ type: 'telegram_message', content: `[${doc.file_name}] ${caption}`, user: ctx.from.first_name });
      sendToClaude(`Analyze the file at ${filePath}: ${caption}`, 'telegram', 'telegram');
    } catch (err) {
      console.error('[Telegram] Doc error:', err.message);
    }
  });
}

// --- WebSocket ---
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  if (!verifyToken(token)) {
    ws.close(4001, 'Nao autorizado');
    return;
  }

  const wsSessionId = uuidv4();
  const sessionUploadDir = path.join(UPLOAD_DIR, wsSessionId);
  fs.mkdirSync(sessionUploadDir, { recursive: true });

  sessions.set(wsSessionId, {
    claudeSessionId: null,
    isProcessing: false,
    queue: [],
    ws,
    uploadDir: sessionUploadDir,
    token
  });

  // Map token -> wsSessionId for /api/reset and /api/upload
  tokenToSessionId.set(token, wsSessionId);

  console.log(`[WS] Client connected wsSessionId=${wsSessionId} (${sessions.size} total)`);
  ws.send(JSON.stringify({ type: 'status', status: 'ready' }));

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'message' && msg.content) {
        const content = msg.content.trim();
        await saveMessage('user', content, 'web', wsSessionId);
        sendToClaude(content, wsSessionId, 'web').catch(err => {
          console.error('[WS] Claude error:', err.message);
        });
      }

      if (msg.type === 'file' && msg.path) {
        const text = `Analyze this file: ${msg.path}`;
        await saveMessage('user', text, 'web', wsSessionId);
        sendToClaude(text, wsSessionId, 'web').catch(err => {
          console.error('[WS] Claude error:', err.message);
        });
      }
    } catch (err) {
      console.error('[WS] Error:', err.message);
    }
  });

  ws.on('close', () => {
    sessions.delete(wsSessionId);
    tokenToSessionId.delete(token);

    // Clean up session upload dir
    try {
      fs.rmSync(sessionUploadDir, { recursive: true, force: true });
    } catch {}

    console.log(`[WS] Client disconnected wsSessionId=${wsSessionId} (${sessions.size} total)`);
  });
});

// --- Cleanup stale sessions every 10 minutes ---
setInterval(() => {
  let cleaned = 0;
  sessions.forEach((sess, id) => {
    if (!sess.ws || sess.ws.readyState !== 1) {
      if (sess.uploadDir) {
        try { fs.rmSync(sess.uploadDir, { recursive: true, force: true }); } catch {}
      }
      if (sess.token) tokenToSessionId.delete(sess.token);
      sessions.delete(id);
      cleaned++;
    }
  });
  if (cleaned > 0) console.log(`[Cleanup] Removed ${cleaned} stale session(s)`);
}, 10 * 60 * 1000);

// --- Start ---
(async () => {
  try {
    await redis.connect();
    console.log('[Redis] Connected');
  } catch (err) {
    console.error('[Redis] Connection failed:', err.message);
  }

  if (bot) {
    bot.start({
      onStart: () => console.log('[Telegram] Bot polling started'),
      allowed_updates: ['message'],
    }).catch(err => {
      console.error('[Telegram] Bot error:', err.message);
      setTimeout(() => {
        console.log('[Telegram] Retrying...');
        bot.start({ allowed_updates: ['message'] }).catch(e => {
          console.error('[Telegram] Retry failed:', e.message);
        });
      }, 15000);
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Claude Chat running on http://0.0.0.0:${PORT}`);
  });
})();

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach(sig => {
  process.on(sig, async () => {
    console.log('[Server] Shutting down...');
    if (bot) await bot.stop().catch(() => {});
    process.exit(0);
  });
});
