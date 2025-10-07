const express = require("express");
const http = require("http");
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
  const points = (users[req.session.user]?.points) ?? (req.session.points || 0);

  res.render("challenge-thread", {
    challenge,
    user: req.session.user,
    guild: req.session.guild || "Fire",
    points,
    online: totalOnline,
  });
});

// --- POST COMMENT TO CHALLENGE ---
app.post("/challenges/:id/comment", ensureLoggedIn, (req, res) => {
  const challenges = readJsonOrDefault(CHALLENGES_FILE, []);
  const idx = challenges.findIndex(c => String(c.id) === String(req.params.id));
  if (idx === -1) return res.status(404).send("Not found");

  challenges[idx].comments = challenges[idx].comments || [];
  challenges[idx].comments.push({
    user: req.session.user || "Anonymous",
    text: req.body.text || "",
  });

  try {
    fs.writeFileSync(CHALLENGES_FILE, JSON.stringify(challenges, null, 2));
  } catch (_) {}
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

  res.render("leaderboard", {
    sortedGuilds,
    user: req.session.user,
    guild: req.session.guild || "Fire",
    online: totalOnline,
  });
});

// Admin portal
app.get("/admin", ensureAdmin, (req, res) => {
  const allUsers = readJsonOrDefault(USERS_FILE, {});       // { username/email: {guild, points, role, ...} }
  const guildTotals = readJsonOrDefault(GUILDS_FILE, { Fire: 0, Water: 0, Earth: 0 });

  res.render("admin", {
    user:   req.session.user,
    guild:  req.session.guild || "Fire",
    role:   req.session.role || "user",
    online: totalOnline,
    points: req.session.points || 0,
    allUsers,
    guildTotals,
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
  res.redirect("/admin");
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
    io.to(guild).emit("guildMessage", { user: username, message });
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
