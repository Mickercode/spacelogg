const express = require('express');
const db      = require('../db/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { Notify } = require('../utils/notify');
const router  = express.Router();

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

module.exports = router;
