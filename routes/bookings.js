const express = require('express');
const db      = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { sendEmail, emailTemplate } = require('../utils/mailer');
const { notify } = require('../utils/notify');
const router  = express.Router();

function parse(row) {
  if (!row) return null;
  return { ...row, amenities: JSON.parse(row.amenities||'[]'), hours: JSON.parse(row.hours||'{}'), images: JSON.parse(row.images||'[]') };
}

// GET /api/bookings — user's bookings
router.get('/', requireAuth, async (req, res) => {
  const bookings = await db.allAsync(`
    SELECT b.*, s.name as space_name, s.address, s.category, s.images
    FROM bookings b JOIN spaces s ON s.id = b.space_id
    WHERE b.user_id = ? ORDER BY b.date DESC, b.start_time DESC`, [req.user.id]);
  res.json({ bookings });
});

// GET /api/bookings/availability/:spaceId?date=YYYY-MM-DD
router.get('/availability/:spaceId', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
  const bookings = await db.allAsync(
    `SELECT start_time, end_time FROM bookings WHERE space_id = ? AND date = ? AND status != 'cancelled'`,
    [req.params.spaceId, date]);
  res.json({ date, bookedSlots: bookings });
});

// POST /api/bookings — create booking
router.post('/', requireAuth, async (req, res) => {
  try {
    const { space_id, date, start_time, end_time, guests, note } = req.body;
    if (!space_id || !date || !start_time || !end_time)
      return res.status(400).json({ error: 'space_id, date, start_time and end_time are required' });

    const space = await db.getAsync('SELECT * FROM spaces WHERE id = ? AND status = ?', [space_id, 'approved']);
    if (!space) return res.status(404).json({ error: 'Space not found' });

    // Check for conflicts
    const conflict = await db.getAsync(`
      SELECT id FROM bookings WHERE space_id = ? AND date = ? AND status != 'cancelled'
      AND NOT (end_time <= ? OR start_time >= ?)`, [space_id, date, start_time, end_time]);
    if (conflict) return res.status(409).json({ error: 'This time slot is already booked' });

    const { lastID } = await db.runAsync(
      `INSERT INTO bookings (space_id, user_id, date, start_time, end_time, guests, note, total_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [space_id, req.user.id, date, start_time, end_time, guests||1, note||'', space.price||'']);

    const booking = await db.getAsync(`
      SELECT b.*, s.name as space_name, s.address, s.category
      FROM bookings b JOIN spaces s ON s.id = b.space_id WHERE b.id = ?`, [lastID]);

    // In-app notification
    await notify({ userId: req.user.id, type: 'booking_confirmed', title: 'Booking confirmed! 🎉',
      message: `Your booking at ${space.name} on ${date} (${start_time}–${end_time}) is confirmed.` });

    // Email confirmation
    const user = await db.getAsync('SELECT name, email FROM users WHERE id = ?', [req.user.id]);
    await sendEmail({
      to: user.email,
      subject: `Booking confirmed — ${space.name}`,
      html: emailTemplate({
        title: 'Your booking is confirmed!',
        body: `<p>Hi ${user.name},</p>
               <p>Your workspace booking is all set:</p>
               <table style="width:100%;border-collapse:collapse;margin:16px 0">
                 <tr><td style="padding:8px 0;color:#9C8F78;font-size:14px">Space</td><td style="padding:8px 0;font-size:14px;font-weight:600">${space.name}</td></tr>
                 <tr><td style="padding:8px 0;color:#9C8F78;font-size:14px">Address</td><td style="padding:8px 0;font-size:14px">${space.address}</td></tr>
                 <tr><td style="padding:8px 0;color:#9C8F78;font-size:14px">Date</td><td style="padding:8px 0;font-size:14px">${date}</td></tr>
                 <tr><td style="padding:8px 0;color:#9C8F78;font-size:14px">Time</td><td style="padding:8px 0;font-size:14px">${start_time} – ${end_time}</td></tr>
                 <tr><td style="padding:8px 0;color:#9C8F78;font-size:14px">Guests</td><td style="padding:8px 0;font-size:14px">${guests||1}</td></tr>
               </table>`,
        ctaText: 'View my bookings',
        ctaUrl:  `${process.env.APP_URL||'http://localhost:3000'}/profile.html`
      })
    });

    // Notify space owner
    if (space.owner_id && space.owner_id !== req.user.id) {
      await notify({ userId: space.owner_id, type: 'new_booking', title: 'New booking!',
        message: `${user.name} booked ${space.name} on ${date} (${start_time}–${end_time}).` });
    }

    res.status(201).json({ booking, message: 'Booking confirmed' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Booking failed' }); }
});

// PATCH /api/bookings/:id/cancel
router.patch('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const booking = await db.getAsync('SELECT * FROM bookings WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status === 'cancelled') return res.status(400).json({ error: 'Already cancelled' });
    await db.runAsync('UPDATE bookings SET status = ? WHERE id = ?', ['cancelled', req.params.id]);
    const space = await db.getAsync('SELECT name FROM spaces WHERE id = ?', [booking.space_id]);
    await notify({ userId: req.user.id, type: 'booking_cancelled', title: 'Booking cancelled',
      message: `Your booking at ${space?.name} on ${booking.date} has been cancelled.` });
    res.json({ message: 'Booking cancelled' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Cancellation failed' }); }
});

// GET /api/bookings/my-space/:spaceId — owner sees bookings for their space
router.get('/my-space/:spaceId', requireAuth, async (req, res) => {
  const space = await db.getAsync('SELECT owner_id FROM spaces WHERE id = ?', [req.params.spaceId]);
  if (!space || (space.owner_id !== req.user.id && req.user.role !== 'admin'))
    return res.status(403).json({ error: 'Not authorized' });
  const bookings = await db.allAsync(`
    SELECT b.*, u.name as user_name, u.email as user_email
    FROM bookings b JOIN users u ON u.id = b.user_id
    WHERE b.space_id = ? ORDER BY b.date DESC`, [req.params.spaceId]);
  res.json({ bookings });
});

module.exports = router;
