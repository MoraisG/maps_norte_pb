#!/usr/bin/env node
/**
 * Gera vias-rurais.geojson: estradas do OpenStreetMap (asfalto, estradas municipais de terra,
 * acessos e carreadores) recortadas pelos territórios rurais, para o mapa do cartão funcionar
 * sem internet (spec 07, fase 1). O arquivo é estático, versionado e entra no cache do
 * service worker como quadras.geojson.
 *
 * Uso (na raiz do projeto, Node 18+; sem dependências):
 *   node scripts/rurais/gerar-vias-rurais.js              gera/atualiza vias-rurais.geojson
 *   node scripts/rurais/gerar-vias-rurais.js --ajuda      lista as opções
 *
 * Só atributos públicos do OSM vão para o arquivo: classe da via (h), nome ou referência (n)
 * e superfície (s). Licença: ODbL — crédito "© OpenStreetMap contributors".
 *
 * Privacidade: a única informação enviada à Overpass API é a caixa delimitadora dos territórios
 * rurais e o filtro de `highway`. A resposta fica em cache local (scripts/rurais/.cache/, fora do
 * versionamento) e só é baixada de novo com --atualizar-osm. Nenhum dado de residência entra aqui.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Geo = require("../../js/geo.js");
const Osm = require("../lib/overpass.js");

const RAIZ = path.resolve(__dirname, "..", "..");

const PADROES = {
  territorios: path.join(RAIZ, "territorios_nortpb.geojson"),
  saida: path.join(RAIZ, "vias-rurais.geojson"),
  cache: path.join(__dirname, ".cache"),
  // Mesma regra do gerador de quadras: acima desta área o território é rural
  areaMaxUrbanoHa: 60,
  margemM: 300,      // vias até esta distância fora do contorno também entram (orientação na divisa)
  toleranciaM: 3,    // simplificação (Douglas-Peucker)
  passoM: 40,        // densificação antes do recorte (segmentos longos que só cruzam a área)
  semGravar: false,
  atualizarOsm: false,
  urbanos: new Set(),
  rurais: new Set()
};

// Classes baixadas, da mais importante para a menos importante (ordem usada no arquivo)
const CLASSES_VIA = ["motorway", "trunk", "primary", "secondary", "tertiary", "motorway_link", "trunk_link",
  "primary_link", "secondary_link", "tertiary_link", "unclassified", "residential", "living_street", "road",
  "service", "track"];
const ORDEM_CLASSE = new Map(CLASSES_VIA.map((c, i) => [c, i]));

const AJUDA = `
Gera vias-rurais.geojson com as estradas do OpenStreetMap dentro dos territórios rurais.

  --atualizar-osm              baixa as vias de novo (ignora o cache local)
  --sem-gravar                 só calcula e mostra o resumo
  --margem=300                 metros além do contorno que também entram
  --tolerancia=3               simplificação das linhas, em metros
  --area-max-urbano-ha=60      limite de área para tratar um território como urbano
  --rurais=46,50               força territórios a terem vias (mesmo abaixo do limite de área)
  --urbanos=58,90              força territórios a ficarem sem vias
  --territorios=arquivo        geojson dos territórios (padrão: territorios_nortpb.geojson)
  --saida=arquivo              arquivo gerado (padrão: vias-rurais.geojson)
`;

function lerArgumentos(argv) {
  const op = Object.assign({}, PADROES, { urbanos: new Set(), rurais: new Set() });
  for (const a of argv) {
    const [chave, valor] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, ""];
    const lista = () => valor.split(",").map(Number).filter(Number.isFinite);
    if (chave === "--atualizar-osm") op.atualizarOsm = true;
    else if (chave === "--sem-gravar") op.semGravar = true;
    else if (chave === "--margem") op.margemM = Number(valor);
    else if (chave === "--tolerancia") op.toleranciaM = Number(valor);
    else if (chave === "--area-max-urbano-ha") op.areaMaxUrbanoHa = Number(valor);
    else if (chave === "--rurais") lista().forEach(n => op.rurais.add(n));
    else if (chave === "--urbanos") lista().forEach(n => op.urbanos.add(n));
    else if (chave === "--territorios") op.territorios = path.resolve(valor);
    else if (chave === "--saida") op.saida = path.resolve(valor);
    else if (chave === "--ajuda" || chave === "-h") op.ajuda = true;
    else throw new Error(`Opção desconhecida: ${a} (use --ajuda)`);
  }
  return op;
}

// ---------------------------------------------------------------------------------------------
// Geometria (pontos [x, y] em metros)
// ---------------------------------------------------------------------------------------------

/** Insere pontos intermediários para que nenhum trecho passe de `passo` metros. */
function densificar(pts, passo) {
  const saida = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / passo);
    for (let k = 1; k < n; k++) saida.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
    saida.push(b);
  }
  return saida;
}

/** Douglas-Peucker iterativo (mantém o primeiro e o último ponto). */
function simplificarLinha(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const manter = new Uint8Array(pts.length);
  manter[0] = manter[pts.length - 1] = 1;
  const pilha = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (pilha.length) {
    const [i, j] = pilha.pop();
    let maior = -1, indice = -1;
    for (let k = i + 1; k < j; k++) {
      const d = Geo._distSegmentoQuadrada(pts[k][0], pts[k][1], pts[i], pts[j]);
      if (d > maior) { maior = d; indice = k; }
    }
    if (indice >= 0 && maior > tol2) {
      manter[indice] = 1;
      pilha.push([i, indice], [indice, j]);
    }
  }
  return pts.filter((_, k) => manter[k]);
}

/** Distância (m) do ponto ao território: positiva dentro, negativa fora (maior valor entre as partes). */
function distanciaAoTerritorio(x, y, partesXY) {
  let melhor = -Infinity;
  for (const parte of partesXY) {
    const d = Geo.distanciaAssinada(x, y, parte);
    if (d > melhor) melhor = d;
  }
  return melhor;
}

/**
 * Recorta uma linha (já em metros) pela área do território + margem. Devolve os trechos que
 * ficam dentro, cada um estendido em um ponto para cada lado (as estradas não "param" na divisa).
 */
function recortarLinha(pts, partesXY, margem, passo) {
  const densa = densificar(pts, passo);
  const dentro = densa.map(p => distanciaAoTerritorio(p[0], p[1], partesXY) >= -margem);
  const trechos = [];
  let inicio = -1;
  for (let i = 0; i <= densa.length; i++) {
    if (i < densa.length && dentro[i]) {
      if (inicio < 0) inicio = i;
      continue;
    }
    if (inicio >= 0) {
      const a = Math.max(0, inicio - 1), b = Math.min(densa.length - 1, i);
      if (b > a) trechos.push(densa.slice(a, b + 1));
      inicio = -1;
    }
  }
  return trechos;
}

const caixaDe = pts => {
  const c = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    if (p[0] < c[0]) c[0] = p[0];
    if (p[1] < c[1]) c[1] = p[1];
    if (p[0] > c[2]) c[2] = p[0];
    if (p[1] > c[3]) c[3] = p[1];
  }
  return c;
};
const caixasSeTocam = (a, b, folga) => a[0] - folga <= b[2] && b[0] - folga <= a[2] && a[1] - folga <= b[3] && b[1] - folga <= a[3];

/** Só atributos públicos e úteis em campo: classe, nome (ou referência, ex.: "PR-493") e superfície. */
function atributosVia(tags) {
  const props = { h: tags.highway };
  const nome = String(tags.name || tags.ref || "").trim();
  if (nome) props.n = nome;
  if (tags.surface) props.s = String(tags.surface);
  return props;
}

/** Vias do OSM que interessam no mapa rural. */
function viaAceita(via) {
  if (via.type !== "way" || !Array.isArray(via.geometry) || via.geometry.length < 2 || !via.tags) return false;
  if (!ORDEM_CLASSE.has(via.tags.highway)) return false;
  if (via.tags.area === "yes") return false;
  if (via.tags.service === "parking_aisle") return false;
  return true;
}

/**
 * Recorta as vias do OSM pelos territórios rurais.
 * @param osm resposta da Overpass ({ elements: [{ type, id, tags, geometry: [{lat, lon}] }] })
 * @param rurais [{ numero, partes: [[externo, ...furos], ...] em [lng, lat] }]
 * @returns features GeoJSON (LineString), ordenadas por território, classe e id da via
 */
function gerarFeatures(osm, rurais, op = {}) {
  const margem = op.margemM !== undefined ? op.margemM : PADROES.margemM;
  const tol = op.toleranciaM !== undefined ? op.toleranciaM : PADROES.toleranciaM;
  const passo = op.passoM || PADROES.passoM;
  if (!rurais.length) return [];

  const caixaGeral = caixaDe(rurais.flatMap(t => t.partes.map(p => p[0])).flat());
  const proj = Geo.criarProjecao((caixaGeral[1] + caixaGeral[3]) / 2, (caixaGeral[0] + caixaGeral[2]) / 2);
  const territoriosXY = rurais.map(t => {
    const partesXY = t.partes.map(parte => parte.map(anel => anel.map(c => proj.paraXY(c[1], c[0]))));
    return { numero: t.numero, partesXY, caixa: caixaDe(partesXY.map(p => p[0]).flat()) };
  });

  const itens = [];
  for (const via of osm.elements || []) {
    if (!viaAceita(via)) continue;
    const pts = via.geometry.map(g => proj.paraXY(g.lat, g.lon));
    const caixaVia = caixaDe(pts);
    const props = atributosVia(via.tags);
    for (const t of territoriosXY) {
      if (!caixasSeTocam(caixaVia, t.caixa, margem)) continue;
      for (const trecho of recortarLinha(pts, t.partesXY, margem, passo)) {
        const coords = [];
        for (const p of simplificarLinha(trecho, tol)) {
          const [lat, lng] = proj.paraLatLng(p[0], p[1]);
          const c = [Number(lng.toFixed(5)), Number(lat.toFixed(5))];
          const u = coords[coords.length - 1];
          if (!u || u[0] !== c[0] || u[1] !== c[1]) coords.push(c);
        }
        if (coords.length < 2) continue;
        itens.push({ numero: t.numero, ordem: ORDEM_CLASSE.get(props.h), id: Number(via.id) || 0, coords, props });
      }
    }
  }
  itens.sort((a, b) => a.numero - b.numero || a.ordem - b.ordem || a.id - b.id);
  return itens.map(i => ({
    type: "Feature",
    properties: Object.assign({ NUM_TERR: i.numero }, i.props),
    geometry: { type: "LineString", coordinates: i.coords }
  }));
}

/** Texto do arquivo: uma feature por linha (diff legível, como quadras.geojson). */
function serializar(features, dataOsm) {
  const cabecalho = {
    type: "FeatureCollection",
    name: "vias-rurais",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } },
    fonte: "© OpenStreetMap contributors (ODbL) — gerado por scripts/rurais/gerar-vias-rurais.js",
    dadosOsm: dataOsm || ""
  };
  return "{\n" + Object.entries(cabecalho).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n") +
    ',\n"features": [\n' + features.map(f => JSON.stringify(f)).join(",\n") + "\n]\n}\n";
}

function comprimentoKm(coords) {
  const proj = Geo.criarProjecao(coords[0][1], coords[0][0]);
  let soma = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = proj.paraXY(coords[i - 1][1], coords[i - 1][0]), b = proj.paraXY(coords[i][1], coords[i][0]);
    soma += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return soma / 1000;
}

async function principal() {
  const op = lerArgumentos(process.argv.slice(2));
  if (op.ajuda) { console.log(AJUDA); return; }

  const territorios = Osm.classificarPorArea(Osm.carregarTerritorios(op.territorios), op);
  const rurais = territorios.filter(t => !t.urbano);
  if (!rurais.length) throw new Error("Nenhum território rural encontrado.");
  console.log(`Territórios rurais (${rurais.length}): ${rurais.map(t => t.numero).join(", ")}`);

  // A margem precisa caber na caixa enviada à Overpass (passo de 0,005° ≈ 500 m)
  const caixa = Osm.caixaDosTerritorios(rurais, 0.005);
  console.log(`Caixa enviada à Overpass (S,O,N,L): ${caixa.join(", ")}`);
  const osm = await Osm.baixarMalhaViaria(caixa, {
    tipos: CLASSES_VIA, cache: op.cache, atualizarOsm: op.atualizarOsm, prefixo: "vias-rurais",
    agente: "gerar-vias-rurais/1.0 (script offline)"
  });

  const t0 = Date.now();
  const features = gerarFeatures(osm, rurais, op);
  console.log(`Recorte: ${features.length} trechos em ${Date.now() - t0} ms.`);

  const porTerritorio = new Map();
  const porClasse = new Map();
  for (const f of features) {
    const km = comprimentoKm(f.geometry.coordinates);
    porTerritorio.set(f.properties.NUM_TERR, (porTerritorio.get(f.properties.NUM_TERR) || 0) + km);
    porClasse.set(f.properties.h, (porClasse.get(f.properties.h) || 0) + km);
  }
  console.log("\nkm por classe: " + CLASSES_VIA.filter(c => porClasse.has(c)).map(c => `${c} ${porClasse.get(c).toFixed(0)}`).join(" · "));
  console.log("km por território: " + rurais.map(t => `${t.numero}:${(porTerritorio.get(t.numero) || 0).toFixed(0)}`).join(" · "));
  const semVias = rurais.filter(t => !porTerritorio.has(t.numero)).map(t => t.numero);
  if (semVias.length) console.log(`Sem nenhuma via do OSM: ${semVias.join(", ")}`);

  if (!op.semGravar) {
    const dataOsm = (osm.osm3s && osm.osm3s.timestamp_osm_base) || osm._baixadoEm || "";
    const texto = serializar(features, dataOsm);
    fs.writeFileSync(op.saida, texto);
    console.log(`\nGravado: ${op.saida} (${features.length} trechos, ${(texto.length / 1024).toFixed(0)} KB)`);
  }
}

if (require.main === module) {
  principal().catch(e => { console.error("ERRO: " + e.message); process.exit(1); });
}

module.exports = { CLASSES_VIA, densificar, simplificarLinha, recortarLinha, atributosVia, viaAceita, gerarFeatures, serializar };
