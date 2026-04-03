const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// ═══════════════════════════════════════
//  OWNER CRUD
// ═══════════════════════════════════════

// GET /api/offers/my — owner's offers
router.get('/my', requireAuth, async (req, res) => {
  const offers = await db.allAsync(
    `SELECT o.*, s.name as space_name FROM offers o
     JOIN spaces s ON s.id = o.space_id
     WHERE o.owner_id = ? ORDER BY o.created_at DESC`, [req.user.id]);
  res.json({ offers });
});

// POST /api/offers — create offer
router.post('/', requireAuth, async (req, res) => {
  try {
    const { space_id, type, title, description, discount_percent, code, deadline,
            bundle_buy, bundle_free, hh_start_time, hh_end_time, hh_days,
            max_uses, valid_from, valid_until } = req.body;

    if (!space_id || !type || !title) return res.status(400).json({ error: 'space_id, type, and title are required' });

    const validTypes = ['discount_code', 'time_based', 'bundle', 'first_time', 'happy_hour'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid offer type' });

    // Verify ownership
    const space = await db.getAsync('SELECT id FROM spaces WHERE id = ? AND owner_id = ?', [space_id, req.user.id]);
    if (!space) return res.status(403).json({ error: 'Space not found or not yours' });

    // Validate code uniqueness for discount_code type
    if (type === 'discount_code') {
      if (!code) return res.status(400).json({ error: 'Promo code is required for discount code offers' });
      const existing = await db.getAsync(
        'SELECT id FROM offers WHERE space_id = ? AND code = ? AND active = 1', [space_id, code.toUpperCase()]);
      if (existing) return res.status(409).json({ error: 'This promo code already exists for this space' });
    }

    const { lastID } = await db.runAsync(
      `INSERT INTO offers (space_id, owner_id, type, title, description, discount_percent, code,
       deadline, bundle_buy, bundle_free, hh_start_time, hh_end_time, hh_days,
       max_uses, valid_from, valid_until)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [space_id, req.user.id, type, title, description || '',
       discount_percent || 0, type === 'discount_code' ? (code || '').toUpperCase() : null,
       deadline || null, bundle_buy || 0, bundle_free || 0,
       hh_start_time || null, hh_end_time || null, hh_days || '[]',
       max_uses || 0, valid_from || new Date().toISOString(), valid_until || null]);

    const offer = await db.getAsync('SELECT * FROM offers WHERE id = ?', [lastID]);
    res.status(201).json({ offer, message: 'Offer created' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create offer' }); }
});

// PATCH /api/offers/:id — update offer
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const offer = await db.getAsync('SELECT * FROM offers WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
    if (!offer) return res.status(404).json({ error: 'Offer not found' });

    const fields = ['title', 'description', 'discount_percent', 'code', 'deadline',
                    'bundle_buy', 'bundle_free', 'hh_start_time', 'hh_end_time', 'hh_days',
                    'max_uses', 'valid_from', 'valid_until'];
    const updates = []; const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        params.push(f === 'code' ? (req.body[f] || '').toUpperCase() : req.body[f]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    updates.push("updated_at = NOW()");
    params.push(req.params.id);
    await db.runAsync(`UPDATE offers SET ${updates.join(', ')} WHERE id = ?`, params);
    const updated = await db.getAsync('SELECT * FROM offers WHERE id = ?', [req.params.id]);
    res.json({ offer: updated });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Update failed' }); }
});

// PATCH /api/offers/:id/toggle — toggle active
router.patch('/:id/toggle', requireAuth, async (req, res) => {
  const offer = await db.getAsync('SELECT id, active FROM offers WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
  if (!offer) return res.status(404).json({ error: 'Offer not found' });
  await db.runAsync('UPDATE offers SET active = ?, updated_at = NOW() WHERE id = ?', [offer.active ? 0 : 1, req.params.id]);
  res.json({ message: offer.active ? 'Offer paused' : 'Offer activated' });
});

// DELETE /api/offers/:id
router.delete('/:id', requireAuth, async (req, res) => {
  const offer = await db.getAsync('SELECT id FROM offers WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
  if (!offer) return res.status(404).json({ error: 'Offer not found' });
  await db.runAsync('DELETE FROM offers WHERE id = ?', [req.params.id]);
  res.json({ message: 'Offer deleted' });
});

// ═══════════════════════════════════════
//  PUBLIC ENDPOINTS
// ═══════════════════════════════════════

// GET /api/offers/space/:spaceId — active offers for a space (public)
router.get('/space/:spaceId', async (req, res) => {
  const offers = await db.allAsync(
    `SELECT id, type, title, description, discount_percent, deadline,
            bundle_buy, bundle_free, hh_start_time, hh_end_time, hh_days, valid_until
     FROM offers
     WHERE space_id = ? AND active = 1
       AND (valid_from IS NULL OR valid_from <= NOW())
       AND (valid_until IS NULL OR valid_until >= NOW())
       AND (max_uses = 0 OR current_uses < max_uses)`,
    [req.params.spaceId]);
  res.json({ offers });
});

// POST /api/offers/validate — validate an offer for a booking
router.post('/validate', requireAuth, async (req, res) => {
  try {
    const { space_id, offer_id, code, date, start_time, end_time, base_amount } = req.body;
    if (!space_id || !base_amount) return res.status(400).json({ error: 'space_id and base_amount required' });

    let offer = null;

    // Find the offer
    if (code) {
      offer = await db.getAsync(
        `SELECT * FROM offers WHERE space_id = ? AND code = ? AND type = 'discount_code'
         AND active = 1 AND (valid_from IS NULL OR valid_from <= NOW())
         AND (valid_until IS NULL OR valid_until >= NOW())
         AND (max_uses = 0 OR current_uses < max_uses)`,
        [space_id, code.toUpperCase()]);
      if (!offer) return res.json({ valid: false, reason: 'Invalid or expired promo code' });
    } else if (offer_id) {
      offer = await db.getAsync(
        `SELECT * FROM offers WHERE id = ? AND space_id = ? AND active = 1
         AND (valid_from IS NULL OR valid_from <= NOW())
         AND (valid_until IS NULL OR valid_until >= NOW())
         AND (max_uses = 0 OR current_uses < max_uses)`,
        [offer_id, space_id]);
      if (!offer) return res.json({ valid: false, reason: 'Offer no longer available' });
    } else {
      // Auto-detect best offer
      const autoOffers = await db.allAsync(
        `SELECT * FROM offers WHERE space_id = ? AND active = 1
         AND type IN ('time_based', 'first_time', 'happy_hour', 'bundle')
         AND (valid_from IS NULL OR valid_from <= NOW())
         AND (valid_until IS NULL OR valid_until >= NOW())
         AND (max_uses = 0 OR current_uses < max_uses)`,
        [space_id]);

      let bestDiscount = 0;
      for (const o of autoOffers) {
        const disc = await calcDiscount(o, req.user.id, space_id, date, start_time, end_time, base_amount);
        if (disc > bestDiscount) { bestDiscount = disc; offer = o; }
      }
      if (!offer) return res.json({ valid: false, reason: 'No offers available' });
    }

    // Calculate discount
    const discount = await calcDiscount(offer, req.user.id, space_id, date, start_time, end_time, base_amount);
    if (discount <= 0) return res.json({ valid: false, reason: 'Offer does not apply to this booking' });

    const finalAmount = Math.max(0, base_amount - discount);
    res.json({
      valid: true,
      offer_id: offer.id,
      offer_title: offer.title,
      offer_type: offer.type,
      discount_percent: offer.discount_percent,
      discount_amount: discount,
      final_amount: finalAmount
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Validation failed' }); }
});

// ═══════════════════════════════════════
//  DISCOUNT CALCULATION
// ═══════════════════════════════════════

async function calcDiscount(offer, userId, spaceId, date, startTime, endTime, baseAmount) {
  switch (offer.type) {
    case 'discount_code':
    case 'first_time': {
      // First-time: check if user has booked this space before
      if (offer.type === 'first_time') {
        const prev = await db.getAsync(
          "SELECT id FROM bookings WHERE user_id = ? AND space_id = ? AND status IN ('confirmed','paid') LIMIT 1",
          [userId, spaceId]);
        if (prev) return 0; // Not first time
      }
      return Math.round(baseAmount * (offer.discount_percent / 100));
    }

    case 'time_based': {
      if (offer.deadline && new Date(offer.deadline) < new Date()) return 0;
      return Math.round(baseAmount * (offer.discount_percent / 100));
    }

    case 'happy_hour': {
      if (!startTime || !date) return 0;
      // Check day of week
      const dayOfWeek = new Date(date + 'T12:00:00').getDay(); // 0=Sun
      const allowedDays = JSON.parse(offer.hh_days || '[]');
      if (allowedDays.length && !allowedDays.includes(dayOfWeek)) return 0;
      // Check time window
      if (offer.hh_start_time && startTime < offer.hh_start_time) return 0;
      if (offer.hh_end_time && endTime > offer.hh_end_time) return 0;
      return Math.round(baseAmount * (offer.discount_percent / 100));
    }

    case 'bundle': {
      if (!offer.bundle_buy || !offer.bundle_free) return 0;
      // Count previous confirmed bookings at this space
      const count = await db.getAsync(
        "SELECT COUNT(*) as c FROM bookings WHERE user_id = ? AND space_id = ? AND status IN ('confirmed','paid')",
        [userId, spaceId]);
      const totalCycle = offer.bundle_buy + offer.bundle_free;
      const position = (count.c % totalCycle) + 1; // 1-indexed position in cycle
      // If position > bundle_buy, this booking is free
      if (position > offer.bundle_buy) return baseAmount;
      return 0;
    }

    default:
      return 0;
  }
}

module.exports = router;
