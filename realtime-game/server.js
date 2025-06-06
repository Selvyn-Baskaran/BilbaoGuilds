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

app.set("view engine", "ejs");


// JSON user storage
const USERS_FILE = "./users.json";
let users = {};
if (fs.existsSync(USERS_FILE)) {
  users = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
}

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Session middleware
const sessionMiddleware = session({
  secret: "replace-this-with-a-strong-secret",
  resave: false,
  saveUninitialized: false,
});

app.use(express.static("public", { index: "login.html" }));
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);
io.use(sharedSession(sessionMiddleware, { autoSave: true }));

// Redirect root to signup or index
app.get("/", (req, res) => {
  if (req.session.user) {
    res.redirect("/index");
  } else {
    res.redirect("/signup.html");
  }
});

// Check if session exists
app.get("/session-check", (req, res) => {
  if (req.session.user) res.sendStatus(200);
  else res.sendStatus(401);
});

// Signup route (with guild)
app.post("/signup", async (req, res) => {
  const { username, password} = req.body;
  if (!username || !password ) return res.send("All fields are required.");
  if (users[username]) return res.send("Username already exists.");

  const hashedPassword = await bcrypt.hash(password, 10);
  users[username] = { password: hashedPassword };
  saveUsers();

  req.session.user = username;
  //req.session.guild = guild;
  res.redirect("/index");
});

// Login route
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user) return res.send("Invalid username or password.");
  
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.send("Invalid username or password.");

  req.session.user = username;
  req.session.guild = user.guild;
  res.redirect("/index");
});

app.get("/index", (req, res) => {
  if (!req.session.user) return res.redirect("/login.html");

  const userData = users[req.session.user];
  const guild = userData?.guild || "Fire"; // fallback to Fire
  points = userData?.points || 0; // fall back points to 0

  res.render("index", {
  guild,
  points,
  user: req.session.user
});
 
});

// Leaderboard Route
app.get("/leaderboard", (req, res) => {
  const guildsFile = "./guilds.json";
  let guilds = { Fire: 0, Water: 0, Earth: 0 };

  if (fs.existsSync(guildsFile)) {
    guilds = JSON.parse(fs.readFileSync(guildsFile, "utf-8"));
  }

  // Sort guilds by points descending
  const sortedGuilds = Object.entries(guilds)
    .sort((a, b) => b[1] - a[1])
    .map(([name, points]) => ({ name, points }));

  const userData = users[req.session.user] || {};
  const guild = userData.guild || "Fire"; // 🔥 get user guild

  res.render("leaderboard", {
    sortedGuilds,
    user: req.session.user,
    guild // 🟢 pass it to the template
  });
});



// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login.html");
  });
});

// Socket.IO events
io.on("connection", (socket) => {
  const username = socket.handshake.session.user;
  if (!username) {
    socket.disconnect();
    return;
  }

  console.log(`User connected: ${username}`);

  socket.on("joinRoom", (room) => {
    socket.join(room);
    socket.to(room).emit("message", `${username} joined the room`);
  });

  socket.on("sendMessage", ({ room, message }) => {
    io.to(room).emit("message", `${username}: ${message}`);
  });

  socket.on("disconnect", () => {
    console.log(`${username} disconnected`);
  });
});

// Start server
server.listen(3000, "0.0.0.0", () => {
  console.log("Server running on http://localhost:3000");
});
