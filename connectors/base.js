class BaseConnector {
  constructor(integration) {
    this.integration = integration;
    this.platform = 'native';
  }

  async checkAvailability(spaceId, date) {
    throw new Error('checkAvailability not implemented');
  }

  async createBooking({ spaceId, userId, date, startTime, endTime, guests, note }) {
    throw new Error('createBooking not implemented');
  }

  async cancelBooking(bookingId, userId) {
    throw new Error('cancelBooking not implemented');
  }

  async getPrice(spaceId, date, startTime, endTime) {
    throw new Error('getPrice not implemented');
  }
}

module.exports = BaseConnector;
