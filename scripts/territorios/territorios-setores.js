#!/usr/bin/env node
/**
 * Territórios a partir dos setores censitários do IBGE (Censo 2022) — o mesmo critério usado em
 * Pato Branco: cada setor censitário vira um território, com SITUACAO (Urbana/Rural) do IBGE.
 *
 * Fonte: malha de setores do IBGE, um KMZ por município, em
 *   https://geoftp.ibge.gov.br/organizacao_do_territorio/malhas_territoriais/
 *     malhas_de_setores_censitarios__divisoes_intramunicipais/censo_2022/setores/kml/41_PR.zip
 *   (ex.: 41/bom_sucesso_do_sul_4103222_setores_CD2022.kmz)
 *
 * Uso (na raiz do projeto, Node 18+; sem dependências):
 *   node scripts/territorios/territorios-setores.js --setores=<kmz do IBGE> --inicio=100 \
 *        --saida=<pasta fora do repositório> [--gravar-territorios]
 *
 * - Numeração: a partir de --inicio (padrão: maior NUM_TERR de territorios_nortpb.geojson + 1),
 *   na ordem do código do setor (CD_SETOR), como em Pato Branco.
 * - Saída: CSV no formato da aba BASE (NUM_TER, DESC_TERRITORIO, SITUACAO, wkt_geom + colunas de
 *   conferência) e GeoJSON, sempre fora do repositório. Nada é gravado na planilha.
 * - --gravar-territorios: acrescenta os territórios a territorios_nortpb.geojson (usado pelos
 *   geradores de quadras e de estradas rurais). Recusa números que já existam.
 * - Os setores do IBGE são dado público; nenhum dado pessoal é lido ou gravado.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Geo = require("../../js/geo.js");
const { lerZip, lerPoligonosKml, paraWkt, dentroDoRepositorio } = require("./rascunho-limite.js");

const RAIZ = path.resolve(__dirname, "..", "..");
const ARQ_TERRITORIOS = path.join(RAIZ, "territorios_nortpb.geojson");

function lerArgumentos(argv) {
  const op = { setores: "", inicio: 0, saida: "", cidade: "", gravarTerritorios: false, toleranciaM: 1, ajuda: false };
  for (const a of argv) {
    const [chave, valor] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, ""];
    if (chave === "--setores") op.setores = path.resolve(valor);
    else if (chave === "--inicio") op.inicio = Number(valor);
    else if (chave === "--saida") op.saida = path.resolve(valor);
    else if (chave === "--cidade") op.cidade = valor;
    else if (chave === "--tolerancia") op.toleranciaM = Number(valor);
    else if (chave === "--gravar-territorios") op.gravarTerritorios = true;
    else if (chave === "--ajuda" || chave === "-h") op.ajuda = true;
    else throw new Error(`Opção desconhecida: ${a} (use --ajuda)`);
  }
  return op;
}

const AJUDA = `
Territórios a partir dos setores censitários do IBGE (um setor = um território).
  --setores=arquivo.kmz        KMZ de setores do município (malha do IBGE, Censo 2022)
  --inicio=100                 primeiro número (padrão: maior NUM_TERR atual + 1)
  --cidade="Bom Sucesso do Sul" nome da cidade (padrão: NM_MUN do IBGE)
  --saida=pasta                pasta FORA do repositório para o CSV da BASE e o GeoJSON
  --gravar-territorios         acrescenta os territórios a territorios_nortpb.geojson
  --tolerancia=1               simplificação do contorno, em metros (0 desliga)
`;

/** Setores de um KML do IBGE: [{ attr: {CD_SETOR, SITUACAO, ...}, partes }]. */
function lerSetoresKml(kml) {
  const setores = [];
  for (const m of kml.matchAll(/<Placemark\b[\s\S]*?<\/Placemark>/g)) {
    const attr = {};
    for (const d of m[0].matchAll(/<SimpleData name="([^"]+)">([^<]*)<\/SimpleData>/g)) attr[d[1]] = d[2].trim();
    const pol = lerPoligonosKml(m[0])[0];
    if (!pol || !attr.CD_SETOR) continue;
    setores.push({ attr, partes: pol.partes });
  }
  return setores.sort((a, b) => a.attr.CD_SETOR.localeCompare(b.attr.CD_SETOR));
}

function lerSetores(arquivo) {
  const buf = fs.readFileSync(arquivo);
  if (/\.kml$/i.test(arquivo)) return lerSetoresKml(buf.toString("utf8"));
  const kmls = lerZip(buf, n => /\.kml$/i.test(n));
  return Object.values(kmls).flatMap(b => lerSetoresKml(b.toString("utf8")));
}

/** Douglas-Peucker num anel fechado (em metros, projeção local); mantém o anel fechado. */
function simplificarAnel(anel, tolM, proj) {
  if (!(tolM > 0) || anel.length <= 5) return anel;
  const xy = anel.map(([lng, lat]) => proj.paraXY(lat, lng));
  const manter = new Uint8Array(anel.length);
  manter[0] = manter[anel.length - 1] = 1;
  const pilha = [[0, anel.length - 1]];
  while (pilha.length) {
    const [i, j] = pilha.pop();
    const [ax, ay] = xy[i], [bx, by] = xy[j];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let k = i + 1; k < j; k++) {
      const [px, py] = xy[k];
      let d;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (maxD > tolM) { manter[idx] = 1; pilha.push([i, idx], [idx, j]); }
  }
  const res = anel.filter((_, k) => manter[k]);
  return res.length >= 4 ? res : anel;
}

const arred = c => [Math.round(c[0] * 1e7) / 1e7, Math.round(c[1] * 1e7) / 1e7];

/** Descrição do território: bairro do IBGE ou "<cidade> - Sede/Interior". */
function descricao(attr, cidade) {
  if (attr.NM_BAIRRO) return attr.NM_BAIRRO;
  return `${cidade} - ${attr.SITUACAO === "Rural" ? "Interior" : "Sede"}`;
}

/** Converte os setores em territórios numerados a partir de `inicio`. */
function montarTerritorios(setores, inicio, cidade, toleranciaM) {
  return setores.map((s, i) => {
    const anel0 = s.partes[0][0];
    const proj = Geo.criarProjecao(anel0[0][1], anel0[0][0]);
    const partes = s.partes.map(p => p.map(anel => simplificarAnel(anel, toleranciaM, proj).map(arred)));
    const areaHa = partes.reduce((soma, p) => soma + Geo.areaPoligono(p.map(a => a.map(([lng, lat]) => proj.paraXY(lat, lng)))), 0) / 1e4;
    const situacao = s.attr.SITUACAO === "Rural" ? "Rural" : "Urbana";
    return {
      numero: inicio + i,
      cdSetor: s.attr.CD_SETOR,
      situacao,
      descricao: descricao(s.attr, cidade),
      cidade,
      areaHa,
      partes,
      vertices: partes.flat(2).length
    };
  });
}

const csvCampo = v => /[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

/** CSV para colar na aba BASE (as quatro primeiras colunas são as que o app lê). */
function paraCsvBase(territorios) {
  const linhas = [["NUM_TER", "DESC_TERRITORIO", "SITUACAO", "wkt_geom", "CIDADE", "CD_SETOR", "AREA_HA"].join(",")];
  for (const t of territorios) {
    linhas.push([t.numero, t.descricao, t.situacao, paraWkt(t.partes), t.cidade, t.cdSetor, t.areaHa.toFixed(1)].map(csvCampo).join(","));
  }
  return linhas.join("\n") + "\n";
}

function paraFeature(t, completo) {
  const props = completo
    ? { NUM_TERR: t.numero, DESC_TERRITORIO: t.descricao, SITUACAO: t.situacao, CIDADE: t.cidade, CD_SETOR: t.cdSetor, AREA_HA: Number(t.areaHa.toFixed(1)) }
    : { NUM_TERR: t.numero };
  return { type: "Feature", properties: props, geometry: { type: "MultiPolygon", coordinates: t.partes } };
}

/**
 * Acrescenta os territórios ao texto de territorios_nortpb.geojson mantendo o formato do arquivo
 * (uma feature por linha). Recusa números repetidos.
 */
function acrescentarAoGeojson(texto, territorios) {
  const atual = JSON.parse(texto);
  const existentes = new Set(atual.features.map(f => Number(f.properties.NUM_TERR)));
  const repetidos = territorios.filter(t => existentes.has(t.numero)).map(t => t.numero);
  if (repetidos.length) throw new Error(`Números já existentes em territorios_nortpb.geojson: ${repetidos.join(", ")}`);
  const nl = texto.includes("\r\n") ? "\r\n" : "\n";
  const fim = texto.lastIndexOf("]");
  if (fim < 0) throw new Error("territorios_nortpb.geojson em formato inesperado");
  const antes = texto.slice(0, fim).replace(/\s+$/, "");
  const novas = territorios.map(t => JSON.stringify(paraFeature(t, false))).join("," + nl);
  return `${antes},${nl}${novas}${nl}${texto.slice(fim)}`;
}

function principal() {
  const op = lerArgumentos(process.argv.slice(2));
  if (op.ajuda || !op.setores) { console.log(AJUDA); return; }
  const setores = lerSetores(op.setores);
  if (!setores.length) throw new Error("Nenhum setor censitário (CD_SETOR) encontrado no arquivo.");

  const textoGeo = fs.readFileSync(ARQ_TERRITORIOS, "utf8");
  const maior = Math.max(...JSON.parse(textoGeo).features.map(f => Number(f.properties.NUM_TERR) || 0));
  const inicio = op.inicio || maior + 1;
  const cidade = op.cidade || setores[0].attr.NM_MUN || "";
  const territorios = montarTerritorios(setores, inicio, cidade, op.toleranciaM);

  console.log(`${cidade}: ${setores.length} setores censitários → territórios ${inicio}–${inicio + territorios.length - 1}`);
  for (const t of territorios) {
    console.log(`  ${t.numero}  ${t.cdSetor}  ${t.situacao.padEnd(6)}  ${t.areaHa.toFixed(0).padStart(5)} ha  ${t.vertices} vértices  ${t.descricao}`);
  }
  if (inicio <= maior) console.log(`Atenção: --inicio=${inicio} não é maior que o último território atual (${maior}).`);

  if (op.saida) {
    if (dentroDoRepositorio(op.saida)) throw new Error("--saida precisa ficar fora do repositório.");
    fs.mkdirSync(op.saida, { recursive: true });
    const base = path.join(op.saida, `territorios-${inicio}-${inicio + territorios.length - 1}`);
    fs.writeFileSync(base + "-BASE.csv", paraCsvBase(territorios));
    fs.writeFileSync(base + ".geojson", JSON.stringify({ type: "FeatureCollection", features: territorios.map(t => paraFeature(t, true)) }));
    console.log(`CSV da BASE: ${base}-BASE.csv\nGeoJSON: ${base}.geojson`);
  }
  if (op.gravarTerritorios) {
    fs.writeFileSync(ARQ_TERRITORIOS, acrescentarAoGeojson(textoGeo, territorios));
    console.log(`territorios_nortpb.geojson: ${territorios.length} território(s) acrescentado(s).`);
  }
}

if (require.main === module) {
  try { principal(); } catch (e) { console.error("Erro:", e.message); process.exit(1); }
}

module.exports = { lerSetoresKml, simplificarAnel, montarTerritorios, descricao, paraCsvBase, acrescentarAoGeojson };
