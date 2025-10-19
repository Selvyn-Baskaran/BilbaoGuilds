/**
 * Guilds Website — Server
 * ------------------------------------------------------
 * Tech: Express + EJS, Passport (Azure AD OIDC), Socket.IO
 * Storage: flat JSON files (users/challenges/guilds/events/announcements/help)
 * Notes:
 *  - Cookies: SameSite=None + secure for Azure AD form_post callback
 *  - Trust proxy: required behind HTTPS reverse proxy / Docker ingress
 *  - Do not change route paths casually; front-end expects them
 */

require("dotenv").config();

// =============== 1) Core Imports & Setup =================
const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const multer = require("multer");
const session = require("express-session");
const sharedSession = require("express-socket.io-session");
const passport = require("passport");
const { OIDCStrategy } = require("passport-azure-ad");

const app = express();
app.set("trust proxy", 1); // required so secure cookies work behind a proxy
app.set("view engine", "ejs");

const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

// =============== 2) Paths, Files & Small Helpers =========
const USERS_FILE       = "./users.json";
const CHALLENGES_FILE  = "./challenges.json";
const GUILDS_FILE      = "./guilds.json";
const EVENTS_FILE      = "./events.json";
const ANNOUNCEMENTS_FILE = "./announcements.json";
const HELP_FILE        = "./help.json";

function readJsonOrDefault(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (_) {}
  return fallback;
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// quick raw helpers (used in admin handlers)
const readJSON  = (p) => JSON.parse(fs.readFileSync(p, "utf-8"));
const writeJSON = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2));

// =============== 3) Static, Body, Sessions ===============
app.use(express.static("public", { index: "login.html" }));
app.use(express.urlencoded({ extended: true })); // form posts
app.use(express.json());                          // JSON posts

// session cookie: must be SameSite=None for Azure AD form_post
const sessionMiddleware = session({
  name: "guilds.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,     // requires HTTPS + trust proxy
    sameSite: "none", // allow cross-site POST back from Azure
    // domain: ".finalgames.org", // if you ever need subdomain sharing
  },
});
app.use(sessionMiddleware);
io.use(sharedSession(sessionMiddleware, { autoSave: true }));

// =============== 4) File Uploads (multer) ================
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, path.join(__dirname, "public/uploads")),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const ok = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Only PNG/JPEG/GIF/WEBP allowed"), ok);
  },
});

// =============== 5) Auth: Passport (Azure AD OIDC) =======
app.use(passport.initialize());
app.use(passport.session());

// callback URL derived from BASE_URL
const callbackURL = `${process.env.BASE_URL.replace(/\/+$/, "")}/auth/microsoft/callback`;

// Azure AD strategy — organizations (work/school)
// NOTE: validateIssuer=false to accept multi-tenant org accounts; flip to true with tenant config if you restrict further.
passport.use(new OIDCStrategy(
  {
    identityMetadata: "https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration",
    clientID: process.env.AZURE_CLIENT_ID,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
    responseType: "code",
    responseMode: "form_post",
    redirectUrl: callbackURL,
    allowHttpForRedirectUrl: false,
    scope: ["openid", "profile", "email"],
    validateIssuer: false,
  },
  (_iss, _sub, profile, _accessToken, _refreshToken, done) => done(null, profile)
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// =============== 6) Locals for Views (safe defaults) =====
let totalOnline = 0;
app.use((req, res, next) => {
  res.locals.user   = req.session.user   || null;
  res.locals.guild  = req.session.guild  || "Fire";
  res.locals.points = req.session.points || 0;
  res.locals.role   = req.session.role   || "user";
  res.locals.online = totalOnline;

  // avatar helper available to all views
  const allUsers = readJsonOrDefault(USERS_FILE, {});
  const emailKey = (req.session.email || "").toLowerCase();
  const u = allUsers[emailKey] || {};
  const DEFAULT = "/uploads/default.png";
  let avatarPath = (typeof u.avatar === "string" && u.avatar.trim()) ? u.avatar.trim() : DEFAULT;
  if (!avatarPath.startsWith("/") && !avatarPath.startsWith("http")) {
    avatarPath = `/uploads/${avatarPath.replace(/^\/+/, "")}`;
  }
  req.session.avatar = avatarPath;
  res.locals.avatarUrl = avatarPath;
  res.locals.isDefaultAvatar = (avatarPath === DEFAULT);
  next();
});

// Optional: helpful request logging (kept as in your code)
app.use((req, _res, next) => {
  if (req.user) {
    console.log("AAD profile snapshot:", {
      preferred_username: req.user._json?.preferred_username,
      upn: req.user._json?.upn,
      emails_json: req.user._json?.emails,
      emails_obj: req.user.emails
    });
  }
  console.log("session.user =", req.session.user);
  next();
});

// =============== 7) Auth Guards ==========================
function requireLogin(req, res, next) {
  // used on /profile in your code; goes directly to Microsoft login
  if (!req.session.user) return res.redirect("/auth/microsoft");
  next();
}
function ensureLoggedIn(req, res, next) {
  // used for most pages; sends to local login page
  if (!req.session.user) return res.redirect("/login.html");
  next();
}
function ensureAdmin(req, res, next) {
  if (!req.session.user) return res.redirect("/login.html");
  if (req.session.role === "admin" || req.session.role === "manager") return next();
  return res.status(403).send("Forbidden: admin only");
}

// =============== 8) Auth Routes ==========================
app.get("/", (_req, res) => res.redirect("/login.html"));

app.get("/auth/microsoft",
  passport.authenticate("azuread-openidconnect", { prompt: "select_account" })
);

app.post(
  "/auth/microsoft/callback",
  passport.authenticate("azuread-openidconnect", { failureRedirect: "/" }),
  (req, res) => {
    // Normalize identity + seed session from users.json
    const emailRaw = req.user?._json?.preferred_username || "";
    const email = String(emailRaw).trim().toLowerCase();
    const displayName = req.user?.displayName || email;

    const users = readJsonOrDefault(USERS_FILE, {});
    const existing = users[email] || {}; // { guild, points, role, avatar? }

    req.session.user   = displayName;
    req.session.email  = email;
    req.session.guild  = existing.guild  || "Fire";
    req.session.points = existing.points || 0;
    req.session.role   = existing.role   || "user";
    req.session.avatar = existing.avatar || "/uploads/default.png";

    if (!users[email]) {
      users[email] = {
        guild:  req.session.guild,
        points: req.session.points,
        role:   req.session.role,
      };
      writeJson(USERS_FILE, users);
      console.log(`[NEW USER ADDED] ${email}`);
    }

    res.redirect("/index");
  }
);

// Session health check (AJAX)
app.get("/session-check", (req, res) => {
  if (req.session.user) return res.sendStatus(200);
  return res.sendStatus(401);
});

// =============== 9) Pages: Core ==========================
app.get("/index", ensureLoggedIn, (req, res) => {
  res.render("index", {
    guild:  req.session.guild || "Fire",
    points: req.session.points || 0,
    user:   req.session.user,
    role:   req.session.role,
    online: totalOnline,
  });
});

// =============== 10) Events (Month Grid + Detail) ========
app.get("/events", ensureLoggedIn, (req, res) => {
  const now = new Date();
  const y = Number(req.query.y) || now.getFullYear();
  const m = Number(req.query.m) || (now.getMonth() + 1); // 1..12

  // prev/next month (for header nav)
  let prevY = y, prevM = m - 1;
  if (prevM < 1)  { prevM = 12; prevY = y - 1; }
  let nextY = y, nextM = m + 1;
  if (nextM > 12) { nextM = 1;  nextY = y + 1; }

  const monthLabel = new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });

  // Load events list
  const events = readJsonOrDefault(EVENTS_FILE, []);

  // Helpers to bucket events by local date key
  const toKey = (d) => d.toISOString().slice(0,10);
  const normalizeDateStr = (s) => {
    if (!s) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    const ld = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return toKey(ld);
  };

  const eventsByDate = {};
  for (const ev of events) {
    const key = normalizeDateStr(ev.date || ev.start || ev.when);
    if (!key) continue;
    (eventsByDate[key] ||= []).push(ev);
  }

  // 6 x 7 grid starting Monday
  const weekStartsOn = 1; // Mon
  const firstOfMonth = new Date(y, m - 1, 1);
  const jsW = firstOfMonth.getDay(); // 0..6 Sun..Sat
  const offset = (jsW - weekStartsOn + 7) % 7;
  const gridStart = new Date(y, m - 1, 1 - offset);

  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const cellDate = new Date(gridStart);
      cellDate.setDate(gridStart.getDate() + (w * 7 + d));
      const inMonth =
        cellDate.getMonth() === (m - 1) &&
        cellDate.getFullYear() === y;

      const key = toKey(new Date(cellDate.getFullYear(), cellDate.getMonth(), cellDate.getDate()));
      week.push({
        y: cellDate.getFullYear(),
        m: cellDate.getMonth() + 1,
        day: cellDate.getDate(),
        inMonth,
        events: eventsByDate[key] || [],
      });
    }
    weeks.push(week);
  }

  // Upcoming list (today onward, max 10)
  const today = new Date();
  const todayKey = toKey(new Date(today.getFullYear(), today.getMonth(), today.getDate()));
  const upcoming = events
    .map(ev => {
      const key = normalizeDateStr(ev.date || ev.start || ev.when);
      return key ? { key, ev } : null;
    })
    .filter(x => x && x.key >= todayKey)
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, 10)
    .map(x => x.ev);

  res.render("events", {
    user:   req.session.user,
    role:   req.session.role || "user",
    guild:  req.session.guild || "Fire",
    points: req.session.points || 0,
    online: totalOnline,
    y, m, prevY, prevM, nextY, nextM, monthLabel,
    weeks,
    events,
    upcoming,
  });
});

// Single event details
app.get("/events/:id", ensureLoggedIn, (req, res) => {
  const events = readJsonOrDefault(EVENTS_FILE, []);
  const event = events.find(e => e.id === req.params.id);
  if (!event) return res.status(404).send("Event not found");

  res.render("event-details", {
    event,
    user:   req.session.user,
    role:   req.session.role || "user",
    guild:  req.session.guild || "Fire",
    points: req.session.points || 0,
    online: totalOnline,
  });
});

// =============== 11) Challenges ==========================
app.get("/challenges", ensureLoggedIn, (req, res) => {
  const challenges = readJsonOrDefault(CHALLENGES_FILE, []);
  res.render("challenges", {
    user:   req.session.user,
    guild:  req.session.guild || "Fire",
    points: req.session.points || 0,
    role:   req.session.role || "user",
    online: totalOnline,
    challenges,
  });
});

app.get("/challenges/:id", ensureLoggedIn, (req, res) => {
  const challenges = readJsonOrDefault(CHALLENGES_FILE, []);
  const challenge = challenges.find(c => String(c.id) === String(req.params.id));
  if (!challenge) return res.status(404).send("Challenge not found");

  const users  = readJsonOrDefault(USERS_FILE, {});
  const emailKey = (req.session.email || "").toLowerCase();
  const points = (users[emailKey]?.points) ?? (req.session.points || 0);

  res.render("challenge-thread", {
    challenge,
    user: req.session.user,
    guild: req.session.guild || "Fire",
    points,
    online: totalOnline,
  });
});

// Add a comment (optional attachment)
app.post("/challenges/:id/comment", ensureLoggedIn, upload.single("attachment"), (req, res) => {
  const challenges = readJsonOrDefault(CHALLENGES_FILE, []);
  const idx = challenges.findIndex(c => String(c.id) === String(req.params.id));
  if (idx === -1) return res.status(404).send("Not found");

  const avatar = req.session.avatar || "/uploads/default.png";
  const text = String(req.body.text || "").slice(0, 1000);
  const attachment = req.file ? `/uploads/${req.file.filename}` : null;

  challenges[idx].comments = challenges[idx].comments || [];
  challenges[idx].comments.push({
    user:   req.session.user,
    email:  (req.session.email || ""),
    text,
    avatar,
    attachment,
    ts: Date.now()
  });

  writeJson(CHALLENGES_FILE, challenges);
  res.redirect(`/challenges/${req.params.id}`);
});

// =============== 12) Guild Chat ==========================
app.get("/guild-chat", ensureLoggedIn, (req, res) => {
  // NOTE: your users.json is keyed by email; this line keeps your original behavior.
  const users = readJsonOrDefault(USERS_FILE, {});
  const guild = (users[req.session.user]?.guild) || req.session.guild || "Fire";
  req.session.guild = guild; // keep session consistent

  res.render("guild-chat", {
    user: req.session.user,
    guild,
    online: totalOnline,
  });
});

// =============== 13) Leaderboard =========================
app.get("/leaderboard", ensureLoggedIn, (req, res) => {
  const guilds = readJsonOrDefault(GUILDS_FILE, { Fire: 0, Water: 0, Earth: 0 });
  const sortedGuilds = Object.entries(guilds)
    .sort((a, b) => b[1] - a[1])
    .map(([name, points]) => ({ name, points }));
  const maxPoints = Math.max(1, ...sortedGuilds.map(g => g.points));

  res.render("leaderboard", {
    sortedGuilds, maxPoints,
    user: req.session.user,
    guild: req.session.guild || "Fire",
    online: totalOnline,
  });
});

// =============== 14) Profile =============================
app.get("/profile", requireLogin, (req, res) => {
  const email = (req.session.email || "").toLowerCase();
  const allUsers = readJsonOrDefault(USERS_FILE, {});
  const u = allUsers[email] || {};

  if (!req.session.avatar) req.session.avatar = u.avatar || "/uploads/default.png";

  res.render("profile", {
    user: req.session.user,
    guild: u.guild || "Fire",
    points: u.points || 0,
    role: u.role || "user",
    online: totalOnline,
    profile: {
      avatar: u.avatar || null,
      bio: u.bio || "",
    },
  });
});

app.post("/profile", requireLogin, upload.single("avatar"), (req, res) => {
  const email = (req.session.email || "").toLowerCase();
  const allUsers = readJsonOrDefault(USERS_FILE, {});
  const u = allUsers[email] || (allUsers[email] = {});

  // text fields
  u.bio = String(req.body.bio || "").slice(0, 500);

  // remove avatar
  if (req.body.removeAvatar === "on") {
    u.avatar = null;
    req.session.avatar = "/uploads/default.png";
  }
  // upload new avatar
  if (req.file) {
    u.avatar = `/uploads/${req.file.filename}`;
    req.session.avatar = u.avatar;
  }

  writeJson(USERS_FILE, allUsers);
  res.redirect("/profile");
});

// =============== 15) Admin: Pages & Handlers =============
app.get("/admin", ensureAdmin, (req, res) => {
  const allUsers      = readJsonOrDefault(USERS_FILE, {});
  const guildTotals   = readJsonOrDefault(GUILDS_FILE, { Fire: 0, Water: 0, Earth: 0 });
  const challenges    = readJsonOrDefault(CHALLENGES_FILE, []);
  const events        = readJsonOrDefault(EVENTS_FILE, []);
  const announcements = readJsonOrDefault(ANNOUNCEMENTS_FILE, []);

  res.render("admin", {
    user:   req.session.user,
    guild:  req.session.guild || "Fire",
    role:   req.session.role || "user",
    online: totalOnline,
    points: req.session.points || 0,
    allUsers,
    guildTotals,
    challenges,
    events,
    announcements,
  });
});

/* ---- Challenges (admin) ---- */
app.post("/admin/challenges/create", ensureAdmin, (req, res) => {
  const { id, title, description } = req.body;
  if (!id || !title) return res.status(400).send("id and title required");
  const challenges = readJsonOrDefault(CHALLENGES_FILE, []);
  if (challenges.some(c => String(c.id) === String(id))) return res.status(400).send("id already exists");
  challenges.push({ id, title, description: description || "", comments: [] });
  writeJson(CHALLENGES_FILE, challenges);
  res.redirect("/challenges");
});

app.post("/admin/challenges/:id/delete", ensureAdmin, (req, res) => {
  const challenges = readJsonOrDefault(CHALLENGES_FILE, []);
  const filtered = challenges.filter(c => String(c.id) !== String(req.params.id));
  writeJson(CHALLENGES_FILE, filtered);
  res.redirect("/admin");
});

app.post("/admin/challenges/:id/update", ensureAdmin, (req, res) => {
  const { title, description } = req.body;
  const challenges = readJsonOrDefault(CHALLENGES_FILE, []);
  const idx = challenges.findIndex(c => String(c.id) === String(req.params.id));
  if (idx === -1) return res.status(404).send("Challenge not found");
  if (title !== undefined)       challenges[idx].title = String(title);
  if (description !== undefined) challenges[idx].description = String(description);
  writeJson(CHALLENGES_FILE, challenges);
  res.redirect("/admin");
});

/* ---- Events (admin) ---- */
app.post("/admin/events/create", ensureAdmin, (req, res) => {
  const { id, title, date, time, location, description } = req.body;
  if (!id || !title || !date) return res.status(400).send("id, title, and date are required");

  const events = readJsonOrDefault(EVENTS_FILE, []);
  if (events.some(e => String(e.id) === String(id))) return res.status(400).send("Event id already exists");

  events.push({
    id: String(id),
    title: String(title),
    date: String(date),                  // "YYYY-MM-DD"
    time: time ? String(time) : "",
    location: location ? String(location) : "",
    description: description ? String(description) : "",
  });

  writeJson(EVENTS_FILE, events);
  res.redirect("/events");
});

app.post("/admin/events/:id/delete", ensureAdmin, (req, res) => {
  const events = readJsonOrDefault(EVENTS_FILE, []);
  const filtered = events.filter(e => String(e.id) !== String(req.params.id));
  writeJson(EVENTS_FILE, filtered);
  res.redirect("/admin");
});

app.post("/admin/events/:id/update", ensureAdmin, (req, res) => {
  const { title, date, time, location, description } = req.body;
  const events = readJsonOrDefault(EVENTS_FILE, []);
  const idx = events.findIndex(e => String(e.id) === String(req.params.id));
  if (idx === -1) return res.status(404).send("Event not found");

  if (title !== undefined)      events[idx].title = String(title);
  if (date !== undefined)       events[idx].date = String(date);
  if (time !== undefined)       events[idx].time = String(time);
  if (location !== undefined)   events[idx].location = String(location);
  if (description !== undefined)events[idx].description = String(description);

  writeJson(EVENTS_FILE, events);
  res.redirect("/admin");
});

/* Poster upload/remove */
app.post("/admin/events/:id/poster", ensureAdmin, upload.single("poster"), (req, res) => {
  if (!req.file) return res.status(400).send("No poster uploaded");
  const events = readJsonOrDefault(EVENTS_FILE, []);
  const idx = events.findIndex(e => String(e.id) === String(req.params.id));
  if (idx === -1) return res.status(404).send("Event not found");
  events[idx].poster = `/uploads/${req.file.filename}`;
  writeJson(EVENTS_FILE, events);
  res.redirect(`/events/${req.params.id}`);
});

app.post("/admin/events/:id/poster/delete", ensureAdmin, (req, res) => {
  const events = readJsonOrDefault(EVENTS_FILE, []);
  const idx = events.findIndex(e => String(e.id) === String(req.params.id));
  if (idx === -1) return res.status(404).send("Event not found");

  const old = events[idx].poster;
  if (old && old.startsWith("/uploads/")) {
    try { fs.unlinkSync(path.join(__dirname, "public", old)); } catch {}
  }
  events[idx].poster = null;
  writeJson(EVENTS_FILE, events);
  res.redirect(`/events/${req.params.id}`);
});

/* ---- Users/Guilds (admin) ---- */
app.post("/admin/users/points", ensureAdmin, (req, res) => {
  const { username, delta } = req.body;
  const d = Number(delta);
  if (!username || Number.isNaN(d)) return res.status(400).send("username and numeric delta required");

  const users = readJsonOrDefault(USERS_FILE, {});
  users[username] = users[username] || {};
  users[username].points = (users[username].points || 0) + d;
  writeJson(USERS_FILE, users);

  if (req.session.user === username) req.session.points = users[username].points;
  res.redirect("/admin");
});

app.post("/admin/users/role", ensureAdmin, (req, res) => {
  const { username, role } = req.body;
  if (!username || !role) return res.status(400).send("username and role required");

  const users = readJsonOrDefault(USERS_FILE, {});
  users[username] = users[username] || {};
  users[username].role = role;
  writeJson(USERS_FILE, users);

  if (req.session.user === username) req.session.role = role;
  res.redirect("/admin");
});

app.post("/admin/guilds/points", ensureAdmin, (req, res) => {
  const { guild, delta } = req.body;
  const d = Number(delta);
  if (!guild || Number.isNaN(d)) return res.status(400).send("guild and numeric delta required");

  const guilds = readJsonOrDefault(GUILDS_FILE, { Fire: 0, Water: 0, Earth: 0 });
  guilds[guild] = (guilds[guild] || 0) + d;
  writeJson(GUILDS_FILE, guilds);

  // live update for leaderboard
  io.emit("guildPointsUpdate", { guild, delta: d });
  res.redirect("/admin");
});

// =============== 16) Announcements (admin) ===============
app.get("/announcements.json", (_req, res) => {
  res.json(readJsonOrDefault(ANNOUNCEMENTS_FILE, []));
});

app.post("/admin/announcements/create", ensureAdmin, (req, res) => {
  const rawId = (req.body.id || "").trim();
  const safeId = rawId || `ann-${Date.now()}`;
  const title = (req.body.title || "").trim();
  const date  = req.body.date || "";
  const tag   = req.body.tag || "info";
  const note  = req.body.note || "";
  const href  = req.body.href || "";
  if (!title) return res.status(400).send("title required");

  const anns = readJsonOrDefault(ANNOUNCEMENTS_FILE, []);
  if (anns.some(a => String(a.id) === String(safeId))) {
    return res.status(400).send("ID already exists");
  }
  anns.push({ id: safeId, title, date, tag, note, href });
  writeJson(ANNOUNCEMENTS_FILE, anns);
  res.redirect("/admin");
});

app.post("/admin/announcements/:id/delete", ensureAdmin, (req, res) => {
  const id = req.params.id || req.body.id;
  if (!id) return res.status(400).send("Missing announcement id");
  const anns = readJsonOrDefault(ANNOUNCEMENTS_FILE, []);
  const filtered = anns.filter(a => String(a.id) !== String(id));
  writeJson(ANNOUNCEMENTS_FILE, filtered);
  res.redirect("/admin");
});

// =============== 17) Help Center =========================
app.get("/help", (req, res) => {
  const role  = req.session.role  || "user";
  const email = req.session.email || "";
  const all = readJsonOrDefault(HELP_FILE, []);
  const helpOpen = all.filter(h => h.status !== "resolved");
  const helpResolved = all.filter(h => h.status === "resolved")
                          .sort((a,b) => (b.resolvedAt||0) - (a.resolvedAt||0));

  res.render("help", {
    user: req.session.user,
    email,
    guild: req.session.guild || "Fire",
    points: req.session.points || 0,
    role,
    online: totalOnline,
    sent: req.query.sent === "1",
    helpOpen,
    helpResolved
  });
});

app.post("/help/submit", (req, res) => {
  const all = readJsonOrDefault(HELP_FILE, []);
  const id = `help-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
  const email = (req.body.email || req.session.email || "").trim();
  const message = (req.body.message || "").trim();
  if (!message) return res.status(400).send("Message is required");

  all.push({
    id, email,
    user: req.session.user || null,
    guild: req.session.guild || null,
    message,
    status: "open",
    createdAt: Date.now()
  });

  writeJson(HELP_FILE, all);
  res.redirect("/help?sent=1");
});

app.post("/admin/help/:id/resolve", ensureAdmin, (req, res) => {
  const all = readJsonOrDefault(HELP_FILE, []);
  const idx = all.findIndex(h => String(h.id) === String(req.params.id));
  if (idx === -1) return res.status(404).send("Help item not found");
  all[idx].status = "resolved";
  all[idx].resolvedAt = Date.now();
  writeJson(HELP_FILE, all);
  res.redirect("/help");
});

// =============== 18) Logout ==============================
app.get("/logout", (req, res) => {
  if (typeof req.logout === "function") {
    req.logout(() => {
      req.session.destroy(() => res.redirect("/login.html"));
    });
  } else {
    req.session.destroy(() => res.redirect("/login.html"));
  }
});

// =============== 19) Socket.IO ===========================
io.on("connection", (socket) => {
  const username = socket.handshake.session.user;
  if (!username) {
    socket.disconnect();
    return;
  }

  console.log(`User connected: ${username}`);
  totalOnline++;
  io.emit("updateOnline", totalOnline);

  socket.on("joinGuildRoom", (guild) => {
    socket.join(guild);
  });

  socket.on("guildMessage", ({ guild, message }) => {
    const avatar = socket.handshake.session?.avatar || "/uploads/default.png";
    io.to(guild).emit("guildMessage", { user: username, message, avatar });
  });

  socket.on("disconnect", () => {
    console.log(`${username} disconnected`);
    totalOnline = Math.max(0, totalOnline - 1);
    io.emit("updateOnline", totalOnline);
  });
});

// =============== 20) Start Server ========================
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
