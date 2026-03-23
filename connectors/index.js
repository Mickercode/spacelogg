const db = require('../db/database');
const NativeConnector = require('./native');

// All bookings go through the native connector for now.
// External platform sync happens via webhooks, not API calls.

async function getConnector(spaceId) {
  return new NativeConnector(null);
}

function clearCache() {}

async function logSync({ bookingId, spaceId, platform, action, externalRef, status, request, response, error }) {
  try {
    await db.runAsync(
      `INSERT INTO booking_sync_log (booking_id, space_id, platform, action, external_ref, status, request_payload, response_payload, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [bookingId || null, spaceId, platform, action, externalRef || null, status, request || null, response || null, error || null]
    );
  } catch (err) {
    console.error('Sync log failed:', err.message);
  }
}

module.exports = { getConnector, clearCache, logSync };
