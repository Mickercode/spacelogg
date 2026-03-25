const express = require('express');
const db = require('../db/database');
const { requireAuth, requireOwner } = require('../middleware/auth');
const router = express.Router();

router.use(requireAuth, requireOwner);

function parse(row) {
  if (!row) return null;
  return { ...row, amenities: JSON.parse(row.amenities||'[]'), hours: JSON.parse(row.hours||'{}'), images: JSON.parse(row.images||'[]') };
}

// GET /api/owner/stats — overview stats for this owner
router.get('/stats', async (req, res) => {
  const uid = req.user.id;
  const [spaces, bookings, revenue, reviews, upcoming] = await Promise.all([
    db.getAsync('SELECT COUNT(*) as c FROM spaces WHERE owner_id = ?', [uid]),
    db.getAsync(`SELECT COUNT(*) as c FROM bookings b JOIN spaces s ON s.id = b.space_id
                 WHERE s.owner_id = ? AND b.status IN ('confirmed','paid')`, [uid]),
    db.getAsync(`SELECT COALESCE(SUM(p.amount),0) as c FROM payments p
                 JOIN bookings b ON b.id = p.booking_id JOIN spaces s ON s.id = b.space_id
                 WHERE s.owner_id = ? AND p.status = 'success'`, [uid]),
    db.getAsync(`SELECT COUNT(*) as c FROM reviews r JOIN spaces s ON s.id = r.space_id
                 WHERE s.owner_id = ?`, [uid]),
    db.getAsync(`SELECT COUNT(*) as c FROM bookings b JOIN spaces s ON s.id = b.space_id
                 WHERE s.owner_id = ? AND b.status = 'confirmed' AND b.date >= date('now')`, [uid]),
  ]);
  res.json({
    totalSpaces: spaces.c,
    totalBookings: bookings.c,
    totalRevenue: revenue.c,
    totalReviews: reviews.c,
    upcomingBookings: upcoming.c
  });
});

// GET /api/owner/spaces — owner's spaces
router.get('/spaces', async (req, res) => {
  const spaces = await db.allAsync(
    'SELECT * FROM spaces WHERE owner_id = ? ORDER BY created_at DESC', [req.user.id]);
  res.json({ spaces: spaces.map(parse) });
});

// GET /api/owner/bookings — all bookings across owner's spaces
router.get('/bookings', async (req, res) => {
  const { status, space_id } = req.query;
  let sql = `SELECT b.*, s.name as space_name, s.category, u.name as user_name, u.email as user_email
             FROM bookings b
             JOIN spaces s ON s.id = b.space_id
             JOIN users u ON u.id = b.user_id
             WHERE s.owner_id = ?`;
  const args = [req.user.id];
  if (status) { sql += ' AND b.status = ?'; args.push(status); }
  if (space_id) { sql += ' AND b.space_id = ?'; args.push(space_id); }
  sql += ' ORDER BY b.date DESC, b.start_time DESC LIMIT 100';
  const bookings = await db.allAsync(sql, args);
  res.json({ bookings });
});

// GET /api/owner/revenue — revenue breakdown
router.get('/revenue', async (req, res) => {
  const uid = req.user.id;
  const total = await db.getAsync(`
    SELECT COALESCE(SUM(p.amount),0) as c FROM payments p
    JOIN bookings b ON b.id = p.booking_id JOIN spaces s ON s.id = b.space_id
    WHERE s.owner_id = ? AND p.status = 'success'`, [uid]);
  const thisMonth = new Date().toISOString().substring(0, 7);
  const monthly = await db.getAsync(`
    SELECT COALESCE(SUM(p.amount),0) as c FROM payments p
    JOIN bookings b ON b.id = p.booking_id JOIN spaces s ON s.id = b.space_id
    WHERE s.owner_id = ? AND p.status = 'success' AND p.created_at LIKE ?`, [uid, `${thisMonth}%`]);
  const pendingPayout = await db.getAsync(
    "SELECT COALESCE(SUM(amount),0) as c FROM payouts WHERE owner_id = ? AND status = 'pending'", [uid]);
  const paidOut = await db.getAsync(
    "SELECT COALESCE(SUM(amount),0) as c FROM payouts WHERE owner_id = ? AND status = 'paid'", [uid]);
  res.json({
    totalRevenue: total.c,
    monthlyRevenue: monthly.c,
    pendingPayout: pendingPayout.c,
    paidOut: paidOut.c
  });
});

// GET /api/owner/reviews — reviews on owner's spaces
router.get('/reviews', async (req, res) => {
  const reviews = await db.allAsync(`
    SELECT r.*, s.name as space_name, u.name as user_name
    FROM reviews r
    JOIN spaces s ON s.id = r.space_id
    JOIN users u ON u.id = r.user_id
    WHERE s.owner_id = ?
    ORDER BY r.created_at DESC LIMIT 50`, [req.user.id]);
  res.json({ reviews });
});

// GET /api/owner/today — today's bookings
router.get('/today', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const bookings = await db.allAsync(`
    SELECT b.*, s.name as space_name, u.name as user_name, u.email as user_email
    FROM bookings b
    JOIN spaces s ON s.id = b.space_id
    JOIN users u ON u.id = b.user_id
    WHERE s.owner_id = ? AND b.date = ? AND b.status = 'confirmed'
    ORDER BY b.start_time ASC`, [req.user.id, today]);
  res.json({ bookings, date: today });
});

module.exports = router;
