require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Required for Railway/Render

app.use(cors());
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

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// Admin redirect
app.get('/admin', (req, res) => res.redirect('/admin/login.html'));

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
