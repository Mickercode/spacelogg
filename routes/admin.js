const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const db      = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { Notify } = require('../utils/notify');
const { encrypt } = require('../utils/crypto');
const { clearCache } = require('../connectors');
const { sendEmail, emailTemplate } = require('../utils/mailer');
const router  = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'spacelogg_dev_secret';

router.use(requireAuth, requireAdmin);

function parse(row) {
  if (!row) return null;
  return { ...row,
    amenities: JSON.parse(row.amenities||'[]'),
    hours:     JSON.parse(row.hours||'{}'),
    images:    JSON.parse(row.images||'[]')
  };
}

// GET /api/admin/stats
router.get('/stats', async (req, res) => {
  const [total, pending, users, reviews, saved, bookings] = await Promise.all([
    db.getAsync("SELECT COUNT(*) as c FROM spaces WHERE status='approved'"),
    db.getAsync("SELECT COUNT(*) as c FROM spaces WHERE status='pending'"),
    db.getAsync("SELECT COUNT(*) as c FROM users WHERE role != 'admin'"),
    db.getAsync("SELECT COUNT(*) as c FROM reviews"),
    db.getAsync("SELECT COUNT(*) as c FROM saved_spaces"),
    db.getAsync("SELECT COUNT(*) as c FROM bookings WHERE status='confirmed'"),
  ]);
  res.json({
    totalSpaces:   total.c,
    pendingSpaces: pending.c,
    totalUsers:    users.c,
    totalReviews:  reviews.c,
    savedCount:    saved.c,
    totalBookings: bookings.c
  });
});

// GET /api/admin/spaces
router.get('/spaces', async (req, res) => {
  const { status='approved', limit=100, offset=0, q='' } = req.query;
  let sql = `SELECT s.*, u.name as owner_name, u.email as owner_email
             FROM spaces s LEFT JOIN users u ON u.id = s.owner_id
             WHERE s.status = ?`;
  const args = [status];
  if (q) { sql += ' AND (s.name LIKE ? OR s.city LIKE ?)'; args.push(`%${q}%`,`%${q}%`); }
  sql += ' ORDER BY s.created_at DESC LIMIT ? OFFSET ?';
  args.push(Number(limit), Number(offset));
  const spaces = await db.allAsync(sql, args);
  const row    = await db.getAsync('SELECT COUNT(*) as c FROM spaces WHERE status=?',[status]);
  res.json({ spaces: spaces.map(parse), total: row.c });
});

// PATCH /api/admin/spaces/:id/approve
router.patch('/spaces/:id/approve', async (req, res) => {
  const { status, reason } = req.body;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({error:'Invalid status'});
  const space = await db.getAsync('SELECT * FROM spaces WHERE id=?',[req.params.id]);
  if (!space) return res.status(404).json({error:'Space not found'});
  await db.runAsync('UPDATE spaces SET status=? WHERE id=?',[status, req.params.id]);
  if (space.owner_id) {
    if (status==='approved') await Notify.spaceApproved(space.owner_id, space.name);
    else await Notify.spaceRejected(space.owner_id, space.name, reason);
  }
  res.json({ message:`Space ${status}` });
});

// DELETE /api/admin/spaces/:id
router.delete('/spaces/:id', async (req, res) => {
  await db.runAsync('DELETE FROM spaces WHERE id=?',[req.params.id]);
  res.json({ message:'Space deleted' });
});

// GET /api/admin/bookings
router.get('/bookings', async (req, res) => {
  const { status } = req.query;
  let sql = `SELECT b.*, s.name as space_name, s.category,
             u.name as user_name, u.email as user_email
             FROM bookings b
             JOIN spaces s ON s.id = b.space_id
             JOIN users  u ON u.id = b.user_id`;
  const args = [];
  if (status) { sql += ' WHERE b.status=?'; args.push(status); }
  sql += ' ORDER BY b.date DESC, b.start_time DESC LIMIT 200';
  const bookings = await db.allAsync(sql, args);
  res.json({ bookings });
});

// GET /api/admin/users
router.get('/users', async (req, res) => {
  const { q } = req.query;
  let sql='SELECT id, name, email, role, created_at FROM users';
  const args=[];
  if (q) { sql+=' WHERE name LIKE ? OR email LIKE ?'; args.push(`%${q}%`,`%${q}%`); }
  sql+=' ORDER BY created_at DESC LIMIT 200';
  const users = await db.allAsync(sql, args);
  const row   = await db.getAsync('SELECT COUNT(*) as c FROM users');
  res.json({ users, total: row.c });
});

// PATCH /api/admin/users/:id — change role
router.patch('/users/:id', async (req, res) => {
  const { role } = req.body;
  if (!['user','admin'].includes(role)) return res.status(400).json({error:'Invalid role'});
  await db.runAsync('UPDATE users SET role=? WHERE id=?',[role, req.params.id]);
  res.json({ message:`User updated to ${role}` });
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', async (req, res) => {
  if (req.params.id == req.user.id) return res.status(400).json({error:"Can't delete yourself"});
  await db.runAsync('DELETE FROM users WHERE id=?',[req.params.id]);
  res.json({ message:'User deleted' });
});

// ═══════════════════════════════════════════════════
//  INTEGRATIONS MANAGEMENT
// ═══════════════════════════════════════════════════

const VALID_PLATFORMS = ['skedda', 'officernd', 'cobot', 'custom'];

// GET /api/admin/integrations
router.get('/integrations', async (req, res) => {
  const integrations = await db.allAsync(`
    SELECT si.*, s.name as space_name
    FROM space_integrations si
    JOIN spaces s ON s.id = si.space_id
    ORDER BY si.created_at DESC`);
  res.json({
    integrations: integrations.map(i => ({
      ...i, credentials_enc: undefined, has_credentials: !!i.credentials_enc
    }))
  });
});

// GET /api/admin/integrations/:id
router.get('/integrations/:id', async (req, res) => {
  const row = await db.getAsync(`
    SELECT si.*, s.name as space_name
    FROM space_integrations si
    JOIN spaces s ON s.id = si.space_id
    WHERE si.id = ?`, [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Integration not found' });
  res.json({ integration: { ...row, credentials_enc: undefined, has_credentials: !!row.credentials_enc } });
});

// POST /api/admin/integrations
router.post('/integrations', async (req, res) => {
  try {
    const { space_id, platform, external_space_id, credentials, config } = req.body;
    if (!space_id || !platform || !external_space_id || !credentials)
      return res.status(400).json({ error: 'space_id, platform, external_space_id and credentials are required' });
    if (!VALID_PLATFORMS.includes(platform))
      return res.status(400).json({ error: `Invalid platform. Must be one of: ${VALID_PLATFORMS.join(', ')}` });

    const space = await db.getAsync('SELECT id FROM spaces WHERE id = ?', [space_id]);
    if (!space) return res.status(404).json({ error: 'Space not found' });

    const existing = await db.getAsync('SELECT id FROM space_integrations WHERE space_id = ?', [space_id]);
    if (existing) return res.status(409).json({ error: 'This space already has an integration. Delete it first or update it.' });

    const credentialsEnc = encrypt(JSON.stringify(credentials));
    const { lastID } = await db.runAsync(
      `INSERT INTO space_integrations (space_id, platform, external_space_id, credentials_enc, config)
       VALUES (?, ?, ?, ?, ?)`,
      [space_id, platform, external_space_id, credentialsEnc, JSON.stringify(config || {})]
    );
    clearCache(space_id);
    res.status(201).json({ message: 'Integration created', id: lastID });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create integration' });
  }
});

// PATCH /api/admin/integrations/:id
router.patch('/integrations/:id', async (req, res) => {
  try {
    const row = await db.getAsync('SELECT * FROM space_integrations WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Integration not found' });

    const updates = []; const params = [];
    if (req.body.external_space_id) { updates.push('external_space_id = ?'); params.push(req.body.external_space_id); }
    if (req.body.platform && VALID_PLATFORMS.includes(req.body.platform)) { updates.push('platform = ?'); params.push(req.body.platform); }
    if (req.body.credentials) { updates.push('credentials_enc = ?'); params.push(encrypt(JSON.stringify(req.body.credentials))); }
    if (req.body.config !== undefined) { updates.push('config = ?'); params.push(JSON.stringify(req.body.config)); }
    if (req.body.enabled !== undefined) { updates.push('enabled = ?'); params.push(req.body.enabled ? 1 : 0); }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    updates.push("updated_at = NOW()");
    params.push(req.params.id);

    await db.runAsync(`UPDATE space_integrations SET ${updates.join(', ')} WHERE id = ?`, params);
    clearCache(row.space_id);
    res.json({ message: 'Integration updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update integration' });
  }
});

// DELETE /api/admin/integrations/:id
router.delete('/integrations/:id', async (req, res) => {
  const row = await db.getAsync('SELECT space_id FROM space_integrations WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Integration not found' });
  await db.runAsync('DELETE FROM space_integrations WHERE id = ?', [req.params.id]);
  clearCache(row.space_id);
  res.json({ message: 'Integration deleted — space reverted to native booking' });
});

// GET /api/admin/sync-log
router.get('/sync-log', async (req, res) => {
  const { space_id, status, limit = 50 } = req.query;
  let sql = `SELECT sl.*, s.name as space_name
             FROM booking_sync_log sl
             JOIN spaces s ON s.id = sl.space_id`;
  const args = [];
  const where = [];
  if (space_id) { where.push('sl.space_id = ?'); args.push(space_id); }
  if (status)   { where.push('sl.status = ?'); args.push(status); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY sl.created_at DESC LIMIT ?';
  args.push(Number(limit));
  const logs = await db.allAsync(sql, args);
  res.json({ logs });
});

// ═══════════════════════════════════════════════════
//  REVENUE & PAYOUTS
// ═══════════════════════════════════════════════════

// GET /api/admin/revenue
router.get('/revenue', async (req, res) => {
  try {
    const total = await db.getAsync("SELECT COALESCE(SUM(amount),0) as c FROM payments WHERE status='success'");
    const thisMonth = new Date().toISOString().substring(0, 7); // YYYY-MM
    const monthly = await db.getAsync(
      "SELECT COALESCE(SUM(amount),0) as c FROM payments WHERE status='success' AND created_at::text LIKE ?",
      [`${thisMonth}%`]
    );
    const pendingPayouts = await db.getAsync("SELECT COALESCE(SUM(amount),0) as c FROM payouts WHERE status='pending'");
    const completedPayouts = await db.getAsync("SELECT COALESCE(SUM(amount),0) as c FROM payouts WHERE status='paid'");
    const recentPayments = await db.allAsync(`
      SELECT p.*, b.date, b.start_time, b.end_time, s.name as space_name, u.name as user_name
      FROM payments p
      JOIN bookings b ON b.id = p.booking_id
      JOIN spaces s ON s.id = b.space_id
      JOIN users u ON u.id = b.user_id
      WHERE p.status = 'success'
      ORDER BY p.created_at DESC LIMIT 50`);
    res.json({
      totalRevenue: total.c,
      monthlyRevenue: monthly.c,
      pendingPayouts: pendingPayouts.c,
      completedPayouts: completedPayouts.c,
      recentPayments
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load revenue' }); }
});

// GET /api/admin/payouts
router.get('/payouts', async (req, res) => {
  const { status } = req.query;
  let sql = `SELECT p.*, u.name as owner_name, u.email as owner_email
             FROM payouts p JOIN users u ON u.id = p.owner_id`;
  const args = [];
  if (status) { sql += ' WHERE p.status = ?'; args.push(status); }
  sql += ' ORDER BY p.created_at DESC LIMIT 100';
  const payouts = await db.allAsync(sql, args);
  res.json({ payouts });
});

// POST /api/admin/payouts/generate — generate payout records for a period
router.post('/payouts/generate', async (req, res) => {
  try {
    const { period_start, period_end } = req.body;
    if (!period_start || !period_end)
      return res.status(400).json({ error: 'period_start and period_end are required (YYYY-MM-DD)' });

    const commission = Number(process.env.COMMISSION_PERCENT || 10) / 100;

    // Sum successful payments per space owner in the period
    const ownerTotals = await db.allAsync(`
      SELECT s.owner_id, SUM(p.amount) as total, p.currency
      FROM payments p
      JOIN bookings b ON b.id = p.booking_id
      JOIN spaces s ON s.id = b.space_id
      WHERE p.status = 'success'
        AND p.created_at >= ? AND p.created_at < ?
        AND s.owner_id IS NOT NULL
      GROUP BY s.owner_id, p.currency`, [period_start, period_end + 'T23:59:59']);

    let created = 0;
    for (const row of ownerTotals) {
      const payoutAmount = Math.round(row.total * (1 - commission));
      if (payoutAmount <= 0) continue;
      await db.runAsync(
        `INSERT INTO payouts (owner_id, amount, currency, period_start, period_end) VALUES (?, ?, ?, ?, ?)`,
        [row.owner_id, payoutAmount, row.currency, period_start, period_end]
      );
      created++;
    }
    res.json({ message: `Generated ${created} payout(s)`, commission: `${commission * 100}%` });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to generate payouts' }); }
});

// PATCH /api/admin/payouts/:id/mark-paid
router.patch('/payouts/:id/mark-paid', async (req, res) => {
  const row = await db.getAsync('SELECT * FROM payouts WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Payout not found' });
  if (row.status === 'paid') return res.status(400).json({ error: 'Already marked as paid' });
  await db.runAsync(
    "UPDATE payouts SET status = 'paid', paid_at = NOW(), note = ? WHERE id = ?",
    [req.body.note || '', req.params.id]
  );
  res.json({ message: 'Payout marked as paid' });
});

// ═══════════════════════════════════════════════════
//  OWNER ONBOARDING
// ═══════════════════════════════════════════════════

// POST /api/admin/onboard-owner — create or promote user to owner, generate magic link
router.post('/onboard-owner', async (req, res) => {
  try {
    const { name, email, space_ids } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    let user = await db.getAsync('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);

    if (user) {
      // Promote existing user to owner
      if (user.role === 'user') {
        await db.runAsync('UPDATE users SET role = ? WHERE id = ?', ['owner', user.id]);
      }
    } else {
      // Create new owner account with temporary password
      const tempPw = crypto.randomBytes(8).toString('hex');
      const hash = await bcrypt.hash(tempPw, 10);
      const { lastID } = await db.runAsync(
        "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'owner')",
        [name, email.toLowerCase(), hash]);
      user = { id: lastID, name, email: email.toLowerCase() };
    }

    // Assign spaces to this owner
    if (space_ids && space_ids.length) {
      for (const sid of space_ids) {
        await db.runAsync('UPDATE spaces SET owner_id = ? WHERE id = ?', [user.id, sid]);
      }
    }

    // Generate magic login token (valid 7 days)
    const token = jwt.sign({ id: user.id, email: user.email, role: 'owner' }, JWT_SECRET, { expiresIn: '7d' });
    const magicLink = `${appUrl}/space-admin/login.html?token=${token}`;

    // Send onboarding email
    await sendEmail({
      to: user.email,
      subject: 'Welcome to SpaceLogg — Your Owner Dashboard',
      html: emailTemplate({
        title: `Welcome, ${name}!`,
        body: `<p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#6B6456;line-height:1.7;margin:0 0 16px;">You've been set up as a space owner on SpaceLogg. Your dashboard lets you manage your spaces, view bookings, track revenue, and more.</p>
               <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#6B6456;line-height:1.7;margin:0 0 16px;">Click below to access your dashboard. This link is valid for 7 days.</p>`,
        ctaText: 'Open My Dashboard',
        ctaUrl: magicLink
      })
    });

    res.json({ message: 'Owner onboarded', user_id: user.id, magic_link: magicLink });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to onboard owner: ' + err.message });
  }
});

// GET /api/admin/owners — list all owners
router.get('/owners', async (req, res) => {
  const owners = await db.allAsync(
    "SELECT id, name, email, created_at FROM users WHERE role = 'owner' ORDER BY created_at DESC");
  for (const o of owners) {
    const row = await db.getAsync('SELECT COUNT(*) as c FROM spaces WHERE owner_id = ?', [o.id]);
    o.space_count = row.c;
    const profile = await db.getAsync('SELECT * FROM owner_profiles WHERE user_id = ?', [o.id]);
    o.profile = profile || {};
    const revenue = await db.getAsync(
      `SELECT COALESCE(SUM(p.amount),0) as total FROM payments p
       JOIN bookings b ON p.booking_id = b.id
       JOIN spaces s ON b.space_id = s.id
       WHERE s.owner_id = ? AND p.status = 'paid'`, [o.id]);
    o.total_revenue = revenue.total;
  }
  res.json({ owners });
});

// GET /api/admin/owners/:id — full owner detail
router.get('/owners/:id', async (req, res) => {
  const user = await db.getAsync("SELECT id, name, email, created_at FROM users WHERE id = ? AND role = 'owner'", [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Owner not found' });
  const profile = await db.getAsync('SELECT * FROM owner_profiles WHERE user_id = ?', [user.id]);
  const spaces = await db.allAsync('SELECT id, name, category, city, area, status, price FROM spaces WHERE owner_id = ?', [user.id]);
  const revenue = await db.getAsync(
    `SELECT COALESCE(SUM(p.amount),0) as total, COUNT(p.id) as count FROM payments p
     JOIN bookings b ON p.booking_id = b.id JOIN spaces s ON b.space_id = s.id
     WHERE s.owner_id = ? AND p.status = 'paid'`, [user.id]);
  const bookings = await db.getAsync(
    `SELECT COUNT(*) as total FROM bookings b JOIN spaces s ON b.space_id = s.id WHERE s.owner_id = ?`, [user.id]);
  res.json({ owner: { ...user, profile: profile || {}, spaces, revenue: revenue.total, booking_count: bookings.total, payment_count: revenue.count } });
});

// POST /api/admin/owners/:id/regenerate-link — regenerate magic link
router.post('/owners/:id/regenerate-link', async (req, res) => {
  const user = await db.getAsync("SELECT * FROM users WHERE id = ? AND role = 'owner'", [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Owner not found' });
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  const token = jwt.sign({ id: user.id, email: user.email, role: 'owner' }, JWT_SECRET, { expiresIn: '7d' });
  const magicLink = `${appUrl}/space-admin/login.html?token=${token}`;
  res.json({ magic_link: magicLink });
});

// POST /api/admin/owners/:id/create-subaccount — create Paystack subaccount
router.post('/owners/:id/create-subaccount', async (req, res) => {
  try {
    const user = await db.getAsync("SELECT * FROM users WHERE id = ? AND role = 'owner'", [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Owner not found' });
    const profile = await db.getAsync('SELECT * FROM owner_profiles WHERE user_id = ?', [user.id]);
    if (!profile || !profile.bank_name || !profile.account_number) {
      return res.status(400).json({ error: 'Owner has not added bank details yet' });
    }
    if (profile.paystack_subaccount_id) {
      return res.status(400).json({ error: 'Subaccount already exists: ' + profile.paystack_subaccount_id });
    }

    const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
    if (!PAYSTACK_SECRET) return res.status(500).json({ error: 'Paystack secret key not configured' });

    // Resolve bank code from bank name
    const banksRes = await fetch('https://api.paystack.co/bank', {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
    });
    const banksData = await banksRes.json();
    const bank = banksData.data?.find(b =>
      b.name.toLowerCase().includes(profile.bank_name.toLowerCase()) ||
      profile.bank_name.toLowerCase().includes(b.name.toLowerCase())
    );
    if (!bank) return res.status(400).json({ error: `Could not find bank "${profile.bank_name}" on Paystack. Check the bank name.` });

    // Create subaccount
    const subRes = await fetch('https://api.paystack.co/subaccount', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        business_name: profile.business_name || user.name,
        bank_code: bank.code,
        account_number: profile.account_number,
        percentage_charge: 10,
        settlement_bank: bank.code,
        account_name: profile.account_name || user.name,
        primary_contact_email: user.email
      })
    });
    const subData = await subRes.json();
    if (!subData.status) return res.status(400).json({ error: subData.message || 'Failed to create subaccount' });

    // Save subaccount code
    await db.runAsync('UPDATE owner_profiles SET paystack_subaccount_id = ? WHERE user_id = ?',
      [subData.data.subaccount_code, user.id]);

    res.json({ message: 'Subaccount created', subaccount_code: subData.data.subaccount_code });
  } catch (err) {
    console.error('Create subaccount error:', err);
    res.status(500).json({ error: 'Failed to create subaccount: ' + err.message });
  }
});

module.exports = router;
