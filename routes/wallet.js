const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// Credit reward rate: percentage of booking amount returned as credits
const CREDIT_RATE = Number(process.env.CREDIT_REWARD_PERCENT || 5) / 100;

// GET /api/wallet — get user's wallet balance
router.get('/', requireAuth, async (req, res) => {
  const wallet = await db.getAsync(
    'SELECT balance, currency FROM wallet WHERE user_id = ?', [req.user.id]);
  res.json({ balance: wallet?.balance || 0, currency: wallet?.currency || 'NGN' });
});

// GET /api/wallet/transactions — credit history
router.get('/transactions', requireAuth, async (req, res) => {
  const txs = await db.allAsync(
    'SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
    [req.user.id]);
  res.json({ transactions: txs });
});

/**
 * Credit a user's wallet (internal use)
 * @param {number} userId
 * @param {number} amount - in kobo
 * @param {string} type - 'booking_reward' | 'refund_credit' | 'admin_credit'
 * @param {string} description
 * @param {number|null} bookingId
 */
async function creditWallet(userId, amount, type, description, bookingId = null) {
  if (amount <= 0) return;
  // Ensure wallet exists
  await db.runAsync(
    `INSERT INTO wallet (user_id, balance, currency) VALUES (?, 0, 'NGN')
     ON CONFLICT(user_id, currency) DO NOTHING`, [userId]);
  // Add credit
  await db.runAsync('UPDATE wallet SET balance = balance + ? WHERE user_id = ?', [amount, userId]);
  await db.runAsync(
    'INSERT INTO wallet_transactions (user_id, amount, type, description, booking_id) VALUES (?, ?, ?, ?, ?)',
    [userId, amount, type, description, bookingId]);
}

/**
 * Debit a user's wallet (for applying credits to booking)
 * @returns {number} actual amount debited (may be less than requested if insufficient balance)
 */
async function debitWallet(userId, amount, description, bookingId = null) {
  if (amount <= 0) return 0;
  const wallet = await db.getAsync('SELECT balance FROM wallet WHERE user_id = ?', [userId]);
  const available = wallet?.balance || 0;
  const debit = Math.min(amount, available);
  if (debit <= 0) return 0;
  await db.runAsync('UPDATE wallet SET balance = balance - ? WHERE user_id = ?', [debit, userId]);
  await db.runAsync(
    'INSERT INTO wallet_transactions (user_id, amount, type, description, booking_id) VALUES (?, ?, ?, ?, ?)',
    [userId, -debit, 'booking_debit', description, bookingId]);
  return debit;
}

/**
 * Award credits after a successful booking
 */
async function awardBookingCredits(userId, bookingAmount, bookingId, spaceName) {
  const credits = Math.round(bookingAmount * CREDIT_RATE);
  if (credits <= 0) return 0;
  await creditWallet(userId, credits, 'booking_reward',
    `Earned from booking at ${spaceName}`, bookingId);
  return credits;
}

module.exports = router;
module.exports.creditWallet = creditWallet;
module.exports.debitWallet = debitWallet;
module.exports.awardBookingCredits = awardBookingCredits;
