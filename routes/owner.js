const express = require('express');
const db = require('../db/database');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { upload, uploadFiles } = require('../utils/cloudinary');
const { Notify } = require('../utils/notify');
const router = express.Router();

router.use(requireAuth, requireOwner);

function parse(row) {
  if (!row) return null;
  return { ...row, amenities: JSON.parse(row.amenities||'[]'), hours: JSON.parse(row.hours||'{}'), images: JSON.parse(row.images||'[]') };
}

// ═══════════════════════════════════════════════════
//  DASHBOARD STATS
// ═══════════════════════════════════════════════════

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
  res.json({ totalSpaces: spaces.c, totalBookings: bookings.c, totalRevenue: revenue.c, totalReviews: reviews.c, upcomingBookings: upcoming.c });
});

router.get('/today', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const bookings = await db.allAsync(`
    SELECT b.*, s.name as space_name, u.name as user_name, u.email as user_email
    FROM bookings b JOIN spaces s ON s.id = b.space_id JOIN users u ON u.id = b.user_id
    WHERE s.owner_id = ? AND b.date = ? AND b.status = 'confirmed'
    ORDER BY b.start_time ASC`, [req.user.id, today]);
  res.json({ bookings, date: today });
});

// ═══════════════════════════════════════════════════
//  BUSINESS PROFILE
// ═══════════════════════════════════════════════════

router.get('/profile', async (req, res) => {
  let profile = await db.getAsync('SELECT * FROM owner_profiles WHERE user_id = ?', [req.user.id]);
  if (!profile) {
    await db.runAsync("INSERT INTO owner_profiles (user_id) VALUES (?)", [req.user.id]);
    profile = await db.getAsync('SELECT * FROM owner_profiles WHERE user_id = ?', [req.user.id]);
  }
  res.json({ profile });
});

router.patch('/profile', upload.single('logo'), async (req, res) => {
  try {
    const fields = ['business_name', 'business_description', 'phone', 'bank_name', 'account_number', 'account_name'];
    const updates = []; const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }
    if (req.file) {
      const [logoUrl] = await uploadFiles([req.file]);
      updates.push('logo = ?'); params.push(logoUrl);
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    updates.push("updated_at = datetime('now')");
    params.push(req.user.id);
    // Ensure profile exists
    await db.runAsync("INSERT OR IGNORE INTO owner_profiles (user_id) VALUES (?)", [req.user.id]);
    await db.runAsync(`UPDATE owner_profiles SET ${updates.join(', ')} WHERE user_id = ?`, params);
    const profile = await db.getAsync('SELECT * FROM owner_profiles WHERE user_id = ?', [req.user.id]);
    res.json({ profile, message: 'Profile updated' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Update failed' }); }
});

// ═══════════════════════════════════════════════════
//  SPACE MANAGEMENT
// ═══════════════════════════════════════════════════

router.get('/spaces', async (req, res) => {
  const spaces = await db.allAsync('SELECT * FROM spaces WHERE owner_id = ? ORDER BY created_at DESC', [req.user.id]);
  res.json({ spaces: spaces.map(parse) });
});

router.post('/spaces', upload.array('images', 6), async (req, res) => {
  try {
    const { name, category, description, address, city, area, lat, lng, price, walkin_price, price_unit,
            price_hourly, price_monthly, amenities, hours, capacity, wifi_speed, power_backup } = req.body;
    if (!name || !category || !address) return res.status(400).json({ error: 'Name, category, and address are required' });
    const images = req.files?.length ? await uploadFiles(req.files) : [];
    const { lastID } = await db.runAsync(
      `INSERT INTO spaces (name,category,description,address,city,area,lat,lng,price,walkin_price,price_unit,
       price_hourly,price_monthly,amenities,hours,images,owner_id,status,capacity,wifi_speed,power_backup)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
      [name, category, description||'', address, city||'', area||'',
       lat?Number(lat):null, lng?Number(lng):null,
       price||'', walkin_price||'', price_unit||'',
       price_hourly||'', price_monthly||'',
       amenities||'[]', hours||'{}',
       JSON.stringify(images), req.user.id,
       Number(capacity)||1, wifi_speed||'', power_backup||'']);
    const space = await db.getAsync('SELECT * FROM spaces WHERE id=?', [lastID]);
    res.status(201).json({ space: parse(space), message: 'Space submitted for review' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create space' }); }
});

router.patch('/spaces/:id', upload.array('images', 6), async (req, res) => {
  try {
    const space = await db.getAsync('SELECT * FROM spaces WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
    if (!space) return res.status(404).json({ error: 'Space not found' });
    const fields = ['name','category','description','address','city','area','lat','lng','price','walkin_price',
                    'price_unit','price_hourly','price_monthly','amenities','hours','capacity','wifi_speed','power_backup'];
    const updates = []; const params = [];
    for (const f of fields) { if (req.body[f] !== undefined) { updates.push(`${f}=?`); params.push(req.body[f]); } }
    const keptRaw = req.body.kept_images;
    const kept = keptRaw ? JSON.parse(keptRaw) : JSON.parse(space.images||'[]');
    const newUploads = req.files?.length ? await uploadFiles(req.files) : [];
    if (keptRaw || newUploads.length) { updates.push('images=?'); params.push(JSON.stringify([...kept,...newUploads])); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    await db.runAsync(`UPDATE spaces SET ${updates.join(',')} WHERE id=?`, params);
    res.json({ space: parse(await db.getAsync('SELECT * FROM spaces WHERE id=?', [req.params.id])), message: 'Space updated' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Update failed' }); }
});

router.delete('/spaces/:id', async (req, res) => {
  const space = await db.getAsync('SELECT id FROM spaces WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
  if (!space) return res.status(404).json({ error: 'Space not found' });
  await db.runAsync('DELETE FROM spaces WHERE id = ?', [req.params.id]);
  res.json({ message: 'Space deleted' });
});

// Toggle space availability
router.patch('/spaces/:id/toggle', async (req, res) => {
  const space = await db.getAsync('SELECT id, status FROM spaces WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
  if (!space) return res.status(404).json({ error: 'Space not found' });
  const newStatus = space.status === 'approved' ? 'unavailable' : 'approved';
  await db.runAsync('UPDATE spaces SET status = ? WHERE id = ?', [newStatus, req.params.id]);
  res.json({ message: `Space ${newStatus === 'approved' ? 'made available' : 'marked unavailable'}`, status: newStatus });
});

// ═══════════════════════════════════════════════════
//  AVAILABILITY MANAGEMENT
// ═══════════════════════════════════════════════════

// Get blocked dates for a space
router.get('/availability/:spaceId', async (req, res) => {
  const space = await db.getAsync('SELECT id FROM spaces WHERE id = ? AND owner_id = ?', [req.params.spaceId, req.user.id]);
  if (!space) return res.status(404).json({ error: 'Space not found' });
  const blocks = await db.allAsync(
    'SELECT * FROM availability_blocks WHERE space_id = ? AND block_date >= date(\'now\') ORDER BY block_date ASC',
    [req.params.spaceId]);
  res.json({ blocks });
});

// Block a date/time
router.post('/availability/:spaceId/block', async (req, res) => {
  const { block_date, start_time, end_time, reason } = req.body;
  if (!block_date) return res.status(400).json({ error: 'block_date is required' });
  const space = await db.getAsync('SELECT id FROM spaces WHERE id = ? AND owner_id = ?', [req.params.spaceId, req.user.id]);
  if (!space) return res.status(404).json({ error: 'Space not found' });
  await db.runAsync(
    'INSERT INTO availability_blocks (space_id, block_date, start_time, end_time, reason) VALUES (?, ?, ?, ?, ?)',
    [req.params.spaceId, block_date, start_time||null, end_time||null, reason||'']);
  res.status(201).json({ message: 'Date blocked' });
});

// Remove a block
router.delete('/availability/block/:blockId', async (req, res) => {
  const block = await db.getAsync(`
    SELECT ab.* FROM availability_blocks ab JOIN spaces s ON s.id = ab.space_id
    WHERE ab.id = ? AND s.owner_id = ?`, [req.params.blockId, req.user.id]);
  if (!block) return res.status(404).json({ error: 'Block not found' });
  await db.runAsync('DELETE FROM availability_blocks WHERE id = ?', [req.params.blockId]);
  res.json({ message: 'Block removed' });
});

// ═══════════════════════════════════════════════════
//  BOOKING MANAGEMENT
// ═══════════════════════════════════════════════════

router.get('/bookings', async (req, res) => {
  const { status, space_id, from, to } = req.query;
  let sql = `SELECT b.*, s.name as space_name, s.category, u.name as user_name, u.email as user_email
             FROM bookings b JOIN spaces s ON s.id = b.space_id JOIN users u ON u.id = b.user_id
             WHERE s.owner_id = ?`;
  const args = [req.user.id];
  if (status) { sql += ' AND b.status = ?'; args.push(status); }
  if (space_id) { sql += ' AND b.space_id = ?'; args.push(space_id); }
  if (from) { sql += ' AND b.date >= ?'; args.push(from); }
  if (to) { sql += ' AND b.date <= ?'; args.push(to); }
  sql += ' ORDER BY b.date DESC, b.start_time DESC LIMIT 200';
  const bookings = await db.allAsync(sql, args);
  res.json({ bookings });
});

// Accept/reject a booking
router.patch('/bookings/:id/respond', async (req, res) => {
  const { action } = req.body; // 'accept' or 'reject'
  if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'Action must be accept or reject' });
  const booking = await db.getAsync(`
    SELECT b.*, s.owner_id FROM bookings b JOIN spaces s ON s.id = b.space_id
    WHERE b.id = ? AND s.owner_id = ?`, [req.params.id, req.user.id]);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (action === 'accept') {
    await db.runAsync("UPDATE bookings SET status_owner = 'accepted' WHERE id = ?", [req.params.id]);
    await Notify.bookingAccepted(booking.user_id, booking.space_name || 'your space', booking.date);
  } else {
    await db.runAsync("UPDATE bookings SET status = 'cancelled', status_owner = 'rejected' WHERE id = ?", [req.params.id]);
    await Notify.bookingRejected(booking.user_id, booking.space_name || 'a space', booking.date);
  }
  res.json({ message: `Booking ${action}ed` });
});

// Mark no-show
router.patch('/bookings/:id/no-show', async (req, res) => {
  const booking = await db.getAsync(`
    SELECT b.id FROM bookings b JOIN spaces s ON s.id = b.space_id
    WHERE b.id = ? AND s.owner_id = ?`, [req.params.id, req.user.id]);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  await db.runAsync("UPDATE bookings SET status_owner = 'no_show' WHERE id = ?", [req.params.id]);
  res.json({ message: 'Marked as no-show' });
});

// ═══════════════════════════════════════════════════
//  REVENUE & PAYOUTS
// ═══════════════════════════════════════════════════

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
  const recentPayments = await db.allAsync(`
    SELECT p.amount, p.currency, p.created_at, b.date, b.start_time, b.end_time, s.name as space_name, u.name as user_name
    FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN spaces s ON s.id = b.space_id JOIN users u ON u.id = b.user_id
    WHERE s.owner_id = ? AND p.status = 'success' ORDER BY p.created_at DESC LIMIT 20`, [uid]);
  res.json({ totalRevenue: total.c, monthlyRevenue: monthly.c, pendingPayout: pendingPayout.c, paidOut: paidOut.c, recentPayments });
});

router.get('/payouts', async (req, res) => {
  const payouts = await db.allAsync(
    'SELECT * FROM payouts WHERE owner_id = ? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json({ payouts });
});

// ═══════════════════════════════════════════════════
//  REVIEWS
// ═══════════════════════════════════════════════════

router.get('/reviews', async (req, res) => {
  const reviews = await db.allAsync(`
    SELECT r.*, s.name as space_name, u.name as user_name
    FROM reviews r JOIN spaces s ON s.id = r.space_id JOIN users u ON u.id = r.user_id
    WHERE s.owner_id = ? ORDER BY r.created_at DESC LIMIT 50`, [req.user.id]);
  res.json({ reviews });
});

// ═══════════════════════════════════════════════════
//  ANALYTICS
// ═══════════════════════════════════════════════════

router.get('/analytics', async (req, res) => {
  const uid = req.user.id;

  // Busiest days of week
  const busiestDays = await db.allAsync(`
    SELECT CASE cast(strftime('%w', b.date) as integer)
      WHEN 0 THEN 'Sun' WHEN 1 THEN 'Mon' WHEN 2 THEN 'Tue' WHEN 3 THEN 'Wed'
      WHEN 4 THEN 'Thu' WHEN 5 THEN 'Fri' WHEN 6 THEN 'Sat' END as day,
      COUNT(*) as count
    FROM bookings b JOIN spaces s ON s.id = b.space_id
    WHERE s.owner_id = ? AND b.status = 'confirmed'
    GROUP BY strftime('%w', b.date) ORDER BY count DESC`, [uid]);

  // Bookings per space
  const perSpace = await db.allAsync(`
    SELECT s.name, COUNT(b.id) as bookings, COALESCE(SUM(CASE WHEN p.status='success' THEN p.amount ELSE 0 END),0) as revenue
    FROM spaces s LEFT JOIN bookings b ON b.space_id = s.id AND b.status IN ('confirmed','paid')
    LEFT JOIN payments p ON p.booking_id = b.id
    WHERE s.owner_id = ? GROUP BY s.id ORDER BY bookings DESC`, [uid]);

  // Monthly trend (last 6 months)
  const monthlyTrend = await db.allAsync(`
    SELECT strftime('%Y-%m', b.date) as month, COUNT(*) as bookings
    FROM bookings b JOIN spaces s ON s.id = b.space_id
    WHERE s.owner_id = ? AND b.status = 'confirmed' AND b.date >= date('now', '-6 months')
    GROUP BY month ORDER BY month ASC`, [uid]);

  // Cancellation rate
  const totalB = await db.getAsync(`SELECT COUNT(*) as c FROM bookings b JOIN spaces s ON s.id = b.space_id WHERE s.owner_id = ?`, [uid]);
  const cancelled = await db.getAsync(`SELECT COUNT(*) as c FROM bookings b JOIN spaces s ON s.id = b.space_id WHERE s.owner_id = ? AND b.status = 'cancelled'`, [uid]);
  const cancellationRate = totalB.c > 0 ? Math.round((cancelled.c / totalB.c) * 100) : 0;

  // Occupancy (bookings this week / capacity * 7)
  const thisWeekBookings = await db.getAsync(`
    SELECT COUNT(*) as c FROM bookings b JOIN spaces s ON s.id = b.space_id
    WHERE s.owner_id = ? AND b.status = 'confirmed' AND b.date >= date('now', '-7 days')`, [uid]);
  const totalCapacity = await db.getAsync(`SELECT COALESCE(SUM(capacity),1) as c FROM spaces WHERE owner_id = ? AND status = 'approved'`, [uid]);
  const occupancyRate = Math.min(100, Math.round((thisWeekBookings.c / (totalCapacity.c * 7)) * 100));

  res.json({ busiestDays, perSpace, monthlyTrend, cancellationRate, occupancyRate });
});

module.exports = router;
