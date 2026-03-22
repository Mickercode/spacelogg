# SpaceLogg 🗺️
**Find your space. Do your work.**

A full-stack workspace discovery web app for remote workers — built with Node.js, Express, SQLite, and Leaflet maps.

---

## 🚀 Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment
```bash
cp .env.example .env
# Edit .env and change JWT_SECRET to a strong random string
```

### 3. Run the server
```bash
# Development (auto-restart)
npm run dev

# Production
npm start
```

### 4. Open in browser
```
http://localhost:3000
```

The database is created and seeded automatically on first run with 6 sample spaces in Ibadan.

---

## 📁 Project Structure

```
spacelogg/
├── server.js              # Express app entry point
├── .env.example           # Environment template
├── db/
│   └── database.js        # SQLite schema + seed data
├── routes/
│   ├── auth.js            # Register, login, profile
│   ├── spaces.js          # CRUD, search, reviews, image upload
│   └── users.js           # Saved spaces, my listings
├── middleware/
│   └── auth.js            # JWT guard middleware
└── public/
    ├── index.html         # Full frontend (all views)
    └── uploads/           # Uploaded space images
```

---

## 🔌 API Reference

### Auth
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | — | Create account |
| POST | `/api/auth/login` | — | Sign in, get JWT |
| GET | `/api/auth/me` | ✅ | Get current user |
| PATCH | `/api/auth/me` | ✅ | Update name/password |

### Spaces
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/spaces` | — | List & search spaces |
| GET | `/api/spaces/:id` | — | Get single space + reviews |
| POST | `/api/spaces` | ✅ | Submit new listing |
| PATCH | `/api/spaces/:id` | ✅ | Update listing (owner/admin) |
| DELETE | `/api/spaces/:id` | ✅ | Delete listing |
| POST | `/api/spaces/:id/reviews` | ✅ | Leave a review |
| PATCH | `/api/spaces/:id/approve` | 🔐 | Approve/reject (admin) |

### Users
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/users/saved` | ✅ | Get saved spaces |
| POST | `/api/users/saved/:spaceId` | ✅ | Save a space |
| DELETE | `/api/users/saved/:spaceId` | ✅ | Unsave a space |
| GET | `/api/users/my-listings` | ✅ | Get own submitted spaces |

### Query Parameters (GET /api/spaces)
- `category` — filter by: `cafe`, `coworking`, `library`, `hotel`
- `city` — filter by city name
- `q` — full-text search (name, description, address)
- `limit` — results per page (default: 50)
- `offset` — pagination offset

---

## 🌍 Deployment

### Railway (recommended — free tier)
```bash
# Install Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
```

### Render
1. Create a new Web Service
2. Connect your GitHub repo
3. Set Build Command: `npm install`
4. Set Start Command: `node server.js`
5. Add environment variables from `.env`

### Environment Variables
```
PORT=3000
JWT_SECRET=your_long_random_secret_here
DB_PATH=./db/spacelogg.db
UPLOAD_DIR=./public/uploads
```

---

## 🛠️ Features

**Frontend**
- Landing page with hero, features, how it works
- Interactive map (Leaflet + OpenStreetMap, no API key needed)
- Split-view dashboard: card list + live map
- Filter by category, full-text search
- Space detail modal with amenities, hours, reviews
- Multi-step listing submission form with image upload
- User accounts: sign up, sign in, profile
- Saved spaces with heart toggle
- My listings with approval status

**Backend**
- REST API with Express
- SQLite database (zero setup, file-based)
- JWT authentication (7-day tokens)
- Bcrypt password hashing
- Image upload with Multer (5MB limit, jpg/png/webp)
- Input validation and error handling
- Admin approval workflow for new listings

---

## 📸 Adding Real Images

Space images are served from `/public/uploads/`. To add images:
1. Upload via the "List a Space" form
2. Or copy images directly to `/public/uploads/` and update the DB:
```sql
UPDATE spaces SET images = '["./uploads/yourfile.jpg"]' WHERE id = 1;
```

---

## 🔐 Admin Access

To make a user an admin, update the database:
```bash
# Using SQLite CLI
sqlite3 db/spacelogg.db
UPDATE users SET role = 'admin' WHERE email = 'your@email.com';
```

Admins can approve/reject submitted spaces via:
```
PATCH /api/spaces/:id/approve
Body: { "status": "approved" }
```

---

Built with ❤️ for remote workers everywhere.
