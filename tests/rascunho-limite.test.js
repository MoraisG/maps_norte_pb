/**
 * Rascunho de territórios a partir do limite de outra cidade (spec 04):
 * scripts/territorios/rascunho-limite.js — leitura de KMZ/KML/GeoJSON (só polígonos),
 * corte pelas estradas, agrupamento por área, dissolução, WKT/CSV no formato da BASE.
 * Dados sintéticos; nenhuma rede.
 */
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib"), assert = require("assert");
const R = require("../scripts/territorios/rascunho-limite.js");
const Geo = require("../js/geo.js");

// ---------------------------------------------------------------------------------------------
// KML com um polígono (com furo), um ponto (casa) e um MultiGeometry
// ---------------------------------------------------------------------------------------------
const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Placemark><name>Casa do Fulano - Linha X</name><ExtendedData><Data name="Tipo"><value>leite</value></Data></ExtendedData>
  <Point><coordinates>-52.80,-26.05,0</coordinates></Point></Placemark>
<Placemark><name><![CDATA[Cidade Teste & Região]]></name>
  <Polygon><outerBoundaryIs><LinearRing><coordinates>
    -52.90,-26.10,0 -52.80,-26.10,0 -52.80,-26.00,0 -52.90,-26.00,0 -52.90,-26.10,0
  </coordinates></LinearRing></outerBoundaryIs>
  <innerBoundaryIs><LinearRing><coordinates>-52.86,-26.06 -52.85,-26.06 -52.85,-26.05 -52.86,-26.05 -52.86,-26.06</coordinates></LinearRing></innerBoundaryIs>
  </Polygon></Placemark>
<Placemark><name>Outro</name><MultiGeometry>
  <Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,1 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon>
  <Polygon><outerBoundaryIs><LinearRing><coordinates>2,0 3,0 3,1 2,1 2,0</coordinates></LinearRing></outerBoundaryIs></Polygon>
</MultiGeometry></Placemark>
</Document></kml>`;

const pols = R.lerPoligonosKml(kml);
assert.strictEqual(pols.length, 2, "só Placemarks com polígono (o ponto é ignorado)");
assert.strictEqual(pols[0].nome, "Cidade Teste & Região", "nome com CDATA");
assert.strictEqual(pols[0].partes.length, 1);
assert.strictEqual(pols[0].partes[0].length, 2, "anel externo + furo");
assert.deepStrictEqual(pols[0].partes[0][0][0], [-52.9, -26.1], "lon/lat, sem altitude");
assert.strictEqual(pols[1].partes.length, 2, "MultiGeometry vira duas partes");
assert.ok(!JSON.stringify(pols).includes("Fulano") && !JSON.stringify(pols).includes("leite"), "nada do ponto/atributos vaza");

assert.strictEqual(R.escolherPoligono(pols, "cidade teste").nome, "Cidade Teste & Região");
assert.throws(() => R.escolherPoligono(pols, "inexistente"), /Nenhum polígono corresponde[\s\S]*Cidade Teste/);
assert.throws(() => R.escolherPoligono(pols, ""), /Mais de um/);

// ---------------------------------------------------------------------------------------------
// KMZ (ZIP com deflate e stored) e GeoJSON
// ---------------------------------------------------------------------------------------------
function criarZip(arquivos) {
  const locais = [], central = [];
  let pos = 0;
  for (const [nome, conteudo, comprimir] of arquivos) {
    const dados = comprimir ? zlib.deflateRawSync(conteudo) : conteudo;
    const nomeBuf = Buffer.from(nome);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(comprimir ? 8 : 0, 8);
    lh.writeUInt32LE(dados.length, 18); lh.writeUInt32LE(conteudo.length, 22); lh.writeUInt16LE(nomeBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(comprimir ? 8 : 0, 10);
    ch.writeUInt32LE(dados.length, 20); ch.writeUInt32LE(conteudo.length, 24); ch.writeUInt16LE(nomeBuf.length, 28);
    ch.writeUInt32LE(pos, 42);
    locais.push(lh, nomeBuf, dados);
    central.push(ch, nomeBuf);
    pos += 30 + nomeBuf.length + dados.length;
  }
  const centralBuf = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(arquivos.length, 8); fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(centralBuf.length, 12); fim.writeUInt32LE(pos, 16);
  return Buffer.concat([...locais, centralBuf, fim]);
}

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "rascunho-teste-"));
try {
  const kmz = path.join(pasta, "teste.kmz");
  fs.writeFileSync(kmz, criarZip([["images/icone.png", Buffer.from([1, 2, 3]), false], ["doc.kml", Buffer.from(kml), true]]));
  const doKmz = R.lerLimite(kmz);
  assert.strictEqual(doKmz.length, 2, "KMZ: lê o doc.kml compactado e ignora as imagens");
  assert.deepStrictEqual(doKmz[0].partes, pols[0].partes);

  const kmlArq = path.join(pasta, "teste.kml");
  fs.writeFileSync(kmlArq, kml);
  assert.strictEqual(R.lerLimite(kmlArq).length, 2);

  const gj = path.join(pasta, "limite.geojson");
  fs.writeFileSync(gj, JSON.stringify({ type: "FeatureCollection", features: [
    { type: "Feature", properties: { NM_MUN: "Município X" }, geometry: { type: "Polygon", coordinates: [[[-52, -26], [-51.9, -26], [-51.9, -25.9], [-52, -26]]] } },
    { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [-52, -26] } }
  ] }));
  const doGeojson = R.lerLimite(gj);
  assert.strictEqual(doGeojson.length, 1);
  assert.strictEqual(doGeojson[0].nome, "Município X");

  const utm = path.join(pasta, "utm.geojson");
  fs.writeFileSync(utm, JSON.stringify({ type: "Polygon", coordinates: [[[340000, 7100000], [341000, 7100000], [341000, 7101000], [340000, 7100000]]] }));
  assert.throws(() => R.lerLimite(utm), /projetadas.*WGS84/, "UTM é recusado com orientação");
  assert.throws(() => R.lerLimite(path.join(pasta, "x.shp")), /não suportado/);
} finally {
  fs.rmSync(pasta, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------
// Dissolver e agrupar faces (grade 2 x 2 de quadrados de 100 m)
// ---------------------------------------------------------------------------------------------
const q = (x, y) => ({ poligono: [[[x, y], [x + 100, y], [x + 100, y + 100], [x, y + 100]]], area: 1e4 });
const grade = [q(0, 0), q(100, 0), q(0, 100), q(100, 100)];
const unido = R.dissolver(grade);
assert.strictEqual(unido.length, 1, "quatro quadrados vizinhos viram um contorno");
assert.strictEqual(Geo.areaPoligono(unido[0]), 4e4);
const separados = R.dissolver([q(0, 0), q(500, 0)]);
assert.strictEqual(separados.length, 2, "faces sem aresta em comum continuam separadas");
// Anel de 8 quadrados em volta de um furo
const anel8 = [];
for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) if (x !== 1 || y !== 1) anel8.push(q(x * 100, y * 100));
const comFuro = R.dissolver(anel8);
assert.strictEqual(comFuro.length, 1);
assert.strictEqual(comFuro[0].length, 2, "contorno externo + furo");
assert.strictEqual(Geo.areaPoligono(comFuro[0]), 8e4);

const grupos = R.agruparFaces([q(0, 0), q(100, 0), q(200, 0), q(300, 0)], 2e4);
assert.strictEqual(grupos.length, 2, "4 faces de 1 ha com alvo de 2 ha: 2 grupos");
assert.ok(grupos.every(g => g.length === 2));
const comSobra = R.agruparFaces([q(0, 0), q(100, 0), q(200, 0)], 2e4);
assert.strictEqual(comSobra.length, 2, "sobra de 1 ha (50% do alvo) fica como grupo próprio");
const sobraPequena = R.agruparFaces([q(0, 0), q(100, 0), q(200, 0), q(300, 0), { poligono: [[[400, 0], [420, 0], [420, 100], [400, 100]]], area: 2000 }], 2e4);
assert.strictEqual(sobraPequena.length, 2, "sobra pequena (< 40% do alvo) é absorvida pelo vizinho");

// ---------------------------------------------------------------------------------------------
// Candidatos: limite ~2 km x 2 km cortado por uma estrada em cruz → 4 faces de ~100 ha
// ---------------------------------------------------------------------------------------------
const limite = { nome: "Teste", partes: [[[[-52.81, -26.11], [-52.79, -26.11], [-52.79, -26.09], [-52.81, -26.09], [-52.81, -26.11]]]] };
const via = (id, highway, pts) => ({ type: "way", id, tags: { highway }, geometry: pts.map(([lat, lon]) => ({ lat, lon })) });
const osm = { elements: [
  via(1, "unclassified", [[-26.115, -52.80], [-26.085, -52.80]]),       // norte-sul, passa da divisa
  via(2, "tertiary", [[-26.10, -52.815], [-26.10, -52.785]]),           // leste-oeste
  via(3, "residential", [[-26.105, -52.805], [-26.105, -52.795]]),      // não divide (classe fora de --vias)
  via(4, "unclassified", [[-26.20, -52.90], [-26.21, -52.91]])          // fora do limite
] };
const vias = ["tertiary", "unclassified"];
const r1 = R.gerarCandidatos(limite, osm, { vias, areaAlvoHa: 100 });
assert.strictEqual(r1.faces, 4, "a cruz divide o limite em 4 faces");
assert.strictEqual(r1.candidatos.length, 4);
assert.ok(Math.abs(r1.coberturaPct - 100) < 0.5, "candidatos cobrem o limite inteiro");
assert.deepStrictEqual(r1.candidatos.map(c => c.id), ["C01", "C02", "C03", "C04"]);
// C01 = noroeste (numeração norte → sul, oeste → leste)
const c1 = r1.candidatos[0].partes[0][0];
assert.ok(c1.every(c => c[0] <= -52.7999 && c[1] >= -26.1001), "C01 é o quadrante noroeste");
for (const c of r1.candidatos) {
  const anel = c.partes[0][0];
  assert.deepStrictEqual(anel[0], anel[anel.length - 1], "anel fechado (WKT/GeoJSON)");
  assert.ok(c.areaHa > 90 && c.areaHa < 115);
}
const r2 = R.gerarCandidatos(limite, osm, { vias, areaAlvoHa: 200 });
assert.strictEqual(r2.candidatos.length, 2, "alvo de 200 ha junta pares de faces");
assert.ok(r2.candidatos.every(c => c.partes.length === 1), "faces juntadas viram um polígono só");
const r3 = R.gerarCandidatos(limite, { elements: [] }, { vias, areaAlvoHa: 100 });
assert.strictEqual(r3.candidatos.length, 1, "sem estradas: o limite inteiro é um candidato");
assert.ok(r3.candidatos[0].alertas.some(a => /grande demais/.test(a)));

// ---------------------------------------------------------------------------------------------
// Saída no formato da BASE
// ---------------------------------------------------------------------------------------------
assert.strictEqual(R.paraWkt([[[[1, 2], [3, 4], [5, 6], [1, 2]]]]), "MULTIPOLYGON (((1 2, 3 4, 5 6, 1 2)))");
const wkt = R.paraWkt(r1.candidatos[0].partes);
const lido = Geo.parseWktPartes(wkt);
assert.strictEqual(lido.length, 1, "o WKT gerado é lido pelo parser do app");
const csv = R.paraCsv(r1.candidatos, "Cidade, PR").trim().split("\n");
assert.strictEqual(csv[0], "NUM_TER,DESC_TERRITORIO,SITUACAO,wkt_geom,CIDADE,CANDIDATO,AREA_HA,ALERTAS");
assert.strictEqual(csv.length, 5);
assert.ok(csv[1].startsWith(',Rascunho C01,,"MULTIPOLYGON ((('), "NUM_TER vazio (decisão Q5) e WKT entre aspas");
assert.ok(csv[1].includes(',"Cidade, PR",C01,'));

// Territórios tocados e pasta de saída
const tocados = R.territoriosTocados(limite, [
  { numero: 1, partes: [[[[-52.805, -26.105], [-52.80, -26.105], [-52.80, -26.10], [-52.805, -26.105]]]] },
  { numero: 2, partes: [[[[-53, -27], [-52.99, -27], [-52.99, -26.99], [-53, -27]]]] }
]);
assert.deepStrictEqual(tocados.map(t => t.numero), [1]);
assert.ok(R.dentroDoRepositorio(path.join(__dirname, "..", "saida")), "pasta dentro do repositório é recusada");
assert.ok(!R.dentroDoRepositorio(os.tmpdir()));

console.log("rascunho-limite: ok");
