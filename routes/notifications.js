const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const notifications = await db.allAsync('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  const row = await db.getAsync('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0', [req.user.id]);
  res.json({ notifications, unread: row.count });
});

router.patch('/read-all', requireAuth, async (req, res) => {
  await db.runAsync('UPDATE notifications SET read = 1 WHERE user_id = ?', [req.user.id]);
  res.json({ message: 'All marked as read' });
});

router.patch('/:id/read', requireAuth, async (req, res) => {
  await db.runAsync('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ message: 'Marked as read' });
});

router.delete('/:id', requireAuth, async (req, res) => {
  await db.runAsync('DELETE FROM notifications WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ message: 'Deleted' });
});

module.exports = router;
