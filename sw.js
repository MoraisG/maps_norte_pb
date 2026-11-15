/**
 * Service Worker — casca do app com "cache primeiro, atualiza depois".
 *
 * - index.html (navegação): rede primeiro, com limite de espera; se a rede demorar ou faltar, usa o cache.
 *   É o index.html que aponta para os arquivos ?v=N, então um F5 com rede sempre traz a versão publicada.
 * - Demais arquivos do próprio site (JS, CSS, vendor, geojson, ícones): responde do cache na hora e
 *   revalida em segundo plano. Publicar versão nova = subir o ?v= (index.html, VERSAO abaixo e js/app.js).
 * - API (Google Apps Script) e login Google não passam por aqui.
 * - Ladrilhos de mapa (outras origens) seguem direto para a rede, exceto quando existe um pacote
 *   offline baixado (js/pacote-offline.js): aí o ladrilho guardado é servido primeiro.
 */
const VERSAO = 22;
const PREFIXO_CACHE = "territorios-pwa-shell-";
const PREFIXO_PACOTE = "territorios-tiles-";   // pacotes offline de ladrilhos, um cache por território
const DOWNLOADS_PARALELOS = 6;
const CACHE_NAME = `${PREFIXO_CACHE}v${VERSAO}`;
const ESPERA_NAVEGACAO_MS = 3000;
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  `./css/tailwind.css?v=${VERSAO}`,
  `./css/styles.css?v=${VERSAO}`,
  "./vendor/leaflet-1.9.4/leaflet.css",
  "./vendor/leaflet-1.9.4/leaflet.js",
  "./vendor/qrcode-generator-1.4.4/qrcode.js",
  `./js/geo.js?v=${VERSAO}`,
  `./quadras.geojson?v=${VERSAO}`,
  `./vias-rurais.geojson?v=${VERSAO}`,
  `./js/frame-guard.js?v=${VERSAO}`,
  `./js/utils.js?v=${VERSAO}`,
  `./js/api.js?v=${VERSAO}`,
  `./js/armazenamento.js?v=${VERSAO}`,
  `./js/fila.js?v=${VERSAO}`,
  `./js/pacote-offline.js?v=${VERSAO}`,
  `./js/modal-predios.js?v=${VERSAO}`,
  `./js/map.js?v=${VERSAO}`,
  `./js/instalacao.js?v=${VERSAO}`,
  `./js/app.js?v=${VERSAO}`,
  "./assets/icon.svg",
  "./assets/icon-192.png",
  "./assets/icon-512.png"
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
  // Remove só as cascas antigas; outros caches do app (ex.: pacotes offline) não são tocados
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith(PREFIXO_CACHE) && k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function guardarNoCache(request, response) {
  if (!response || response.status !== 200) return Promise.resolve();
  const copia = response.clone();
  return caches.open(CACHE_NAME).then(cache => cache.put(request, copia)).catch(() => {});
}

/** Navegação: rede primeiro; passado o limite de espera (ou sem rede), responde com a cópia em cache. */
function responderNavegacao(event) {
  const request = event.request;
  const emCache = () => caches.match(request).then(r => r || caches.match("./index.html"));

  const daRede = fetch(request, { cache: "no-store" });
  // Registrado já aqui: se a resposta da rede chegar depois do limite, a cópia em cache ainda é atualizada
  event.waitUntil(daRede.then(response => guardarNoCache(request, response)).catch(() => {}));

  const limite = new Promise(resolve => setTimeout(resolve, ESPERA_NAVEGACAO_MS)).then(emCache);

  return Promise.race([
    daRede.catch(() => undefined),
    limite
  ]).then(resposta => {
    if (resposta) return resposta;
    // Limite vencido sem cópia em cache (ou rede falhou primeiro): fica com o que chegar
    return daRede.catch(() => emCache()).then(r => r || Response.error());
  });
}

/** Arquivos do site: cache primeiro; a rede atualiza a cópia para a próxima abertura. */
function responderArquivo(event) {
  const request = event.request;
  const daRede = fetch(request, { cache: "no-cache" });
  event.waitUntil(daRede.then(response => guardarNoCache(request, response)).catch(() => {}));

  return caches.match(request).then(emCache => emCache || daRede);
}

// ---------------------------------------------------------------------------------------------
// Pacotes offline de ladrilhos
// ---------------------------------------------------------------------------------------------
let pacotesAtivos = null;            // null = ainda não se sabe (service worker acabou de iniciar)
const downloadsCancelados = new Set();

function conferirPacotes() {
  return caches.keys()
    .then(nomes => { pacotesAtivos = nomes.some(n => n.startsWith(PREFIXO_PACOTE)); })
    .catch(() => { pacotesAtivos = false; });
}
conferirPacotes();

/** Chave do ladrilho no cache: o endereço sem a chave de acesso (token) do provedor. */
function chaveLadrilho(endereco) {
  const u = new URL(endereco);
  u.searchParams.delete("token");
  return u.href;
}

async function responderLadrilho(request) {
  try {
    const chave = chaveLadrilho(request.url);
    for (const nome of await caches.keys()) {
      if (!nome.startsWith(PREFIXO_PACOTE)) continue;
      const guardado = await (await caches.open(nome)).match(chave);
      if (guardado) return guardado;
    }
  } catch (e) {}
  return fetch(request);
}

/** Baixa os ladrilhos de um território; já baixados são pulados (permite retomar). */
async function baixarPacote(dados, porta) {
  const numero = String(dados.numero);
  const urls = Array.isArray(dados.urls) ? dados.urls : [];
  const avisar = msg => { try { if (porta) porta.postMessage(msg); } catch (e) {} };
  downloadsCancelados.delete(numero);

  let cache;
  try {
    cache = await caches.open(PREFIXO_PACOTE + numero);
  } catch (e) {
    avisar({ tipo: "ERRO" });
    return;
  }
  pacotesAtivos = true;

  let proximo = 0, feitos = 0, falhas = 0;
  const trabalhar = async () => {
    while (proximo < urls.length && !downloadsCancelados.has(numero)) {
      const url = urls[proximo++];
      try {
        const chave = chaveLadrilho(url);
        if (!(await cache.match(chave))) {
          const resposta = await fetch(url, { mode: "cors", credentials: "omit" });
          if (resposta && resposta.ok) await cache.put(chave, resposta);
          else falhas++;
        }
      } catch (e) {
        falhas++;
      }
      feitos++;
      if (feitos % 10 === 0) avisar({ tipo: "PROGRESSO", feitos, total: urls.length });
    }
  };
  await Promise.all(Array.from({ length: DOWNLOADS_PARALELOS }, trabalhar));

  const cancelado = downloadsCancelados.delete(numero);
  // Cancelado: o que não foi tentado conta como falta, para o pacote não ser dado como completo
  avisar({ tipo: "FIM", total: urls.length, falhas: falhas + (urls.length - feitos), cancelado });
}

self.addEventListener("message", event => {
  const dados = event.data || {};
  if (dados.tipo === "PACOTE_BAIXAR") {
    event.waitUntil(baixarPacote(dados, event.ports && event.ports[0]));
  } else if (dados.tipo === "PACOTE_CANCELAR") {
    downloadsCancelados.add(String(dados.numero));
  } else if (dados.tipo === "PACOTES_MUDARAM") {
    event.waitUntil(conferirPacotes());
  }
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

  // Outras origens (ladrilhos OSM/Esri, fontes): seguem direto para a rede, com o cache HTTP
  // normal do navegador. Só quando há pacote offline baixado as imagens são procuradas nele antes.
  if (url.origin !== self.location.origin) {
    if (pacotesAtivos !== false && event.request.destination === "image") {
      event.respondWith(responderLadrilho(event.request));
    }
    return;
  }

  const ehNavegacao = event.request.mode === "navigate" ||
    url.pathname.endsWith("/") || url.pathname.endsWith("/index.html");

  event.respondWith(ehNavegacao ? responderNavegacao(event) : responderArquivo(event));
});
