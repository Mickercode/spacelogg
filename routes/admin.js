const express = require('express');
const db = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { Notify } = require('../utils/notify');
const router = express.Router();

router.use(requireAuth, requireAdmin);

function parse(row) {
  if (!row) return null;
  return { ...row, amenities: JSON.parse(row.amenities||'[]'), hours: JSON.parse(row.hours||'{}'), images: JSON.parse(row.images||'[]') };
}

router.get('/stats', async (req, res) => {
  const [total, pending, users, reviews, saved, byCategory] = await Promise.all([
    db.getAsync("SELECT COUNT(*) as c FROM spaces WHERE status='approved'"),
    db.getAsync("SELECT COUNT(*) as c FROM spaces WHERE status='pending'"),
    db.getAsync("SELECT COUNT(*) as c FROM users WHERE role != 'admin'"),
    db.getAsync("SELECT COUNT(*) as c FROM reviews"),
    db.getAsync("SELECT COUNT(*) as c FROM saved_spaces"),
    db.allAsync("SELECT category, COUNT(*) as count FROM spaces WHERE status='approved' GROUP BY category"),
  ]);
  res.json({ totalSpaces: total.c, pendingSpaces: pending.c, totalUsers: users.c, totalReviews: reviews.c, savedCount: saved.c, byCategory });
});

router.get('/spaces', async (req, res) => {
  const { status = 'pending', limit = 50, offset = 0 } = req.query;
  const spaces = await db.allAsync(
    `SELECT s.*, u.name as owner_name, u.email as owner_email FROM spaces s
     LEFT JOIN users u ON u.id = s.owner_id WHERE s.status = ? ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
    [status, Number(limit), Number(offset)]);
  const row = await db.getAsync('SELECT COUNT(*) as c FROM spaces WHERE status = ?', [status]);
  res.json({ spaces: spaces.map(parse), total: row.c });
});

router.patch('/spaces/:id/approve', async (req, res) => {
  const { status, reason } = req.body;
  if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const space = await db.getAsync('SELECT * FROM spaces WHERE id = ?', [req.params.id]);
  if (!space) return res.status(404).json({ error: 'Space not found' });
  await db.runAsync('UPDATE spaces SET status = ? WHERE id = ?', [status, req.params.id]);
  if (space.owner_id) {
    if (status === 'approved') await Notify.spaceApproved(space.owner_id, space.name);
    else await Notify.spaceRejected(space.owner_id, space.name, reason);
  }
  res.json({ message: `Space ${status}` });
});

router.get('/users', async (req, res) => {
  const { q, limit = 50, offset = 0 } = req.query;
  let sql = 'SELECT id, name, email, role, created_at FROM users'; const args = [];
  if (q) { sql += ' WHERE name LIKE ? OR email LIKE ?'; args.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'; args.push(Number(limit), Number(offset));
  const users = await db.allAsync(sql, args);
  const row   = await db.getAsync('SELECT COUNT(*) as c FROM users');
  res.json({ users, total: row.c });
});

router.patch('/users/:id', async (req, res) => {
  const { role } = req.body;
  if (!['user','admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  await db.runAsync('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
  res.json({ message: 'User updated' });
});

router.delete('/users/:id', async (req, res) => {
  if (req.params.id == req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  await db.runAsync('DELETE FROM users WHERE id = ?', [req.params.id]);
  res.json({ message: 'User deleted' });
});

router.delete('/spaces/:id', async (req, res) => {
  await db.runAsync('DELETE FROM spaces WHERE id = ?', [req.params.id]);
  res.json({ message: 'Space deleted' });
});

module.exports = router;
