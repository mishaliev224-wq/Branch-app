import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, extname } from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import nodemailer from 'nodemailer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JWT_SECRET = 'branch-app-secret-2026';

// ── Persistent data directory (survives redeploys) ──
const DATA_DIR = process.env.DATA_DIR || __dirname;
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = join(DATA_DIR, 'db.json');
const DB_BACKUP_PATH = join(DATA_DIR, 'db.backup.json');

// ── Email transporter (dev mode: codes returned in response; production: set SMTP_* env vars) ──
let mailTransporter = null;
const DEV_MODE = !process.env.SMTP_HOST;
if (process.env.SMTP_HOST) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  console.log('📧 SMTP configured:', process.env.SMTP_HOST);
} else {
  console.log('📧 Dev mode: verification codes will be returned in API response');
}

// In-memory stores for verification codes
const verificationCodes = new Map(); // email -> { code, expiresAt, username, password }
const resetCodes = new Map(); // email -> { code, expiresAt }
const captchas = new Map(); // captchaId -> { answer, expiresAt }

function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function genCaptchaId() { return 'cap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

async function sendEmail(to, subject, html) {
  if (mailTransporter) {
    const info = await mailTransporter.sendMail({ from: '"Буст" <noreply@boost.app>', to, subject, html });
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) console.log('📧 Preview:', previewUrl);
    return true;
  }
  return false;
}

// ── Database ──
let _lastBackupTime = 0;
const BACKUP_INTERVAL = 60_000; // backup at most once per minute

function saveDB(data) {
  const json = JSON.stringify(data || db, null, 2);
  writeFileSync(DB_PATH, json);

  // Periodic backup to protect against corruption
  const now = Date.now();
  if (now - _lastBackupTime > BACKUP_INTERVAL) {
    _lastBackupTime = now;
    writeFileSync(DB_BACKUP_PATH, json);
  }
}

function loadDB() {
  // Try main db file
  if (existsSync(DB_PATH)) {
    try {
      const data = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
      if (data && data.users) {
        console.log(`✅ Database loaded: ${data.users.length} users, ${data.servers.length} servers`);
        return data;
      }
    } catch (e) {
      console.error('⚠️ Failed to read db.json:', e.message);
    }
  }
  // Try backup
  if (existsSync(DB_BACKUP_PATH)) {
    try {
      const data = JSON.parse(readFileSync(DB_BACKUP_PATH, 'utf-8'));
      if (data && data.users) {
        console.log(`🔄 Restored from backup: ${data.users.length} users, ${data.servers.length} servers`);
        writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        return data;
      }
    } catch (e) {
      console.error('⚠️ Failed to read backup:', e.message);
    }
  }
  console.log('🆕 No existing data found, initializing fresh database');
  return initDB();
}

function initDB() {
  const now = new Date().toISOString();
  const db = {
    users: [],
    servers: [
      { id: 's1', name: 'Буст HQ', iconText: 'BH', ownerId: 'system', createdAt: now },
      { id: 's2', name: 'Gaming Zone', iconText: 'GZ', ownerId: 'system', createdAt: now },
      { id: 's3', name: 'Music Lounge', iconText: 'ML', ownerId: 'system', createdAt: now },
    ],
    channels: [
      { id: 'c1', serverId: 's1', name: 'general', createdAt: now },
      { id: 'c2', serverId: 's1', name: 'announcements', createdAt: now },
      { id: 'c3', serverId: 's1', name: 'off-topic', createdAt: now },
      { id: 'c4', serverId: 's2', name: 'general', createdAt: now },
      { id: 'c5', serverId: 's2', name: 'fps-games', createdAt: now },
      { id: 'c6', serverId: 's2', name: 'mmorpg', createdAt: now },
      { id: 'c7', serverId: 's3', name: 'general', createdAt: now },
      { id: 'c8', serverId: 's3', name: 'playlists', createdAt: now },
    ],
    members: [],
    messages: [],
    nextId: 100,
  };
  saveDB(db);
  return db;
}

let db = loadDB();
if (!db.friendRequests) { db.friendRequests = []; saveDB(); }
if (!db.dmChannels) { db.dmChannels = []; saveDB(); }
if (!db.dmMessages) { db.dmMessages = []; saveDB(); }

// ── Premium: migrate existing data ──
let premiumDirty = false;
db.users.forEach(u => {
  if (u.premium === undefined) { u.premium = null; premiumDirty = true; }
  if (u.premiumExpiry === undefined) { u.premiumExpiry = null; premiumDirty = true; }
  if (u.boostCredits === undefined) { u.boostCredits = 0; premiumDirty = true; }
  if (u.boostedServers === undefined) { u.boostedServers = []; premiumDirty = true; }
  if (u.statusEmoji === undefined) { u.statusEmoji = null; premiumDirty = true; }
  if (u.avatarFrame === undefined) { u.avatarFrame = null; premiumDirty = true; }
});
db.servers.forEach(s => {
  if (s.boostCount === undefined) { s.boostCount = 0; premiumDirty = true; }
  if (s.boostLevel === undefined) { s.boostLevel = 0; premiumDirty = true; }
  if (s.customEmojis === undefined) { s.customEmojis = []; premiumDirty = true; }
});
if (premiumDirty) saveDB();

// Helper: recalculate server boost level
function recalcBoostLevel(server) {
  const count = server.boostCount || 0;
  if (count >= 30) server.boostLevel = 3;
  else if (count >= 15) server.boostLevel = 2;
  else if (count >= 5) server.boostLevel = 1;
  else server.boostLevel = 0;
}

// Helper: get boost credits by tier
const PREMIUM_PLANS = {
  standard: { boostCredits: 2, price: 99, label: 'Стандарт' },
  pro:      { boostCredits: 8, price: 249, label: 'Про' },
};

// Helper: check if premium is active
function isPremiumActive(user) {
  if (!user.premium || !user.premiumExpiry) return false;
  return new Date(user.premiumExpiry) > new Date();
}

function genId() {
  db.nextId++;
  saveDB();
  return String(db.nextId);
}

// Check if a member has a specific permission (admin perms or custom role perms)
function memberHasPerm(server, member, perm) {
  if (!server || !member) return false;
  if (server.ownerId === member.userId) return true;
  if (member.role === 'admin' && server.adminPermissions?.[perm]) return true;
  // Check custom role permissions
  const customRole = (server.customRoles || []).find(r => r.id === member.role);
  if (customRole && customRole.permissions?.[perm]) return true;
  return false;
}

// ── Express ──
const app = express();
const httpServer = createServer(app);
app.use(express.json());

// ── File uploads (persistent in production) ──
const uploadsDir = join(DATA_DIR, 'uploads');
mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Serve public assets (sounds, etc.)
app.use(express.static(join(__dirname, 'public')));

// Serve built frontend in production
const distDir = join(__dirname, 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir, { setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }}));
}

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    cb(null, unique + extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Auth middleware
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET);
    const user = db.users.find(u => u.id === decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── File upload route ──
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const sendAs = req.body.sendAs || 'file';
  const mime = req.file.mimetype;
  let fileType = 'file';
  if (mime.startsWith('image/') && sendAs === 'photo') fileType = 'image';
  else if (mime.startsWith('audio/')) fileType = 'audio';
  else if (mime.startsWith('video/')) fileType = 'video';
  res.json({
    url: '/uploads/' + req.file.filename,
    fileName: req.file.originalname,
    fileSize: req.file.size,
    mimeType: mime,
    fileType,
  });
});

// Avatar colors
const COLORS = ['#f04747','#faa61a','#43b581','#00d4aa','#7c5cfc','#ff6b9d','#3b82f6','#06b6d4','#ec4899','#f97316'];

function genTag() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// ── Captcha endpoint ──
app.get('/api/auth/captcha', (req, res) => {
  const a = Math.floor(1 + Math.random() * 20);
  const b = Math.floor(1 + Math.random() * 20);
  const ops = ['+', '-'];
  const op = ops[Math.floor(Math.random() * ops.length)];
  const answer = op === '+' ? a + b : a - b;
  const id = genCaptchaId();
  captchas.set(id, { answer, expiresAt: Date.now() + 5 * 60 * 1000 });
  // Cleanup old captchas
  for (const [k, v] of captchas) { if (v.expiresAt < Date.now()) captchas.delete(k); }
  res.json({ captchaId: id, question: `${a} ${op} ${b} = ?` });
});

// ── Auth Routes ──

// Step 1: Send verification code
app.post('/api/auth/register/send-code', async (req, res) => {
  const { username, email, password, captchaId, captchaAnswer } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (username.length < 2) return res.status(400).json({ error: 'Username too short (min 2)' });
  if (password.length < 6) return res.status(400).json({ error: 'Password too short (min 6)' });
  if (!/\S+@\S+\.\S+/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
  // Captcha check
  if (!captchaId || captchaAnswer === undefined) return res.status(400).json({ error: 'Captcha required' });
  const cap = captchas.get(captchaId);
  if (!cap || cap.expiresAt < Date.now()) return res.status(400).json({ error: 'Captcha expired, refresh' });
  if (Number(captchaAnswer) !== cap.answer) return res.status(400).json({ error: 'Wrong captcha answer' });
  captchas.delete(captchaId);

  if (db.users.find(u => u.email === email)) return res.status(400).json({ error: 'Email already registered' });
  if (db.users.find(u => u.username === username)) return res.status(400).json({ error: 'Username taken' });

  const code = genCode();
  verificationCodes.set(email, { code, expiresAt: Date.now() + 10 * 60 * 1000, username, password });
  const sent = await sendEmail(email, 'Буст — Код подтверждения', `<h2>Your verification code</h2><p style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#7c5cfc">${code}</p><p>Valid for 10 minutes.</p>`);
  console.log(`📧 Verification code for ${email}: ${code}`);
  const response = { ok: true, message: sent ? 'Code sent to email' : 'Check code below' };
  if (DEV_MODE) response.code = code;
  res.json(response);
});

// Step 2: Verify code and complete registration
app.post('/api/auth/register/verify', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code required' });
  const entry = verificationCodes.get(email);
  if (!entry) return res.status(400).json({ error: 'No pending verification for this email' });
  if (entry.expiresAt < Date.now()) { verificationCodes.delete(email); return res.status(400).json({ error: 'Code expired, register again' }); }
  if (entry.code !== code) return res.status(400).json({ error: 'Wrong code' });

  verificationCodes.delete(email);
  // Check again in case someone registered while verifying
  if (db.users.find(u => u.email === email)) return res.status(400).json({ error: 'Email already registered' });
  if (db.users.find(u => u.username === entry.username)) return res.status(400).json({ error: 'Username taken' });

  const id = genId();
  const passwordHash = await bcrypt.hash(entry.password, 10);
  const avatarColor = COLORS[Math.floor(Math.random() * COLORS.length)];
  const tag = genTag();
  const user = { id, username: entry.username, email, passwordHash, avatarColor, tag, status: 'online', bio: '', createdAt: new Date().toISOString(), verified: true, agreedToTerms: true, agreedAt: new Date().toISOString() };
  db.users.push(user);
  // Auto-join official server(s)
  const officialServerId = 's1';
  const officialServer = db.servers.find(s => s.id === officialServerId);
  if (officialServer && !db.members.find(m => m.serverId === officialServerId && m.userId === id)) {
    db.members.push({ serverId: officialServerId, userId: id, role: 'user', joinedAt: new Date().toISOString() });
  }
  saveDB();
  const token = jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id, username: entry.username, email, avatarColor, avatar: null, tag, status: 'online', bio: '', agreedToTerms: true } });
});

// Legacy register (fallback)
app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (username.length < 2) return res.status(400).json({ error: 'Username too short' });
  if (password.length < 6) return res.status(400).json({ error: 'Password too short (min 6)' });
  if (db.users.find(u => u.email === email)) return res.status(400).json({ error: 'Email already registered' });
  if (db.users.find(u => u.username === username)) return res.status(400).json({ error: 'Username taken' });
  const id = genId();
  const passwordHash = await bcrypt.hash(password, 10);
  const avatarColor = COLORS[Math.floor(Math.random() * COLORS.length)];
  const tag = genTag();
  const user = { id, username, email, passwordHash, avatarColor, tag, status: 'online', bio: '', createdAt: new Date().toISOString(), agreedToTerms: true, agreedAt: new Date().toISOString() };
  db.users.push(user);
  // Auto-join official server(s)
  const officialServerId = 's1';
  const officialServer = db.servers.find(s => s.id === officialServerId);
  if (officialServer && !db.members.find(m => m.serverId === officialServerId && m.userId === id)) {
    db.members.push({ serverId: officialServerId, userId: id, role: 'user', joinedAt: new Date().toISOString() });
  }
  saveDB();
  const token = jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id, username, email, avatarColor, avatar: null, tag, status: 'online', bio: '', agreedToTerms: true } });
});

// ── Password Reset ──
app.post('/api/auth/reset/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const user = db.users.find(u => u.email === email);
  if (!user) return res.status(400).json({ error: 'No account with this email' });
  const code = genCode();
  resetCodes.set(email, { code, expiresAt: Date.now() + 10 * 60 * 1000 });
  const sent = await sendEmail(email, 'Буст — Сброс пароля', `<h2>Password reset code</h2><p style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#7c5cfc">${code}</p><p>Valid for 10 minutes. If you didn't request this, ignore this email.</p>`)
  console.log(`📧 Reset code for ${email}: ${code}`);
  const response = { ok: true, message: sent ? 'Code sent to email' : 'Check code below' };
  if (DEV_MODE) response.code = code;
  res.json(response);
});

app.post('/api/auth/reset/verify', async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) return res.status(400).json({ error: 'All fields required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password too short (min 6)' });
  const entry = resetCodes.get(email);
  if (!entry) return res.status(400).json({ error: 'No pending reset for this email' });
  if (entry.expiresAt < Date.now()) { resetCodes.delete(email); return res.status(400).json({ error: 'Code expired' }); }
  if (entry.code !== code) return res.status(400).json({ error: 'Wrong code' });
  resetCodes.delete(email);
  const user = db.users.find(u => u.email === email);
  if (!user) return res.status(400).json({ error: 'User not found' });
  user.passwordHash = await bcrypt.hash(newPassword, 10);
  saveDB();
  res.json({ ok: true, message: 'Password updated' });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'All fields required' });
  const user = db.users.find(u => u.email === email);
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });
  if (user.deleted) return res.status(400).json({ error: 'Этот аккаунт был удалён' });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(400).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, email: user.email, avatarColor: user.avatarColor, avatar: user.avatar || null, tag: user.tag || genTag(), status: user.status || 'online', bio: user.bio || '', bannerColor: user.bannerColor || null, agreedToTerms: !!user.agreedToTerms, statusEmoji: user.statusEmoji || null, avatarFrame: user.avatarFrame || null } });
});

// ── Premium ──

app.get('/api/premium/plans', (req, res) => {
  res.json(PREMIUM_PLANS);
});

app.get('/api/premium/status', auth, (req, res) => {
  const u = req.user;
  const active = isPremiumActive(u);
  if (!active && u.premium) {
    // Expired: revoke boosts
    u.boostedServers.forEach(bs => {
      const srv = db.servers.find(s => s.id === bs.serverId);
      if (srv) { srv.boostCount = Math.max(0, (srv.boostCount || 0) - bs.amount); recalcBoostLevel(srv); }
    });
    u.boostedServers = [];
    u.premium = null;
    u.premiumExpiry = null;
    u.boostCredits = 0;
    saveDB();
  }
  res.json({
    premium: active ? u.premium : null,
    premiumExpiry: u.premiumExpiry,
    boostCredits: active ? u.boostCredits : 0,
    boostedServers: u.boostedServers || [],
    statusEmoji: u.statusEmoji || null,
    active,
  });
});

app.post('/api/premium/activate', auth, (req, res) => {
  const { tier } = req.body; // 'standard' | 'pro'
  const plan = PREMIUM_PLANS[tier];
  if (!plan) return res.status(400).json({ error: 'Invalid tier' });
  const u = req.user;
  const wasCredits = u.boostCredits || 0;
  const newCredits = plan.boostCredits;
  const diff = newCredits - wasCredits; // may be negative (downgrade)

  // If downgrade and over-allocated, pull back excess boosts
  if (diff < 0) {
    let toRemove = Math.abs(diff);
    const newBoosted = [];
    for (const bs of (u.boostedServers || [])) {
      if (toRemove <= 0) { newBoosted.push(bs); continue; }
      const remove = Math.min(bs.amount, toRemove);
      const srv = db.servers.find(s => s.id === bs.serverId);
      if (srv) { srv.boostCount = Math.max(0, (srv.boostCount || 0) - remove); recalcBoostLevel(srv); }
      toRemove -= remove;
      if (bs.amount - remove > 0) newBoosted.push({ ...bs, amount: bs.amount - remove });
    }
    u.boostedServers = newBoosted;
  }

  u.premium = tier;
  u.premiumExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
  u.boostCredits = newCredits;
  saveDB();
  res.json({ ok: true, premium: u.premium, premiumExpiry: u.premiumExpiry, boostCredits: u.boostCredits });
});

app.delete('/api/premium/cancel', auth, (req, res) => {
  const u = req.user;
  (u.boostedServers || []).forEach(bs => {
    const srv = db.servers.find(s => s.id === bs.serverId);
    if (srv) { srv.boostCount = Math.max(0, (srv.boostCount || 0) - bs.amount); recalcBoostLevel(srv); }
  });
  u.boostedServers = [];
  u.premium = null;
  u.premiumExpiry = null;
  u.boostCredits = 0;
  saveDB();
  res.json({ ok: true });
});

// ── Boosts ──

app.get('/api/boosts/my', auth, (req, res) => {
  const u = req.user;
  const used = (u.boostedServers || []).reduce((sum, b) => sum + b.amount, 0);
  res.json({
    total: u.boostCredits || 0,
    used,
    free: (u.boostCredits || 0) - used,
    boostedServers: u.boostedServers || [],
  });
});

app.post('/api/boosts/give', auth, (req, res) => {
  const { serverId, amount } = req.body;
  if (!serverId || !amount || amount < 1) return res.status(400).json({ error: 'Invalid params' });
  const u = req.user;
  if (!isPremiumActive(u)) return res.status(403).json({ error: 'Premium required' });
  const used = (u.boostedServers || []).reduce((sum, b) => sum + b.amount, 0);
  const free = (u.boostCredits || 0) - used;
  if (amount > free) return res.status(400).json({ error: 'Not enough boost credits' });
  const srv = db.servers.find(s => s.id === serverId);
  if (!srv) return res.status(404).json({ error: 'Server not found' });
  const existing = u.boostedServers.find(b => b.serverId === serverId);
  if (existing) existing.amount += amount;
  else u.boostedServers.push({ serverId, amount });
  srv.boostCount = (srv.boostCount || 0) + amount;
  recalcBoostLevel(srv);
  saveDB();
  io.emit('server-boost-updated', { serverId, boostCount: srv.boostCount, boostLevel: srv.boostLevel });
  res.json({ ok: true, boostCount: srv.boostCount, boostLevel: srv.boostLevel });
});

app.post('/api/boosts/remove', auth, (req, res) => {
  const { serverId, amount } = req.body;
  if (!serverId || !amount || amount < 1) return res.status(400).json({ error: 'Invalid params' });
  const u = req.user;
  const existing = (u.boostedServers || []).find(b => b.serverId === serverId);
  if (!existing || existing.amount < amount) return res.status(400).json({ error: 'Not enough boosts on this server' });
  const srv = db.servers.find(s => s.id === serverId);
  if (srv) { srv.boostCount = Math.max(0, (srv.boostCount || 0) - amount); recalcBoostLevel(srv); }
  existing.amount -= amount;
  if (existing.amount <= 0) u.boostedServers = u.boostedServers.filter(b => b.serverId !== serverId);
  saveDB();
  if (srv) io.emit('server-boost-updated', { serverId, boostCount: srv.boostCount, boostLevel: srv.boostLevel });
  res.json({ ok: true });
});

// Status emoji
app.patch('/api/premium/status-emoji', auth, (req, res) => {
  const { emoji } = req.body;
  if (!isPremiumActive(req.user)) return res.status(403).json({ error: 'Premium required' });
  req.user.statusEmoji = emoji || null;
  saveDB();
  res.json({ ok: true, statusEmoji: req.user.statusEmoji });
});

// ── Auto-translate ──
app.post('/api/translate', async (req, res) => {
  const { texts, to, from = 'ru' } = req.body
  if (!Array.isArray(texts) || !to) return res.status(400).json({ error: 'Missing params' })
  const BATCH = 40
  const results = []
  try {
    for (let i = 0; i < texts.length; i += BATCH) {
      const chunk = texts.slice(i, i + BATCH)
      const body = chunk.map(t => `q=${encodeURIComponent(t)}`).join('&')
      const url = `https://translate.googleapis.com/translate_a/t?client=gtx&sl=${from}&tl=${to}&${body}`
      const data = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json())
      const translated = Array.isArray(data) ? data.map(item => Array.isArray(item) ? item[0] : item) : chunk
      results.push(...translated)
    }
    res.json({ translations: results })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/auth/me', auth, (req, res) => {
  const u = req.user;
  const { id, username, email, avatarColor, avatar, tag, status, bio, bannerColor, agreedToTerms } = u;
  if (!u.tag) { u.tag = genTag(); saveDB(); }
  // Auto-expire premium
  if (u.premium && u.premiumExpiry && new Date(u.premiumExpiry) <= new Date()) {
    (u.boostedServers || []).forEach(bs => {
      const srv = db.servers.find(s => s.id === bs.serverId);
      if (srv) { srv.boostCount = Math.max(0, (srv.boostCount || 0) - bs.amount); recalcBoostLevel(srv); }
    });
    u.boostedServers = []; u.premium = null; u.premiumExpiry = null; u.boostCredits = 0;
    saveDB();
  }
  const active = isPremiumActive(u);
  res.json({ id, username, email, avatarColor, avatar: avatar || null, tag: u.tag, status: status || 'online', bio: bio || '', bannerColor: bannerColor || null, agreedToTerms: !!agreedToTerms, premium: active ? u.premium : null, premiumExpiry: u.premiumExpiry || null, statusEmoji: u.statusEmoji || null, avatarFrame: u.avatarFrame || null });
});

app.patch('/api/auth/me', auth, (req, res) => {
  const { username, status, bio, bannerColor, statusEmoji } = req.body;
  const validStatuses = ['online', 'idle', 'dnd', 'invisible'];
  if (status && !validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (username !== undefined) {
    if (username.length < 2) return res.status(400).json({ error: 'Username too short' });
    const taken = db.users.find(u => u.username === username && u.id !== req.user.id);
    if (taken) return res.status(400).json({ error: 'Username taken' });
    req.user.username = username;
  }
  if (status) req.user.status = status;
  const bioLimit = isPremiumActive(req.user) ? 500 : 200;
  if (bio !== undefined) req.user.bio = bio.slice(0, bioLimit);
  if (bannerColor !== undefined) req.user.bannerColor = bannerColor;
  if (req.body.bannerImg !== undefined) {
    if (!isPremiumActive(req.user)) return res.status(403).json({ error: 'Premium required' });
    req.user.bannerImg = req.body.bannerImg || null;
    io.emit('user-banner-changed', { userId: req.user.id, bannerImg: req.user.bannerImg });
  }
  if (statusEmoji !== undefined) {
    if (!isPremiumActive(req.user)) return res.status(403).json({ error: 'Premium required' });
    req.user.statusEmoji = statusEmoji || null;
  }
  const VALID_FRAMES = ['glow-purple','gold','fire','ice','galaxy','neon'];
  if (req.body.avatarFrame !== undefined) {
    if (!isPremiumActive(req.user)) return res.status(403).json({ error: 'Premium required' });
    req.user.avatarFrame = VALID_FRAMES.includes(req.body.avatarFrame) ? req.body.avatarFrame : null;
  }
  saveDB();
  // Broadcast changes to all
  if (status) io.emit('user-status-changed', { userId: req.user.id, status });
  if (statusEmoji !== undefined) io.emit('user-status-emoji-changed', { userId: req.user.id, statusEmoji: req.user.statusEmoji });
  if (req.body.avatarFrame !== undefined) io.emit('user-frame-changed', { userId: req.user.id, avatarFrame: req.user.avatarFrame });
  const u = req.user;
  res.json({ id: u.id, username: u.username, email: u.email, avatarColor: u.avatarColor, avatar: u.avatar || null, tag: u.tag || genTag(), status: u.status, bio: u.bio || '', bannerColor: u.bannerColor || null, bannerImg: u.bannerImg || null, agreedToTerms: !!u.agreedToTerms, premium: isPremiumActive(u) ? u.premium : null, premiumExpiry: u.premiumExpiry || null, statusEmoji: u.statusEmoji || null, avatarFrame: u.avatarFrame || null });
});

// ── Avatar upload ──
app.post('/api/auth/avatar', auth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'Not an image' });
  req.user.avatar = '/uploads/' + req.file.filename;
  saveDB();
  io.emit('user-avatar-changed', { userId: req.user.id, avatar: req.user.avatar });
  res.json({ avatar: req.user.avatar });
});

app.delete('/api/auth/avatar', auth, (req, res) => {
  req.user.avatar = null;
  saveDB();
  io.emit('user-avatar-changed', { userId: req.user.id, avatar: null });
  res.json({ ok: true });
});

// ── Banner image ──
app.post('/api/auth/banner', auth, upload.single('banner'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'Not an image' });
  req.user.bannerImg = '/uploads/' + req.file.filename;
  saveDB();
  io.emit('user-banner-changed', { userId: req.user.id, bannerImg: req.user.bannerImg });
  res.json({ bannerImg: req.user.bannerImg });
});

app.delete('/api/auth/banner', auth, (req, res) => {
  req.user.bannerImg = null;
  saveDB();
  io.emit('user-banner-changed', { userId: req.user.id, bannerImg: null });
  res.json({ ok: true });
});

// ── Agree to terms ──
app.post('/api/auth/agree-terms', auth, (req, res) => {
  req.user.agreedToTerms = true;
  req.user.agreedAt = new Date().toISOString();
  saveDB();
  res.json({ ok: true });
});

// ── Delete account ──
app.delete('/api/auth/account', auth, (req, res) => {
  const uid = req.user.id;
  // Mark user as deleted (keep record for message history)
  req.user.deleted = true;
  req.user.deletedAt = new Date().toISOString();
  req.user.username = 'Удалённый пользователь';
  req.user.avatarColor = '#555';
  req.user.email = `deleted_${uid}@deleted`;
  req.user.passwordHash = '';
  req.user.bio = '';
  req.user.status = 'offline';
  // Remove from all servers
  db.members = db.members.filter(m => m.userId !== uid);
  // Remove from friends
  db.users.forEach(u => {
    if (u.friends) u.friends = u.friends.filter(f => f !== uid);
  });
  // Remove friend requests
  if (db.friendRequests) db.friendRequests = db.friendRequests.filter(r => r.fromId !== uid && r.toId !== uid);
  // Hide all DM channels
  db.dmChannels.forEach(dm => {
    if (dm.participants.includes(uid)) {
      if (!dm.hiddenFor) dm.hiddenFor = [];
      if (!dm.hiddenFor.includes(uid)) dm.hiddenFor.push(uid);
    }
  });
  saveDB();
  // Disconnect all sockets for this user
  const sockets = onlineUsers.get(uid);
  if (sockets) {
    sockets.forEach(sid => { io.sockets.sockets.get(sid)?.disconnect(true) });
    onlineUsers.delete(uid);
  }
  io.emit('user-offline', { userId: uid });
  res.json({ ok: true });
});

// ── Server Routes ──
app.get('/api/servers', auth, (req, res) => {
  const memberOf = db.members.filter(m => m.userId === req.user.id).map(m => m.serverId);
  const defaultPerms = { deleteMessages: false, deleteChannels: false, createChannels: false, kickMembers: true, manageRoles: false, bypassSlowmode: false };
  const servers = db.servers.filter(s => memberOf.includes(s.id)).map(s => ({ ...s, adminPermissions: s.adminPermissions || defaultPerms }));
  res.json(servers);
});

app.post('/api/servers', auth, (req, res) => {
  const { name } = req.body;
  if (!name || name.length < 2) return res.status(400).json({ error: 'Server name required (min 2 chars)' });
  const id = 's' + genId();
  const iconText = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  const server = { id, name, iconText, ownerId: req.user.id, createdAt: new Date().toISOString(), adminPermissions: { deleteMessages: false, deleteChannels: false, createChannels: false, kickMembers: true, manageRoles: false, bypassSlowmode: false } };
  db.servers.push(server);
  db.members.push({ serverId: id, userId: req.user.id, joinedAt: new Date().toISOString() });
  // Create default channel
  const chId = 'c' + genId();
  db.channels.push({ id: chId, serverId: id, name: 'general', createdAt: new Date().toISOString() });
  saveDB();
  res.json(server);
});

app.post('/api/servers/:id/join', auth, (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (db.members.find(m => m.serverId === server.id && m.userId === req.user.id)) {
    return res.status(400).json({ error: 'Already a member' });
  }
  db.members.push({ serverId: server.id, userId: req.user.id, joinedAt: new Date().toISOString() });
  // Post system message to server's first channel
  const generalCh = db.channels.find(c => c.serverId === server.id);
  if (generalCh) {
    const sysMsg = {
      id: 'm' + genId(),
      channelId: generalCh.id,
      userId: req.user.id,
      content: `${req.user.username} присоединился(-ась) к серверу`,
      type: 'system',
      createdAt: new Date().toISOString(),
      user: userMsg(req.user),
    };
    db.messages.push(sysMsg);
    io.to('channel:' + generalCh.id).emit('new-message', sysMsg);
  }
  saveDB();
  res.json({ ok: true });
});

app.delete('/api/servers/:id/leave', auth, (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  db.members = db.members.filter(m => !(m.serverId === req.params.id && m.userId === req.user.id));
  // Post system message to server's first channel
  const generalCh = db.channels.find(c => c.serverId === req.params.id);
  if (generalCh) {
    const sysMsg = {
      id: 'm' + genId(),
      channelId: generalCh.id,
      userId: req.user.id,
      content: `${req.user.username} покинул(а) сервер`,
      type: 'system',
      createdAt: new Date().toISOString(),
      user: userMsg(req.user),
    };
    db.messages.push(sysMsg);
    io.to('channel:' + generalCh.id).emit('new-message', sysMsg);
  }
  saveDB();
  res.json({ ok: true });
});

app.put('/api/servers/:id', auth, (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== req.user.id) return res.status(403).json({ error: 'Only the owner can edit this server' });
  const { name } = req.body;
  if (!name || name.length < 2) return res.status(400).json({ error: 'Server name required (min 2 chars)' });
  server.name = name;
  server.iconText = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  saveDB();
  io.to('server:' + req.params.id).emit('server-updated', { id: server.id, name: server.name, iconText: server.iconText, avatar: server.avatar || null });
  res.json(server);
});

app.post('/api/servers/:id/avatar', auth, upload.single('avatar'), (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== req.user.id) return res.status(403).json({ error: 'Only the owner can change the avatar' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  if (!req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'Not an image' });
  server.avatar = '/uploads/' + req.file.filename;
  saveDB();
  io.to('server:' + req.params.id).emit('server-updated', { id: server.id, name: server.name, iconText: server.iconText, avatar: server.avatar });
  res.json({ avatar: server.avatar });
});

app.delete('/api/servers/:id/avatar', auth, (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== req.user.id) return res.status(403).json({ error: 'Only the owner can change the avatar' });
  server.avatar = null;
  saveDB();
  io.to('server:' + req.params.id).emit('server-updated', { id: server.id, name: server.name, iconText: server.iconText, avatar: null });
  res.json({ ok: true });
});

// ── Server custom emojis ──
app.get('/api/servers/:id/emojis', auth, (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  res.json(server.customEmojis || []);
});

app.post('/api/servers/:id/emojis', auth, upload.single('image'), (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (server.ownerId !== req.user.id) return res.status(403).json({ error: 'Only owner can manage emojis' });
  // Check boost level — Level 1: 10 emojis, Level 2: 25, Level 3: 50
  const limits = [0, 10, 25, 50];
  const limit = limits[server.boostLevel || 0];
  if (limit === 0) return res.status(403).json({ error: 'Server needs at least Boost Level 1 for custom emojis' });
  if ((server.customEmojis || []).length >= limit) return res.status(400).json({ error: `Emoji limit reached (${limit} for Level ${server.boostLevel})` });
  if (!req.file) return res.status(400).json({ error: 'No image' });
  const { name } = req.body;
  if (!name || !/^[a-zA-Z0-9_]{2,32}$/.test(name)) return res.status(400).json({ error: 'Emoji name must be 2-32 chars (letters, numbers, underscore)' });
  if ((server.customEmojis || []).find(e => e.name === name)) return res.status(400).json({ error: 'Emoji name already used' });
  const emoji = { id: 'em' + genId(), name, url: '/uploads/' + req.file.filename, addedBy: req.user.id, addedAt: new Date().toISOString() };
  if (!server.customEmojis) server.customEmojis = [];
  server.customEmojis.push(emoji);
  saveDB();
  io.to('server:' + server.id).emit('server-emojis-updated', { serverId: server.id, emojis: server.customEmojis });
  res.json(emoji);
});

app.delete('/api/servers/:id/emojis/:emojiId', auth, (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  if (server.ownerId !== req.user.id) return res.status(403).json({ error: 'Only owner can manage emojis' });
  server.customEmojis = (server.customEmojis || []).filter(e => e.id !== req.params.emojiId);
  saveDB();
  io.to('server:' + server.id).emit('server-emojis-updated', { serverId: server.id, emojis: server.customEmojis });
  res.json({ ok: true });
});

app.put('/api/channels/:id', auth, (req, res) => {
  const channel = db.channels.find(c => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const server = db.servers.find(s => s.id === channel.serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const member = db.members.find(m => m.serverId === server.id && m.userId === req.user.id);
  const isOwner = server.ownerId === req.user.id;
  const isAdmin = member && member.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Only the server owner or admins can edit channels' });

  const { name, isPrivate, allowedUsers, permissions, slowmode } = req.body;

  // Rename
  if (name !== undefined) {
    if (!name || name.length < 1) return res.status(400).json({ error: 'Channel name required' });
    const oldName = channel.name;
    channel.name = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9а-яёіїґүөәңғқһ-]/g, '').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
    if (oldName !== channel.name) {
      const sysMsg = { id: 'msg' + genId(), channelId: channel.id, type: 'system', content: `${req.user.username} изменил(а) название канала с «${oldName}» на «${channel.name}»`, createdAt: new Date().toISOString() };
      db.messages.push(sysMsg);
      io.to('channel:' + channel.id).emit('new-message', sysMsg);
    }
  }

  // Private channel
  if (isPrivate !== undefined) channel.isPrivate = !!isPrivate;
  if (allowedUsers !== undefined) channel.allowedUsers = allowedUsers; // array of userIds

  // Role-based permissions: { user: { invite, sendMessages, sendMedia, viewChannel }, admin: { ... } }
  if (permissions !== undefined) channel.permissions = permissions;

  // Slowmode in seconds (0 = off)
  if (slowmode !== undefined) channel.slowmode = parseInt(slowmode) || 0;

  saveDB();
  io.to('server:' + channel.serverId).emit('channel-updated', channel);
  res.json(channel);
});

app.delete('/api/servers/:id', auth, (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== req.user.id) return res.status(403).json({ error: 'Only the owner can delete this server' });
  // Broadcast to all members before deleting
  io.to('server:' + req.params.id).emit('server-deleted', { id: req.params.id });
  db.servers = db.servers.filter(s => s.id !== req.params.id);
  db.channels = db.channels.filter(c => c.serverId !== req.params.id);
  db.messages = db.messages.filter(m => {
    const ch = db.channels.find(c => c.id === m.channelId);
    return ch || !m.channelId;
  });
  db.members = db.members.filter(m => m.serverId !== req.params.id);
  saveDB();
  res.json({ ok: true });
});

app.get('/api/servers/:id/channels', auth, (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  const member = db.members.find(m => m.serverId === req.params.id && m.userId === req.user.id);
  const isOwner = server && server.ownerId === req.user.id;
  const isAdmin = member && member.role === 'admin';
  const channels = db.channels.filter(c => {
    if (c.serverId !== req.params.id) return false;
    if (c.isPrivate && !isOwner && !isAdmin) {
      return c.allowedUsers && c.allowedUsers.includes(req.user.id);
    }
    return true;
  });
  res.json(channels);
});

app.post('/api/servers/:id/channels', auth, (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const memberRec = db.members.find(m => m.serverId === req.params.id && m.userId === req.user.id);
  if (!memberHasPerm(server, memberRec, 'createChannels')) return res.status(403).json({ error: 'No permission' });
  const { name, type } = req.body;
  if (!name || name.length < 2) return res.status(400).json({ error: 'Channel name required' });
  const channelName = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9а-яёіїґүөәңғқһ-]/g, '').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  if (!channelName) return res.status(400).json({ error: 'Invalid channel name' });
  const id = 'c' + genId();
  const channel = { id, serverId: req.params.id, name: channelName, type: type === 'voice' ? 'voice' : 'text', createdAt: new Date().toISOString() };
  db.channels.push(channel);
  saveDB();
  // Notify all in server
  io.to('server:' + req.params.id).emit('channel-created', channel);
  res.json(channel);
});

app.delete('/api/channels/:id', auth, (req, res) => {
  const channel = db.channels.find(c => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const server = db.servers.find(s => s.id === channel.serverId);
  const memberRec = server && db.members.find(m => m.serverId === server.id && m.userId === req.user.id);
  if (!memberHasPerm(server, memberRec, 'deleteChannels')) return res.status(403).json({ error: 'No permission to delete channels' });
  // If voice channel, disconnect all users in it
  if (channel.type === 'voice' && voiceState.has(req.params.id)) {
    io.to('voice:' + req.params.id).emit('voice-channel-deleted', { channelId: req.params.id });
    voiceState.delete(req.params.id);
    io.to('server:' + channel.serverId).emit('voice-state-update', { channelId: req.params.id, users: [] });
  }
  // Emit before removing so clients still have room membership
  io.to('server:' + channel.serverId).emit('channel-deleted', { id: req.params.id, serverId: channel.serverId });
  db.channels = db.channels.filter(c => c.id !== req.params.id);
  db.messages = db.messages.filter(m => m.channelId !== req.params.id);
  saveDB();
  res.json({ ok: true });
});

app.get('/api/servers/:id/members', auth, (req, res) => {
  const serverMembers = db.members.filter(m => m.serverId === req.params.id);
  const server = db.servers.find(s => s.id === req.params.id);
  const members = serverMembers.map(sm => {
    const u = db.users.find(u => u.id === sm.userId);
    if (!u) return null;
    return {
      id: u.id,
      username: u.username,
      avatarColor: u.avatarColor,
      avatar: u.avatar || null,
      tag: u.tag || '0000',
      status: !onlineUsers.has(u.id) ? 'offline' : (u.status === 'invisible' ? 'offline' : (u.status || 'online')),
      role: server && server.ownerId === u.id ? 'owner' : (sm.role || 'user')
    };
  }).filter(Boolean);
  res.json(members);
});

// Set member role (admin/user/customRoleId)
app.post('/api/servers/:id/members/:userId/role', auth, (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const isOwner = server.ownerId === req.user.id;
  const reqMember = db.members.find(m => m.serverId === req.params.id && m.userId === req.user.id);
  if (!memberHasPerm(server, reqMember, 'manageRoles')) return res.status(403).json({ error: 'No permission to manage roles' });
  if (req.params.userId === req.user.id) return res.status(400).json({ error: 'Cannot change own role' });
  const member = db.members.find(m => m.serverId === req.params.id && m.userId === req.params.userId);
  if (!member) return res.status(404).json({ error: 'Member not found' });
  const { role } = req.body; // 'admin', 'user', or custom role id
  const customRoles = server.customRoles || [];
  if (role !== 'admin' && role !== 'user' && !customRoles.find(r => r.id === role)) return res.status(400).json({ error: 'Invalid role' });
  const oldRole = member.role;
  member.role = role;
  saveDB();
  io.to('server:' + req.params.id).emit('member-role-updated', { serverId: req.params.id, userId: req.params.userId, role });
  // System message for role change
  const targetUser = db.users.find(u => u.id === req.params.userId);
  const generalCh = db.channels.find(c => c.serverId === req.params.id && c.type !== 'voice');
  if (generalCh && targetUser) {
    let roleLabel = role;
    if (role === 'admin') roleLabel = '🛡️ Admin';
    else if (role === 'user') roleLabel = 'Member';
    else {
      const cr = customRoles.find(r => r.id === role);
      if (cr) roleLabel = cr.name;
    }
    const sysMsg = { id: 'msg' + genId(), channelId: generalCh.id, type: 'system', content: `${req.user.username} изменил(а) роль ${targetUser.username} на ${roleLabel}`, createdAt: new Date().toISOString() };
    db.messages.push(sysMsg);
    saveDB();
    io.to('channel:' + generalCh.id).emit('new-message', sysMsg);
  }
  res.json({ ok: true, role });
});

// CRUD for custom roles
app.get('/api/servers/:id/roles', auth, (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  res.json(server.customRoles || []);
});

app.post('/api/servers/:id/roles', auth, (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== req.user.id) return res.status(403).json({ error: 'Only owner can create roles' });
  const { name, permissions, color } = req.body;
  if (!name || name.length < 1) return res.status(400).json({ error: 'Role name required' });
  if (!server.customRoles) server.customRoles = [];
  const role = { id: 'r' + genId(), name, permissions: permissions || {}, color: color || '#99aab5' };
  server.customRoles.push(role);
  saveDB();
  io.to('server:' + server.id).emit('server-roles-updated', { serverId: server.id, customRoles: server.customRoles });
  res.json(role);
});

app.put('/api/servers/:id/roles/:roleId', auth, (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== req.user.id) return res.status(403).json({ error: 'Only owner can edit roles' });
  const role = (server.customRoles || []).find(r => r.id === req.params.roleId);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (req.body.name) role.name = req.body.name;
  if (req.body.permissions) role.permissions = req.body.permissions;
  if (req.body.color) role.color = req.body.color;
  saveDB();
  io.to('server:' + server.id).emit('server-roles-updated', { serverId: server.id, customRoles: server.customRoles });
  res.json(role);
});

app.delete('/api/servers/:id/roles/:roleId', auth, (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== req.user.id) return res.status(403).json({ error: 'Only owner can delete roles' });
  if (!server.customRoles) return res.status(404).json({ error: 'Role not found' });
  const idx = server.customRoles.findIndex(r => r.id === req.params.roleId);
  if (idx < 0) return res.status(404).json({ error: 'Role not found' });
  server.customRoles.splice(idx, 1);
  // Reset members with this role back to 'user'
  db.members.filter(m => m.serverId === server.id && m.role === req.params.roleId).forEach(m => { m.role = 'user'; });
  saveDB();
  io.to('server:' + server.id).emit('server-roles-updated', { serverId: server.id, customRoles: server.customRoles });
  io.to('server:' + server.id).emit('role-deleted-reset', { serverId: server.id, roleId: req.params.roleId });
  res.json({ ok: true });
});

// Update admin permissions for server
app.put('/api/servers/:id/permissions', auth, (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== req.user.id) return res.status(403).json({ error: 'Only owner can change permissions' });
  const validPerms = ['deleteMessages', 'deleteChannels', 'createChannels', 'kickMembers', 'manageRoles', 'bypassSlowmode', 'clearChannel'];
  const perms = {};
  for (const p of validPerms) perms[p] = !!req.body[p];
  server.adminPermissions = perms;
  saveDB();
  io.to('server:' + req.params.id).emit('server-permissions-updated', { serverId: req.params.id, adminPermissions: perms });
  res.json({ ok: true, adminPermissions: perms });
});

// Kick member from server
app.post('/api/servers/:id/members/:userId/kick', auth, (req, res) => {
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const reqMember = db.members.find(m => m.serverId === req.params.id && m.userId === req.user.id);
  const isOwner = server.ownerId === req.user.id;
  if (!memberHasPerm(server, reqMember, 'kickMembers')) return res.status(403).json({ error: 'No permission' });
  if (req.params.userId === server.ownerId) return res.status(400).json({ error: 'Cannot kick the owner' });
  // Non-owners can't kick admins
  const targetMember = db.members.find(m => m.serverId === req.params.id && m.userId === req.params.userId);
  if (!isOwner && targetMember?.role === 'admin') return res.status(403).json({ error: 'Cannot kick an admin' });
  // Get kicked user info before removing
  const kickedUser = db.users.find(u => u.id === req.params.userId);
  db.members = db.members.filter(m => !(m.serverId === req.params.id && m.userId === req.params.userId));
  saveDB();
  // System message for kick
  const generalCh = db.channels.find(c => c.serverId === req.params.id && c.type !== 'voice');
  if (generalCh && kickedUser) {
    const sysMsg = { id: 'msg' + genId(), channelId: generalCh.id, type: 'system', content: `${req.user.username} исключил(а) ${kickedUser.username} с сервера`, createdAt: new Date().toISOString() };
    db.messages.push(sysMsg);
    saveDB();
    io.to('channel:' + generalCh.id).emit('new-message', sysMsg);
  }
  // Notify kicked user
  const targetSockets = onlineUsers.get(req.params.userId);
  if (targetSockets) {
    for (const sid of targetSockets) {
      io.to(sid).emit('kicked-from-server', { serverId: req.params.id });
    }
  }
  io.to('server:' + req.params.id).emit('member-kicked', { serverId: req.params.id, userId: req.params.userId });
  res.json({ ok: true });
});

// ── Channel / Messages Routes ──
app.get('/api/channels/:id/messages', auth, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const before = req.query.before;
  let msgs = db.messages.filter(m => m.channelId === req.params.id);
  if (before) {
    const idx = msgs.findIndex(m => m.id === before);
    if (idx > 0) msgs = msgs.slice(Math.max(0, idx - limit), idx);
    else msgs = msgs.slice(-limit);
  } else {
    msgs = msgs.slice(-limit);
  }
  // Filter out messages hidden for this user
  msgs = msgs.filter(m => !m.hiddenFor || !m.hiddenFor.includes(req.user.id));
  // Attach user info
  const result = msgs.map(m => {
    const user = db.users.find(u => u.id === m.userId);
    const obj = { ...m, hiddenFor: undefined, user: userMsg(user || { id: m.userId }) };
    if (m.replyToId) {
      const replyMsg = db.messages.find(r => r.id === m.replyToId);
      if (replyMsg) {
        const ru = db.users.find(u => u.id === replyMsg.userId);
        obj.replyTo = { id: replyMsg.id, content: replyMsg.deleted ? null : replyMsg.content, user: ru ? { id: ru.id, username: ru.username, avatarColor: ru.avatarColor } : null };
      }
    }
    return obj;
  });
  res.json(result);
});

app.get('/api/channels/:id/pinned', auth, (req, res) => {
  const msgs = db.messages.filter(m => m.channelId === req.params.id && !m.deleted &&
    (m.pinned || (m.pinnedFor && m.pinnedFor.includes(req.user.id)))
  );
  msgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const result = msgs.map(m => {
    const user = db.users.find(u => u.id === m.userId);
    return { ...m, hiddenFor: undefined, pinnedFor: undefined, user: userMsg(user || { id: m.userId }) };
  });
  res.json(result);
});

app.get('/api/dm-channels/:id/pinned', auth, (req, res) => {
  const dm = db.dmChannels.find(d => d.id === req.params.id && d.participants.includes(req.user.id));
  if (!dm) return res.status(404).json({ error: 'DM not found' });
  const msgs = db.dmMessages.filter(m => m.dmChannelId === dm.id && !m.deleted &&
    (m.pinned || (m.pinnedFor && m.pinnedFor.includes(req.user.id)))
  );
  msgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const result = msgs.map(m => {
    const user = db.users.find(u => u.id === m.userId);
    return { ...m, hiddenFor: undefined, pinnedFor: undefined, user: userMsg(user || { id: m.userId }) };
  });
  res.json(result);
});

// ── Socket.io (early init for onlineUsers) ──
const io = new Server(httpServer, {
  cors: { origin: '*' },
  pingTimeout: 30000,
  pingInterval: 10000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: false,
  },
});
const onlineUsers = new Map(); // userId -> Set<socketId>

// ── Friends Routes ──
function userPublic(u) {
  return { id: u.id, username: u.username, avatarColor: u.avatarColor, avatar: u.avatar || null, tag: u.tag || '0000', bio: u.bio || '', bannerColor: u.bannerColor || null, status: !onlineUsers.has(u.id) ? 'offline' : (u.status === 'invisible' ? 'offline' : (u.status || 'online')) };
}
function userMsg(u) {
  if (!u || !u.username) return { id: u?.id || '0', username: 'Deleted User', avatarColor: '#555', avatar: null, tag: '0000', statusEmoji: null, avatarFrame: null };
  return { id: u.id, username: u.username, avatarColor: u.avatarColor, avatar: u.avatar || null, tag: u.tag || '0000', statusEmoji: u.statusEmoji || null, avatarFrame: u.avatarFrame || null };
}

app.post('/api/friends/search', auth, (req, res) => {
  const { query } = req.body;
  if (!query || !query.includes('#')) return res.status(400).json({ error: 'Use format Username#1234' });
  const [username, tag] = query.split('#');
  if (!username || !tag || tag.length !== 4) return res.status(400).json({ error: 'Use format Username#1234' });
  const found = db.users.find(u => u.username.toLowerCase() === username.toLowerCase() && (u.tag || '0000') === tag);
  if (!found) return res.status(404).json({ error: 'User not found' });
  if (found.id === req.user.id) return res.status(400).json({ error: 'self' });
  // Check existing relationship
  const existing = db.friendRequests.find(fr =>
    ((fr.fromId === req.user.id && fr.toId === found.id) || (fr.fromId === found.id && fr.toId === req.user.id))
    && fr.status !== 'declined'
  );
  res.json({ user: userPublic(found), friendStatus: existing ? existing.status : null, requestId: existing?.id || null });
});

app.post('/api/friends/request', auth, (req, res) => {
  const { toUserId } = req.body;
  if (!toUserId || toUserId === req.user.id) return res.status(400).json({ error: 'Invalid user' });
  const target = db.users.find(u => u.id === toUserId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  // Check existing
  const existing = db.friendRequests.find(fr =>
    ((fr.fromId === req.user.id && fr.toId === toUserId) || (fr.fromId === toUserId && fr.toId === req.user.id))
    && fr.status !== 'declined'
  );
  if (existing) {
    // If the other user already sent us a pending request, auto-accept (mutual add)
    if (existing.status === 'pending' && existing.fromId === toUserId && existing.toId === req.user.id) {
      existing.status = 'accepted';
      saveDB();
      // Notify the other user that their request was accepted
      const otherSockets = onlineUsers.get(toUserId);
      if (otherSockets) {
        for (const sid of otherSockets) {
          io.to(sid).emit('friend-request-accepted', { requestId: existing.id, friend: userPublic(req.user) });
        }
      }
      return res.json({ ...existing, autoAccepted: true });
    }
    return res.status(400).json({ error: existing.status === 'accepted' ? 'Already friends' : 'Request already pending', requestId: existing.status === 'pending' ? existing.id : undefined });
  }
  const id = 'fr' + genId();
  const fr = { id, fromId: req.user.id, toId: toUserId, status: 'pending', createdAt: new Date().toISOString() };
  db.friendRequests.push(fr);
  saveDB();
  // Notify target via socket
  const targetSockets = onlineUsers.get(toUserId);
  if (targetSockets) {
    for (const sid of targetSockets) {
      io.to(sid).emit('friend-request-received', { ...fr, from: userPublic(req.user) });
    }
  }
  res.json(fr);
});

app.get('/api/friends', auth, (req, res) => {
  const accepted = db.friendRequests.filter(fr => fr.status === 'accepted' && (fr.fromId === req.user.id || fr.toId === req.user.id));
  const friends = accepted.map(fr => {
    const friendId = fr.fromId === req.user.id ? fr.toId : fr.fromId;
    const u = db.users.find(u => u.id === friendId);
    return u ? { ...userPublic(u), requestId: fr.id } : null;
  }).filter(Boolean);
  res.json(friends);
});

app.get('/api/friends/requests', auth, (req, res) => {
  const pending = db.friendRequests.filter(fr => fr.toId === req.user.id && fr.status === 'pending');
  const result = pending.map(fr => {
    const u = db.users.find(u => u.id === fr.fromId);
    return { ...fr, from: u ? userPublic(u) : null };
  }).filter(r => r.from);
  res.json(result);
});

app.get('/api/friends/requests/sent', auth, (req, res) => {
  const sent = db.friendRequests.filter(fr => fr.fromId === req.user.id && fr.status === 'pending');
  const result = sent.map(fr => {
    const u = db.users.find(u => u.id === fr.toId);
    return { ...fr, to: u ? userPublic(u) : null };
  }).filter(r => r.to);
  res.json(result);
});

app.post('/api/friends/requests/:id/accept', auth, (req, res) => {
  const fr = db.friendRequests.find(f => f.id === req.params.id && f.toId === req.user.id && f.status === 'pending');
  if (!fr) return res.status(404).json({ error: 'Request not found' });
  fr.status = 'accepted';
  saveDB();
  // Notify sender
  const senderSockets = onlineUsers.get(fr.fromId);
  if (senderSockets) {
    for (const sid of senderSockets) {
      io.to(sid).emit('friend-request-accepted', { requestId: fr.id, friend: userPublic(req.user) });
    }
  }
  res.json(fr);
});

app.post('/api/friends/requests/:id/decline', auth, (req, res) => {
  const fr = db.friendRequests.find(f => f.id === req.params.id && f.toId === req.user.id && f.status === 'pending');
  if (!fr) return res.status(404).json({ error: 'Request not found' });
  fr.status = 'declined';
  saveDB();
  res.json(fr);
});

app.post('/api/friends/requests/:id/cancel', auth, (req, res) => {
  const fr = db.friendRequests.find(f => f.id === req.params.id && f.fromId === req.user.id && f.status === 'pending');
  if (!fr) return res.status(404).json({ error: 'Request not found' });
  fr.status = 'declined';
  saveDB();
  // Remove from target's pending requests in real-time
  const targetSockets = onlineUsers.get(fr.toId);
  if (targetSockets) {
    for (const sid of targetSockets) {
      io.to(sid).emit('friend-request-cancelled', { requestId: fr.id });
    }
  }
  res.json(fr);
});

app.delete('/api/friends/:id', auth, (req, res) => {
  const fr = db.friendRequests.find(f => f.id === req.params.id && f.status === 'accepted' && (f.fromId === req.user.id || f.toId === req.user.id));
  if (!fr) return res.status(404).json({ error: 'Friend not found' });
  fr.status = 'declined';
  saveDB();
  // Notify the other user in real-time
  const otherUserId = fr.fromId === req.user.id ? fr.toId : fr.fromId;
  const otherSockets = onlineUsers.get(otherUserId);
  if (otherSockets) {
    for (const sid of otherSockets) {
      io.to(sid).emit('friend-removed', { userId: req.user.id });
    }
  }
  res.json({ ok: true });
});

// ── Server Invite ──
app.post('/api/servers/:id/invite', auth, (req, res) => {
  const { targetUserId } = req.body;
  if (!targetUserId) return res.status(400).json({ error: 'Target user required' });
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const target = db.users.find(u => u.id === targetUserId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  // Already a member?
  if (db.members.find(m => m.serverId === server.id && m.userId === targetUserId)) {
    return res.status(400).json({ error: 'User is already a member' });
  }
  // Find or create DM channel
  let dm = db.dmChannels.find(d => d.participants.includes(req.user.id) && d.participants.includes(targetUserId));
  if (!dm) {
    dm = { id: 'dm' + genId(), participants: [req.user.id, targetUserId], createdAt: new Date().toISOString() };
    db.dmChannels.push(dm);
  }
  // Send invite message
  const msgId = 'dm' + genId();
  const msg = {
    id: msgId, dmChannelId: dm.id, userId: req.user.id,
    content: `Приглашает вас на сервер ${server.name}`,
    type: 'invite',
    invite: { serverId: server.id, serverName: server.name, serverIcon: server.iconText, memberCount: db.members.filter(m => m.serverId === server.id).length },
    createdAt: new Date().toISOString(),
  };
  db.dmMessages.push(msg);
  saveDB();
  const fullMsg = { ...msg, user: userMsg(req.user) };
  io.to('dm:' + dm.id).emit('new-dm', fullMsg);
  // Make sure target is in the DM room
  const targetSockets = onlineUsers.get(targetUserId);
  if (targetSockets) {
    for (const sid of targetSockets) { io.sockets.sockets.get(sid)?.join('dm:' + dm.id); }
  }
  res.json({ ok: true });
});

// ── Voice Channel Invite ──
app.post('/api/channels/:id/voice-invite', auth, (req, res) => {
  const { targetUserId } = req.body;
  if (!targetUserId) return res.status(400).json({ error: 'Target user required' });
  const channel = db.channels.find(c => c.id === req.params.id && c.type === 'voice');
  if (!channel) return res.status(404).json({ error: 'Voice channel not found' });
  const server = db.servers.find(s => s.id === channel.serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const target = db.users.find(u => u.id === targetUserId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  // Find or create DM channel
  let dm = db.dmChannels.find(d => d.participants.includes(req.user.id) && d.participants.includes(targetUserId));
  if (!dm) {
    dm = { id: 'dm' + genId(), participants: [req.user.id, targetUserId], createdAt: new Date().toISOString() };
    db.dmChannels.push(dm);
  }
  const vcUsers = voiceState.get(channel.id);
  const participantCount = vcUsers ? vcUsers.size : 0;
  const msgId = 'dm' + genId();
  const msg = {
    id: msgId, dmChannelId: dm.id, userId: req.user.id,
    content: `Приглашает вас в голосовой канал «${channel.name}»`,
    type: 'voice-invite',
    voiceInvite: { serverId: server.id, serverName: server.name, serverIcon: server.iconText, channelId: channel.id, channelName: channel.name, participantCount },
    createdAt: new Date().toISOString(),
  };
  db.dmMessages.push(msg);
  saveDB();
  const fullMsg = { ...msg, user: userMsg(req.user) };
  io.to('dm:' + dm.id).emit('new-dm', fullMsg);
  const targetSockets = onlineUsers.get(targetUserId);
  if (targetSockets) {
    for (const sid of targetSockets) { io.sockets.sockets.get(sid)?.join('dm:' + dm.id); }
  }
  res.json({ ok: true });
});

// ── DM Routes ──
app.get('/api/dm-channels', auth, (req, res) => {
  const myDMs = db.dmChannels.filter(d => d.participants.includes(req.user.id));
  const result = myDMs.map(dm => {
    const otherId = dm.participants.find(p => p !== req.user.id);
    const other = db.users.find(u => u.id === otherId);
    const lastMsg = [...db.dmMessages].reverse().find(m => m.dmChannelId === dm.id);
    return {
      ...dm,
      partner: other ? userPublic(other) : null,
      lastMessage: lastMsg ? { content: lastMsg.content, createdAt: lastMsg.createdAt, userId: lastMsg.userId, attachment: lastMsg.attachment } : null,
    };
  }).filter(d => d.partner);
  // Sort by last message time descending
  result.sort((a, b) => {
    const ta = a.lastMessage?.createdAt || a.createdAt;
    const tb = b.lastMessage?.createdAt || b.createdAt;
    return tb.localeCompare(ta);
  });
  res.json(result);
});

app.post('/api/dm-channels', auth, (req, res) => {
  const { targetUserId } = req.body;
  if (!targetUserId || targetUserId === req.user.id) return res.status(400).json({ error: 'Invalid user' });
  const target = db.users.find(u => u.id === targetUserId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  // Find existing
  let dm = db.dmChannels.find(d =>
    d.participants.includes(req.user.id) && d.participants.includes(targetUserId)
  );
  if (!dm) {
    dm = { id: 'dm' + genId(), participants: [req.user.id, targetUserId], createdAt: new Date().toISOString() };
    db.dmChannels.push(dm);
    saveDB();
  }
  res.json({ ...dm, partner: userPublic(target) });
});

app.get('/api/dm-channels/:id/messages', auth, (req, res) => {
  const dm = db.dmChannels.find(d => d.id === req.params.id && d.participants.includes(req.user.id));
  if (!dm) return res.status(404).json({ error: 'DM not found' });
  const limit = parseInt(req.query.limit) || 50;
  let msgs = db.dmMessages.filter(m => m.dmChannelId === dm.id);
  msgs = msgs.filter(m => !m.hiddenFor || !m.hiddenFor.includes(req.user.id));
  // Filter out messages before clearedAt for this user
  const clearedAt = dm.clearedAt && dm.clearedAt[req.user.id];
  if (clearedAt) msgs = msgs.filter(m => m.createdAt > clearedAt);
  msgs = msgs.slice(-limit);
  const result = msgs.map(m => {
    const user = db.users.find(u => u.id === m.userId);
    const obj = { ...m, hiddenFor: undefined, user: userMsg(user || { id: m.userId }) };
    if (m.replyToId) {
      const replyMsg = db.dmMessages.find(r => r.id === m.replyToId);
      if (replyMsg) {
        const ru = db.users.find(u => u.id === replyMsg.userId);
        obj.replyTo = { id: replyMsg.id, content: replyMsg.deleted ? null : replyMsg.content, user: ru ? { id: ru.id, username: ru.username, avatarColor: ru.avatarColor } : null };
      }
    }
    return obj;
  });
  res.json(result);
});

// ── DM search ──
app.get('/api/dm-search', auth, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  const myDMs = db.dmChannels.filter(d => d.participants.includes(req.user.id) && (!d.hiddenFor || !d.hiddenFor.includes(req.user.id)));
  const results = [];
  for (const dm of myDMs) {
    const partnerId = dm.participants.find(p => p !== req.user.id);
    const partner = db.users.find(u => u.id === partnerId);
    if (!partner) continue;
    const clearedAt = dm.clearedAt && dm.clearedAt[req.user.id];
    let msgs = db.dmMessages.filter(m => m.dmChannelId === dm.id && !m.deleted);
    if (clearedAt) msgs = msgs.filter(m => m.createdAt > clearedAt);
    msgs = msgs.filter(m => !m.hiddenFor || !m.hiddenFor.includes(req.user.id));
    const nameMatch = partner.username.toLowerCase().includes(q);
    const matchedMsgs = msgs.filter(m => m.content && m.content.toLowerCase().includes(q)).slice(-20).reverse();
    if (nameMatch || matchedMsgs.length > 0) {
      results.push({
        dmId: dm.id,
        partner: { ...userMsg(partner), status: partner.status || 'offline' },
        matchedMessages: matchedMsgs.map(m => {
          const u = db.users.find(u => u.id === m.userId);
          return { id: m.id, content: m.content, createdAt: m.createdAt, userId: m.userId, username: u ? u.username : 'Deleted User' };
        }),
        nameMatch
      });
    }
  }
  res.json(results);
});

// ── Message actions (edit, delete, pin) ──
app.put('/api/messages/:id', auth, (req, res) => {
  const msg = db.messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.userId !== req.user.id) return res.status(403).json({ error: 'Not your message' });
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
  msg.content = content.trim().slice(0, 1500);
  msg.editedAt = new Date().toISOString();
  saveDB();
  io.to('channel:' + msg.channelId).emit('message-edited', { id: msg.id, content: msg.content, editedAt: msg.editedAt });
  res.json({ ok: true });
});

app.delete('/api/messages/:id', auth, (req, res) => {
  const msg = db.messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  // Check if user is owner or admin/custom-role with deleteMessages permission
  const channel = db.channels.find(c => c.id === msg.channelId);
  const server = channel && db.servers.find(s => s.id === channel.serverId);
  const memberRec = server && db.members.find(m => m.serverId === server.id && m.userId === req.user.id);
  const canDeleteOthers = memberHasPerm(server, memberRec, 'deleteMessages');
  const isAuthor = msg.userId === req.user.id;
  if (!isAuthor && !canDeleteOthers) return res.status(403).json({ error: 'Not your message' });
  if (isAuthor || canDeleteOthers) {
    const age = Date.now() - new Date(msg.createdAt).getTime();
    const fifteenMin = 15 * 60 * 1000;
    if (canDeleteOthers || age < fifteenMin) {
      msg.deleted = true;
      msg.deletedAt = new Date().toISOString();
      delete msg.content;
      delete msg.attachment;
      saveDB();
      io.to('channel:' + msg.channelId).emit('message-deleted-for-all', { id: msg.id });
    } else {
      if (!msg.hiddenFor) msg.hiddenFor = [];
      if (!msg.hiddenFor.includes(req.user.id)) msg.hiddenFor.push(req.user.id);
      saveDB();
    }
  }
  res.json({ ok: true });
});

// Clear all messages in a channel
app.post('/api/channels/:id/clear', auth, (req, res) => {
  const channel = db.channels.find(c => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const server = db.servers.find(s => s.id === channel.serverId);
  const memberRec = server && db.members.find(m => m.serverId === server.id && m.userId === req.user.id);
  if (!memberHasPerm(server, memberRec, 'clearChannel')) return res.status(403).json({ error: 'No permission' });
  const count = db.messages.filter(m => m.channelId === channel.id && !m.deleted).length;
  db.messages = db.messages.filter(m => m.channelId !== channel.id);
  saveDB();
  io.to('channel:' + channel.id).emit('channel-cleared', { channelId: channel.id });
  res.json({ ok: true, cleared: count });
});

// Bulk delete messages
app.delete('/api/channels/:id/messages/bulk', auth, (req, res) => {
  const { messageIds, mode } = req.body; // mode: 'forAll' | 'forMe'
  if (!Array.isArray(messageIds) || messageIds.length === 0) return res.status(400).json({ error: 'No messages specified' });
  if (messageIds.length > 100) return res.status(400).json({ error: 'Max 100 messages at once' });
  const channel = db.channels.find(c => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const server = db.servers.find(s => s.id === channel.serverId);
  const memberRec = server && db.members.find(m => m.serverId === server.id && m.userId === req.user.id);
  const canDeleteOthers = memberHasPerm(server, memberRec, 'deleteMessages');
  const deleted = [];
  const hidden = [];
  for (const msgId of messageIds) {
    const msg = db.messages.find(m => m.id === msgId && m.channelId === channel.id);
    if (!msg || msg.deleted) continue;
    if (mode === 'forMe') {
      if (!msg.hiddenFor) msg.hiddenFor = [];
      if (!msg.hiddenFor.includes(req.user.id)) msg.hiddenFor.push(req.user.id);
      hidden.push(msg.id);
    } else {
      const isAuthor = msg.userId === req.user.id;
      if (!isAuthor && !canDeleteOthers) continue;
      msg.deleted = true;
      msg.deletedAt = new Date().toISOString();
      delete msg.content;
      delete msg.attachment;
      deleted.push(msg.id);
    }
  }
  if (deleted.length > 0 || hidden.length > 0) {
    saveDB();
    for (const id of deleted) {
      io.to('channel:' + channel.id).emit('message-deleted-for-all', { id });
    }
  }
  res.json({ ok: true, deleted: deleted.length, hidden: hidden.length });
});

// Bulk delete DM messages
app.delete('/api/dm-channels/:id/messages/bulk', auth, (req, res) => {
  const { messageIds, mode } = req.body; // mode: 'forAll' | 'forMe'
  if (!Array.isArray(messageIds) || messageIds.length === 0) return res.status(400).json({ error: 'No messages specified' });
  if (messageIds.length > 100) return res.status(400).json({ error: 'Max 100 messages at once' });
  const dm = db.dmChannels.find(d => d.id === req.params.id && d.participants.includes(req.user.id));
  if (!dm) return res.status(404).json({ error: 'DM not found' });
  const deleted = [];
  const hidden = [];
  const fifteenMin = 15 * 60 * 1000;
  for (const msgId of messageIds) {
    const msg = db.dmMessages.find(m => m.id === msgId && m.dmChannelId === dm.id);
    if (!msg || msg.deleted) continue;
    if (mode === 'forMe') {
      if (!msg.hiddenFor) msg.hiddenFor = [];
      if (!msg.hiddenFor.includes(req.user.id)) msg.hiddenFor.push(req.user.id);
      hidden.push(msg.id);
    } else {
      // Only author can delete for all, and only within 15 min
      if (msg.userId !== req.user.id) continue;
      const age = Date.now() - new Date(msg.createdAt).getTime();
      if (age >= fifteenMin) continue;
      msg.deleted = true;
      msg.deletedAt = new Date().toISOString();
      delete msg.content;
      delete msg.attachment;
      deleted.push(msg.id);
    }
  }
  if (deleted.length > 0 || hidden.length > 0) {
    saveDB();
    for (const id of deleted) {
      io.to('dm:' + dm.id).emit('dm-message-deleted-for-all', { id });
    }
  }
  res.json({ ok: true, deleted: deleted.length, hidden: hidden.length });
});

app.post('/api/messages/:id/pin', auth, (req, res) => {
  const msg = db.messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  const { mode } = req.body; // 'all' or 'self'
  if (mode === 'self') {
    if (!msg.pinnedFor) msg.pinnedFor = [];
    const idx = msg.pinnedFor.indexOf(req.user.id);
    if (idx >= 0) msg.pinnedFor.splice(idx, 1);
    else msg.pinnedFor.push(req.user.id);
    saveDB();
    res.json({ ok: true });
  } else {
    msg.pinned = !msg.pinned;
    saveDB();
    io.to('channel:' + msg.channelId).emit('message-pinned', { id: msg.id, pinned: msg.pinned });
    // System message for pin/unpin
    const ch = db.channels.find(c => c.id === msg.channelId);
    if (ch) {
      const sysMsg = {
        id: 'm' + genId(), channelId: ch.id, userId: req.user.id,
        content: msg.pinned ? `${req.user.username} закрепил(а) сообщение` : `${req.user.username} открепил(а) сообщение`,
        type: 'system', createdAt: new Date().toISOString(),
        user: userMsg(req.user),
      };
      db.messages.push(sysMsg);
      saveDB();
      io.to('channel:' + ch.id).emit('new-message', sysMsg);
    }
    res.json({ ok: true, pinned: msg.pinned });
  }
});

app.post('/api/dm-messages/:id/pin', auth, (req, res) => {
  const msg = db.dmMessages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  const { mode } = req.body;
  if (mode === 'self') {
    if (!msg.pinnedFor) msg.pinnedFor = [];
    const idx = msg.pinnedFor.indexOf(req.user.id);
    if (idx >= 0) msg.pinnedFor.splice(idx, 1);
    else msg.pinnedFor.push(req.user.id);
    saveDB();
    res.json({ ok: true });
  } else {
    msg.pinned = !msg.pinned;
    saveDB();
    io.to('dm:' + msg.dmChannelId).emit('dm-message-pinned', { id: msg.id, pinned: msg.pinned });
    res.json({ ok: true, pinned: msg.pinned });
  }
});

// ── Reactions ──
app.post('/api/messages/:id/react', auth, (req, res) => {
  const msg = db.messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ error: 'Emoji required' });
  if (!msg.reactions) msg.reactions = [];
  const existing = msg.reactions.find(r => r.emoji === emoji);
  if (existing) {
    if (existing.users.includes(req.user.id)) {
      existing.users = existing.users.filter(u => u !== req.user.id);
      if (existing.users.length === 0) msg.reactions = msg.reactions.filter(r => r.emoji !== emoji);
    } else {
      existing.users.push(req.user.id);
    }
  } else {
    msg.reactions.push({ emoji, users: [req.user.id] });
  }
  saveDB();
  io.to('channel:' + msg.channelId).emit('message-reacted', { id: msg.id, reactions: msg.reactions });
  res.json({ ok: true, reactions: msg.reactions });
});

app.post('/api/dm-messages/:id/react', auth, (req, res) => {
  const msg = db.dmMessages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  const { emoji } = req.body;
  if (!emoji) return res.status(400).json({ error: 'Emoji required' });
  if (!msg.reactions) msg.reactions = [];
  const existing = msg.reactions.find(r => r.emoji === emoji);
  if (existing) {
    if (existing.users.includes(req.user.id)) {
      existing.users = existing.users.filter(u => u !== req.user.id);
      if (existing.users.length === 0) msg.reactions = msg.reactions.filter(r => r.emoji !== emoji);
    } else {
      existing.users.push(req.user.id);
    }
  } else {
    msg.reactions.push({ emoji, users: [req.user.id] });
  }
  saveDB();
  io.to('dm:' + msg.dmChannelId).emit('dm-message-reacted', { id: msg.id, reactions: msg.reactions });
  res.json({ ok: true, reactions: msg.reactions });
});

app.put('/api/dm-messages/:id', auth, (req, res) => {
  const msg = db.dmMessages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.userId !== req.user.id) return res.status(403).json({ error: 'Not your message' });
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });
  msg.content = content.trim().slice(0, 1500);
  msg.editedAt = new Date().toISOString();
  saveDB();
  io.to('dm:' + msg.dmChannelId).emit('dm-message-edited', { id: msg.id, content: msg.content, editedAt: msg.editedAt });
  res.json({ ok: true });
});

app.delete('/api/dm-messages/:id', auth, (req, res) => {
  const msg = db.dmMessages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.userId !== req.user.id) return res.status(403).json({ error: 'Not your message' });
  const age = Date.now() - new Date(msg.createdAt).getTime();
  const fifteenMin = 15 * 60 * 1000;
  if (age < fifteenMin) {
    msg.deleted = true;
    msg.deletedAt = new Date().toISOString();
    delete msg.content;
    delete msg.attachment;
    saveDB();
    io.to('dm:' + msg.dmChannelId).emit('dm-message-deleted-for-all', { id: msg.id });
  } else {
    if (!msg.hiddenFor) msg.hiddenFor = [];
    if (!msg.hiddenFor.includes(req.user.id)) msg.hiddenFor.push(req.user.id);
    saveDB();
  }
  res.json({ ok: true });
});

// Delete DM channel (for self or both)
app.delete('/api/dm-channels/:id/messages', auth, (req, res) => {
  const dm = db.dmChannels.find(d => d.id === req.params.id && d.participants.includes(req.user.id));
  if (!dm) return res.status(404).json({ error: 'DM not found' });
  const mode = req.query.mode;
  if (mode === 'both') {
    db.dmMessages = db.dmMessages.filter(m => m.dmChannelId !== dm.id);
    io.to('dm:' + dm.id).emit('dm-messages-cleared', { dmChannelId: dm.id });
  } else {
    if (!dm.clearedAt) dm.clearedAt = {};
    dm.clearedAt[req.user.id] = new Date().toISOString();
  }
  saveDB();
  res.json({ ok: true });
});

app.delete('/api/dm-channels/:id', auth, (req, res) => {
  const dm = db.dmChannels.find(d => d.id === req.params.id && d.participants.includes(req.user.id));
  if (!dm) return res.status(404).json({ error: 'DM not found' });
  const mode = req.query.mode; // 'self' or 'both'
  if (mode === 'both') {
    db.dmChannels = db.dmChannels.filter(d => d.id !== dm.id);
    db.dmMessages = db.dmMessages.filter(m => m.dmChannelId !== dm.id);
    io.to('dm:' + dm.id).emit('dm-channel-deleted', { id: dm.id });
  } else {
    if (!dm.hiddenFor) dm.hiddenFor = [];
    if (!dm.hiddenFor.includes(req.user.id)) dm.hiddenFor.push(req.user.id);
    // Remember the timestamp — user won't see messages before this point
    if (!dm.clearedAt) dm.clearedAt = {};
    dm.clearedAt[req.user.id] = new Date().toISOString();
  }
  saveDB();
  res.json({ ok: true });
});

// Block/unblock user
app.post('/api/users/:id/block', auth, (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot block yourself' });
  const target = db.users.find(u => u.id === targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const blocker = db.users.find(u => u.id === req.user.id);
  if (!blocker.blockedUsers) blocker.blockedUsers = [];
  if (!blocker.blockedUsers.includes(targetId)) {
    blocker.blockedUsers.push(targetId);
    // Remove from friends
    db.friends = db.friends.filter(f => !(
      (f.userId === req.user.id && f.friendId === targetId) ||
      (f.userId === targetId && f.friendId === req.user.id)
    ));
    saveDB();
    // Notify blocked user in realtime
    const targetSockets = onlineUsers.get(targetId);
    if (targetSockets) {
      for (const sid of targetSockets) {
        io.to(sid).emit('blocked-by-user', { userId: req.user.id });
      }
    }
  }
  res.json({ ok: true });
});

app.post('/api/users/:id/unblock', auth, (req, res) => {
  const targetId = req.params.id;
  const blocker = db.users.find(u => u.id === req.user.id);
  if (blocker.blockedUsers) {
    blocker.blockedUsers = blocker.blockedUsers.filter(id => id !== targetId);
    saveDB();
  }
  res.json({ ok: true });
});

app.get('/api/blocked-users', auth, (req, res) => {
  const u = db.users.find(u => u.id === req.user.id);
  res.json(u?.blockedUsers || []);
});

app.get('/api/users/:id/profile', auth, (req, res) => {
  const u = db.users.find(u => u.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const realStatus = !onlineUsers.has(u.id) ? 'offline' : (u.status === 'invisible' ? 'offline' : (u.status || 'online'));
  res.json({ id: u.id, username: u.username, tag: u.tag, avatarColor: u.avatarColor, avatar: u.avatar || null, bio: u.bio || '', bannerColor: u.bannerColor || null, status: realStatus, createdAt: u.createdAt });
});

app.get('/api/blocked-by/:id', auth, (req, res) => {
  const target = db.users.find(u => u.id === req.params.id);
  if (!target) return res.json({ blocked: false });
  res.json({ blocked: (target.blockedUsers || []).includes(req.user.id) });
});

app.get('/api/blocked-users-details', auth, (req, res) => {
  const u = db.users.find(u => u.id === req.user.id);
  const ids = u?.blockedUsers || [];
  const details = ids.map(id => {
    const bu = db.users.find(x => x.id === id);
    return bu ? { id: bu.id, username: bu.username, tag: bu.tag, avatarColor: bu.avatarColor, avatar: bu.avatar || null } : null;
  }).filter(Boolean);
  res.json(details);
});

// ── Voice state tracking ──
const voiceState = new Map(); // channelId -> Map<userId, { socketId, username, avatarColor, tag, camera, screen }>
const dmCallState = new Map(); // dmChannelId -> { callerId, participants: Map<userId, { socketId, username, avatarColor, tag }>, startedAt, timeout }


function getVoiceUsers(channelId) {
  const map = voiceState.get(channelId);
  if (!map) return [];
  return [...map.values()].map(v => ({ id: v.userId, username: v.username, avatarColor: v.avatarColor, avatar: v.avatar || null, tag: v.tag, socketId: v.socketId, camera: v.camera || false, screen: v.screen || false, muted: v.muted || false, deafened: v.deafened || false }));
}

// API to get voice state for a server's channels
app.get('/api/servers/:id/voice', auth, (req, res) => {
  const channels = db.channels.filter(c => c.serverId === req.params.id && c.type === 'voice');
  const result = {};
  for (const ch of channels) {
    result[ch.id] = getVoiceUsers(ch.id);
  }
  res.json(result);
});

// ── Socket.io (handlers) ──
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Auth required'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.users.find(u => u.id === decoded.id);
    if (!user) return next(new Error('User not found'));
    socket.userId = user.id;
    socket.userData = { id: user.id, username: user.username, avatarColor: user.avatarColor, avatar: user.avatar || null, tag: user.tag || '0000' };
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const uid = socket.userId;

  // Track online status
  if (!onlineUsers.has(uid)) onlineUsers.set(uid, new Set());
  onlineUsers.get(uid).add(socket.id);

  // Join all server rooms this user is member of
  const userServers = db.members.filter(m => m.userId === uid).map(m => m.serverId);
  userServers.forEach(sid => socket.join('server:' + sid));

  // Join DM rooms
  db.dmChannels.filter(d => d.participants.includes(uid)).forEach(d => socket.join('dm:' + d.id));

  // Broadcast online status
  io.emit('user-online', { userId: uid });

  socket.on('join-channel', (channelId) => {
    socket.join('channel:' + channelId);
  });

  socket.on('leave-channel', (channelId) => {
    socket.leave('channel:' + channelId);
  });

  socket.on('send-message', ({ channelId, content, attachment, replyToId }) => {
    if (!channelId) return;
    const channel = db.channels.find(c => c.id === channelId);
    if (!channel) return;

    // Private channel check
    if (channel.isPrivate) {
      const server = db.servers.find(s => s.id === channel.serverId);
      const isOwner = server && server.ownerId === uid;
      const member = db.members.find(m => m.serverId === channel.serverId && m.userId === uid);
      const isAdmin = member && member.role === 'admin';
      const isAllowed = channel.allowedUsers && channel.allowedUsers.includes(uid);
      if (!isOwner && !isAdmin && !isAllowed) {
        socket.emit('message-error', { error: 'У вас нет доступа к этому каналу' });
        return;
      }
    }

    // Permission check
    if (channel.permissions) {
      const server = db.servers.find(s => s.id === channel.serverId);
      const member = db.members.find(m => m.serverId === channel.serverId && m.userId === uid);
      const isOwner = server && server.ownerId === uid;
      const role = (member && member.role === 'admin') ? 'admin' : 'user';
      if (!isOwner) {
        const perms = channel.permissions[role];
        if (perms && perms.sendMessages === false) {
          socket.emit('message-error', { error: 'У вас нет прав отправлять сообщения' });
          return;
        }
        if (attachment && perms && perms.sendMedia === false) {
          socket.emit('message-error', { error: 'У вас нет прав отправлять медиа' });
          return;
        }
      }
    }

    // Slowmode check
    if (channel.slowmode && channel.slowmode > 0) {
      const server = db.servers.find(s => s.id === channel.serverId);
      const member = db.members.find(m => m.serverId === channel.serverId && m.userId === uid);
      if (!memberHasPerm(server, member, 'bypassSlowmode')) {
        const lastMsg = [...db.messages].reverse().find(m => m.channelId === channelId && m.userId === uid && m.type !== 'system');
        if (lastMsg) {
          const elapsed = (Date.now() - new Date(lastMsg.createdAt).getTime()) / 1000;
          if (elapsed < channel.slowmode) {
            socket.emit('message-error', { error: `Медленный режим: подождите ${Math.ceil(channel.slowmode - elapsed)} сек.` });
            return;
          }
        }
      }
    }

    const text = (content || '').trim().slice(0, 1500);
    if (!text && !attachment) return;
    const id = 'm' + genId();
    const msg = {
      id,
      channelId,
      userId: uid,
      content: text,
      createdAt: new Date().toISOString(),
    };
    if (attachment) msg.attachment = attachment;
    if (replyToId) msg.replyToId = replyToId;
    db.messages.push(msg);
    saveDB();

    const fullMsg = { ...msg, user: socket.userData };
    if (replyToId) {
      const replyMsg = db.messages.find(m => m.id === replyToId);
      if (replyMsg) {
        const replyUser = db.users.find(u => u.id === replyMsg.userId);
        fullMsg.replyTo = { id: replyMsg.id, content: replyMsg.content, user: replyUser ? { id: replyUser.id, username: replyUser.username, avatarColor: replyUser.avatarColor } : null };
      }
    }
    io.to('channel:' + channelId).emit('new-message', fullMsg);
    // Notify all server members for unread tracking
    if (channel.serverId) {
      io.to('server:' + channel.serverId).emit('channel-message-notify', { channelId, serverId: channel.serverId, userId: uid, username: socket.userData?.username, avatarColor: socket.userData?.avatarColor, avatar: socket.userData?.avatar, content: text, attachment: !!attachment });
    }
  });

  socket.on('send-dm', ({ dmChannelId, content, attachment, replyToId }) => {
    if (!dmChannelId) return;
    const dm = db.dmChannels.find(d => d.id === dmChannelId && d.participants.includes(uid));
    if (!dm) return;
    // Block check: prevent DMs between blocked users
    const partnerId = dm.participants.find(p => p !== uid);
    const sender = db.users.find(u => u.id === uid);
    const partner = db.users.find(u => u.id === partnerId);
    if (sender?.blockedUsers?.includes(partnerId) || partner?.blockedUsers?.includes(uid)) return;
    // Unhide DM channel for both participants when new message is sent
    if (dm.hiddenFor) dm.hiddenFor = dm.hiddenFor.filter(id => id !== uid);
    const text = (content || '').trim().slice(0, 1500);
    if (!text && !attachment) return;
    const id = 'dm' + genId();
    const msg = { id, dmChannelId, userId: uid, content: text, createdAt: new Date().toISOString() };
    if (attachment) msg.attachment = attachment;
    if (replyToId) msg.replyToId = replyToId;
    db.dmMessages.push(msg);
    saveDB();
    const fullMsg = { ...msg, user: socket.userData };
    if (replyToId) {
      const replyMsg = db.dmMessages.find(m => m.id === replyToId);
      if (replyMsg) {
        const replyUser = db.users.find(u => u.id === replyMsg.userId);
        fullMsg.replyTo = { id: replyMsg.id, content: replyMsg.content, user: replyUser ? { id: replyUser.id, username: replyUser.username, avatarColor: replyUser.avatarColor } : null };
      }
    }
    io.to('dm:' + dmChannelId).emit('new-dm', fullMsg);
  });

  socket.on('join-dm', (dmChannelId) => {
    socket.join('dm:' + dmChannelId);
  });

  socket.on('typing', ({ channelId }) => {
    socket.to('channel:' + channelId).emit('user-typing', { channelId, user: socket.userData });
  });

  // ── Voice channel events ──
  socket.on('voice-join', ({ channelId }) => {
    const channel = db.channels.find(c => c.id === channelId && c.type === 'voice');
    if (!channel) return;

    // Leave any current voice channel first
    for (const [chId, users] of voiceState) {
      if (users.has(uid)) {
        users.delete(uid);
        if (users.size === 0) voiceState.delete(chId);
        const oldCh = db.channels.find(c => c.id === chId);
        if (oldCh) io.to('server:' + oldCh.serverId).emit('voice-state-update', { channelId: chId, users: getVoiceUsers(chId) });
      }
    }

    // Join new voice channel
    if (!voiceState.has(channelId)) voiceState.set(channelId, new Map());
    voiceState.get(channelId).set(uid, { userId: uid, socketId: socket.id, username: socket.userData.username, avatarColor: socket.userData.avatarColor, avatar: socket.userData.avatar, tag: socket.userData.tag });
    socket.join('voice:' + channelId);
    io.to('server:' + channel.serverId).emit('voice-state-update', { channelId, users: getVoiceUsers(channelId) });
    // Sound notification for others in the channel
    socket.to('voice:' + channelId).emit('voice-sound', { type: 'join', userId: uid });

    // Notify existing voice users to set up WebRTC connections with the new user
    const existingUsers = getVoiceUsers(channelId).filter(u => u.id !== uid);
    socket.emit('voice-peers', { channelId, peers: existingUsers });
  });

  // Handle reconnection while in voice — update socketId
  socket.on('rejoin-voice', ({ channelId }) => {
    if (!channelId) return;
    const channel = db.channels.find(c => c.id === channelId && c.type === 'voice');
    if (!channel) return;
    const users = voiceState.get(channelId);
    if (users && users.has(uid)) {
      // Update socket ID for the reconnected user
      const userData = users.get(uid);
      const oldSocketId = userData.socketId;
      userData.socketId = socket.id;
      socket.join('voice:' + channelId);
      io.to('server:' + channel.serverId).emit('voice-state-update', { channelId, users: getVoiceUsers(channelId) });
      // Re-send peers list so client can re-establish WebRTC
      const existingUsers = getVoiceUsers(channelId).filter(u => u.id !== uid);
      socket.emit('voice-peers', { channelId, peers: existingUsers });
    }
  });

  socket.on('voice-leave', () => {
    for (const [chId, users] of voiceState) {
      if (users.has(uid)) {
        // Sound notification before removing
        socket.to('voice:' + chId).emit('voice-sound', { type: 'leave', userId: uid });
        users.delete(uid);
        socket.leave('voice:' + chId);
        if (users.size === 0) voiceState.delete(chId);
        const ch = db.channels.find(c => c.id === chId);
        if (ch) io.to('server:' + ch.serverId).emit('voice-state-update', { channelId: chId, users: getVoiceUsers(chId) });
        break;
      }
    }
  });

  // Voice mute/deafen state
  socket.on('voice-mute-state', ({ muted, deafened }) => {
    for (const [chId, users] of voiceState) {
      if (users.has(uid)) {
        const userData = users.get(uid);
        userData.muted = !!muted;
        userData.deafened = !!deafened;
        const ch = db.channels.find(c => c.id === chId);
        if (ch) io.to('server:' + ch.serverId).emit('voice-state-update', { channelId: chId, users: getVoiceUsers(chId) });
        // Sound notification for others
        socket.to('voice:' + chId).emit('voice-sound', { type: muted ? 'mute' : 'unmute', userId: uid });
        break;
      }
    }
  });

  // Voice video state (camera/screen share)
  socket.on('voice-video-state', ({ camera, screen }) => {
    for (const [chId, users] of voiceState) {
      if (users.has(uid)) {
        const userData = users.get(uid);
        userData.camera = camera;
        userData.screen = screen;
        socket.to('voice:' + chId).emit('voice-video-state', { userId: uid, camera, screen });
        const ch = db.channels.find(c => c.id === chId);
        if (ch) io.to('server:' + ch.serverId).emit('voice-state-update', { channelId: chId, users: getVoiceUsers(chId) });
        break;
      }
    }
  });

  // WebRTC signaling
  socket.on('voice-offer', ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit('voice-offer', { fromSocketId: socket.id, fromUserId: uid, offer });
  });

  socket.on('voice-answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('voice-answer', { fromSocketId: socket.id, answer });
  });

  socket.on('voice-ice-candidate', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('voice-ice-candidate', { fromSocketId: socket.id, candidate });
  });

  // ── DM Call events ──
  socket.on('dm-call-start', ({ dmChannelId }) => {
    if (!dmChannelId) return;
    const dm = db.dmChannels.find(d => d.id === dmChannelId && d.participants.includes(uid));
    if (!dm) return;
    if (dmCallState.has(dmChannelId)) return; // call already active
    const partnerId = dm.participants.find(p => p !== uid);
    const partner = db.users.find(u => u.id === partnerId);
    if (!partner) return;
    // Block check
    const sender = db.users.find(u => u.id === uid);
    if (sender?.blockedUsers?.includes(partnerId) || partner?.blockedUsers?.includes(uid)) return;
    // Leave any server voice channel first
    for (const [chId, users] of voiceState) {
      if (users.has(uid)) {
        users.delete(uid);
        if (users.size === 0) voiceState.delete(chId);
        const ch = db.channels.find(c => c.id === chId);
        if (ch) io.to('server:' + ch.serverId).emit('voice-state-update', { channelId: chId, users: getVoiceUsers(chId) });
      }
    }
    // Create call state
    const participants = new Map();
    participants.set(uid, { socketId: socket.id, username: socket.userData.username, avatarColor: socket.userData.avatarColor, avatar: socket.userData.avatar, tag: socket.userData.tag });
    const timeout = setTimeout(() => {
      // No answer after 30s
      if (dmCallState.has(dmChannelId)) {
        const call = dmCallState.get(dmChannelId);
        dmCallState.delete(dmChannelId);
        for (const [pId, p] of call.participants) {
          io.to(p.socketId).emit('dm-call-ended', { dmChannelId, reason: 'no-answer' });
        }
        // Also notify partner
        const partnerSockets = onlineUsers.get(partnerId);
        if (partnerSockets) partnerSockets.forEach(sid => io.to(sid).emit('dm-call-ended', { dmChannelId, reason: 'no-answer' }));
        // System message
        const msgId = 'dm' + genId();
        const sysMsg = { id: msgId, dmChannelId, userId: uid, content: '', type: 'dm-call-missed', createdAt: new Date().toISOString() };
        db.dmMessages.push(sysMsg);
        saveDB();
        io.to('dm:' + dmChannelId).emit('new-dm', { ...sysMsg, user: socket.userData });
      }
    }, 30000);
    dmCallState.set(dmChannelId, { callerId: uid, participants, startedAt: null, timeout });
    // Notify partner
    const partnerSockets = onlineUsers.get(partnerId);
    if (partnerSockets) {
      partnerSockets.forEach(sid => {
        io.to(sid).emit('dm-call-incoming', { dmChannelId, caller: { id: uid, username: socket.userData.username, avatarColor: socket.userData.avatarColor, avatar: socket.userData.avatar, tag: socket.userData.tag } });
      });
    }
  });

  socket.on('dm-call-accept', ({ dmChannelId }) => {
    if (!dmChannelId) return;
    const call = dmCallState.get(dmChannelId);
    if (!call) return;
    if (call.callerId === uid) return; // caller can't accept own call
    const dm = db.dmChannels.find(d => d.id === dmChannelId && d.participants.includes(uid));
    if (!dm) return;
    // Leave any server voice channel
    for (const [chId, users] of voiceState) {
      if (users.has(uid)) {
        users.delete(uid);
        if (users.size === 0) voiceState.delete(chId);
        const ch = db.channels.find(c => c.id === chId);
        if (ch) io.to('server:' + ch.serverId).emit('voice-state-update', { channelId: chId, users: getVoiceUsers(chId) });
      }
    }
    // Clear no-answer timeout
    if (call.timeout) clearTimeout(call.timeout);
    call.timeout = null;
    call.startedAt = new Date();
    // Add callee to participants
    call.participants.set(uid, { socketId: socket.id, username: socket.userData.username, avatarColor: socket.userData.avatarColor, avatar: socket.userData.avatar, tag: socket.userData.tag });
    // Notify both sides with peer info for WebRTC
    for (const [pId, p] of call.participants) {
      const peers = [];
      for (const [otherId, other] of call.participants) {
        if (otherId !== pId) peers.push({ id: otherId, socketId: other.socketId, username: other.username, avatarColor: other.avatarColor, avatar: other.avatar, tag: other.tag });
      }
      io.to(p.socketId).emit('dm-call-accepted', { dmChannelId, peers });
    }
  });

  socket.on('dm-call-reject', ({ dmChannelId }) => {
    if (!dmChannelId) return;
    const call = dmCallState.get(dmChannelId);
    if (!call) return;
    if (call.timeout) clearTimeout(call.timeout);
    dmCallState.delete(dmChannelId);
    // Notify all participants
    for (const [pId, p] of call.participants) {
      io.to(p.socketId).emit('dm-call-ended', { dmChannelId, reason: 'rejected' });
    }
  });

  socket.on('dm-call-end', ({ dmChannelId }) => {
    if (!dmChannelId) return;
    const call = dmCallState.get(dmChannelId);
    if (!call) return;
    if (call.timeout) clearTimeout(call.timeout);
    const duration = call.startedAt ? Math.round((Date.now() - call.startedAt.getTime()) / 1000) : 0;
    dmCallState.delete(dmChannelId);
    // Notify all participants
    for (const [pId, p] of call.participants) {
      io.to(p.socketId).emit('dm-call-ended', { dmChannelId, reason: 'ended', duration });
    }
    // System message: call ended
    const msgId = 'dm' + genId();
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const durationStr = mins > 0 ? `${mins} мин. ${secs} сек.` : `${secs} сек.`;
    const sysMsg = { id: msgId, dmChannelId, userId: uid, content: durationStr, type: 'dm-call-end', createdAt: new Date().toISOString() };
    db.dmMessages.push(sysMsg);
    saveDB();
    io.to('dm:' + dmChannelId).emit('new-dm', { ...sysMsg, user: socket.userData });
  });

  socket.on('disconnect', () => {
    // Delay DM call cleanup
    setTimeout(() => {
      const currentSockets = onlineUsers.get(uid);
      if (currentSockets && currentSockets.size > 0) return;
      for (const [dmChId, call] of dmCallState) {
        if (call.participants.has(uid)) {
          if (call.timeout) clearTimeout(call.timeout);
          const duration = call.startedAt ? Math.round((Date.now() - call.startedAt.getTime()) / 1000) : 0;
          dmCallState.delete(dmChId);
          for (const [pId, p] of call.participants) {
            if (pId !== uid) io.to(p.socketId).emit('dm-call-ended', { dmChannelId: dmChId, reason: 'disconnected', duration });
          }
          break;
        }
      }
    }, 15000);

    // Delay voice cleanup to allow reconnection (15 seconds grace period)
    setTimeout(() => {
      // Check if user reconnected (has a new socket in onlineUsers)
      const currentSockets = onlineUsers.get(uid);
      if (currentSockets && currentSockets.size > 0) return; // User reconnected, skip cleanup

      for (const [chId, users] of voiceState) {
        if (users.has(uid)) {
          users.delete(uid);
          if (users.size === 0) voiceState.delete(chId);
          const ch = db.channels.find(c => c.id === chId);
          if (ch) io.to('server:' + ch.serverId).emit('voice-state-update', { channelId: chId, users: getVoiceUsers(chId) });
          break;
        }
      }
    }, 15000);

    const sockets = onlineUsers.get(uid);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        // Delay offline broadcast to allow reconnection
        setTimeout(() => {
          const current = onlineUsers.get(uid);
          if (!current || current.size === 0) {
            onlineUsers.delete(uid);
            io.emit('user-offline', { userId: uid });
          }
        }, 5000);
      }
    }
  });
});

// Static legal pages
app.get('/terms', (req, res) => { const f = join(__dirname, 'dist', 'terms.html'); existsSync(f) ? res.sendFile(f) : res.status(404).send('Not found') });
app.get('/privacy', (req, res) => { const f = join(__dirname, 'dist', 'privacy.html'); existsSync(f) ? res.sendFile(f) : res.status(404).send('Not found') });

// SPA fallback — serve index.html for non-API routes
if (existsSync(join(__dirname, 'dist', 'index.html'))) {
  app.get('*', (req, res) => {
    res.sendFile(join(__dirname, 'dist', 'index.html'));
  });
}

// ── Start ──
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Буст running on http://localhost:${PORT}`);
});
