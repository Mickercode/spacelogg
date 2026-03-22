const express = require('express');
const db      = require('../db/database');
const { requireAuth, optionalAuth, requireAdmin } = require('../middleware/auth');
const { Notify } = require('../utils/notify');
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
    const { category, city, q, limit=50, offset=0 } = req.query;
    let sql='SELECT * FROM spaces WHERE status=?'; const args=['approved'];
    if (category) { sql+=' AND category=?'; args.push(category); }
    if (city)     { sql+=' AND city LIKE ?'; args.push(`%${city}%`); }
    if (q)        { sql+=' AND (name LIKE ? OR description LIKE ? OR address LIKE ?)'; const l=`%${q}%`; args.push(l,l,l); }
    sql+=' ORDER BY rating DESC LIMIT ? OFFSET ?'; args.push(Number(limit),Number(offset));
    const spaces   = await db.allAsync(sql, args);
    const countRow = await db.getAsync('SELECT COUNT(*) as c FROM spaces WHERE status=?',['approved']);
    res.json({ spaces: spaces.map(parse), total: countRow.c });
  } catch(err){ console.error(err); res.status(500).json({error:'Failed to load spaces'}); }
});

// GET /api/spaces/:id
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const space = await db.getAsync('SELECT * FROM spaces WHERE id=? AND status=?',[req.params.id,'approved']);
    if (!space) return res.status(404).json({error:'Space not found'});
    let saved = false;
    if (req.user) { const s=await db.getAsync('SELECT id FROM saved_spaces WHERE user_id=? AND space_id=?',[req.user.id,space.id]); saved=!!s; }
    const reviews = await db.allAsync(
      `SELECT r.*, u.name as user_name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.space_id=? ORDER BY r.created_at DESC LIMIT 20`,
      [space.id]);
    res.json({ space: parse(space), saved, reviews });
  } catch(err){ console.error(err); res.status(500).json({error:'Failed to load space'}); }
});

// POST /api/spaces — ADMIN ONLY
router.post('/', requireAuth, requireAdmin, upload.array('images',6), async (req, res) => {
  try {
    const { name, category, description, address, city, lat, lng, price, price_unit, amenities, hours } = req.body;
    if (!name||!category||!address) return res.status(400).json({error:'Name, category and address are required'});
    const images = req.files?.length ? await uploadFiles(req.files) : [];
    const { lastID } = await db.runAsync(
      `INSERT INTO spaces (name,category,description,address,city,lat,lng,price,price_unit,amenities,hours,images,owner_id,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'approved')`,
      [name, category, description||'', address, city||'Ibadan',
       lat?Number(lat):null, lng?Number(lng):null,
       price||'', price_unit||'',
       amenities||'[]', hours||'{}',
       JSON.stringify(images), req.user.id]);
    const space = await db.getAsync('SELECT * FROM spaces WHERE id=?',[lastID]);
    res.status(201).json({ space: parse(space), message: 'Space added successfully' });
  } catch(err){ console.error(err); res.status(500).json({error:'Failed to add space: '+err.message}); }
});

// PATCH /api/spaces/:id — admin edit
router.patch('/:id', requireAuth, requireAdmin, upload.array('images',6), async (req, res) => {
  try {
    const space = await db.getAsync('SELECT * FROM spaces WHERE id=?',[req.params.id]);
    if (!space) return res.status(404).json({error:'Space not found'});
    const fields=['name','category','description','address','city','lat','lng','price','price_unit','amenities','hours'];
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
