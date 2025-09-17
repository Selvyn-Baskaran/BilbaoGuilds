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

// EJS view engine
app.set("view engine", "ejs");

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

// Passport setup
app.use(passport.initialize());
app.use(passport.session());

// Configure Microsoft Azure AD strategy
passport.use(
  new OIDCStrategy(
    {
      identityMetadata:
        "https://login.microsoftonline.com/2fd4305e-4a8d-40ff-a0d2-e92381196e1a/v2.0/.well-known/openid-configuration",
      clientID: "5418c944-d78f-485b-bbde-45b77a4110e6",
      responseType: "code",
      responseMode: "form_post",
      redirectUrl: "http://localhost:3000/auth/microsoft/callback",
      allowHttpForRedirectUrl: true,
      clientSecret: "xeR8Q~zuitUbPsXPG.ZfImBoWyvpKkd5y6S-McyW",
      validateIssuer: true,
      scope: ["profile", "email", "openid"],
    },
    function (iss, sub, profile, accessToken, refreshToken, done) {
      return done(null, profile);
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Online count
let totalOnline = 0;

// Routes
app.get("/", (req, res) => {
  res.redirect("/login.html");
});

// Microsoft login start
app.get("/auth/microsoft", passport.authenticate("azuread-openidconnect"));

// Microsoft login callback
app.post(
  "/auth/microsoft/callback",
  passport.authenticate("azuread-openidconnect", { failureRedirect: "/" }),
  (req, res) => {
    req.session.user = req.user.displayName;
    req.session.email = req.user._json.preferred_username;
    req.session.role = "user"; // default role
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

// Main index page
app.get("/index", ensureLoggedIn, (req, res) => {
  res.render("index", {
    guild: req.session.guild || "Fire",
    points: 0,
    user: req.session.user,
    role: req.session.role,
    online: totalOnline,
  });
});

// Logout
app.get("/logout", (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.redirect("/login.html");
    });
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