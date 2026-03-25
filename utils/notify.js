const db = require('../db/database');
const { sendEmail, emailTemplate } = require('./mailer');

async function notify({ userId, type, title, message, link, email }) {
  await db.runAsync(
    `INSERT INTO notifications (user_id, type, title, message, link) VALUES (?, ?, ?, ?, ?)`,
    [userId, type, title, message, link || null]);
  if (email) {
    const user = await db.getAsync('SELECT email, name FROM users WHERE id = ?', [userId]);
    if (user) {
      const appUrl = process.env.APP_URL || 'http://localhost:3000';
      sendEmail({
        to: user.email,
        subject: title,
        html: emailTemplate({
          title,
          body: `<p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#6B6456;line-height:1.7;margin:0 0 16px;">Hi ${user.name},</p>
                 <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#6B6456;line-height:1.7;margin:0 0 16px;">${message}</p>`,
          ctaText: link ? 'View on SpaceLogg' : null,
          ctaUrl: link || null
        })
      }).catch(err => console.error('Email error:', err));
    }
  }
}

const Notify = {
  spaceApproved: (uid, name) => notify({
    userId: uid, type: 'space_approved',
    title: 'Your space was approved!',
    message: `"${name}" is now live on SpaceLogg. Users can find and book it.`,
    email: true
  }),

  spaceRejected: (uid, name, reason) => notify({
    userId: uid, type: 'space_rejected',
    title: 'Space submission update',
    message: `"${name}" was not approved. ${reason || 'Please review and resubmit.'}`,
    email: true
  }),

  newReview: (uid, name, rating) => notify({
    userId: uid, type: 'new_review',
    title: 'New review on your space',
    message: `Someone left a ${rating}★ review on "${name}". Check it out!`,
    email: true
  }),

  newBooking: (uid, spaceName, userName, date, time) => notify({
    userId: uid, type: 'new_booking',
    title: 'New booking received!',
    message: `${userName} just booked ${spaceName} on ${date} (${time}). Log in to view details.`,
    link: '/owner.html',
    email: true
  }),

  bookingCancelled: (uid, spaceName, userName, date) => notify({
    userId: uid, type: 'booking_cancelled',
    title: 'Booking cancelled',
    message: `${userName}'s booking at ${spaceName} on ${date} has been cancelled.`,
    link: '/owner.html',
    email: true
  }),

  bookingAccepted: (uid, spaceName, date) => notify({
    userId: uid, type: 'booking_accepted',
    title: 'Booking accepted!',
    message: `Your booking at ${spaceName} on ${date} has been accepted by the host.`,
    link: '/profile.html',
    email: true
  }),

  bookingRejected: (uid, spaceName, date) => notify({
    userId: uid, type: 'booking_rejected',
    title: 'Booking not accepted',
    message: `Your booking at ${spaceName} on ${date} was not accepted by the host. You will receive a refund if payment was made.`,
    link: '/profile.html',
    email: true
  }),

  payoutProcessed: (uid, amount) => notify({
    userId: uid, type: 'payout',
    title: 'Payout sent!',
    message: `Your payout of ${amount} has been processed. Check your bank account.`,
    email: true
  }),

  weeklySummary: (uid, bookings, revenue) => notify({
    userId: uid, type: 'weekly_summary',
    title: 'Your weekly summary',
    message: `This week: ${bookings} booking${bookings !== 1 ? 's' : ''}, ${revenue} in revenue.`,
    link: '/space-admin/',
    email: true
  }),
};

module.exports = { notify, Notify };
