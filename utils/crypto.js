const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 16;
const TAG_LEN = 16;

function getKey() {
  if (process.env.INTEGRATION_SECRET) {
    return Buffer.from(process.env.INTEGRATION_SECRET, 'hex');
  }
  // Fallback: derive from JWT_SECRET for dev convenience
  return crypto.createHash('sha256')
    .update(process.env.JWT_SECRET || 'spacelogg-dev-key')
    .digest();
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  let enc = cipher.update(plaintext, 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${enc}`;
}

function decrypt(encryptedString) {
  const key = getKey();
  const [ivHex, tagHex, cipherHex] = encryptedString.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  let dec = decipher.update(cipherHex, 'hex', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

module.exports = { encrypt, decrypt };
