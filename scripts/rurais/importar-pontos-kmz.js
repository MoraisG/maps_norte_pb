#!/usr/bin/env node
/**
 * Prepara os pontos das casas rurais (KMZ/KML do Google My Maps) para importar no app (spec 07,
 * fase 2). Roda só no computador; a saída fica FORA do repositório e é enviada pelo ADMIN no
 * painel do app ("Importar casas rurais"), que grava a aba PontosRurais.
 *
 * Uso (na raiz do projeto, Node 18+; sem dependências):
 *   node scripts/rurais/importar-pontos-kmz.js --kmz="<arquivo .kmz>" --saida="<arquivo .json fora do repo>"
 *
 * Minimização (LGPD): só ficam a posição (5 casas decimais ≈ 1 m), o logradouro, a localidade e a
 * quantidade de domicílios no mesmo ponto. O nome do placemark, "Tipo" (atividade), "Endereco",
 * "Ref", descrição e altitude são descartados. Pontos fora dos territórios da congregação
 * (territorios_nortpb.geojson) também são descartados.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Geo = require("../../js/geo.js");
const { lerZip, dentroDoRepositorio } = require("../territorios/rascunho-limite.js");

const RAIZ = path.resolve(__dirname, "..", "..");

function lerArgumentos(argv) {
  const op = { kmz: "", saida: "", territorios: path.join(RAIZ, "territorios_nortpb.geojson"), ajuda: false };
  for (const a of argv) {
    const [chave, valor] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, ""];
    if (chave === "--kmz") op.kmz = path.resolve(valor);
    else if (chave === "--saida") op.saida = path.resolve(valor);
    else if (chave === "--territorios") op.territorios = path.resolve(valor);
    else if (chave === "--ajuda" || chave === "-h") op.ajuda = true;
    else throw new Error(`Opção desconhecida: ${a} (use --ajuda)`);
  }
  return op;
}

const limpar = s => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\s+/g, " ").trim();

/** Pontos de um KML: [{ lat, lng, logradouro, localidade }] — só os campos permitidos. */
function lerPontosKml(kml) {
  const pontos = [];
  for (const m of kml.matchAll(/<Placemark\b[\s\S]*?<\/Placemark>/g)) {
    const bloco = m[0];
    const pt = /<Point\b[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/.exec(bloco);
    if (!pt) continue;
    const [lng, lat] = pt[1].trim().split(/[\s,]+/).map(Number);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    const dados = {};
    for (const d of bloco.matchAll(/<Data name="([^"]+)">\s*<value>([\s\S]*?)<\/value>/g)) dados[d[1]] = limpar(d[2]);
    pontos.push({ lat, lng, logradouro: dados.Logradouro || "", localidade: dados.Localidade || "" });
  }
  return pontos;
}

/** Identificador estável a partir da posição arredondada (FNV-1a 32 bits, base 36). */
function idDoPonto(lat5, lng5) {
  let h = 0x811c9dc5;
  for (const c of `${lat5.toFixed(5)},${lng5.toFixed(5)}`) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return "PR" + h.toString(36).toUpperCase().padStart(7, "0");
}

const maisFrequente = lista => {
  const cont = new Map();
  for (const v of lista) if (v) cont.set(v, (cont.get(v) || 0) + 1);
  return [...cont.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || "";
};

/** Territórios do geojson projetados para teste de ponto-no-polígono. */
function prepararTerritorios(geo) {
  const proj = Geo.criarProjecao(-26.15, -52.75);
  return {
    proj,
    lista: geo.features.map(f => {
      const pols = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      return { numero: Number(f.properties.NUM_TERR), xy: pols.map(p => p.map(a => a.map(([lng, lat]) => proj.paraXY(lat, lng)))) };
    })
  };
}

/**
 * Agrupa por posição (5 casas), atribui território e descarta o que estiver fora.
 * @returns {{ pontos: Array, descartados: number, porTerritorio: Object }}
 */
function montarPontos(brutos, territorios) {
  const grupos = new Map();
  for (const p of brutos) {
    const lat5 = Math.round(p.lat * 1e5) / 1e5, lng5 = Math.round(p.lng * 1e5) / 1e5;
    const chave = `${lat5},${lng5}`;
    if (!grupos.has(chave)) grupos.set(chave, { lat5, lng5, itens: [] });
    grupos.get(chave).itens.push(p);
  }
  const pontos = [];
  let descartados = 0;
  const porTerritorio = {};
  for (const g of grupos.values()) {
    const [x, y] = territorios.proj.paraXY(g.lat5, g.lng5);
    const t = territorios.lista.find(t => t.xy.some(p => Geo.pontoEmPoligono(x, y, p)));
    if (!t) { descartados += g.itens.length; continue; }
    pontos.push({
      id: idDoPonto(g.lat5, g.lng5),
      terr: t.numero,
      lat: g.lat5,
      lng: g.lng5,
      dom: Math.min(99, g.itens.length),
      log: maisFrequente(g.itens.map(i => i.logradouro)).slice(0, 80),
      loc: maisFrequente(g.itens.map(i => i.localidade)).slice(0, 80)
    });
    porTerritorio[t.numero] = (porTerritorio[t.numero] || 0) + 1;
  }
  const ids = new Set(pontos.map(p => p.id));
  if (ids.size !== pontos.length) throw new Error("Colisão de identificadores de ponto (improvável): rode de novo com outra precisão.");
  pontos.sort((a, b) => a.terr - b.terr || a.lat - b.lat || a.lng - b.lng);
  return { pontos, descartados, porTerritorio };
}

function principal() {
  const op = lerArgumentos(process.argv.slice(2));
  if (op.ajuda || !op.kmz || !op.saida) {
    console.log("Uso: node scripts/rurais/importar-pontos-kmz.js --kmz=<arquivo.kmz|.kml> --saida=<arquivo.json fora do repositório>");
    return;
  }
  if (dentroDoRepositorio(path.dirname(op.saida))) throw new Error("--saida precisa ficar fora do repositório (dados de residências, LGPD).");
  const buf = fs.readFileSync(op.kmz);
  const kml = /\.kml$/i.test(op.kmz) ? buf.toString("utf8")
    : Object.values(lerZip(buf, n => /\.kml$/i.test(n))).map(b => b.toString("utf8")).join("\n");
  const brutos = lerPontosKml(kml);
  const territorios = prepararTerritorios(JSON.parse(fs.readFileSync(op.territorios, "utf8")));
  const { pontos, descartados, porTerritorio } = montarPontos(brutos, territorios);
  fs.writeFileSync(op.saida, JSON.stringify({ tipo: "pontos-rurais", versao: 1, geradoEm: new Date().toISOString(), pontos }));
  console.log(`${brutos.length} ponto(s) lidos → ${pontos.length} posição(ões) em ${Object.keys(porTerritorio).length} território(s); ${descartados} fora dos territórios (descartados).`);
  console.log("Por território: " + Object.entries(porTerritorio).map(([t, n]) => `${t}:${n}`).join(" · "));
  console.log(`Gravado: ${op.saida}\nNo app: Painel Admin → "Importar casas rurais" → escolher este arquivo.`);
}

if (require.main === module) {
  try { principal(); } catch (e) { console.error("Erro:", e.message); process.exit(1); }
}

module.exports = { lerPontosKml, idDoPonto, montarPontos, prepararTerritorios };
