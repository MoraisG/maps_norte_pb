/**
 * Spec 07 / Fase 3 — scripts/rurais/acessos-faltando.js: casas a mais de N metros de qualquer
 * estrada, com distância exata; saída só fora do repositório; CSV sem fórmulas.
 */
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const RAIZ = path.join(__dirname, "..");
const A = require(path.join(RAIZ, "scripts", "rurais", "acessos-faltando.js"));

// Estrada reta leste-oeste em lat -26.2000; 0,001° de latitude ≈ 111 m
const vias = { type: "FeatureCollection", features: [
  { type: "Feature", properties: { NUM_TERR: 18 }, geometry: { type: "LineString", coordinates: [[-52.70, -26.2000], [-52.69, -26.2000], [-52.68, -26.2000]] } },
  { type: "Feature", properties: { NUM_TERR: 18 }, geometry: { type: "MultiLineString", coordinates: [[[-52.60, -26.3000], [-52.59, -26.3000]]] } }
] };
const pontos = [
  { id: "perto", terr: 18, lat: -26.2005, lng: -52.69, dom: 1, loc: "Linha A" },    // ~56 m
  { id: "medio", terr: 18, lat: -26.2020, lng: -52.69, dom: 2, loc: "Linha A" },    // ~223 m
  { id: "longe", terr: 18, lat: -26.2100, lng: -52.695, dom: 1, loc: "=HYPERLINK(\"x\")" }, // ~1,1 km
  { id: "fim", terr: 20, lat: -26.2000, lng: -52.6700, dom: 1 },                     // ~1 km a leste do fim da estrada
  { id: "invalido", terr: 20, lat: NaN, lng: -52.6 }
];

// --- 1. Cálculo ---
{
  const r = A.calcularAcessosFaltando(pontos, vias, 150);
  assert.deepStrictEqual(r.map(p => p.id), ["longe", "fim", "medio"], "do mais distante ao mais próximo; perto e inválido fora");
  const d = Object.fromEntries(r.map(p => [p.id, p.distancia]));
  assert.ok(Math.abs(d.medio - 222.6) < 2, "medio: " + d.medio);
  assert.ok(Math.abs(d.longe - 1113) < 5, "longe: distância exata (não limitada à caixa): " + d.longe);
  assert.ok(Math.abs(d.fim - 998) < 5, "fim: distância até a ponta da estrada: " + d.fim);
  assert.deepStrictEqual(A.calcularAcessosFaltando(pontos, vias, 2000).map(p => p.id), []);
  assert.deepStrictEqual(A.calcularAcessosFaltando([], vias, 150), []);
  const semVias = A.calcularAcessosFaltando(pontos.slice(0, 1), { features: [] }, 150);
  assert.strictEqual(semVias[0].distancia, Infinity, "sem nenhuma via: Infinity");
}

// --- 2. CSV e GeoJSON ---
{
  const r = A.calcularAcessosFaltando(pontos, vias, 150);
  const csv = A.gerarCsv(r).split("\n");
  assert.strictEqual(csv[0], "terr,id,lat,lng,domicilios,distancia_m,localidade");
  assert.ok(csv[1].startsWith("18,longe,"));
  assert.ok(csv[1].includes("\"'=HYPERLINK(\"\"x\"\")\""), "texto que começa com = não vira fórmula: " + csv[1]);
  assert.ok(A.gerarCsv(A.calcularAcessosFaltando(pontos.slice(0, 1), { features: [] }, 150)).includes("sem via"));
  const gj = JSON.parse(A.gerarGeojson(r));
  assert.strictEqual(gj.features.length, 3);
  assert.deepStrictEqual(Object.keys(gj.features[0].properties).sort(), ["distancia_m", "domicilios", "id", "terr"], "GeoJSON sem endereço/localidade");
}

// --- 3. Linha de comando: entrada e saída só fora do repositório ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acessos-"));
  const arqP = path.join(dir, "pontos.json"), arqV = path.join(dir, "vias.geojson"), saida = path.join(dir, "saida");
  fs.writeFileSync(arqP, JSON.stringify({ tipo: "pontos-rurais", pontos }));
  fs.writeFileSync(arqV, JSON.stringify(vias));
  const log = [];
  assert.throws(() => A.executar([`--pontos=${arqP}`, `--saida=${path.join(RAIZ, "tmp-saida")}`, `--vias=${arqV}`], l => log.push(l)), /fora do repositório/);
  assert.ok(!fs.existsSync(path.join(RAIZ, "tmp-saida")));
  assert.strictEqual(A.executar([`--pontos=${arqP}`, `--saida=${saida}`, `--vias=${arqV}`, "--territorios=18"], l => log.push(l)), 0);
  const csv = fs.readFileSync(path.join(saida, "acessos-faltando.csv"), "utf8");
  assert.strictEqual(csv.trim().split("\n").length, 3, "cabeçalho + 2 casas do território 18");
  assert.ok(!log.join("\n").includes("Linha A"), "console sem endereços/localidades");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("acessos-faltando: ok");
