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
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('[FATAL] JWT_SECRET not set in .env'); process.exit(1); }
const LOGIN_USER = process.env.LOGIN_USER || 'admin';
const LOGIN_PASS = process.env.LOGIN_PASS || 'admin';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7579372831';
const SESSION_KEY = 'claude-chat:session';
const MAX_HISTORY = 200;
const MAX_CONCURRENT_SESSIONS = 5;
const SKILLS_DIR = path.join(process.env.HOME || '/root', '.claude', 'skills');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- Skills loader ---
function loadSkills() {
  const skills = [];
  if (!fs.existsSync(SKILLS_DIR)) return skills;
  const dirs = fs.readdirSync(SKILLS_DIR).filter(d => {
    try { return fs.statSync(path.join(SKILLS_DIR, d)).isDirectory(); } catch { return false; }
  });
  for (const dir of dirs) {
    const skillFile = path.join(SKILLS_DIR, dir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const content = fs.readFileSync(skillFile, 'utf8');
    // Extract name and description from frontmatter
    const nameMatch = content.match(/^name:\s*["']?(.+?)["']?\s*$/m);
    const descMatch = content.match(/^description:\s*["']?([\s\S]+?)["']?\s*$/m);
    const name = nameMatch ? nameMatch[1].trim() : dir;
    const description = descMatch ? descMatch[1].trim().substring(0, 200) : '';
    skills.push({ id: dir, name, description, content });
  }
  return skills;
}

// Skills cache (reload every 5 minutes)
let _skillsCache = null;
let _skillsCacheTs = 0;
function getSkills() {
  const now = Date.now();
  if (!_skillsCache || now - _skillsCacheTs > 300000) {
    _skillsCache = loadSkills();
    _skillsCacheTs = now;
  }
  return _skillsCache;
}

// --- Session maps ---
// wsSessionId -> { claudeSessionId, isProcessing, queue, ws, uploadDir, token, proc }
const sessions = new Map();

// token -> wsSessionId (for HTTP endpoint lookups)
const tokenToSessionId = new Map();

// Telegram has its own persistent session
const telegramSession = { claudeSessionId: null, isProcessing: false, queue: [], proc: null, activeSkill: null };

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
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json());

// Rate limiting
const loginAttempts = new Map();
function rateLimit(key, maxAttempts = 5, windowMs = 300000) {
  const now = Date.now();
  const record = loginAttempts.get(key) || { count: 0, firstAttempt: now };
  if (now - record.firstAttempt > windowMs) { record.count = 0; record.firstAttempt = now; }
  record.count++;
  loginAttempts.set(key, record);
  return record.count <= maxAttempts;
}
// Clean up rate limit map every 10 minutes
setInterval(() => { const now = Date.now(); loginAttempts.forEach((v, k) => { if (now - v.firstAttempt > 300000) loginAttempts.delete(k); }); }, 600000);

app.use(express.static(path.join(__dirname, 'public')));

// --- Auth ---
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// --- Helper: get token from request ---
function getToken(req) {
  const auth = req.headers.authorization;
  return auth ? auth.replace('Bearer ', '') : (req.query.token || null);
}

// --- Routes ---
app.post('/api/login', (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  if (!rateLimit(clientIp)) {
    return res.status(429).json({ ok: false, error: 'Muitas tentativas. Aguarde 5 minutos.' });
  }
  const { username, password } = req.body;
  if (username === LOGIN_USER && password === LOGIN_PASS) {
    const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: '30d' });
    redis.set(SESSION_KEY, token, { EX: 30 * 24 * 3600 }).catch(() => {});
    return res.json({ ok: true, token });
  }
  res.status(401).json({ ok: false, error: 'Credenciais invalidas' });
});

app.post('/api/upload', (req, res) => {
  const token = getToken(req);
  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: 'Nao autorizado' });
  }

  const wsSessionId = tokenToSessionId.get(token);
  const sessionUploadDir = wsSessionId ? path.join(UPLOAD_DIR, wsSessionId) : UPLOAD_DIR;
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
  const token = getToken(req);
  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: 'Nao autorizado' });
  }
  try {
    const wsSessionId = tokenToSessionId.get(token);
    const historyKey = wsSessionId ? `claude-chat:history:${wsSessionId}` : 'claude-chat:history';
    const raw = await redis.lRange(historyKey, -50, -1);
    const messages = raw.map(r => JSON.parse(r));
    res.json({ ok: true, messages });
  } catch {
    res.json({ ok: true, messages: [] });
  }
});

// Reset session
app.post('/api/reset', (req, res) => {
  const token = getToken(req);
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

// Cancel current response (Melhoria 2)
app.post('/api/cancel', (req, res) => {
  const token = getToken(req);
  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: 'Nao autorizado' });
  }
  const wsSessionId = tokenToSessionId.get(token);
  if (wsSessionId && sessions.has(wsSessionId)) {
    const sessCtx = sessions.get(wsSessionId);
    if (sessCtx.proc) {
      try { sessCtx.proc.kill(); } catch {}
      sessCtx.proc = null;
    }
    sessCtx.isProcessing = false;
    sessCtx.queue = [];
    if (sessCtx.ws && sessCtx.ws.readyState === 1) {
      sessCtx.ws.send(JSON.stringify({ type: 'cancelled' }));
    }
  }
  res.json({ ok: true });
});

// Download generated file (Melhoria 4)
app.get('/api/download/:filename', (req, res) => {
  const token = getToken(req);
  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: 'Nao autorizado' });
  }
  const filename = path.basename(req.params.filename);
  // Search in UPLOAD_DIR and 2 levels deep
  const searchDirs = [UPLOAD_DIR];
  try {
    fs.readdirSync(UPLOAD_DIR).forEach(entry => {
      const full = path.join(UPLOAD_DIR, entry);
      if (fs.statSync(full).isDirectory()) searchDirs.push(full);
    });
  } catch {}

  for (const dir of searchDirs) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) {
      return res.download(candidate, filename);
    }
  }

  res.status(404).json({ error: 'Arquivo nao encontrado' });
});

// Status endpoint (Melhoria 8)
app.get('/api/status', (req, res) => {
  res.json({ sessions: sessions.size, max: MAX_CONCURRENT_SESSIONS, ok: true });
});

// Skills endpoints
app.get('/api/skills', (req, res) => {
  const token = getToken(req);
  if (!token || !verifyToken(token)) return res.status(401).json({ error: 'Nao autorizado' });
  const skills = getSkills().map(s => ({ id: s.id, name: s.name, description: s.description }));
  res.json({ ok: true, skills });
});

app.post('/api/skills/activate', (req, res) => {
  const token = getToken(req);
  if (!token || !verifyToken(token)) return res.status(401).json({ error: 'Nao autorizado' });
  const { skillId } = req.body;
  const wsSessionId = tokenToSessionId.get(token);
  if (!wsSessionId || !sessions.has(wsSessionId)) return res.status(400).json({ error: 'Sessao nao encontrada' });

  const sess = sessions.get(wsSessionId);
  if (!skillId) {
    sess.activeSkill = null;
    console.log(`[Skills] Deactivated for wsSessionId=${wsSessionId}`);
    return res.json({ ok: true, active: null });
  }

  const all = getSkills();
  const skill = all.find(s => s.id === skillId);
  if (!skill) return res.status(404).json({ error: 'Skill nao encontrada' });

  sess.activeSkill = skill;
  console.log(`[Skills] Activated: ${skill.name} for wsSessionId=${wsSessionId}`);
  res.json({ ok: true, active: { id: skill.id, name: skill.name } });
});

// Saved sessions endpoints (Melhoria 5)
app.post('/api/sessions/save', async (req, res) => {
  const token = getToken(req);
  const decoded = token ? verifyToken(token) : null;
  if (!decoded) return res.status(401).json({ error: 'Nao autorizado' });

  const { name } = req.body;
  const wsSessionId = tokenToSessionId.get(token);
  if (!wsSessionId || !sessions.has(wsSessionId)) {
    return res.status(400).json({ error: 'Sessao nao encontrada' });
  }
  const sessCtx = sessions.get(wsSessionId);
  const redisKey = `claude-chat:saved-sessions:${decoded.user}`;

  try {
    const raw = await redis.get(redisKey);
    const saved = raw ? JSON.parse(raw) : [];
    saved.unshift({
      id: wsSessionId,
      name: name || `Sessao ${new Date().toLocaleDateString('pt-BR')}`,
      claudeSessionId: sessCtx.claudeSessionId,
      ts: Date.now()
    });
    if (saved.length > 10) saved.length = 10;
    await redis.set(redisKey, JSON.stringify(saved), { EX: 90 * 24 * 3600 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions', async (req, res) => {
  const token = getToken(req);
  const decoded = token ? verifyToken(token) : null;
  if (!decoded) return res.status(401).json({ error: 'Nao autorizado' });

  try {
    const raw = await redis.get(`claude-chat:saved-sessions:${decoded.user}`);
    res.json({ ok: true, sessions: raw ? JSON.parse(raw) : [] });
  } catch {
    res.json({ ok: true, sessions: [] });
  }
});

app.post('/api/sessions/load', async (req, res) => {
  const token = getToken(req);
  const decoded = token ? verifyToken(token) : null;
  if (!decoded) return res.status(401).json({ error: 'Nao autorizado' });

  const { sessionId } = req.body;
  const wsSessionId = tokenToSessionId.get(token);
  if (!wsSessionId || !sessions.has(wsSessionId)) {
    return res.status(400).json({ error: 'Sessao ativa nao encontrada' });
  }

  try {
    const raw = await redis.get(`claude-chat:saved-sessions:${decoded.user}`);
    const saved = raw ? JSON.parse(raw) : [];
    const target = saved.find(s => s.id === sessionId);
    if (!target) return res.status(404).json({ error: 'Sessao salva nao encontrada' });

    // Resume that Claude session context
    sessions.get(wsSessionId).claudeSessionId = target.claudeSessionId;
    console.log(`[Claude] Loaded saved session ${sessionId} -> claudeSessionId=${target.claudeSessionId}`);
    res.json({ ok: true, name: target.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Redis helper ---
async function saveMessage(role, content, source = 'web', wsSessionId = null) {
  const msg = { role, content, source, ts: Date.now() };
  const historyKey = wsSessionId ? `claude-chat:history:${wsSessionId}` : 'claude-chat:history';
  try {
    await redis.rPush(historyKey, JSON.stringify(msg));
    await redis.lTrim(historyKey, -MAX_HISTORY, -1);
    await redis.expire(historyKey, 30 * 24 * 3600);
  } catch {}
  return msg;
}

// --- File path detection regex (Melhoria 4) ---
const FILE_PATH_RE = /(?:criado|salvo|saved|created|arquivo|file)[:\s]+([\/\w\-\.]+\.(xlsx|xls|html|json|csv|txt|pdf|zip|png|jpg|jpeg))/gi;

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
  const isTelegram = wsSessionId === 'telegram';
  const sessCtx = isTelegram ? telegramSession : sessions.get(wsSessionId);

  if (!sessCtx) {
    console.error(`[Claude] No session context for wsSessionId=${wsSessionId}`);
    return Promise.reject(new Error('Session not found'));
  }

  return new Promise((resolve, reject) => {
    if (sessCtx.isProcessing) {
      const position = sessCtx.queue.length + 1;
      sessCtx.queue.push({ text, resolve, reject });
      // Notify client of queue position
      if (!isTelegram && sessCtx.ws && sessCtx.ws.readyState === 1) {
        sessCtx.ws.send(JSON.stringify({ type: 'queued', position }));
      }
      return;
    }

    sessCtx.isProcessing = true;
    let fullResponse = '';
    let buffer = '';

    const sendToSession = (msg) => {
      if (isTelegram) {
        broadcastWeb(msg);
      } else if (sessCtx.ws && sessCtx.ws.readyState === 1) {
        sessCtx.ws.send(JSON.stringify(msg));
      }
    };

    sendToSession({ type: 'typing', active: true, source });
    console.log(`[Claude] Processing wsSessionId=${wsSessionId} (${source}): ${text.substring(0, 80)}...`);

    // Prepend active skill context if set
    let fullText = text;
    if (sessCtx.activeSkill) {
      fullText = `[SKILL CONTEXT - follow these instructions for this response]\n\n${sessCtx.activeSkill.content}\n\n[END SKILL CONTEXT]\n\nUser request: ${text}`;
      console.log(`[Skills] Injecting skill: ${sessCtx.activeSkill.name}`);
    }

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

    // Store proc reference for cancel support (Melhoria 2)
    sessCtx.proc = proc;

    proc.stdin.write(fullText);
    proc.stdin.end();

    // Watchdog: kill if no output for 60s (Melhoria 7)
    let lastActivityAt = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivityAt > 60000 && sessCtx.isProcessing) {
        console.warn(`[Claude] Watchdog: no output for 60s on wsSessionId=${wsSessionId}, killing...`);
        try { proc.kill(); } catch {}
        clearInterval(watchdog);
        sendToSession({ type: 'watchdog_restart' });
      }
    }, 15000);

    proc.stdout.on('data', (chunk) => {
      lastActivityAt = Date.now(); // reset watchdog timer
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
            // Send token usage (Melhoria 6)
            if (event.usage) {
              const inputTokens = event.usage.input_tokens || 0;
              const outputTokens = event.usage.output_tokens || 0;
              const inputCost = (inputTokens / 1000000) * 3.0;
              const outputCost = (outputTokens / 1000000) * 15.0;
              const totalCost = inputCost + outputCost;
              sendToSession({
                type: 'usage',
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cost_usd: totalCost.toFixed(6)
              });
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
      clearInterval(watchdog);
      sessCtx.proc = null;

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

      // Detect file paths in response (Melhoria 4)
      FILE_PATH_RE.lastIndex = 0;
      let match;
      while ((match = FILE_PATH_RE.exec(fullResponse)) !== null) {
        const filePath = match[1];
        if (fs.existsSync(filePath)) {
          sendToSession({ type: 'file_created', filename: path.basename(filePath), path: filePath });
        }
      }

      // Save response
      saveMessage('assistant', fullResponse, 'claude', isTelegram ? null : wsSessionId);

      // Mirror to Telegram (only if from web)
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
        // Notify client that queued message is now starting
        if (!isTelegram && sessCtx.ws && sessCtx.ws.readyState === 1) {
          sessCtx.ws.send(JSON.stringify({ type: 'queue_start' }));
        }
        sendToClaude(next.text, wsSessionId, source).then(next.resolve).catch(next.reject);
      }
    });

    proc.on('error', (err) => {
      clearInterval(watchdog);
      sessCtx.proc = null;
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
        sessCtx.proc = null;
        sendToSession({ type: 'response_end' });
      }
    }, 600000);

    proc.on('close', () => clearTimeout(timeoutId));
  });
}

// --- Telegram message handler ---
if (bot) {
  bot.on('message:text', async (ctx) => {
    if (TELEGRAM_CHAT_ID && ctx.from.id.toString() !== TELEGRAM_CHAT_ID) return;
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
    if (TELEGRAM_CHAT_ID && ctx.from.id.toString() !== TELEGRAM_CHAT_ID) return;
    const caption = ctx.message.caption || 'Analise esta imagem';
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    try {
      const file = await ctx.api.getFile(photo.file_id);
      const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
      const res = await fetch(url);
      const arrayBuf = Buffer.from(await res.arrayBuffer());
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
    if (TELEGRAM_CHAT_ID && ctx.from.id.toString() !== TELEGRAM_CHAT_ID) return;
    const doc = ctx.message.document;
    const caption = ctx.message.caption || `Analise o arquivo ${doc.file_name}`;
    try {
      const file = await ctx.api.getFile(doc.file_id);
      const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
      const res = await fetch(url);
      const arrayBuf = Buffer.from(await res.arrayBuffer());
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

  // Melhoria 8: limit concurrent sessions
  if (sessions.size >= MAX_CONCURRENT_SESSIONS) {
    ws.send(JSON.stringify({
      type: 'error',
      code: 'max_sessions',
      message: 'Limite de sessoes ativas atingido. Feche uma aba e tente novamente.'
    }));
    ws.close(4002, 'Max sessions');
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
    token,
    proc: null,
    activeSkill: null
  });

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
    try { fs.rmSync(sessionUploadDir, { recursive: true, force: true }); } catch {}
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
