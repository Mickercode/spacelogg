const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

function parse(row) {
  if (!row) return null;
  return { ...row, amenities: JSON.parse(row.amenities||'[]'), hours: JSON.parse(row.hours||'{}'), images: JSON.parse(row.images||'[]') };
}

router.get('/saved', requireAuth, async (req, res) => {
  const rows = await db.allAsync(
    `SELECT s.*, ss.saved_at FROM spaces s JOIN saved_spaces ss ON ss.space_id = s.id
     WHERE ss.user_id = ? AND s.status = 'approved' ORDER BY ss.saved_at DESC`, [req.user.id]);
  res.json({ saved: rows.map(parse) });
});

router.post('/saved/:spaceId', requireAuth, async (req, res) => {
  try {
    const space = await db.getAsync('SELECT id FROM spaces WHERE id = ? AND status = ?', [req.params.spaceId, 'approved']);
    if (!space) return res.status(404).json({ error: 'Space not found' });
    await db.runAsync('INSERT OR IGNORE INTO saved_spaces (user_id, space_id) VALUES (?, ?)', [req.user.id, req.params.spaceId]);
    res.status(201).json({ message: 'Space saved' });
  } catch (err) { res.status(500).json({ error: 'Could not save space' }); }
});

router.delete('/saved/:spaceId', requireAuth, async (req, res) => {
  await db.runAsync('DELETE FROM saved_spaces WHERE user_id = ? AND space_id = ?', [req.user.id, req.params.spaceId]);
  res.json({ message: 'Removed from saved' });
});

router.get('/my-listings', requireAuth, async (req, res) => {
  const rows = await db.allAsync('SELECT * FROM spaces WHERE owner_id = ? ORDER BY created_at DESC', [req.user.id]);
  res.json({ listings: rows.map(parse) });
});

module.exports = router;
