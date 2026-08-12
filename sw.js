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

var ASSET_VERSION = "5";
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

self.addEventListener("fetch", function(e){
  if(e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then(function(hit){
      return hit || fetch(e.request).then(function(res){
        var copy = res.clone();
        caches.open(CACHE).then(function(c){ c.put(e.request, copy); }).catch(function(){});
        return res;
      });
    }).catch(function(){ return caches.match("index.html"); })
  );
});
