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
const HISTORY_KEY = 'claude-chat:history';
const SESSION_KEY = 'claude-chat:session';
const MAX_HISTORY = 200;

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Session ID for Claude Code - captured from first response, used to resume
let claudeSessionId = null;
let isProcessing = false;
let messageQueue = [];

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

// --- Multer ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf',
      'text/plain', 'text/csv', 'application/json', 'application/zip'];
    cb(null, allowed.includes(file.mimetype));
  }
});

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
  if (!auth || !verifyToken(auth.replace('Bearer ', ''))) {
    return res.status(401).json({ error: 'Nao autorizado' });
  }
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    res.json({ ok: true, path: req.file.path, name: req.file.originalname });
  });
});

app.get('/api/history', async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !verifyToken(auth.replace('Bearer ', ''))) {
    return res.status(401).json({ error: 'Nao autorizado' });
  }
  try {
    const raw = await redis.lRange(HISTORY_KEY, 0, MAX_HISTORY - 1);
    const messages = raw.map(r => JSON.parse(r));
    res.json({ ok: true, messages });
  } catch {
    res.json({ ok: true, messages: [] });
  }
});

// Reset session endpoint
app.post('/api/reset', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !verifyToken(auth.replace('Bearer ', ''))) {
    return res.status(401).json({ error: 'Nao autorizado' });
  }
  claudeSessionId = null;
  console.log('[Claude] Session reset - next message starts fresh');
  res.json({ ok: true, session: claudeSessionId });
});

// --- Redis helper ---
async function saveMessage(role, content, source = 'web') {
  const msg = { role, content, source, ts: Date.now() };
  try {
    await redis.rPush(HISTORY_KEY, JSON.stringify(msg));
    await redis.lTrim(HISTORY_KEY, -MAX_HISTORY, -1);
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

// --- WebSocket clients ---
const wsClients = new Set();

function broadcastWeb(msg) {
  const payload = JSON.stringify(msg);
  wsClients.forEach(ws => {
    if (ws.readyState === 1) ws.send(payload);
  });
}

// --- Claude Code integration via -p mode ---
function sendToClaude(text, source = 'web') {
  return new Promise((resolve, reject) => {
    if (isProcessing) {
      messageQueue.push({ text, source, resolve, reject });
      return;
    }

    isProcessing = true;
    let fullResponse = '';
    let buffer = '';

    broadcastWeb({ type: 'typing', active: true, source });

    console.log(`[Claude] Processing (${source}): ${text.substring(0, 80)}...`);

    // Build args: first message creates session, subsequent messages resume it
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (claudeSessionId) {
      args.push('--resume', claudeSessionId);
    }

    console.log(`[Claude] Session: ${claudeSessionId || 'new'}`);
    const proc = spawn('claude', args, {
      cwd: '/root',
      env: { ...process.env, HOME: '/root' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Send the message
    proc.stdin.write(text);
    proc.stdin.end();

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();

      // Process complete JSON lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          // Capture session_id from init or assistant events
          if (event.session_id && !claudeSessionId) {
            claudeSessionId = event.session_id;
            console.log(`[Claude] Got session: ${claudeSessionId}`);
          }

          if (event.type === 'assistant' && event.message) {
            // Extract text from message content
            const texts = (event.message.content || [])
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('');
            if (texts && texts !== fullResponse) {
              // Send only the new part
              const newPart = texts.substring(fullResponse.length);
              if (newPart) {
                fullResponse = texts;
                broadcastWeb({ type: 'stream', content: newPart });
              }
            }
          } else if (event.type === 'result') {
            // Capture session_id for resuming subsequent messages
            if (event.session_id) {
              claudeSessionId = event.session_id;
              console.log(`[Claude] Captured session: ${claudeSessionId}`);
            }
            if (event.result && event.result !== fullResponse) {
              const newPart = event.result.substring(fullResponse.length);
              if (newPart) {
                fullResponse = event.result;
                broadcastWeb({ type: 'stream', content: newPart });
              }
            }
          }
        } catch {
          // Skip non-JSON lines
        }
      }
    });

    let stderrBuf = '';
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });

    proc.on('close', (code) => {
      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === 'result' && event.result && !fullResponse) {
            fullResponse = event.result;
            broadcastWeb({ type: 'stream', content: event.result });
          }
        } catch {}
      }

      if (!fullResponse && stderrBuf) {
        console.error('[Claude] stderr:', stderrBuf.substring(0, 500));
      }

      if (!fullResponse) {
        fullResponse = 'Desculpe, nao consegui processar. Tente novamente.';
        broadcastWeb({ type: 'stream', content: fullResponse });
      }

      broadcastWeb({ type: 'response_end' });

      // Save response
      saveMessage('assistant', fullResponse, 'claude');

      // Mirror to Telegram
      if (bot && TELEGRAM_CHAT_ID) {
        const telegramText = fullResponse.substring(0, 4000);
        if (telegramText.length > 0) {
          const label = source === 'web' ? '[Web] ' : '';
          bot.api.sendMessage(TELEGRAM_CHAT_ID, label + telegramText).catch(err => {
            console.error('[Telegram] Send error:', err.message);
          });
        }
      }

      console.log(`[Claude] Done (${code}): ${fullResponse.substring(0, 80)}...`);
      isProcessing = false;
      resolve(fullResponse);

      // Process next in queue
      if (messageQueue.length > 0) {
        const next = messageQueue.shift();
        sendToClaude(next.text, next.source).then(next.resolve).catch(next.reject);
      }
    });

    proc.on('error', (err) => {
      console.error('[Claude] Spawn error:', err.message);
      isProcessing = false;
      broadcastWeb({ type: 'response_end' });
      reject(err);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      if (isProcessing) {
        try { proc.kill(); } catch {}
        isProcessing = false;
        broadcastWeb({ type: 'response_end' });
      }
    }, 300000);
  });
}

// --- Telegram message handler ---
if (bot) {
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const userName = ctx.from.first_name || 'User';

    console.log(`[Telegram] ${userName}: ${text}`);
    await saveMessage('user', text, 'telegram');
    broadcastWeb({ type: 'telegram_message', content: text, user: userName });

    sendToClaude(text, 'telegram').catch(err => {
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

      await saveMessage('user', `[Foto] ${caption}`, 'telegram');
      broadcastWeb({ type: 'telegram_message', content: `[Foto] ${caption}`, user: ctx.from.first_name });
      sendToClaude(`Read the image at ${filePath} and: ${caption}`, 'telegram');
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

      await saveMessage('user', `[${doc.file_name}] ${caption}`, 'telegram');
      broadcastWeb({ type: 'telegram_message', content: `[${doc.file_name}] ${caption}`, user: ctx.from.first_name });
      sendToClaude(`Analyze the file at ${filePath}: ${caption}`, 'telegram');
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

  wsClients.add(ws);
  console.log(`[WS] Client connected (${wsClients.size} total)`);

  ws.send(JSON.stringify({ type: 'status', status: 'ready' }));

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'message' && msg.content) {
        const content = msg.content.trim();
        await saveMessage('user', content, 'web');
        sendToClaude(content, 'web').catch(err => {
          console.error('[WS] Claude error:', err.message);
        });
      }

      if (msg.type === 'file' && msg.path) {
        const text = `Analyze this file: ${msg.path}`;
        await saveMessage('user', text, 'web');
        sendToClaude(text, 'web').catch(err => {
          console.error('[WS] Claude error:', err.message);
        });
      }
    } catch (err) {
      console.error('[WS] Error:', err.message);
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[WS] Client disconnected (${wsClients.size} total)`);
  });
});

// --- Start ---
(async () => {
  try {
    await redis.connect();
    console.log('[Redis] Connected');
  } catch (err) {
    console.error('[Redis] Connection failed:', err.message);
  }

  // Start Telegram bot
  if (bot) {
    bot.start({
      onStart: () => console.log('[Telegram] Bot polling started'),
      allowed_updates: ['message'],
    }).catch(err => {
      console.error('[Telegram] Bot error:', err.message);
      // Retry with delay
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
    console.log(`[Server] Session: ${claudeSessionId}`);
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
