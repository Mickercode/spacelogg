// ── CONFIG ──
const API = '/api';

// ── AUTH TOKEN ──
const Auth = {
  getToken: ()       => localStorage.getItem('sl_token'),
  setToken: (t)      => localStorage.setItem('sl_token', t),
  clear:    ()       => { localStorage.removeItem('sl_token'); localStorage.removeItem('sl_user'); },
  getUser:  ()       => { try { return JSON.parse(localStorage.getItem('sl_user')); } catch { return null; } },
  setUser:  (u)      => localStorage.setItem('sl_user', JSON.stringify(u)),
  isAdmin:  ()       => { const u = Auth.getUser(); return u && u.role === 'admin'; },
  loggedIn: ()       => !!Auth.getToken(),
};

// ── API FETCH ──
async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = Auth.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res  = await fetch(API + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function apiMultipart(path, formData) {
  const headers = {};
  const token = Auth.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res  = await fetch(API + path, { method: 'POST', headers, body: formData });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ── TOAST ──
function toast(msg, type = '') {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3200);
}

// ── HELPERS ──
function catLabel(c) { return { cafe:'Café', coworking:'Coworking', library:'Library', hotel:'Hotel Lounge' }[c] || c; }
function catIcon(c)  { return { cafe:'☕', coworking:'🖥', library:'📚', hotel:'🏨' }[c] || '📍'; }
function catColor(c) { return { cafe:'#E8891A', coworking:'#2EA87A', library:'#6B5ED6', hotel:'#B87A2A' }[c] || '#888'; }
function catColorLight(c) { return { cafe:'#FDF0E0', coworking:'#E8F4F0', library:'#EBE8F8', hotel:'#F5EDD8' }[c] || '#f5f5f5'; }
function catColorDark(c)  { return { cafe:'#A05E0A', coworking:'#1A6B50', library:'#4A3E9E', hotel:'#6B4A1A' }[c] || '#333'; }
function catGrad(c) {
  return { cafe:'linear-gradient(135deg,#7a3a00,#e8891a)', coworking:'linear-gradient(135deg,#0d5e40,#2ea87a)',
           library:'linear-gradient(135deg,#2d2480,#6b5ed6)', hotel:'linear-gradient(135deg,#4a2a00,#b87a2a)' }[c]
         || 'linear-gradient(135deg,#444,#888)';
}
function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── NAV RENDERER ──
function renderNav({ page = '' } = {}) {
  const user = Auth.getUser();
  const authBtns  = document.getElementById('nav-auth-btns');
  const userArea  = document.getElementById('nav-user-area');
  const notifWrap = document.getElementById('nav-notif-wrap');

  if (user) {
    if (authBtns)  authBtns.style.display  = 'none';
    if (userArea)  { userArea.style.display = 'flex'; const a = document.getElementById('nav-avatar'); if(a) a.textContent = user.name.charAt(0).toUpperCase(); }
    if (notifWrap) { notifWrap.style.display = 'flex'; loadNotifications(); }
    // Mobile drawer — show profile/logout, hide sign in/up
    const dAuth   = document.getElementById('drawer-auth-btns');
    const dProf   = document.getElementById('drawer-profile-link');
    const dLogout = document.getElementById('drawer-logout-btn');
    if (dAuth)   dAuth.style.display   = 'none';
    if (dProf)   { dProf.style.display = 'block'; }
    if (dLogout) dLogout.style.display = 'block';
  } else {
    if (authBtns)  authBtns.style.display  = 'flex';
    if (userArea)  userArea.style.display   = 'none';
    if (notifWrap) notifWrap.style.display  = 'none';
    // Mobile drawer — show sign in/up
    const dAuth   = document.getElementById('drawer-auth-btns');
    const dProf   = document.getElementById('drawer-profile-link');
    const dLogout = document.getElementById('drawer-logout-btn');
    if (dAuth)   dAuth.style.display   = 'flex';
    if (dProf)   dProf.style.display   = 'none';
    if (dLogout) dLogout.style.display = 'none';
  }
}

// ── NAV HTML SNIPPET (paste into each page) ──
function navLogoHTML() {
  return `<a href="/" class="nav-logo">
    <div class="nav-logomark">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="10" r="5" stroke="#1C1A16" stroke-width="2"/>
        <circle cx="12" cy="10" r="2" fill="#1C1A16"/>
        <path d="M12 15L12 22" stroke="#1C1A16" stroke-width="2" stroke-linecap="round"/>
        <path d="M8 21Q12 18.5 16 21" stroke="#1C1A16" stroke-width="1.5" stroke-linecap="round" fill="none"/>
      </svg>
    </div>
    <div class="nav-wordmark">Space<span>Logg</span></div>
  </a>`;
}

// ── NOTIFICATIONS ──
async function loadNotifications() {
  if (!Auth.loggedIn()) return;
  try {
    const { notifications, unread } = await apiFetch('/notifications');
    const badge = document.getElementById('notif-badge');
    if (badge) { badge.textContent = unread; badge.classList.toggle('show', unread > 0); }
    const list = document.getElementById('notif-list');
    if (!list) return;
    if (!notifications.length) { list.innerHTML = '<div class="notif-empty">No notifications yet</div>'; return; }
    list.innerHTML = notifications.map(n => `
      <div class="notif-item ${n.read ? '' : 'unread'}" onclick="readNotif(${n.id},this)">
        <div class="notif-icon" style="background:${notifBg(n.type)}">${notifEmoji(n.type)}</div>
        <div>
          <div class="notif-item-title">${n.title}</div>
          <div class="notif-item-msg">${n.message}</div>
          <div class="notif-time">${timeAgo(n.created_at)}</div>
        </div>
      </div>`).join('');
  } catch {}
}
function toggleNotifDropdown() {
  const dd = document.getElementById('notif-dropdown');
  if (dd) { dd.classList.toggle('open'); if (dd.classList.contains('open')) loadNotifications(); }
}
async function readNotif(id, el) {
  el.classList.remove('unread');
  await apiFetch(`/notifications/${id}/read`, { method:'PATCH' }).catch(() => {});
  loadNotifications();
}
async function markAllRead() {
  await apiFetch('/notifications/read-all', { method:'PATCH' });
  loadNotifications();
}
function notifEmoji(t) { return {welcome:'👋',space_approved:'✅',space_rejected:'❌',new_review:'⭐',space_saved:'♥'}[t]||'🔔'; }
function notifBg(t) { return {welcome:'#FDF0E0',space_approved:'#E8F4F0',space_rejected:'#FCEBEB',new_review:'#FDF0E0'}[t]||'#f0f0f0'; }

// ── CLOSE NOTIF ON OUTSIDE CLICK ──
document.addEventListener('click', e => {
  if (!e.target.closest('#nav-notif-wrap') && !e.target.closest('.notif-wrap')) {
    document.querySelectorAll('.notif-dropdown').forEach(d => d.classList.remove('open'));
  }
});

// ── LOGOUT ──
function logout() {
  Auth.clear();
  window.location.href = '/';
}

// ── GUARD: redirect if not logged in ──
function requireLogin(redirectTo) {
  if (!Auth.loggedIn()) {
    window.location.href = `/?login=1&next=${encodeURIComponent(redirectTo || window.location.pathname)}`;
  }
}

// ── GUARD: redirect if not admin ──
function requireAdminAccess() {
  if (!Auth.loggedIn() || !Auth.isAdmin()) {
    window.location.href = '/admin/login.html';
  }
}

// ── MOBILE NAV ──
function initMobileNav() {
  const btn = document.getElementById('nav-hamburger');
  const drawer = document.getElementById('nav-drawer');
  if (!btn || !drawer) return;

  btn.addEventListener('click', () => {
    btn.classList.toggle('open');
    drawer.classList.toggle('open');
    document.body.style.overflow = drawer.classList.contains('open') ? 'hidden' : '';
  });

  // Close on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('nav') && !e.target.closest('#nav-drawer')) {
      btn.classList.remove('open');
      drawer.classList.remove('open');
      document.body.style.overflow = '';
    }
  });

  // Close on link click
  drawer.querySelectorAll('a, button').forEach(el => {
    el.addEventListener('click', () => {
      btn.classList.remove('open');
      drawer.classList.remove('open');
      document.body.style.overflow = '';
    });
  });
}

// Call on DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMobileNav);
} else {
  initMobileNav();
}
