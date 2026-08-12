/* Word Hunt 5x5 — game logic
   Input runs on Pointer Events, so the same code path serves a mouse drag
   and a finger drag with no branching. */

(function(){
  "use strict";

  var SIZE = 5, CELLS = 25;

  // How long the word bubble lingers, and how long it takes to fade out.
  // FADE_MS is mirrored into CSS as --flash-fade.
  var FLASH_HOLD_MS = 420, FADE_MS = 300;

  /* ------------------------------------------------------------------
     SWIPE FEEL — the knobs worth touching.

     A tile is picked up when the finger reaches its CENTRE, not when the
     finger merely leaves the previous tile. That distinction is the whole
     ballgame. Judging by direction-from-centre looks right on paper but
     breaks on any curved swipe: a tile gets selected while the finger is
     still most of a tile away from it, so the next heading is measured from
     a point the finger hasn't arrived at yet, and an east-then-south turn
     reads as south-WEST. That produced constant unwanted diagonals.

     Centre-entry has no such lag. Each tile's catch zone is a circle around
     its centre; the circles don't overlap, so there is never a contest
     between two tiles, and a diagonal swipe never passes through an
     orthogonal neighbour's zone.
     ------------------------------------------------------------------ */
  var SWIPE = {
    // Radius of a tile's catch zone, as a fraction of tile spacing.
    // 0.42 is the circle inscribed in the tile — the finger has to genuinely
    // reach the letter. Larger = easier to pick up but sloppier; past 0.50 the
    // zones of neighbouring tiles start to overlap and it gets unpredictable.
    coreRadius: 0.38,

    // Extra radius for the four diagonal neighbours only. They sit 1.41x
    // farther away than orthogonal ones, so a little help keeps diagonals
    // feeling as responsive as straight moves. This is the diagonal
    // forgiveness knob: raise it if diagonals feel stiff, drop it to 0 to
    // treat all eight directions identically.
    diagonalBonus: 0.04,

    // Hard floor: nothing at all can be picked up until the finger has moved
    // this far from the CURRENT tile's centre, as a fraction of tile spacing.
    // A tile's own half-width is about 0.42, so 0.55 means the finger must
    // genuinely leave the square it is sitting on before anything can change.
    // Raise this if selections still fire while you're clearly still on a tile.
    minTravel: 0.55,

    // Distance between resampled points along a fast swipe, as a fraction of
    // tile spacing. Smaller catches quicker flicks at slightly more CPU.
    sampleSpacing: 0.10
  };


  var SCORE_BY_LEN = { 3:100, 4:400, 5:800, 6:1400, 7:1800, 8:2200, 9:2600 };
  function scoreOf(w){ return w.length >= 10 ? 3000 : (SCORE_BY_LEN[w.length] || 0); }

  /* Real Boggle dice, not random letters — random letters produce consonant
     soup. 5x5 is the Big Boggle set and 4x4 the classic set; 3x3 has no
     official set, so it's a 9-die subset of Big Boggle picked for vowel
     balance. The classic set's "Qu" face is just Q here, since tiles are
     single letters now. */
  var DICE_SETS = {
    3: ["aaeeee","aeegmu","aaafrs","adennn","ceiilt","ensssu","dhlnor","nootuw","ccnstw"],
    4: ["aaeegn","abbjoo","achops","affkps","aoottw","cimotu","deilrx","delrvy",
        "distty","eeghnw","eeinsu","ehrtvw","eiosst","elrtty","himnqu","hlnnrz"],
    5: ["aaafrs","aaeeee","aafirs","adennn","aeeeem","aeegmu","aegmnn","afirsy",
        "bjkqxz","ccnstw","ceiilt","ceilpt","ceipst","ddhnot","dhhlor","dhhnot",
        "dhlnor","eiiitt","emottt","ensssu","fiprsy","gorrvw","hiprry","nootuw","ooottu"],
    // 6x6 extends the Big Boggle set with 11 more dice drawn from it, chosen
    // to hold the same vowel-to-consonant ratio across the bigger grid.
    6: ["aaafrs","aaeeee","aafirs","adennn","aeeeem","aeegmu","aegmnn","afirsy",
        "bjkqxz","ccnstw","ceiilt","ceilpt","ceipst","ddhnot","dhhlor","dhhnot",
        "dhlnor","eiiitt","emottt","ensssu","fiprsy","gorrvw","hiprry","nootuw","ooottu",
        "aaeeee","aeegmu","adennn","ceiilt","ensssu","dhlnor","nootuw","ccnstw",
        "eiiitt","gorrvw","ceipst"]
  };

  /* Minimum quality a board has to clear before it's shown, set near the 25th
     percentile of what each size actually produces (measured, not guessed), so
     roughly three boards in four pass on the first roll. */
  var GATES = {
    3: { words: 30,  longest: 5, common: 12 },
    4: { words: 75,  longest: 6, common: 30 },
    5: { words: 200, longest: 7, common: 70 },
    6: { words: 450, longest: 8, common: 180 }
  };

  var DICE = DICE_SETS[SIZE];
  var GATE = GATES[SIZE];

  var WORDS = [], COMMON = null, MASKS = null;

  /* Dictionary arrives front-coded: one marker char holding how many leading
     characters this word shares with the previous one, then the new suffix.
     An uppercase first letter of the suffix flags a common (non-obscure) word. */
  function decodeDict(enc){
    var words = [], common = [], prev = "", i = 0, n = enc.length;
    while(i < n){
      var shared = enc.charCodeAt(i) - 32;
      i++;
      var j = i;
      while(j < n && enc.charCodeAt(j) >= 65) j++;
      var suf = enc.slice(i, j);
      i = j;
      var isCommon = suf.charCodeAt(0) <= 90;
      if(isCommon) suf = suf.charAt(0).toLowerCase() + suf.slice(1);
      var w = prev.slice(0, shared) + suf;
      words.push(w);
      common.push(isCommon);
      prev = w;
    }
    return { words: words, common: common };
  }

  function buildMasks(){
    var m = new Uint32Array(WORDS.length);
    for(var i = 0; i < WORDS.length; i++){
      var w = WORDS[i], bits = 0;
      for(var k = 0; k < w.length; k++) bits |= (1 << (w.charCodeAt(k) - 97));
      m[i] = bits;
    }
    return m;
  }

  function buildNeighbors(size){
    var out = [];
    for(var r = 0; r < size; r++){
      for(var c = 0; c < size; c++){
        var list = [];
        for(var dr = -1; dr <= 1; dr++){
          for(var dc = -1; dc <= 1; dc++){
            if(!dr && !dc) continue;
            var nr = r + dr, nc = c + dc;
            if(nr >= 0 && nr < size && nc >= 0 && nc < size) list.push(nr * size + nc);
          }
        }
        out.push(list);
      }
    }
    return out;
  }

  var NEIGHBORS = buildNeighbors(SIZE);

  function rollBoard(){
    var d = DICE.slice(), cells = [];
    for(var i = d.length - 1; i > 0; i--){
      var j = Math.floor(Math.random() * (i + 1));
      var t = d[i]; d[i] = d[j]; d[j] = t;
    }
    for(var k = 0; k < CELLS; k++){
      // Every tile is a single letter, Q included — no combined "Qu" tile.
      // That makes Q genuinely hard (QUIT needs a U sitting next to it), which
      // is the intended trade.
      cells.push(d[k].charAt(Math.floor(Math.random() * 6)));
    }
    return cells;
  }

  var scratch = new Uint8Array(26);

  /* Cheap two-stage filter before the expensive search: a 26-bit letter mask
     knocks out most of the dictionary with one integer test, then only the
     survivors get a full letter-count check. */
  function candidates(cells){
    var boardMask = 0, boardCount = new Uint8Array(26), i, k;
    for(i = 0; i < cells.length; i++){
      for(k = 0; k < cells[i].length; k++){
        var ci = cells[i].charCodeAt(k) - 97;
        boardMask |= (1 << ci);
        boardCount[ci]++;
      }
    }
    var out = [];
    for(i = 0; i < WORDS.length; i++){
      if((MASKS[i] & ~boardMask) !== 0) continue;
      var w = WORDS[i];
      if(w.length > CELLS) continue;
      scratch.fill(0);
      var ok = true;
      for(k = 0; k < w.length; k++){
        var idx = w.charCodeAt(k) - 97;
        if(++scratch[idx] > boardCount[idx]){ ok = false; break; }
      }
      if(ok) out.push(i);
    }
    return out;
  }

  function solve(cells){
    var cand = candidates(cells);
    var root = {};
    for(var a = 0; a < cand.length; a++){
      var w = WORDS[cand[a]], node = root;
      for(var k = 0; k < w.length; k++){
        var ch = w.charAt(k);
        node = node[ch] || (node[ch] = {});
      }
      node.$ = cand[a];
    }

    var found = new Map();
    var used = new Array(CELLS).fill(false);
    var path = [];

    function dfs(i, node, str){
      var cs = cells[i], n = node;
      for(var k = 0; k < cs.length; k++){
        n = n[cs.charAt(k)];
        if(!n) return;
      }
      used[i] = true;
      path.push(i);
      var s = str + cs;
      if(n.$ !== undefined && !found.has(s)) found.set(s, { path: path.slice(), common: COMMON[n.$] });
      var nb = NEIGHBORS[i];
      for(var j = 0; j < nb.length; j++) if(!used[nb[j]]) dfs(nb[j], n, s);
      used[i] = false;
      path.pop();
    }

    for(var i2 = 0; i2 < CELLS; i2++) dfs(i2, root, "");
    return found;
  }

  // Solve every board before showing it, and reroll the duds.
  function makeGoodBoard(){
    var best = null;
    for(var attempt = 0; attempt < 25; attempt++){
      var cells = rollBoard();
      var sol = solve(cells);
      var longest = 0, commons = 0;
      sol.forEach(function(v, w){
        if(w.length > longest) longest = w.length;
        if(v.common) commons++;
      });
      var board = { cells: cells, sol: sol };
      if(sol.size >= GATE.words && longest >= GATE.longest && commons >= GATE.common) return board;
      if(!best || sol.size > best.sol.size) best = board;
    }
    return best;
  }

  // ---------- DOM ----------

  var $ = function(id){ return document.getElementById(id); };
  var boardEl = $("board"), trailLine = $("trail-line"), ribbon = $("ribbon-chip");
  var scoreEl = $("score-value"), timeEl = $("time-value"), fillEl = $("timer-fill");
  var chipsEl = $("found-chips"), hintEl = $("found-hint"), countEl = $("found-count");
  var overlay = $("overlay"), ovTitle = $("ov-title"), ovText = $("ov-text");
  var startBtn = $("start-btn"), durSeg = $("dur-seg"), results = $("results");
  var soundBtn = $("sound-btn"), quitBtn = $("quit-btn");
  var sizeSeg = $("size-seg"), foundSection = $("found-section");
  var statsBtn = $("stats-btn"), statsOverlay = $("stats-overlay");
  var statTable = $("stat-table"), statsClose = $("stats-close"), statsReset = $("stats-reset");
  var statsOpen = $("stats-open"), statsCloseX = $("stats-close-x"), readyClose = $("ready-close");
  var defOverlay = $("def-overlay"), defWord = $("def-word"), defBody = $("def-body"), defClose = $("def-close");
  var potentialEl = $("board-potential");
  var achOverlay = $("ach-overlay"), achList = $("ach-list");
  var achOpen = $("ach-open"), achBtnReady = $("ach-btn-ready"), achCloseX = $("ach-close-x");
  var missedChips = $("missed-chips"), showAllBtn = $("show-all-btn"), againBtn = $("again-btn");

  var tiles = [];

  function buildTiles(){
    boardEl.innerHTML = "";
    boardEl.style.gridTemplateColumns = "repeat(" + SIZE + ", 1fr)";
    boardEl.style.gap = GAP + "%";
    boardEl.classList.remove("size-3", "size-4", "size-5", "size-6");
    boardEl.classList.add("size-" + SIZE);
    tiles = [];
    for(var t = 0; t < CELLS; t++){
      var el = document.createElement("div");
      el.className = "tile";
      el.dataset.i = String(t);
      boardEl.appendChild(el);
      tiles.push(el);
    }
  }

  // Switches every size-dependent piece at once: dice, gate, adjacency map,
  // the tile grid, and the trail's coordinate math.
  function setBoardSize(n){
    SIZE = n;
    CELLS = n * n;
    DICE = DICE_SETS[n];
    GATE = GATES[n];
    NEIGHBORS = buildNeighbors(n);
    computeGeometry();
    rebuildCellList();
    buildNeighborInfo();
    buildTiles();
  }

  // ---------- feedback: sound + haptics ----------

  var audioCtx = null;

  // WKWebView can throw outright on localStorage from a file:// URL, which is
  // how the Mac app loads — so every access goes through these.
  function prefGet(k){ try { return localStorage.getItem(k); } catch(err){ return null; } }
  function prefSet(k, v){ try { localStorage.setItem(k, v); } catch(err){} }

  var soundOn = prefGet("wordhunt-sound") !== "off";

  // ---------- persistent stats ----------

  var STATS_KEY = "wordhunt-stats";

  function loadStats(){
    try {
      var raw = prefGet(STATS_KEY);
      var s = raw ? JSON.parse(raw) : null;
      if(!s || typeof s !== "object") throw 0;
      s.best = s.best || {};
      // longest.words holds every word tied at the record length, oldest first,
      // so the newest is simply the last one.
      s.longest = s.longest || { len: 0, words: [] };
      s.games = s.games || 0;
      // Separate from `best`: only updated by timed rounds, since infinite mode
      // has no clock and would trivialize the high-score achievements below.
      s.bestTimedScore = s.bestTimedScore || {};
      // Lifetime counts of words found in a length range, for the long-word
      // achievements — cumulative across every round ever played.
      s.longFinds = s.longFinds || { range6to11: 0, range8to11: 0 };
      return s;
    } catch(err){
      return {
        best: {}, longest: { len: 0, words: [] }, games: 0,
        bestTimedScore: {}, longFinds: { range6to11: 0, range8to11: 0 }
      };
    }
  }

  function saveStats(s){ prefSet(STATS_KEY, JSON.stringify(s)); }

  var stats = loadStats();

  function recordRound(){
    stats.games++;
    var key = String(SIZE);
    if(game.score > (stats.best[key] || 0)) stats.best[key] = game.score;

    // "Timed matches only" per the achievement spec — infinite mode has no
    // clock, so it would trivially clear every score threshold.
    if(!isInfinite() && game.score > (stats.bestTimedScore[key] || 0)){
      stats.bestTimedScore[key] = game.score;
    }

    game.found.forEach(function(pts, w){
      if(w.length > stats.longest.len){
        stats.longest = { len: w.length, words: [w] };      // new record, reset ties
      } else if(w.length === stats.longest.len && stats.longest.words.indexOf(w) === -1){
        stats.longest.words.push(w);
      }
      if(w.length >= 6 && w.length <= 11) stats.longFinds.range6to11++;
      if(w.length >= 8 && w.length <= 11) stats.longFinds.range8to11++;
    });
    saveStats(stats);
  }

  // iOS refuses to start an AudioContext outside a real user gesture, so this
  // runs off the Start button rather than at load.
  function unlockAudio(){
    if(audioCtx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return;
    try {
      audioCtx = new AC();
      if(audioCtx.state === "suspended") audioCtx.resume();
      // A silent one-frame buffer; without it the first real tone gets eaten.
      var src = audioCtx.createBufferSource();
      src.buffer = audioCtx.createBuffer(1, 1, 22050);
      src.connect(audioCtx.destination);
      src.start(0);
    } catch(err){ audioCtx = null; }
  }

  // Synthesised rather than a sound file, so the app stays self-contained and
  // there's nothing extra to cache offline. Pitch climbs with word length.
  function ding(len){
    if(!soundOn || !audioCtx) return;
    if(audioCtx.state === "suspended") audioCtx.resume();
    var now = audioCtx.currentTime;
    var base = 700 * Math.pow(1.05, Math.min(len, 10) - 3);
    [[base, 0.25], [base * 2, 0.1]].forEach(function(voice){
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = voice[0];
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(voice[1], now + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.28);
    });
  }

  // One-off tone helper shared by the countdown and the end-of-round chime.
  function tone(freq, startIn, dur, peak, type){
    if(!soundOn || !audioCtx) return;
    var t0 = audioCtx.currentTime + (startIn || 0);
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.type = type || "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /* Two quiet clicks that sit under the main ding rather than competing with
     it: one per letter picked up, and one when the letters first spell
     something valid. Both are deliberately much softer than the word ding. */
  function selectTick(len){
    if(!soundOn || !audioCtx) return;
    if(audioCtx.state === "suspended") audioCtx.resume();
    // Rises as the word grows, so a long chain audibly builds.
    var f = 520 * Math.pow(1.055, Math.min(len, 12) - 1);
    tone(f, 0, 0.035, 0.055, "triangle");
  }

  function wordFormedTick(){
    if(!soundOn || !audioCtx) return;
    if(audioCtx.state === "suspended") audioCtx.resume();
    // A clean interval, so "this is a word" is distinct from "letter added".
    tone(784, 0,     0.075, 0.075, "sine");
    tone(1175, 0.03, 0.085, 0.055, "sine");
  }

  // Clock tick for the last ten seconds; climbs in pitch as it runs out.
  function tick(secondsLeft){
    if(!soundOn || !audioCtx) return;
    if(audioCtx.state === "suspended") audioCtx.resume();
    var urgency = (10 - secondsLeft) / 10;          // 0 at :10, ~0.9 at :01
    tone(880 + urgency * 320, 0, 0.06, 0.16, "triangle");
  }

  // Deliberately unlike the word ding — descending, so it reads as "over".
  function timeUpChime(){
    if(!soundOn || !audioCtx) return;
    if(audioCtx.state === "suspended") audioCtx.resume();
    tone(660, 0,    0.5, 0.22);
    tone(440, 0.14, 0.7, 0.20);
  }

  /* iOS has never implemented navigator.vibrate — it's ignored outright on
     iPhone. The one lever that exists is a side effect: iOS fires the Taptic
     Engine whenever a native toggle switch flips, so a hidden <input
     type="checkbox" switch> (Safari 17.4+) can be clicked to borrow it.
     Apple restricted this in iOS 26.5, so on current phones it may do nothing.
     It fails silently either way, and Android takes the standard API path. */
  var hapticSwitch = null;

  function initHaptics(){
    var el = document.createElement("input");
    el.type = "checkbox";
    el.setAttribute("switch", "");
    // Kept rendered but off-screen; display:none can stop the haptic firing.
    el.style.cssText = "position:fixed;top:-40px;left:-40px;width:1px;height:1px;opacity:0;pointer-events:none";
    el.setAttribute("aria-hidden", "true");
    el.tabIndex = -1;
    document.body.appendChild(el);
    hapticSwitch = el;
  }

  function buzz(){
    if(navigator.vibrate){ try { navigator.vibrate(12); } catch(err){} }
    if(hapticSwitch){ try { hapticSwitch.click(); } catch(err){} }
  }

  /* Tile centres in the SVG's 100x100 space, derived from the CSS grid gap so
     the trail stays aligned at any board size without measuring the DOM:
     SIZE tiles plus SIZE-1 gaps fill the 100 units. */
  var GAPS = { 3: 3.2, 4: 3.2, 5: 3.2, 6: 2.0 };
  var GAP = 3.2, STEP = 0, OFF = 0, SAMPLE_STEP = 0;

  function computeGeometry(){
    GAP = GAPS[SIZE];
    var tile = (100 - GAP * (SIZE - 1)) / SIZE;
    OFF = tile / 2;
    STEP = tile + GAP;
    // Fast flicks arrive as sparse pointermove events; the gap between them is
    // resampled at this spacing so a quick diagonal can't skip a tile.
    SAMPLE_STEP = STEP * SWIPE.sampleSpacing;
    // Trail thickness tracks tile size, so it reads the same on every board
    // instead of thickening as the grid gets denser.
    trailLine.setAttribute("stroke-width", (tile * 0.14).toFixed(2));
  }

  function centerOf(i){
    return { x: (i % SIZE) * STEP + OFF, y: Math.floor(i / SIZE) * STEP + OFF };
  }

  var game = {
    cells: [], sol: null, path: [], dragging: false,
    found: new Map(), score: 0, duration: 45, left: 45,
    timer: null, running: false
  };

  function fmtTime(s){
    var m = Math.floor(s / 60);
    return m > 0 ? m + ":" + String(s % 60).padStart(2, "0") : "0:" + String(s).padStart(2, "0");
  }

  function isInfinite(){ return game.duration === 0; }

  function drawTiles(){
    for(var i = 0; i < CELLS; i++){
      tiles[i].textContent = game.cells[i].toUpperCase();
    }
  }

  function currentWord(){
    var s = "";
    for(var i = 0; i < game.path.length; i++) s += game.cells[game.path[i]];
    return s;
  }

  function renderTrail(list){
    var pts = [];
    for(var i = 0; i < list.length; i++){
      var c = centerOf(list[i]);
      pts.push(c.x + "," + c.y);
    }
    trailLine.setAttribute("points", pts.join(" "));
  }

  function refreshSelection(){
    for(var i = 0; i < CELLS; i++) tiles[i].classList.remove("on");
    for(var k = 0; k < game.path.length; k++) tiles[game.path[k]].classList.add("on");

    var w = currentWord();
    boardEl.classList.remove("is-valid", "is-dupe");
    ribbon.className = "";

    if(!w){ game.wasValidNew = false; ribbon.textContent = " "; renderTrail(game.path); return; }

    ribbon.classList.add("show");
    ribbon.textContent = w.toUpperCase();

    var isValidNew = false;
    if(w.length >= 3 && game.sol.has(w)){
      if(game.found.has(w)){ ribbon.classList.add("dupe"); boardEl.classList.add("is-dupe"); }
      else { ribbon.classList.add("valid"); boardEl.classList.add("is-valid"); isValidNew = true; }
    }
    // Only on the edge into validity, or it would re-fire on every letter after.
    if(isValidNew && !game.wasValidNew) wordFormedTick();
    game.wasValidNew = isValidNew;

    renderTrail(game.path);
  }

  /* Direction decides the next tile, distance only decides the first one.

     The start tile is whatever is nearest the touch, so corners and gutters
     always begin a word. After that, each step asks which of the eight
     compass directions the finger is travelling from the current tile's
     centre, and takes that neighbour. Proximity is never consulted again,
     which is what stops a curved diagonal swipe being stolen by the
     orthogonal neighbour it happens to pass nearer to. */

  function pointToBoard(x, y){
    var r = boardEl.getBoundingClientRect();
    if(!r.width || !r.height) return null;
    return { x: (x - r.left) / r.width * 100, y: (y - r.top) / r.height * 100 };
  }

  function nearestOf(px, py, list){
    var best = -1, bestD = Infinity;
    for(var k = 0; k < list.length; k++){
      var c = centerOf(list[k]);
      var dx = px - c.x, dy = py - c.y;
      var d = dx * dx + dy * dy;
      if(d < bestD){ bestD = d; best = list[k]; }
    }
    return { index: best, dist: Math.sqrt(bestD) };
  }

  var ALL_CELLS = [];
  function rebuildCellList(){
    ALL_CELLS = [];
    for(var i = 0; i < CELLS; i++) ALL_CELLS.push(i);
  }

  /* Neighbours of a tile, tagged with whether they sit diagonally, so the
     diagonal bonus can be applied without recomputing geometry per sample. */
  var NEIGHBOR_INFO = [];
  function buildNeighborInfo(){
    NEIGHBOR_INFO = [];
    for(var i = 0; i < CELLS; i++){
      var r = Math.floor(i / SIZE), c = i % SIZE, list = [];
      for(var dr = -1; dr <= 1; dr++){
        for(var dc = -1; dc <= 1; dc++){
          if(!dr && !dc) continue;
          var nr = r + dr, nc = c + dc;
          if(nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
          list.push({ index: nr * SIZE + nc, diagonal: (dr !== 0 && dc !== 0) });
        }
      }
      NEIGHBOR_INFO.push(list);
    }
  }

  /* Advances the path by at most one tile for a single sampled point.
     A neighbour is picked up only once the finger is inside its catch zone —
     i.e. has actually reached the letter. Zones don't overlap, so the nearest
     check below is a tie-break that effectively never fires; it just keeps
     behaviour defined if the radii are ever tuned past 0.5. */
  function advanceTo(px, py){
    var cur = game.path[game.path.length - 1];

    // Nothing changes while the finger is still over the current tile.
    var cc = centerOf(cur);
    var cdx = px - cc.x, cdy = py - cc.y;
    if(Math.sqrt(cdx * cdx + cdy * cdy) < SWIPE.minTravel * STEP) return;

    var list = NEIGHBOR_INFO[cur];
    var best = -1, bestDist = Infinity;

    for(var k = 0; k < list.length; k++){
      var n = list[k];
      // Already used this drag: ignore it entirely. The path only ever grows,
      // so sliding back over an earlier tile does nothing rather than rewinding.
      if(game.path.indexOf(n.index) !== -1) continue;

      var c = centerOf(n.index);
      var dx = px - c.x, dy = py - c.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var radius = (SWIPE.coreRadius + (n.diagonal ? SWIPE.diagonalBonus : 0)) * STEP;

      if(dist <= radius && dist < bestDist){ bestDist = dist; best = n.index; }
    }

    if(best < 0) return;
    game.path.push(best);
    selectTick(game.path.length);
    refreshSelection();
  }

  function adjacent(a, b){
    var ar = Math.floor(a / SIZE), ac = a % SIZE;
    var br = Math.floor(b / SIZE), bc = b % SIZE;
    return a !== b && Math.abs(ar - br) <= 1 && Math.abs(ac - bc) <= 1;
  }

  function onDown(e){
    if(!game.running) return;
    var p = pointToBoard(e.clientX, e.clientY);
    if(!p || p.x < 0 || p.y < 0 || p.x > 100 || p.y > 100) return;
    e.preventDefault();
    // Nearest tile among all of them, so corners and gutters still start a word.
    var start = nearestOf(p.x, p.y, ALL_CELLS);
    if(start.index < 0) return;
    game.dragging = true;
    game.path = [start.index];
    game.lastPoint = p;
    game.wasValidNew = false;
    clearTrace();
    refreshSelection();
    try { boardEl.setPointerCapture(e.pointerId); } catch(err){}
  }

  function onMove(e){
    if(!game.dragging) return;
    e.preventDefault();
    var p = pointToBoard(e.clientX, e.clientY);
    if(!p) return;

    var last = game.lastPoint;
    if(last){
      var dx = p.x - last.x, dy = p.y - last.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var steps = Math.max(1, Math.ceil(dist / SAMPLE_STEP));
      for(var k = 1; k <= steps; k++){
        var t = k / steps;
        advanceTo(last.x + dx * t, last.y + dy * t);
      }
    } else {
      advanceTo(p.x, p.y);
    }
    game.lastPoint = p;
  }

  function flash(kind){
    ribbon.className = "show " + kind;
    if(kind === "invalid") ribbon.classList.add("shake");
    setTimeout(function(){
      // Drop .show first so it fades via the CSS transition, and only blank the
      // text once the fade has finished — otherwise it vanishes mid-fade.
      ribbon.classList.remove("show");
      setTimeout(function(){
        ribbon.classList.remove("valid", "dupe", "invalid", "shake");
        ribbon.textContent = " ";
      }, FADE_MS);
    }, FLASH_HOLD_MS);
  }

  function onUp(){
    if(!game.dragging) return;
    game.dragging = false;
    game.lastPoint = null;
    game.wasValidNew = false;
    var w = currentWord();
    game.path = [];
    for(var i = 0; i < CELLS; i++) tiles[i].classList.remove("on");
    boardEl.classList.remove("is-valid", "is-dupe");
    renderTrail([]);

    if(w.length < 3){ ribbon.classList.remove("show"); ribbon.textContent = " "; return; }
    if(!game.sol.has(w)){ ribbon.textContent = w.toUpperCase(); flash("invalid"); return; }
    if(game.found.has(w)){ ribbon.textContent = w.toUpperCase(); flash("dupe"); return; }

    var pts = scoreOf(w);
    game.found.set(w, pts);
    game.score += pts;
    ding(w.length);
    buzz();
    scoreEl.textContent = game.score.toLocaleString();
    scoreEl.classList.remove("pop");
    void scoreEl.offsetWidth;
    scoreEl.classList.add("pop");
    ribbon.textContent = w.toUpperCase() + "  +" + pts;
    flash("valid");
    renderFound();
  }

  // Longest words first, A-Z within each length.
  function byLengthThenAlpha(a, b){
    return b.length - a.length || (a < b ? -1 : a > b ? 1 : 0);
  }

  var HOLD_MS = 450;

  function makeChip(w, pts, extraClass){
    var chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (extraClass ? " " + extraClass : "");
    chip.innerHTML = '<span>' + w.toUpperCase() + '</span><span class="pts">' + pts + '</span>';

    /* Tap traces the word; press and hold opens its definition. The held flag
       swallows the click that a long press would otherwise still fire, so
       holding never also toggles the trace. */
    var timer = null, held = false;

    function startHold(){
      held = false;
      clearTimeout(timer);
      timer = setTimeout(function(){
        held = true;
        showDefinition(w);
      }, HOLD_MS);
    }
    function cancelHold(){ clearTimeout(timer); }

    chip.addEventListener("pointerdown", startHold);
    chip.addEventListener("pointerup", cancelHold);
    chip.addEventListener("pointerleave", cancelHold);
    chip.addEventListener("pointercancel", cancelHold);
    chip.addEventListener("contextmenu", function(e){ e.preventDefault(); });

    chip.addEventListener("click", function(){
      if(held){ held = false; return; }
      traceWord(w, chip);
    });
    return chip;
  }

  // Rebuilt rather than appended to, since a new word can belong anywhere in
  // the sort order rather than at the end.
  function renderFound(){
    chipsEl.innerHTML = "";
    countEl.textContent = String(game.found.size);
    if(!game.found.size){ chipsEl.appendChild(hintEl); return; }
    Array.from(game.found.keys()).sort(byLengthThenAlpha).forEach(function(w){
      chipsEl.appendChild(makeChip(w, game.found.get(w)));
    });
  }

  var tracedChip = null;

  function clearTrace(){
    for(var i = 0; i < CELLS; i++) tiles[i].classList.remove("trace");
    if(tracedChip){ tracedChip.classList.remove("active"); tracedChip = null; }
  }

  // Replays where a word actually was on the board — the point of the review screen.
  function traceWord(w, chip){
    // Clicking the same word again untraces it, so the board can be cleared.
    if(chip && tracedChip === chip){
      clearTrace();
      renderTrail([]);
      ribbon.className = "";
      ribbon.textContent = " ";
      return;
    }
    var entry = game.sol.get(w);
    clearTrace();
    renderTrail([]);
    if(!entry) return;
    tracedChip = chip;
    if(chip) chip.classList.add("active");
    for(var i = 0; i < entry.path.length; i++) tiles[entry.path[i]].classList.add("trace");
    renderTrail(entry.path);
    ribbon.className = "show";
    ribbon.textContent = w.toUpperCase();
  }

  boardEl.addEventListener("pointerdown", onDown);
  boardEl.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);

  // ---------- flow ----------

  durSeg.addEventListener("click", function(e){
    var b = e.target.closest("button");
    if(!b) return;
    Array.prototype.forEach.call(durSeg.children, function(c){ c.classList.remove("on"); });
    b.classList.add("on");
    game.duration = Number(b.dataset.sec);
  });

  function newGame(){
    var board = makeGoodBoard();
    game.cells = board.cells;
    game.sol = board.sol;
    game.found = new Map();
    game.score = 0;
    game.path = [];
    game.left = game.duration;
    game.elapsed = 0;

    drawTiles();
    clearTrace();
    renderTrail([]);
    scoreEl.textContent = "0";
    countEl.textContent = "0";
    timeEl.textContent = isInfinite() ? "∞" : fmtTime(game.left);
    timeEl.classList.remove("low");
    fillEl.classList.remove("low");
    fillEl.style.width = "100%";
    renderFound();
    quitBtn.hidden = true;
    statsOpen.hidden = false;
    foundSection.hidden = true;
    results.hidden = true;
    missedChips.innerHTML = "";
    showAllBtn.textContent = "Show all missed words";
    showAllBtn.dataset.expanded = "";
    ribbon.className = "";
    ribbon.textContent = " ";
  }

  function startGame(){
    overlay.hidden = true;
    syncScrollLock();
    game.running = true;
    boardEl.classList.remove("masked");
    quitBtn.hidden = false;
    statsOpen.hidden = true;
    foundSection.hidden = true;
    if(game.timer) clearInterval(game.timer);
    game.timer = setInterval(function(){
      if(isInfinite()){
        // No clock — count elapsed time up and never end on its own.
        game.elapsed++;
        timeEl.textContent = fmtTime(game.elapsed);
        return;
      }
      game.left--;
      timeEl.textContent = fmtTime(Math.max(0, game.left));
      fillEl.style.width = (100 * Math.max(0, game.left) / game.duration) + "%";
      if(game.left <= 10){ timeEl.classList.add("low"); fillEl.classList.add("low"); }
      if(game.left <= 10 && game.left >= 1) tick(game.left);
      if(game.left <= 0){ timeUpChime(); endGame(); }
    }, 1000);
  }

  function endGame(){
    clearInterval(game.timer);
    game.running = false;
    game.dragging = false;
    quitBtn.hidden = true;
    statsOpen.hidden = false;
    foundSection.hidden = false;   // the round is over, so revealing it is safe
    game.path = [];
    refreshSelection();
    ribbon.className = "";
    ribbon.textContent = " ";

    var missedCommon = [], missedAll = [];
    game.sol.forEach(function(v, w){
      if(game.found.has(w)) return;
      var rec = { w: w, pts: scoreOf(w) };
      missedAll.push(rec);
      if(v.common) missedCommon.push(rec);
    });
    var order = function(a, b){ return byLengthThenAlpha(a.w, b.w); };
    missedCommon.sort(order);
    missedAll.sort(order);

    recordRound();

    var potential = 0;
    game.sol.forEach(function(v, w){ potential += scoreOf(w); });
    potentialEl.textContent = "of " + potential.toLocaleString() + " possible";

    $("final-score").textContent = game.score.toLocaleString();
    $("final-words").textContent = String(game.found.size);
    $("final-total").textContent = String(game.sol.size);

    renderMissed(missedCommon.slice(0, 40), true);
    showAllBtn.onclick = function(){
      if(showAllBtn.dataset.expanded){
        renderMissed(missedCommon.slice(0, 40), true);
        showAllBtn.textContent = "Show all missed words";
        showAllBtn.dataset.expanded = "";
      } else {
        renderMissed(missedAll.slice(0, 300), false);
        showAllBtn.textContent = "Show common words only";
        showAllBtn.dataset.expanded = "1";
      }
    };

    results.hidden = false;
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderMissed(list, commonOnly){
    missedChips.innerHTML = "";
    if(!list.length){
      var p = document.createElement("p");
      p.className = "empty-hint";
      p.textContent = commonOnly ? "You got every common word on this board." : "Nothing missed.";
      missedChips.appendChild(p);
      return;
    }
    list.forEach(function(rec){
      missedChips.appendChild(
        makeChip(rec.w, rec.pts, game.sol.get(rec.w).common ? "common" : "")
      );
    });
  }

  // Any open modal locks the page so the board can't be scrolled away behind it.
  function syncScrollLock(){
    var open = !overlay.hidden || !statsOverlay.hidden || !defOverlay.hidden || !achOverlay.hidden;
    document.body.classList.toggle("modal-open", open);
  }

  function openStats(){
    renderStats();
    statsOverlay.hidden = false;
    syncScrollLock();
  }

  function closeStats(){
    statsOverlay.hidden = true;
    syncScrollLock();
  }

  /* Definitions come from Wiktionary's REST API. The obvious choice,
     dictionaryapi.dev, turned out to 502 on almost every request and has poor
     coverage of obscure words; Wiktionary runs on Wikimedia infrastructure,
     sends CORS headers, and actually has entries for the Collins long tail
     (TOCCATINAS, WOOLIES). Still needs a connection — there's no way to ship
     268k definitions in the bundle. */
  function showDefinition(w){
    defWord.textContent = w.toUpperCase();
    defBody.innerHTML = '<p class="note">Looking it up\u2026</p>';
    defOverlay.hidden = false;
    syncScrollLock();

    var url = "https://en.wiktionary.org/api/rest_v1/page/definition/" + encodeURIComponent(w);

    fetch(url)
      .then(function(r){
        if(r.status === 404) throw { kind: "missing" };
        if(!r.ok) throw { kind: "down" };
        return r.json();
      })
      .then(function(data){
        var sections = (data && data.en) || [];
        var html = "";
        sections.slice(0, 4).forEach(function(sec){
          html += '<p class="pos">' + escapeHtml(sec.partOfSpeech || "") + '</p><ol>';
          (sec.definitions || []).slice(0, 3).forEach(function(d){
            html += '<li>' + escapeHtml(stripTags(d.definition || "")) + '</li>';
          });
          html += '</ol>';
        });
        defBody.innerHTML = html || '<p class="note">No definition found. Quite a unique word indeed!</p>';
        fetchEtymology(w);
      })
      .catch(function(err){
        // A missing entry and a broken service are different problems, and
        // saying "no definition" for an outage would be a lie.
        // A missing entry and an outage are different problems; calling an
        // outage "no definition" would be a lie.
        defBody.innerHTML = (err && err.kind === "missing")
          ? '<p class="note">No definition found. Quite a unique word indeed!</p>'
          : '<p class="note">Could not reach the dictionary just now. Check your connection and try again.</p>';
      });
  }

  /* Etymology lives in a separate section of the wiki page, so it needs its own
     two-step lookup: find the section index, then fetch that section rendered.
     Loaded after the definitions and appended when it lands, so the popup isn't
     held up waiting for it. Wikitext is useless here — it's full of unexpanded
     templates that flatten to "From , , from , from" — hence the rendered HTML. */
  function fetchEtymology(w){
    var api = "https://en.wiktionary.org/w/api.php?origin=*&format=json&action=parse&page=" + encodeURIComponent(w);
    fetch(api + "&prop=sections")
      .then(function(r){ return r.json(); })
      .then(function(d){
        var secs = (d.parse && d.parse.sections) || [];
        var hit = null;
        for(var i = 0; i < secs.length; i++){
          if(/^etymology/i.test(secs[i].line)){ hit = secs[i].index; break; }
        }
        if(!hit) return null;
        return fetch(api + "&prop=text&section=" + hit).then(function(r){ return r.json(); });
      })
      .then(function(d){
        if(!d || !d.parse) return;
        var txt = stripTags(d.parse.text["*"] || "")
          .replace(/\[edit\]/gi, "")
          .replace(/^\s*Etymology\s*\d*/i, "")
          .replace(/\s+/g, " ")
          .trim();
        if(!txt) return;
        if(txt.length > 400) txt = txt.slice(0, 400).replace(/\s+\S*$/, "") + "…";
        var el = document.createElement("div");
        el.className = "etym";
        el.innerHTML = "<b>Origin</b>" + escapeHtml(decodeEntities(txt));
        defBody.appendChild(el);
      })
      .catch(function(){});
  }

  function decodeEntities(str){
    var t = document.createElement("textarea");
    t.innerHTML = str;
    return t.value;
  }

  // Wiktionary returns definitions as HTML; render them as plain text so no
  // markup from the wiki can be injected into the page.
  function stripTags(str){ return str.replace(/<[^>]*>/g, ""); }

  function escapeHtml(str){
    return str.replace(/[&<>"']/g, function(c){
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c];
    });
  }

  defClose.addEventListener("click", function(){
    defOverlay.hidden = true;
    syncScrollLock();
  });

  statsOpen.addEventListener("click", openStats);
  statsCloseX.addEventListener("click", closeStats);

  // Closing the ready screen without playing, so the last board stays reviewable.
  readyClose.addEventListener("click", function(){
    overlay.hidden = true;
    boardEl.classList.remove("masked");
    syncScrollLock();
  });

  function renderStats(){
    var rows = [3, 4, 5, 6].map(function(n){
      var v = stats.best[String(n)] || 0;
      return '<div class="stat-row"><span>' + n + '×' + n + ' best score</span>' +
             '<span class="v">' + v.toLocaleString() + '</span></div>';
    });
    var lw = stats.longest, words = lw.words || [];
    var newest = words.length ? words[words.length - 1] : "";
    rows.push('<div class="stat-row"><span>Longest word' +
      (words.length > 1 ? ' <button class="stat-expand" id="tie-toggle">+' + (words.length - 1) + ' more this long</button>' : '') +
      '</span><span class="v">' +
      // Parenthetical is letter count, not score — the chips in the expanded
      // tie list already show score per word if that's wanted.
      (newest ? newest.toUpperCase() + ' (' + newest.length + ')' : '—') + '</span></div>');

    if(words.length > 1){
      rows.push('<div class="stat-more" id="tie-list" hidden>' +
        words.slice().reverse().map(function(w){
          return '<span class="chip">' + w.toUpperCase() + '</span>';
        }).join("") + '</div>');
    }

    rows.push('<div class="stat-row"><span>Rounds played</span><span class="v">' +
      stats.games + '</span></div>');
    statTable.innerHTML = rows.join("");

    var toggle = $("tie-toggle"), list = $("tie-list");
    if(toggle && list){
      toggle.addEventListener("click", function(e){
        e.stopPropagation();
        list.hidden = !list.hidden;
        toggle.textContent = list.hidden
          ? "+" + (words.length - 1) + " more this long"
          : "hide";
      });
    }
  }

  // ---------- achievements ----------

  var HS_TIERS = {
    3: [20000, 25000, 30000],
    4: [30000, 35000, 40000],
    5: [40000, 45000, 50000],
    6: [45000, 50000, 55000]
  };

  var ACHIEVEMENTS = (function(){
    var list = [
      { cat: "Long Words", label: "Find a 6\u201311 letter word",
        check: function(s){ return (s.longFinds.range6to11 || 0) >= 1; } },
      { cat: "Long Words", label: "Find 5 words, 8\u201311 letters",
        check: function(s){ return (s.longFinds.range8to11 || 0) >= 5; } },
      { cat: "Long Words", label: "Find 10 words, 8\u201311 letters",
        check: function(s){ return (s.longFinds.range8to11 || 0) >= 10; } }
    ];
    [3, 4, 5, 6].forEach(function(size){
      HS_TIERS[size].forEach(function(threshold){
        list.push({
          cat: "High Scores (timed only)",
          label: size + "\u00d7" + size + " \u2014 " + threshold.toLocaleString() + " pts",
          check: function(s){ return (s.bestTimedScore[String(size)] || 0) >= threshold; }
        });
      });
    });
    return list;
  })();

  function renderAchievements(){
    var byCat = {}, order = [];
    ACHIEVEMENTS.forEach(function(a){
      if(!byCat[a.cat]){ byCat[a.cat] = []; order.push(a.cat); }
      byCat[a.cat].push(a);
    });

    var html = "";
    order.forEach(function(cat){
      var items = byCat[cat];
      var doneCount = items.filter(function(a){ return a.check(stats); }).length;
      html += '<h3 class="ach-cat">' + cat + ' <span class="ach-cat-count">' +
        doneCount + '/' + items.length + '</span></h3>';
      items.forEach(function(a){
        var done = a.check(stats);
        html += '<div class="ach-row' + (done ? ' done' : '') + '">' +
          '<span class="ach-trophy">' + (done ? "\ud83c\udfc6" : "\ud83c\udfc6") + '</span>' +
          '<span class="ach-label">' + a.label + '</span>' +
          (done ? '<span class="ach-check">\u2713</span>' : '') +
          '</div>';
      });
    });
    achList.innerHTML = html;
  }

  function openAch(){ renderAchievements(); achOverlay.hidden = false; syncScrollLock(); }
  function closeAch(){ achOverlay.hidden = true; syncScrollLock(); }

  achOpen.addEventListener("click", openAch);
  achBtnReady.addEventListener("click", openAch);
  achCloseX.addEventListener("click", closeAch);

  statsBtn.addEventListener("click", openStats);
  statsClose.addEventListener("click", closeStats);

  statsReset.addEventListener("click", function(){
    stats = {
      best: {}, longest: { len: 0, words: [] }, games: 0,
      bestTimedScore: {}, longFinds: { range6to11: 0, range8to11: 0 }
    };
    saveStats(stats);
    renderStats();
  });

  sizeSeg.addEventListener("click", function(e){
    var b = e.target.closest("button");
    if(!b) return;
    Array.prototype.forEach.call(sizeSeg.children, function(c){ c.classList.remove("on"); });
    b.classList.add("on");
    setBoardSize(Number(b.dataset.size));
    newGame();          // reroll immediately so the board behind the overlay matches
  });

  quitBtn.addEventListener("click", function(){
    if(game.running) endGame();
  });

  soundBtn.addEventListener("click", function(){
    soundOn = !soundOn;
    prefSet("wordhunt-sound", soundOn ? "on" : "off");
    paintSoundBtn();
    if(soundOn){ unlockAudio(); ding(4); buzz(); }   // preview what you just turned on
  });

  function paintSoundBtn(){
    soundBtn.textContent = soundOn ? "Sound on" : "Sound off";
    soundBtn.setAttribute("aria-pressed", soundOn ? "true" : "false");
    soundBtn.classList.toggle("off", !soundOn);
  }

  startBtn.addEventListener("click", function(){
    if(startBtn.disabled) return;
    unlockAudio();   // must happen inside the click, not after the timeout
    startBtn.disabled = true;
    startBtn.textContent = "Shuffling…";
    // let the button repaint before the solver blocks the thread
    setTimeout(function(){
      newGame();
      startBtn.disabled = false;
      startBtn.textContent = "Start";
      startGame();
    }, 20);
  });

  againBtn.addEventListener("click", function(){
    ovTitle.textContent = "Ready?";
    ovText.textContent = "New board, same rules. Longer words score much more.";
    startBtn.textContent = "Start";
    boardEl.classList.add("masked");
    overlay.hidden = false;
    syncScrollLock();
  });

  // ---------- boot ----------

  // Single source of truth for the fade: JS owns the number, CSS reads it.
  document.documentElement.style.setProperty("--flash-fade", (FADE_MS / 1000) + "s");

  initHaptics();
  paintSoundBtn();
  setBoardSize(SIZE);
  syncScrollLock();   // the ready overlay is open on load

  setTimeout(function(){
    var d = decodeDict(window.WORDHUNT_DICT);
    WORDS = d.words;
    COMMON = d.common;
    MASKS = buildMasks();
    window.WORDHUNT_DICT = null;   // release the raw string
    newGame();
    startBtn.disabled = false;
    startBtn.textContent = "Start";
  }, 30);

})();
