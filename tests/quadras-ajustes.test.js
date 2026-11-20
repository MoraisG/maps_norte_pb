/**
 * Spec 05 — ajustes manuais de quadras (scripts/quadras/ajustes.js e ajustar-quadras.js):
 * número, rótulo, posição, ocultar; reversível e idempotente; e quadras.geojson do repositório
 * em dia com scripts/quadras/ajustes-quadras.json.
 */
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const RAIZ = path.join(__dirname, "..");
const Ajustes = require(path.join(RAIZ, "scripts", "quadras", "ajustes.js"));
const Cli = require(path.join(RAIZ, "scripts", "quadras", "ajustar-quadras.js"));

const feicao = (terr, id, n, lat, lng) => ({
  type: "Feature",
  properties: { NUM_TERR: terr, ID_QUADRA: id, NUM_QUADRA: n, ROTULO: String(n), LABEL_LNG: lng, LABEL_LAT: lat },
  geometry: { type: "Polygon", coordinates: [[[lng, lat], [lng + 0.001, lat], [lng, lat + 0.001], [lng, lat]]] }
});
const base = () => [
  feicao(12, "QA", 1, -26.21, -52.67),
  feicao(12, "QB", 2, -26.22, -52.68),
  feicao(12, "QC", 3, -26.23, -52.69),
  feicao(13, "QD", 1, -26.24, -52.70)
];
const props = (fs_, id) => fs_.find(f => f.properties.ID_QUADRA === id).properties;

// --- 1. Aplicar: número, rótulo, posição, ocultar ---
{
  const ent = base();
  const r = Ajustes.aplicarAjustes(ent, { ajustes: {
    QA: { terr: 12, numero: 3 },
    QC: { terr: 12, numero: 1, rotulo: "1A", lat: -26.2312345678, lng: -52.6912345678 },
    QB: { terr: 12, oculta: true, obs: "canteiro" }
  } });
  assert.deepStrictEqual(r.avisos, []);
  assert.strictEqual(r.aplicados, 3);
  assert.strictEqual(props(r.features, "QA").NUM_QUADRA, 3);
  assert.strictEqual(props(r.features, "QA").ROTULO, "3", "rótulo acompanha o número");
  assert.deepStrictEqual(props(r.features, "QA")._GER, { n: 1, lat: -26.21, lng: -52.67 }, "guarda o que o gerador fez");
  assert.strictEqual(props(r.features, "QC").ROTULO, "1A");
  assert.strictEqual(props(r.features, "QC").LABEL_LAT, -26.231235, "posição com 6 casas");
  assert.strictEqual(props(r.features, "QB").OCULTA, true, "oculta continua no arquivo");
  assert.strictEqual(r.features.length, 4);
  assert.strictEqual(ent[0].properties.NUM_QUADRA, 1, "entrada não é alterada");
  assert.ok(!("obs" in props(r.features, "QB")), "observação fica só no arquivo de ajustes");

  // Idempotente: aplicar de novo sobre a saída dá o mesmo resultado
  const r2 = Ajustes.aplicarAjustes(r.features, { ajustes: {
    QA: { terr: 12, numero: 3 }, QC: { terr: 12, numero: 1, rotulo: "1A", lat: -26.2312345678, lng: -52.6912345678 }, QB: { terr: 12, oculta: true }
  } });
  assert.deepStrictEqual(r2.features, r.features);

  // Reversível: sem ajustes, volta exatamente ao que o gerador fez
  const r3 = Ajustes.aplicarAjustes(r.features, { ajustes: {} });
  assert.deepStrictEqual(r3.features, base());
}

// --- 2. Avisos: território errado, ajuste órfão, número repetido ---
{
  const r = Ajustes.aplicarAjustes(base(), { ajustes: {
    QD: { terr: 12, numero: 9 },     // QD é do 13
    QZ: { terr: 12, numero: 4 },     // não existe
    QA: { terr: 12, numero: 2 }      // repete o 2 de QB
  } });
  assert.strictEqual(props(r.features, "QD").NUM_QUADRA, 1, "ajuste com território errado é ignorado");
  assert.ok(r.avisos.some(a => a.includes("QD") && a.includes("ignorado")));
  assert.ok(r.avisos.some(a => a.includes("QZ") && a.includes("não existe mais")));
  assert.ok(r.avisos.some(a => a.includes("Território 12") && a.includes("quadra 2 aparece mais de uma vez")));
  // Ocultar a quadra repetida resolve o aviso
  const r2 = Ajustes.aplicarAjustes(base(), { ajustes: { QA: { terr: 12, numero: 2 }, QB: { terr: 12, oculta: true } } });
  assert.deepStrictEqual(r2.avisos, []);
}

// --- 3. Linha de comando sobre cópias temporárias ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quadras-ajustes-"));
  const arqQ = path.join(dir, "q.geojson"), arqA = path.join(dir, "a.json");
  fs.writeFileSync(arqQ, Ajustes.serializarColecao({ type: "FeatureCollection", name: "quadras", features: base() }));
  const log = [];
  const rodar = (...args) => Cli.executar(args.concat([`--quadras=${arqQ}`, `--ajustes=${arqA}`]), l => log.push(l));
  const ler = () => JSON.parse(fs.readFileSync(arqQ, "utf8")).features;

  assert.strictEqual(rodar("--terr=12", "--trocar=1,3"), 0);
  assert.strictEqual(props(ler(), "QA").NUM_QUADRA, 3);
  assert.strictEqual(props(ler(), "QC").NUM_QUADRA, 1);

  assert.strictEqual(rodar("--terr=12", "--quadra=2", "--rotulo=2B", "--posicao=-26.3,-52.8"), 0);
  assert.strictEqual(props(ler(), "QB").ROTULO, "2B");
  assert.strictEqual(props(ler(), "QB").LABEL_LNG, -52.8);

  assert.strictEqual(rodar("--terr=12", "--quadra=2", "--ocultar"), 0);
  assert.strictEqual(props(ler(), "QB").OCULTA, true);
  assert.throws(() => rodar("--terr=12", "--quadra=2", "--rotulo=X"), /não há quadra visível/, "oculta não é achada pelo número");
  assert.strictEqual(rodar("--terr=12", "--id=QB", "--mostrar"), 0);
  assert.ok(!props(ler(), "QB").OCULTA);

  assert.strictEqual(rodar("--terr=12", "--id=QB", "--desfazer"), 0);
  assert.strictEqual(props(ler(), "QB").ROTULO, "2", "desfazer volta ao gerador");
  assert.ok(!props(ler(), "QB")._GER);

  const salvos = JSON.parse(fs.readFileSync(arqA, "utf8"));
  assert.deepStrictEqual(Object.keys(salvos.ajustes).sort(), ["QA", "QC"]);
  assert.strictEqual(rodar("--terr=12", "--listar"), 0);
  assert.ok(log.some(l => l.includes("QA") && l.includes("gerador: nº 1")));

  assert.throws(() => rodar("--terr=12", "--quadra=1", "--numero=0"), /inteiro positivo/);
  assert.throws(() => rodar("--quadra=1", "--numero=2"), /território/);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 4. Repositório: quadras.geojson em dia com ajustes-quadras.json ---
{
  const arqQ = path.join(RAIZ, "quadras.geojson");
  const texto = fs.readFileSync(arqQ, "utf8").replace(/\r\n/g, "\n");
  const colecao = JSON.parse(texto);
  const r = Ajustes.aplicarAjustes(colecao.features, Ajustes.lerAjustes());
  assert.deepStrictEqual(r.avisos, [], "ajustes-quadras.json sem avisos");
  assert.strictEqual(Ajustes.serializarColecao(Object.assign({}, colecao, { features: r.features })), texto,
    "quadras.geojson desatualizado: rode node scripts/quadras/ajustar-quadras.js --aplicar");
}

console.log("quadras-ajustes: ok");
