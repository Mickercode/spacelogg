require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Required for Railway/Render

app.use(cors());

// Paystack webhook needs raw body for HMAC signature verification — must be BEFORE express.json()
app.use('/api/webhooks/paystack', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// ── ROUTES ──
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/spaces',        require('./routes/spaces'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/bookings',      require('./routes/bookings'));
app.use('/api/wallet',        require('./routes/wallet'));
app.use('/api/owner',         require('./routes/owner'));
app.use('/api/webhooks',      require('./routes/webhooks'));

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// Admin redirect
app.get('/admin', (req, res) => res.redirect('/admin/login.html'));

// HostApp: /space-admin/ serves landing page, /space-admin/dashboard goes to app
app.get('/space-admin', (req, res) => res.redirect('/space-admin/'));
app.get('/space-admin/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'space-admin', 'landing.html')));
app.get('/space-admin/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'space-admin', 'index.html')));

// Catch-all: serve static file if exists, otherwise index.html
app.get('*', (req, res) => {
  const filePath = path.join(__dirname, 'public', req.path);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return res.sendFile(filePath);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(PORT, HOST, () => {
  console.log(`🚀 SpaceLogg running at http://${HOST}:${PORT}`);
  console.log(`🔐 Admin portal: http://${HOST}:${PORT}/admin`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
