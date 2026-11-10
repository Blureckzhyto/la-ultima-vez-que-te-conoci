import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, timingSafeEqual, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DB_PATH = path.resolve(process.env.DATABASE_PATH || path.join(DATA_DIR, 'book.sqlite'));
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const PORT = Number(process.env.PORT || 4173);
const SESSION_COOKIE = 'book_session';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const PASSWORD_MIN = 12;
const MAX_BODY = 8 * 1024;
const rateWindows = new Map();

await mkdir(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(email) <= 254),
    display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
    password_salt BLOB NOT NULL,
    password_hash BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chapter_number INTEGER NOT NULL CHECK(chapter_number BETWEEN 1 AND 1000),
    body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS comments_chapter_created ON comments(chapter_number, created_at DESC);
  CREATE TABLE IF NOT EXISTS reading_progress (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    page_start INTEGER NOT NULL DEFAULT 1 CHECK(page_start BETWEEN 1 AND 1000),
    updated_at INTEGER NOT NULL
  );
`);
db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());

function json(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}
function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) cookies[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return cookies;
}
function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
function publicUser(row) { return { id: row.id, email: row.email, name: row.display_name }; }
function clearCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
}
function readSession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token || token.length > 128) return null;
  const row = db.prepare(`SELECT users.id, users.email, users.display_name, sessions.id AS session_id, sessions.expires_at
    FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?`).get(tokenHash(token));
  if (!row || row.expires_at <= Date.now()) {
    if (row) db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id);
    return null;
  }
  return { user: publicUser(row), sessionId: row.session_id };
}
function createSession(userId, res) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), userId, tokenHash(token), now, now + SESSION_TTL_MS);
  return sessionCookie(token);
}
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('La solicitud es demasiado grande.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('El formato de la solicitud no es válido.'), { status: 400 }); }
}
function limited(req, key, cap, periodMs) {
  const now = Date.now();
  const ip = req.socket.remoteAddress || 'unknown';
  const id = `${ip}:${key}`;
  const previous = rateWindows.get(id);
  if (!previous || now - previous.start >= periodMs) {
    rateWindows.set(id, { start: now, count: 1 });
    return false;
  }
  previous.count++;
  return previous.count > cap;
}
function normalizedEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}
function validPassword(value) {
  return typeof value === 'string' && value.length >= PASSWORD_MIN && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}
async function passwordHash(password, salt) {
  return await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/supabase-config.js', ['supabase-config.js', 'text/javascript; charset=utf-8']],
  ['/chapters.json', ['chapters.json', 'application/json; charset=utf-8']],
]);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isSameOrigin(req)) {
      return json(res, 403, { error: 'Solicitud de otro origen rechazada.' });
    }
    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) return json(res, 204, {});
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const sqlite = db.prepare('SELECT sqlite_version() AS version').get().version;
      return json(res, 200, { status: 'ok', database: 'sqlite', sqliteVersion: sqlite });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/signup') {
      if (limited(req, 'signup', 5, 60 * 60 * 1000)) return json(res, 429, { error: 'Intenta de nuevo más tarde.' });
      const body = await readJson(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const email = normalizedEmail(body.email);
      if (name.length < 1 || name.length > 80) return json(res, 400, { error: 'Escribe un nombre de entre 1 y 80 caracteres.' });
      if (!email) return json(res, 400, { error: 'Escribe un correo electrónico válido.' });
      if (!validPassword(body.password)) return json(res, 400, { error: `La contraseña debe tener entre ${PASSWORD_MIN} y 128 caracteres.` });
      const salt = randomBytes(16);
      const hash = await passwordHash(body.password, salt);
      const user = { id: randomUUID(), email, display_name: name };
      const now = Date.now();
      try {
        db.exec('BEGIN IMMEDIATE');
        db.prepare('INSERT INTO users (id, email, display_name, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(user.id, user.email, user.display_name, salt, hash, now);
        db.prepare('INSERT INTO reading_progress (user_id, page_start, updated_at) VALUES (?, 1, ?)').run(user.id, now);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        if (String(error.message).includes('UNIQUE')) return json(res, 409, { error: 'Ya existe una cuenta con ese correo.' });
        throw error;
      }
      return json(res, 201, { user: publicUser(user) }, { 'Set-Cookie': createSession(user.id) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      if (limited(req, 'login', 10, 15 * 60 * 1000)) return json(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' });
      const body = await readJson(req);
      const email = normalizedEmail(body.email);
      if (!email || typeof body.password !== 'string' || body.password.length > 128) return json(res, 401, { error: 'Correo o contraseña incorrectos.' });
      const row = db.prepare('SELECT id, email, display_name, password_salt, password_hash FROM users WHERE email = ?').get(email);
      if (!row) return json(res, 401, { error: 'Correo o contraseña incorrectos.' });
      const candidate = await passwordHash(body.password, row.password_salt);
      if (candidate.length !== row.password_hash.length || !timingSafeEqual(candidate, row.password_hash)) return json(res, 401, { error: 'Correo o contraseña incorrectos.' });
      return json(res, 200, { user: publicUser(row) }, { 'Set-Cookie': createSession(row.id) });
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      const session = readSession(req);
      return json(res, 200, { user: session?.user || null }, session ? {} : { 'Set-Cookie': clearCookie() });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const session = readSession(req);
      if (session) db.prepare('DELETE FROM sessions WHERE id = ?').run(session.sessionId);
      return json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
    }
    if (url.pathname === '/api/comments' && req.method === 'GET') {
      const chapter = Number(url.searchParams.get('chapter') || 1);
      if (!Number.isSafeInteger(chapter) || chapter < 1 || chapter > 1000) return json(res, 400, { error: 'El capítulo no es válido.' });
      const rows = db.prepare(`SELECT comments.id, comments.body, comments.created_at, users.display_name AS author
        FROM comments JOIN users ON users.id = comments.user_id
        WHERE comments.chapter_number = ? ORDER BY comments.created_at DESC LIMIT 50`).all(chapter);
      return json(res, 200, { comments: rows.map(row => ({ id: row.id, body: row.body, author: row.author, createdAt: row.created_at })) });
    }
    if (req.method === 'POST' && url.pathname === '/api/comments') {
      const session = readSession(req);
      if (!session) return json(res, 401, { error: 'Inicia sesión para dejar un comentario.' }, { 'Set-Cookie': clearCookie() });
      if (limited(req, 'comment', 8, 60 * 60 * 1000)) return json(res, 429, { error: 'Has compartido varios comentarios. Intenta más tarde.' });
      const body = await readJson(req);
      const chapter = Number(body.chapter);
      const message = typeof body.body === 'string' ? body.body.trim() : '';
      if (!Number.isSafeInteger(chapter) || chapter < 1 || chapter > 1000) return json(res, 400, { error: 'El capítulo no es válido.' });
      if (message.length < 1 || message.length > 2000) return json(res, 400, { error: 'El comentario debe tener entre 1 y 2000 caracteres.' });
      const id = randomUUID();
      const createdAt = Date.now();
      db.prepare('INSERT INTO comments (id, user_id, chapter_number, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, session.user.id, chapter, message, createdAt);
      return json(res, 201, { comment: { id, body: message, author: session.user.name, createdAt } });
    }    if (url.pathname === '/api/reading/progress') {
      const session = readSession(req);
      if (!session) return json(res, 401, { error: 'Inicia sesión para sincronizar tu lectura.' }, { 'Set-Cookie': clearCookie() });
      if (req.method === 'GET') {
        const row = db.prepare('SELECT page_start FROM reading_progress WHERE user_id = ?').get(session.user.id);
        return json(res, 200, { pageStart: row?.page_start || 1 });
      }
      if (req.method === 'PUT') {
        const body = await readJson(req);
        const value = Number(body.pageStart);
        if (!Number.isSafeInteger(value) || value < 1 || value > 1000) return json(res, 400, { error: 'La página no es válida.' });
        db.prepare(`INSERT INTO reading_progress (user_id, page_start, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET page_start = excluded.page_start, updated_at = excluded.updated_at`)
          .run(session.user.id, value, Date.now());
        return json(res, 200, { pageStart: value });
      }
    }
    const asset = staticFiles.get(url.pathname);
    if (req.method === 'GET' && asset) {
      const filePath = path.join(ROOT, asset[0]);
      const contents = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': asset[1],
        'Content-Length': (await stat(filePath)).size,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://*.supabase.co wss://*.supabase.co; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
      });
      return res.end(contents);
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Ruta de API no encontrada.' });
    return json(res, 404, { error: 'No encontrado.' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) return json(res, error.status || 500, { error: error.status ? error.message : 'Error interno del servidor.' });
    res.destroy();
  }
});
server.listen(PORT, HOST, () => {
  console.log(`Libro abierto escuchando en http://${HOST}:${PORT}`);
  console.log(`Base SQLite persistente: ${DB_PATH}`);
});
function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
