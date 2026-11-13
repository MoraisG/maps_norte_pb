/**
 * Geometria pura (js/geo.js) e poligonização do gerador de quadras (scripts/quadras/gerar-quadras.js):
 * parser WKT por parte, polylabel, serpentina, ID estável e faces da malha viária.
 */
const assert = require("assert");
const path = require("path");
const Geo = require(path.join(__dirname, "..", "js", "geo.js"));
const { poligonizar } = require(path.join(__dirname, "..", "scripts", "quadras", "gerar-quadras.js"));

// --- Parser WKT: cada parte do MultiPolygon é um polígono; furos ficam na sua parte ---
const multi = "MultiPolygonZ (((0 0 0, 10 0 0, 10 10 0, 0 10 0, 0 0 0),(2 2 0, 4 2 0, 4 4 0, 2 4 0, 2 2 0)),((20 20 0, 30 20 0, 30 30 0, 20 20 0)))";
const partes = Geo.parseWktPartes(multi);
assert.strictEqual(partes.length, 2, "duas partes");
assert.strictEqual(partes[0].length, 2, "primeira parte: externo + 1 furo");
assert.strictEqual(partes[1].length, 1, "segunda parte sem furos (não é furo da primeira)");
assert.deepStrictEqual(partes[0][0][1], [0, 10], "ordem [lat, lng]");
assert.deepStrictEqual(partes[1][0][0], [20, 20]);

const simples = Geo.parseWktPartes("POLYGON ((0 0, 5 0, 5 5, 0 5, 0 0), (1 1, 2 1, 2 2, 1 1))");
assert.strictEqual(simples.length, 1);
assert.strictEqual(simples[0].length, 2);
assert.strictEqual(Geo.parseWktPartes("MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)),((5 5, 6 5, 6 6, 5 5)),((8 8, 9 8, 9 9, 8 8)))").length, 3);
assert.deepStrictEqual(Geo.parseWktPartes(""), []);
assert.deepStrictEqual(Geo.parseWktPartes(null), []);
assert.deepStrictEqual(Geo.parseWktPartes("lixo sem parênteses"), []);
assert.deepStrictEqual(Geo.parseWktPartes("POLYGON ((0 0, 1 1))"), [], "anel com menos de 3 pontos é descartado");

// --- Polylabel: em formas côncavas o ponto fica dentro (o centroide ficaria fora) ---
const formaL = [[[0, 0], [100, 0], [100, 20], [20, 20], [20, 100], [0, 100]]];
const poloL = Geo.polylabel(formaL, 0.5);
assert.ok(Geo.pontoEmPoligono(poloL.x, poloL.y, formaL), "polo dentro do L");
assert.ok(poloL.distancia > 9.5 && poloL.distancia <= 12, `raio inscrito do L ≈ 10–11,7 (obtido ${poloL.distancia})`);

const formaU = [[[0, 0], [90, 0], [90, 90], [60, 90], [60, 30], [30, 30], [30, 90], [0, 90]]];
const poloU = Geo.polylabel(formaU, 0.5);
assert.ok(Geo.pontoEmPoligono(poloU.x, poloU.y, formaU), "polo dentro do U");
assert.ok(!Geo.pontoEmPoligono(45, 60, formaU), "o vão do U está fora");

const quadrado = [[[0, 0], [40, 0], [40, 40], [0, 40]]];
const poloQ = Geo.polylabel(quadrado, 0.1);
assert.ok(Math.abs(poloQ.x - 20) < 0.5 && Math.abs(poloQ.y - 20) < 0.5 && Math.abs(poloQ.distancia - 20) < 0.5);

// Furo no centro empurra o polo para fora do furo
const comFuro = [[[0, 0], [100, 0], [100, 100], [0, 100]], [[30, 30], [70, 30], [70, 70], [30, 70]]];
const poloF = Geo.polylabel(comFuro, 0.5);
assert.ok(Geo.pontoEmPoligono(poloF.x, poloF.y, comFuro));
assert.strictEqual(Geo.areaPoligono(comFuro), 10000 - 1600);
assert.strictEqual(Geo.polylabel([[[0, 0], [1, 1]]]).distancia, 0, "polígono degenerado não quebra");

// Ponto de rótulo em lat/lng: usa a maior parte e devolve o raio em metros
const rotulo = Geo.pontoRotuloLatLng([
  [[[-26.2200, -52.6700], [-26.2200, -52.6699], [-26.2199, -52.6699], [-26.2199, -52.6700]]],
  [[[-26.2300, -52.6800], [-26.2300, -52.6780], [-26.2280, -52.6780], [-26.2280, -52.6800]]]
]);
assert.strictEqual(rotulo.indiceParte, 1, "maior parte");
assert.ok(Math.abs(rotulo.lat - -26.229) < 1e-4 && Math.abs(rotulo.lng - -52.679) < 1e-4);
assert.ok(rotulo.raioMetros > 90 && rotulo.raioMetros < 115, `raio ≈ 100 m (obtido ${rotulo.raioMetros})`);
assert.strictEqual(Geo.pontoRotuloLatLng([]), null);

// --- Serpentina: grade 3×3 → 1 2 3 / 6 5 4 / 7 8 9 (norte→sul, oeste→leste alternando) ---
function grade(colunas, linhas, anguloGraus) {
  const a = (anguloGraus * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const girar = (x, y) => [x * c - y * s, x * s + y * c];
  const quadras = [];
  for (let lin = 0; lin < linhas; lin++) for (let col = 0; col < colunas; col++) {
    const x0 = col * 110, y0 = -lin * 110; // linha 0 = mais ao norte
    const anel = [[x0, y0], [x0 + 100, y0], [x0 + 100, y0 - 100], [x0, y0 - 100]].map(p => girar(p[0], p[1]));
    const [x, y] = girar(x0 + 50, y0 - 50);
    quadras.push({ x, y, anel });
  }
  return quadras;
}
assert.deepStrictEqual(Geo.numerarSerpentina(grade(3, 3, 0)), [1, 2, 3, 6, 5, 4, 7, 8, 9]);
assert.deepStrictEqual(Geo.numerarSerpentina(grade(3, 3, 25)), [1, 2, 3, 6, 5, 4, 7, 8, 9], "malha girada 25°");
assert.deepStrictEqual(Geo.numerarSerpentina(grade(3, 3, -30)), [1, 2, 3, 6, 5, 4, 7, 8, 9], "malha girada -30°");
assert.deepStrictEqual(Geo.numerarSerpentina(grade(4, 2, 10)), [1, 2, 3, 4, 8, 7, 6, 5]);
assert.deepStrictEqual(Geo.numerarSerpentina([]), []);
assert.deepStrictEqual(Geo.numerarSerpentina(grade(1, 1, 0)), [1]);
// Ordem de entrada não altera o resultado
const embaralhada = grade(3, 3, 25);
const permutacao = [4, 0, 8, 2, 6, 1, 7, 3, 5];
const numerosPermutados = Geo.numerarSerpentina(permutacao.map(i => embaralhada[i]));
assert.deepStrictEqual(numerosPermutados, permutacao.map(i => [1, 2, 3, 6, 5, 4, 7, 8, 9][i]));
assert.ok(Math.abs(Geo.orientacaoDominante(grade(2, 2, 25).map(q => q.anel)) - (25 * Math.PI) / 180) < 1e-6);

// --- ID de quadra: estável para deslocamentos menores que a grade (~5 m), distinto além disso ---
const id = Geo.idQuadra(-26.22501, -52.67001);
assert.ok(/^Q[0-9A-Z]{7}$/.test(id), id);
assert.strictEqual(Geo.idQuadra(-26.225012, -52.670008), id, "jitter de ~0,2 m mantém o ID");
assert.notStrictEqual(Geo.idQuadra(-26.22531, -52.67001), id, "30 m de distância muda o ID");

// --- Poligonização: 3 ruas verticais × 3 horizontais (com pontas sobrando) → 4 quadras ---
const op = { grade: 0.05, tolerancia: 0.06 };
const ruas = [];
for (const v of [0, 100, 200]) {
  ruas.push([v, -30, v, 230]);  // vertical, ultrapassa a malha (pontas soltas)
  ruas.push([-30, v, 230, v]);  // horizontal
}
ruas.push([50, 100, 50, 160]);  // rua sem saída dentro de uma quadra: não divide
let r = poligonizar(ruas, op);
assert.strictEqual(r.faces.length, 4, "quatro quadras");
for (const f of r.faces) assert.ok(Math.abs(f.area - 10000) < 1, `área ≈ 1 ha (obtida ${f.area})`);

// Limite de território sobreposto a uma rua (colinear) e cortando quadras ao meio
const comLimite = ruas.concat([[0, 0, 200, 0], [200, 0, 200, 50], [200, 50, 0, 50], [0, 50, 0, 0]]);
r = poligonizar(comLimite, op);
assert.strictEqual(r.faces.length, 6, "as duas quadras de baixo são divididas pelo limite");
assert.ok(Math.abs(r.faces.reduce((s, f) => s + f.area, 0) - 40000) < 1, "as faces cobrem a malha sem sobreposição");

// Encosto em T: rua que termina no meio de outra fecha a quadra
r = poligonizar([[0, 0, 100, 0], [100, 0, 100, 100], [100, 100, 0, 100], [0, 100, 0, 0], [50, 0, 50, 100]], op);
assert.strictEqual(r.faces.length, 2);

// Quadra isolada dentro de outra vira furo (sem sobreposição de áreas)
r = poligonizar([
  [0, 0, 300, 0], [300, 0, 300, 300], [300, 300, 0, 300], [0, 300, 0, 0],
  [100, 100, 200, 100], [200, 100, 200, 200], [200, 200, 100, 200], [100, 200, 100, 100]
], op);
assert.strictEqual(r.faces.length, 2);
assert.strictEqual(r.furos, 1);
assert.deepStrictEqual(r.faces.map(f => Math.round(f.area)).sort((a, b) => a - b), [10000, 80000]);

console.log("GEOMETRIA E QUADRAS: TODOS OS TESTES PASSARAM.");
