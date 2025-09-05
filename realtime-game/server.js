const express = require("express");
const http = require("http");
const path = require("path");
const session = require("express-session");
const sharedSession = require("express-socket.io-session");
const bcrypt = require("bcrypt");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

// EJS view engine
app.set("view engine", "ejs");

// Load users from file
const USERS_FILE = "./users.json";
let users = {};
if (fs.existsSync(USERS_FILE)) {
  users = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
}
function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Sessions
const sessionMiddleware = session({
  secret: "replace-this-with-a-strong-secret",
  resave: false,
  saveUninitialized: false,
});
app.use(express.static("public", { index: "login.html" }));
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
io.use(sharedSession(sessionMiddleware, { autoSave: true }));

// Online count
let totalOnline = 0;

// Routes
app.get("/", (req, res) => {
  res.redirect("/login.html");
});

// Central Challenges list
app.get("/challenges", (req, res) => {
  const challenges = JSON.parse(fs.readFileSync("./challenges.json", "utf-8"));
  res.render("challenges", {  
    user: req.session.user,
    guild: req.session.guild,
    points: users[req.session.user]?.points || 0,
    role: req.session.role,
    challenges,
    online: totalOnline,
  });
});

// View challenge thread
app.get("/challenges/:id", (req, res) => {
  const challenges = JSON.parse(fs.readFileSync("./challenges.json", "utf-8"));
  const challenge = challenges.find(c => c.id === req.params.id);
  if (!challenge) return res.send("Not found");
  res.render("challenge-thread", {
  challenge,
  user: req.session.user,
  guild: req.session.guild,
  role: req.session.role,
  points: users[req.session.user]?.points || 0,
  online: totalOnline
});
});

// Post comment to challenge
app.post("/challenges/:id/comment", (req, res) => {
  const challenges = JSON.parse(fs.readFileSync("./challenges.json", "utf-8"));
  const challenge = challenges.find(c => c.id === req.params.id);
  if (!challenge) return res.send("Not found");

  challenge.comments.push({ user: req.session.user, text: req.body.text });
  fs.writeFileSync("./challenges.json", JSON.stringify(challenges, null, 2));
  res.redirect(`/challenges/${req.params.id}`);
});

// Guild Chat Page
app.get("/guild-chat", (req, res) => {
  if (!req.session.user) return res.redirect("/login.html");
  const userData = users[req.session.user] || {};
  const guild = userData.guild || "Fire";

  res.render("guild-chat", {
    user: req.session.user,
    guild,
    points: users[req.session.user]?.points || 0,
    role: req.session.role,
    online: totalOnline,
  });
});

// Session checker (AJAX)
app.get("/session-check", (req, res) => {
  if (req.session.user) res.sendStatus(200);
  else res.sendStatus(401);
});

// Signup - To Remove
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.send("All fields are required.");
  if (users[username]) return res.send("Username already exists.");

  const hashedPassword = await bcrypt.hash(password, 10);
  users[username] = { password: hashedPassword };
  saveUsers();

  req.session.user = username;
  res.redirect("/index");
});

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user) return res.send("Invalid username or password.");

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.send("Invalid username or password.");

  req.session.user = username;
  req.session.guild = user.guild;
  req.session.role = user.role || "user";
  res.redirect("/index");
});

function ensureLoggedIn(req, res, next) {
  if (!req.session.user) return res.redirect("/login.html");
  next();
}

function ensureAdmin(req, res, next) {
  if (!req.session.user) return res.redirect("/login.html");
  if (req.session.role !== "admin" && req.session.role !== "manager") {
    return res.status(403).send("Forbidden");
  }
  next();
}

// Admin portal (view)
app.get("/admin", ensureAdmin, (req, res) => {
  const challenges = JSON.parse(fs.readFileSync("./challenges.json", "utf-8"));
  const allUsers = users; // already in memory
  const guilds = JSON.parse(fs.readFileSync("./guilds.json", "utf-8"));
  res.render("admin", {
    user: req.session.user,
    role: req.session.role,
    guild: req.session.guild,
    online: totalOnline,
    points: users[req.session.user]?.points || 0,
    challenges,
    allUsers,
    guilds
  });
});

// Create challenge
app.post("/admin/challenges/create", ensureAdmin, (req, res) => {
  const { id, title, description } = req.body;
  if (!id || !title) return res.send("id and title are required.");

  const challenges = JSON.parse(fs.readFileSync("./challenges.json", "utf-8"));
  if (challenges.find(c => c.id === id)) return res.send("Challenge id already exists.");

  challenges.push({ id, title, description: description || "", comments: [] });
  fs.writeFileSync("./challenges.json", JSON.stringify(challenges, null, 2));
  res.redirect("/admin");
});

// Adjust user points (+/-)
app.post("/admin/users/points", ensureAdmin, (req, res) => {
  const { username, delta } = req.body;
  if (!users[username]) return res.send("No such user.");
  const d = Number(delta) || 0;
  users[username].points = (users[username].points || 0) + d;
  saveUsers();
  res.redirect("/admin");
});

// Set user role
app.post("/admin/users/role", ensureAdmin, (req, res) => {
  const { username, role } = req.body;
  if (!users[username]) return res.send("No such user.");
  users[username].role = role; // "user" | "manager" | "admin"
  saveUsers();
  res.redirect("/admin");
});

// Adjust guild total points
app.post("/admin/guilds/points", ensureAdmin, (req, res) => {
  const { guild, delta } = req.body;
  const file = "./guilds.json";
  let guilds = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : { Fire:0, Water:0, Earth:0 };
  if (!(guild in guilds)) return res.send("No such guild.");

  const d = Number(delta) || 0;
  guilds[guild] = (guilds[guild] || 0) + d;
  fs.writeFileSync(file, JSON.stringify(guilds, null, 2));
  res.redirect("/admin");
});

// Main index page
app.get("/index", (req, res) => {
  if (!req.session.user) return res.redirect("/login.html");

  const userData = users[req.session.user];
  const guild = userData?.guild || "Fire";
  const points = userData?.points || 0;

  res.render("index", {
    guild,
    points,
    user: req.session.user,
    role: req.session.role,
    online: totalOnline,
  });
});

// Leaderboard
app.get("/leaderboard", (req, res) => {
  const guildsFile = "./guilds.json";
  let guilds = { Fire: 0, Water: 0, Earth: 0 };

  if (fs.existsSync(guildsFile)) {
    guilds = JSON.parse(fs.readFileSync(guildsFile, "utf-8"));
  }

  const sortedGuilds = Object.entries(guilds)
    .sort((a, b) => b[1] - a[1])
    .map(([name, points]) => ({ name, points }));

  const userData = users[req.session.user] || {};
  const guild = userData.guild || "Fire";

  res.render("leaderboard", {
    sortedGuilds,
    user: req.session.user,
    guild,
    points: users[req.session.user]?.points || 0,
    role: req.session.role,
    online: totalOnline,
  });
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login.html");
  });
});

// Socket.IO logic
io.on("connection", (socket) => {
  const username = socket.handshake.session.user;
  if (!username) {
    socket.disconnect();
    return;
  }

  console.log(`User connected: ${username}`);
  totalOnline++;
  io.emit("updateOnline", totalOnline);



  // New guild chat system
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

// Start server
server.listen(3000, "0.0.0.0", () => {
  console.log("Server running on http://localhost:3000");
});
