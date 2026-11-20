/**
 * Spec 03 — inativar / reativar território.
 * Decisões de 2026-11-20: publicador não vê inativos; ADMIN/SUPERVISOR veem (cinza no app);
 * cartão em campo pede confirmação e, confirmado, é devolvido antes; S-13 traz inativos só se
 * tiveram trabalho no ano (seção separada). Histórico na aba TerritoriosHistorico, nunca apagado.
 */
const fs = require("fs"), vm = require("vm"), path = require("path"), assert = require("assert");
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, "..", "backend", "Code.gs"), "utf8");

const DIA = 86400000;
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function criarAmbiente() {
  const agora = new Date(2026, 10, 14, 10, 0, 0).getTime();
  const cacheDados = {};
  const criarAba = linhas => {
    const dados = linhas.map(l => l.slice());
    return {
      dados,
      getDataRange: () => ({ getValues: () => dados.map(l => l.slice()) }),
      getLastColumn: () => Math.max(...dados.map(l => l.length)),
      getLastRow: () => dados.length,
      appendRow: l => { dados.push(l.slice()); },
      getRange: (lin, col) => ({
        getValue: () => (dados[lin - 1] || [])[col - 1],
        setValue: v => { while (dados[lin - 1].length < col) dados[lin - 1].push(""); dados[lin - 1][col - 1] = v; }
      })
    };
  };
  const abas = {};
  const ss = { getSheetByName: n => abas[n] || null, insertSheet: n => (abas[n] = criarAba([])) };
  const cache = {
    get: k => { const e = cacheDados[k]; return e && e.exp > agora ? e.v : null; },
    put: (k, v, ttl) => { cacheDados[k] = { v: String(v), exp: agora + (ttl || 600) * 1000 }; },
    remove: k => { delete cacheDados[k]; },
    getAll: chaves => { const r = {}; for (const k of chaves) { const v = cache.get(k); if (v !== null) r[k] = v; } return r; },
    putAll: (valores, ttl) => { for (const k in valores) cache.put(k, valores[k], ttl); }
  };
  class DataSimulada extends Date {
    constructor(...args) { if (args.length) super(...args); else super(agora); }
    static now() { return agora; }
  }
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    CacheService: { getScriptCache: () => cache },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: { formatDate: d => iso(d), getUuid: () => "uuid-0000-0000" },
    Session: { getScriptTimeZone: () => "America/Sao_Paulo", getEffectiveUser: () => ({ getEmail: () => "root@exemplo.test" }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    ContentService: { createTextOutput: t => ({ texto: t, getContent() { return t; }, setMimeType() { return this; } }), MimeType: { JSON: "json" } },
    Logger: { log() {} },
    console: { log() {}, error() {}, warn() {} },
    Date: DataSimulada
  };
  vm.createContext(ctx);
  vm.runInContext(src + `\nthis.__t={listarTodosTerritoriosConsolidados,calcularNumerosElegiveisFila,rotearRequisicao,gerarDadosRelatorioAnoServico};
    this.__sessaoDe = function (email) { validarSessao = function () { return { email: email, nome: "x" }; }; };`, ctx);

  const d = dias => new Date(agora - dias * DIA);
  abas.BASE = criarAba([
    ["NUM_TER", "DESC_TERRITORIO", "SITUACAO", "wkt_geom"],
    ["01", "Centro", "Urbana", ""], ["02", "Bortot", "Urbana", ""], ["03", "Fraron", "Urbana", ""]
  ]);
  abas.DASHBOARD = criarAba([["Num", "a", "b", "c", "Pdf", "d", "Bairro"]]);
  abas.Respostas = criarAba([
    ["Carimbo", "Nome", "Territorio", "Acao", "Data", "Email", "Tipo", "Obs", "Tag"],
    [d(400), "Ana Souza", "1", "Solicitar", d(400), "ana@exemplo.test", "Cidade"],
    [d(300), "Ana Souza", "1", "Devolver", d(300), "ana@exemplo.test", "Cidade", "", "COMPLETO"],   // T1 disponível
    [d(30), "Bruno Lima", "2", "Solicitar", d(30), "bruno@exemplo.test", "Cidade"],                 // T2 em campo
    [d(500), "Ana Souza", "3", "Solicitar", d(500), "ana@exemplo.test", "Cidade"],
    [d(450), "Ana Souza", "3", "Devolver", d(450), "ana@exemplo.test", "Cidade", "", "COMPLETO"]    // T3 disponível
  ]);
  abas.Predios = criarAba([["IdPredio", "NumeroTerritorio", "NomeEdificio", "Endereco", "Andares", "Apartamentos", "TipoInterfone", "TagsLogisticas", "ReferenciaComercial", "Latitude", "Longitude", "UltimaDataConclusao", "AptosTrabalhados"]]);
  abas.Usuarios = criarAba([
    ["Id", "Nome", "Email", "Perfil", "Status"],
    ["USR-1", "Admin Raiz", "root@exemplo.test", "ADMIN", "ATIVO"],
    ["USR-2", "Ana Souza", "ana@exemplo.test", "PUBLICADOR", "ATIVO"],
    ["USR-3", "Bruno Lima", "bruno@exemplo.test", "PUBLICADOR", "ATIVO"],
    ["USR-4", "Sara Supervisora", "sara@exemplo.test", "SUPERVISOR", "ATIVO"]
  ]);
  const chamar = (email, rota, extra) => {
    ctx.__sessaoDe(email);
    return JSON.parse(ctx.__t.rotearRequisicao("POST", {}, Object.assign({ rota: rota, sessionToken: "s" }, extra || {})).texto);
  };
  return { t: ctx.__t, abas, chamar };
}

const U = {
  admin: { nome: "Admin Raiz", email: "root@exemplo.test", perfil: "ADMIN" },
  sup: { nome: "Sara Supervisora", email: "sara@exemplo.test", perfil: "SUPERVISOR" },
  pub: { nome: "Ana Souza", email: "ana@exemplo.test", perfil: "PUBLICADOR" }
};
const lista = (a, u) => JSON.parse(JSON.stringify(a.t.listarTodosTerritoriosConsolidados(u, { fresco: true })));
const terr = (a, u, n) => lista(a, u).find(t => t.numero === n);

// --- 1. Validações e permissão ---
{
  const a = criarAmbiente();
  assert.strictEqual(a.chamar("sara@exemplo.test", "admin/territorios/inativar", { numeroTerritorio: 1, motivo: "FUSAO" }).codigo, 403, "só ADMIN inativa");
  assert.strictEqual(a.chamar("ana@exemplo.test", "admin/territorios/inativar", { numeroTerritorio: 1, motivo: "FUSAO" }).codigo, 403);
  assert.strictEqual(a.chamar("root@exemplo.test", "admin/territorios/inativar", { numeroTerritorio: 1, motivo: "QUALQUER" }).codigo, 400, "motivo fora da lista");
  assert.strictEqual(a.chamar("root@exemplo.test", "admin/territorios/inativar", { numeroTerritorio: 1, motivo: "OUTRO", observacao: "" }).codigo, 400, "OUTRO exige observação");
  assert.strictEqual(a.chamar("root@exemplo.test", "admin/territorios/inativar", { numeroTerritorio: 99, motivo: "FUSAO" }).codigo, 404);
}

// --- 2. Inativar disponível: some para o publicador, cinza para gestão, fora da fila ---
{
  const a = criarAmbiente();
  assert.ok(a.t.calcularNumerosElegiveisFila(lista(a, U.admin)).has("1"), "antes: T1 na fila");
  const r = a.chamar("root@exemplo.test", "admin/territorios/inativar", { numeroTerritorio: 1, motivo: "FUSAO", observacao: "Unido ao 3" });
  assert.strictEqual(r.sucesso, true, r.erro);

  assert.strictEqual(terr(a, U.pub, 1), undefined, "publicador não recebe inativo");
  const paraAdmin = terr(a, U.admin, 1), paraSup = terr(a, U.sup, 1);
  assert.strictEqual(paraAdmin.statusReal, "INATIVO");
  assert.strictEqual(paraSup.statusReal, "INATIVO", "supervisor vê inativo");
  assert.strictEqual(paraAdmin.inativacao.motivo, "FUSAO");
  assert.strictEqual(paraAdmin.inativacao.observacao, "Unido ao 3");
  assert.ok(paraAdmin.inativacao.em);
  assert.ok(!a.t.calcularNumerosElegiveisFila(lista(a, U.admin)).has("1"), "inativo sai da fila");
  const ordem = lista(a, U.admin).map(t => t.numero);
  assert.strictEqual(ordem[ordem.length - 1], 1, "inativos no fim da lista");

  const hist = a.abas.TerritoriosHistorico.dados;
  assert.deepStrictEqual(Array.from(hist[0]), ["IdEvento", "DataHora", "Numero", "Acao", "Email", "Nome", "Motivo", "Observacao"]);
  assert.strictEqual(hist[1][3], "INATIVAR");
  assert.strictEqual(a.abas.Respostas.dados.length, 6, "nada gravado em Respostas");
  assert.ok(a.abas.Auditoria.dados.some(l => l[4] === "TERRITORIO_INATIVAR" && l[6] === "SUCESSO"));

  // Bloqueios sobre inativo
  assert.strictEqual(a.chamar("root@exemplo.test", "admin/territorios/inativar", { numeroTerritorio: 1, motivo: "FUSAO" }).codigo, 409, "já inativo");
  assert.strictEqual(a.chamar("ana@exemplo.test", "territorios/solicitar", { numerosTerritorios: [1] }).sucesso, false, "não dá para solicitar");
  assert.strictEqual(a.chamar("root@exemplo.test", "admin/territorios/designar", { numeroTerritorio: 1, emailDirigente: "ana@exemplo.test", dataInicio: "2026-11-14" }).codigo, 409, "não dá para designar");

  // Reativar: volta a ser DISPONÍVEL pela última devolução, com histórico preservado
  const rr = a.chamar("root@exemplo.test", "admin/territorios/reativar", { numeroTerritorio: 1 });
  assert.strictEqual(rr.sucesso, true, rr.erro);
  assert.strictEqual(terr(a, U.pub, 1).statusReal, "DISPONÍVEL");
  assert.strictEqual(a.abas.TerritoriosHistorico.dados.length, 3, "evento REATIVAR acrescentado, nada apagado");
  assert.strictEqual(a.chamar("root@exemplo.test", "admin/territorios/reativar", { numeroTerritorio: 1 }).codigo, 409, "não está inativo");
}

// --- 3. Inativar cartão em campo: confirmação, devolução e inativação ---
{
  const a = criarAmbiente();
  let r = a.chamar("root@exemplo.test", "admin/territorios/inativar", { numeroTerritorio: 2, motivo: "AREA_INEXISTENTE" });
  assert.strictEqual(r.codigo, 409);
  assert.strictEqual(r.confirmacaoNecessaria, true);
  assert.strictEqual(r.dirigente, "Bruno Lima");
  assert.strictEqual(terr(a, U.admin, 2).statusReal, "OCUPADO", "nada muda sem confirmação");

  r = a.chamar("root@exemplo.test", "admin/territorios/inativar", { numeroTerritorio: 2, motivo: "AREA_INEXISTENTE", devolverSeOcupado: true });
  assert.strictEqual(r.sucesso, true, r.erro);
  const t2 = terr(a, U.admin, 2);
  assert.strictEqual(t2.statusReal, "INATIVO");
  assert.strictEqual(t2.ciclos[t2.ciclos.length - 1].dataConclusao, "2026-11-14", "ciclo do Bruno foi fechado");
  const ultimaResp = a.abas.Respostas.dados[a.abas.Respostas.dados.length - 1];
  assert.strictEqual(ultimaResp[3], "Devolver");
}

// --- 4. S-13: inativo só com trabalho no ano, marcado como inativo ---
{
  const a = criarAmbiente();
  a.chamar("root@exemplo.test", "admin/territorios/inativar", { numeroTerritorio: 2, motivo: "DIVISAO", devolverSeOcupado: true }); // trabalhado no ano
  a.chamar("root@exemplo.test", "admin/territorios/inativar", { numeroTerritorio: 3, motivo: "DIVISAO" });                           // sem trabalho no ano
  const rel = JSON.parse(JSON.stringify(a.t.gerarDadosRelatorioAnoServico(U.admin, 2026)));
  const nums = rel.territorios.map(t => t.numero);
  assert.ok(nums.includes(2) && rel.territorios.find(t => t.numero === 2).inativo === true, "T2 inativo com trabalho entra, marcado");
  assert.ok(!nums.includes(3), "T3 inativo sem trabalho no ano fica de fora");
  assert.ok(nums.includes(1) && rel.territorios.find(t => t.numero === 1).inativo === false);
}

console.log("inativar-territorios: ok");
