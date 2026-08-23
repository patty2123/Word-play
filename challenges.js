/* Word Hunt — Challenges (async duels)
   ------------------------------------------------------------------
   Owns everything Supabase-related. game.js has no idea this module
   exists beyond two things: it calls window.WordHuntChallenges.submitResult()
   when a challenge round ends, and this module calls window.WordHuntGame's
   public methods (startSeeded, solveSeed, isReady) to actually run a round
   or regenerate a board for the trace view. Neither file reaches into the
   other's internals.

   Identity: every device gets an anonymous Supabase auth session on first
   load — no login screen, no password. That auth id becomes a row in
   `players`, labelled "Creator" (the very first ever) or "User #N" after
   that, assigned server-side by a trigger — this file never invents a label.

   Fairness: a challenge stores a SEED, never board contents. Both players'
   clients regenerate the identical board independently via the same
   mulberry32 PRNG game.js already uses for solo seeded play. See
   supabase/schema.sql for the full data model and RLS policies — those
   policies are the actual security boundary, not this client code. */

(function(){
  "use strict";

  // ---- configuration ----
  // The anon/publishable key is safe to ship in client code by design —
  // Supabase's actual security boundary is the RLS policies in schema.sql,
  // not secrecy of this key.
  var SUPABASE_URL = "https://kynpzrcezwsgpvdkahlh.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_OwqxlN6gKjEX7_jt5cm4hg_OEgAgJkb";

  var SESSION_KEY = "wordhunt-supabase-session";

  function prefGet(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
  function prefSet(k, v){ try { localStorage.setItem(k, v); } catch(e){} }

  // ---- session (hand-rolled, no SDK) ----
  // No Supabase JS SDK on purpose — this project has stayed dependency-free
  // throughout, and pulling in an SDK would also mean a CDN script the
  // service worker can't offline-cache. Supabase's auth API is plain REST,
  // so a session is just { access_token, refresh_token, expires_at, user_id }
  // read from and written straight to localStorage.

  var session = null;

  function loadSession(){
    try {
      var raw = prefGet(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch(e){ return null; }
  }

  function saveSession(s){
    session = s;
    prefSet(SESSION_KEY, JSON.stringify(s));
  }

  function authHeaders(){
    return {
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": "Bearer " + session.access_token
    };
  }

  function signInAnonymously(){
    return fetch(SUPABASE_URL + "/auth/v1/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY },
      body: JSON.stringify({})   // omitting email/phone is what triggers anonymous signup
    }).then(function(r){
      if(!r.ok) throw new Error("anonymous sign-in failed: " + r.status);
      return r.json();
    }).then(function(d){
      saveSession({
        access_token: d.access_token,
        refresh_token: d.refresh_token,
        expires_at: Date.now() + (d.expires_in - 60) * 1000,   // refresh 60s early
        user_id: d.user.id
      });
      return session;
    });
  }

  function refreshSession(){
    return fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    }).then(function(r){
      if(!r.ok) throw new Error("refresh failed: " + r.status);
      return r.json();
    }).then(function(d){
      saveSession({
        access_token: d.access_token,
        refresh_token: d.refresh_token,
        expires_at: Date.now() + (d.expires_in - 60) * 1000,
        user_id: d.user.id
      });
      return session;
    });
  }

  // Every entry point calls this first. Reuses a still-valid session, quietly
  // refreshes an expired one, and only creates a brand-new anonymous identity
  // if neither is possible — that's what keeps a player's label and history
  // stable across visits instead of minting a new "User #N" every time.
  function ensureSession(){
    session = session || loadSession();
    if(session && Date.now() < session.expires_at) return Promise.resolve(session);
    if(session && session.refresh_token){
      return refreshSession().catch(function(){ return signInAnonymously(); });
    }
    return signInAnonymously();
  }

  // ---- REST helpers (PostgREST) ----

  function rest(path, opts){
    opts = opts || {};
    var headers = authHeaders();
    headers["Content-Type"] = "application/json";
    if(opts.prefer) headers["Prefer"] = opts.prefer;
    return fetch(SUPABASE_URL + "/rest/v1" + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function(r){
      if(!r.ok) return r.text().then(function(t){ throw new Error("REST " + r.status + ": " + t); });
      var len = r.headers.get("content-length");
      if(len === "0") return null;
      return r.json().catch(function(){ return null; });
    });
  }

  // ---- player bootstrap ----

  var REGISTERED_KEY = "wordhunt-player-registered";
  var myLabel = null;

  function ensurePlayerRow(){
    if(prefGet(REGISTERED_KEY)){
      return rest("/players?id=eq." + session.user_id + "&select=label").then(function(rows){
        myLabel = rows && rows[0] ? rows[0].label : null;
      });
    }
    // Insert-then-read: RLS only allows inserting a row where id = auth.uid(),
    // so this can never claim someone else's identity even if called twice.
    return rest("/players", {
      method: "POST",
      prefer: "return=representation",
      body: { id: session.user_id }
    }).then(function(rows){
      myLabel = rows && rows[0] ? rows[0].label : null;
      prefSet(REGISTERED_KEY, "1");
    }).catch(function(){
      // Row already existed (e.g. localStorage was cleared but the account
      // wasn't) — fall back to reading it instead of treating this as fatal.
      return rest("/players?id=eq." + session.user_id + "&select=label").then(function(rows){
        myLabel = rows && rows[0] ? rows[0].label : null;
        prefSet(REGISTERED_KEY, "1");
      });
    });
  }

  function labelFor(id, playersById){
    var p = playersById[id];
    return p ? p.label : "Unknown player";
  }

  // ---- DOM ----

  var $ = function(id){ return document.getElementById(id); };
  var chBtn, chOpen, chOverlay, chCloseX, chList, chNewBtn, chStatus;
  var chDetailOverlay, chDetailClose, chDetailBody;

  function ready(){
    chBtn = $("challenge-btn-ready");
    chOpen = $("challenge-open");
    chOverlay = $("challenge-overlay");
    chCloseX = $("challenge-close-x");
    chList = $("challenge-list");
    chNewBtn = $("challenge-new-btn");
    chStatus = $("challenge-status");
    chDetailOverlay = $("challenge-detail-overlay");
    chDetailClose = $("challenge-detail-close");
    chDetailBody = $("challenge-detail-body");
    wire();
  }

  // A separate class from game.js's own "modal-open", not the same one —
  // if both modules toggled one shared class independently, whichever
  // closed last would win and could clobber the other's lock. Matching both
  // class names in CSS (see style.css) sidesteps that coordination problem
  // entirely: each module only ever touches its own class.
  function syncChalLock(){
    var anyOpen = !chOverlay.hidden || !chDetailOverlay.hidden;
    document.body.classList.toggle("chal-modal-open", anyOpen);
  }

  function openChallenges(){
    chOverlay.hidden = false;
    syncChalLock();
    ensureSession().then(ensurePlayerRow).then(function(){
      chStatus.textContent = myLabel ? ("Playing as " + myLabel) : "";
      refreshList();
    }).catch(function(err){
      chStatus.textContent = "Couldn't connect — check your connection and reopen.";
    });
  }

  function closeChallenges(){
    chOverlay.hidden = true;
    syncChalLock();
  }

  function closeDetail(){
    chDetailOverlay.hidden = true;
    syncChalLock();
  }

  function wire(){
    chOpen.addEventListener("click", openChallenges);
    chBtn.addEventListener("click", openChallenges);
    chCloseX.addEventListener("click", closeChallenges);
    chOverlay.addEventListener("click", function(e){ if(e.target === chOverlay) closeChallenges(); });

    chDetailClose.addEventListener("click", closeDetail);
    chDetailOverlay.addEventListener("click", function(e){ if(e.target === chDetailOverlay) closeDetail(); });

    chNewBtn.addEventListener("click", function(){
      if(!window.WordHuntGame || !window.WordHuntGame.isReady()){
        chStatus.textContent = "Still loading the dictionary — try again in a second.";
        return;
      }
      // A real random seed — this does NOT need to be seeded itself, it just
      // needs to be unpredictable. crypto avoids Math.random's low bits being
      // somewhat weaker, though for a word game either would be plenty.
      var seed = (crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0;
      chOverlay.hidden = true;   // step out of the way, the round takes over the screen
      window.WordHuntGame.startSeeded(seed, "challenge-create", null);
    });
  }

  // ---- listing ----

  function refreshList(){
    chList.innerHTML = '<p class="empty-hint">Loading…</p>';
    Promise.all([
      rest("/challenges?select=*&order=created_at.desc&limit=100"),
      rest("/players?select=id,label")
    ]).then(function(res){
      var challenges = res[0] || [], players = res[1] || [];
      var byId = {};
      players.forEach(function(p){ byId[p.id] = p; });
      renderList(challenges, byId);
    }).catch(function(){
      chList.innerHTML = '<p class="empty-hint">Couldn’t load challenges. Check your connection.</p>';
    });
  }

  function renderList(challenges, byId){
    var mine = session.user_id;
    var openFromOthers = challenges.filter(function(c){ return c.status === "open" && c.creator_id !== mine; });
    var myOwn = challenges.filter(function(c){ return c.creator_id === mine; });
    var iPlayed = challenges.filter(function(c){ return c.opponent_id === mine; });

    var html = "";

    html += '<h3 class="ach-cat">Open challenges <span class="ach-cat-count">' + openFromOthers.length + '</span></h3>';
    if(!openFromOthers.length){
      html += '<p class="empty-hint">No open challenges from other players right now.</p>';
    } else {
      openFromOthers.forEach(function(c){
        html += challengeRow({
          title: "From " + labelFor(c.creator_id, byId),
          potential: c.potential,
          action: '<button type="button" class="btn ghost play-challenge-btn" data-id="' + c.id + '">Play</button>'
        });
      });
    }

    html += '<h3 class="ach-cat">Challenges you sent <span class="ach-cat-count">' + myOwn.length + '</span></h3>';
    if(!myOwn.length){
      html += '<p class="empty-hint">You haven’t sent any challenges yet.</p>';
    } else {
      myOwn.forEach(function(c){
        var icon = "⏳", note = "Waiting for someone to play…", clickable = false;
        if(c.status === "completed"){
          clickable = true;
          if(c.opponent_score > c.creator_score){ icon = "❌"; note = labelFor(c.opponent_id, byId) + " won, " + c.opponent_score.toLocaleString() + "–" + c.creator_score.toLocaleString(); }
          else if(c.opponent_score < c.creator_score){ icon = "🏆"; note = "You won, " + c.creator_score.toLocaleString() + "–" + c.opponent_score.toLocaleString(); }
          else { icon = "🤝"; note = "Tied, " + c.creator_score.toLocaleString() + " each"; }
        }
        html += challengeRow({
          title: icon + " " + note,
          potential: c.potential,
          action: clickable ? '<button type="button" class="btn ghost view-challenge-btn" data-id="' + c.id + '">View</button>' : ""
        });
      });
    }

    html += '<h3 class="ach-cat">Challenges you played <span class="ach-cat-count">' + iPlayed.length + '</span></h3>';
    if(!iPlayed.length){
      html += '<p class="empty-hint">You haven’t played anyone’s challenge yet.</p>';
    } else {
      iPlayed.forEach(function(c){
        var icon, note;
        if(c.opponent_score > c.creator_score){ icon = "🏆"; note = "You won, " + c.opponent_score.toLocaleString() + "–" + c.creator_score.toLocaleString(); }
        else if(c.opponent_score < c.creator_score){ icon = "❌"; note = labelFor(c.creator_id, byId) + " won, " + c.creator_score.toLocaleString() + "–" + c.opponent_score.toLocaleString(); }
        else { icon = "🤝"; note = "Tied, " + c.opponent_score.toLocaleString() + " each"; }
        html += challengeRow({
          title: icon + " vs " + labelFor(c.creator_id, byId) + " — " + note,
          potential: c.potential,
          action: '<button type="button" class="btn ghost view-challenge-btn" data-id="' + c.id + '">View</button>'
        });
      });
    }

    chList.innerHTML = html;
    var byIdRef = byId;

    chList.querySelectorAll(".play-challenge-btn").forEach(function(btn){
      btn.addEventListener("click", function(){ playChallenge(btn.dataset.id, challenges); });
    });
    chList.querySelectorAll(".view-challenge-btn").forEach(function(btn){
      btn.addEventListener("click", function(){ viewChallenge(btn.dataset.id, challenges, byIdRef); });
    });
  }

  function challengeRow(opts){
    return '<div class="ach-row challenge-row">' +
      '<span class="ach-label">' + opts.title + '</span>' +
      '<span class="ach-progress" style="cursor:default">' + opts.potential.toLocaleString() + ' pts</span>' +
      opts.action +
      '</div>';
  }

  // ---- playing ----

  function playChallenge(id, challenges){
    var c = challenges.filter(function(x){ return x.id === id; })[0];
    if(!c) return;
    if(!window.WordHuntGame || !window.WordHuntGame.isReady()){
      chStatus.textContent = "Still loading the dictionary — try again in a second.";
      return;
    }
    chOverlay.hidden = true;
    window.WordHuntGame.startSeeded(Number(c.seed), "challenge-play", c.id);
  }

  // ---- submission (called by game.js at end of a challenge round) ----

  function submitResult(result){
    ensureSession().then(function(){
      if(result.mode === "challenge-create"){
        return rest("/challenges", {
          method: "POST",
          body: {
            creator_id: session.user_id,
            seed: result.seed,
            potential: result.potential,
            creator_score: result.score,
            creator_words: result.words
          }
        });
      }
      if(result.mode === "challenge-play"){
        return rest("/challenges?id=eq." + result.challengeId, {
          method: "PATCH",
          prefer: "return=minimal",
          body: {
            opponent_id: session.user_id,
            opponent_score: result.score,
            opponent_words: result.words,
            status: "completed",
            completed_at: new Date().toISOString()
          }
        });
      }
    }).catch(function(err){
      // The round already scored and shows normally either way — a failed
      // submission means "this one didn't post," not "the round didn't count."
      console.error("Challenge submission failed:", err);
    });
  }

  // ---- detail / trace view ----

  function viewChallenge(id, challenges, byId){
    var c = challenges.filter(function(x){ return x.id === id; })[0];
    if(!c) return;

    var board = window.WordHuntGame && window.WordHuntGame.solveSeed(Number(c.seed));
    if(!board){ chStatus.textContent = "Couldn't load that board."; return; }

    renderDetail(c, board, byId);
    chDetailOverlay.hidden = false;
    syncChalLock();
  }

  // Minimal, non-interactive board — letters plus an SVG trail, no drag
  // input. Geometry mirrors game.js's 5x5 formula exactly (GAP=3.2, and
  // every challenge board is 5x5 by construction, so no size branching
  // is needed here).
  function buildStaticBoard(cells){
    var GAP = 3.2, SIZE = 5;
    var tile = (100 - GAP * (SIZE - 1)) / SIZE, off = tile / 2, step = tile + GAP;
    function center(i){ return { x: (i % SIZE) * step + off, y: Math.floor(i / SIZE) * step + off }; }

    var wrap = document.createElement("div");
    wrap.className = "board-stage";
    var grid = document.createElement("div");
    grid.className = "board size-5 static-board";
    grid.style.gap = GAP + "%";
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    var line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("stroke-width", (tile * 0.14).toFixed(2));
    line.setAttribute("class", "static-trail-line");
    svg.appendChild(line);

    var tiles = [];
    for(var i = 0; i < 25; i++){
      var t = document.createElement("div");
      t.className = "tile";
      t.textContent = cells[i].toUpperCase();
      grid.appendChild(t);
      tiles.push(t);
    }
    wrap.appendChild(grid);
    wrap.appendChild(svg);

    return {
      el: wrap,
      trace: function(path){
        tiles.forEach(function(t){ t.classList.remove("trace"); });
        if(!path){ line.setAttribute("points", ""); return; }
        var pts = path.map(function(i){ var c = center(i); return c.x + "," + c.y; });
        line.setAttribute("points", pts.join(" "));
        path.forEach(function(i){ tiles[i].classList.add("trace"); });
      }
    };
  }

  function wordChips(words, sol, boardCtl){
    var wrap = document.createElement("div");
    wrap.className = "chips";
    if(!words.length){
      var p = document.createElement("p");
      p.className = "empty-hint";
      p.textContent = "No words found.";
      wrap.appendChild(p);
      return wrap;
    }
    words.slice().sort(function(a,b){ return b.length - a.length || (a<b?-1:a>b?1:0); }).forEach(function(w){
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      var entry = sol.get(w);
      chip.textContent = w.toUpperCase();
      chip.addEventListener("click", function(){
        boardCtl.trace(entry ? entry.path : null);
      });
      wrap.appendChild(chip);
    });
    return wrap;
  }

  function renderDetail(c, board, byId){
    chDetailBody.innerHTML = "";

    var boardCtl = buildStaticBoard(board.cells);
    chDetailBody.appendChild(boardCtl.el);

    var summary = document.createElement("div");
    summary.className = "final-row";
    summary.innerHTML =
      '<div class="final-cell"><span class="k">' + labelFor(c.creator_id, byId) + '</span><span class="v">' + c.creator_score.toLocaleString() + '</span></div>' +
      (c.status === "completed"
        ? '<div class="final-cell"><span class="k">' + labelFor(c.opponent_id, byId) + '</span><span class="v">' + c.opponent_score.toLocaleString() + '</span></div>'
        : '<div class="final-cell"><span class="k">Opponent</span><span class="v">—</span></div>') +
      '<div class="final-cell"><span class="k">Potential</span><span class="v">' + c.potential.toLocaleString() + '</span></div>';
    chDetailBody.appendChild(summary);

    var h1 = document.createElement("h3");
    h1.className = "ach-cat";
    h1.textContent = labelFor(c.creator_id, byId) + "’s words";
    chDetailBody.appendChild(h1);
    chDetailBody.appendChild(wordChips(c.creator_words || [], board.sol, boardCtl));

    if(c.status === "completed"){
      var h2 = document.createElement("h3");
      h2.className = "ach-cat";
      h2.textContent = labelFor(c.opponent_id, byId) + "’s words";
      chDetailBody.appendChild(h2);
      chDetailBody.appendChild(wordChips(c.opponent_words || [], board.sol, boardCtl));
    }
  }

  window.WordHuntChallenges = { submitResult: submitResult };

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", ready);
  } else {
    ready();
  }

})();
