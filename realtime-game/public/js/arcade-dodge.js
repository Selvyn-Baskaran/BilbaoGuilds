(() => {
  const canvas = document.getElementById("gameCanvas");
  const ctx = canvas.getContext("2d");
  const startBtn = document.getElementById("startBtn");
  const retryBtn = document.getElementById("retryBtn");
  const scoreNow = document.getElementById("scoreNow");
  const bestMineVal = document.getElementById("bestMineVal");

  // ---------- IMAGES (optional) ----------
  const playerImg = new Image();
  playerImg.src = "/img/felix.png"; // 64x64-ish PNG; fallback draws a square if missing

  // ---------- STATE ----------
  let running = false, over = false;
  let last = 0, t0 = 0;

  let player, keys, score, hueBase;
  let blocks, coins, particles;
  let dashCD, dashActive, dashTimerMs, shield, shieldTimerMs, shake;

  let shownHint = false;   // hide “Press Space to dash” after first dash
  let lastGapCol = null;   // for wall patterns
  let lastPattern = -1;    // avoid repeating walls
  let wallCooldownMs = 0;  // cooldown before next wall wave

  // spawn accumulators (ms)
  let accPattern = 0, accDrip = 0, accCoin = 0, accShield = 0;

  // ---------- TUNING ----------
  const CFG = {
    // slower difficulty curve
    baseFall: 145,
    // spawn pacing (slower ramp)
    dripBase: 900,       // ms
    dripMin: 210,
    patternEvery: 2600,  // ms
    coinEvery: 1600,     // ms
    shieldEvery: 7000,   // ms

    // abilities
    dashCDms: 1800,
    dashTimeMs: 350,         // invulnerability window
    dashSpeedMul: 2.25,
    shieldTimeMs: 6500,

    // scoring
    coinValue: 35,

    // gaps
    gapColsMin: 1,
    gapColsMax: 2,
    minGapPx: 48,            // >= player width + margin

    // pattern cooldowns
    wallCooldownAfterUse: 2600, // ms block another wall

    // VFX
    dashTrailPerFrame: 10,     // particle count
    dashBurstAmount: 20
  };

  // ---------- CURVES ----------
  // Very gentle ramp: base + A*log(1+t*k) + B*sqrt(t)
  function fallSpeed(ts) {
    return CFG.baseFall + 60 * Math.log1p(ts * 0.45) + 16 * Math.sqrt(ts);
  }
  function dripInterval(ts, score) {
    // Larger intervals that shrink slowly
    const reduce = 90 * Math.log1p(ts * 0.35) + 20 * Math.sqrt(ts) + score * 0.20;
    return Math.max(CFG.dripMin, CFG.dripBase - reduce);
  }

  // ---------- SETUP / RESET ----------
  function reset() {
    const w = 32, h = 32;
    player = { x: canvas.width/2 - w/2, y: canvas.height - 54, w, h, spd: 335 };

    keys = {};
    score = 0;
    hueBase = 260;

    blocks = [];
    coins = [];
    particles = [];

    dashCD = 0; dashActive = false; dashTimerMs = 0;
    shield = false; shieldTimerMs = 0;
    shake = 0;

    accPattern = 0; accDrip = 0; accCoin = 0; accShield = 0;

    lastGapCol = null;
    lastPattern = -1;
    wallCooldownMs = 0;

    t0 = last = performance.now();
    over = false;
  }

  // ---------- UTILS ----------
  const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
  const rnd = (a,b)=>a+Math.random()*(b-a);

  function rectRect(a,b){
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }
  function rectCircle(rect,c){
    const cx = clamp(c.x+c.r, rect.x, rect.x+rect.w);
    const cy = clamp(c.y+c.r, rect.y, rect.y+rect.h);
    const dx = (c.x+c.r)-cx, dy = (c.y+c.r)-cy;
    return dx*dx+dy*dy <= c.r*c.r;
  }

  function addBurst(x,y,h,amount=12){
    for(let i=0;i<amount;i++){
      const a = Math.random()*Math.PI*2;
      const s = rnd(110,260);
      particles.push({
        x, y, vx: Math.cos(a)*s, vy: Math.sin(a)*s,
        life: rnd(.28,.6), age: 0, color: `hsl(${h}, 95%, 65%)`
      });
    }
  }
  function addTrail(x,y,h,count){
    for(let i=0;i<count;i++){
      particles.push({
        x: x + rnd(-3,3), y: y + rnd(-3,3),
        vx: rnd(-60,60), vy: rnd(-20,10),
        life: rnd(.22,.4), age: 0,
        color: `hsl(${h}, 90%, 72%)`
      });
    }
  }

  // ---------- SPAWNING ----------
  function spawnBlock(x,y,w,h,vy){
    blocks.push({
      x,y,w,h, vy,
      hue: (hueBase + Math.floor(Math.random()*60))%360
    });
  }
  function spawnCoin(x,y,vy,type=null){
    const r = type==="shield" ? 11 : rnd(8,11);
    coins.push({ x,y,r, vy, type, hue: type==="shield" ? 200 : 48 });
  }

  // patterns with guaranteed gaps; walls cannot chain and gaps stay reasonable
  function patternSpawn(ts) {
    const fall = fallSpeed(ts);

    // choose a pattern (avoid repeating wall and respect cooldown)
    let pat;
    const WALL = 2;
    const options = wallCooldownMs > 0 || lastPattern === WALL ? [0,1,3] : [0,1,2,3];
    pat = options[Math.floor(Math.random()*options.length)];

    const cols = 6 + Math.floor(Math.min(6, ts/7)); // small growth
    const laneW = canvas.width / cols;

    if (pat === 0) {
      // lane rain — a few columns get a block
      const n = 1 + Math.floor(Math.random()*2); // fewer to reduce clutter
      for (let i=0;i<n;i++){
        const col = Math.floor(Math.random()*cols);
        const w = Math.max(18, Math.min(laneW-10, rnd(22,44)));
        spawnBlock(col*laneW + rnd(0, laneW-w), -40, w, rnd(18,24), fall);
      }
    } else if (pat === 1) {
      // staggered tiles — every other lane, but not all rows filled
      const w = Math.max(16, Math.min(laneW-8, rnd(22,32)));
      for(let col=0; col<cols; col+=2){
        if (Math.random() < 0.2) continue; // leave extra holes
        spawnBlock(col*laneW + rnd(0,laneW-w), -40, w, rnd(16,22), fall*0.95);
      }
    } else if (pat === 2) {
      // wall with GAP — ensure min pixel gap; prevent repeating same gap
      const gapSpan = Math.floor(rnd(CFG.gapColsMin, CFG.gapColsMax+1)); // 1..2
      let gap = Math.floor(Math.random()*(cols-gapSpan));
      if (lastGapCol !== null && Math.abs(gap - lastGapCol) < 1) {
        gap = clamp(gap + (Math.random()<0.5?-1:+1), 0, cols-gapSpan);
      }
      lastGapCol = gap;

      for (let col=0; col<cols; col++){
        if (col >= gap && col < gap + gapSpan) continue; // guaranteed gap region
        const w = Math.max(16, laneW-6);
        spawnBlock(col*laneW, -40, w, rnd(16,24), fall*1.02);
      }

      // ensure min pixel gap
      const pxGap = laneW * gapSpan;
      if (pxGap < CFG.minGapPx) {
        const removeCol = (gap>0 ? gap-1 : gap+gapSpan);
        for (let i = blocks.length-1; i >= 0; i--) {
          const b = blocks[i];
          if (b.y < -30 && b.x >= removeCol*laneW && b.x < (removeCol+1)*laneW) {
            blocks.splice(i,1);
            break;
          }
        }
      }

      // start cooldown so walls don't chain
      wallCooldownMs = CFG.wallCooldownAfterUse;
    } else {
      // fat chunk
      const w = rnd(46,76), h = rnd(24,32);
      spawnBlock(rnd(0,canvas.width-w), -48, w, h, fall*0.92);
    }

    lastPattern = pat;
  }

  function dripSpawn(ts) {
    // single random block
    const fall = fallSpeed(ts);
    spawnBlock(rnd(0, canvas.width-40), -30, rnd(22,38), rnd(16,26), fall);
  }

  // ---------- LOOP ----------
  function loop(now) {
    if (!running) return;
    const dt = (now - last) / 1000; // seconds
    last = now;

    const ts = (now - t0) / 1000;   // seconds since start
    hueBase = 220 + (score/14)%140;

    // timers
    if (dashCD > 0) dashCD = Math.max(0, dashCD - (dt*1000));
    if (dashActive) { dashTimerMs -= (dt*1000); if (dashTimerMs <= 0) dashActive = false; }
    if (shield) { shieldTimerMs -= (dt*1000); if (shieldTimerMs <= 0) shield = false; }
    if (wallCooldownMs > 0) wallCooldownMs = Math.max(0, wallCooldownMs - dt*1000);
    if (shake > 0) shake = Math.max(0, shake - dt*8);

    // score — slow constant
    score += dt * 10.5;
    scoreNow.textContent = "Score: " + Math.floor(score);

    // input
    let mv = 0;
    if (keys["ArrowLeft"] || keys["a"]) mv -= 1;
    if (keys["ArrowRight"] || keys["d"]) mv += 1;
    const speed = player.spd * (dashActive ? CFG.dashSpeedMul : 1.0);
    player.x = clamp(player.x + mv*speed*dt, 0, canvas.width - player.w);

    // dash
    if ((keys[" "] || keys["Space"]) && dashCD === 0 && !dashActive) {
      dashActive = true;
      dashTimerMs = CFG.dashTimeMs;
      dashCD = CFG.dashCDms;
      shownHint = true;
      shake = Math.max(shake, .45);
      addBurst(player.x+player.w/2, player.y+player.h/2, hueBase, CFG.dashBurstAmount);
    }

    // ---- accumulators (robust spawns) ----
    const dripEvery = dripInterval(ts, score);
    accDrip += dt*1000;
    while (accDrip >= dripEvery) { dripSpawn(ts); accDrip -= dripEvery; }

    accPattern += dt*1000;
    while (accPattern >= CFG.patternEvery) { patternSpawn(ts); accPattern -= CFG.patternEvery; }

    accCoin += dt*1000;
    while (accCoin >= CFG.coinEvery) {
      const fall = fallSpeed(ts)*0.9;
      spawnCoin(rnd(12, canvas.width-24), -18, fall);
      accCoin -= CFG.coinEvery;
    }

    accShield += dt*1000;
    while (accShield >= CFG.shieldEvery) {
      if (!shield) {
        const fall = fallSpeed(ts)*0.85;
        spawnCoin(rnd(14, canvas.width-28), -20, fall, "shield");
      }
      accShield -= CFG.shieldEvery;
    }

    // update entities
    blocks.forEach(b => { b.y += b.vy * dt; });
    coins.forEach(c => { c.y += c.vy * dt; });
    particles.forEach(p => { p.age += dt; p.x += p.vx*dt; p.y += p.vy*dt; });

    blocks = blocks.filter(b => b.y < canvas.height + 64);
    coins = coins.filter(c => c.y < canvas.height + 64);
    particles = particles.filter(p => p.age < p.life);

    // dash trail (beefier, clearer)
    if (dashActive) {
      addTrail(player.x+player.w/2, player.y+player.h/2, hueBase, CFG.dashTrailPerFrame);
    }

    // coin collisions
    coins = coins.filter(c => {
      if (rectCircle(player, c)) {
        if (c.type==="shield") {
          shield = true; shieldTimerMs = CFG.shieldTimeMs;
          addBurst(player.x+player.w/2, player.y, 200, 26);
          shake = Math.max(shake, .5);
        } else {
          score += CFG.coinValue;
          addBurst(c.x+c.r, c.y+c.r, 48, 12);
        }
        return false;
      }
      return true;
    });

    // block collisions — dash is fully invulnerable; shield absorbs and deletes the block
    for (let i=0; i<blocks.length; i++) {
      const b = blocks[i];
      if (rectRect(player, b)) {
        if (dashActive) continue;
        if (shield) {
          shield = false;
          addBurst(player.x+player.w/2, player.y, 200, 34); // bigger effect
          shake = 0.9; // stronger shake on shield break
          blocks.splice(i,1);
          i--;
          continue;
        }
        return gameOver();
      }
    }

    draw();
    requestAnimationFrame(loop);
  }

  // ---------- DRAW ----------
  function drawBG() {
    const g = ctx.createLinearGradient(0,0,0,canvas.height);
    g.addColorStop(0, `hsl(${(hueBase+40)%360}, 55%, 10%)`);
    g.addColorStop(1, `hsl(${(hueBase+300)%360}, 55%, 6%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0,0,canvas.width,canvas.height);
  }

  function drawPlayer() {
    // dash “ghost” blur to make dash obvious
    if (dashActive) {
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = `hsl(${hueBase}, 100%, 70%)`;
      ctx.fillRect(player.x-6, player.y-4, player.w+12, player.h+8);
      ctx.restore();
    }

    if (playerImg.complete && playerImg.naturalWidth) {
      ctx.save();
      if (dashActive) ctx.globalAlpha = 0.88;
      const pad = 4;
      ctx.drawImage(playerImg, player.x-pad, player.y-pad, player.w+pad*2, player.h+pad*2);
      ctx.restore();
    } else {
      ctx.fillStyle = dashActive ? "#9c7cff" : "#6e38ff";
      ctx.fillRect(player.x, player.y, player.w, player.h);
    }
    if (shield) {
      ctx.strokeStyle = "rgba(100,180,255,0.9)";
      ctx.lineWidth = 3;
      ctx.strokeRect(player.x-4, player.y-4, player.w+8, player.h+8);
    }
  }

  function drawBlocks() {
    for (const b of blocks) {
      const grad = ctx.createLinearGradient(b.x, b.y, b.x+b.w, b.y+b.h);
      grad.addColorStop(0, `hsl(${b.hue}, 22%, 82%)`);
      grad.addColorStop(1, `hsl(${(b.hue+16)%360}, 20%, 72%)`);
      ctx.fillStyle = grad;
      ctx.strokeStyle = `hsl(${b.hue}, 18%, 55%)`;
      ctx.lineWidth = 2;

      roundRect(ctx, b.x, b.y, b.w, b.h, 6);
      ctx.fill();
      ctx.stroke();
    }
  }

  function drawCoins() {
    for (const c of coins) {
      ctx.beginPath();
      ctx.fillStyle = c.type==="shield" ? "hsl(200, 90%, 60%)" : "hsl(48, 100%, 60%)";
      ctx.arc(c.x+c.r, c.y+c.r, c.r, 0, Math.PI*2);
      ctx.fill();
    }
  }

  function drawParticles() {
    for (const p of particles) {
      const a = 1 - p.age/p.life;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, 2, 2);
      ctx.globalAlpha = 1;
    }
  }

  function drawHUD() {
    // top-right HUD (no multiplier)
    ctx.save();
    ctx.font = "15px system-ui, Segoe UI, Roboto, Arial";
    ctx.textAlign = "right";
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = "#fff";
    ctx.fillText(`Score: ${Math.floor(score)}`, canvas.width - 12, 22);
    ctx.fillText(`Dash: ${dashCD>0 ? (dashCD/1000).toFixed(1)+'s' : 'Ready'}`, canvas.width - 12, 42);
    if (shield) ctx.fillText(`Shield: ${(shieldTimerMs/1000|0)}s`, canvas.width - 12, 62);
    ctx.globalAlpha = 1;

    // hint
    if (!shownHint) {
      ctx.textAlign = "left";
      ctx.globalAlpha = 0.9;
      ctx.fillText("Press Space to dash", 12, 24);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function drawOverlayGameOver() {
    if (!over) return;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0,0,canvas.width,canvas.height);

    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.font = "bold 28px system-ui, Segoe UI, Roboto, Arial";
    ctx.fillText("Game Over", canvas.width/2, canvas.height/2 - 6);

    ctx.font = "16px system-ui, Segoe UI, Roboto, Arial";
    ctx.fillText("Click Retry to try again", canvas.width/2, canvas.height/2 + 20);
    ctx.restore();
  }

  function draw() {
    // screen shake
    const ox = (Math.random()*2-1)*shake*9;
    const oy = (Math.random()*2-1)*shake*9;

    ctx.save();
    ctx.translate(ox, oy);

    drawBG();
    drawBlocks();
    drawCoins();
    drawParticles();
    drawPlayer();
    ctx.restore();

    drawHUD();
    drawOverlayGameOver();
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x+rr, y);
    ctx.arcTo(x+w, y, x+w, y+h, rr);
    ctx.arcTo(x+w, y+h, x, y+h, rr);
    ctx.arcTo(x, y+h, x, y, rr);
    ctx.arcTo(x, y, x+w, y, rr);
    ctx.closePath();
  }

  // ---------- GAME OVER ----------
  async function gameOver() {
    running = false; over = true;
    startBtn.disabled = false;
    retryBtn.disabled = false;
    const finalScore = Math.floor(score);

    try {
      const res = await fetch("/api/arcade/score", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ score: finalScore })
      });
      const data = await res.json();
      if (data.ok) bestMineVal.textContent = data.best;
    } catch (e) {
      console.error("score submit failed", e);
    }
  }

  // ---------- INPUT / HOOKS ----------
  startBtn.addEventListener("click", () => {
    if (running) return;
    startBtn.disabled = true; retryBtn.disabled = true;
    reset(); running = true; requestAnimationFrame(loop);
  });
  retryBtn.addEventListener("click", () => {
    if (running) return;
    startBtn.disabled = true; retryBtn.disabled = true;
    reset(); running = true; requestAnimationFrame(loop);
  });

  window.addEventListener("keydown", e => { keys[e.key] = true; });
  window.addEventListener("keyup", e => { keys[e.key] = false; });
})();
