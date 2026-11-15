/**
 * Funções comuns aos geradores que usam o OpenStreetMap (scripts/quadras e scripts/rurais):
 * leitura de territorios_nortpb.geojson, classificação urbano/rural por área, caixa delimitadora
 * e consulta à Overpass API com cache local, novas tentativas e servidores alternativos.
 *
 * Privacidade: a única informação enviada à Overpass API é a caixa delimitadora e o filtro de
 * `highway`. A resposta fica em cache local (pasta .cache/ do script, fora do versionamento).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Geo = require("../../js/geo.js");

const SERVIDORES_OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];

const esperar = ms => new Promise(r => setTimeout(r, ms));

/** Territórios do geojson: [{ numero, partes: [[externo, ...furos], ...] }] em [lng, lat], sem Z. */
function carregarTerritorios(arquivo) {
  const geo = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  return geo.features.map(f => {
    const g = f.geometry;
    const poligonos = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    return {
      numero: Number(f.properties.NUM_TERR),
      partes: poligonos.map(pol => pol.map(anel => anel.map(c => [c[0], c[1]])))
    };
  }).sort((a, b) => a.numero - b.numero);
}

/**
 * Calcula t.areaM2 e t.urbano de cada território. O geojson não traz o tipo (Cidade/Rural da
 * BASE), então usa-se a área, com exceções manuais (`urbanos`/`rurais`: Set de números).
 */
function classificarPorArea(territorios, { areaMaxUrbanoHa, urbanos = new Set(), rurais = new Set() }) {
  let latSoma = 0, lngSoma = 0, cont = 0;
  for (const t of territorios) for (const parte of t.partes) for (const c of parte[0]) { lngSoma += c[0]; latSoma += c[1]; cont++; }
  const proj = Geo.criarProjecao(latSoma / cont, lngSoma / cont);
  for (const t of territorios) {
    t.areaM2 = t.partes.reduce((s, parte) => s + Geo.areaPoligono(parte.map(anel => anel.map(c => proj.paraXY(c[1], c[0])))), 0);
    t.urbano = urbanos.has(t.numero) || (!rurais.has(t.numero) && t.areaM2 <= areaMaxUrbanoHa * 1e4);
  }
  return territorios;
}

/**
 * Caixa [sul, oeste, norte, leste] dos territórios, arredondada para fora em `passo` graus e
 * com uma volta extra de `passo` (~500 m com 0,005°) de margem.
 */
function caixaDosTerritorios(territorios, passo = 0.005) {
  let sul = Infinity, oeste = Infinity, norte = -Infinity, leste = -Infinity;
  for (const t of territorios) for (const parte of t.partes) for (const c of parte[0]) {
    if (c[1] < sul) sul = c[1];
    if (c[1] > norte) norte = c[1];
    if (c[0] < oeste) oeste = c[0];
    if (c[0] > leste) leste = c[0];
  }
  return [Math.floor(sul / passo) * passo - passo, Math.floor(oeste / passo) * passo - passo,
    Math.ceil(norte / passo) * passo + passo, Math.ceil(leste / passo) * passo + passo].map(v => Number(v.toFixed(3)));
}

/**
 * Baixa `way[highway~tipos]` da caixa pela Overpass API (`out tags geom`), com cache local.
 * @param caixa [sul, oeste, norte, leste]
 * @param op { tipos: string[], cache: pasta, atualizarOsm: boolean, prefixo?: nome do arquivo de cache,
 *             agente?: User-Agent, servidores?: lista, fetch?: função (testes) }
 */
async function baixarMalhaViaria(caixa, op) {
  const chave = caixa.map(v => v.toFixed(3)).join("_");
  const arquivo = path.join(op.cache, `${op.prefixo || "overpass"}_${chave}.json`);
  if (!op.atualizarOsm && fs.existsSync(arquivo)) {
    const dados = JSON.parse(fs.readFileSync(arquivo, "utf8"));
    console.log(`Malha viária: cache local (${dados.elements.length} vias, baixado em ${dados._baixadoEm || "?"}).`);
    return dados;
  }

  const servidores = op.servidores || SERVIDORES_OVERPASS;
  const buscar = op.fetch || fetch;
  const consulta = `[out:json][timeout:180];way["highway"~"^(${op.tipos.join("|")})$"](${caixa.join(",")});out tags geom;`;
  let ultimoErro = null;
  for (let tentativa = 0; tentativa < 6; tentativa++) {
    const servidor = servidores[tentativa % servidores.length];
    if (tentativa > 0) {
      const espera = op.semEspera ? 0 : Math.min(60000, 4000 * 2 ** (tentativa - 1));
      console.log(`  nova tentativa em ${espera / 1000}s (${ultimoErro})...`);
      await esperar(espera);
    }
    try {
      console.log(`Malha viária: consultando ${new URL(servidor).host}...`);
      const resposta = await buscar(servidor, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": op.agente || "gerador-mapas/1.0 (script offline)" },
        body: "data=" + encodeURIComponent(consulta),
        signal: AbortSignal.timeout(200000)
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

module.exports = { SERVIDORES_OVERPASS, carregarTerritorios, classificarPorArea, caixaDosTerritorios, baixarMalhaViaria };
