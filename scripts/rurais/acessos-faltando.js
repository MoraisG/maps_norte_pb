#!/usr/bin/env node
/**
 * Spec 07 / Fase 3 — lista de "acessos faltando": casas do interior a mais de N metros de qualquer
 * estrada de vias-rurais.geojson. Serve de roteiro para traçar os acessos (OSM/JOSM ou QGIS) e
 * depois rodar de novo scripts/rurais/gerar-vias-rurais.js.
 *
 * Uso (na raiz do projeto, Node 18+; sem dependências):
 *   node scripts/rurais/acessos-faltando.js --pontos="<pontos-rurais.json fora do repo>" --saida="<pasta fora do repo>"
 *     [--limite=150] [--territorios=18,20]
 *
 * Entrada: o .json gerado por scripts/rurais/importar-pontos-kmz.js (dados de residências: fica
 * FORA do repositório). Saída, também fora do repositório:
 *   acessos-faltando.csv      terr, id, lat, lng, domicilios, distancia_m, localidade
 *   acessos-faltando.geojson  os mesmos pontos, para abrir no QGIS/JOSM como camada de referência
 * O console mostra só contagens por território (nenhum endereço).
 *
 * Importante: os pontos são dados privados — servem de guia visual para traçar a ESTRADA; nunca
 * envie os pontos nem atributos deles ao OpenStreetMap.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const RAIZ = path.resolve(__dirname, "..", "..");

function dentroDoRepositorio(alvo) {
  const rel = path.relative(RAIZ, path.resolve(alvo));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Projeção equiretangular local (metros) centrada em lat0: boa para distâncias de poucos km. */
function projetor(lat0) {
  const kLat = 111320, kLng = 111320 * Math.cos(lat0 * Math.PI / 180);
  return (lat, lng) => [lng * kLng, lat * kLat];
}

function distPontoSegmento(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

/**
 * pontos: [{ id, terr, lat, lng, dom, loc }]; vias: FeatureCollection de LineString/MultiLineString.
 * Devolve [{ ...ponto, distancia }] dos pontos a mais de limiteM da via mais próxima (distância
 * = Infinity quando não há nenhuma via por perto), do mais distante para o mais próximo.
 */
function calcularAcessosFaltando(pontos, vias, limiteM) {
  const lista = (pontos || []).filter(p => p && isFinite(p.lat) && isFinite(p.lng));
  if (!lista.length) return [];
  const lat0 = lista.reduce((s, p) => s + p.lat, 0) / lista.length;
  const xy = projetor(lat0);

  // Linhas em metros, com caixa para descartar rápido as que estão longe
  const linhas = [];
  for (const f of (vias && vias.features) || []) {
    const g = f.geometry || {};
    const partes = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    for (const parte of partes) {
      const pts = parte.map(c => xy(c[1], c[0]));
      if (pts.length < 2) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      linhas.push({ pts, minX, minY, maxX, maxY });
    }
  }

  const menorDistancia = (px, py, raio) => {
    let melhor = Infinity;
    for (const l of linhas) {
      // fora da caixa ampliada pelo raio: não pode estar a menos que o raio
      if (isFinite(raio) && (px < l.minX - raio || px > l.maxX + raio || py < l.minY - raio || py > l.maxY + raio)) continue;
      for (let i = 1; i < l.pts.length; i++) {
        const d = distPontoSegmento(px, py, l.pts[i - 1][0], l.pts[i - 1][1], l.pts[i][0], l.pts[i][1]);
        if (d < melhor) melhor = d;
      }
      if (isFinite(raio) && melhor <= raio) break;
    }
    return melhor;
  };

  const saida = [];
  for (const p of lista) {
    const [px, py] = xy(p.lat, p.lng);
    // 1ª passada rápida: só decide se há estrada a até limiteM
    if (menorDistancia(px, py, limiteM) <= limiteM) continue;
    // Longe: distância exata até a estrada mais próxima (sem filtro de caixa)
    saida.push(Object.assign({}, p, { distancia: menorDistancia(px, py, Infinity) }));
  }
  return saida.sort((a, b) => b.distancia - a.distancia);
}

const csvCampo = v => {
  const s = String(v === undefined || v === null ? "" : v);
  // Evita fórmula ao abrir na planilha e escapa aspas
  const seguro = /^[=+\-@]/.test(s) && isNaN(Number(s)) ? "'" + s : s;
  return /[",;\n]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
};

function gerarCsv(lista) {
  const linhas = ["terr,id,lat,lng,domicilios,distancia_m,localidade"];
  for (const p of lista) {
    linhas.push([p.terr, p.id, p.lat, p.lng, p.dom || 1, isFinite(p.distancia) ? Math.round(p.distancia) : "sem via", p.loc || ""].map(csvCampo).join(","));
  }
  return linhas.join("\n") + "\n";
}

function gerarGeojson(lista) {
  return JSON.stringify({
    type: "FeatureCollection",
    name: "acessos-faltando",
    features: lista.map(p => ({
      type: "Feature",
      properties: { terr: p.terr, id: p.id, domicilios: p.dom || 1, distancia_m: isFinite(p.distancia) ? Math.round(p.distancia) : null },
      geometry: { type: "Point", coordinates: [p.lng, p.lat] }
    }))
  });
}

const AJUDA = `
Casas do interior longe de qualquer estrada (spec 07 / Fase 3)

  node scripts/rurais/acessos-faltando.js --pontos="<pontos-rurais.json>" --saida="<pasta>" [--limite=150] [--territorios=18,20]

  --pontos       .json gerado por scripts/rurais/importar-pontos-kmz.js (fora do repositório)
  --saida        pasta onde gravar acessos-faltando.csv e .geojson (fora do repositório)
  --limite       distância mínima até a estrada para entrar na lista, em metros (padrão 150)
  --territorios  só estes territórios
  --vias         outro arquivo de vias (padrão: vias-rurais.geojson)
`;

function executar(argv, log) {
  const escrever = log || console.log;
  const op = { limite: 150, vias: path.join(RAIZ, "vias-rurais.geojson"), territorios: null, pontos: "", saida: "" };
  for (const a of argv) {
    const i = a.indexOf("="), chave = i >= 0 ? a.slice(0, i) : a, valor = i >= 0 ? a.slice(i + 1) : "";
    if (chave === "--pontos") op.pontos = path.resolve(valor);
    else if (chave === "--saida") op.saida = path.resolve(valor);
    else if (chave === "--vias") op.vias = path.resolve(valor);
    else if (chave === "--limite") op.limite = Number(valor);
    else if (chave === "--territorios") op.territorios = new Set(valor.split(",").map(Number).filter(Number.isFinite));
    else if (chave === "--ajuda" || chave === "-h") { escrever(AJUDA); return 0; }
    else throw new Error(`Opção desconhecida: ${a} (use --ajuda)`);
  }
  if (!op.pontos || !op.saida) { escrever(AJUDA); throw new Error("Informe --pontos e --saida."); }
  if (!(op.limite > 0)) throw new Error("--limite deve ser maior que zero.");
  if (dentroDoRepositorio(op.pontos)) throw new Error("--pontos não deve ficar dentro do repositório (dados de residências).");
  if (dentroDoRepositorio(op.saida)) throw new Error("--saida precisa ficar fora do repositório (dados de residências, LGPD).");

  const dados = JSON.parse(fs.readFileSync(op.pontos, "utf8"));
  let pontos = Array.isArray(dados) ? dados : dados.pontos;
  if (!Array.isArray(pontos)) throw new Error("Arquivo de pontos sem a lista \"pontos\".");
  if (op.territorios) pontos = pontos.filter(p => op.territorios.has(Number(p.terr)));
  const vias = JSON.parse(fs.readFileSync(op.vias, "utf8"));

  const faltando = calcularAcessosFaltando(pontos, vias, op.limite);
  fs.mkdirSync(op.saida, { recursive: true });
  fs.writeFileSync(path.join(op.saida, "acessos-faltando.csv"), gerarCsv(faltando));
  fs.writeFileSync(path.join(op.saida, "acessos-faltando.geojson"), gerarGeojson(faltando));

  // Resumo só com contagens (sem endereços)
  const porTerr = new Map();
  for (const p of pontos) {
    const r = porTerr.get(p.terr) || { total: 0, longe: 0, semVia: 0 };
    r.total++;
    porTerr.set(p.terr, r);
  }
  for (const p of faltando) {
    const r = porTerr.get(p.terr);
    r.longe++;
    if (!isFinite(p.distancia)) r.semVia++;
  }
  escrever(`Casas analisadas: ${pontos.length} | a mais de ${op.limite} m de uma estrada: ${faltando.length}`);
  escrever("Terr  Casas  Longe  (sem nenhuma via por perto)");
  for (const [terr, r] of [...porTerr.entries()].sort((a, b) => a[0] - b[0])) {
    if (!r.longe) continue;
    escrever(`${String(terr).padStart(4)}  ${String(r.total).padStart(5)}  ${String(r.longe).padStart(5)}  ${r.semVia ? r.semVia : ""}`);
  }
  escrever(`Gravado em: ${op.saida} (acessos-faltando.csv e acessos-faltando.geojson)`);
  escrever("Lembrete: use os pontos só como guia para traçar a estrada; não envie os pontos ao OpenStreetMap.");
  return 0;
}

module.exports = { calcularAcessosFaltando, gerarCsv, gerarGeojson, executar, dentroDoRepositorio };

if (require.main === module) {
  try {
    process.exitCode = executar(process.argv.slice(2));
  } catch (e) {
    console.error("Erro: " + e.message);
    process.exitCode = 2;
  }
}
