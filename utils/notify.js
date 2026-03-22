const db = require('../db/database');
const { sendEmail } = require('./mailer');

async function notify({ userId, type, title, message, link, email }) {
  await db.runAsync(
    `INSERT INTO notifications (user_id, type, title, message, link) VALUES (?, ?, ?, ?, ?)`,
    [userId, type, title, message, link || null]);
  if (email) {
    const user = await db.getAsync('SELECT email, name FROM users WHERE id = ?', [userId]);
    if (user) sendEmail({ to: user.email, subject: title,
      html: `<p>Hi ${user.name},</p><p>${message}</p>${link?`<p><a href="${link}">View on SpaceLogg →</a></p>`:''}`
    }).catch(err => console.error('Email error:', err));
  }
}

const Notify = {
  spaceApproved: (uid, name)         => notify({ userId:uid, type:'space_approved', title:'Your space was approved! ✅', message:`"${name}" is now live on SpaceLogg.`, email:true }),
  spaceRejected: (uid, name, reason) => notify({ userId:uid, type:'space_rejected', title:'Space submission update', message:`"${name}" was not approved. ${reason||'Please review and resubmit.'}`, email:true }),
  newReview:     (uid, name, rating) => notify({ userId:uid, type:'new_review', title:'New review on your space', message:`Someone left a ${rating}★ review on "${name}".` }),
};

module.exports = { notify, Notify };
