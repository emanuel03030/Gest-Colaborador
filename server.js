const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
require('dotenv').config();
const { startBackupScheduler } = require('./backup');

const app = express();
const port = Number(process.env.PORT || 3000);
const dbFile = process.env.DB_FILE || './database.sqlite';
const allowedOriginsRaw = (process.env.ALLOWED_ORIGINS || '*').trim();
const writeApiKey = String(process.env.WRITE_API_KEY || '').trim();
const jwt = require('jsonwebtoken');
// ── Segredo do JWT (sessão de login) ──────────────────────────────────
// Nunca usar um valor padrão fixo aqui: se ninguém soubesse configurar o
// .env, o servidor rodaria com uma chave previsível, e qualquer pessoa
// poderia forjar um token de login válido para qualquer usuário.
function resolveJwtSecret() {
  const fromEnv = String(process.env.JWT_SECRET || '').trim();
  if (fromEnv) return fromEnv;

  const secretFile = path.join(__dirname, '.jwt-secret');
  try {
    if (fs.existsSync(secretFile)) {
      const existing = fs.readFileSync(secretFile, 'utf8').trim();
      if (existing) return existing;
    }
  } catch (_) { /* segue para gerar um novo abaixo */ }

  const generated = crypto.randomBytes(48).toString('hex');
  try {
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    console.warn('[Backend] JWT_SECRET não definido no .env — foi gerado automaticamente e salvo em .jwt-secret. Para produção, defina JWT_SECRET manualmente no .env (não apague o .jwt-secret sem trocar por um valor fixo, ou todas as sessões serão invalidadas).');
  } catch (err) {
    console.warn('[Backend] JWT_SECRET não definido e não foi possível salvá-lo em disco — usando um segredo temporário só desta execução (todas as sessões serão invalidadas ao reiniciar o servidor).');
  }
  return generated;
}

const jwtSecret = resolveJwtSecret();
const jwtExpiresIn = String(process.env.JWT_EXPIRES_IN || '2h').trim();
const authHostRaw = String(process.env.AUTH_HOST || '').trim(); // Removido: não usado para autenticação local  
const authProxyEnabled = String(process.env.AUTH_PROXY_ENABLED || 'false').trim().toLowerCase() === 'true'; // Removido: não usado para autenticação local  

// Autenticação local apenas: cada servidor gerencia seus próprios usuários.
// Removidas configurações de proxy/SSRF para servidor de autenticação remoto.

function parseBoolEnv(name, defaultValue = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return defaultValue;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

const allowSelfRegister = parseBoolEnv('ALLOW_SELF_REGISTER', false);
const pruneNonDefaultUsers = parseBoolEnv('PRUNE_NON_DEFAULT_USERS', false);
const resolvedDbPath = path.resolve(__dirname, dbFile);
fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });

const db = new Database(resolvedDbPath);
db.pragma('journal_mode = WAL');

// Usuários iniciais (SOMENTE os nomes). Nenhuma senha fica no código-fonte:
// em um banco novo, cada usuário recebe uma senha provisória ALEATÓRIA, gravada
// apenas como hash (scrypt) no banco. As senhas provisórias são salvas uma
// única vez em ./initial-passwords.txt (permissão 600) para serem entregues a
// cada pessoa — apague o arquivo depois e peça para todos trocarem a senha.
// Bancos que já têm esses usuários NÃO são alterados.
const DEFAULT_USERNAMES = Object.freeze([
  'FRANCISCO.C',
  'ELITOM.M',
  'EMANUEL.N',
  'NEIVA.C',
  'LUIZ.H',
  'EVANY.S'
]);

function generateTempPassword() {
  // 8 caracteres sem símbolos ambíguos (0/O, 1/l/I)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

db.exec(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  owner_username TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  ip TEXT NOT NULL,
  success INTEGER NOT NULL,
  reason_code TEXT NOT NULL,
  reason_message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

// Registros antigos eram globais. Atribui-os uma única vez ao administrador
// legado para que continuem disponíveis sem misturar dados entre usuários.
const recordsColumns = db.prepare("PRAGMA table_info(records)").all().map((c) => c.name);
if (!recordsColumns.includes('owner_username')) {
  db.exec('ALTER TABLE records ADD COLUMN owner_username TEXT');
}

// Migração segura: adiciona a coluna is_admin em bancos que já existiam
// antes desse recurso, sem apagar nenhum usuário já cadastrado.
const usersColumns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!usersColumns.includes('is_admin')) {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
}

// Quem é administrador: configurável no .env (ADMIN_USERNAMES=FRANCISCO.C,ELITOM.M).
// Só administradores podem ver/alterar o acesso de OUTRAS pessoas; qualquer
// usuário sempre pode alterar a própria senha.
const adminUsernames = String(process.env.ADMIN_USERNAMES || '')
  .split(',')
  .map((u) => normalizeUsername(u))
  .filter(Boolean);

function syncAdminUsers() {
  if (adminUsernames.length === 0) return;
  const placeholders = adminUsernames.map(() => '?').join(',');
  db.prepare(`UPDATE users SET is_admin = 1 WHERE username IN (${placeholders})`).run(...adminUsernames);
}

app.disable('x-powered-by');
if (process.env.TRUST_PROXY) {
  const tp = String(process.env.TRUST_PROXY).trim();
  app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp);
}

function normalizeUsername(value) {
  return String(value || '').trim().toUpperCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, originalHash] = String(storedHash || '').split(':');
  if (!salt || !originalHash) {
    return false;
  }

  const derivedHash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(originalHash, 'hex'), Buffer.from(derivedHash, 'hex'));
}

const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

function validateCredentials(username, password) {
  if (!username || !password) {
    return 'Preencha usuario e senha.';
  }

  if (!/^[A-Z0-9._-]{3,30}$/.test(username)) {
    return 'Use de 3 a 30 caracteres: letras, numeros, ponto, hifen ou _';
  }

  const length = String(password).length;
  if (length < 4 || length > 12) {
    return 'A senha deve ter entre 4 e 12 caracteres.';
  }

  return null;
}

function getUserByUsername(username) {
  return db.prepare('SELECT username, password_hash, is_admin, created_at, updated_at FROM users WHERE username = ?').get(username);
}

// ── Validação e sanitização de tudo que chega em /api/records ─────────
// Sem isso, a API aceitava qualquer tipo de registro e qualquer conteúdo
// de campo sem checagem nenhuma (inclusive HTML/script, o que poderia
// ficar salvo no banco e ser executado depois em quem visse aquele dado).
const ALLOWED_RECORD_TYPES = new Set(['Collaborator', 'absence', 'occurrence', 'schedule', 'performance_review', 'app_setting']);
const MAX_STRING_LENGTH = 3000;

function sanitizeValue(value, depth) {
  depth = depth || 0;
  if (depth > 6) return null;

  if (typeof value === 'string') {
    let cleaned = value
      .replace(/<\/?[a-z!][^>]*>?/gi, '')                  // remove tags tipo <script>, <img onerror=...> (inclusive sem o '>' final)
      .replace(/\bon[a-z]+\s*=/gi, '')                      // remove atributos de evento (onerror=, onclick=...)
      .replace(/^\s*(javascript|vbscript)\s*:/i, '')        // remove esquemas perigosos no início do valor
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); // remove caracteres de controle
    cleaned = cleaned.trim();
    if (cleaned.length > MAX_STRING_LENGTH) cleaned = cleaned.slice(0, MAX_STRING_LENGTH);
    return cleaned;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 500).map((v) => sanitizeValue(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).slice(0, 200).forEach((key) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return; // prototype pollution
      out[key] = sanitizeValue(value[key], depth + 1);
    });
    return out;
  }
  return value; // números, booleans, null passam direto
}

function sanitizeRecordPayload(item) {
  const sanitized = sanitizeValue(item);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized : {};
}

function createAuthToken(username, isAdmin) {
  return jwt.sign({ username, is_admin: !!isAdmin }, jwtSecret, { expiresIn: jwtExpiresIn, algorithm: 'HS256' });
}

// Middleware: exige um token JWT válido (usuário autenticado) para acessar a rota.
// Sem isso, qualquer pessoa que soubesse a URL do servidor conseguia ler/gravar
// dados dos colaboradores e até trocar a senha de qualquer usuário sem estar logada.
function authenticateToken(req, res, next) {
  const authHeader = String(req.headers['authorization'] || '');
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : String(req.query.token || '').trim();

  if (!token) {
    res.status(401).json({ isOk: false, error: { message: 'Token de autenticação ausente. Faça login novamente.', code: 'AUTH_TOKEN_MISSING' } });
    return;
  }

  try {
    const decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    req.user = { username: normalizeUsername(decoded.username), is_admin: !!decoded.is_admin };
    next();
  } catch (err) {
    res.status(401).json({ isOk: false, error: { message: 'Sessão expirada ou inválida. Faça login novamente.', code: 'AUTH_TOKEN_INVALID' } });
  }
}

function logAuthAttempt({ username, ip, success, reasonCode, reasonMessage }) {
  const nowIso = new Date().toISOString();
  const stmt = db.prepare(
    'INSERT INTO auth_logs (username, ip, success, reason_code, reason_message, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  stmt.run(
    username || null,
    String(ip || 'unknown'),
    success ? 1 : 0,
    String(reasonCode || 'UNKNOWN'),
    String(reasonMessage || '').slice(0, 255),
    nowIso
  );
}

function seedDefaultUsers() {
  const nowIso = new Date().toISOString();

  // Opcional: remover usuarios fora da lista padrao apenas quando explicitamente habilitado.
  if (pruneNonDefaultUsers) {
    const authorized = DEFAULT_USERNAMES.slice();
    const placeholders = authorized.map(() => '?').join(',');
    db.prepare(`DELETE FROM users WHERE username NOT IN (${placeholders})`).run(...authorized);
  }

  // Insere usuários que ainda não existem, com senha provisória aleatória
  // (nunca sobrescreve a senha de quem já existe).
  const insertUser = db.prepare(
    'INSERT OR IGNORE INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)'
  );
  const created = [];
  for (const username of DEFAULT_USERNAMES) {
    if (getUserByUsername(username)) continue;
    const temp = generateTempPassword();
    insertUser.run(username, hashPassword(temp), nowIso, nowIso);
    created.push(username + '  ' + temp);
  }

  if (created.length) {
    const file = path.join(__dirname, 'initial-passwords.txt');
    try {
      fs.writeFileSync(file, 'SENHAS PROVISÓRIAS — entregue a cada pessoa e APAGUE este arquivo.\n' + created.join('\n') + '\n', { mode: 0o600, flag: 'a' });
      console.warn('[Backend] ' + created.length + ' usuário(s) criado(s) com senha provisória. Veja initial-passwords.txt, entregue e apague o arquivo.');
    } catch (err) {
      console.warn('[Backend] Não foi possível salvar initial-passwords.txt; usuários criados: ' + created.map((l) => l.split('  ')[0]).join(', ') + ' (use a rota de senha para definir a deles).');
    }
  }
}

seedDefaultUsers();
syncAdminUsers();
const legacyOwner = normalizeUsername(process.env.LEGACY_DATA_OWNER || adminUsernames[0] || DEFAULT_USERNAMES[0]);
db.prepare('UPDATE records SET owner_username = ? WHERE owner_username IS NULL OR TRIM(owner_username) = \'\'').run(legacyOwner);
startBackupScheduler();

function mapRowToRecord(row) {
  try {
    const parsed = JSON.parse(row.payload);
    parsed.__backendId = row.id;
    parsed.type = parsed.type || row.type;
    return parsed;
  } catch (err) {
    return null;
  }
}

function isEmployeeType(typeValue) {
  const type = String(typeValue || '').trim().toLowerCase();
  return [
    'employee',
    'employees',
    'funcionario',
    'funcionarios',
    'funcionário',
    'funcionários',
    'colaborador',
    'colaboradores'
  ].includes(type);
}

function parsePayloadSafe(payload) {
  try {
    return JSON.parse(String(payload || '{}'));
  } catch (err) {
    return null;
  }
}

function isUniqueConstraintError(err) {
  const code = String(err && err.code ? err.code : '');
  return code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function createCorsOptions() {
  if (allowedOriginsRaw === '*') {
    return {
      origin(origin, callback) {
        // Quando configurado com '*', aceita qualquer origem.
        // Isso viabiliza frontend e backend em dominios diferentes.
        callback(null, true);
      }
    };
  }

  const allowedOrigins = allowedOriginsRaw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    origin(origin, callback) {
      if (!origin || origin === 'null' || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin not allowed by CORS'));
    }
  };
}

app.use(cors(createCorsOptions()));
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || '').toLowerCase();
  const isHttps = proto.includes('https');

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api')) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  }
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');

  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
});

// IP do cliente. NÃO confia em X-Forwarded-For diretamente (qualquer um pode
// forjar esse cabeçalho e escapar do rate limit). Só é considerado quando
// TRUST_PROXY está configurado (ex.: TRUST_PROXY=1 atrás de Nginx/Render).
function getClientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

// ══════════════════════════════════════════════════════════════════════
// Rate limiting (janela deslizante em memória)
// ══════════════════════════════════════════════════════════════════════
function createRateLimiter({ windowMs, max, message, keyFn }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, list] of hits) {
      const fresh = list.filter((t) => now - t < windowMs);
      if (fresh.length) hits.set(k, fresh); else hits.delete(k);
    }
  }, Math.max(windowMs, 30000)).unref();

  return function rateLimiter(req, res, next) {
    const key = (keyFn ? keyFn(req) : getClientIp(req)) + '|' + req.method + '|' + req.path;
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      const retry = Math.max(1, Math.ceil((windowMs - (now - list[0])) / 1000));
      res.setHeader('Retry-After', String(retry));
      res.status(429).json({ isOk: false, error: { code: 'RATE_LIMIT', message: message || ('Muitas requisições. Aguarde ' + retry + 's e tente novamente.') } });
      return;
    }
    list.push(now);
    hits.set(key, list);
    next();
  };
}

const globalLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 600 });
const authLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30 });
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10, // por IP+usuário; o bloqueio por falhas reais (banco) fica em isLoginLocked()
  message: 'Muitas tentativas de login. Tente novamente em alguns minutos.',
  keyFn: (req) => getClientIp(req) + '|' + normalizeUsername(req.body && req.body.username).slice(0, 40)
});

// Bloqueio persistente (sobrevive a reinício do servidor): 5 falhas nos últimos
// 15 min para o mesmo usuário OU 20 falhas do mesmo IP => bloqueia o login.
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
function isLoginLocked(username, ip) {
  const since = new Date(Date.now() - LOGIN_FAIL_WINDOW_MS).toISOString();
  const byUser = username
    ? db.prepare("SELECT COUNT(*) AS n FROM auth_logs WHERE username = ? AND success = 0 AND created_at >= ?").get(username, since).n
    : 0;
  const byIp = db.prepare("SELECT COUNT(*) AS n FROM auth_logs WHERE ip = ? AND success = 0 AND created_at >= ?").get(String(ip), since).n;
  return byUser >= 5 || byIp >= 20;
}

app.use(globalLimiter);
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authLimiter);

// ══════════════════════════════════════════════════════════════════════
// Proteção CSRF
//  - Rotas que alteram dados exigem o cabeçalho X-CSRF-Token (64 hex). Um
//    cabeçalho customizado obriga o navegador a fazer preflight CORS, o que
//    barra formulários/requisições forjadas por outros sites.
//  - Se o cookie csrf_token também chegar (mesmo domínio), ele precisa ser
//    IGUAL ao cabeçalho (double-submit).
//  - Se ALLOWED_ORIGINS não for '*', Origin/Referer precisam estar na lista.
//  - CSRF_ENFORCE=false desativa (só para depuração).
// ══════════════════════════════════════════════════════════════════════
const csrfEnforce = parseBoolEnv('CSRF_ENFORCE', true);
const allowedOriginList = allowedOriginsRaw === '*' ? null : allowedOriginsRaw.split(',').map((o) => o.trim()).filter(Boolean);

function csrfProtect(req, res, next) {
  if (!csrfEnforce || ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.path.startsWith('/api/')) {
    next();
    return;
  }

  const fail = (code, message) => res.status(403).json({ isOk: false, error: { code, message } });

  const originHeader = String(req.headers.origin || '').trim();
  const refererOrigin = String(req.headers.referer || '').split('/').slice(0, 3).join('/');
  const origin = originHeader || refererOrigin;
  if (allowedOriginList && origin && origin !== 'null' && !allowedOriginList.includes(origin)) {
    fail('CSRF_ORIGIN', 'Origem não permitida.');
    return;
  }

  const headerToken = String(req.headers['x-csrf-token'] || '');
  if (!/^[a-f0-9]{64}$/.test(headerToken)) {
    fail('CSRF_TOKEN_MISSING', 'Token CSRF ausente. Recarregue a página e tente novamente.');
    return;
  }

  const cookieMatch = String(req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('csrf_token='));
  if (cookieMatch) {
    const cookieToken = decodeURIComponent(cookieMatch.slice('csrf_token='.length));
    const a = Buffer.from(cookieToken), b = Buffer.from(headerToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      fail('CSRF_TOKEN_INVALID', 'Token CSRF inválido. Recarregue a página.');
      return;
    }
  }
  next();
}
app.use(csrfProtect);

function requireWriteApiKey(req, res, next) {
  const isRecordsWrite = req.path.startsWith('/api/records') && ['POST', 'PUT', 'DELETE'].includes(req.method);
  if (!isRecordsWrite || !writeApiKey) {
    next();
    return;
  }

  const provided = String(req.headers['x-api-key'] || '').trim();
  if (provided !== writeApiKey) {
    res.status(401).json({ isOk: false, error: { message: 'Unauthorized' } });
    return;
  }

  next();
}

app.use(requireWriteApiKey);

// A partir daqui, toda leitura/gravação de /api/records exige login (token JWT válido).
// Antes, qualquer pessoa que soubesse a URL do servidor conseguia ver todos os
// dados de colaboradores, ausências etc. sem nunca ter feito login.
app.use('/api/records', authenticateToken);

// ──────────────────────────────────────────────
// Server-Sent Events – sincronização em tempo real
// ──────────────────────────────────────────────
const sseClients = new Map();

app.get('/api/events', authenticateToken, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // heartbeat a cada 25 s para manter a conexão viva
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  sseClients.set(res, req.user.username);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

function broadcastDataChanged(username) {
  if (sseClients.size === 0) return;
  const msg = `data: ${JSON.stringify({ type: 'dataChanged' })}\n\n`;
  for (const [client] of sseClients) {
    client.write(msg);
  }
}
// ──────────────────────────────────────────────

// ── Páginas do sistema servidas pelo próprio backend ────────────────────
// Abra http://localhost:PORTA/ e o login já fala com este servidor (mesma
// origem), sem precisar configurar URL nenhuma. Só uma lista fixa de arquivos
// é pública: .env, database.sqlite, .jwt-secret, backups etc. NUNCA são servidos.
const PUBLIC_PAGES = ['login.html', 'index.html', '404.html', 'config.js'];
app.get('/', (req, res) => res.redirect('/login.html'));
PUBLIC_PAGES.forEach((file) => {
  const full = path.join(__dirname, file);
  app.get('/' + file, (req, res, next) => {
    if (!fs.existsSync(full)) { next(); return; }
    res.sendFile(full);
  });
});
app.use('/sdk', express.static(path.join(__dirname, 'sdk'), { dotfiles: 'deny', index: false, fallthrough: true }));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'employee-management-backend' });
});

app.get('/api/records', (req, res) => {
  const rows = db
    .prepare('SELECT id, type, payload, created_at, updated_at FROM records ORDER BY created_at ASC')
    .all();

  const data = rows.map(mapRowToRecord).filter(Boolean);
  res.json({ isOk: true, data });
});

function tryGetAuthenticatedUser(req) {
  const authHeader = String(req.headers['authorization'] || '');
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : '';
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    return { username: normalizeUsername(decoded.username), is_admin: !!decoded.is_admin };
  } catch (err) {
    return null;
  }
}

app.post('/api/auth/register', (req, res) => {
  // Criar acesso para outra pessoa é uma ação de administrador. O
  // auto-registro público (ALLOW_SELF_REGISTER) é uma exceção separada,
  // pensada só para ambientes de teste.
  const requestingUser = tryGetAuthenticatedUser(req);
  const isAdminRequest = !!(requestingUser && requestingUser.is_admin);
  if (!allowSelfRegister && !isAdminRequest) {
    if (requestingUser) {
      res.status(403).json({ isOk: false, error: { message: 'Alteração não autorizada, fale com seu administrador ou desenvolvedor', code: 'AUTH_FORBIDDEN' } });
    } else {
      res.status(403).json({ isOk: false, error: { message: 'Criar novo acesso requer um administrador autenticado.' } });
    }
    return;
  }

  const username = normalizeUsername(req.body && req.body.username);
  const password = String((req.body && req.body.password) || '');

  const validationError = validateCredentials(username, password);
  if (validationError) {
    res.status(400).json({ isOk: false, error: { message: validationError } });
    return;
  }

  if (getUserByUsername(username)) {
    res.status(409).json({ isOk: false, error: { message: 'Este usuario ja existe.' } });
    return;
  }

  const nowIso = new Date().toISOString();
  db.prepare(
    'INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(username, hashPassword(password), nowIso, nowIso);

  res.status(201).json({ isOk: true, data: { username } });
});

app.post('/api/auth/login', (req, res) => {
  const username = normalizeUsername(req.body && req.body.username);
  const password = String((req.body && req.body.password) || '');

  // Autenticação local apenas.
  // Cada usuário tem seu próprio servidor backend (não há proxy para servidor remoto).
  // Removed: authHostRaw, proxyAuthRequest() function, and all proxy/SSRF logic.

  const validationError = validateCredentials(username, password);
  if (validationError) {
    const payload = { isOk: false, error: { message: validationError, code: 'AUTH_VALIDATION_ERROR' } };
    logAuthAttempt({
      username,
      ip: getClientIp(req),
      success: false,
      reasonCode: 'AUTH_VALIDATION_ERROR',
      reasonMessage: validationError
    });
    res.status(400).json(payload);
    return;
  }

  if (isLoginLocked(username, getClientIp(req))) {
    const message = 'Muitas tentativas incorretas. Aguarde alguns minutos e tente novamente.';
    logAuthAttempt({ username, ip: getClientIp(req), success: false, reasonCode: 'AUTH_LOCKED', reasonMessage: message });
    res.setHeader('Retry-After', String(Math.ceil(LOGIN_FAIL_WINDOW_MS / 1000)));
    res.status(429).json({ isOk: false, error: { message, code: 'RATE_LIMIT' } });
    return;
  }

  const user = getUserByUsername(username);
  // Executa o scrypt mesmo quando o usuário não existe, para que o tempo de
  // resposta não revele quais usuários existem.
  const passwordOk = verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
  if (!user || !passwordOk) {
    const message = 'Usuário ou senha inválidos.';
    logAuthAttempt({
      username,
      ip: getClientIp(req),
      success: false,
      reasonCode: 'AUTH_INVALID_CREDENTIALS',
      reasonMessage: message
    });
    res.status(401).json({ isOk: false, error: { message, code: 'AUTH_INVALID_CREDENTIALS' } });
    return;
  }

  logAuthAttempt({
    username,
    ip: getClientIp(req),
    success: true,
    reasonCode: 'AUTH_SUCCESS',
    reasonMessage: 'Login bem-sucedido'
  });
  res.json({ isOk: true, data: { username, isAdmin: !!user.is_admin, token: createAuthToken(username, user.is_admin) } });
});

app.put('/api/auth/password', authenticateToken, (req, res) => {
  const username = normalizeUsername(req.body && req.body.username);
  const password = String((req.body && req.body.password) || '');

  // REGRA DE NEGÓCIO: ninguém altera o acesso de outra pessoa — somente o
  // próprio usuário, e sempre pelo token da sessão (nem administrador altera
  // a senha de terceiros). O 'username' vindo do corpo só é aceito se for o
  // mesmo do token; caso contrário, a requisição é negada e registrada.
  if (username !== req.user.username) {
    logAuthAttempt({ username: req.user.username, ip: getClientIp(req), success: false, reasonCode: 'AUTH_FORBIDDEN_PASSWORD_CHANGE', reasonMessage: 'Tentativa de alterar senha de ' + username });
    res.status(403).json({ isOk: false, error: { message: 'Somente o próprio usuário pode alterar o seu acesso.', code: 'AUTH_FORBIDDEN' } });
    return;
  }

  const validationError = validateCredentials(username, password);
  if (validationError) {
    res.status(400).json({ isOk: false, error: { message: validationError } });
    return;
  }

  const existing = getUserByUsername(username);
  if (!existing) {
    res.status(404).json({ isOk: false, error: { message: 'Usuario nao encontrado.' } });
    return;
  }

  const nowIso = new Date().toISOString();
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE username = ?').run(
    hashPassword(password),
    nowIso,
    username
  );

  res.json({ isOk: true, data: { username } });
});

// Lista usuários com acesso ao sistema (nunca retorna o hash da senha).
app.get('/api/auth/users', authenticateToken, (req, res) => {
  // Administrador vê todos os usuários; os demais enxergam somente o próprio.
  const rows = req.user.is_admin
    ? db.prepare('SELECT username, is_admin, created_at, updated_at FROM users ORDER BY username ASC').all()
    : db.prepare('SELECT username, is_admin, created_at, updated_at FROM users WHERE username = ?').all(req.user.username);
  res.json({ isOk: true, data: rows.map((r) => ({ ...r, is_admin: !!r.is_admin })) });
});

// Remove o acesso de um usuário. Cada um pode remover só o próprio (embora
// isso já derrube a sessão dele); remover o acesso de outra pessoa exige
// ser administrador.
app.delete('/api/auth/users/:username', authenticateToken, (req, res) => {
  // REGRA DE NEGÓCIO: ninguém remove/altera o acesso de outra pessoa.
  logAuthAttempt({ username: req.user.username, ip: getClientIp(req), success: false, reasonCode: 'AUTH_FORBIDDEN_DELETE_USER', reasonMessage: 'Tentativa de remover acesso de ' + normalizeUsername(req.params.username) });
  res.status(403).json({ isOk: false, error: { message: 'Somente o próprio usuário pode alterar o seu acesso.', code: 'AUTH_FORBIDDEN' } });
});

app.post('/api/records', (req, res) => {
  const rawItem = req.body || {};

  if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
    res.status(400).json({ isOk: false, error: { message: 'Invalid payload' } });
    return;
  }

  const type = String(rawItem.type || '').trim();
  if (!ALLOWED_RECORD_TYPES.has(type)) {
    res.status(400).json({ isOk: false, error: { message: 'Tipo de registro inválido.' } });
    return;
  }

  const item = sanitizeRecordPayload(rawItem);
  item.type = type;

  const id = String(item.__backendId || (Date.now().toString() + Math.random().toString(36).slice(2, 11)));
  const nowIso = new Date().toISOString();

  const payload = { ...item, __backendId: id };

  try {
    db.prepare(
      'INSERT INTO records (id, type, payload, owner_username, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, String(payload.type || 'unknown'), JSON.stringify(payload), req.user.username, nowIso, nowIso);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      res.status(409).json({ isOk: false, error: { code: 'RECORD_ALREADY_EXISTS', message: 'Record already exists' } });
      return;
    }
    throw err;
  }

  broadcastDataChanged(req.user.username);
  res.status(201).json({ isOk: true, data: payload });
});

app.put('/api/records/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  const rawItem = req.body || {};

  if (!id) {
    res.status(400).json({ isOk: false, error: { message: 'Missing id' } });
    return;
  }

  if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
    res.status(400).json({ isOk: false, error: { message: 'Invalid payload' } });
    return;
  }

  const type = String(rawItem.type || '').trim();
  if (!ALLOWED_RECORD_TYPES.has(type)) {
    res.status(400).json({ isOk: false, error: { message: 'Tipo de registro inválido.' } });
    return;
  }

  const existing = db.prepare('SELECT id FROM records WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ isOk: false, error: { message: 'Item not found' } });
    return;
  }

  const item = sanitizeRecordPayload(rawItem);
  item.type = type;

  const nowIso = new Date().toISOString();
  const payload = { ...item, __backendId: id };

  try {
    db.prepare('UPDATE records SET type = ?, payload = ?, updated_at = ? WHERE id = ?').run(
      String(payload.type || 'unknown'),
      JSON.stringify(payload),
      nowIso,
      id
    );
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      res.status(409).json({ isOk: false, error: { code: 'RECORD_CONFLICT', message: 'Record conflict' } });
      return;
    }
    throw err;
  }

  broadcastDataChanged(req.user.username);
  res.json({ isOk: true, data: payload });
});

app.delete('/api/records/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) {
    res.status(400).json({ isOk: false, error: { message: 'Missing id' } });
    return;
  }

  const existing = db.prepare('SELECT id, type, payload FROM records WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ isOk: false, error: { message: 'Item not found' } });
    return;
  }

  let deletedRelated = 0;

  const removeRecordAndRelations = db.transaction((recordId, row) => {
    db.prepare('DELETE FROM records WHERE id = ?').run(recordId);

    if (!isEmployeeType(row && row.type)) {
      return 0;
    }

    const allRows = db.prepare('SELECT id, payload FROM records WHERE id != ?').all(recordId);
    let removed = 0;

    for (const candidate of allRows) {
      const parsed = parsePayloadSafe(candidate.payload);
      if (!parsed) continue;

      if (String(parsed.employee_id || '').trim() === recordId) {
        const out = db.prepare('DELETE FROM records WHERE id = ?').run(candidate.id);
        removed += Number(out && out.changes ? out.changes : 0);
      }
    }

    return removed;
  });

  deletedRelated = removeRecordAndRelations(id, existing);

  broadcastDataChanged(req.user.username);
  res.json({ isOk: true, data: { deletedRelated } });
});

app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    res.status(err.type === 'entity.too.large' ? 413 : 400).json({ isOk: false, error: { message: 'Corpo da requisição inválido.' } });
    return;
  }
  if (err && /CORS/i.test(String(err.message))) {
    res.status(403).json({ isOk: false, error: { message: 'Origem não permitida.' } });
    return;
  }
  console.error('[API Error]', err);
  res.status(500).json({ isOk: false, error: { message: 'Internal server error' } });
});

app.listen(port, () => {
  console.log(`[Backend] Running at http://localhost:${port}`);
  console.log(`[Backend] Database: ${resolvedDbPath}`);
  console.log(`[Backend] Self-register: ${allowSelfRegister ? 'enabled' : 'disabled'}`);
  console.log(`[Backend] Records write API key: ${writeApiKey ? 'enabled' : 'disabled'}`);
});