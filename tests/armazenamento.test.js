/**
 * Armazenamento local (js/armazenamento.js) sem IndexedDB (Node): confere o modo de reserva em
 * memória, a fila em ordem de chegada e as regras de privacidade (troca de conta e limpeza).
 * O caminho com IndexedDB real é exercitado no navegador.
 */
const assert = require("assert");
const path = require("path");
const Armazenamento = require(path.join(__dirname, "..", "js", "armazenamento.js"));

(async () => {
  assert.strictEqual(await Armazenamento.ler("retrato"), null, "chave ausente devolve null");
  assert.strictEqual(await Armazenamento.gravar("retrato", { versao: "v1", territorios: [{ numero: 1 }] }), true);
  assert.deepStrictEqual(await Armazenamento.ler("retrato"), { versao: "v1", territorios: [{ numero: 1 }] });
  assert.strictEqual(Armazenamento._usarMemoria, true, "sem IndexedDB, usa a memória");
  await Armazenamento.remover("retrato");
  assert.strictEqual(await Armazenamento.ler("retrato"), null);

  // Fila: ordem de chegada, atualização e remoção
  const id1 = await Armazenamento.filaAdicionar({ rota: "quadras/salvar", chave: "quadras:1" });
  const id2 = await Armazenamento.filaAdicionar({ rota: "predios/marcar-trabalhado", chave: "predio:P1" });
  assert.ok(id2 > id1);
  assert.deepStrictEqual((await Armazenamento.filaListar()).map(i => i.chave), ["quadras:1", "predio:P1"]);
  const [primeiro] = await Armazenamento.filaListar();
  await Armazenamento.filaAtualizar(Object.assign({}, primeiro, { tentativas: 2 }));
  assert.strictEqual((await Armazenamento.filaListar())[0].tentativas, 2);
  await Armazenamento.filaRemover(id1);
  assert.deepStrictEqual((await Armazenamento.filaListar()).map(i => i.id), [id2]);

  // Dono: mesma conta mantém os dados; outra conta apaga tudo (retrato e fila)
  assert.strictEqual(await Armazenamento.definirDono("Ana@Exemplo.Test "), false, "primeiro dono: nada a apagar");
  assert.strictEqual(await Armazenamento.obterDono(), "ana@exemplo.test");
  await Armazenamento.gravar("retrato", { versao: "v2" });
  assert.strictEqual(await Armazenamento.definirDono("ana@exemplo.test"), false);
  assert.deepStrictEqual(await Armazenamento.ler("retrato"), { versao: "v2" }, "mesma conta: dados preservados");
  assert.strictEqual(await Armazenamento.definirDono("bruno@exemplo.test"), true, "outra conta: limpeza");
  assert.strictEqual(await Armazenamento.ler("retrato"), null, "retrato da conta anterior apagado");
  assert.deepStrictEqual(await Armazenamento.filaListar(), [], "fila da conta anterior apagada");
  assert.strictEqual(await Armazenamento.obterDono(), "bruno@exemplo.test");

  // Logout: nada sobra
  await Armazenamento.gravar("geometria", { versao: "g1" });
  await Armazenamento.filaAdicionar({ rota: "x" });
  await Armazenamento.limparTudo();
  assert.strictEqual(await Armazenamento.ler("geometria"), null);
  assert.strictEqual(await Armazenamento.obterDono(), "");
  assert.deepStrictEqual(await Armazenamento.filaListar(), []);

  console.log("ARMAZENAMENTO LOCAL: TODOS OS TESTES PASSARAM.");
})().catch(erro => { console.error(erro); process.exit(1); });
