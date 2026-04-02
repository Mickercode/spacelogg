const express = require('express');
const db      = require('../db/database');
const { requireAuth, optionalAuth, requireAdmin } = require('../middleware/auth');
const { Notify } = require('../utils/notify');
const { sendEmail, emailTemplate } = require('../utils/mailer');
const { upload, uploadFiles } = require('../utils/cloudinary');
const router  = express.Router();

function parse(row) {
  if (!row) return null;
  return { ...row,
    amenities: JSON.parse(row.amenities||'[]'),
    hours:     JSON.parse(row.hours||'{}'),
    images:    JSON.parse(row.images||'[]')
  };
}

// GET /api/spaces
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { category, city, area, q, limit=50, offset=0 } = req.query;
    let sql='SELECT * FROM spaces WHERE status=?'; const args=['approved'];
    if (category) { sql+=' AND category=?'; args.push(category); }
    if (city)     { sql+=' AND city LIKE ?'; args.push(`%${city}%`); }
    if (area)     { sql+=' AND area LIKE ?'; args.push(`%${area}%`); }
    if (q)        { sql+=' AND (name LIKE ? OR description LIKE ? OR address LIKE ? OR area LIKE ?)'; const l=`%${q}%`; args.push(l,l,l,l); }
    sql+=' ORDER BY rating DESC LIMIT ? OFFSET ?'; args.push(Number(limit),Number(offset));
    const spaces   = await db.allAsync(sql, args);
    const countRow = await db.getAsync('SELECT COUNT(*) as c FROM spaces WHERE status=?',['approved']);
    res.json({ spaces: spaces.map(parse), total: countRow.c });
  } catch(err){ console.error(err); res.status(500).json({error:'Failed to load spaces'}); }
});

// GET /api/spaces/nearby?lat=X&lng=Y&radius=10 — spaces near a location (radius in km)
router.get('/nearby', async (req, res) => {
  try {
    const { lat, lng, radius = 10, limit = 50 } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
    const userLat = Number(lat), userLng = Number(lng), r = Number(radius);
    // Haversine approximation in SQL (good enough for filtering)
    const spaces = await db.allAsync(`
      SELECT *, (
        6371 * 2 * atan2(
          sqrt(sin((radians(lat) - radians(?)) / 2) * sin((radians(lat) - radians(?)) / 2) +
          cos(radians(?)) * cos(radians(lat)) *
          sin((radians(lng) - radians(?)) / 2) * sin((radians(lng) - radians(?)) / 2)),
          sqrt(1 - sin((radians(lat) - radians(?)) / 2) * sin((radians(lat) - radians(?)) / 2) -
          cos(radians(?)) * cos(radians(lat)) *
          sin((radians(lng) - radians(?)) / 2) * sin((radians(lng) - radians(?)) / 2))
        )
      ) as distance
      FROM spaces WHERE status = 'approved' AND lat IS NOT NULL AND lng IS NOT NULL
      HAVING distance <= ?
      ORDER BY distance ASC LIMIT ?`,
      [userLat, userLat, userLat, userLng, userLng, userLat, userLat, userLat, userLng, userLng, r, Number(limit)]);
    res.json({ spaces: spaces.map(parse), total: spaces.length });
  } catch (err) {
    // SQLite doesn't have radians/atan2 — fall back to simple bounding box
    try {
      const userLat = Number(req.query.lat), userLng = Number(req.query.lng), r = Number(req.query.radius || 10);
      const degPerKm = 1 / 111.32;
      const latMin = userLat - r * degPerKm, latMax = userLat + r * degPerKm;
      const lngMin = userLng - r * degPerKm, lngMax = userLng + r * degPerKm;
      const spaces = await db.allAsync(
        `SELECT * FROM spaces WHERE status = 'approved' AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? ORDER BY rating DESC LIMIT ?`,
        [latMin, latMax, lngMin, lngMax, Number(req.query.limit || 50)]);
      res.json({ spaces: spaces.map(parse), total: spaces.length });
    } catch (err2) { console.error(err2); res.status(500).json({ error: 'Nearby search failed' }); }
  }
});

// GET /api/spaces/discover — discovery feed sections
router.get('/discover', async (req, res) => {
  try {
    const topRated = await db.allAsync(
      "SELECT * FROM spaces WHERE status='approved' AND rating >= 4.5 ORDER BY rating DESC, review_count DESC LIMIT 6");
    const newest = await db.allAsync(
      "SELECT * FROM spaces WHERE status='approved' ORDER BY created_at DESC LIMIT 6");
    const mostReviewed = await db.allAsync(
      "SELECT * FROM spaces WHERE status='approved' AND review_count > 0 ORDER BY review_count DESC LIMIT 6");
    res.json({
      topRated: topRated.map(parse),
      newest: newest.map(parse),
      mostReviewed: mostReviewed.map(parse)
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Discovery failed' }); }
});

// GET /api/spaces/areas — distinct areas for filter dropdown
router.get('/areas', async (req, res) => {
  const { city } = req.query;
  let sql = "SELECT DISTINCT area FROM spaces WHERE status='approved' AND area != ''";
  const args = [];
  if (city) { sql += ' AND city LIKE ?'; args.push(`%${city}%`); }
  sql += ' ORDER BY area ASC';
  const rows = await db.allAsync(sql, args);
  res.json({ areas: rows.map(r => r.area) });
});

// GET /api/spaces/:id
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const space = await db.getAsync('SELECT * FROM spaces WHERE id=? AND status=?',[req.params.id,'approved']);
    if (!space) return res.status(404).json({error:'Space not found'});
    let saved = false;
    if (req.user) {
      const s=await db.getAsync('SELECT id FROM saved_spaces WHERE user_id=? AND space_id=?',[req.user.id,space.id]); saved=!!s;
      // Track recently viewed
      db.runAsync('INSERT INTO recently_viewed (user_id, space_id) VALUES (?, ?) ON CONFLICT(user_id, space_id) DO UPDATE SET viewed_at = NOW()', [req.user.id, space.id]).catch(()=>{});
    }
    const reviews = await db.allAsync(
      `SELECT r.*, u.name as user_name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.space_id=? ORDER BY r.created_at DESC LIMIT 20`,
      [space.id]);
    res.json({ space: parse(space), saved, reviews });
  } catch(err){ console.error(err); res.status(500).json({error:'Failed to load space'}); }
});

// POST /api/spaces — ADMIN or OWNER
router.post('/', requireAuth, (req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'owner') return res.status(403).json({ error: 'Only space owners can create listings' });
  next();
}, upload.array('images',6), async (req, res) => {
  try {
    const { name, category, description, address, city, area, lat, lng, price, walkin_price, price_unit, amenities, hours } = req.body;
    if (!name||!category||!address) return res.status(400).json({error:'Name, category and address are required'});
    const images = req.files?.length ? await uploadFiles(req.files) : [];
    const initialStatus = req.user.role === 'admin' ? 'approved' : 'pending';
    const { lastID } = await db.runAsync(
      `INSERT INTO spaces (name,category,description,address,city,area,lat,lng,price,walkin_price,price_unit,amenities,hours,images,owner_id,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [name, category, description||'', address, city||'', area||'',
       lat?Number(lat):null, lng?Number(lng):null,
       price||'', walkin_price||'', price_unit||'',
       amenities||'[]', hours||'{}',
       JSON.stringify(images), req.user.id, initialStatus]);
    const space = await db.getAsync('SELECT * FROM spaces WHERE id=?',[lastID]);

    // Notify owner that their space was submitted
    if (initialStatus === 'pending') {
      Notify.spaceSubmitted(req.user.id, name).catch(() => {});

      // Notify all admins about new pending space
      const admins = await db.allAsync("SELECT email, name FROM users WHERE role='admin'");
      const appUrl = process.env.APP_URL || 'http://localhost:3000';
      for (const admin of admins) {
        sendEmail({
          to: admin.email,
          subject: `New space pending approval: ${name}`,
          html: emailTemplate({
            title: 'New space submitted',
            body: `<p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#6B6456;line-height:1.7;margin:0 0 16px;">Hi ${admin.name},</p>
                   <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#6B6456;line-height:1.7;margin:0 0 16px;">A new space <strong>"${name}"</strong> (${category}, ${city || 'unknown city'}) has been submitted by ${req.user.name || req.user.email} and needs your approval.</p>`,
            ctaText: 'Review in Admin Dashboard',
            ctaUrl: `${appUrl}/admin/`
          })
        }).catch(() => {});
      }
    }

    res.status(201).json({ space: parse(space), message: 'Space added successfully' });
  } catch(err){ console.error(err); res.status(500).json({error:'Failed to add space: '+err.message}); }
});

// PATCH /api/spaces/:id — admin edit
router.patch('/:id', requireAuth, requireAdmin, upload.array('images',6), async (req, res) => {
  try {
    const space = await db.getAsync('SELECT * FROM spaces WHERE id=?',[req.params.id]);
    if (!space) return res.status(404).json({error:'Space not found'});
    const fields=['name','category','description','address','city','area','lat','lng','price','walkin_price','price_unit','amenities','hours'];
    const updates=[]; const params=[];
    for (const f of fields) { if (req.body[f]!==undefined){ updates.push(`${f}=?`); params.push(req.body[f]); } }
    const keptRaw  = req.body.kept_images;
    const kept     = keptRaw ? JSON.parse(keptRaw) : JSON.parse(space.images||'[]');
    const newUploads = req.files?.length ? await uploadFiles(req.files) : [];
    updates.push('images=?'); params.push(JSON.stringify([...kept,...newUploads]));
    if (!updates.length) return res.status(400).json({error:'Nothing to update'});
    params.push(req.params.id);
    await db.runAsync(`UPDATE spaces SET ${updates.join(',')} WHERE id=?`, params);
    res.json({ space: parse(await db.getAsync('SELECT * FROM spaces WHERE id=?',[req.params.id])) });
  } catch(err){ console.error(err); res.status(500).json({error:'Update failed: '+err.message}); }
});

// DELETE /api/spaces/:id — admin only
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const space = await db.getAsync('SELECT * FROM spaces WHERE id=?',[req.params.id]);
  if (!space) return res.status(404).json({error:'Space not found'});
  await db.runAsync('DELETE FROM spaces WHERE id=?',[req.params.id]);
  res.json({message:'Space deleted'});
});

// POST /api/spaces/:id/reviews
router.post('/:id/reviews', requireAuth, async (req, res) => {
  try {
    const { rating, comment } = req.body;
    if (!rating||rating<1||rating>5) return res.status(400).json({error:'Rating must be 1–5'});
    const space = await db.getAsync('SELECT * FROM spaces WHERE id=? AND status=?',[req.params.id,'approved']);
    if (!space) return res.status(404).json({error:'Space not found'});
    const hasBooked = await db.getAsync(
      "SELECT id FROM bookings WHERE space_id = ? AND user_id = ? AND status IN ('confirmed','paid')",
      [req.params.id, req.user.id]);
    if (!hasBooked) return res.status(403).json({error:'You can only review spaces you have booked'});
    await db.runAsync(
      `INSERT INTO reviews (space_id,user_id,rating,comment) VALUES (?,?,?,?)
       ON CONFLICT(space_id,user_id) DO UPDATE SET rating=excluded.rating,comment=excluded.comment`,
      [req.params.id,req.user.id,Number(rating),comment||'']);
    const avg = await db.getAsync('SELECT AVG(rating) as avg,COUNT(*) as cnt FROM reviews WHERE space_id=?',[req.params.id]);
    await db.runAsync('UPDATE spaces SET rating=?,review_count=? WHERE id=?',
      [Math.round(avg.avg*10)/10, avg.cnt, req.params.id]);
    if (space.owner_id&&space.owner_id!==req.user.id)
      Notify.newReview(space.owner_id,space.name,Number(rating)).catch(()=>{});
    res.status(201).json({message:'Review submitted'});
  } catch(err){ console.error(err); res.status(500).json({error:'Review failed'}); }
});

module.exports = router;
