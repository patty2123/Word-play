/* Offline cache + self-update.
   The whole game is static, so caching it is what makes the Home Screen app
   open instantly and work with no signal. The fetch handler still stays
   cache-first for speed — but on its own a cache-first worker never checks
   for anything newer, which is wrong while this app is under active
   development. Two things fix that:

     1. ASSET_VERSION below. Bump it any time a game file changes and the
        cache key changes with it, which is what makes the browser notice
        this file is different and run a fresh install/activate.
     2. index.html calls registration.update() every time the app is
        foregrounded, so "is there a new version" gets checked on every
        open instead of on the browser's own ~once-a-day schedule.

   When activate finds an old cache to replace, that means a real update just
   landed, so every open tab/app instance gets a postMessage about it —
   index.html turns that into the "Update available" banner. */

var ASSET_VERSION = "19";
var CACHE = "wordhunt-v" + ASSET_VERSION;

var ASSETS = [
  "./",
  "index.html",
  "style.css",
  "game.js",
  "dict.js",
  "build-info.js",
  "manifest.webmanifest",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png"
];

self.addEventListener("install", function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(c){ return c.addAll(ASSETS); }).then(function(){
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      var hadPriorVersion = keys.some(function(k){ return k !== CACHE; });
      return Promise.all(keys.map(function(k){
        return k === CACHE ? null : caches.delete(k);
      })).then(function(){ return self.clients.claim(); })
        .then(function(){ if(hadPriorVersion) notifyClients(); });
    })
  );
});

function notifyClients(){
  self.clients.matchAll({ type: "window" }).then(function(list){
    list.forEach(function(c){ c.postMessage({ type: "wordhunt-updated", version: ASSET_VERSION }); });
  });
}

/* Network-first for code, cache-first for the heavy immutable assets.

   This used to be cache-first for everything, which is right for a finished
   app and wrong for one under active development: a phone that had cached a
   build kept serving it, so a deployed fix could sit there invisibly while the
   old behaviour persisted. Code is now always fetched fresh when online and
   falls back to cache offline, so the app can never silently run stale logic.
   The dictionary and icons stay cache-first — 840KB re-downloaded on every
   load for a file that rarely changes would be wasteful, and the version bump
   already clears them when they do. */

var CACHE_FIRST = ["dict.js", "icon-180.png", "icon-192.png", "icon-512.png"];

function isCacheFirst(url){
  for(var i = 0; i < CACHE_FIRST.length; i++){
    if(url.indexOf(CACHE_FIRST[i]) !== -1) return true;
  }
  return false;
}

self.addEventListener("fetch", function(e){
  if(e.request.method !== "GET") return;

  if(isCacheFirst(e.request.url)){
    e.respondWith(
      caches.match(e.request).then(function(hit){
        return hit || fetch(e.request).then(function(res){
          var copy = res.clone();
          caches.open(CACHE).then(function(c){ c.put(e.request, copy); }).catch(function(){});
          return res;
        });
      })
    );
    return;
  }

  e.respondWith(
    fetch(e.request).then(function(res){
      var copy = res.clone();
      caches.open(CACHE).then(function(c){ c.put(e.request, copy); }).catch(function(){});
      return res;
    }).catch(function(){
      // Offline: fall back to whatever was cached, then to the shell.
      return caches.match(e.request).then(function(hit){
        return hit || caches.match("index.html");
      });
    })
  );
});
