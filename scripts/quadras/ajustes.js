/**
 * Spec 05 — ajustes manuais de quadras, versionados no repositório (spec 08 / Q4: a geometria
 * vive no repositório, não no app).
 *
 * Arquivo scripts/quadras/ajustes-quadras.json:
 *   { "ajustes": { "<ID_QUADRA>": { "terr": 12, "numero": 5, "rotulo": "5A", "lat": -26.2, "lng": -52.6,
 *                                   "oculta": true, "obs": "texto livre" } } }
 * Só "terr" é obrigatório (conferência). O ID_QUADRA é estável entre execuções do gerador (hash do
 * ponto de rótulo original), então o ajuste sobrevive a uma nova geração das quadras.
 *
 * Reversível e idempotente: a quadra ajustada guarda em "_GER" o número e a posição que o gerador
 * deu; aplicar de novo parte sempre desses valores, e remover o ajuste os restaura. Quadra oculta
 * continua no arquivo com OCULTA = true (o app não a desenha).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ARQUIVO_AJUSTES = path.join(__dirname, "ajustes-quadras.json");
const COMENTARIO = "Ajustes manuais de quadras (spec 05). Edite com: node scripts/quadras/ajustar-quadras.js --ajuda";

function lerAjustes(arquivo) {
  const alvo = arquivo || ARQUIVO_AJUSTES;
  if (!fs.existsSync(alvo)) return { comentario: COMENTARIO, ajustes: {} };
  const dados = JSON.parse(fs.readFileSync(alvo, "utf8"));
  if (!dados || typeof dados.ajustes !== "object" || Array.isArray(dados.ajustes)) throw new Error(`${alvo}: falta o objeto "ajustes".`);
  return dados;
}

function gravarAjustes(dados, arquivo) {
  const ordenado = { comentario: dados.comentario || COMENTARIO, ajustes: {} };
  const ids = Object.keys(dados.ajustes).sort((a, b) =>
    (Number(dados.ajustes[a].terr) - Number(dados.ajustes[b].terr)) || a.localeCompare(b));
  for (const id of ids) ordenado.ajustes[id] = dados.ajustes[id];
  fs.writeFileSync(arquivo || ARQUIVO_AJUSTES, JSON.stringify(ordenado, null, 2) + "\n");
}

/** Propriedades como o gerador deixou (desfaz um ajuste anterior, se houver). */
function propriedadesGeradas(props) {
  const p = Object.assign({}, props);
  if (p._GER) {
    p.NUM_QUADRA = p._GER.n;
    p.LABEL_LAT = p._GER.lat;
    p.LABEL_LNG = p._GER.lng;
    p.ROTULO = String(p._GER.n);
  }
  delete p._GER;
  delete p.OCULTA;
  return p;
}

/**
 * Aplica os ajustes às feições de quadras.geojson. Não altera a entrada.
 * Devolve { features, avisos, aplicados }.
 */
function aplicarAjustes(features, dadosAjustes) {
  const ajustes = (dadosAjustes && dadosAjustes.ajustes) || {};
  const avisos = [];
  const encontrados = new Set();
  let aplicados = 0;

  const saida = features.map(f => {
    const base = propriedadesGeradas(f.properties);
    const id = base.ID_QUADRA;
    const a = ajustes[id];
    if (!a) return Object.assign({}, f, { properties: base });
    encontrados.add(id);
    if (Number(a.terr) !== Number(base.NUM_TERR)) {
      avisos.push(`Ajuste ${id}: indicado para o território ${a.terr}, mas a quadra é do ${base.NUM_TERR} — ignorado.`);
      return Object.assign({}, f, { properties: base });
    }
    aplicados++;
    const p = Object.assign({}, base, { _GER: { n: base.NUM_QUADRA, lat: base.LABEL_LAT, lng: base.LABEL_LNG } });
    if (a.numero !== undefined) p.NUM_QUADRA = Number(a.numero);
    p.ROTULO = a.rotulo !== undefined ? String(a.rotulo) : String(p.NUM_QUADRA);
    if (a.lat !== undefined && a.lng !== undefined) {
      p.LABEL_LAT = Number(Number(a.lat).toFixed(6));
      p.LABEL_LNG = Number(Number(a.lng).toFixed(6));
    }
    if (a.oculta) p.OCULTA = true;
    return Object.assign({}, f, { properties: p });
  });

  for (const id of Object.keys(ajustes)) {
    if (!encontrados.has(id)) avisos.push(`Ajuste ${id} (território ${ajustes[id].terr}): quadra não existe mais em quadras.geojson.`);
  }

  // Número repetido dentro do mesmo território (quadras ocultas não contam)
  const vistos = new Map();
  for (const f of saida) {
    if (f.properties.OCULTA) continue;
    const chave = `${f.properties.NUM_TERR}|${f.properties.NUM_QUADRA}`;
    if (vistos.has(chave)) avisos.push(`Território ${f.properties.NUM_TERR}: a quadra ${f.properties.NUM_QUADRA} aparece mais de uma vez (${vistos.get(chave)} e ${f.properties.ID_QUADRA}).`);
    else vistos.set(chave, f.properties.ID_QUADRA);
  }
  return { features: saida, avisos, aplicados };
}

/** Mesmo formato de gravação do gerador (uma feição por linha: diffs pequenos no git). */
function serializarColecao(colecao) {
  return "{\n" + Object.entries(colecao).filter(([k]) => k !== "features").map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n") +
    ',\n"features": [\n' + colecao.features.map(f => JSON.stringify(f)).join(",\n") + "\n]\n}\n";
}

module.exports = { ARQUIVO_AJUSTES, lerAjustes, gravarAjustes, aplicarAjustes, propriedadesGeradas, serializarColecao };
