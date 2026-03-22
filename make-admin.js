require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const path    = require('path');

const DB_PATH = process.env.DB_PATH || './db/spacelogg.db';
const email   = process.argv[2];

if (!email) {
  console.log('Usage: node make-admin.js your@email.com');
  process.exit(1);
}

const db = new sqlite3.Database(DB_PATH, err => {
  if (err) { console.error('Could not open database. Is the server running first?', err.message); process.exit(1); }
});

db.get('SELECT id, name, email, role FROM users WHERE email = ?', [email.toLowerCase()], (err, user) => {
  if (err)  { console.error('Error:', err.message); process.exit(1); }
  if (!user) { console.log(`No user found with email: ${email}\nMake sure you have registered first at http://localhost:3000`); process.exit(1); }

  if (user.role === 'admin') {
    console.log(`${user.name} (${user.email}) is already an admin.`);
    db.close(); return;
  }

  db.run('UPDATE users SET role = ? WHERE email = ?', ['admin', email.toLowerCase()], function(err) {
    if (err) { console.error('Update failed:', err.message); process.exit(1); }
    console.log(`\n✅ Success! ${user.name} (${user.email}) is now an admin.`);
    console.log('Sign out and sign back in to see the Admin link in the nav.\n');
    db.close();
  });
});
