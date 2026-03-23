const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const db      = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { sendEmail, emailTemplate, welcomeEmail } = require('../utils/mailer');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'spacelogg_dev_secret';

function makeToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
}

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const existing = await db.getAsync('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const { lastID } = await db.runAsync('INSERT INTO users (name, email, password) VALUES (?, ?, ?)', [name.trim(), email.toLowerCase().trim(), hash]);
    const user = await db.getAsync('SELECT id, name, email, role, created_at FROM users WHERE id = ?', [lastID]);
    await db.runAsync(`INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'welcome', ?, ?)`,
      [user.id, 'Welcome to SpaceLogg! 🎉', `Hi ${user.name.split(' ')[0]}! Start exploring workspaces near you.`]);
    sendEmail({ to: user.email, subject: 'Welcome to SpaceLogg!', html: welcomeEmail(user.name) }).catch(() => {});
    res.status(201).json({ token: makeToken(user), user });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Registration failed' }); }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const user = await db.getAsync('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    const { password: _, ...safeUser } = user;
    res.json({ token: makeToken(safeUser), user: safeUser });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Login failed' }); }
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await db.getAsync('SELECT id, name, email, avatar, role, created_at FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

router.patch('/me', requireAuth, async (req, res) => {
  try {
    const { name, password } = req.body;
    const updates = []; const params = [];
    if (name)     { updates.push('name = ?');     params.push(name.trim()); }
    if (password) { if (password.length < 6) return res.status(400).json({ error: 'Password too short' }); updates.push('password = ?'); params.push(await bcrypt.hash(password, 10)); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.user.id);
    await db.runAsync(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    const updated = await db.getAsync('SELECT id, name, email, avatar, role, created_at FROM users WHERE id = ?', [req.user.id]);
    res.json({ user: updated });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Update failed' }); }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const user = await db.getAsync('SELECT id, name, email FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!user) return res.json({ message: 'If that email exists, a reset link has been sent.' });
    const token   = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600000).toISOString();
    await db.runAsync('INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)', [user.id, token, expires]);
    const resetUrl = `${process.env.APP_URL || 'http://localhost:3000'}/?reset=${token}`;
    await sendEmail({ to: user.email, subject: 'Reset your SpaceLogg password',
      html: emailTemplate({
        title: 'Reset your password',
        body: `<p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#6B6456;line-height:1.7;margin:0 0 8px;">Hi ${user.name.split(' ')[0]},</p><p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#6B6456;line-height:1.7;margin:0 0 8px;">We received a request to reset your SpaceLogg password. Click the button below — this link is valid for <strong>1 hour</strong>.</p><p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#9C8F78;line-height:1.7;margin:0;">If you didn't request this, you can safely ignore this email.</p>`,
        ctaText: 'Reset Password',
        ctaUrl: resetUrl
      })
    });
    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not send reset email' }); }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password too short' });
    const reset = await db.getAsync(`SELECT * FROM password_resets WHERE token = ? AND used = 0 AND expires_at > datetime('now')`, [token]);
    if (!reset) return res.status(400).json({ error: 'Invalid or expired reset link' });
    const hash = await bcrypt.hash(password, 10);
    await db.runAsync('UPDATE users SET password = ? WHERE id = ?', [hash, reset.user_id]);
    await db.runAsync('UPDATE password_resets SET used = 1 WHERE id = ?', [reset.id]);
    const user = await db.getAsync('SELECT id, name, email, role, created_at FROM users WHERE id = ?', [reset.user_id]);
    res.json({ token: makeToken(user), user, message: 'Password reset successfully' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Reset failed' }); }
});

router.get('/config', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
});

router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'No credential provided' });
    if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google sign-in not configured' });

    const { OAuth2Client } = require('google-auth-library');
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    const { email, name, picture } = ticket.getPayload();

    let user = await db.getAsync('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!user) {
      const randomPw = crypto.randomBytes(32).toString('hex');
      const hash = await bcrypt.hash(randomPw, 10);
      const { lastID } = await db.runAsync(
        'INSERT INTO users (name, email, password, avatar) VALUES (?, ?, ?, ?)',
        [name, email.toLowerCase(), hash, picture || '']
      );
      user = await db.getAsync('SELECT * FROM users WHERE id = ?', [lastID]);
      await db.runAsync(`INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'welcome', ?, ?)`,
        [user.id, 'Welcome to SpaceLogg! 🎉', `Hi ${name.split(' ')[0]}! Start exploring workspaces near you.`]);
      sendEmail({ to: user.email, subject: 'Welcome to SpaceLogg!', html: welcomeEmail(user.name) }).catch(() => {});
    }

    const { password: _, ...safeUser } = user;
    res.json({ token: makeToken(safeUser), user: safeUser });
  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(401).json({ error: 'Google sign-in failed' });
  }
});

module.exports = router;
