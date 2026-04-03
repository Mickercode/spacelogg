const express = require('express');
const db      = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { sendEmail, emailTemplate } = require('../utils/mailer');
const { notify, Notify } = require('../utils/notify');
const { getConnector } = require('../connectors');
const { initializeTransaction, verifyTransaction, refundTransaction, parsePrice, formatAmount, generateReference } = require('../utils/payment');
const { completeBookingAfterPayment } = require('./webhooks');
const router  = express.Router();

// GET /api/bookings — user's bookings (optional ?space_id= filter)
router.get('/', requireAuth, async (req, res) => {
  let sql = `SELECT b.*, s.name as space_name, s.address, s.category, s.images
    FROM bookings b JOIN spaces s ON s.id = b.space_id
    WHERE b.user_id = ?`;
  const params = [req.user.id];
  if (req.query.space_id) { sql += ' AND b.space_id = ?'; params.push(req.query.space_id); }
  sql += ' ORDER BY b.date DESC, b.start_time DESC';
  const bookings = await db.allAsync(sql, params);
  res.json({ bookings });
});

// GET /api/bookings/availability/:spaceId?date=YYYY-MM-DD
router.get('/availability/:spaceId', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
  const connector = await getConnector(req.params.spaceId);
  const result = await connector.checkAvailability(req.params.spaceId, date);
  res.json({ date, bookedSlots: result.bookedSlots });
});

// POST /api/bookings — create booking (with payment if not free)
router.post('/', requireAuth, async (req, res) => {
  try {
    const { space_id, date, start_time, end_time, guests, note, offer_id, code } = req.body;
    if (!space_id || !date || !start_time || !end_time)
      return res.status(400).json({ error: 'space_id, date, start_time and end_time are required' });

    // Verify space
    const space = await db.getAsync('SELECT * FROM spaces WHERE id = ? AND status = ?', [space_id, 'approved']);
    if (!space) return res.status(404).json({ error: 'Space not found' });

    // Check for time conflicts
    const conflict = await db.getAsync(`
      SELECT id FROM bookings WHERE space_id = ? AND date = ? AND status NOT IN ('cancelled','refunded')
      AND NOT (end_time <= ? OR start_time >= ?)`, [space_id, date, start_time, end_time]);
    if (conflict) return res.status(409).json({ error: 'This time slot is already booked' });

    // Parse price
    let { amountKobo, currency } = parsePrice(space.price);
    const appUrl = process.env.APP_URL || 'http://localhost:3000';

    // Apply offer/promo code discount
    let appliedOffer = null, discountKobo = 0;
    if (amountKobo > 0 && (offer_id || code)) {
      let offer = null;
      if (code) {
        offer = await db.getAsync(
          `SELECT * FROM offers WHERE space_id = ? AND code = ? AND type = 'discount_code'
           AND active = 1 AND (valid_from IS NULL OR valid_from <= NOW())
           AND (valid_until IS NULL OR valid_until >= NOW())
           AND (max_uses = 0 OR current_uses < max_uses)`,
          [space_id, code.toUpperCase()]);
      } else if (offer_id) {
        offer = await db.getAsync(
          `SELECT * FROM offers WHERE id = ? AND space_id = ? AND active = 1
           AND (valid_from IS NULL OR valid_from <= NOW())
           AND (valid_until IS NULL OR valid_until >= NOW())
           AND (max_uses = 0 OR current_uses < max_uses)`,
          [offer_id, space_id]);
      }
      if (offer) {
        if (offer.type === 'bundle') {
          const count = await db.getAsync(
            "SELECT COUNT(*) as c FROM bookings WHERE user_id = ? AND space_id = ? AND status IN ('confirmed','paid')",
            [req.user.id, space_id]);
          const totalCycle = offer.bundle_buy + offer.bundle_free;
          if (((count.c % totalCycle) + 1) > offer.bundle_buy) discountKobo = amountKobo;
        } else if (offer.type === 'first_time') {
          const prev = await db.getAsync(
            "SELECT id FROM bookings WHERE user_id = ? AND space_id = ? AND status IN ('confirmed','paid') LIMIT 1",
            [req.user.id, space_id]);
          if (!prev) discountKobo = Math.round(amountKobo * (offer.discount_percent / 100));
        } else {
          discountKobo = Math.round(amountKobo * (offer.discount_percent / 100));
        }
        if (discountKobo > 0) {
          appliedOffer = offer;
          amountKobo = Math.max(0, amountKobo - discountKobo);
        }
      }
    }

    // FREE SPACE or fully discounted — confirm immediately
    if (amountKobo === 0) {
      const connector = await getConnector(space_id);
      const result = await connector.createBooking({
        spaceId: space_id, userId: req.user.id,
        date, startTime: start_time, endTime: end_time, guests, note
      });
      if (result.error) return res.status(result.statusCode || 500).json({ error: result.error });

      const { booking } = result;

      await notify({ userId: req.user.id, type: 'booking_confirmed', title: 'Booking confirmed! 🎉',
        message: `Your booking at ${space.name} on ${date} (${start_time}–${end_time}) is confirmed.` });

      const user = await db.getAsync('SELECT name, email FROM users WHERE id = ?', [req.user.id]);
      await sendEmail({
        to: user.email,
        subject: `Booking confirmed — ${space.name}`,
        html: emailTemplate({
          title: 'Your booking is confirmed!',
          body: `<p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#6B6456;line-height:1.7;margin:0 0 16px;">Hi ${user.name},</p>
                 <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#6B6456;line-height:1.7;margin:0 0 16px;">Your free workspace booking is confirmed:</p>
                 <table style="width:100%;border-collapse:collapse;margin:16px 0">
                   <tr><td style="padding:8px 0;color:#9C8F78;font-size:14px">Space</td><td style="padding:8px 0;font-size:14px;font-weight:600">${space.name}</td></tr>
                   <tr><td style="padding:8px 0;color:#9C8F78;font-size:14px">Date</td><td style="padding:8px 0;font-size:14px">${date}</td></tr>
                   <tr><td style="padding:8px 0;color:#9C8F78;font-size:14px">Time</td><td style="padding:8px 0;font-size:14px">${start_time} – ${end_time}</td></tr>
                 </table>`,
          ctaText: 'View my bookings',
          ctaUrl: `${appUrl}/profile.html`
        })
      });

      if (space.owner_id && space.owner_id !== req.user.id) {
        await Notify.newBooking(space.owner_id, space.name, user.name, date, `${start_time}–${end_time}`);
      }

      return res.status(201).json({ booking, message: 'Booking confirmed' });
    }

    // PAID SPACE — create pending booking, return Paystack checkout URL
    const { lastID } = await db.runAsync(
      `INSERT INTO bookings (space_id, user_id, date, start_time, end_time, guests, note, status, total_price, amount_value, currency, offer_id, discount_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?, ?, ?)`,
      [space_id, req.user.id, date, start_time, end_time, guests || 1, note || '',
       space.price || '', amountKobo, currency,
       appliedOffer ? appliedOffer.id : null, discountKobo]
    );

    // Record offer redemption
    if (appliedOffer) {
      await db.runAsync(
        'INSERT INTO offer_redemptions (offer_id, user_id, booking_id, discount_amount) VALUES (?, ?, ?, ?)',
        [appliedOffer.id, req.user.id, lastID, discountKobo]);
      await db.runAsync(
        'UPDATE offers SET current_uses = current_uses + 1 WHERE id = ?', [appliedOffer.id]);
    }

    const booking = await db.getAsync(`
      SELECT b.*, s.name as space_name, s.address, s.category
      FROM bookings b JOIN spaces s ON s.id = b.space_id WHERE b.id = ?`, [lastID]);

    // Create payment record
    const reference = generateReference(lastID);
    await db.runAsync(
      `INSERT INTO payments (booking_id, amount, currency, provider_ref) VALUES (?, ?, ?, ?)`,
      [lastID, amountKobo, currency, reference]
    );

    // Initialize Paystack
    const user = await db.getAsync('SELECT name, email FROM users WHERE id = ?', [req.user.id]);

    // Check if space owner has a Paystack subaccount for auto-split
    let subaccount = null;
    if (space.owner_id) {
      const ownerProfile = await db.getAsync('SELECT paystack_subaccount_id FROM owner_profiles WHERE user_id = ?', [space.owner_id]);
      if (ownerProfile?.paystack_subaccount_id) subaccount = ownerProfile.paystack_subaccount_id;
    }

    const paystackData = await initializeTransaction({
      email: user.email,
      amount: amountKobo,
      currency,
      reference,
      callbackUrl: `${appUrl}/api/bookings/verify-payment?reference=${reference}`,
      subaccount,
      metadata: {
        booking_id: lastID,
        space_name: space.name,
        user_name: user.name,
        date, start_time, end_time
      }
    });

    res.status(201).json({
      booking,
      payment_url: paystackData.authorization_url,
      reference: paystackData.reference,
      message: 'Complete payment to confirm booking'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Booking failed: ' + err.message });
  }
});

// GET /api/bookings/verify-payment?reference=xxx — Paystack callback redirect
router.get('/verify-payment', async (req, res) => {
  const { reference } = req.query;
  const appUrl = process.env.APP_URL || 'http://localhost:3000';

  if (!reference) return res.redirect(`${appUrl}/payment-failed.html`);

  try {
    const txData = await verifyTransaction(reference);
    const payment = await db.getAsync('SELECT * FROM payments WHERE provider_ref = ?', [reference]);
    if (!payment) return res.redirect(`${appUrl}/payment-failed.html?error=not_found`);

    if (txData.status === 'success' && payment.status !== 'success') {
      // Update payment
      await db.runAsync(
        `UPDATE payments SET status = 'success', provider_status = ?, metadata = ?, updated_at = NOW() WHERE id = ?`,
        [txData.status, JSON.stringify(txData), payment.id]
      );
      await db.runAsync('UPDATE bookings SET status = ? WHERE id = ?', ['paid', payment.booking_id]);

      // Complete booking
      await completeBookingAfterPayment(payment.booking_id);
      return res.redirect(`${appUrl}/payment-success.html?booking_id=${payment.booking_id}`);
    }

    if (txData.status === 'success') {
      return res.redirect(`${appUrl}/payment-success.html?booking_id=${payment.booking_id}`);
    }

    // Payment failed or abandoned
    return res.redirect(`${appUrl}/payment-failed.html?reference=${reference}`);
  } catch (err) {
    console.error('Payment verification error:', err.message);
    return res.redirect(`${appUrl}/payment-failed.html?reference=${reference}`);
  }
});

// GET /api/bookings/:id/payment-status
router.get('/:id/payment-status', requireAuth, async (req, res) => {
  const booking = await db.getAsync('SELECT * FROM bookings WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const payment = await db.getAsync('SELECT status, provider_ref FROM payments WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1', [booking.id]);
  res.json({ booking_status: booking.status, payment_status: payment?.status || null, reference: payment?.provider_ref || null });
});

// PATCH /api/bookings/:id/cancel
router.patch('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const booking = await db.getAsync('SELECT * FROM bookings WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status === 'cancelled' || booking.status === 'refunded')
      return res.status(400).json({ error: 'Already cancelled' });

    // If payment was made, initiate refund
    if (booking.status === 'paid' || booking.status === 'confirmed') {
      const payment = await db.getAsync(
        "SELECT * FROM payments WHERE booking_id = ? AND status = 'success' ORDER BY created_at DESC LIMIT 1",
        [booking.id]
      );
      if (payment?.provider_ref) {
        try {
          await refundTransaction({ transactionRef: payment.provider_ref });
          await db.runAsync("UPDATE payments SET status = 'refunded', updated_at = NOW() WHERE id = ?", [payment.id]);
          await db.runAsync('UPDATE bookings SET status = ? WHERE id = ?', ['refunded', booking.id]);
        } catch (refundErr) {
          console.error('Refund failed:', refundErr.message);
          // Still cancel the booking, admin can handle manual refund
          await db.runAsync('UPDATE bookings SET status = ? WHERE id = ?', ['cancelled', booking.id]);
        }
      } else {
        await db.runAsync('UPDATE bookings SET status = ? WHERE id = ?', ['cancelled', booking.id]);
      }
    } else {
      // pending_payment — just cancel, no refund needed
      await db.runAsync('UPDATE bookings SET status = ? WHERE id = ?', ['cancelled', booking.id]);
    }

    // Cancel on external platform if applicable
    if (booking.external_ref) {
      const connector = await getConnector(booking.space_id);
      await connector.cancelBooking(booking.id, req.user.id).catch(() => {});
    }

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

// GET /api/bookings/my-earnings — owner sees their total earnings
router.get('/my-earnings', requireAuth, async (req, res) => {
  try {
    const earnings = await db.getAsync(`
      SELECT COALESCE(SUM(p.amount), 0) as total
      FROM payments p
      JOIN bookings b ON b.id = p.booking_id
      JOIN spaces s ON s.id = b.space_id
      WHERE s.owner_id = ? AND p.status = 'success'`, [req.user.id]);
    const pending = await db.getAsync(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM payouts WHERE owner_id = ? AND status = 'pending'`, [req.user.id]);
    const paid = await db.getAsync(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM payouts WHERE owner_id = ? AND status = 'paid'`, [req.user.id]);
    res.json({
      totalEarnings: earnings.total,
      pendingPayout: pending.total,
      paidOut: paid.total
    });
  } catch (err) { res.status(500).json({ error: 'Failed to load earnings' }); }
});

module.exports = router;
