const express = require('express');
const https = require('https');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = 3443;

// === Status constants (prevent typos) ===
const STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  ALLOTTED: 'allotted',
  NOT_ALLOTTED: 'not_allotted',
};

// === Directories ===
const PHOTOS_DIR = path.join(__dirname, 'photos');
const BACKUPS_DIR = path.join(__dirname, 'backups');
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// === Encryption Key (persisted to file) ===
const KEY_FILE = path.join(__dirname, '.encryption_key');
let ENC_KEY;
if (fs.existsSync(KEY_FILE)) {
  ENC_KEY = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
} else {
  ENC_KEY = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, ENC_KEY.toString('hex'), { mode: 0o600 });
  console.log('Generated new encryption key (.encryption_key)');
}

// === Database ===
const DB_PATH = path.join(__dirname, 'cro_lucky_dip.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS pilgrims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    enrollment_no INTEGER,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    aadhaar_hash TEXT NOT NULL,
    aadhaar_encrypted TEXT NOT NULL,
    aadhaar_masked TEXT NOT NULL,
    id_type TEXT DEFAULT 'aadhaar',
    seva TEXT NOT NULL,
    photo_file TEXT,
    face_descriptor TEXT,
    status TEXT DEFAULT 'pending',
    allotment_status TEXT,
    created_at TEXT,
    confirmed_at TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS seva_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seva_name TEXT NOT NULL,
    slots INTEGER NOT NULL DEFAULT 50,
    enabled INTEGER NOT NULL DEFAULT 0,
    draw_date TEXT NOT NULL,
    drawn_at TEXT,
    UNIQUE(seva_name, draw_date)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS operators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT
  )
`);

// === Sessions table (persistent across restarts) ===
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    operator_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (operator_id) REFERENCES operators(id)
  )
`);

// === Audit log table ===
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operator_id INTEGER,
    operator_name TEXT,
    action TEXT NOT NULL,
    details TEXT,
    target_token TEXT,
    created_at TEXT NOT NULL
  )
`);

// === Indexes for performance ===
db.exec(`CREATE INDEX IF NOT EXISTS idx_pilgrims_created_at ON pilgrims(created_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pilgrims_token ON pilgrims(token)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pilgrims_aadhaar_hash ON pilgrims(aadhaar_hash)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pilgrims_seva_status ON pilgrims(seva, status, created_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pilgrims_allotment ON pilgrims(allotment_status, created_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pilgrims_status_created ON pilgrims(status, created_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pilgrims_enrollment ON pilgrims(enrollment_no, created_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`);

// === Migrate old schema if needed ===
try {
  const cols = db.prepare("PRAGMA table_info(pilgrims)").all().map(c => c.name);
  if (cols.includes('aadhaar') && !cols.includes('aadhaar_hash')) {
    console.log('Migrating old schema: encrypting Aadhaar data...');
    db.exec('ALTER TABLE pilgrims ADD COLUMN aadhaar_hash TEXT');
    db.exec('ALTER TABLE pilgrims ADD COLUMN aadhaar_encrypted TEXT');
    db.exec('ALTER TABLE pilgrims ADD COLUMN aadhaar_masked TEXT');
    db.exec('ALTER TABLE pilgrims ADD COLUMN allotment_status TEXT');
    if (!cols.includes('photo_file')) {
      db.exec('ALTER TABLE pilgrims ADD COLUMN photo_file TEXT');
    }
    const rows = db.prepare('SELECT id, aadhaar, id_type, photo FROM pilgrims').all();
    const updateStmt = db.prepare('UPDATE pilgrims SET aadhaar_hash=?, aadhaar_encrypted=?, aadhaar_masked=? WHERE id=?');
    const updatePhoto = db.prepare('UPDATE pilgrims SET photo_file=? WHERE id=?');
    for (const row of rows) {
      if (row.aadhaar) {
        const hash = hashId(row.aadhaar);
        const enc = encrypt(row.aadhaar);
        const masked = maskId(row.aadhaar, row.id_type || 'aadhaar');
        updateStmt.run(hash, enc, masked, row.id);
      }
      if (row.photo) {
        const token = db.prepare('SELECT token FROM pilgrims WHERE id=?').get(row.id);
        if (token) {
          const filename = `${token.token}.jpg`;
          const base64Data = row.photo.replace(/^data:image\/\w+;base64,/, '');
          fs.writeFileSync(path.join(PHOTOS_DIR, filename), Buffer.from(base64Data, 'base64'));
          updatePhoto.run(filename, row.id);
        }
      }
    }
    console.log(`Migrated ${rows.length} records`);
  }
  const cols2 = db.prepare("PRAGMA table_info(pilgrims)").all().map(c => c.name);
  if (!cols2.includes('allotment_status')) {
    try { db.exec('ALTER TABLE pilgrims ADD COLUMN allotment_status TEXT'); } catch(e) {}
  }
  if (!cols2.includes('face_descriptor')) {
    try { db.exec('ALTER TABLE pilgrims ADD COLUMN face_descriptor TEXT'); } catch(e) {}
  }
} catch (e) {
  console.log('Migration note:', e.message);
}

// Add enabled column to seva_config if missing
try {
  const sevaCols = db.prepare("PRAGMA table_info(seva_config)").all().map(c => c.name);
  if (!sevaCols.includes('enabled')) {
    db.exec('ALTER TABLE seva_config ADD COLUMN enabled INTEGER DEFAULT 0');
    console.log('Added enabled column to seva_config');
  }
} catch (e) {
  console.log('seva_config migration note:', e.message);
}

// === Password hashing (scrypt, built-in) ===
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored.includes(':')) {
    const legacyHash = crypto.createHash('sha256').update(password).digest('hex');
    return legacyHash === stored;
  }
  const [salt, hash] = stored.split(':');
  const testHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return testHash === hash;
}

function isLegacyHash(stored) {
  return !stored.includes(':');
}

// === Default operator account ===
const defaultOp = db.prepare('SELECT id FROM operators WHERE username = ?').get('admin');
if (!defaultOp) {
  const hash = hashPassword('ttd@cro2024');
  db.prepare('INSERT INTO operators (username, password_hash, created_at) VALUES (?, ?, ?)').run('admin', hash, nowIST());
  console.log('Default operator created — username: admin (change password after first login)');
}

// === Crypto helpers ===
function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${enc}`;
}

function hashId(id) {
  return crypto.createHash('sha256').update(id.trim().toUpperCase()).digest('hex');
}

function maskId(id, type) {
  if (type === 'passport') return id.slice(0, 1) + 'XXXXX' + id.slice(-2);
  return 'XXXX-XXXX-' + id.slice(-4);
}

// === IST helpers ===
function nowIST() {
  const d = new Date();
  const opts = { timeZone: 'Asia/Kolkata' };
  const day = d.toLocaleDateString('en-GB', { ...opts, day: '2-digit' });
  const month = d.toLocaleDateString('en-GB', { ...opts, month: '2-digit' });
  const year = d.toLocaleDateString('en-GB', { ...opts, year: 'numeric' });
  const time = d.toLocaleTimeString('en-IN', { ...opts, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  return `${day}/${month}/${year}, ${time}`;
}

function todayIST() {
  const d = new Date();
  const opts = { timeZone: 'Asia/Kolkata' };
  const day = d.toLocaleDateString('en-GB', { ...opts, day: '2-digit' });
  const month = d.toLocaleDateString('en-GB', { ...opts, month: '2-digit' });
  const year = d.toLocaleDateString('en-GB', { ...opts, year: 'numeric' });
  return `${day}/${month}/${year}`;
}

function generateToken() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// Validate date format DD/MM/YYYY
function isValidDate(str) {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(str);
}

// === Audit logging ===
function logAudit(operatorId, operatorName, action, details, targetToken) {
  db.prepare('INSERT INTO audit_log (operator_id, operator_name, action, details, target_token, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    operatorId || null, operatorName || 'system', action, details || null, targetToken || null, nowIST()
  );
}

// === Session management (SQLite-backed) ===
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000; // 12 hours

function createSession(operatorId, username) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DURATION_MS);
  db.prepare('INSERT INTO sessions (token, operator_id, username, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    token, operatorId, username, now.toISOString(), expires.toISOString()
  );
  return token;
}

function getSession(token) {
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: session.operator_id, username: session.username };
}

function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Clean expired sessions every 30 minutes
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}, 30 * 60 * 1000);

// Clean expired sessions on startup
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());

function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.auth_token;
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized. Please login.' });
  }
  req.operator = session;
  next();
}

// === Express setup ===

// Trust Railway's proxy headers (X-Forwarded-Proto, X-Forwarded-For)
if (process.env.RAILWAY_ENVIRONMENT) {
  app.set('trust proxy', true);
}

// Redirect HTTP → HTTPS for non-localhost, non-Railway requests (local LAN phones need HTTPS for GPS)
app.use((req, res, next) => {
  if (!process.env.RAILWAY_ENVIRONMENT && !req.secure && !isLocalhostRequest(req)) {
    const httpsUrl = `https://${req.hostname}:${HTTPS_PORT}${req.originalUrl}`;
    return res.redirect(301, httpsUrl);
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// === SEVAS list ===
const SEVAS = [
  'Suprabhatam', 'Thomala Seva', 'Archana',
  'Astadala Pada Padmaradhana', 'Vishesha Pooja',
  'Sahasra Deepalankara Seva', 'Nijapada Darshanam'
];

// === GEOFENCING CONFIG ===
const GEO_FENCE = {
  enabled: true,
  lat: 13.641483,
  lng: 79.419905,
  radius_meters: 50000,  // 50km radius
};

// Haversine distance between two GPS points (returns meters)
function geoDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Helper: check if request is from localhost
function isLocalhostRequest(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
}

// Public endpoint: returns geo config for client-side check
// Only sends enabled/radius to non-localhost (client uses browser GPS to compare)
app.get('/api/geo-config', (req, res) => {
  if (isLocalhostRequest(req)) {
    return res.json({ enabled: false });
  }
  res.json({
    enabled: GEO_FENCE.enabled,
    lat: GEO_FENCE.lat,
    lng: GEO_FENCE.lng,
    radius: GEO_FENCE.radius_meters
  });
});

// Public endpoint: available sevas for today
app.get('/api/registration-status', (req, res) => {
  const today = todayIST();

  const enabledSevas = db.prepare(
    'SELECT seva_name, slots FROM seva_config WHERE draw_date = ? AND enabled = 1'
  ).all(today);

  res.json({
    available_sevas: enabledSevas.map(s => s.seva_name),
    date: today
  });
});

// ===================== AUTH ROUTES =====================

// Login rate limiter (separate from registration)
const loginRateLimit = new Map();
const LOGIN_RATE_WINDOW = 300000; // 5 minutes
const LOGIN_RATE_MAX = 10; // 10 attempts per 5 min

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginRateLimit.get(ip);
  if (!entry || now - entry.start > LOGIN_RATE_WINDOW) {
    loginRateLimit.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= LOGIN_RATE_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginRateLimit) {
    if (now - entry.start > LOGIN_RATE_WINDOW) loginRateLimit.delete(ip);
  }
}, 300000);

app.post('/api/login', (req, res) => {
  if (!checkLoginRateLimit(req.ip)) {
    return res.status(429).json({ error: 'Too many login attempts. Please wait 5 minutes.' });
  }

  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const op = db.prepare('SELECT id, username, password_hash FROM operators WHERE username = ?').get(username);
  if (!op || !verifyPassword(password, op.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Auto-migrate legacy SHA-256 hash to scrypt on successful login
  if (isLegacyHash(op.password_hash)) {
    const newHash = hashPassword(password);
    db.prepare('UPDATE operators SET password_hash = ? WHERE id = ?').run(newHash, op.id);
  }

  const sessionToken = createSession(op.id, op.username);
  logAudit(op.id, op.username, 'login', 'Operator logged in');
  res.json({ token: sessionToken, username: op.username });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  const session = getSession(token);
  if (session) logAudit(session.id, session.username, 'logout', 'Operator logged out');
  deleteSession(token);
  res.json({ success: true });
});

app.post('/api/change-password', authMiddleware, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const op = db.prepare('SELECT password_hash FROM operators WHERE id = ?').get(req.operator.id);
  if (!op || !verifyPassword(current_password, op.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const newHash = hashPassword(new_password);
  db.prepare('UPDATE operators SET password_hash = ? WHERE id = ?').run(newHash, req.operator.id);
  logAudit(req.operator.id, req.operator.username, 'change_password', 'Password changed');
  res.json({ success: true });
});

// ===================== RATE LIMITING (registration) =====================
const rateLimit = new Map();
const RATE_WINDOW = 60000;
const RATE_MAX = 5;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimit.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW) {
    rateLimit.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimit) {
    if (now - entry.start > RATE_WINDOW) rateLimit.delete(ip);
  }
}, 300000);

// ===================== PILGRIM REGISTRATION (PUBLIC) =====================

app.post('/api/register', async (req, res) => {
  if (!checkRateLimit(req.ip)) {
    return res.status(429).json({ error: 'Too many registrations. Please wait a minute and try again.' });
  }

  const { name, phone, id_number, id_type, seva, geo_lat, geo_lng } = req.body;

  // Geofencing check (skip for localhost/dev)
  if (GEO_FENCE.enabled && !isLocalhostRequest(req)) {
    if (geo_lat == null || geo_lng == null || typeof geo_lat !== 'number' || typeof geo_lng !== 'number') {
      return res.status(403).json({ error: 'Location access is required for registration. Please enable GPS and allow location access.' });
    }
    const dist = geoDistance(GEO_FENCE.lat, GEO_FENCE.lng, geo_lat, geo_lng);
    if (dist > GEO_FENCE.radius_meters) {
      return res.status(403).json({ error: `Registration is only allowed within ${GEO_FENCE.radius_meters}m of the CRO office. You are ${Math.round(dist)}m away.` });
    }
  }

  if (!name || !phone || !id_number || !id_type || !seva) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 100) {
    return res.status(400).json({ error: 'Name is required and must be under 100 characters' });
  }
  if (!SEVAS.includes(seva)) {
    return res.status(400).json({ error: 'Invalid seva selection' });
  }
  // Check if seva is enabled for today's registration
  if (!db.prepare('SELECT 1 FROM seva_config WHERE seva_name = ? AND draw_date = ? AND enabled = 1').get(seva, todayIST())) {
    return res.status(400).json({ error: 'This seva is not available for registration today.' });
  }
  if (!/^\d{10}$/.test(phone)) {
    return res.status(400).json({ error: 'Phone must be 10 digits' });
  }
  if (!['aadhaar', 'passport'].includes(id_type)) {
    return res.status(400).json({ error: 'Invalid ID proof type' });
  }
  if (id_type === 'aadhaar' && !/^\d{12}$/.test(id_number)) {
    return res.status(400).json({ error: 'Aadhaar must be 12 digits' });
  }
  if (id_type === 'passport' && !/^[A-Z]\d{7}$/i.test(id_number)) {
    return res.status(400).json({ error: 'Passport must be 1 letter followed by 7 digits' });
  }

  const today = todayIST();
  const idHash = hashId(id_number);

  const existing = db.prepare(
    "SELECT seva, token FROM pilgrims WHERE aadhaar_hash = ? AND created_at LIKE ?"
  ).get(idHash, `${today}%`);

  if (existing) {
    return res.status(409).json({
      error: `You have already registered for "${existing.seva}" today (Token: ${existing.token}). Only one seva per day is allowed.`
    });
  }

  const idEncrypted = encrypt(id_number.trim().toUpperCase());
  const idMasked = maskId(id_number.trim().toUpperCase(), id_type);
  const createdAt = nowIST();

  // Wrap token generation + enrollment number + INSERT in a transaction to prevent race conditions
  const registerTransaction = db.transaction(() => {
    let token;
    let tokenUnique = false;
    for (let i = 0; i < 10; i++) {
      token = generateToken();
      if (!db.prepare('SELECT id FROM pilgrims WHERE token = ?').get(token)) { tokenUnique = true; break; }
    }
    if (!tokenUnique) return null;

    const last = db.prepare("SELECT MAX(enrollment_no) as m FROM pilgrims WHERE created_at LIKE ?").get(`${today}%`);
    const enrollmentNo = (last.m || 0) + 1;

    db.prepare(`INSERT INTO pilgrims
      (token, enrollment_no, name, phone, aadhaar_hash, aadhaar_encrypted, aadhaar_masked, id_type, seva, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(token, enrollmentNo, name.trim(), phone.trim(), idHash, idEncrypted, idMasked, id_type, seva, createdAt);

    return { token, enrollmentNo };
  });

  const result = registerTransaction();
  if (!result) {
    return res.status(500).json({ error: 'Unable to generate unique token. Please try again.' });
  }

  const qrDataUrl = await QRCode.toDataURL(result.token, { width: 200, margin: 2, color: { dark: '#c0392b' } });
  res.json({ token: result.token, enrollment_no: result.enrollmentNo, qr: qrDataUrl });
});

// ===================== PILGRIM STATUS CHECK (PUBLIC) =====================

app.get('/api/status/:token', (req, res) => {
  const pilgrim = db.prepare(
    'SELECT token, enrollment_no, name, seva, status, allotment_status, created_at FROM pilgrims WHERE token = ?'
  ).get(req.params.token.toUpperCase());

  if (!pilgrim) return res.status(404).json({ error: 'Token not found' });
  res.json(pilgrim);
});

// ===================== OPERATOR ROUTES (AUTH REQUIRED) =====================

// Lookup pilgrim by token
app.get('/api/pilgrim/:token', authMiddleware, (req, res) => {
  const pilgrim = db.prepare(
    'SELECT id, token, enrollment_no, name, phone, aadhaar_hash, aadhaar_masked, id_type, seva, photo_file, status, allotment_status, created_at FROM pilgrims WHERE token = ?'
  ).get(req.params.token.toUpperCase());

  if (!pilgrim) return res.status(404).json({ error: 'Token not found' });

  const today = todayIST();
  const otherSeva = db.prepare(
    `SELECT seva, token FROM pilgrims WHERE aadhaar_hash = ? AND token != ? AND status = '${STATUS.CONFIRMED}' AND created_at LIKE ?`
  ).get(pilgrim.aadhaar_hash, pilgrim.token, `${today}%`);

  if (otherSeva) {
    pilgrim.duplicate_warning = `This pilgrim already has a confirmed seva today: "${otherSeva.seva}" (Token: ${otherSeva.token})`;
  }

  // Don't leak aadhaar_hash to client
  delete pilgrim.aadhaar_hash;
  res.json(pilgrim);
});

// Helper: compute euclidean distance between two face descriptor arrays
function faceDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

const FACE_MATCH_THRESHOLD = 0.4; // below this = same person (strict: reduces false positives)

// === Face descriptor cache (avoids re-querying + JSON.parse on every request) ===
let faceCache = { date: '', descriptors: [] };

function getFaceCacheToday() {
  const today = todayIST();
  if (faceCache.date !== today) {
    faceCache = { date: today, descriptors: [] };
    reloadFaceCache(today);
  }
  return faceCache.descriptors;
}

function reloadFaceCache(today) {
  if (!today) today = todayIST();
  const rows = db.prepare(
    `SELECT token, name, seva, face_descriptor FROM pilgrims WHERE status = '${STATUS.CONFIRMED}' AND face_descriptor IS NOT NULL AND created_at LIKE ?`
  ).all(`${today}%`);

  faceCache.date = today;
  faceCache.descriptors = [];
  for (const p of rows) {
    try {
      const parsed = JSON.parse(p.face_descriptor);
      if (Array.isArray(parsed) && parsed.length === 128) {
        faceCache.descriptors.push({ token: p.token, name: p.name, seva: p.seva, descriptor: parsed });
      }
    } catch (e) {
      console.warn(`Corrupt face descriptor for token ${p.token}, skipping`);
    }
  }
}

function addToFaceCache(token, name, seva, descriptor) {
  const today = todayIST();
  if (faceCache.date !== today) {
    reloadFaceCache(today);
  }
  if (Array.isArray(descriptor) && descriptor.length === 128) {
    faceCache.descriptors.push({ token, name, seva, descriptor });
  }
}

function findFaceMatch(descriptor) {
  const cached = getFaceCacheToday();
  for (const p of cached) {
    const dist = faceDistance(descriptor, p.descriptor);
    if (dist < FACE_MATCH_THRESHOLD) {
      return { token: p.token, name: p.name, seva: p.seva, distance: dist.toFixed(3) };
    }
  }
  return null;
}

// Live face check endpoint (lightweight — no photo, just descriptor)
app.post('/api/face-check', authMiddleware, (req, res) => {
  const { face_descriptor } = req.body;
  if (!face_descriptor || !Array.isArray(face_descriptor) || face_descriptor.length !== 128) {
    return res.json({ match: false });
  }

  const match = findFaceMatch(face_descriptor);
  if (match) {
    return res.json({ match: true, token: match.token, name: match.name, seva: match.seva, distance: match.distance });
  }
  res.json({ match: false });
});

// Confirm pilgrim with photo + face descriptor
app.post('/api/confirm/:token', authMiddleware, (req, res) => {
  const { photo, face_descriptor, force_confirm } = req.body;
  if (!photo) return res.status(400).json({ error: 'Photo is required for verification' });

  const token = req.params.token.toUpperCase();
  const hasValidDescriptor = face_descriptor && Array.isArray(face_descriptor) && face_descriptor.length === 128;

  const pilgrimCheck = db.prepare(`SELECT id, seva FROM pilgrims WHERE token = ? AND status = '${STATUS.PENDING}'`).get(token);
  if (!pilgrimCheck) {
    return res.status(404).json({ error: 'Token not found or already confirmed' });
  }

  // Face dedup check: compare against cached descriptors of confirmed pilgrims today
  let faceMatch = null;
  if (hasValidDescriptor && !force_confirm) {
    faceMatch = findFaceMatch(face_descriptor);
  }

  // If face match found and not force-confirmed, return warning
  if (faceMatch) {
    return res.status(409).json({
      face_match: true,
      match_token: faceMatch.token,
      match_name: faceMatch.name,
      match_seva: faceMatch.seva,
      match_distance: faceMatch.distance,
      message: `Face matches already-confirmed pilgrim "${faceMatch.name}" (Token: ${faceMatch.token}, Seva: ${faceMatch.seva}). This may be the same person registering multiple times.`
    });
  }

  const confirmedAt = nowIST();
  const photoFilename = `${token}.jpg`;
  const base64Data = photo.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(path.join(PHOTOS_DIR, photoFilename), Buffer.from(base64Data, 'base64'));

  // Store face descriptor as JSON string
  const descriptorJson = hasValidDescriptor ? JSON.stringify(face_descriptor) : null;

  db.prepare(
    `UPDATE pilgrims SET status = '${STATUS.CONFIRMED}', photo_file = ?, face_descriptor = ?, confirmed_at = ? WHERE token = ? AND status = '${STATUS.PENDING}'`
  ).run(photoFilename, descriptorJson, confirmedAt, token);

  const pilgrim = db.prepare(
    'SELECT token, enrollment_no, name, phone, aadhaar_masked, id_type, seva, created_at, confirmed_at FROM pilgrims WHERE token = ?'
  ).get(token);

  // Add to face cache so next face-check picks it up immediately
  if (hasValidDescriptor) {
    addToFaceCache(token, pilgrim.name, pilgrim.seva, face_descriptor);
  }

  const forceNote = force_confirm ? ' (force-confirmed despite face match warning)' : '';
  logAudit(req.operator.id, req.operator.username, 'confirm_pilgrim', `Confirmed pilgrim: ${pilgrim.name} for ${pilgrim.seva}${forceNote}`, token);

  res.json({ success: true, pilgrim, photo_url: `/api/photo/${photoFilename}` });
});

// Serve pilgrim photo (authenticated)
app.get('/api/photo/:filename', authMiddleware, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(PHOTOS_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Photo not found' });
  res.sendFile(filepath);
});

// List pilgrims (paginated, server-side search, date-filterable)
app.get('/api/pilgrims', authMiddleware, (req, res) => {
  const { status, search, page = 1, limit = 100, date } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  const offset = (pageNum - 1) * lim;

  const targetDate = (date && isValidDate(date)) ? date : todayIST();

  let where = ['created_at LIKE ?'];
  let params = [`${targetDate}%`];

  if (status && ['pending', 'confirmed'].includes(status)) {
    where.push('status = ?');
    params.push(status);
  }

  if (search && search.trim()) {
    const q = `%${search.trim()}%`;
    where.push('(name LIKE ? OR token LIKE ? OR phone LIKE ? OR seva LIKE ?)');
    params.push(q, q, q, q);
  }

  const whereClause = where.join(' AND ');
  const countRow = db.prepare(`SELECT COUNT(*) as total FROM pilgrims WHERE ${whereClause}`).get(...params);

  const rows = db.prepare(
    `SELECT id, token, enrollment_no, name, phone, aadhaar_masked, id_type, seva, photo_file, status, allotment_status, created_at, confirmed_at
     FROM pilgrims WHERE ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, lim, offset);

  rows.forEach(r => { r.has_photo = !!r.photo_file; delete r.photo_file; });
  res.json({ rows, total: countRow.total, page: pageNum, limit: lim, date: targetDate });
});

// Stats (date-filterable, auth required)
app.get('/api/stats', authMiddleware, (req, res) => {
  const { date } = req.query;
  const targetDate = (date && isValidDate(date)) ? date : todayIST();
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = '${STATUS.CONFIRMED}' THEN 1 ELSE 0 END) as confirmed,
      SUM(CASE WHEN status = '${STATUS.PENDING}' THEN 1 ELSE 0 END) as pending
    FROM pilgrims WHERE created_at LIKE ?
  `).get(`${targetDate}%`);
  stats.date = targetDate;
  res.json(stats);
});

// ===================== LUCKY DIP / LOTTERY =====================

// Get seva config (date-filterable)
app.get('/api/seva-config', authMiddleware, (req, res) => {
  const { date } = req.query;
  const targetDate = (date && isValidDate(date)) ? date : todayIST();

  const result = SEVAS.map(seva => {
    const config = db.prepare(
      'SELECT slots, enabled, drawn_at FROM seva_config WHERE seva_name = ? AND draw_date = ?'
    ).get(seva, targetDate);

    const counts = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = '${STATUS.CONFIRMED}' THEN 1 ELSE 0 END) as confirmed,
        SUM(CASE WHEN allotment_status = '${STATUS.ALLOTTED}' THEN 1 ELSE 0 END) as allotted
      FROM pilgrims WHERE seva = ? AND created_at LIKE ?
    `).get(seva, `${targetDate}%`);

    return {
      seva_name: seva,
      slots: config ? config.slots : 50,
      enabled: config ? !!config.enabled : false,
      drawn_at: config ? config.drawn_at : null,
      total_registrations: counts.total || 0,
      confirmed_count: counts.confirmed || 0,
      allotted_count: counts.allotted || 0
    };
  });

  res.json({ sevas: result, date: targetDate });
});

// Update slots for a seva
app.post('/api/seva-config', authMiddleware, (req, res) => {
  const { seva_name, slots } = req.body;
  if (!seva_name || !SEVAS.includes(seva_name)) return res.status(400).json({ error: 'Invalid seva' });
  if (!Number.isInteger(slots) || slots < 1) return res.status(400).json({ error: 'Slots must be a positive integer' });

  const today = todayIST();

  const existing = db.prepare('SELECT drawn_at FROM seva_config WHERE seva_name = ? AND draw_date = ?').get(seva_name, today);
  if (existing && existing.drawn_at) {
    return res.status(400).json({ error: 'Cannot change slots after draw has been conducted' });
  }

  db.prepare(`INSERT INTO seva_config (seva_name, slots, draw_date)
    VALUES (?, ?, ?) ON CONFLICT(seva_name, draw_date) DO UPDATE SET slots = ?`
  ).run(seva_name, slots, today, slots);

  logAudit(req.operator.id, req.operator.username, 'update_slots', `Set ${seva_name} slots to ${slots}`);
  res.json({ success: true });
});

// Toggle seva enabled/disabled for today
app.post('/api/seva-toggle', authMiddleware, (req, res) => {
  const { seva_name, enabled } = req.body;
  if (!seva_name || !SEVAS.includes(seva_name)) return res.status(400).json({ error: 'Invalid seva' });

  const today = todayIST();
  const enabledVal = enabled ? 1 : 0;

  // Can't change availability after draw is done
  const existing = db.prepare('SELECT drawn_at FROM seva_config WHERE seva_name = ? AND draw_date = ?').get(seva_name, today);
  if (existing && existing.drawn_at) {
    return res.status(400).json({ error: 'Cannot change availability after draw has been conducted' });
  }

  db.prepare(`INSERT INTO seva_config (seva_name, slots, draw_date, enabled)
    VALUES (?, 50, ?, ?) ON CONFLICT(seva_name, draw_date) DO UPDATE SET enabled = ?`
  ).run(seva_name, today, enabledVal, enabledVal);

  logAudit(req.operator.id, req.operator.username, 'toggle_seva', `${enabled ? 'Enabled' : 'Disabled'} ${seva_name} for today`);
  res.json({ success: true });
});

// Run the lucky dip draw for a seva
app.post('/api/draw/:seva', authMiddleware, (req, res) => {
  const sevaName = decodeURIComponent(req.params.seva);
  if (!SEVAS.includes(sevaName)) return res.status(400).json({ error: 'Invalid seva' });

  const today = todayIST();

  const config = db.prepare('SELECT slots, drawn_at FROM seva_config WHERE seva_name = ? AND draw_date = ?').get(sevaName, today);
  if (config && config.drawn_at) {
    return res.status(400).json({ error: `Draw already conducted for "${sevaName}" today at ${config.drawn_at}` });
  }

  const slots = config ? config.slots : 50;

  const confirmed = db.prepare(
    `SELECT id, token, name FROM pilgrims WHERE seva = ? AND status = '${STATUS.CONFIRMED}' AND created_at LIKE ? ORDER BY id`
  ).all(sevaName, `${today}%`);

  if (confirmed.length === 0) {
    return res.status(400).json({ error: `No confirmed pilgrims for "${sevaName}" today` });
  }

  // Fisher-Yates shuffle for fair randomness
  const shuffled = [...confirmed];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const winners = shuffled.slice(0, Math.min(slots, shuffled.length));
  const winnerIds = new Set(winners.map(w => w.id));

  const updateAllotted = db.prepare(`UPDATE pilgrims SET allotment_status = '${STATUS.ALLOTTED}' WHERE id = ?`);
  const updateNotAllotted = db.prepare(`UPDATE pilgrims SET allotment_status = '${STATUS.NOT_ALLOTTED}' WHERE id = ?`);

  const runDraw = db.transaction(() => {
    for (const p of confirmed) {
      if (winnerIds.has(p.id)) {
        updateAllotted.run(p.id);
      } else {
        updateNotAllotted.run(p.id);
      }
    }
    const drawTime = nowIST();
    db.prepare(`INSERT INTO seva_config (seva_name, slots, draw_date, drawn_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(seva_name, draw_date) DO UPDATE SET drawn_at = ?`
    ).run(sevaName, slots, today, drawTime, drawTime);
  });

  runDraw();

  logAudit(req.operator.id, req.operator.username, 'run_draw', `Draw for ${sevaName}: ${winners.length} allotted / ${confirmed.length} confirmed`);

  res.json({
    success: true,
    seva: sevaName,
    total_confirmed: confirmed.length,
    slots,
    allotted: winners.length,
    not_allotted: confirmed.length - winners.length
  });
});

// Reset draw for a seva (admin safeguard)
app.post('/api/draw-reset/:seva', authMiddleware, (req, res) => {
  const sevaName = decodeURIComponent(req.params.seva);
  if (!SEVAS.includes(sevaName)) return res.status(400).json({ error: 'Invalid seva' });

  const { confirm_text } = req.body;
  if (confirm_text !== `RESET ${sevaName}`) {
    return res.status(400).json({ error: `Type "RESET ${sevaName}" to confirm` });
  }

  const today = todayIST();

  const config = db.prepare('SELECT drawn_at FROM seva_config WHERE seva_name = ? AND draw_date = ?').get(sevaName, today);
  if (!config || !config.drawn_at) {
    return res.status(400).json({ error: 'No draw to reset for this seva today' });
  }

  const resetDraw = db.transaction(() => {
    db.prepare("UPDATE pilgrims SET allotment_status = NULL WHERE seva = ? AND created_at LIKE ? AND allotment_status IS NOT NULL")
      .run(sevaName, `${today}%`);
    db.prepare("UPDATE seva_config SET drawn_at = NULL WHERE seva_name = ? AND draw_date = ?")
      .run(sevaName, today);
  });

  resetDraw();

  logAudit(req.operator.id, req.operator.username, 'reset_draw', `Reset draw for ${sevaName}`);
  res.json({ success: true, message: `Draw reset for "${sevaName}". You can now re-run the draw.` });
});

// Get draw results (paginated, date-filterable)
app.get('/api/draw-results', authMiddleware, (req, res) => {
  const { seva, status, page = 1, limit = 100, date } = req.query;
  const targetDate = (date && isValidDate(date)) ? date : todayIST();
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  const offset = (pageNum - 1) * lim;

  let where = ["allotment_status IS NOT NULL", "created_at LIKE ?"];
  const params = [`${targetDate}%`];

  if (seva && SEVAS.includes(seva)) {
    where.push("seva = ?");
    params.push(seva);
  }
  if (status && ['allotted', 'not_allotted'].includes(status)) {
    where.push("allotment_status = ?");
    params.push(status);
  }

  const whereClause = where.join(' AND ');
  const countRow = db.prepare(`SELECT COUNT(*) as total FROM pilgrims WHERE ${whereClause}`).get(...params);

  const orderBy = 'ORDER BY enrollment_no';
  const rows = db.prepare(
    `SELECT token, enrollment_no, name, phone, aadhaar_masked, id_type, seva, allotment_status, created_at
     FROM pilgrims WHERE ${whereClause} ${orderBy} LIMIT ? OFFSET ?`
  ).all(...params, lim, offset);

  res.json({ rows, total: countRow.total, page: pageNum, limit: lim, date: targetDate });
});

// ===================== AUDIT LOG =====================

app.get('/api/audit-log', authMiddleware, (req, res) => {
  const { page = 1, limit = 50, date } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const offset = (pageNum - 1) * lim;

  let where = ['1=1'];
  let params = [];

  if (date && isValidDate(date)) {
    where.push('created_at LIKE ?');
    params.push(`${date}%`);
  }

  const whereClause = where.join(' AND ');
  const countRow = db.prepare(`SELECT COUNT(*) as total FROM audit_log WHERE ${whereClause}`).get(...params);

  const rows = db.prepare(
    `SELECT id, operator_name, action, details, target_token, created_at FROM audit_log WHERE ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, lim, offset);

  res.json({ rows, total: countRow.total, page: pageNum, limit: lim });
});

// ===================== PHOTO CLEANUP =====================

app.post('/api/cleanup-photos', authMiddleware, (req, res) => {
  const { days_old = 30 } = req.body;
  const daysOld = Math.max(1, parseInt(days_old));

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysOld);

  let deleted = 0;
  const files = fs.readdirSync(PHOTOS_DIR);
  for (const file of files) {
    const filepath = path.join(PHOTOS_DIR, file);
    try {
      const stat = fs.statSync(filepath);
      if (stat.mtime < cutoff) {
        fs.unlinkSync(filepath);
        deleted++;
      }
    } catch (e) { /* skip */ }
  }

  logAudit(req.operator.id, req.operator.username, 'cleanup_photos', `Deleted ${deleted} photos older than ${daysOld} days`);
  res.json({ success: true, deleted, days_old: daysOld });
});

// ===================== DATABASE BACKUP =====================

function createBackup() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupFile = path.join(BACKUPS_DIR, `cro_backup_${stamp}.db`);
  db.backup(backupFile);

  // Keep only last 10 backups
  const backups = fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.startsWith('cro_backup_') && f.endsWith('.db'))
    .sort();
  while (backups.length > 10) {
    const oldest = backups.shift();
    try { fs.unlinkSync(path.join(BACKUPS_DIR, oldest)); } catch(e) {}
  }

  return backupFile;
}

// Manual backup endpoint
app.post('/api/backup', authMiddleware, (req, res) => {
  try {
    const backupFile = createBackup();
    logAudit(req.operator.id, req.operator.username, 'manual_backup', `Created backup: ${path.basename(backupFile)}`);
    res.json({ success: true, file: path.basename(backupFile) });
  } catch (e) {
    res.status(500).json({ error: 'Backup failed: ' + e.message });
  }
});

// List backups
app.get('/api/backups', authMiddleware, (req, res) => {
  const backups = fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.startsWith('cro_backup_') && f.endsWith('.db'))
    .sort()
    .reverse()
    .map(f => {
      const stat = fs.statSync(path.join(BACKUPS_DIR, f));
      return { name: f, size_mb: (stat.size / 1024 / 1024).toFixed(1), created: stat.mtime.toISOString() };
    });
  res.json(backups);
});

// Startup backup
try {
  const backupFile = createBackup();
  console.log(`Startup backup: ${path.basename(backupFile)}`);
} catch (e) {
  console.log('Startup backup skipped:', e.message);
}

// Daily backup at midnight IST — track last backup date to avoid duplicates
let lastDailyBackupDate = '';
setInterval(() => {
  const now = new Date();
  const istDate = now.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });
  const istHour = parseInt(now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }));
  if (istHour === 0 && lastDailyBackupDate !== istDate) {
    try {
      const file = createBackup();
      lastDailyBackupDate = istDate;
      console.log(`Daily auto-backup: ${path.basename(file)}`);
    } catch (e) { console.log('Daily backup failed:', e.message); }
  }
}, 5 * 60 * 1000);

// ===================== EXPORT =====================

app.get('/api/export/csv', authMiddleware, (req, res) => {
  const { date, type } = req.query;
  const targetDate = (date && isValidDate(date)) ? date : todayIST();

  let query, params;
  if (type === 'allotted') {
    query = `SELECT enrollment_no, token, name, phone, aadhaar_masked, id_type, seva, status, allotment_status, created_at, confirmed_at FROM pilgrims WHERE allotment_status = '${STATUS.ALLOTTED}' AND created_at LIKE ? ORDER BY seva, enrollment_no`;
    params = [`${targetDate}%`];
  } else if (type === 'results') {
    query = "SELECT enrollment_no, token, name, phone, aadhaar_masked, id_type, seva, status, allotment_status, created_at, confirmed_at FROM pilgrims WHERE allotment_status IS NOT NULL AND created_at LIKE ? ORDER BY seva, allotment_status DESC, enrollment_no";
    params = [`${targetDate}%`];
  } else {
    query = "SELECT enrollment_no, token, name, phone, aadhaar_masked, id_type, seva, status, allotment_status, created_at, confirmed_at FROM pilgrims WHERE created_at LIKE ? ORDER BY enrollment_no";
    params = [`${targetDate}%`];
  }

  const filename = type
    ? `CRO_${type}_${targetDate.replace(/\//g, '-')}.csv`
    : `CRO_All_Registrations_${targetDate.replace(/\//g, '-')}.csv`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const headers = ['Enrollment No', 'Token', 'Name', 'Phone', 'ID Masked', 'ID Type', 'Seva', 'Status', 'Allotment', 'Registered At', 'Confirmed At'];
  res.write(headers.join(',') + '\n');

  // CSV-safe helper: prevent formula injection and properly quote fields
  function csvSafe(val) {
    if (val == null) return '';
    let s = String(val);
    // Prevent CSV formula injection
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    // Quote if contains comma, quote, or newline
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  const stmt = db.prepare(query);
  for (const r of stmt.iterate(...params)) {
    const row = [
      r.enrollment_no || '',
      csvSafe(r.token),
      csvSafe(r.name),
      csvSafe(r.phone),
      csvSafe(r.aadhaar_masked),
      csvSafe(r.id_type),
      csvSafe(r.seva),
      csvSafe(r.status),
      csvSafe(r.allotment_status || '-'),
      csvSafe(r.created_at),
      csvSafe(r.confirmed_at)
    ];
    res.write(row.join(',') + '\n');
  }

  logAudit(req.operator.id, req.operator.username, 'export_csv', `Exported ${type || 'all'} for ${targetDate}`);
  res.end();
});

// ===================== START =====================

// HTTP server (main — Railway uses this with their own HTTPS proxy)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP server running on port ${PORT}`);
});

// HTTPS server (local network only — for phone GPS over LAN)
if (!process.env.RAILWAY_ENVIRONMENT) {
  const sslKeyPath = path.join(__dirname, 'server.key');
  const sslCertPath = path.join(__dirname, 'server.cert');
  if (fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath)) {
    const sslOptions = {
      key: fs.readFileSync(sslKeyPath),
      cert: fs.readFileSync(sslCertPath),
    };
    https.createServer(sslOptions, app).listen(HTTPS_PORT, () => {
      console.log(`HTTPS server running on port ${HTTPS_PORT}`);
    });
  }
}
