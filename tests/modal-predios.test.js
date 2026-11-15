/**
 * Modal de prédios (js/modal-predios.js): numeração sugerida da grade de apartamentos e a
 * lógica de marcar/desmarcar um apartamento.
 */
const assert = require("assert");
const fs = require("fs"), vm = require("vm"), path = require("path");

const salvos = [];
const ctx = vm.createContext({
  document: { addEventListener() {}, getElementById: () => null },
  App: {
    _predio: { idPredio: "P1", aptosTrabalhados: ["101"] },
    acharPredio(num, id) { return num === 7 && id === "P1" ? this._predio : null; },
    salvarApartamentosPredio(id, num, lista) { salvos.push(lista); this._predio.aptosTrabalhados = lista; return Promise.resolve(true); }
  },
  console
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "modal-predios.js"), "utf8") + "\n;globalThis.__M = ModalPredios;", ctx);
const M = ctx.__M;
const simples = v => JSON.parse(JSON.stringify(v));

// Grade: andar mais alto em cima, unidades andar*100 + n
assert.deepStrictEqual(simples(M.gradeSugerida({ andares: 3, apartamentos: 6 })), [
  { andar: 3, unidades: ["301", "302"] },
  { andar: 2, unidades: ["201", "202"] },
  { andar: 1, unidades: ["101", "102"] }
]);
assert.strictEqual(M.gradeSugerida({ andares: 10, apartamentos: 40 }).length, 10);
assert.deepStrictEqual(simples(M.gradeSugerida({ andares: 12, apartamentos: 24 })[0]), { andar: 12, unidades: ["1201", "1202"] });
// Sem dado confiável: sem grade (fica só o campo de digitação)
assert.strictEqual(M.gradeSugerida({ andares: 3, apartamentos: 7 }), null, "total não divide pelos andares");
assert.strictEqual(M.gradeSugerida({ andares: 0, apartamentos: 6 }), null);
assert.strictEqual(M.gradeSugerida({ andares: 2, apartamentos: 0 }), null);
assert.strictEqual(M.gradeSugerida({ andares: "", apartamentos: "" }), null);
assert.strictEqual(M.gradeSugerida({ andares: 1, apartamentos: 13 }), null, "mais de 12 por andar: provavelmente outro tipo de numeração");
assert.strictEqual(M.gradeSugerida({ andares: 41, apartamentos: 41 }), null);
// Rótulos da grade passam na mesma validação usada para o texto digitado
for (const linha of M.gradeSugerida({ andares: 30, apartamentos: 360 })) {
  for (const u of linha.unidades) assert.ok(/^[A-Z0-9][A-Z0-9\-]{0,9}$/.test(u));
}

// Toque: marca e desmarca preservando os demais
(async () => {
  await M.alternarApto("P1", 7, "102");
  assert.deepStrictEqual(simples(salvos[0]), ["101", "102"]);
  await M.alternarApto("P1", 7, "101");
  assert.deepStrictEqual(simples(salvos[1]), ["102"]);
  assert.strictEqual(M.alternarApto("P1", 9, "101"), undefined, "prédio de outro cartão: nada a fazer");
  console.log("MODAL DE PRÉDIOS: TODOS OS TESTES PASSARAM.");
})().catch(e => { console.error(e); process.exit(1); });
