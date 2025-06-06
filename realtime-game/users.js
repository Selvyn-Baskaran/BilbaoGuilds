// users.js
const bcrypt = require("bcrypt");
const users = {};

async function register(username, password) {
  if (users[username]) throw new Error("User already exists");
  const hashed = await bcrypt.hash(password, 10);
  users[username] = { password: hashed };
}

async function authenticate(username, password) {
  const user = users[username];
  if (!user) return false;
  return await bcrypt.compare(password, user.password);
}

module.exports = { register, authenticate, users };
