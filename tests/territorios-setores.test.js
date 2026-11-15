/**
 * Territórios a partir dos setores censitários do IBGE (scripts/territorios/territorios-setores.js):
 * leitura do KML do IBGE, numeração na ordem do CD_SETOR, CSV da BASE e acréscimo ao geojson.
 */
const assert = require("assert");
const path = require("path");
const S = require(path.join(__dirname, "..", "scripts", "territorios", "territorios-setores.js"));

const quadrado = (lng, lat, d) => `${lng},${lat} ${lng + d},${lat} ${lng + d},${lat + d} ${lng},${lat + d} ${lng},${lat}`;
const placemark = (cd, sit, bairro, coords) => `<Placemark><name>${cd}</name><ExtendedData><SchemaData>
<SimpleData name="CD_SETOR">${cd}</SimpleData><SimpleData name="SITUACAO">${sit}</SimpleData>
${bairro ? `<SimpleData name="NM_BAIRRO">${bairro}</SimpleData>` : ""}<SimpleData name="NM_MUN">Cidade Teste</SimpleData>
</SchemaData></ExtendedData><MultiGeometry><Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></MultiGeometry></Placemark>`;
const kml = `<kml><Document>
${placemark("410000005000003", "Urbana", "", quadrado(-52.80, -26.10, 0.002))}
${placemark("410000005000002", "Rural", "", quadrado(-52.85, -26.15, 0.05))}
${placemark("410000005000004", "Urbana", "São Pedro", quadrado(-52.81, -26.11, 0.001))}
<Placemark><name>sem setor</name><Point><coordinates>-52.8,-26.1</coordinates></Point></Placemark>
</Document></kml>`;

// Leitura: só placemarks com CD_SETOR e polígono, ordenados pelo código do setor
const setores = S.lerSetoresKml(kml);
assert.deepStrictEqual(setores.map(s => s.attr.CD_SETOR), ["410000005000002", "410000005000003", "410000005000004"]);

// Numeração contínua a partir de `inicio`, situação e descrição
const terr = S.montarTerritorios(setores, 100, "Cidade Teste", 1);
assert.deepStrictEqual(terr.map(t => t.numero), [100, 101, 102]);
assert.deepStrictEqual(terr.map(t => t.situacao), ["Rural", "Urbana", "Urbana"]);
assert.deepStrictEqual(terr.map(t => t.descricao), ["Cidade Teste - Interior", "Cidade Teste - Sede", "São Pedro"]);
assert.ok(terr[0].areaHa > 2000 && terr[0].areaHa < 3500, `área rural ${terr[0].areaHa}`);
assert.ok(terr[1].areaHa > 2 && terr[1].areaHa < 6, `área urbana ${terr[1].areaHa}`);

// Simplificação: mantém o anel fechado e os cantos; remove ponto colinear
const anel = [[0, 0], [0.0005, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]];
const proj = { paraXY: (lat, lng) => [lng * 100000, lat * 100000] };
const simpl = S.simplificarAnel(anel, 1, proj);
assert.deepStrictEqual(simpl, [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]);
assert.deepStrictEqual(S.simplificarAnel(anel, 0, proj), anel, "tolerância 0 não simplifica");

// CSV da BASE: NUM_TER, DESC_TERRITORIO, SITUACAO, wkt_geom nas quatro primeiras colunas
const csv = S.paraCsvBase(terr).trim().split("\n");
assert.strictEqual(csv[0], "NUM_TER,DESC_TERRITORIO,SITUACAO,wkt_geom,CIDADE,CD_SETOR,AREA_HA");
assert.ok(csv[1].startsWith('100,Cidade Teste - Interior,Rural,"MULTIPOLYGON ((('), csv[1].slice(0, 80));
assert.strictEqual(csv.length, 4);

// Acréscimo ao geojson: mantém as features atuais e recusa números repetidos
const atual = '{\n"type": "FeatureCollection",\n"features": [\n{ "type": "Feature", "properties": { "NUM_TERR": 99 }, "geometry": null }\n]\n}\n';
const novo = JSON.parse(S.acrescentarAoGeojson(atual, terr));
assert.deepStrictEqual(novo.features.map(f => f.properties.NUM_TERR), [99, 100, 101, 102]);
assert.deepStrictEqual(Object.keys(novo.features[1].properties), ["NUM_TERR"], "só NUM_TERR, como as demais");
assert.throws(() => S.acrescentarAoGeojson(JSON.stringify(novo), terr), /já existentes/);

console.log("TERRITÓRIOS A PARTIR DE SETORES CENSITÁRIOS: TODOS OS TESTES PASSARAM.");
