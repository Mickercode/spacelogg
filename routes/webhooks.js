const express = require('express');
const db = require('../db/database');
const { verifyWebhookSignature } = require('../utils/payment');
const { getConnector } = require('../connectors');
const { sendEmail, emailTemplate } = require('../utils/mailer');
const { notify, Notify } = require('../utils/notify');
const router = express.Router();

/**
 * Complete a booking after successful payment:
 * - Create on external platform if integrated
 * - Update status to confirmed
 * - Send confirmation email + notifications
 */
async function completeBookingAfterPayment(bookingId) {
  const booking = await db.getAsync(`
    SELECT b.*, s.name as space_name, s.address, s.category, s.owner_id, s.price
    FROM bookings b JOIN spaces s ON s.id = b.space_id WHERE b.id = ?`, [bookingId]);
  if (!booking) return;

  const connector = await getConnector(booking.space_id);

  // If integrated with external platform, create booking there
  if (connector.platform !== 'native') {
    try {
      const result = await connector.createBooking({
        spaceId: booking.space_id, userId: booking.user_id,
        date: booking.date, startTime: booking.start_time, endTime: booking.end_time,
        guests: booking.guests, note: booking.note
      });
      if (result.externalRef) {
        await db.runAsync('UPDATE bookings SET external_ref = ? WHERE id = ?', [result.externalRef, bookingId]);
      }
    } catch (err) {
      console.error(`External booking creation failed for booking ${bookingId}:`, err.message);
      // Payment was taken — mark confirmed anyway, admin can handle sync issues
    }
  }

  // Update to confirmed
  await db.runAsync('UPDATE bookings SET status = ? WHERE id = ?', ['confirmed', bookingId]);

  // Get user for notifications
  const user = await db.getAsync('SELECT name, email FROM users WHERE id = ?', [booking.user_id]);
  if (!user) return;

  // In-app notification
  await notify({ userId: booking.user_id, type: 'booking_confirmed', title: 'Booking confirmed! 🎉',
    message: `Your booking at ${booking.space_name} on ${booking.date} (${booking.start_time}–${booking.end_time}) is confirmed.` });

  // Email confirmation
  const appUrl = process.env.APP_URL || 'http://localhost:3000';
  await sendEmail({
    to: user.email,
    subject: `Booking confirmed — ${booking.space_name}`,
    html: emailTemplate({
      title: 'Your booking is confirmed!',
      body: `<p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#6B6456;line-height:1.7;margin:0 0 16px;">Hi ${user.name},</p>
             <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#6B6456;line-height:1.7;margin:0 0 16px;">Your payment has been received and your workspace booking is confirmed:</p>
             <table style="width:100%;border-collapse:collapse;margin:16px 0">
               <tr><td style="padding:8px 0;color:#9C8F78;font-size:14px">Space</td><td style="padding:8px 0;font-size:14px;font-weight:600">${booking.space_name}</td></tr>
               <tr><td style="padding:8px 0;color:#9C8F78;font-size:14px">Address</td><td style="padding:8px 0;font-size:14px">${booking.address}</td></tr>
               <tr><td style="padding:8px 0;color:#9C8F78;font-size:14px">Date</td><td style="padding:8px 0;font-size:14px">${booking.date}</td></tr>
               <tr><td style="padding:8px 0;color:#9C8F78;font-size:14px">Time</td><td style="padding:8px 0;font-size:14px">${booking.start_time} – ${booking.end_time}</td></tr>
               <tr><td style="padding:8px 0;color:#9C8F78;font-size:14px">Amount</td><td style="padding:8px 0;font-size:14px;font-weight:600">${booking.total_price || 'Paid'}</td></tr>
             </table>`,
      ctaText: 'View my bookings',
      ctaUrl: `${appUrl}/profile.html`
    })
  });

  // Notify space owner via email + in-app
  if (booking.owner_id && booking.owner_id !== booking.user_id) {
    await Notify.newBooking(booking.owner_id, booking.space_name, user.name, booking.date, `${booking.start_time}–${booking.end_time}`);
  }

  // Fire outgoing webhook to partner systems
  fireOutgoingWebhook(booking.space_id, 'booking.confirmed', {
    booking_id: bookingId,
    space_name: booking.space_name,
    user_name: user.name,
    date: booking.date,
    start_time: booking.start_time,
    end_time: booking.end_time,
    guests: booking.guests,
    amount: booking.total_price
  }).catch(() => {}); // don't block on webhook failures
}

// POST /api/webhooks/paystack
router.post('/paystack', async (req, res) => {
  try {
    const rawBody = req.body; // raw Buffer from express.raw()
    const signature = req.headers['x-paystack-signature'];

    if (!verifyWebhookSignature(rawBody, signature)) {
      console.error('Paystack webhook: invalid signature');
      return res.status(400).send('Invalid signature');
    }

    const event = JSON.parse(rawBody.toString('utf8'));
    console.log(`📩 Paystack webhook: ${event.event}`);

    switch (event.event) {
      case 'charge.success': {
        const ref = event.data?.reference;
        if (!ref) break;

        const payment = await db.getAsync('SELECT * FROM payments WHERE provider_ref = ?', [ref]);
        if (!payment) { console.error('Payment not found for ref:', ref); break; }
        if (payment.status === 'success') break; // already processed

        // Update payment
        await db.runAsync(
          `UPDATE payments SET status = 'success', provider_status = ?, metadata = ?, updated_at = datetime('now') WHERE id = ?`,
          [event.data.status, JSON.stringify(event.data), payment.id]
        );

        // Update booking to paid
        await db.runAsync('UPDATE bookings SET status = ? WHERE id = ?', ['paid', payment.booking_id]);

        // Complete the booking (external creation, confirmation, etc.)
        await completeBookingAfterPayment(payment.booking_id);
        break;
      }

      case 'charge.failed': {
        const ref = event.data?.reference;
        if (!ref) break;
        const payment = await db.getAsync('SELECT * FROM payments WHERE provider_ref = ?', [ref]);
        if (!payment) break;
        await db.runAsync(
          `UPDATE payments SET status = 'failed', provider_status = ?, updated_at = datetime('now') WHERE id = ?`,
          [event.data.status || 'failed', payment.id]
        );
        await db.runAsync('UPDATE bookings SET status = ? WHERE id = ?', ['cancelled', payment.booking_id]);
        break;
      }

      case 'refund.processed': {
        const ref = event.data?.transaction?.reference;
        if (!ref) break;
        const payment = await db.getAsync('SELECT * FROM payments WHERE provider_ref = ?', [ref]);
        if (!payment) break;
        await db.runAsync(
          `UPDATE payments SET status = 'refunded', updated_at = datetime('now') WHERE id = ?`,
          [payment.id]
        );
        await db.runAsync('UPDATE bookings SET status = ? WHERE id = ?', ['refunded', payment.booking_id]);
        break;
      }
    }

    // Always respond 200 to Paystack
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.sendStatus(200); // Still 200 to prevent Paystack retries
  }
});

// ═══════════════════════════════════════════════════
//  INCOMING: External booking platforms
// ═══════════════════════════════════════════════════

// POST /api/webhooks/skedda — Skedda booking status updates
router.post('/skedda', express.json(), async (req, res) => {
  try {
    const secret = req.headers['x-webhook-secret'];
    if (secret !== process.env.SKEDDA_WEBHOOK_SECRET) {
      console.error('Skedda webhook: invalid secret');
      return res.status(403).send('Forbidden');
    }

    const { event, data } = req.body;
    console.log(`📩 Skedda webhook: ${event}`);

    if (!data?.id) return res.sendStatus(200);

    // Find booking by external_ref
    const booking = await db.getAsync('SELECT * FROM bookings WHERE external_ref = ?', [String(data.id)]);
    if (!booking) { console.log('Skedda webhook: no matching booking for ref', data.id); return res.sendStatus(200); }

    if (event === 'booking.cancelled' || event === 'booking.deleted') {
      await db.runAsync('UPDATE bookings SET status = ? WHERE id = ?', ['cancelled', booking.id]);
      await notify({ userId: booking.user_id, type: 'booking_cancelled', title: 'Booking cancelled',
        message: `Your booking on ${booking.date} was cancelled by the venue.` });
    }

    if (event === 'booking.updated') {
      // Log the update for admin review
      const { logSync } = require('../connectors');
      await logSync({ bookingId: booking.id, spaceId: booking.space_id, platform: 'skedda',
        action: 'webhook_update', status: 'success', response: JSON.stringify(data) });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Skedda webhook error:', err.message);
    res.sendStatus(200);
  }
});

// POST /api/webhooks/officernd — OfficeRnD booking status updates
router.post('/officernd', express.json(), async (req, res) => {
  try {
    const secret = req.headers['x-webhook-secret'];
    if (secret !== process.env.OFFICERND_WEBHOOK_SECRET) {
      return res.status(403).send('Forbidden');
    }

    const { event, data } = req.body;
    console.log(`📩 OfficeRnD webhook: ${event}`);

    const extRef = data?._id || data?.id;
    if (!extRef) return res.sendStatus(200);

    const booking = await db.getAsync('SELECT * FROM bookings WHERE external_ref = ?', [String(extRef)]);
    if (!booking) return res.sendStatus(200);

    if (event === 'booking.cancelled' || event === 'booking.deleted') {
      await db.runAsync('UPDATE bookings SET status = ? WHERE id = ?', ['cancelled', booking.id]);
      await notify({ userId: booking.user_id, type: 'booking_cancelled', title: 'Booking cancelled',
        message: `Your booking on ${booking.date} was cancelled by the venue.` });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('OfficeRnD webhook error:', err.message);
    res.sendStatus(200);
  }
});

// POST /api/webhooks/cobot — Cobot booking status updates
router.post('/cobot', express.json(), async (req, res) => {
  try {
    const secret = req.headers['x-webhook-secret'];
    if (secret !== process.env.COBOT_WEBHOOK_SECRET) {
      return res.status(403).send('Forbidden');
    }

    const { event, data } = req.body;
    console.log(`📩 Cobot webhook: ${event}`);

    if (!data?.id) return res.sendStatus(200);

    const booking = await db.getAsync('SELECT * FROM bookings WHERE external_ref = ?', [String(data.id)]);
    if (!booking) return res.sendStatus(200);

    if (event === 'booking_cancelled') {
      await db.runAsync('UPDATE bookings SET status = ? WHERE id = ?', ['cancelled', booking.id]);
      await notify({ userId: booking.user_id, type: 'booking_cancelled', title: 'Booking cancelled',
        message: `Your booking on ${booking.date} was cancelled by the venue.` });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Cobot webhook error:', err.message);
    res.sendStatus(200);
  }
});

// ═══════════════════════════════════════════════════
//  OUTGOING: Send webhooks to space owners/partners
// ═══════════════════════════════════════════════════

const axios = require('axios');

/**
 * Fire an outgoing webhook to a registered URL
 * Spaces can register webhook URLs in space_integrations.config.webhook_url
 */
async function fireOutgoingWebhook(spaceId, event, payload) {
  try {
    const integration = await db.getAsync(
      'SELECT config FROM space_integrations WHERE space_id = ? AND enabled = 1', [spaceId]);
    if (!integration) return;

    const config = JSON.parse(integration.config || '{}');
    if (!config.webhook_url) return;

    await axios.post(config.webhook_url, {
      event,
      timestamp: new Date().toISOString(),
      data: payload
    }, {
      headers: { 'Content-Type': 'application/json', 'X-Source': 'SpaceLogg' },
      timeout: 10000
    });
    console.log(`📤 Outgoing webhook sent: ${event} → ${config.webhook_url}`);
  } catch (err) {
    console.error(`Outgoing webhook failed for space ${spaceId}:`, err.message);
  }
}

module.exports = router;
module.exports.completeBookingAfterPayment = completeBookingAfterPayment;
module.exports.fireOutgoingWebhook = fireOutgoingWebhook;
