const sqlite3  = require('sqlite3').verbose();
const path     = require('path');
const fs       = require('fs');
const bcrypt   = require('bcryptjs');

// Railway uses ephemeral filesystem — use /tmp for SQLite
// For persistent data on Railway, set DB_PATH in environment variables
// pointing to a mounted volume path
const DB_PATH = process.env.DB_PATH || (
  process.env.RAILWAY_ENVIRONMENT ? '/tmp/spacelogg.db' : './db/spacelogg.db'
);
const dbDir   = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new sqlite3.Database(DB_PATH, err => {
  if (err) { console.error('DB error:', err); process.exit(1); }
});

db.runAsync = (sql, p=[]) => new Promise((res,rej) => db.run(sql,p,function(err){err?rej(err):res({lastID:this.lastID,changes:this.changes})}));
db.getAsync  = (sql, p=[]) => new Promise((res,rej) => db.get(sql,p,(err,row)=>err?rej(err):res(row)));
db.allAsync  = (sql, p=[]) => new Promise((res,rej) => db.all(sql,p,(err,rows)=>err?rej(err):res(rows)));

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA journal_mode = WAL');

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
    avatar TEXT, role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);

  db.run(`CREATE TABLE IF NOT EXISTS spaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    category TEXT NOT NULL, description TEXT,
    address TEXT NOT NULL, city TEXT NOT NULL DEFAULT '',
    lat REAL, lng REAL, price TEXT, price_unit TEXT,
    rating REAL DEFAULT 0, review_count INTEGER DEFAULT 0,
    amenities TEXT DEFAULT '[]', hours TEXT DEFAULT '{}', images TEXT DEFAULT '[]',
    owner_id INTEGER REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);

  db.run(`CREATE TABLE IF NOT EXISTS saved_spaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    saved_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, space_id))`);

  db.run(`CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    rating INTEGER NOT NULL, comment TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(space_id, user_id))`);

  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, link TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);

  db.run(`CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);

  db.run(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id   INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    date       TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time   TEXT NOT NULL,
    guests     INTEGER NOT NULL DEFAULT 1,
    note       TEXT,
    status     TEXT NOT NULL DEFAULT 'confirmed',
    total_price TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);

  db.run(`CREATE TABLE IF NOT EXISTS space_integrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    external_space_id TEXT NOT NULL,
    credentials_enc TEXT NOT NULL,
    config TEXT DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(space_id))`);

  db.run(`CREATE TABLE IF NOT EXISTS booking_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
    space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    action TEXT NOT NULL,
    external_ref TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    request_payload TEXT,
    response_payload TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);

  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'NGN',
    provider TEXT NOT NULL DEFAULT 'paystack',
    provider_ref TEXT,
    provider_status TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);

  db.run(`CREATE TABLE IF NOT EXISTS payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'NGN',
    period_start TEXT,
    period_end TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    paid_at TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);

  // Safe migrations (swallow error if column already exists)
  db.run('ALTER TABLE bookings ADD COLUMN external_ref TEXT', [], () => {});
  db.run('ALTER TABLE bookings ADD COLUMN amount_value INTEGER', [], () => {});
  db.run("ALTER TABLE bookings ADD COLUMN currency TEXT DEFAULT 'NGN'", [], () => {});
  db.run("ALTER TABLE spaces ADD COLUMN area TEXT DEFAULT ''", [], () => {});

  db.run(`CREATE INDEX IF NOT EXISTS idx_spaces_category ON spaces(category)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_spaces_status   ON spaces(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_saved_user      ON saved_spaces(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notif_user      ON notifications(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bookings_space  ON bookings(space_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bookings_user   ON bookings(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_integrations_space ON space_integrations(space_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sync_log_booking ON booking_sync_log(booking_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payments_ref ON payments(provider_ref)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_payouts_owner ON payouts(owner_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status)`);

  // Seed spaces if empty
  db.get('SELECT COUNT(*) as c FROM spaces', [], (err, row) => {
    if (err || row.c > 0) return;
    const ins = db.prepare(`INSERT INTO spaces
      (name,category,description,address,city,area,lat,lng,price,price_unit,rating,review_count,amenities,hours,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'approved')`);
    [
      ['The Loft Workspace','coworking','A premium coworking space with high-speed fibre, ergonomic chairs, and a quiet focused environment.','14 Marina Street','Lagos','Lagos Island',6.4541,3.3947,'₦2,500','/day',4.9,128,'["Fast WiFi","Air Con","Printing","Meeting Rooms","Café","Lockers"]','{"Mon–Fri":"7am – 10pm","Saturday":"8am – 8pm","Sunday":"Closed"}'],
      ['Brew & Work Café','cafe','A warm artisan café with strong WiFi and great coffee. Popular with freelancers for its relaxed atmosphere.','22 Wuse Zone 4','Abuja','Wuse',9.0574,7.4898,'₦500','/coffee',4.7,84,'["WiFi","Power Outlets","Coffee","Pastries","Quiet Zone"]','{"Mon–Fri":"7am – 9pm","Saturday":"8am – 9pm","Sunday":"9am – 6pm"}'],
      ['Central Public Library','library','A fully renovated public library with modern study facilities and reliable internet.','5 Independence Ave','Accra','Osu',5.5502,-0.2174,'Free','',4.5,61,'["WiFi","Quiet Space","Study Rooms","AC","Printing"]','{"Mon–Fri":"8am – 6pm","Saturday":"9am – 4pm","Sunday":"Closed"}'],
      ['Skyline Business Lounge','hotel','A refined hotel business lounge available to non-guests by day pass.','Nairobi CBD','Nairobi','Nairobi CBD',-1.2863,36.8172,'$15','/day',4.6,47,'["High-Speed WiFi","AC","Coffee Service","Printing","Quiet"]','{"Mon–Sun":"6am – 11pm"}'],
      ['Roamers Co','coworking','A modern coworking space with private pods, communal tables, café bar, and networking events.','31 Victoria Island','Lagos','Victoria Island',6.4281,3.4219,'₦3,000','/day',4.8,96,'["Fibre WiFi","Standing Desks","Locker","Café Bar","Events Space"]','{"Mon–Fri":"6am – 11pm","Saturday":"8am – 9pm","Sunday":"10am – 6pm"}'],
      ['Grounds Café','cafe','A specialty coffee shop loved by the creative community. Great natural light and ample power sockets.','8 Oxford Street','London','Westminster',51.5155,-0.1410,'£5','/coffee',4.6,72,'["Fast WiFi","Power Points","Specialty Coffee","Food","Outdoor Seating"]','{"Mon–Fri":"7am – 8pm","Saturday":"8am – 8pm","Sunday":"10am – 5pm"}'],
    ].forEach(r => ins.run(...r));
    ins.finalize();
    console.log('✅ Database seeded with sample spaces');
  });

  // Auto-create admin from env vars
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    db.get('SELECT id, role FROM users WHERE email = ?', [process.env.ADMIN_EMAIL.toLowerCase()], async (err, row) => {
      if (err) return;
      if (row && row.role === 'admin') {
        console.log(`✅ Admin account exists: ${process.env.ADMIN_EMAIL}`);
        return;
      }
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
      if (row) {
        // User exists but not admin — promote them
        db.run('UPDATE users SET role = ? WHERE email = ?', ['admin', process.env.ADMIN_EMAIL.toLowerCase()],
          () => console.log(`✅ Promoted ${process.env.ADMIN_EMAIL} to admin`)
        );
      } else {
        // Create fresh admin account
        db.run(`INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'admin')`,
          [process.env.ADMIN_NAME || 'Admin', process.env.ADMIN_EMAIL.toLowerCase(), hash],
          () => console.log(`✅ Admin account created: ${process.env.ADMIN_EMAIL}`)
        );
      }
    });
  }
});

module.exports = db;
