const express = require("express");
const http = require("http");
const multer = require("multer");
const path = require("path");
const session = require("express-session");
const sharedSession = require("express-socket.io-session");
const fs = require("fs");
const passport = require("passport");
const OIDCStrategy = require("passport-azure-ad").OIDCStrategy;


const app = express();
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

// --- EJS view engine ---
app.set("view engine", "ejs");

// --- Sessions (unchanged style; this was working for you) ---
const sessionMiddleware = session({
  secret: "replace-this-with-a-strong-secret",
  resave: false,
  saveUninitialized: false,
});
app.use(express.static("public", { index: "login.html" }));
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
io.use(sharedSession(sessionMiddleware, { autoSave: true }));

// --- Passport setup (kept your config) ---
app.use(passport.initialize());
app.use(passport.session());

// Ensure every view has these defined so EJS never crashes
app.use((req, res, next) => {
  res.locals.user   = req.session.user || null;
  res.locals.guild  = req.session.guild || "Fire";
  res.locals.points = req.session.points || 0;
  res.locals.role   = req.session.role || "user";
  res.locals.online = 0; // you can set to totalOnline if you prefer
  next();
});


// Azure AD OIDC Strategy (left as you had it, including validateIssuer dup)
passport.use(
  new OIDCStrategy(
    {
      identityMetadata:
        "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
      clientID: "5418c944-d78f-485b-bbde-45b77a4110e6",
      responseType: "code",
      responseMode: "form_post",
      redirectUrl: "http://localhost:3000/auth/microsoft/callback",
      allowHttpForRedirectUrl: true,
      clientSecret: "xeR8Q~zuitUbPsXPG.ZfImBoWyvpKkd5y6S-McyW",
      scope: ["profile", "email", "openid"],
      validateIssuer: true,
      // note: you also had validateIssuer:false later; leaving as-is since this was logging you in
      validateIssuer: false,
      issuer: null,
    },
    function (iss, sub, profile, accessToken, refreshToken, done) {
      return done(null, profile);
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// --- Small safety net so views always have something ---
let totalOnline = 0;
app.use((req, res, next) => {
  res.locals.user   = req.session.user || null;
  res.locals.guild  = req.session.guild || "Fire";
  res.locals.points = req.session.points || 0;
  res.locals.online = totalOnline;
  next();
});


// simple login guard
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login.html");
  next();
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "public/uploads")),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const ok = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Only PNG/JPEG/GIF/WEBP allowed"), ok);
  },
});


// --- Users / Challenges helpers (files optional) ---
const USERS_FILE = "./users.json";
const CHALLENGES_FILE = "./challenges.json";
const GUILDS_FILE = "./guilds.json";
function readJsonOrDefault(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (_) {}
  return fallback;
}

// --- Events helpers (files optional) ---
const EVENTS_FILE = "./events.json";

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
function readJsonOrDefault(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (_) {}
  return fallback;
}


const HELP_FILE = "./help.json";

// --- Routes ---
app.get("/", (req, res) => {
  res.redirect("/login.html");
});

// Start Microsoft login
app.get("/auth/microsoft", passport.authenticate("azuread-openidconnect"));

// Microsoft login callback (kept your original, but add safe defaults)
app.post(
  "/auth/microsoft/callback",
  passport.authenticate("azuread-openidconnect", { failureRedirect: "/" }),
  (req, res) => {
    // 1) Normalize keys
    const emailRaw = req.user?._json?.preferred_username || "";
    const email = String(emailRaw).trim().toLowerCase();   // <- canonical key
    const displayName = req.user?.displayName || email;

    // 2) Load users.json
    const users = readJsonOrDefault(USERS_FILE, {});       // make sure this helper + const are defined

    // 3) Look up by email
    const existing = users[email] || {};                   // { guild, points, role }

    // 4) Set session from users.json (or safe defaults)
    req.session.user   = displayName;                      // pretty name for UI
    req.session.email  = email;                            // canonical identity
    req.session.guild  = existing.guild  || "Fire";
    req.session.points = existing.points || 0;
    req.session.role   = existing.role   || "user";        // <- pulls "admin" if present!
    req.session.avatar = existing.avatar || "/uploads/default.png";


    // 5) If first login: create entry
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



// Session checker (AJAX)
app.get("/session-check", (req, res) => {
  if (req.session.user) res.sendStatus(200);
  else res.sendStatus(401);
});

// Protect pages
function ensureLoggedIn(req, res, next) {
  if (!req.session.user) return res.redirect("/login.html");
  next();
}

function ensureAdmin(req, res, next) {
  if (!req.session.user) return res.redirect("/login.html");
  if (req.session.role === "admin" || req.session.role === "manager") return next();
  return res.status(403).send("Forbidden: admin only");
}

// body parser (if not already present)
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// small I/O helpers
const readJSON = (p) => JSON.parse(fs.readFileSync(p, "utf-8"));
const writeJSON = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2));


app.use((req, res, next) => {
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

// Make avatar vars available to all EJS views/partials
app.use((req, res, next) => {
  const allUsers = readJsonOrDefault(USERS_FILE, {});     // load safely
  const emailKey = (req.session.email || "").toLowerCase();
  const u = allUsers[emailKey] || {};

  // Standardize your default path (file should live at public/uploads/default.png)
  const DEFAULT = "/uploads/default.png";

  // Prefer the stored web path (e.g., "/uploads/abc.png"), else default
  let avatarPath = (typeof u.avatar === "string" && u.avatar.trim())
    ? u.avatar.trim()
    : DEFAULT;

  // Normalize if someone saved bare filenames
  if (!avatarPath.startsWith("/") && !avatarPath.startsWith("http")) {
    avatarPath = `/uploads/${avatarPath.replace(/^\/+/, "")}`;
  }

  // Keep session copy around (handy for socket.io)
  req.session.avatar = avatarPath;
  res.locals.avatarUrl = avatarPath;
  res.locals.isDefaultAvatar = (avatarPath === DEFAULT);
  next();
});


// --- MAIN INDEX ---
app.get("/index", ensureLoggedIn, (req, res) => {
  res.render("index", {
    guild:  req.session.guild || "Fire",
    points: req.session.points || 0,
    user:   req.session.user,
    role:   req.session.role,
    online: totalOnline,
  });
});

// Events pages
// Events page (month grid)
app.get("/events", ensureLoggedIn, (req, res) => {
  const now = new Date();
  const y = Number(req.query.y) || now.getFullYear();
  const m = Number(req.query.m) || (now.getMonth() + 1); // 1..12

  // prev / next month
  let prevY = y, prevM = m - 1;
  if (prevM < 1) { prevM = 12; prevY = y - 1; }
  let nextY = y, nextM = m + 1;
  if (nextM > 12) { nextM = 1; nextY = y + 1; }

  const monthLabel = new Date(y, m - 1, 1).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });

  // Load events (optional file)
  let events = [];
  try {
    if (fs.existsSync("./events.json")) {
      events = JSON.parse(fs.readFileSync("./events.json", "utf-8"));
    }
  } catch {}

  // Index events by YYYY-MM-DD
  const toKey = (d) => d.toISOString().slice(0,10);
  const normalizeDateStr = (s) => {
    // accept "YYYY-MM-DD" or anything Date can parse
    if (!s) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    // force to local date key
    const ld = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return toKey(ld);
  };
  const eventsByDate = {};
  for (const ev of events) {
    const key = normalizeDateStr(ev.date || ev.start || ev.when);
    if (!key) continue;
    (eventsByDate[key] ||= []).push(ev);
  }

  // Build calendar grid (weeks -> 7 days each), week starts on Monday
  const weekStartsOn = 1; // 0=Sun, 1=Mon
  const firstOfMonth = new Date(y, m - 1, 1);
  const jsW = firstOfMonth.getDay(); // 0..6 (Sun..Sat)
  const offset = (jsW - weekStartsOn + 7) % 7;

  // Start date shown in grid
  const gridStart = new Date(y, m - 1, 1 - offset);

  // produce 6 weeks * 7 days (42 cells) to cover all cases
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const cellDate = new Date(gridStart);
      cellDate.setDate(gridStart.getDate() + (w * 7 + d));

      const inMonth = (cellDate.getMonth() === (m - 1)) && (cellDate.getFullYear() === y);
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

  // === Build "upcoming" list (today onward), max 10 ===
  const today = new Date();
  const todayKey = toKey(new Date(today.getFullYear(), today.getMonth(), today.getDate()));
  const upcoming = events
    .map(ev => {
      const key = normalizeDateStr(ev.date || ev.start || ev.when); // adjust if your field differs
      return key ? { key, ev } : null;
    })
    .filter(x => x && x.key >= todayKey)
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, 10)
    .map(x => x.ev);

  res.render("events", {
    // navbar + common
    user:   req.session.user,
    role:   req.session.role || "user",
    guild:  req.session.guild || "Fire",
    points: req.session.points || 0,
    online: totalOnline,

    // calendar vars expected by events.ejs
    y, m, prevY, prevM, nextY, nextM, monthLabel,
    weeks,
    events,
    upcoming, // <-- added
  });
});


app.get("/events/:id", ensureLoggedIn, (req, res) => {
  let events = [];
  try {
    events = JSON.parse(fs.readFileSync("./events.json", "utf-8"));
  } catch (e) {
    return res.status(500).send("Failed to load events.json");
  }

  const event = events.find(e => e.id === req.params.id);
  if (!event) return res.status(404).send("Event not found");

  res.render("event-details", {
    // pass the event!
    event,

    // navbar + common
    user:   req.session.user,
    role:   req.session.role || "user",
    guild:  req.session.guild || "Fire",
    points: req.session.points || 0,
    online: totalOnline,
  });
});



// --- CENTRAL CHALLENGES LIST ---
app.get("/challenges", ensureLoggedIn, (req, res) => {
  let challenges = [];
  try {
    if (fs.existsSync("./challenges.json")) {
      challenges = JSON.parse(fs.readFileSync("./challenges.json", "utf-8"));
    }
  } catch {}

  res.render("challenges", {
    user:   req.session.user,
    guild:  req.session.guild || "Fire",
    points: req.session.points || 0,
    role:   req.session.role || "user",
    online: totalOnline,
    challenges,
  });
});


// --- VIEW CHALLENGE THREAD ---
app.get("/challenges/:id", ensureLoggedIn, (req, res) => {
  const challenges = readJsonOrDefault(CHALLENGES_FILE, []);
  const challenge = challenges.find(c => String(c.id) === String(req.params.id));
  if (!challenge) return res.status(404).send("Challenge not found");

  const users = readJsonOrDefault(USERS_FILE, {});
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

// --- POST COMMENT TO CHALLENGE ---
app.post("/challenges/:id/comment", ensureLoggedIn, upload.single("attachment"), (req, res) => {
  const challenges = readJsonOrDefault(CHALLENGES_FILE, []);
  const idx = challenges.findIndex(c => String(c.id) === String(req.params.id));
  if (idx === -1) return res.status(404).send("Not found");

  const avatar = req.session.avatar || "/uploads/default.png";
  const text = String(req.body.text || "").slice(0, 1000);
  const attachment = req.file ? `/uploads/${req.file.filename}` : null;

  challenges[idx].comments = challenges[idx].comments || [];
  challenges[idx].comments.push({
    user:   req.session.user,                // display name
    email:  (req.session.email || ""),       // optional, for moderation
    text,
    avatar,
    attachment,
    ts: Date.now()
  });

  writeJson(CHALLENGES_FILE, challenges);
  res.redirect(`/challenges/${req.params.id}`);
});



// --- GUILD CHAT ---
app.get("/guild-chat", ensureLoggedIn, (req, res) => {
  const users = readJsonOrDefault(USERS_FILE, {});
  const guild = (users[req.session.user]?.guild) || req.session.guild || "Fire";

  // store back to session for consistency
  req.session.guild = guild;

  res.render("guild-chat", {
    user: req.session.user,
    guild,
    online: totalOnline,
  });
});

// --- LEADERBOARD ---
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


app.get("/profile", requireLogin, (req, res) => {
  const email = (req.session.email || "").toLowerCase(); // canonical
  const allUsers = readJsonOrDefault(USERS_FILE, {});
  const u = allUsers[email] || {};

  // keep session avatar in sync (nice-to-have)
  if (!req.session.avatar) {
    req.session.avatar = u.avatar || "/uploads/default.png";
  }

  res.render("profile", {
    user: req.session.user,                  // display name
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

  // new avatar
  if (req.file) {
    u.avatar = `/uploads/${req.file.filename}`;
    req.session.avatar = u.avatar; // keep session in sync
  }

  writeJson(USERS_FILE, allUsers);
  res.redirect("/profile");
});

// ----- ADMIN-ONLY HANDLERS -----

// Adjust a single user's points: { username, delta }
function handlerAdjustUserPoints(req, res) {
  try {
    const { username, delta } = req.body;
    const d = parseInt(delta, 10) || 0;
    if (!username || !Number.isFinite(d)) return res.status(400).send("Bad request");

    const users = readJSON("./users.json");

    // Resolve by exact email key OR by case-insensitive key match
    let key = users[username] ? username : null;
    if (!key) {
      const uname = String(username).toLowerCase();
      key = Object.keys(users).find(k => k.toLowerCase() === uname) || null;
    }
    if (!key) return res.status(404).send("User not found");

    users[key].points = (users[key].points || 0) + d;
    writeJSON("./users.json", users);
    return res.redirect("/admin");
  } catch (e) {
    console.error("handlerAdjustUserPoints error:", e);
    return res.status(500).send("Server error");
  }
}

// Set a user's role: { username, role }
function handlerSetUserRole(req, res) {
  try {
    const { username, role } = req.body;
    const allowed = new Set(["user", "manager", "admin"]);
    if (!username || !allowed.has(role)) return res.status(400).send("Bad request");

    const users = readJSON("./users.json");

    // Resolve by exact email key OR by case-insensitive key match
    let key = users[username] ? username : null;
    if (!key) {
      const uname = String(username).toLowerCase();
      key = Object.keys(users).find(k => k.toLowerCase() === uname) || null;
    }
    if (!key) return res.status(404).send("User not found");

    users[key].role = role;
    writeJSON("./users.json", users);
    return res.redirect("/admin");
  } catch (e) {
    console.error("handlerSetUserRole error:", e);
    return res.status(500).send("Server error");
  }
}

// Adjust guild totals: { guild, delta }
function handlerAdjustGuildTotals(req, res) {
  try {
    const { guild, delta } = req.body;
    const d = parseInt(delta, 10) || 0;
    if (!guild || !Number.isFinite(d)) return res.status(400).send("Bad request");

    const guilds = readJSON("./guilds.json");
    if (!(guild in guilds)) return res.status(404).send("Guild not found");

    guilds[guild] = (guilds[guild] || 0) + d;
    writeJSON("./guilds.json", guilds);
    return res.redirect("/admin");
  } catch (e) {
    console.error("handlerAdjustGuildTotals error:", e);
    return res.status(500).send("Server error");
  }
}

app.get("/announcements.json", (req, res) => {
  const anns = readJsonOrDefault("./announcements.json", []);
  res.json(anns);
});


// Admin portal
app.get("/admin", ensureAdmin, (req, res) => {
  const allUsers = readJsonOrDefault(USERS_FILE, {});       // { username/email: {guild, points, role, ...} }
  const guildTotals = readJsonOrDefault(GUILDS_FILE, { Fire: 0, Water: 0, Earth: 0 });
  const challenges = readJsonOrDefault(CHALLENGES_FILE, []);
  const events      = readJsonOrDefault("./events.json", []);
    const announcements = readJsonOrDefault("./announcements.json", []);


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

// Create Challenge
app.post("/admin/challenges/create", ensureAdmin, (req, res) => {
  const { id, title, description } = req.body;
  if (!id || !title) return res.status(400).send("id and title required");
  const challenges = readJsonOrDefault(CHALLENGES_FILE, []);
  if (challenges.some(c => String(c.id) === String(id))) return res.status(400).send("id already exists");

  challenges.push({ id, title, description: description || "", comments: [] });
  writeJson(CHALLENGES_FILE, challenges);
  res.redirect("/challenges");
});

// Delete Challenge
app.post("/admin/challenges/:id/delete", ensureAdmin, (req, res) => {
  const challenges = readJsonOrDefault(CHALLENGES_FILE, []);
  const filtered = challenges.filter(c => String(c.id) !== String(req.params.id));
  writeJson(CHALLENGES_FILE, filtered);
  res.redirect("/admin");
});

// Update/Edit Challenge
app.post("/admin/challenges/:id/update", ensureAdmin, (req, res) => {
  const { title, description } = req.body;
  const challenges = readJsonOrDefault(CHALLENGES_FILE, []);
  const idx = challenges.findIndex(c => String(c.id) === String(req.params.id));
  if (idx === -1) return res.status(404).send("Challenge not found");

  if (title !== undefined) challenges[idx].title = String(title);
  if (description !== undefined) challenges[idx].description = String(description);

  writeJson(CHALLENGES_FILE, challenges);
  res.redirect("/admin");
});

// Create Event
app.post("/admin/events/create", ensureAdmin, (req, res) => {
  const { id, title, date, time, location, description } = req.body;

  if (!id || !title || !date) {
    return res.status(400).send("id, title, and date are required");
  }

  const events = readJsonOrDefault(EVENTS_FILE, []);
  if (events.some(e => String(e.id) === String(id))) {
    return res.status(400).send("Event id already exists");
  }

  events.push({
    id: String(id),
    title: String(title),
    date: String(date),             // "YYYY-MM-DD" (your calendar already uses this)
    time: time ? String(time) : "", // optional "HH:MM"
    location: location ? String(location) : "",
    description: description ? String(description) : "",
  });

  writeJson(EVENTS_FILE, events);
  res.redirect("/events");
});

// Delete Event
app.post("/admin/events/:id/delete", ensureAdmin, (req, res) => {
  const events = readJsonOrDefault("./events.json", []);
  const filtered = events.filter(e => String(e.id) !== String(req.params.id));
  writeJson("./events.json", filtered);
  res.redirect("/admin");
});

// Update/Edit Event
app.post("/admin/events/:id/update", ensureAdmin, (req, res) => {
  const { title, date, time, location, description } = req.body;
  const events = readJsonOrDefault("./events.json", []);
  const idx = events.findIndex(e => String(e.id) === String(req.params.id));
  if (idx === -1) return res.status(404).send("Event not found");

  // update only provided fields
  if (title !== undefined)      events[idx].title = String(title);
  if (date !== undefined)       events[idx].date = String(date);
  if (time !== undefined)       events[idx].time = String(time);
  if (location !== undefined)   events[idx].location = String(location);
  if (description !== undefined)events[idx].description = String(description);

  writeJson("./events.json", events);
  res.redirect("/admin");
});

// --- Add/Replace Poster ---
app.post("/admin/events/:id/poster", ensureAdmin, upload.single("poster"), (req, res) => {
  if (!req.file) return res.status(400).send("No poster uploaded");
  const events = readJsonOrDefault("./events.json", []);
  const idx = events.findIndex(e => String(e.id) === String(req.params.id));
  if (idx === -1) return res.status(404).send("Event not found");

  events[idx].poster = `/uploads/${req.file.filename}`; // web path
  writeJson("./events.json", events);
  res.redirect(`/events/${req.params.id}`);
});

// --- Remove Poster ---
app.post("/admin/events/:id/poster/delete", ensureAdmin, (req, res) => {
  const events = readJsonOrDefault("./events.json", []);
  const idx = events.findIndex(e => String(e.id) === String(req.params.id));
  if (idx === -1) return res.status(404).send("Event not found");

  // optionally unlink old file (safe: only unlink if it looks like an upload)
  const old = events[idx].poster;
  if (old && old.startsWith("/uploads/")) {
    try { fs.unlinkSync(path.join(__dirname, "public", old)); } catch {}
  }
  events[idx].poster = null;
  writeJson("./events.json", events);
  res.redirect(`/events/${req.params.id}`);
});




// Adjust user points
app.post("/admin/users/points", ensureAdmin, (req, res) => {
  const { username, delta } = req.body;
  const d = Number(delta);
  if (!username || Number.isNaN(d)) return res.status(400).send("username and numeric delta required");

  const users = readJsonOrDefault(USERS_FILE, {});
  users[username] = users[username] || {};
  users[username].points = (users[username].points || 0) + d;
  writeJson(USERS_FILE, users);

  // If you adjusted your own points, reflect it in session
  if (req.session.user === username) req.session.points = users[username].points;
  res.redirect("/admin");
});

// Set user role
app.post("/admin/users/role", ensureAdmin, (req, res) => {
  const { username, role } = req.body;
  if (!username || !role) return res.status(400).send("username and role required");

  const users = readJsonOrDefault(USERS_FILE, {});
  users[username] = users[username] || {};
  users[username].role = role;
  writeJson(USERS_FILE, users);

  // if you changed your own role, reflect it
  if (req.session.user === username) req.session.role = role;
  res.redirect("/admin");
});

// Adjust guild totals
app.post("/admin/guilds/points", ensureAdmin, (req, res) => {
  const { guild, delta } = req.body;
  const d = Number(delta);
  if (!guild || Number.isNaN(d)) return res.status(400).send("guild and numeric delta required");

  const guilds = readJsonOrDefault(GUILDS_FILE, { Fire: 0, Water: 0, Earth: 0 });
  guilds[guild] = (guilds[guild] || 0) + d;
  writeJson(GUILDS_FILE, guilds);

  // 🔥 Broadcast live leaderboard update
  io.emit("guildPointsUpdate", { guild, delta: d });

  res.redirect("/admin");
});

const ANNOUNCEMENTS_FILE = "./announcements.json";

// --- ANNOUNCEMENTS ADMIN ---

// Create announcement
app.post("/admin/announcements/create", ensureAdmin, (req, res) => {
  // sanitize + safe defaults
  const rawId = (req.body.id || "").trim();
  const safeId = rawId || `ann-${Date.now()}`;  // fallback unique id if empty
  const title = (req.body.title || "").trim();
  const date = req.body.date || "";
  const tag = req.body.tag || "info";
  const note = req.body.note || "";
  const href = req.body.href || "";

  if (!title) return res.status(400).send("title required");

  const anns = readJsonOrDefault(ANNOUNCEMENTS_FILE, []);

  // prevent duplicate IDs
  if (anns.some(a => String(a.id) === String(safeId))) {
    return res.status(400).send("ID already exists");
  }

  anns.push({
    id: safeId,
    title,
    date,
    tag,
    note,
    href
  });

  writeJson(ANNOUNCEMENTS_FILE, anns);
  res.redirect("/admin");
});


// Delete announcement
app.post("/admin/announcements/:id/delete", ensureAdmin, (req, res) => {
  const id = req.params.id || req.body.id;
  if (!id) return res.status(400).send("Missing announcement id");

  const anns = readJsonOrDefault(ANNOUNCEMENTS_FILE, []);
  const filtered = anns.filter(a => String(a.id) !== String(id));
  writeJson(ANNOUNCEMENTS_FILE, filtered);
  res.redirect("/admin");
});



// Help Page
app.get("/help", (req, res) => {
  const role = req.session.role || "user";
  const email = req.session.email || "";

  const all = readJsonOrDefault(HELP_FILE, []);
  // split open vs resolved
  const helpOpen = all.filter(h => h.status !== "resolved");
  const helpResolved = all.filter(h => h.status === "resolved")
                          .sort((a,b) => (b.resolvedAt||0) - (a.resolvedAt||0));

  res.render("help", {
    user: req.session.user,
    email, // prefill
    guild: req.session.guild || "Fire",
    points: req.session.points || 0,
    role,
    online: totalOnline,
    sent: req.query.sent === "1",
    // admin-only lists (but we still pass—help.ejs hides unless admin)
    helpOpen,
    helpResolved
  });
});

// POST /help/submit
app.post("/help/submit", (req, res) => {
  const all = readJsonOrDefault(HELP_FILE, []);
  const id = `help-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
  const email = (req.body.email || req.session.email || "").trim();
  const message = (req.body.message || "").trim();

  if (!message) return res.status(400).send("Message is required");

  all.push({
    id,
    email,
    user: req.session.user || null,
    guild: req.session.guild || null,
    message,
    status: "open",
    createdAt: Date.now()
  });

  writeJson(HELP_FILE, all);
  res.redirect("/help?sent=1");
});

// POST /admin/help/:id/resolve
app.post("/admin/help/:id/resolve", ensureAdmin, (req, res) => {
  const all = readJsonOrDefault(HELP_FILE, []);
  const idx = all.findIndex(h => String(h.id) === String(req.params.id));
  if (idx === -1) return res.status(404).send("Help item not found");

  all[idx].status = "resolved";
  all[idx].resolvedAt = Date.now();
  writeJson(HELP_FILE, all);

  res.redirect("/help");
});



// --- Logout ---
app.get("/logout", (req, res) => {
  if (typeof req.logout === "function") {
    req.logout(() => {
      req.session.destroy(() => res.redirect("/login.html"));
    });
  } else {
    req.session.destroy(() => res.redirect("/login.html"));
  }
});

// --- Socket.IO logic ---
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
  const avatar = socket.handshake.session?.avatar || "/uploads/default.png"; // <- use uploads
  io.to(guild).emit("guildMessage", { user: username, message, avatar });
});


  socket.on("disconnect", () => {
    console.log(`${username} disconnected`);
    totalOnline = Math.max(0, totalOnline - 1);
    io.emit("updateOnline", totalOnline);
  });
});

// --- Start server ---
server.listen(3000, "0.0.0.0", () => {
  console.log("Server running on http://localhost:3000");
});
