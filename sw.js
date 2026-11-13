/**
 * Service Worker — Estratégia Network-First Estrita (cache: "no-store")
 * Garante que o F5 sempre busque os arquivos mais recentes da rede, usando cache apenas se estiver sem internet.
 */
const CACHE_NAME = "territorios-pwa-shell-v10";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/tailwind.css?v=10",
  "./css/styles.css?v=10",
  "./vendor/leaflet-1.9.4/leaflet.css",
  "./vendor/leaflet-1.9.4/leaflet.js",
  "./js/frame-guard.js?v=10",
  "./js/utils.js?v=10",
  "./js/api.js?v=10",
  "./js/map.js?v=10",
  "./js/app.js?v=10",
  "./assets/icon.svg"
];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      for (const assetUrl of STATIC_ASSETS) {
        try {
          const response = await fetch(new Request(assetUrl, { cache: "reload" }));
          if (response && response.ok) {
            await cache.put(assetUrl, response);
          }
        } catch (e) {}
      }
    })
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Nunca intercepta requisições à API do Google Apps Script ou Google Identity
  if (
    event.request.method !== "GET" ||
    url.hostname.includes("script.google.com") ||
    url.hostname.includes("googleusercontent.com") ||
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("accounts.google.com")
  ) {
    return;
  }

  // Network-First com bypass do cache HTTP de disco (cache: "no-store") para que o F5 nunca carregue versão antiga
  event.respondWith(
    fetch(event.request, { cache: "no-store" })
      .then(networkResponse => {
        if (networkResponse && networkResponse.status === 200 && url.origin === self.location.origin) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
