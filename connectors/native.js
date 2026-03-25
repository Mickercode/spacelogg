const BaseConnector = require('./base');
const db = require('../db/database');
const { parsePrice } = require('../utils/payment');

class NativeConnector extends BaseConnector {
  constructor(integration) {
    super(integration);
    this.platform = 'native';
  }

  async checkAvailability(spaceId, date) {
    // Check if entire date is blocked by owner
    const fullBlock = await db.getAsync(
      'SELECT id FROM availability_blocks WHERE space_id = ? AND block_date = ? AND start_time IS NULL',
      [spaceId, date]);
    if (fullBlock) return { bookedSlots: [], blocked: true };

    // Get time-specific blocks
    const blocks = await db.allAsync(
      'SELECT start_time, end_time FROM availability_blocks WHERE space_id = ? AND block_date = ? AND start_time IS NOT NULL',
      [spaceId, date]);

    const bookings = await db.allAsync(
      `SELECT start_time, end_time FROM bookings
       WHERE space_id = ? AND date = ? AND status NOT IN ('cancelled','refunded')`,
      [spaceId, date]
    );

    // Check capacity
    const space = await db.getAsync('SELECT capacity FROM spaces WHERE id = ?', [spaceId]);
    const capacity = space?.capacity || 1;

    return { bookedSlots: [...bookings, ...blocks], blocked: false, capacity };
  }

  async createBooking({ spaceId, userId, date, startTime, endTime, guests, note }) {
    // Verify space exists and is approved
    const space = await db.getAsync(
      'SELECT * FROM spaces WHERE id = ? AND status = ?', [spaceId, 'approved']
    );
    if (!space) return { error: 'Space not found', statusCode: 404 };

    // Check for time conflicts
    const conflict = await db.getAsync(`
      SELECT id FROM bookings WHERE space_id = ? AND date = ? AND status != 'cancelled'
      AND NOT (end_time <= ? OR start_time >= ?)`,
      [spaceId, date, startTime, endTime]
    );
    if (conflict) return { error: 'This time slot is already booked', statusCode: 409 };

    // Create booking
    const { lastID } = await db.runAsync(
      `INSERT INTO bookings (space_id, user_id, date, start_time, end_time, guests, note, total_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [spaceId, userId, date, startTime, endTime, guests || 1, note || '', space.price || '']
    );

    const booking = await db.getAsync(`
      SELECT b.*, s.name as space_name, s.address, s.category
      FROM bookings b JOIN spaces s ON s.id = b.space_id WHERE b.id = ?`, [lastID]);

    return { booking, externalRef: null, space };
  }

  async cancelBooking(bookingId, userId) {
    const booking = await db.getAsync(
      'SELECT * FROM bookings WHERE id = ? AND user_id = ?', [bookingId, userId]
    );
    if (!booking) return { error: 'Booking not found', statusCode: 404 };
    if (booking.status === 'cancelled') return { error: 'Already cancelled', statusCode: 400 };

    await db.runAsync('UPDATE bookings SET status = ? WHERE id = ?', ['cancelled', bookingId]);
    const space = await db.getAsync('SELECT name FROM spaces WHERE id = ?', [booking.space_id]);

    return { success: true, booking, spaceName: space?.name };
  }

  async getPrice(spaceId, date, startTime, endTime) {
    const space = await db.getAsync('SELECT price FROM spaces WHERE id = ?', [spaceId]);
    if (!space) return { amountKobo: 0, currency: 'NGN' };
    return parsePrice(space.price);
  }
}

module.exports = NativeConnector;
