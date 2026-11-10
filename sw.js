/**
 * Service Worker — Cache exclusivamente de ativos estáticos de interface (Seção 20 do Plano Técnico v2)
 * NENHUM dado sensível ou resposta da API é armazenado em cache offline.
 */
const CACHE_NAME = "territorios-pwa-shell-v2";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/styles.css",
  "./js/utils.js",
  "./js/api.js",
  "./js/map.js",
  "./js/app.js",
  "./assets/icon.svg"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Nunca intercepta requisições à API do Google Apps Script ou Google Identity (sempre rede ao vivo)
  if (
    event.request.method !== "GET" ||
    url.hostname.includes("script.google.com") ||
    url.hostname.includes("googleusercontent.com") ||
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("accounts.google.com")
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
