// 画面のファイルをスマホに保存しておき、電波が弱い店内でもすぐ開けるようにする。
// ファイルを更新したら CACHE の番号を上げること（上げないと古い画面が出続ける）。
var CACHE = 'karaoke-v3';
var ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'config.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/key-up.png',
  'icons/key-down.png',
];

self.addEventListener('install', function (event) {
  // ブラウザ側の一時保存（最大10分）を通さず、必ずサーバーから最新版を取る
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    return cache.addAll(ASSETS.map(function (url) { return new Request(url, { cache: 'reload' }); }));
  }));
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// 保存してある画面をすぐ返し、裏で最新版を取りに行く（次に開いたときに反映される）。
// スプレッドシートとの通信（別のサイト宛て）には手を出さない。
self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(req, { ignoreSearch: true }).then(function (hit) {
        // 'no-cache' = サーバーに「変わった？」を毎回確かめる（変わっていなければ通信はごく小さい）
        var fresh = fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })).then(function (res) {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(function () { return hit; });
        return hit || fresh;
      });
    })
  );
});
