#!/usr/bin/env node
/**
 * Rascunho de territórios a partir do limite de outra cidade (spec 04, Fase 0/1).
 *
 * Lê um limite (KMZ, KML ou GeoJSON), valida, compara com os territórios atuais e, com
 * --subdividir, propõe CANDIDATOS de território cortando o limite pelas estradas do
 * OpenStreetMap e juntando as faces até uma área-alvo. É só rascunho: NÃO grava na planilha,
 * NÃO numera de verdade (C01, C02... são provisórios) e NÃO escreve dentro do repositório.
 * A revisão/ajuste final continua no QGIS (spec 04, Fase 1).
 *
 * Uso (na raiz do projeto, Node 18+; sem dependências):
 *   node scripts/territorios/rascunho-limite.js --limite="arquivo.kmz" --nome="Bom Sucesso"
 *   node scripts/territorios/rascunho-limite.js --limite=... --nome=... --subdividir --area-alvo-ha=1500
 *   node scripts/territorios/rascunho-limite.js --ajuda
 *
 * Privacidade: do KML/KMZ só são lidos os Placemarks com POLÍGONO; pontos (casas, endereços)
 * são ignorados sem serem interpretados. A saída fica numa pasta fora do repositório (padrão:
 * pasta temporária do sistema). À Overpass API vai só a caixa delimitadora do limite.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const Geo = require("../../js/geo.js");
const Osm = require("../lib/overpass.js");
const { poligonizar } = require("../quadras/gerar-quadras.js");

const RAIZ = path.resolve(__dirname, "..", "..");

const PADROES = {
  territorios: path.join(RAIZ, "territorios_nortpb.geojson"),
  saida: path.join(os.tmpdir(), "rascunho-territorios"),
  cache: path.join(__dirname, ".cache"),
  nome: "",
  cidade: "",
  subdividir: false,
  areaAlvoHa: 1500,          // ~ média dos 22 rurais atuais (37.640 ha / 22 ≈ 1.700 ha)
  atualizarOsm: false,
  // Estradas que dividem candidatos rurais (as menores ficam de fora para não picar demais)
  vias: ["motorway", "trunk", "primary", "secondary", "tertiary", "motorway_link", "trunk_link",
    "primary_link", "secondary_link", "tertiary_link", "unclassified"],
  grade: 0.5,                // m — encaixe dos vértices na poligonização (escala rural)
  tolerancia: 0.6,
  limiteCelulaWkt: 50000     // caracteres por célula do Google Sheets
};

const AJUDA = `
Rascunho de territórios a partir do limite de outra cidade (não grava na planilha).

  --limite=arquivo             KMZ, KML ou GeoJSON com o polígono do limite (obrigatório)
  --nome=texto                 escolhe o polígono pelo nome (parte do nome, sem diferenciar maiúsculas)
  --cidade=texto               nome da cidade para a coluna CIDADE do CSV (padrão: nome do polígono)
  --subdividir                 propõe candidatos cortando o limite pelas estradas do OSM
  --area-alvo-ha=1500          área-alvo de cada candidato
  --vias=a,b,c                 classes highway usadas como divisa (padrão: até unclassified)
  --atualizar-osm              baixa as estradas de novo (ignora o cache local)
  --saida=pasta                pasta de saída (padrão: ${PADROES.saida}); nunca dentro do repositório
`;

function lerArgumentos(argv) {
  const op = Object.assign({}, PADROES);
  for (const a of argv) {
    const [chave, valor] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, ""];
    if (chave === "--limite") op.limite = path.resolve(valor);
    else if (chave === "--nome") op.nome = valor;
    else if (chave === "--cidade") op.cidade = valor;
    else if (chave === "--subdividir") op.subdividir = true;
    else if (chave === "--area-alvo-ha") op.areaAlvoHa = Number(valor);
    else if (chave === "--vias") op.vias = valor.split(",").map(s => s.trim()).filter(Boolean);
    else if (chave === "--atualizar-osm") op.atualizarOsm = true;
    else if (chave === "--saida") op.saida = path.resolve(valor);
    else if (chave === "--territorios") op.territorios = path.resolve(valor);
    else if (chave === "--ajuda" || chave === "-h") op.ajuda = true;
    else throw new Error(`Opção desconhecida: ${a} (use --ajuda)`);
  }
  return op;
}

// ---------------------------------------------------------------------------------------------
// 1. Leitura do limite (KMZ / KML / GeoJSON) — só polígonos
// ---------------------------------------------------------------------------------------------

/** Lê os arquivos de um ZIP (KMZ) sem dependências: { nome → Buffer }. Só "stored" e "deflate". */
function lerZip(buffer, filtro = () => true) {
  // Fim do diretório central: assinatura 0x06054b50 nos últimos ~64 KB
  let fim = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { fim = i; break; }
  }
  if (fim < 0) throw new Error("arquivo KMZ/ZIP inválido (diretório central não encontrado)");
  const total = buffer.readUInt16LE(fim + 10);
  let p = buffer.readUInt32LE(fim + 16);
  const arquivos = {};
  for (let n = 0; n < total; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error("KMZ/ZIP inválido (entrada do diretório central)");
    const metodo = buffer.readUInt16LE(p + 10);
    const tamComp = buffer.readUInt32LE(p + 20);
    const lenNome = buffer.readUInt16LE(p + 28), lenExtra = buffer.readUInt16LE(p + 30), lenComent = buffer.readUInt16LE(p + 32);
    const local = buffer.readUInt32LE(p + 42);
    const nome = buffer.toString("utf8", p + 46, p + 46 + lenNome);
    p += 46 + lenNome + lenExtra + lenComent;
    if (!filtro(nome)) continue;
    const inicio = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const dados = buffer.subarray(inicio, inicio + tamComp);
    if (metodo === 0) arquivos[nome] = Buffer.from(dados);
    else if (metodo === 8) arquivos[nome] = zlib.inflateRawSync(dados);
    else throw new Error(`KMZ: compressão não suportada (${metodo}) em ${nome}`);
  }
  return arquivos;
}

const desescapar = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();

/** "lng,lat[,alt] lng,lat..." → [[lng, lat], ...] (anel fechado ou não). */
function lerCoordenadasKml(texto) {
  return texto.trim().split(/\s+/).map(t => t.split(",").map(Number)).filter(c => c.length >= 2 && isFinite(c[0]) && isFinite(c[1])).map(c => [c[0], c[1]]);
}

/**
 * Polígonos de um KML: [{ nome, partes: [[externo, ...furos], ...] }] em [lng, lat].
 * Placemarks sem <Polygon> (pontos, linhas) são descartados sem ler o conteúdo.
 */
function lerPoligonosKml(kml) {
  const resultado = [];
  for (const m of kml.matchAll(/<Placemark\b[\s\S]*?<\/Placemark>/g)) {
    const bloco = m[0];
    if (!/<Polygon\b/.test(bloco)) continue;
    const nomeM = /<name>([\s\S]*?)<\/name>/.exec(bloco);
    const partes = [];
    for (const pm of bloco.matchAll(/<Polygon\b[\s\S]*?<\/Polygon>/g)) {
      const pol = pm[0];
      const externo = /<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/.exec(pol);
      if (!externo) continue;
      const aneis = [lerCoordenadasKml(externo[1])];
      for (const im of pol.matchAll(/<innerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g)) aneis.push(lerCoordenadasKml(im[1]));
      if (aneis[0].length >= 4) partes.push(aneis.filter(a => a.length >= 4));
    }
    if (partes.length) resultado.push({ nome: nomeM ? desescapar(nomeM[1]) : "", partes });
  }
  return resultado;
}

/** Polígonos de um GeoJSON (Feature, FeatureCollection ou geometria). */
function lerPoligonosGeojson(geo) {
  const feats = geo.type === "FeatureCollection" ? geo.features : geo.type === "Feature" ? [geo] : [{ type: "Feature", properties: {}, geometry: geo }];
  const resultado = [];
  for (const f of feats) {
    const g = f.geometry || {};
    const pols = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    if (!pols.length) continue;
    const props = f.properties || {};
    const coord = pols.flat(2);
    if (coord.some(c => Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90)) {
      throw new Error("GeoJSON com coordenadas projetadas (ex.: UTM). Reprojete para WGS84/EPSG:4326 (QGIS ou mapshaper -proj wgs84).");
    }
    resultado.push({
      nome: String(props.name || props.nome || props.NOME || props.NM_MUN || props.Name || ""),
      partes: pols.map(pol => pol.map(anel => anel.map(c => [c[0], c[1]])))
    });
  }
  return resultado;
}

function lerLimite(arquivo) {
  const ext = path.extname(arquivo).toLowerCase();
  if (![".kmz", ".kml", ".geojson", ".json"].includes(ext)) {
    throw new Error(`Formato não suportado: ${ext} (use KMZ, KML ou GeoJSON; Shapefile: converta no QGIS/mapshaper)`);
  }
  const buf = fs.readFileSync(arquivo);
  if (ext === ".kmz") {
    const arquivos = lerZip(buf, nome => /\.kml$/i.test(nome));
    const kmls = Object.keys(arquivos);
    if (!kmls.length) throw new Error("KMZ sem arquivo .kml dentro");
    return kmls.flatMap(k => lerPoligonosKml(arquivos[k].toString("utf8")));
  }
  if (ext === ".kml") return lerPoligonosKml(buf.toString("utf8"));
  if (ext === ".geojson" || ext === ".json") return lerPoligonosGeojson(JSON.parse(buf.toString("utf8")));
  throw new Error(`Formato não suportado: ${ext} (use KMZ, KML ou GeoJSON; Shapefile: converta no QGIS/mapshaper)`);
}

function escolherPoligono(poligonos, nome) {
  if (!poligonos.length) throw new Error("Nenhum polígono encontrado no arquivo.");
  const alvo = nome ? poligonos.filter(p => p.nome.toLowerCase().includes(nome.toLowerCase())) : poligonos;
  if (alvo.length !== 1) {
    const lista = poligonos.map(p => `  - ${p.nome || "(sem nome)"}`).join("\n");
    throw new Error(`${alvo.length ? "Mais de um" : "Nenhum"} polígono corresponde a --nome="${nome}". Polígonos no arquivo:\n${lista}`);
  }
  return alvo[0];
}

// ---------------------------------------------------------------------------------------------
// 2. Geometria auxiliar (metros)
// ---------------------------------------------------------------------------------------------
const abrirAnel = anel => {
  const u = anel[anel.length - 1];
  return anel.length > 1 && u[0] === anel[0][0] && u[1] === anel[0][1] ? anel.slice(0, -1) : anel.slice();
};

function centroide(anel) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const f = anel[j][0] * anel[i][1] - anel[i][0] * anel[j][1];
    a += f; cx += (anel[j][0] + anel[i][0]) * f; cy += (anel[j][1] + anel[i][1]) * f;
  }
  return a ? [cx / (3 * a), cy / (3 * a)] : anel[0];
}

/**
 * Junta faces (polígonos que compartilham vértices exatos) num contorno só: arestas que
 * aparecem nos dois sentidos são internas e saem; as restantes são encadeadas em anéis.
 * Devolve partes [[externo, ...furos], ...] (externo anti-horário).
 */
function dissolver(faces) {
  const chave = p => p[0].toFixed(3) + "," + p[1].toFixed(3);
  const arestas = new Map();   // "a>b" → [pa, pb]
  for (const f of faces) for (const anel of f.poligono) {
    for (let i = 0; i < anel.length; i++) {
      const a = anel[i], b = anel[(i + 1) % anel.length];
      const ka = chave(a), kb = chave(b);
      if (ka === kb) continue;
      const inversa = kb + ">" + ka;
      if (arestas.has(inversa)) arestas.delete(inversa);
      else arestas.set(ka + ">" + kb, [a, b]);
    }
  }
  const saindo = new Map();
  for (const [k, seg] of arestas) {
    const ka = k.split(">")[0];
    if (!saindo.has(ka)) saindo.set(ka, []);
    saindo.get(ka).push(seg);
  }
  const aneis = [];
  for (const lista of saindo.values()) {
    while (lista.length) {
      const anel = [];
      let seg = lista.pop();
      const inicio = chave(seg[0]);
      for (let guarda = 0; guarda < 1e6; guarda++) {
        anel.push(seg[0]);
        const kb = chave(seg[1]);
        if (kb === inicio) break;
        const prox = saindo.get(kb);
        if (!prox || !prox.length) break;
        seg = prox.pop();
      }
      if (anel.length >= 3) aneis.push(anel);
    }
  }
  const externos = aneis.filter(a => Geo.areaAnel(a) > 0).map(a => [a]);
  for (const furo of aneis.filter(a => Geo.areaAnel(a) < 0)) {
    const dono = externos.find(p => Geo.pontoEmAnel(furo[0][0], furo[0][1], p[0]));
    if (dono) dono.push(furo);
  }
  return externos;
}

/**
 * Agrupa faces vizinhas em candidatos de ~areaAlvo m² (crescimento de região a partir do
 * norte/oeste; sobras pequenas vão para o vizinho menor).
 * faces: [{ poligono: [[x,y]...], area }] com vértices compartilhados exatos.
 */
function agruparFaces(faces, areaAlvo) {
  const chaveAresta = (a, b) => {
    const ka = a[0].toFixed(3) + "," + a[1].toFixed(3), kb = b[0].toFixed(3) + "," + b[1].toFixed(3);
    return ka < kb ? ka + "|" + kb : kb + "|" + ka;
  };
  const donosAresta = new Map();
  faces.forEach((f, i) => {
    f.centro = centroide(f.poligono[0]);
    const anel = f.poligono[0];
    for (let k = 0; k < anel.length; k++) {
      const ch = chaveAresta(anel[k], anel[(k + 1) % anel.length]);
      if (!donosAresta.has(ch)) donosAresta.set(ch, new Set());
      donosAresta.get(ch).add(i);
    }
  });
  const vizinhos = faces.map(() => new Set());
  for (const donos of donosAresta.values()) for (const a of donos) for (const b of donos) if (a !== b) vizinhos[a].add(b);

  const grupoDe = new Array(faces.length).fill(-1);
  const grupos = [];
  const ordem = faces.map((_, i) => i).sort((a, b) => (faces[b].centro[1] - faces[a].centro[1]) || (faces[a].centro[0] - faces[b].centro[0]));
  for (const semente of ordem) {
    if (grupoDe[semente] >= 0) continue;
    const g = { faces: [semente], area: faces[semente].area };
    grupoDe[semente] = grupos.length;
    grupos.push(g);
    const origem = faces[semente].centro;
    while (g.area < areaAlvo) {
      let melhor = -1, dist = Infinity;
      for (const f of g.faces) for (const v of vizinhos[f]) {
        if (grupoDe[v] >= 0) continue;
        const d = Math.hypot(faces[v].centro[0] - origem[0], faces[v].centro[1] - origem[1]);
        if (d < dist) { dist = d; melhor = v; }
      }
      if (melhor < 0 || g.area + faces[melhor].area > areaAlvo * 1.35) break;
      g.faces.push(melhor);
      grupoDe[melhor] = grupos.indexOf(g);
      g.area += faces[melhor].area;
    }
  }
  // Sobras (< 40% da área-alvo) vão para o grupo vizinho de menor área
  for (let mudou = true; mudou;) {
    mudou = false;
    for (let gi = 0; gi < grupos.length; gi++) {
      const g = grupos[gi];
      if (!g || g.area >= areaAlvo * 0.4) continue;
      let alvo = -1;
      for (const f of g.faces) for (const v of vizinhos[f]) {
        const o = grupoDe[v];
        if (o !== gi && o >= 0 && grupos[o] && (alvo < 0 || grupos[o].area < grupos[alvo].area)) alvo = o;
      }
      if (alvo < 0) continue;
      for (const f of g.faces) { grupos[alvo].faces.push(f); grupoDe[f] = alvo; }
      grupos[alvo].area += g.area;
      grupos[gi] = null;
      mudou = true;
    }
  }
  return grupos.filter(Boolean).map(g => g.faces.map(i => faces[i]));
}

// ---------------------------------------------------------------------------------------------
// 3. Candidatos
// ---------------------------------------------------------------------------------------------

/**
 * Corta o limite pelas estradas e agrupa as faces em candidatos.
 * @param limite { partes } em [lng, lat]; osm: resposta da Overpass; op: { vias, areaAlvoHa, grade, tolerancia }
 * @returns [{ id, partes (lng/lat), areaHa, kmVias, alertas: [] }]
 */
function gerarCandidatos(limite, osm, op) {
  const todos = limite.partes.flatMap(p => p[0]);
  const lat0 = todos.reduce((s, c) => s + c[1], 0) / todos.length, lng0 = todos.reduce((s, c) => s + c[0], 0) / todos.length;
  const proj = Geo.criarProjecao(lat0, lng0);
  const partesXY = limite.partes.map(parte => parte.map(anel => abrirAnel(anel).map(c => proj.paraXY(c[1], c[0]))));
  const dentroDoLimite = (x, y) => partesXY.some(p => Geo.pontoEmPoligono(x, y, p));

  const tipos = new Set(op.vias);
  const segmentos = [];
  const linhasVias = [];
  const linhasRuas = [];   // ruas de bairro (residential/living_street): indicam área urbana
  for (const via of (osm && osm.elements) || []) {
    if (via.type !== "way" || !Array.isArray(via.geometry) || !via.tags || via.tags.area === "yes") continue;
    if (/^(residential|living_street)$/.test(via.tags.highway)) linhasRuas.push(via.geometry.map(g => proj.paraXY(g.lat, g.lon)));
    if (!tipos.has(via.tags.highway)) continue;
    const pts = via.geometry.map(g => proj.paraXY(g.lat, g.lon));
    linhasVias.push(pts);
    for (let i = 0; i + 1 < pts.length; i++) segmentos.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]);
  }
  for (const parte of partesXY) for (const anel of parte) {
    for (let i = 0; i < anel.length; i++) {
      const a = anel[i], b = anel[(i + 1) % anel.length];
      segmentos.push([a[0], a[1], b[0], b[1]]);
    }
  }
  const grafo = poligonizar(segmentos, { grade: op.grade || PADROES.grade, tolerancia: op.tolerancia || PADROES.tolerancia });
  const dentro = grafo.faces.filter(f => {
    const polo = Geo.polylabel(f.poligono, 1);
    return dentroDoLimite(polo.x, polo.y);
  });
  // Lascas (cruzamentos de estrada com a divisa, < 1 ha) ficam de fora do rascunho
  const areaMinLasca = (op.areaMinLascaHa !== undefined ? op.areaMinLascaHa : 1) * 1e4;
  const faces = dentro.filter(f => f.area >= areaMinLasca);
  const lascas = dentro.filter(f => f.area < areaMinLasca);

  const alvo = (op.areaAlvoHa || PADROES.areaAlvoHa) * 1e4;
  const grupos = agruparFaces(faces, alvo);
  const candidatos = grupos.map(grupo => {
    const partes = dissolver(grupo);
    const area = partes.reduce((s, p) => s + Geo.areaPoligono(p), 0);
    // km de estradas e de ruas de bairro dentro do candidato
    const medir = linhas => {
      let metros = 0;
      for (const linha of linhas) for (let i = 0; i + 1 < linha.length; i++) {
        const m = [(linha[i][0] + linha[i + 1][0]) / 2, (linha[i][1] + linha[i + 1][1]) / 2];
        if (partes.some(p => Geo.pontoEmPoligono(m[0], m[1], p))) metros += Math.hypot(linha[i + 1][0] - linha[i][0], linha[i + 1][1] - linha[i][1]);
      }
      return metros / 1000;
    };
    const centro = Geo.polylabel(partes.reduce((a, b) => (Geo.areaPoligono(b) > Geo.areaPoligono(a) ? b : a)), 5);
    return {
      partesXY: partes, centro,
      partes: partes.map(p => p.map(anel => {
        const ll = anel.map(([x, y]) => { const [lat, lng] = proj.paraLatLng(x, y); return [Number(lng.toFixed(6)), Number(lat.toFixed(6))]; });
        return ll.concat([ll[0]]);
      })),
      areaHa: area / 1e4,
      kmVias: medir(linhasVias),
      kmRuas: medir(linhasRuas),
      alertas: []
    };
  });
  // Numeração provisória: norte → sul, oeste → leste
  candidatos.sort((a, b) => (b.centro.y - a.centro.y) || (a.centro.x - b.centro.x));
  const areaLimite = partesXY.reduce((s, p) => s + Geo.areaPoligono(p), 0) / 1e4;
  candidatos.forEach((c, i) => {
    c.id = "C" + String(i + 1).padStart(2, "0");
    if (c.areaHa > (op.areaAlvoHa || PADROES.areaAlvoHa) * 1.6) c.alertas.push("grande demais — dividir à mão");
    if (c.kmRuas >= 3) c.alertas.push(`contém área urbana (${c.kmRuas.toFixed(1)} km de ruas de bairro) — separar e dividir por quadras`);
    if (c.partes.length > 1) c.alertas.push(`${c.partes.length} partes separadas`);
  });
  const coberta = candidatos.reduce((s, c) => s + c.areaHa, 0);
  return { candidatos, areaLimiteHa: areaLimite, coberturaPct: areaLimite ? coberta / areaLimite * 100 : 0, faces: faces.length, lascas: lascas.length, lascasHa: lascas.reduce((s, f) => s + f.area, 0) / 1e4 };
}

/** WKT MULTIPOLYGON (lng lat), o formato da coluna wkt_geom da BASE. */
function paraWkt(partes) {
  return "MULTIPOLYGON (" + partes.map(p => "(" + p.map(anel => "(" + anel.map(c => `${c[0]} ${c[1]}`).join(", ") + ")").join(", ") + ")").join(", ") + ")";
}

const csvCampo = v => /[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

/** CSV no formato da BASE (+ CIDADE e AREA_HA). NUM_TER fica vazio: numeração depende da decisão Q5. */
function paraCsv(candidatos, cidade) {
  const linhas = [["NUM_TER", "DESC_TERRITORIO", "SITUACAO", "wkt_geom", "CIDADE", "CANDIDATO", "AREA_HA", "ALERTAS"].join(",")];
  for (const c of candidatos) {
    linhas.push(["", `Rascunho ${c.id}`, "", paraWkt(c.partes), cidade, c.id, c.areaHa.toFixed(1), c.alertas.join("; ")].map(csvCampo).join(","));
  }
  return linhas.join("\n") + "\n";
}

/** Territórios atuais que o limite toca (amostragem de vértices e do polo de cada território). */
function territoriosTocados(limite, territorios) {
  const proj = Geo.criarProjecao(limite.partes[0][0][0][1], limite.partes[0][0][0][0]);
  const xy = c => proj.paraXY(c[1], c[0]);
  const lim = limite.partes.map(p => p.map(anel => abrirAnel(anel).map(xy)));
  const dentro = (x, y) => lim.some(p => Geo.pontoEmPoligono(x, y, p));
  const tocados = [];
  for (const t of territorios) {
    const pts = t.partes.flatMap(p => p[0]).map(xy);
    const n = pts.filter(p => dentro(p[0], p[1])).length;
    if (n) tocados.push({ numero: t.numero, pctVertices: n / pts.length * 100 });
  }
  return tocados;
}

function dentroDoRepositorio(pasta) {
  const rel = path.relative(RAIZ, path.resolve(pasta));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function principal() {
  const op = lerArgumentos(process.argv.slice(2));
  if (op.ajuda) { console.log(AJUDA); return; }
  if (!op.limite) throw new Error("Informe --limite=arquivo (KMZ, KML ou GeoJSON). Use --ajuda.");
  if (dentroDoRepositorio(op.saida)) throw new Error("A pasta de saída não pode ficar dentro do repositório (público). Use --saida fora dele.");

  const limite = escolherPoligono(lerLimite(op.limite), op.nome);
  const cidade = op.cidade || limite.nome;
  const todos = limite.partes.flatMap(p => p[0]);
  const proj = Geo.criarProjecao(todos[0][1], todos[0][0]);
  const areaHa = limite.partes.reduce((s, p) => s + Geo.areaPoligono(p.map(anel => anel.map(c => proj.paraXY(c[1], c[0])))), 0) / 1e4;
  const caixa = Osm.caixaDosTerritorios([limite], 0.005);
  console.log(`Limite: "${limite.nome}" — ${limite.partes.length} parte(s), ${todos.length} vértices, ${areaHa.toFixed(0)} ha (WGS84 lon/lat).`);
  console.log(`Caixa (S,O,N,L): ${caixa.join(", ")}`);
  const wktLimite = paraWkt(limite.partes);
  if (wktLimite.length > op.limiteCelulaWkt) console.log(`Aviso: o WKT do limite tem ${wktLimite.length} caracteres (> ${op.limiteCelulaWkt} de uma célula do Sheets) — guarde o limite como arquivo, não na BASE.`);

  const territorios = Osm.carregarTerritorios(op.territorios);
  const tocados = territoriosTocados(limite, territorios);
  console.log(tocados.length
    ? `Territórios atuais com vértices dentro do limite: ${tocados.map(t => `${t.numero} (${t.pctVertices.toFixed(0)}%)`).join(", ")} — conferir a divisa.`
    : "Nenhum território atual tem vértices dentro do limite.");

  fs.mkdirSync(op.saida, { recursive: true });
  const colecao = feats => JSON.stringify({ type: "FeatureCollection", crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } }, features: feats });
  fs.writeFileSync(path.join(op.saida, "limite.geojson"), colecao([{ type: "Feature", properties: { nome: limite.nome, AREA_HA: Number(areaHa.toFixed(1)) }, geometry: { type: "MultiPolygon", coordinates: limite.partes } }]));
  console.log(`Gravado: ${path.join(op.saida, "limite.geojson")}`);

  if (!op.subdividir) {
    console.log("\nPara propor candidatos de território, rode de novo com --subdividir.");
    return;
  }

  const osm = await Osm.baixarMalhaViaria(caixa, {
    tipos: op.vias.concat(["residential", "living_street", "road", "service", "track"]).filter((v, i, a) => a.indexOf(v) === i),
    cache: op.cache, atualizarOsm: op.atualizarOsm, prefixo: "limite", agente: "rascunho-territorios/1.0 (script offline)"
  });
  const r = gerarCandidatos(limite, osm, op);
  console.log(`\nFaces (limite cortado pelas estradas ${op.vias.join("/")}) dentro do limite: ${r.faces} + ${r.lascas} lasca(s) descartada(s) (${r.lascasHa.toFixed(1)} ha)`);
  console.log(`Candidatos: ${r.candidatos.length} (área-alvo ${op.areaAlvoHa} ha) — cobrem ${r.coberturaPct.toFixed(1)}% do limite.`);
  console.log("\nCand.  Área(ha)  km estradas  km ruas  Alertas");
  for (const c of r.candidatos) console.log(`${c.id.padEnd(5)}  ${c.areaHa.toFixed(0).padStart(8)}  ${c.kmVias.toFixed(1).padStart(11)}  ${c.kmRuas.toFixed(1).padStart(7)}  ${c.alertas.join("; ")}`);

  const feats = r.candidatos.map(c => ({
    type: "Feature",
    properties: { CANDIDATO: c.id, CIDADE: cidade, AREA_HA: Number(c.areaHa.toFixed(1)), KM_VIAS: Number(c.kmVias.toFixed(1)), KM_RUAS: Number(c.kmRuas.toFixed(1)), ALERTAS: c.alertas.join("; ") },
    geometry: { type: "MultiPolygon", coordinates: c.partes }
  }));
  fs.writeFileSync(path.join(op.saida, "candidatos.geojson"), colecao(feats));
  fs.writeFileSync(path.join(op.saida, "candidatos.csv"), paraCsv(r.candidatos, cidade));
  console.log(`\nGravado: ${path.join(op.saida, "candidatos.geojson")} e candidatos.csv (rascunho — revisar no QGIS; nada foi enviado à planilha).`);
}

if (require.main === module) {
  principal().catch(e => { console.error("ERRO: " + e.message); process.exit(1); });
}

module.exports = { lerZip, lerPoligonosKml, lerPoligonosGeojson, lerLimite, escolherPoligono, dissolver, agruparFaces, gerarCandidatos, paraWkt, paraCsv, territoriosTocados, dentroDoRepositorio };
