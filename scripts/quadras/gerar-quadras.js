#!/usr/bin/env node
/**
 * Gera quadras.geojson a partir da malha viária do OpenStreetMap (substitui o fluxo manual
 * QuickOSM → poligonizar → recortar → remover lascas do QGIS).
 *
 * Uso (na raiz do projeto, Node 18+; sem dependências):
 *   node scripts/quadras/gerar-quadras.js                 gera/atualiza quadras.geojson
 *   node scripts/quadras/gerar-quadras.js --relatorio     também grava um HTML de conferência
 *   node scripts/quadras/gerar-quadras.js --ajuda         lista as opções
 *
 * Privacidade: a única informação enviada à Overpass API é a caixa delimitadora dos territórios
 * urbanos e o filtro de `highway`. A resposta fica em cache local (scripts/quadras/.cache/,
 * fora do versionamento) e só é baixada de novo com --atualizar-osm.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Geo = require("../../js/geo.js");

const RAIZ = path.resolve(__dirname, "..", "..");

const PADROES = {
  territorios: path.join(RAIZ, "territorios_nortpb.geojson"),
  saida: path.join(RAIZ, "quadras.geojson"),
  cache: path.join(__dirname, ".cache"),
  // Território acima desta área é tratado como rural (só contorno, sem quadras)
  areaMaxUrbanoHa: 60,
  // Lasca: face menor que isto ou estreita demais (raio do maior círculo inscrito)
  areaMinM2: 400,
  raioMinM: 7,
  // Face maior que isto dentro de território urbano é sinalizada para revisão
  areaRevisaoHa: 6,
  margemM: 120,
  grade: 0.05,       // m — grade de encaixe dos vértices
  tolerancia: 0.06,  // m — tolerância de interseção/encostos
  // Vias que delimitam quadras. `service`, `track` e caminhos de pedestre ficam de fora.
  vias: ["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
    "living_street", "pedestrian", "road", "motorway_link", "trunk_link", "primary_link",
    "secondary_link", "tertiary_link"]
};

const SERVIDORES_OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];
// Superconjunto baixado (o filtro fino é local, para ajustar parâmetros sem baixar de novo)
const VIAS_BAIXADAS = PADROES.vias.concat(["service", "track"]);

function lerArgumentos(argv) {
  const op = {
    relatorio: false, atualizarOsm: false, renumerar: false, ajuda: false, semGravar: false,
    urbanos: new Set(), rurais: new Set(), comService: false
  };
  for (const a of argv) {
    const [chave, valor] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, ""];
    const lista = () => valor.split(",").map(Number).filter(Number.isFinite);
    if (chave === "--relatorio") op.relatorio = valor || true;
    else if (chave === "--atualizar-osm") op.atualizarOsm = true;
    else if (chave === "--renumerar") op.renumerar = true;
    else if (chave === "--sem-gravar") op.semGravar = true;
    else if (chave === "--com-service") op.comService = true;
    else if (chave === "--urbanos") lista().forEach(n => op.urbanos.add(n));
    else if (chave === "--rurais") lista().forEach(n => op.rurais.add(n));
    else if (chave === "--area-max-urbano-ha") op.areaMaxUrbanoHa = Number(valor);
    else if (chave === "--area-min") op.areaMinM2 = Number(valor);
    else if (chave === "--raio-min") op.raioMinM = Number(valor);
    else if (chave === "--territorios") op.territorios = path.resolve(valor);
    else if (chave === "--saida") op.saida = path.resolve(valor);
    else if (chave === "--ajuda" || chave === "-h") op.ajuda = true;
    else throw new Error(`Opção desconhecida: ${a} (use --ajuda)`);
  }
  return Object.assign({}, PADROES, Object.fromEntries(Object.entries(op).filter(([, v]) => v !== undefined)));
}

const AJUDA = `
Gera quadras.geojson a partir das ruas do OpenStreetMap.

  --relatorio[=arquivo.html]   grava um HTML de conferência (padrão: pasta temporária do sistema)
  --atualizar-osm              baixa a malha viária de novo (ignora o cache local)
  --renumerar                  refaz a numeração do zero (padrão: preserva NUM_QUADRA dos IDs
                               já existentes em quadras.geojson e dá n+1 às quadras novas)
  --sem-gravar                 só calcula e mostra a validação
  --urbanos=58,90              força territórios a terem quadras (mesmo acima do limite de área)
  --rurais=46,50               força territórios a ficarem só com o contorno
  --area-max-urbano-ha=60      limite de área para tratar um território como urbano
  --area-min=400               área mínima (m²) de uma quadra; abaixo disso é lasca
  --raio-min=7                 largura mínima: raio (m) do maior círculo inscrito
  --com-service                inclui vias highway=service como limite de quadra
`;

// ---------------------------------------------------------------------------------------------
// 1. Territórios
// ---------------------------------------------------------------------------------------------
function carregarTerritorios(arquivo) {
  const geo = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  return geo.features.map(f => {
    const g = f.geometry;
    const poligonos = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    return {
      numero: Number(f.properties.NUM_TERR),
      // partes[i] = [externo, ...furos] em [lng, lat] (sem Z)
      partes: poligonos.map(pol => pol.map(anel => anel.map(c => [c[0], c[1]])))
    };
  }).sort((a, b) => a.numero - b.numero);
}

// ---------------------------------------------------------------------------------------------
// 2. Malha viária (Overpass API com cache local, novas tentativas e servidores alternativos)
// ---------------------------------------------------------------------------------------------
const esperar = ms => new Promise(r => setTimeout(r, ms));

async function baixarMalhaViaria(caixa, op) {
  // caixa = [sul, oeste, norte, leste] arredondada para fora em 0,005° (~500 m)
  const chave = caixa.map(v => v.toFixed(3)).join("_");
  const arquivo = path.join(op.cache, `overpass_${chave}.json`);
  if (!op.atualizarOsm && fs.existsSync(arquivo)) {
    const dados = JSON.parse(fs.readFileSync(arquivo, "utf8"));
    console.log(`Malha viária: cache local (${dados.elements.length} vias, baixado em ${dados._baixadoEm || "?"}).`);
    return dados;
  }

  const consulta = `[out:json][timeout:120];way["highway"~"^(${VIAS_BAIXADAS.join("|")})$"](${caixa.join(",")});out tags geom;`;
  let ultimoErro = null;
  for (let tentativa = 0; tentativa < 6; tentativa++) {
    const servidor = SERVIDORES_OVERPASS[tentativa % SERVIDORES_OVERPASS.length];
    if (tentativa > 0) {
      const espera = Math.min(60000, 4000 * 2 ** (tentativa - 1));
      console.log(`  nova tentativa em ${espera / 1000}s (${ultimoErro})...`);
      await esperar(espera);
    }
    try {
      console.log(`Malha viária: consultando ${new URL(servidor).host}...`);
      const resposta = await fetch(servidor, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "gerar-quadras/1.0 (script offline)" },
        body: "data=" + encodeURIComponent(consulta),
        signal: AbortSignal.timeout(150000)
      });
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
      const dados = JSON.parse(await resposta.text());
      if (!Array.isArray(dados.elements)) throw new Error("resposta sem 'elements'");
      if (dados.remark && /error|timed out/i.test(dados.remark)) throw new Error(dados.remark);
      dados._baixadoEm = new Date().toISOString();
      dados._caixa = caixa;
      fs.mkdirSync(op.cache, { recursive: true });
      fs.writeFileSync(arquivo, JSON.stringify(dados));
      console.log(`Malha viária: ${dados.elements.length} vias baixadas e guardadas em cache.`);
      return dados;
    } catch (e) {
      ultimoErro = e.message;
    }
  }
  throw new Error(`Não foi possível baixar a malha viária da Overpass API: ${ultimoErro}`);
}

// ---------------------------------------------------------------------------------------------
// 3. Poligonização: faces do grafo planar formado por ruas + limites dos territórios
// ---------------------------------------------------------------------------------------------
function poligonizar(segmentosBrutos, op) {
  const G = op.grade, TOL = op.tolerancia;
  const encaixar = v => Math.round(v / G) * G;

  // 3.1 Segmentos com extremos encaixados na grade
  const segs = [];
  for (const s of segmentosBrutos) {
    const a = [encaixar(s[0]), encaixar(s[1])], b = [encaixar(s[2]), encaixar(s[3])];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    segs.push({ a, b, cortes: [] });
  }

  // 3.2 Nós: toda interseção, encosto em T e sobreposição colinear vira ponto de corte
  const CELULA = 60;
  const celulas = new Map();
  segs.forEach((s, i) => {
    const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / CELULA), x1 = Math.floor(Math.max(s.a[0], s.b[0]) / CELULA);
    const y0 = Math.floor(Math.min(s.a[1], s.b[1]) / CELULA), y1 = Math.floor(Math.max(s.a[1], s.b[1]) / CELULA);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const k = cx + ":" + cy;
      let lista = celulas.get(k);
      if (!lista) celulas.set(k, lista = []);
      lista.push(i);
    }
  });

  const parametro = (s, p) => {
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
    return ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / (dx * dx + dy * dy);
  };
  const distanciaAReta = (s, p) => {
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
    return Math.abs((p[0] - s.a[0]) * dy - (p[1] - s.a[1]) * dx) / Math.hypot(dx, dy);
  };
  const cortar = (s, p) => {
    const t = parametro(s, p);
    const tolT = TOL / Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    if (t > tolT && t < 1 - tolT) s.cortes.push({ t, p });
  };

  const vistos = new Set();
  for (const lista of celulas.values()) {
    for (let i = 0; i < lista.length; i++) for (let j = i + 1; j < lista.length; j++) {
      const ia = lista[i], ib = lista[j];
      const chave = ia < ib ? ia * 4194304 + ib : ib * 4194304 + ia;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      const s1 = segs[ia], s2 = segs[ib];

      // Extremos de um segmento que encostam no outro (T, colinear): corta no próprio extremo,
      // para os dois lados compartilharem exatamente o mesmo vértice
      let encostos = 0;
      for (const p of [s2.a, s2.b]) {
        const t = parametro(s1, p);
        if (t > 0 && t < 1 && distanciaAReta(s1, p) <= TOL) { cortar(s1, p); encostos++; }
      }
      for (const p of [s1.a, s1.b]) {
        const t = parametro(s2, p);
        if (t > 0 && t < 1 && distanciaAReta(s2, p) <= TOL) { cortar(s2, p); encostos++; }
      }
      if (encostos) continue;

      // Cruzamento propriamente dito
      const rx = s1.b[0] - s1.a[0], ry = s1.b[1] - s1.a[1];
      const sx = s2.b[0] - s2.a[0], sy = s2.b[1] - s2.a[1];
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-9) continue;
      const qx = s2.a[0] - s1.a[0], qy = s2.a[1] - s1.a[1];
      const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
      if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue;
      const p = [encaixar(s1.a[0] + t * rx), encaixar(s1.a[1] + t * ry)];
      cortar(s1, p);
      cortar(s2, p);
    }
  }

  // 3.3 Grafo: nós únicos e arestas sem duplicatas
  const nos = [];           // [x, y]
  const indiceNo = new Map();
  const obterNo = p => {
    const k = Math.round(p[0] / G) + ":" + Math.round(p[1] / G);
    let id = indiceNo.get(k);
    if (id === undefined) { id = nos.length; nos.push([p[0], p[1]]); indiceNo.set(k, id); }
    return id;
  };
  const arestas = new Map(); // "u:v" (u<v) → true
  for (const s of segs) {
    s.cortes.sort((c1, c2) => c1.t - c2.t);
    const pontos = [s.a, ...s.cortes.map(c => c.p), s.b];
    for (let i = 0; i + 1 < pontos.length; i++) {
      const u = obterNo(pontos[i]), v = obterNo(pontos[i + 1]);
      if (u !== v) arestas.set(u < v ? u + ":" + v : v + ":" + u, true);
    }
  }

  let vizinhos = nos.map(() => new Set());
  for (const k of arestas.keys()) {
    const [u, v] = k.split(":").map(Number);
    vizinhos[u].add(v);
    vizinhos[v].add(u);
  }

  // 3.4 Remove pontas soltas (ruas sem saída) e pontes; repete até estabilizar
  const podar = () => {
    const fila = [];
    vizinhos.forEach((viz, u) => { if (viz.size === 1) fila.push(u); });
    while (fila.length) {
      const u = fila.pop();
      if (vizinhos[u].size !== 1) continue;
      const v = vizinhos[u].values().next().value;
      vizinhos[u].delete(v);
      vizinhos[v].delete(u);
      if (vizinhos[v].size === 1) fila.push(v);
    }
  };

  let ciclos = [];
  for (let rodada = 0; rodada < 20; rodada++) {
    podar();
    // Meias-arestas ordenadas por ângulo em cada nó
    const ordenados = vizinhos.map((viz, u) => Array.from(viz).sort((a, b) =>
      Math.atan2(nos[a][1] - nos[u][1], nos[a][0] - nos[u][0]) - Math.atan2(nos[b][1] - nos[u][1], nos[b][0] - nos[u][0])));
    const posicao = ordenados.map(lista => new Map(lista.map((v, i) => [v, i])));
    const faceDe = new Map(); // "u>v" → índice do ciclo
    ciclos = [];
    for (let u0 = 0; u0 < nos.length; u0++) {
      for (const v0 of ordenados[u0]) {
        if (faceDe.has(u0 + ">" + v0)) continue;
        const ciclo = [];
        let u = u0, v = v0;
        do {
          faceDe.set(u + ">" + v, ciclos.length);
          ciclo.push(u);
          // Em v, segue pela aresta imediatamente no sentido horário a partir de v→u (face à esquerda)
          const lista = ordenados[v];
          const prox = lista[(posicao[v].get(u) - 1 + lista.length) % lista.length];
          u = v;
          v = prox;
        } while (u !== u0 || v !== v0);
        ciclos.push(ciclo);
      }
    }
    // Ponte: aresta com a mesma face dos dois lados — não delimita quadra
    let pontes = 0;
    vizinhos.forEach((viz, u) => {
      for (const v of Array.from(viz)) {
        if (u < v && faceDe.get(u + ">" + v) === faceDe.get(v + ">" + u)) {
          vizinhos[u].delete(v);
          vizinhos[v].delete(u);
          pontes++;
        }
      }
    });
    if (!pontes) break;
  }

  // 3.5 Faces internas (anti-horárias) e contornos de componentes (horários → furos em potencial)
  const faces = [], contornos = [];
  for (const ciclo of ciclos) {
    const anel = ciclo.map(u => nos[u]);
    const area = Geo.areaAnel(anel);
    if (area > 0) faces.push({ poligono: [anel], area, caixa: caixaDe(anel) });
    else if (area < 0) contornos.push({ anel, area: -area, caixa: caixaDe(anel) });
  }
  // Um componente isolado dentro de uma face vira furo da menor face que o contém
  let furos = 0;
  for (const c of contornos) {
    const p = c.anel[0];
    let melhor = null;
    for (const f of faces) {
      if (f.area <= c.area || !caixaContem(f.caixa, c.caixa)) continue;
      if (Geo.pontoEmAnel(p[0], p[1], f.poligono[0]) && (!melhor || f.area < melhor.area)) melhor = f;
    }
    if (melhor) { melhor.poligono.push(c.anel.slice().reverse()); furos++; }
  }
  for (const f of faces) f.area = Geo.areaPoligono(f.poligono);
  return { faces, nos: nos.length, arestas: arestas.size, furos };
}

function caixaDe(anel) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of anel) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return [minX, minY, maxX, maxY];
}
const caixaContem = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];

/** Remove vértices colineares/repetidos de um anel (tolerância em metros). */
function simplificarAnel(anel, tol) {
  let atual = anel;
  for (let passada = 0; passada < 3; passada++) {
    const saida = [];
    const n = atual.length;
    for (let i = 0; i < n; i++) {
      const ant = saida.length ? saida[saida.length - 1] : atual[(i - 1 + n) % n];
      const p = atual[i], prox = atual[(i + 1) % n];
      const dx = prox[0] - ant[0], dy = prox[1] - ant[1];
      const base = Math.hypot(dx, dy);
      const desvio = base ? Math.abs((p[0] - ant[0]) * dy - (p[1] - ant[1]) * dx) / base : Math.hypot(p[0] - ant[0], p[1] - ant[1]);
      // Só descarta se p estiver entre os vizinhos (não remove "bicos" que voltam sobre si)
      const entre = base && ((p[0] - ant[0]) * dx + (p[1] - ant[1]) * dy) >= 0 && ((p[0] - prox[0]) * -dx + (p[1] - prox[1]) * -dy) >= 0;
      if (desvio <= tol && entre && n - (i - saida.length) > 3) continue;
      saida.push(p);
    }
    if (saida.length === atual.length || saida.length < 3) break;
    atual = saida;
  }
  return atual;
}

// ---------------------------------------------------------------------------------------------
// 4. Programa principal
// ---------------------------------------------------------------------------------------------
async function principal() {
  const op = lerArgumentos(process.argv.slice(2));
  if (op.ajuda) { console.log(AJUDA); return; }

  const territorios = carregarTerritorios(op.territorios);
  let latSoma = 0, lngSoma = 0, cont = 0;
  for (const t of territorios) for (const parte of t.partes) for (const c of parte[0]) { lngSoma += c[0]; latSoma += c[1]; cont++; }

  // Classificação urbano/rural: o geojson não traz o tipo, então usa-se a área (com exceções manuais)
  const projPrevia = Geo.criarProjecao(latSoma / cont, lngSoma / cont);
  for (const t of territorios) {
    t.areaM2 = t.partes.reduce((s, parte) => s + Geo.areaPoligono(parte.map(anel => anel.map(c => projPrevia.paraXY(c[1], c[0])))), 0);
    t.urbano = op.urbanos.has(t.numero) || (!op.rurais.has(t.numero) && t.areaM2 <= op.areaMaxUrbanoHa * 1e4);
  }
  const urbanos = territorios.filter(t => t.urbano);
  const rurais = territorios.filter(t => !t.urbano);
  if (!urbanos.length) throw new Error("Nenhum território urbano encontrado.");

  // Caixa delimitadora dos urbanos (+ margem), arredondada para fora
  let sul = Infinity, oeste = Infinity, norte = -Infinity, leste = -Infinity;
  for (const t of urbanos) for (const parte of t.partes) for (const c of parte[0]) {
    if (c[1] < sul) sul = c[1];
    if (c[1] > norte) norte = c[1];
    if (c[0] < oeste) oeste = c[0];
    if (c[0] > leste) leste = c[0];
  }
  const passo = 0.005;
  const caixa = [Math.floor(sul / passo) * passo - passo, Math.floor(oeste / passo) * passo - passo,
    Math.ceil(norte / passo) * passo + passo, Math.ceil(leste / passo) * passo + passo].map(v => Number(v.toFixed(3)));
  console.log(`Territórios: ${territorios.length} (${urbanos.length} urbanos, ${rurais.length} rurais — só contorno).`);
  console.log(`Caixa enviada à Overpass (S,O,N,L): ${caixa.join(", ")}`);

  const osm = await baixarMalhaViaria(caixa, op);
  const proj = Geo.criarProjecao((caixa[0] + caixa[2]) / 2, (caixa[1] + caixa[3]) / 2);
  const xy = c => proj.paraXY(c[1], c[0]);

  // Territórios em metros
  for (const t of territorios) {
    t.partesXY = t.partes.map(parte => parte.map(anel => {
      const pts = anel.map(xy);
      const u = pts[pts.length - 1];
      if (pts.length > 1 && u[0] === pts[0][0] && u[1] === pts[0][1]) pts.pop(); // anel aberto
      return pts;
    }));
    t.caixasXY = t.partesXY.map(parte => caixaDe(parte[0]));
  }

  // Segmentos: ruas (filtradas) + limites dos territórios urbanos
  const tiposVia = new Set(op.vias.concat(op.comService ? ["service"] : []));
  const segmentos = [];
  const ruasDesenho = [];
  let viasUsadas = 0;
  for (const via of osm.elements) {
    if (via.type !== "way" || !Array.isArray(via.geometry) || !via.tags) continue;
    if (!tiposVia.has(via.tags.highway)) continue;
    if (via.tags.area === "yes") continue;
    viasUsadas++;
    const pts = via.geometry.map(g => proj.paraXY(g.lat, g.lon));
    ruasDesenho.push(pts);
    for (let i = 0; i + 1 < pts.length; i++) segmentos.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]);
  }
  const segRuas = segmentos.length;
  for (const t of urbanos) for (const parte of t.partesXY) for (const anel of parte) {
    for (let i = 0; i < anel.length; i++) {
      const a = anel[i], b = anel[(i + 1) % anel.length];
      segmentos.push([a[0], a[1], b[0], b[1]]);
    }
  }
  console.log(`Vias usadas como limite de quadra: ${viasUsadas} (${segRuas} segmentos) + ${segmentos.length - segRuas} segmentos de limites.`);

  const t0 = Date.now();
  const grafo = poligonizar(segmentos, op);
  console.log(`Poligonização: ${grafo.nos} nós, ${grafo.arestas} arestas, ${grafo.faces.length} faces, ${grafo.furos} furo(s) — ${Date.now() - t0} ms.`);

  // Atribui cada face ao território urbano que contém seu ponto de rótulo
  const porTerritorio = new Map(urbanos.map(t => [t.numero, { t, quadras: [], lascas: [] }]));
  for (const face of grafo.faces) {
    const polo = Geo.polylabel(face.poligono, 0.5);
    let dono = null;
    for (const t of urbanos) {
      for (let i = 0; i < t.partesXY.length && !dono; i++) {
        const cx = t.caixasXY[i];
        if (polo.x < cx[0] || polo.x > cx[2] || polo.y < cx[1] || polo.y > cx[3]) continue;
        if (Geo.pontoEmPoligono(polo.x, polo.y, t.partesXY[i])) dono = t;
      }
      if (dono) break;
    }
    if (!dono) continue;
    const item = { poligono: face.poligono, area: face.area, polo };
    const grupo = porTerritorio.get(dono.numero);
    if (face.area < op.areaMinM2 || polo.distancia < op.raioMinM) grupo.lascas.push(item);
    else grupo.quadras.push(item);
  }

  // Numeração anterior (para preservar números entre execuções)
  const anteriores = new Map();
  if (!op.renumerar && fs.existsSync(op.saida)) {
    try {
      for (const f of JSON.parse(fs.readFileSync(op.saida, "utf8")).features) {
        anteriores.set(`${f.properties.NUM_TERR}|${f.properties.ID_QUADRA}`, Number(f.properties.NUM_QUADRA));
      }
    } catch (e) { console.warn("Aviso: quadras.geojson existente ilegível; numerando do zero."); }
  }

  const features = [];
  const linhas = [];
  const alertas = [];
  const idsUsados = new Set();
  for (const { t, quadras, lascas } of porTerritorio.values()) {
    let semMalha = false;
    if (!quadras.length) {
      // Sem quadra resultante: a quadra passa a ser o próprio território (rótulo na maior parte;
      // as demais partes entram na mesma feição como MultiPolygon)
      semMalha = true;
      const partes = t.partesXY.slice().sort((a, b) => Geo.areaPoligono(b) - Geo.areaPoligono(a));
      quadras.push({
        poligono: partes[0],
        extras: partes.slice(1),
        area: partes.reduce((s, p) => s + Geo.areaPoligono(p), 0),
        polo: Geo.polylabel(partes[0], 0.5)
      });
    }
    for (const q of quadras) {
      if (!q.extras) q.poligono = q.poligono.map(anel => simplificarAnel(anel, 0.15));
      const ll = proj.paraLatLng(q.polo.x, q.polo.y);
      q.lat = Number(ll[0].toFixed(6));
      q.lng = Number(ll[1].toFixed(6));
      let id = Geo.idQuadra(q.lat, q.lng), sufixo = 1;
      while (idsUsados.has(id)) id = Geo.idQuadra(q.lat, q.lng) + "-" + (++sufixo);
      idsUsados.add(id);
      q.id = id;
    }

    // Serpentina; IDs já numerados numa execução anterior mantêm o número e os novos recebem n+1
    const ordem = Geo.numerarSerpentina(quadras.map(q => ({ x: q.polo.x, y: q.polo.y, anel: q.poligono[0] })));
    const conhecidas = quadras.filter(q => anteriores.has(`${t.numero}|${q.id}`));
    if (conhecidas.length) {
      const usados = new Set();
      for (const q of conhecidas) { q.numero = anteriores.get(`${t.numero}|${q.id}`); usados.add(q.numero); }
      let prox = Math.max(...usados) + 1;
      quadras.map((q, i) => ({ q, o: ordem[i] })).filter(x => x.q.numero === undefined)
        .sort((a, b) => a.o - b.o).forEach(x => { x.q.numero = prox++; });
    } else {
      quadras.forEach((q, i) => { q.numero = ordem[i]; });
    }
    quadras.sort((a, b) => a.numero - b.numero);

    const areaQuadras = quadras.reduce((s, q) => s + q.area, 0);
    const cobertura = areaQuadras / t.areaM2;
    const areas = quadras.map(q => q.area).sort((a, b) => a - b);
    const motivos = [];
    if (semMalha) motivos.push("sem quadras pela malha (usa o próprio território)");
    else {
      if (cobertura < 0.85) motivos.push(`cobertura ${(cobertura * 100).toFixed(0)}%`);
      if (areas[areas.length - 1] > op.areaRevisaoHa * 1e4) motivos.push(`quadra de ${(areas[areas.length - 1] / 1e4).toFixed(1)} ha`);
      if (quadras.length === 1 && t.areaM2 > 3e4) motivos.push("uma única quadra");
      const pequenas = areas.filter(a => a < 1500).length;
      if (pequenas) motivos.push(`${pequenas} quadra(s) menor(es) que 1.500 m² (canteiro/rotatória?)`);
      const areaLascas = lascas.reduce((s, q) => s + q.area, 0);
      if (areaLascas / t.areaM2 > 0.05) motivos.push(`lascas somam ${(areaLascas / t.areaM2 * 100).toFixed(0)}% da área`);
    }
    if (motivos.length) alertas.push({ numero: t.numero, motivos });
    linhas.push({ numero: t.numero, areaHa: t.areaM2 / 1e4, quadras: quadras.length, lascas: lascas.length, cobertura, semMalha,
      min: areas[0], mediana: areas[Math.floor(areas.length / 2)], max: areas[areas.length - 1] });

    for (const q of quadras) {
      const paraCoords = poligono => poligono.map(anel => {
        const fechado = anel.map(p => { const g = proj.paraLatLng(p[0], p[1]); return [Number(g[1].toFixed(7)), Number(g[0].toFixed(7))]; });
        fechado.push(fechado[0].slice());
        return fechado;
      });
      features.push({
        type: "Feature",
        properties: { NUM_TERR: t.numero, ID_QUADRA: q.id, NUM_QUADRA: q.numero, ROTULO: String(q.numero), LABEL_LNG: q.lng, LABEL_LAT: q.lat },
        geometry: q.extras && q.extras.length
          ? { type: "MultiPolygon", coordinates: [q.poligono].concat(q.extras).map(paraCoords) }
          : { type: "Polygon", coordinates: paraCoords(q.poligono) }
      });
    }
    porTerritorio.get(t.numero).quadras = quadras;
  }

  // ------------------------------------------------------------------ validação
  const todas = features.length;
  const comMalha = linhas.filter(l => !l.semMalha);
  const areasTodas = [];
  for (const g of porTerritorio.values()) if (!linhas.find(l => l.numero === g.t.numero).semMalha) for (const q of g.quadras) areasTodas.push(q.area);
  areasTodas.sort((a, b) => a - b);
  const pct = p => areasTodas.length ? areasTodas[Math.min(areasTodas.length - 1, Math.floor(p * areasTodas.length))] : 0;
  const contagens = linhas.map(l => l.quadras).sort((a, b) => a - b);

  console.log("\n================ VALIDAÇÃO ================");
  console.log(`Territórios urbanos: ${urbanos.length} | com quadras pela malha viária: ${comMalha.length} | sem malha (quadra = território): ${linhas.length - comMalha.length}`);
  console.log(`Territórios rurais (só contorno, sem quadras): ${rurais.length} → ${rurais.map(t => t.numero).join(", ")}`);
  console.log(`Total de quadras gravadas: ${todas}`);
  console.log(`Quadras por território: mín ${contagens[0]}, mediana ${contagens[Math.floor(contagens.length / 2)]}, máx ${contagens[contagens.length - 1]}`);
  console.log(`Área das quadras (malha): mín ${pct(0).toFixed(0)} m² | p10 ${pct(0.1).toFixed(0)} | mediana ${pct(0.5).toFixed(0)} m² (${(pct(0.5) / 1e4).toFixed(2)} ha) | p90 ${pct(0.9).toFixed(0)} | máx ${(pct(1) / 1e4).toFixed(2)} ha`);
  console.log("\nTerr  Área(ha)  Quadras  Lascas  Cobertura  Mín(m²)  Mediana(m²)  Máx(m²)");
  for (const l of linhas) {
    console.log(`${String(l.numero).padStart(4)}  ${l.areaHa.toFixed(1).padStart(8)}  ${String(l.quadras).padStart(7)}  ${String(l.lascas).padStart(6)}  ${(l.cobertura * 100).toFixed(0).padStart(8)}%  ${l.min.toFixed(0).padStart(7)}  ${l.mediana.toFixed(0).padStart(11)}  ${l.max.toFixed(0).padStart(7)}${l.semMalha ? "  (sem malha)" : ""}`);
  }
  console.log(`\nTerritórios que pedem revisão manual (${alertas.length}):`);
  for (const a of alertas) console.log(`  ${String(a.numero).padStart(3)}: ${a.motivos.join("; ")}`);

  // ------------------------------------------------------------------ saída
  if (!op.semGravar) {
    const colecao = {
      type: "FeatureCollection",
      name: "quadras",
      crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } },
      fonte: "Geometria derivada de © OpenStreetMap contributors (ODbL) — gerado por scripts/quadras/gerar-quadras.js",
      features
    };
    const texto = "{\n" + Object.entries(colecao).filter(([k]) => k !== "features").map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n") +
      ',\n"features": [\n' + features.map(f => JSON.stringify(f)).join(",\n") + "\n]\n}\n";
    fs.writeFileSync(op.saida, texto);
    console.log(`\nGravado: ${op.saida} (${features.length} quadras, ${(texto.length / 1024).toFixed(0)} KB)`);
  }

  if (op.relatorio) {
    const arquivo = typeof op.relatorio === "string" ? path.resolve(op.relatorio) : path.join(os.tmpdir(), "quadras-conferencia.html");
    fs.writeFileSync(arquivo, gerarRelatorioHtml(porTerritorio, ruasDesenho, linhas, alertas));
    console.log(`Relatório de conferência: ${arquivo}`);
  }
}

// ---------------------------------------------------------------------------------------------
// 5. HTML de conferência (um SVG por território, sem dependências nem rede)
// ---------------------------------------------------------------------------------------------
function gerarRelatorioHtml(porTerritorio, ruas, linhas, alertas) {
  const alertaDe = new Map(alertas.map(a => [a.numero, a.motivos.join("; ")]));
  const cores = ["#bfdbfe", "#bbf7d0", "#fde68a", "#fecaca", "#ddd6fe", "#fed7aa", "#a5f3fc", "#f5d0fe"];
  const blocos = [];
  for (const { t, quadras, lascas } of porTerritorio.values()) {
    let cx = [Infinity, Infinity, -Infinity, -Infinity];
    for (const c of t.caixasXY) cx = [Math.min(cx[0], c[0]), Math.min(cx[1], c[1]), Math.max(cx[2], c[2]), Math.max(cx[3], c[3])];
    const m = Math.max(cx[2] - cx[0], cx[3] - cx[1]) * 0.08 + 10;
    cx = [cx[0] - m, cx[1] - m, cx[2] + m, cx[3] + m];
    const L = cx[2] - cx[0], A = cx[3] - cx[1];
    const esc = 420 / Math.max(L, A);
    const P = p => `${((p[0] - cx[0]) * esc).toFixed(1)},${((cx[3] - p[1]) * esc).toFixed(1)}`;
    const caminho = pol => pol.map(anel => "M" + anel.map(P).join("L") + "Z").join("");
    const ruasVisiveis = ruas.filter(r => r.some(p => p[0] >= cx[0] && p[0] <= cx[2] && p[1] >= cx[1] && p[1] <= cx[3]));
    const linha = linhas.find(l => l.numero === t.numero);
    const fonte = Math.max(8, Math.min(13, 420 / Math.sqrt(quadras.length + 1) / 4));
    blocos.push(`
<figure class="${alertaDe.has(t.numero) ? "alerta" : ""}">
<figcaption><b>Território ${t.numero}</b> — ${linha.areaHa.toFixed(1)} ha, ${quadras.length} quadra(s), ${lascas.length} lasca(s), cobertura ${(linha.cobertura * 100).toFixed(0)}%
${alertaDe.has(t.numero) ? `<br><span>Revisar: ${alertaDe.get(t.numero)}</span>` : ""}</figcaption>
<svg viewBox="0 0 ${(L * esc).toFixed(0)} ${(A * esc).toFixed(0)}" width="${(L * esc).toFixed(0)}" height="${(A * esc).toFixed(0)}">
${quadras.map((q, i) => `<path d="${caminho(q.poligono)}" fill="${cores[i % cores.length]}" fill-rule="evenodd" stroke="#1e293b" stroke-width="0.6"/>`).join("")}
${lascas.map(q => `<path d="${caminho(q.poligono)}" fill="#ef4444" fill-opacity="0.7"/>`).join("")}
${ruasVisiveis.map(r => `<polyline points="${r.map(P).join(" ")}" fill="none" stroke="#64748b" stroke-width="1" stroke-opacity="0.55"/>`).join("")}
${t.partesXY.map(parte => `<path d="${caminho(parte)}" fill="none" stroke="#dc2626" stroke-width="2" stroke-dasharray="6 3"/>`).join("")}
${quadras.map(q => `<text x="${P([q.polo.x, q.polo.y]).split(",")[0]}" y="${P([q.polo.x, q.polo.y]).split(",")[1]}" font-size="${fonte.toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-weight="700">${q.numero}</text>`).join("")}
</svg></figure>`);
  }
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Conferência das quadras</title>
<style>body{font-family:system-ui,sans-serif;margin:16px;background:#f8fafc;color:#0f172a}
main{display:flex;flex-wrap:wrap;gap:14px}figure{margin:0;padding:8px;background:#fff;border:1px solid #cbd5e1;border-radius:8px}
figure.alerta{border-color:#f59e0b;background:#fffbeb}figcaption{font-size:12px;margin-bottom:4px;max-width:420px}figcaption span{color:#b45309}
svg{background:#f1f5f9;display:block}</style></head><body>
<h1>Conferência das quadras geradas</h1>
<p>Tracejado vermelho: limite do território. Cinza: ruas do OSM usadas. Vermelho cheio: lascas descartadas. Fundo âmbar: pede revisão.</p>
<main>${blocos.join("")}</main></body></html>`;
}

if (require.main === module) {
  principal().catch(e => { console.error("ERRO: " + e.message); process.exit(1); });
}

module.exports = { poligonizar, simplificarAnel };
