const axios = require('axios');
const crypto = require('crypto');

const PAYSTACK_BASE = 'https://api.paystack.co';

function paystackClient() {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    throw new Error('PAYSTACK_SECRET_KEY not configured');
  }
  return axios.create({
    baseURL: PAYSTACK_BASE,
    headers: {
      'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });
}

/**
 * Initialize a Paystack transaction
 * @param {object} opts - { email, amount (kobo), currency, reference, callbackUrl, metadata }
 * @returns {{ authorization_url, access_code, reference }}
 */
async function initializeTransaction({ email, amount, currency = 'NGN', reference, callbackUrl, metadata }) {
  const client = paystackClient();
  const payload = {
    email,
    amount, // in kobo
    currency,
    reference,
    callback_url: callbackUrl,
    metadata: metadata || {}
  };
  const { data } = await client.post('/transaction/initialize', payload);
  if (!data.status) throw new Error(data.message || 'Paystack initialization failed');
  return data.data; // { authorization_url, access_code, reference }
}

/**
 * Verify a Paystack transaction
 * @param {string} reference
 * @returns {object} Paystack verification data
 */
async function verifyTransaction(reference) {
  const client = paystackClient();
  const { data } = await client.get(`/transaction/verify/${encodeURIComponent(reference)}`);
  if (!data.status) throw new Error(data.message || 'Verification failed');
  return data.data; // { status: 'success'|'failed'|'abandoned', amount, reference, ... }
}

/**
 * Refund a transaction
 * @param {object} opts - { transactionRef, amount? (kobo, omit for full refund) }
 */
async function refundTransaction({ transactionRef, amount }) {
  const client = paystackClient();
  const payload = { transaction: transactionRef };
  if (amount) payload.amount = amount;
  const { data } = await client.post('/refund', payload);
  if (!data.status) throw new Error(data.message || 'Refund failed');
  return data.data;
}

/**
 * Verify Paystack webhook signature
 * @param {string|Buffer} rawBody
 * @param {string} signature - x-paystack-signature header
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret || !signature) return false;
  const hash = crypto.createHmac('sha512', secret)
    .update(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'))
    .digest('hex');
  return hash === signature;
}

/**
 * Parse a display price string into numeric amount in smallest unit
 * "₦2,500" → { amountKobo: 250000, currency: 'NGN' }
 * "$15" → { amountKobo: 1500, currency: 'USD' }
 * "£5" → { amountKobo: 500, currency: 'GBP' }
 * "Free" or "" → { amountKobo: 0, currency: 'NGN' }
 */
function parsePrice(priceStr) {
  if (!priceStr || priceStr.toLowerCase() === 'free') {
    return { amountKobo: 0, currency: 'NGN' };
  }

  let currency = 'NGN';
  let cleaned = priceStr.trim();

  // Detect currency from symbol
  if (cleaned.startsWith('₦') || cleaned.startsWith('N')) {
    currency = 'NGN';
    cleaned = cleaned.replace(/^[₦N]+/, '');
  } else if (cleaned.startsWith('$')) {
    currency = 'USD';
    cleaned = cleaned.replace(/^\$/, '');
  } else if (cleaned.startsWith('£')) {
    currency = 'GBP';
    cleaned = cleaned.replace(/^£/, '');
  } else if (cleaned.startsWith('€')) {
    currency = 'EUR';
    cleaned = cleaned.replace(/^€/, '');
  }

  // Remove commas and whitespace, parse number
  cleaned = cleaned.replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  if (isNaN(num) || num <= 0) return { amountKobo: 0, currency };

  // Convert to smallest unit (kobo/cents/pence)
  return { amountKobo: Math.round(num * 100), currency };
}

/**
 * Format kobo amount to display string
 */
function formatAmount(amountKobo, currency = 'NGN') {
  const symbols = { NGN: '₦', USD: '$', GBP: '£', EUR: '€' };
  const symbol = symbols[currency] || currency + ' ';
  const value = (amountKobo / 100).toLocaleString('en', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return `${symbol}${value}`;
}

/**
 * Generate a unique payment reference
 */
function generateReference(bookingId) {
  return `sl_${bookingId}_${Date.now()}`;
}

module.exports = {
  initializeTransaction,
  verifyTransaction,
  refundTransaction,
  verifyWebhookSignature,
  parsePrice,
  formatAmount,
  generateReference
};
