const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
require('dotenv').config();

const BACKUP_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;

function resolvePath(value, fallback) {
  return path.resolve(__dirname, value || fallback);
}

function getConfig() {
  const dbFile = resolvePath(process.env.DB_FILE, './database.sqlite');
  const backupDir = resolvePath(process.env.BACKUP_DIR, './backups');
  const encryptionKey = String(process.env.BACKUP_ENCRYPTION_KEY || '').trim();
  const intervalMs = Math.max(60 * 60 * 1000, Number(process.env.BACKUP_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
  const retentionDays = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS);

  return { dbFile, backupDir, encryptionKey, intervalMs, retentionDays };
}

function deriveKey(secret, salt) {
  if (!secret) {
    throw new Error('BACKUP_ENCRYPTION_KEY não configurada.');
  }
  return crypto.scryptSync(secret, salt, 32);
}

function encrypt(buffer, secret) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(secret, salt), iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);

  return {
    version: BACKUP_VERSION,
    algorithm: ALGORITHM,
    createdAt: new Date().toISOString(),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decrypt(payload, secret) {
  if (!payload || payload.version !== BACKUP_VERSION || payload.algorithm !== ALGORITHM) {
    throw new Error('Formato de backup não reconhecido.');
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    deriveKey(secret, Buffer.from(payload.salt, 'base64')),
    Buffer.from(payload.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final()
  ]);
}

function removeExpiredBackups(backupDir, retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(backupDir)) {
    if (!file.endsWith('.sqlite.enc')) continue;
    const filePath = path.join(backupDir, file);
    if (fs.statSync(filePath).mtimeMs < cutoff) fs.rmSync(filePath, { force: true });
  }
}

async function createBackup(overrides = {}) {
  const config = { ...getConfig(), ...overrides };
  if (!config.encryptionKey) throw new Error('Defina BACKUP_ENCRYPTION_KEY antes de criar backups.');
  if (!fs.existsSync(config.dbFile)) throw new Error(`Banco não encontrado: ${config.dbFile}`);

  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const temporaryDb = path.join(config.backupDir, `.backup-${process.pid}-${Date.now()}.sqlite`);
  const outputFile = path.join(config.backupDir, `database-${stamp}.sqlite.enc`);

  const sourceDb = new Database(config.dbFile, { readonly: true, fileMustExist: true });
  try {
    await sourceDb.backup(temporaryDb);
  } finally {
    sourceDb.close();
  }

  try {
    const encrypted = encrypt(fs.readFileSync(temporaryDb), config.encryptionKey);
    const temporaryOutput = `${outputFile}.tmp`;
    fs.writeFileSync(temporaryOutput, JSON.stringify(encrypted), { mode: 0o600 });
    fs.renameSync(temporaryOutput, outputFile);
    removeExpiredBackups(config.backupDir, config.retentionDays);
    return outputFile;
  } finally {
    fs.rmSync(temporaryDb, { force: true });
  }
}

function restoreBackup(backupFile, destination, secret) {
  const payload = JSON.parse(fs.readFileSync(path.resolve(backupFile), 'utf8'));
  const decrypted = decrypt(payload, secret);
  const destinationPath = path.resolve(destination);
  const temporaryPath = `${destinationPath}.restore-${process.pid}.tmp`;

  fs.writeFileSync(temporaryPath, decrypted, { mode: 0o600 });
  const restoredDb = new Database(temporaryPath, { readonly: true, fileMustExist: true });
  restoredDb.pragma('integrity_check');
  restoredDb.close();
  fs.renameSync(temporaryPath, destinationPath);
  return destinationPath;
}

function startBackupScheduler() {
  const config = getConfig();
  if (String(process.env.BACKUP_ENABLED || 'false').toLowerCase() !== 'true') return null;
  if (!config.encryptionKey) {
    console.warn('[Backup] BACKUP_ENABLED=true, mas BACKUP_ENCRYPTION_KEY não foi configurada.');
    return null;
  }

  const run = () => createBackup(config)
    .then(file => console.log(`[Backup] Criado: ${file}`))
    .catch(error => console.error(`[Backup] Falha: ${error.message}`));

  run();
  return setInterval(run, config.intervalMs);
}

if (require.main === module) {
  const command = process.argv[2] || 'create';
  const config = getConfig();

  if (command === 'restore') {
    const backupFile = process.argv[3];
    const destination = process.argv[4] || config.dbFile;
    if (!backupFile) throw new Error('Uso: node backup.js restore <arquivo.sqlite.enc> [destino.sqlite]');
    console.log(`Restaurado: ${restoreBackup(backupFile, destination, config.encryptionKey)}`);
  } else {
    createBackup(config)
      .then(file => console.log(`Backup criado: ${file}`))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}

module.exports = { createBackup, restoreBackup, startBackupScheduler };