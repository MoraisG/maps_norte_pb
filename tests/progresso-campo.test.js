/**
 * Progresso do cartão em campo: alfinetes de quadras e apartamentos trabalhados.
 * Simula a planilha em memória para validar as regras de devolução:
 *  - quadras: sempre apagadas ao devolver;
 *  - prédios/apartamentos: mantidos até todos os prédios do cartão serem concluídos.
 */
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const src = fs.readFileSync(process.argv[2] || require("path").join(__dirname, "..", "backend", "Code.gs"), "utf8");

function criarAba(linhas) {
  const dados = linhas.map(l => l.slice());
  return {
    dados,
    getDataRange: () => ({ getValues: () => dados.map(l => l.slice()) }),
    getLastColumn: () => Math.max(...dados.map(l => l.length)),
    appendRow: l => { dados.push(l.slice()); },
    getRange: (lin, col, nLin = 1, nCol = 1) => ({
      getValue: () => (dados[lin - 1] || [])[col - 1],
      setValue: v => { while (dados[lin - 1].length < col) dados[lin - 1].push(""); dados[lin - 1][col - 1] = v; },
      setValues: m => {
        for (let i = 0; i < nLin; i++) for (let j = 0; j < nCol; j++) {
          while (dados[lin - 1 + i].length < col + j) dados[lin - 1 + i].push("");
          dados[lin - 1 + i][col - 1 + j] = m[i][j];
        }
      }
    })
  };
}

const abas = {};
const ss = {
  getSheetByName: n => abas[n] || null,
  insertSheet: n => (abas[n] = criarAba([]))
};
const ctx = {
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  Utilities: {}, Session: {}, SpreadsheetApp: {}, Logger: { log() {} }, console
};
vm.createContext(ctx);
vm.runInContext(src + "\nthis.__t={normalizarApartamentos,normalizarPinosQuadras,extrairLimitesWkt,lerListaJson,gravarQuadrasDoTerritorio,carregarQuadrasPorTerritorio,encerrarProgressoNaDevolucao,LIMITE_PINOS_QUADRAS};", ctx);
const t = ctx.__t;
const json = v => JSON.parse(JSON.stringify(v));

// --- Apartamentos: só identificadores curtos, sem duplicatas, em ordem natural ---
assert.deepStrictEqual(json(t.normalizarApartamentos(["202", " 101 ", "12b", 101, "101"])), ["12B", "101", "202"]);
assert.deepStrictEqual(json(t.normalizarApartamentos(["=HYPERLINK(1)", "João da Silva mora aqui", "", null, {}, "-1"])), []);
assert.deepStrictEqual(json(t.normalizarApartamentos("101")), []);
assert.deepStrictEqual(json(t.lerListaJson("não é json")), []);
assert.deepStrictEqual(json(t.lerListaJson('["101"]')), ["101"]);

// --- Quadras: pontos precisam estar dentro da área do território ---
const wkt = "MultiPolygonZ (((-52.6750 -26.2250 0, -52.6700 -26.2250 0, -52.6700 -26.2200 0, -52.6750 -26.2200 0, -52.6750 -26.2250 0)))";
const lim = t.extrairLimitesWkt(wkt);
assert.ok(lim && lim.minLat < -26.225 && lim.maxLat > -26.22 && lim.minLng < -52.675 && lim.maxLng > -52.67);
assert.strictEqual(t.extrairLimitesWkt(""), null);
assert.deepStrictEqual(
  json(t.normalizarPinosQuadras([{ lat: -26.2221234567, lng: -52.6721 }, { lat: -26.2221234567, lng: -52.6721 }], lim)),
  [{ lat: -26.222123, lng: -52.6721 }]
);
assert.strictEqual(t.normalizarPinosQuadras([{ lat: -26.30, lng: -52.6721 }], lim), null, "fora do território");
assert.strictEqual(t.normalizarPinosQuadras([{ lat: "x", lng: 1 }], lim), null);
assert.strictEqual(t.normalizarPinosQuadras("[]", lim), null);
assert.strictEqual(t.normalizarPinosQuadras(new Array(t.LIMITE_PINOS_QUADRAS + 1).fill({ lat: -26.222, lng: -52.672 }), lim), null);
assert.deepStrictEqual(json(t.normalizarPinosQuadras([], lim)), []);

// --- Persistência das quadras e limpeza na devolução ---
t.gravarQuadrasDoTerritorio(ss, "7", [{ lat: -26.222, lng: -52.672 }, { lat: -26.223, lng: -52.673 }]);
t.gravarQuadrasDoTerritorio(ss, "8", [{ lat: -26.221, lng: -52.671 }]);
assert.strictEqual(json(t.carregarQuadrasPorTerritorio(ss))["7"].length, 2);

const cab = ["IdPredio", "NumeroTerritorio", "NomeEdificio", "Endereco", "Andares", "Apartamentos", "TipoInterfone", "TagsLogisticas", "ReferenciaComercial", "Latitude", "Longitude", "UltimaDataConclusao", "AptosTrabalhados"];
const predio = (id, terr, data, aptos) => [id, terr, "Ed. " + id, "Rua X", 3, 6, "EXTERNO", "", "", -26.22, -52.67, data, aptos];
abas.Predios = criarAba([
  cab,
  predio("PRD-A", 7, "2026-11-01", '["101","102"]'),
  predio("PRD-B", 7, "", '["201"]'),
  predio("PRD-C", 8, "2026-11-02", '["11"]')
]);

// Devolução com prédio pendente: quadras somem, histórico de prédios/apartamentos permanece
let r = t.encerrarProgressoNaDevolucao(ss, "7");
assert.deepStrictEqual(json(r), { totalPredios: 2, prediosConcluidos: 1, cicloPrediosCompleto: false });
assert.strictEqual(json(t.carregarQuadrasPorTerritorio(ss))["7"], undefined);
assert.strictEqual(json(t.carregarQuadrasPorTerritorio(ss))["8"].length, 1, "outros territórios intactos");
assert.strictEqual(abas.Predios.dados[1][11], "2026-11-01");
assert.strictEqual(abas.Predios.dados[1][12], '["101","102"]');
assert.strictEqual(abas.Predios.dados[2][12], '["201"]');

// Próximo ciclo conclui o prédio que faltava: ao devolver, o histórico do cartão é zerado
abas.Predios.dados[2][11] = "2026-11-10";
r = t.encerrarProgressoNaDevolucao(ss, "7");
assert.deepStrictEqual(json(r), { totalPredios: 2, prediosConcluidos: 2, cicloPrediosCompleto: true });
assert.deepStrictEqual(abas.Predios.dados[1].slice(11), ["", ""]);
assert.deepStrictEqual(abas.Predios.dados[2].slice(11), ["", ""]);
assert.deepStrictEqual(abas.Predios.dados[3].slice(11), ["2026-11-02", '["11"]'], "território 8 intacto");

// Cartão sem prédios: nada a encerrar
assert.deepStrictEqual(json(t.encerrarProgressoNaDevolucao(ss, "99")), { totalPredios: 0, prediosConcluidos: 0, cicloPrediosCompleto: false });

console.log("PROGRESSO EM CAMPO: TODOS OS TESTES PASSARAM.");
