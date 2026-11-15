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
// Total que não divide pelos andares: arredonda para cima (39 aptos em 19 andares = 3 por andar)
assert.deepStrictEqual(simples(M.gradeSugerida({ andares: 3, apartamentos: 7 })[0]), { andar: 3, unidades: ["301", "302", "303"] });
assert.strictEqual(M.gradeSugerida({ andares: 19, apartamentos: 39 })[0].unidades.length, 3);
// Escolha feita no aparelho prevalece sobre o cadastro e permite grade sem total cadastrado
assert.strictEqual(M.gradeSugerida({ andares: 3, apartamentos: 6 }, 4)[0].unidades.length, 4);
assert.deepStrictEqual(simples(M.gradeSugerida({ andares: 2, apartamentos: 0 }, 2)), [
  { andar: 2, unidades: ["201", "202"] },
  { andar: 1, unidades: ["101", "102"] }
]);
assert.strictEqual(M.gradeSugerida({ andares: 2, apartamentos: 0 }, 13), null, "escolha fora do limite");
assert.strictEqual(M.gradeSugerida({ andares: 0, apartamentos: 0 }, 2), null, "sem andares não há grade");
// Cadastro com "AptosPorAndar" prevalece sobre a divisão do total
assert.strictEqual(M.gradeSugerida({ andares: 4, apartamentos: 6, aptosPorAndar: 2 })[0].unidades.length, 2);
// Sugestão em revisão: a grade usa os números sugeridos
const emRevisao = M.dadosEfetivos({ andares: 2, apartamentos: 0, revisaoPendente: { andares: 6, aptosPorAndar: 4, criadaEm: "agora" } });
assert.deepStrictEqual(simples(emRevisao), { andares: 6, aptosPorAndar: 4, emRevisao: true });
assert.strictEqual(M.gradeSugerida(emRevisao).length, 6);
assert.strictEqual(M.dadosEfetivos({ andares: 3, apartamentos: 6, revisaoPendente: null }).emRevisao, false);
// Validação do formulário "Corrigir cadastro"
assert.deepStrictEqual(simples(M.validarCadastro("8", "4", "  ok ")), { andares: 8, aptosPorAndar: 4, observacao: "ok" });
assert.ok(M.validarCadastro("", "4").erro);
assert.ok(M.validarCadastro("8", "13").erro);
assert.ok(M.validarCadastro("2.5", "2").erro);
assert.strictEqual(M.textoTotal(8, 4), "= 32 apartamento(s)");
assert.strictEqual(M.textoTotal("", 4), "");
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
