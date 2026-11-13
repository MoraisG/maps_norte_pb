#!/usr/bin/env node
/**
 * Servidor local de desenvolvimento com API SIMULADA (sem login Google e sem tocar na planilha real).
 *
 *   node scripts/dev/servidor-local.js            -> http://localhost:5500  (perfil ADMIN)
 *   node scripts/dev/servidor-local.js --porta=5600
 *   No navegador: ?perfil=PUBLICADOR troca o perfil simulado.
 *
 * Como funciona:
 * - Serve os arquivos do repositório exatamente como o GitHub Pages serviria.
 * - Ao entregar o index.html, acrescenta UMA tag <script> (scripts/dev/api-simulada.js) logo
 *   depois de js/api.js. Esse script troca o ApiClient por uma versão em memória.
 * - Nada disso existe no site publicado: os arquivos de produção não são alterados e o backend
 *   continua exigindo login Google e sessão válida. Não há "porta dos fundos" no servidor real.
 * - /sw.js responde 404 para o service worker não guardar a página modificada em cache.
 *
 * Atende somente 127.0.0.1 (não fica visível na rede).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..", "..");
const argPorta = process.argv.find(a => a.startsWith("--porta="));
const PORTA = Number(argPorta ? argPorta.split("=")[1] : 5500) || 5500;
const ROTA_SIMULADOR = "/__dev/api-simulada.js";
const ROTA_CONFIG = "/__dev/config-local.json";
// Arquivo ignorado pelo git: { "chaveEsri": "..." } (equivale à ScriptProperty ESRI_API_KEY)
const ARQUIVO_CONFIG = path.join(__dirname, "config.local.json");

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};

// Pastas/arquivos que nunca são servidos (segredos e metadados do repositório)
const BLOQUEADOS = /^(\.git|\.env|\.clasp|\.claude|node_modules)(\/|$|\.)|config\.local\.json$/i;

function responder(res, status, corpo, tipo) {
  res.writeHead(status, {
    "Content-Type": tipo || "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(corpo);
}

function injetarSimulador(html) {
  const marcador = /(<script src="js\/api\.js[^"]*"><\/script>)/;
  if (!marcador.test(html)) {
    throw new Error("Não encontrei a tag de js/api.js no index.html para injetar a API simulada.");
  }
  return html.replace(marcador, `$1\n  <script src="${ROTA_SIMULADOR}"></script>`);
}

const servidor = http.createServer((req, res) => {
  let caminho;
  try {
    caminho = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch (e) {
    return responder(res, 400, "Requisição inválida.");
  }

  if (req.method !== "GET" && req.method !== "HEAD") return responder(res, 405, "Método não permitido.");
  if (caminho === "/sw.js") return responder(res, 404, "Service worker desligado no modo local.");

  if (caminho === ROTA_SIMULADOR) {
    return fs.readFile(path.join(__dirname, "api-simulada.js"), (erro, dados) =>
      erro ? responder(res, 500, "Falha ao ler api-simulada.js") : responder(res, 200, dados, TIPOS[".js"]));
  }

  if (caminho === ROTA_CONFIG) {
    return fs.readFile(ARQUIVO_CONFIG, (erro, dados) => responder(res, 200, erro ? "{}" : dados, TIPOS[".json"]));
  }

  if (caminho === "/") caminho = "/index.html";
  const relativo = caminho.replace(/^\/+/, "");
  const absoluto = path.resolve(RAIZ, relativo);

  if (!absoluto.startsWith(RAIZ + path.sep) || BLOQUEADOS.test(relativo)) {
    return responder(res, 403, "Acesso negado.");
  }

  fs.readFile(absoluto, (erro, dados) => {
    if (erro) return responder(res, 404, "Não encontrado: " + caminho);
    if (relativo === "index.html") {
      try {
        return responder(res, 200, injetarSimulador(dados.toString("utf8")), TIPOS[".html"]);
      } catch (e) {
        return responder(res, 500, e.message);
      }
    }
    responder(res, 200, dados, TIPOS[path.extname(absoluto).toLowerCase()] || "application/octet-stream");
  });
});

servidor.on("error", erro => {
  if (erro.code === "EADDRINUSE" || erro.code === "EACCES") {
    console.error(`A porta ${PORTA} está ocupada ou bloqueada. Tente outra: node scripts/dev/servidor-local.js --porta=5600`);
  } else {
    console.error(erro.message);
  }
  process.exit(1);
});

servidor.listen(PORTA, "127.0.0.1", () => {
  console.log(`Modo local com API SIMULADA em http://localhost:${PORTA}/`);
  console.log("Sem login Google e sem acesso à planilha real. Ctrl+C para encerrar.");
});
