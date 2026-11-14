/**
 * Fila de escritas feitas sem conexão (js/fila.js) — spec 06, fase 4.
 * ApiClient, navigator e o armazenamento (modo memória) são simulados.
 */
const assert = require("assert");
const path = require("path");

const Armazenamento = require(path.join(__dirname, "..", "js", "armazenamento.js"));
global.Armazenamento = Armazenamento;
global.navigator = { onLine: true };

const chamadas = [];
let responder = () => ({ sucesso: true });
let token = "sessao-valida";
global.ApiClient = {
  obterTokenSessao: () => token,
  request: async (rota, payload) => {
    chamadas.push({ rota, payload });
    return responder(rota, payload);
  }
};
const erroSemRede = () => Object.assign(new Error("Sem conexão"), { semRede: true });
const erroServidor = (codigo, msg) => Object.assign(new Error(msg), { codigo });

const Fila = require(path.join(__dirname, "..", "js", "fila.js"));
const ANA = "ana@exemplo.test";
const zerar = async () => { await Armazenamento.limparTudo(); chamadas.length = 0; responder = () => ({ sucesso: true }); token = "sessao-valida"; navigator.onLine = true; };

(async () => {
  // --- Com rede: vai direto, nada fica na fila ---
  await zerar();
  responder = () => ({ sucesso: true, trabalhado: true });
  assert.deepStrictEqual(await Fila.enviar("predios/marcar-trabalhado", { idPredio: "P1" }, "predio:P1", ANA), { sucesso: true, trabalhado: true });
  assert.deepStrictEqual(await Fila.contar(ANA), { pendentes: 0, recusados: 0 });

  // --- Recusa do servidor com rede: erro vai para quem chamou (para desfazer), sem enfileirar ---
  responder = () => { throw erroServidor(403, "Território com outro dirigente."); };
  await assert.rejects(Fila.enviar("quadras/salvar", {}, "quadras:1", ANA), /outro dirigente/);
  assert.deepStrictEqual(await Fila.contar(ANA), { pendentes: 0, recusados: 0 });

  // --- Sem rede: guarda sem chamar o servidor ---
  await zerar();
  navigator.onLine = false;
  let avisos = 0;
  Fila.definirOuvinte(() => { avisos++; });
  assert.deepStrictEqual(await Fila.enviar("quadras/salvar", { numeroTerritorio: 3, pinos: [1] }, "quadras:3", ANA), { enfileirado: true });
  assert.strictEqual(chamadas.length, 0, "offline não tenta a rede");
  assert.ok(avisos >= 1, "a tela é avisada da mudança na fila");

  // --- Falha de comunicação com o navegador "online": também guarda ---
  navigator.onLine = true;
  responder = () => { throw erroSemRede(); };
  assert.deepStrictEqual(await Fila.enviar("predios/marcar-apartamentos", { idPredio: "P1", apartamentos: ["101"] }, "aptos:P1", ANA), { enfileirado: true });
  assert.deepStrictEqual(await Fila.contar(ANA), { pendentes: 2, recusados: 0 });

  // --- Fusão por chave: só a marcação mais recente de cada chave fica ---
  navigator.onLine = false;
  await Fila.enviar("quadras/salvar", { numeroTerritorio: 3, pinos: [1, 2] }, "quadras:3", ANA);
  await Fila.enviar("quadras/salvar", { numeroTerritorio: 3, pinos: [1, 2, 3] }, "quadras:3", ANA);
  await Fila.enviar("predios/marcar-trabalhado", { idPredio: "P1", trabalhado: true }, "predio:P1", ANA);
  await Fila.enviar("predios/marcar-trabalhado", { idPredio: "P1", trabalhado: false }, "predio:P1", ANA);
  let itens = await Armazenamento.filaListar();
  assert.deepStrictEqual(itens.map(i => i.chave), ["aptos:P1", "quadras:3", "predio:P1"]);
  assert.deepStrictEqual(itens.find(i => i.chave === "quadras:3").payload.pinos, [1, 2, 3]);
  assert.strictEqual(itens.find(i => i.chave === "predio:P1").payload.trabalhado, false);

  // --- Com item da mesma chave pendente, a nova marcação não fura a fila mesmo com rede ---
  navigator.onLine = true;
  responder = () => ({ sucesso: true });
  chamadas.length = 0;
  assert.deepStrictEqual(await Fila.enviar("quadras/salvar", { numeroTerritorio: 3, pinos: [9] }, "quadras:3", ANA), { enfileirado: true });
  assert.strictEqual(chamadas.length, 0);

  // --- Fila de outra conta não é enviada nem contada ---
  await Armazenamento.filaAdicionar({ rota: "quadras/salvar", payload: {}, chave: "quadras:7", email: "bruno@exemplo.test", tentativas: 0 });
  assert.deepStrictEqual(await Fila.contar(ANA), { pendentes: 3, recusados: 0 });

  // --- Descarga sem rede ou sem sessão: nada é enviado, nada se perde ---
  navigator.onLine = false;
  assert.deepStrictEqual(await Fila.descarregar(ANA), { enviados: 0, recusados: 0, restantes: 3, precisaLogin: false });
  navigator.onLine = true;
  token = null;
  assert.deepStrictEqual(await Fila.descarregar(ANA), { enviados: 0, recusados: 0, restantes: 3, precisaLogin: true });
  assert.strictEqual(chamadas.length, 0);

  // --- Descarga: em ordem; recusa (403) vira "não enviado" com o motivo e não trava os demais ---
  token = "sessao-valida";
  responder = rota => { if (rota === "predios/marcar-trabalhado") throw erroServidor(403, "Território devolvido."); return { sucesso: true }; };
  const r1 = await Fila.descarregar(ANA);
  assert.deepStrictEqual(r1, { enviados: 2, recusados: 1, restantes: 0, precisaLogin: false });
  assert.deepStrictEqual(chamadas.map(c => c.rota), ["predios/marcar-apartamentos", "predios/marcar-trabalhado", "quadras/salvar"], "ordem de chegada");
  assert.deepStrictEqual(chamadas[2].payload.pinos, [9], "vai o estado mais recente");
  assert.deepStrictEqual(await Fila.contar(ANA), { pendentes: 0, recusados: 1 });
  const recusados = await Fila.listarRecusados(ANA);
  assert.strictEqual(recusados[0].recusado.motivo, "Território devolvido.");
  // Recusado não é reenviado
  chamadas.length = 0;
  await Fila.descarregar(ANA);
  assert.strictEqual(chamadas.length, 0);
  await Fila.descartarRecusados(ANA);
  assert.deepStrictEqual(await Fila.contar(ANA), { pendentes: 0, recusados: 0 });
  assert.strictEqual((await Armazenamento.filaListar()).length, 1, "item da outra conta continua intocado");

  // --- Rede cai no meio: para, mantém a ordem e retoma depois ---
  await zerar();
  navigator.onLine = false;
  await Fila.enviar("quadras/salvar", { n: 1 }, "quadras:1", ANA);
  await Fila.enviar("quadras/salvar", { n: 2 }, "quadras:2", ANA);
  await Fila.enviar("quadras/salvar", { n: 3 }, "quadras:3", ANA);
  navigator.onLine = true;
  let n = 0;
  responder = () => { n++; if (n === 2) throw erroSemRede(); return { sucesso: true }; };
  assert.deepStrictEqual(await Fila.descarregar(ANA), { enviados: 1, recusados: 0, restantes: 2, precisaLogin: false });
  itens = await Armazenamento.filaListar();
  assert.deepStrictEqual(itens.map(i => i.payload.n), [2, 3]);
  assert.strictEqual(itens[0].tentativas, 1);
  responder = () => ({ sucesso: true });
  assert.deepStrictEqual(await Fila.descarregar(ANA), { enviados: 2, recusados: 0, restantes: 0, precisaLogin: false });

  // --- Sessão vence no meio (401): mantém na fila e pede login ---
  await zerar();
  navigator.onLine = false;
  await Fila.enviar("quadras/salvar", { n: 1 }, "quadras:1", ANA);
  navigator.onLine = true;
  responder = () => { throw erroServidor(401, "Sessão expirada."); };
  assert.deepStrictEqual(await Fila.descarregar(ANA), { enviados: 0, recusados: 0, restantes: 1, precisaLogin: true });
  assert.deepStrictEqual(await Fila.contar(ANA), { pendentes: 1, recusados: 0 });

  // --- Falha de comunicação repetida: depois do limite, vira "não enviado" em vez de travar para sempre ---
  responder = () => { throw erroSemRede(); };
  for (let i = 0; i < Fila.MAX_TENTATIVAS; i++) await Fila.descarregar(ANA);
  assert.deepStrictEqual(await Fila.contar(ANA), { pendentes: 0, recusados: 1 });

  // --- Descargas simultâneas compartilham a mesma execução (não enviam em dobro) ---
  await zerar();
  navigator.onLine = false;
  await Fila.enviar("quadras/salvar", { n: 1 }, "quadras:1", ANA);
  navigator.onLine = true;
  responder = () => new Promise(r => setTimeout(() => r({ sucesso: true }), 20));
  const [a, b] = await Promise.all([Fila.descarregar(ANA), Fila.descarregar(ANA)]);
  assert.strictEqual(chamadas.length, 1);
  assert.strictEqual(a, b);

  console.log("FILA OFFLINE: TODOS OS TESTES PASSARAM.");
})().catch(erro => { console.error(erro); process.exit(1); });
