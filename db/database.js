const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

// Connection string from environment
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set. Please set it in your environment variables.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Convert SQLite-style ? placeholders to PostgreSQL $1, $2, $3 style
function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Compatibility wrapper — same interface as our old SQLite db object
const db = {
  // INSERT/UPDATE/DELETE — returns { lastID, changes }
  runAsync: async (sql, params = []) => {
    const pgSql = convertPlaceholders(sql);
    const isInsert = /^\s*INSERT/i.test(sql);
    const finalSql = isInsert && !/RETURNING/i.test(pgSql)
      ? pgSql + ' RETURNING id'
      : pgSql;
    const result = await pool.query(finalSql, params);
    return {
      lastID: result.rows?.[0]?.id ?? null,
      changes: result.rowCount
    };
  },

  // SELECT single row
  getAsync: async (sql, params = []) => {
    const result = await pool.query(convertPlaceholders(sql), params);
    return result.rows[0] || null;
  },

  // SELECT multiple rows
  allAsync: async (sql, params = []) => {
    const result = await pool.query(convertPlaceholders(sql), params);
    return result.rows;
  }
};

// ── SCHEMA ──
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        avatar TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        email_verified INTEGER NOT NULL DEFAULT 0,
        verify_token TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS spaces (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT,
        address TEXT NOT NULL,
        city TEXT NOT NULL DEFAULT '',
        area TEXT DEFAULT '',
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        price TEXT,
        walkin_price TEXT DEFAULT '',
        price_unit TEXT,
        price_hourly TEXT DEFAULT '',
        price_monthly TEXT DEFAULT '',
        rating DOUBLE PRECISION DEFAULT 0,
        review_count INTEGER DEFAULT 0,
        amenities TEXT DEFAULT '[]',
        hours TEXT DEFAULT '{}',
        images TEXT DEFAULT '[]',
        owner_id INTEGER REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'pending',
        capacity INTEGER DEFAULT 1,
        wifi_speed TEXT DEFAULT '',
        power_backup TEXT DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS saved_spaces (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, space_id)
      );

      CREATE TABLE IF NOT EXISTS reviews (
        id SERIAL PRIMARY KEY,
        space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        user_id  INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
        rating INTEGER NOT NULL,
        comment TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(space_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        link TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS password_resets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        space_id   INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
        date       TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time   TEXT NOT NULL,
        guests     INTEGER NOT NULL DEFAULT 1,
        note       TEXT,
        status     TEXT NOT NULL DEFAULT 'confirmed',
        total_price TEXT,
        external_ref TEXT,
        amount_value INTEGER,
        currency TEXT DEFAULT 'NGN',
        credits_used INTEGER DEFAULT 0,
        status_owner TEXT DEFAULT 'auto',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS space_integrations (
        id SERIAL PRIMARY KEY,
        space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        external_space_id TEXT NOT NULL,
        credentials_enc TEXT NOT NULL,
        config TEXT DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(space_id)
      );

      CREATE TABLE IF NOT EXISTS booking_sync_log (
        id SERIAL PRIMARY KEY,
        booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
        space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        action TEXT NOT NULL,
        external_ref TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        request_payload TEXT,
        response_payload TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'NGN',
        provider TEXT NOT NULL DEFAULT 'paystack',
        provider_ref TEXT,
        provider_status TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        metadata TEXT DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS payouts (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'NGN',
        period_start TEXT,
        period_end TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        paid_at TEXT,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wallet (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        balance INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'NGN',
        UNIQUE(user_id, currency)
      );

      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount INTEGER NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        booking_id INTEGER REFERENCES bookings(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS recently_viewed (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, space_id)
      );

      CREATE TABLE IF NOT EXISTS owner_profiles (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        business_name TEXT,
        business_description TEXT,
        logo TEXT,
        phone TEXT,
        bank_name TEXT,
        account_number TEXT,
        account_name TEXT,
        paystack_recipient_code TEXT,
        paystack_subaccount_id TEXT,
        verified INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id)
      );

      CREATE TABLE IF NOT EXISTS availability_blocks (
        id SERIAL PRIMARY KEY,
        space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        block_date TEXT NOT NULL,
        start_time TEXT,
        end_time TEXT,
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Safe migrations for existing tables
    const migrations = [
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token TEXT",
    ];
    for (const m of migrations) {
      await client.query(m).catch(() => {});
    }

    // Indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_spaces_category ON spaces(category);
      CREATE INDEX IF NOT EXISTS idx_spaces_status ON spaces(status);
      CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_spaces(user_id);
      CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);
      CREATE INDEX IF NOT EXISTS idx_bookings_space ON bookings(space_id);
      CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
      CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
      CREATE INDEX IF NOT EXISTS idx_integrations_space ON space_integrations(space_id);
      CREATE INDEX IF NOT EXISTS idx_sync_log_booking ON booking_sync_log(booking_id);
      CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);
      CREATE INDEX IF NOT EXISTS idx_payments_ref ON payments(provider_ref);
      CREATE INDEX IF NOT EXISTS idx_payouts_owner ON payouts(owner_id);
      CREATE INDEX IF NOT EXISTS idx_owner_profiles ON owner_profiles(user_id);
      CREATE INDEX IF NOT EXISTS idx_avail_blocks ON availability_blocks(space_id, block_date);
      CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet(user_id);
      CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_recently_viewed ON recently_viewed(user_id);
    `);

    // Seed spaces if empty
    const { rows } = await client.query('SELECT COUNT(*) as c FROM spaces');
    if (parseInt(rows[0].c) === 0) {
      const seeds = [
        ['Leadspace','coworking','One of Lagos\'s most popular coworking spaces with a vibrant community of entrepreneurs, freelancers, and remote workers. Flexible desk options and a collaborative environment designed for productivity and networking.','39 Admiralty Way, Lekki Phase 1','Lagos','Lekki Phase 1',6.4380,3.4750,'₦5,000','/day',4.8,142,'["High-Speed WiFi","Air Con","Meeting Rooms","Printing","Power Backup","Kitchen","Lockers"]','{"Mon–Fri":"8am – 8pm","Saturday":"9am – 5pm","Sunday":"Closed"}'],
        ['Workstation','coworking','A premium coworking and office space in Ikoyi catering to startups, SMEs, and corporate teams. Well-equipped professional workspace with meeting facilities and reception services.','7A Milverton Road, Ikoyi','Lagos','Ikoyi',6.4490,3.4340,'₦7,000','/day',4.7,96,'["High-Speed WiFi","Air Con","Conference Rooms","Reception","Printing","Power Backup","Parking","Kitchen"]','{"Mon–Fri":"8am – 7pm","Saturday":"9am – 3pm","Sunday":"Closed"}'],
        ['Cranium One','coworking','A modern coworking space on the Lagos mainland designed for tech professionals, creatives, and entrepreneurs. Tech-forward environment with event spaces and incubation support for startups.','6 Bola Shadipe Street, off Adelabu Street, Surulere','Lagos','Surulere',6.4969,3.3567,'₦3,000','/day',4.6,78,'["High-Speed WiFi","Air Con","Event Space","Meeting Rooms","Power Backup","Printing","Kitchen"]','{"Mon–Fri":"8am – 8pm","Saturday":"9am – 5pm","Sunday":"Closed"}'],
        ['The Bulb Africa','coworking','A co-creation hub and innovation space that supports tech talent through coworking, training programs, and startup incubation. Well-regarded for nurturing early-stage tech companies with affordable workspace.','44 Oguntolu Street, off Allen Avenue, Ikeja','Lagos','Ikeja',6.6018,3.3515,'₦2,500','/day',4.5,65,'["High-Speed WiFi","Air Con","Training Rooms","Meeting Rooms","Power Backup","Community Events","Mentorship"]','{"Mon–Fri":"8am – 7pm","Saturday":"10am – 4pm","Sunday":"Closed"}'],
        ['Co-Creation Hub (CcHUB)','coworking','Nigeria\'s first open living lab and pre-incubation space. A flagship innovation center that has supported numerous successful Nigerian startups and serves as a community hub for social innovators and developers.','294 Herbert Macaulay Way, Yaba','Lagos','Yaba',6.5170,3.3780,'₦4,000','/day',4.9,203,'["High-Speed WiFi","Air Con","Meeting Rooms","Event Space","Prototyping Lab","Mentorship","Power Backup","Cafe"]','{"Mon–Fri":"8am – 9pm","Saturday":"10am – 6pm","Sunday":"Closed"}'],
        ['Impact Hub Lagos','coworking','Part of the global Impact Hub network, focused on social entrepreneurs and impact-driven businesses. Combines coworking with community programs, events, and acceleration support for ventures creating positive social change.','1 Ozumba Mbadiwe Avenue, Victoria Island','Lagos','Victoria Island',6.4280,3.4230,'₦6,000','/day',4.7,87,'["High-Speed WiFi","Air Con","Conference Rooms","Event Space","Community Programs","Printing","Power Backup","Lounge"]','{"Mon–Fri":"8am – 7pm","Saturday":"10am – 4pm","Sunday":"Closed"}'],
      ];
      for (const s of seeds) {
        await client.query(
          `INSERT INTO spaces (name,category,description,address,city,area,lat,lng,price,price_unit,rating,review_count,amenities,hours,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'approved')`, s
        );
      }
      console.log('✅ Database seeded with sample spaces');
    }

    // Auto-create admin from env vars
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
      const existing = await client.query('SELECT id, role FROM users WHERE email = $1', [process.env.ADMIN_EMAIL.toLowerCase()]);
      if (existing.rows.length && existing.rows[0].role === 'admin') {
        console.log(`✅ Admin account exists: ${process.env.ADMIN_EMAIL}`);
      } else {
        const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
        if (existing.rows.length) {
          await client.query('UPDATE users SET role = $1 WHERE email = $2', ['admin', process.env.ADMIN_EMAIL.toLowerCase()]);
          console.log(`✅ Promoted ${process.env.ADMIN_EMAIL} to admin`);
        } else {
          await client.query(
            `INSERT INTO users (name, email, password, role, email_verified) VALUES ($1, $2, $3, 'admin', 1)`,
            [process.env.ADMIN_NAME || 'Admin', process.env.ADMIN_EMAIL.toLowerCase(), hash]
          );
          console.log(`✅ Admin account created: ${process.env.ADMIN_EMAIL}`);
        }
      }
    }

    console.log('✅ PostgreSQL database initialized');
  } catch (err) {
    console.error('❌ Database initialization error:', err);
    throw err;
  } finally {
    client.release();
  }
}

// Initialize on startup
initDB().catch(err => {
  console.error('Fatal DB error:', err);
  process.exit(1);
});

module.exports = db;
