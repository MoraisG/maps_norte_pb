/**
 * ADMIN: designar território a um dirigente (fora da fila, com data de início) e transferir
 * território em campo entre dirigentes (mantendo a data de início).
 * Planilha, CacheService, relógio e LockService simulados em memória.
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
    ContentService: { createTextOutput: t => ({ texto: t, setMimeType() { return this; } }), MimeType: { JSON: "json" } },
    Logger: { log() {} },
    console: { log() {}, error() {}, warn() {} },
    Date: DataSimulada
  };
  vm.createContext(ctx);
  vm.runInContext(src + `\nthis.__t={listarTodosTerritoriosConsolidados,designarTerritorioAdminTransacional,
    transferirTerritorioAdminTransacional,devolverTerritorioTransacional,listarHistoricoMovimentacoes,rotearRequisicao};
    this.__sessaoDe = function (email) { validarSessao = function () { return { email: email, nome: "x" }; }; };`, ctx);

  const d = dias => new Date(agora - dias * DIA);
  abas.BASE = criarAba([
    ["NUM_TER", "DESC_TERRITORIO", "SITUACAO", "wkt_geom"],
    ["01", "Centro", "Urbana", ""],
    ["02", "Bortot", "Urbana", ""],
    ["03", "Passo da Pedra", "Rural", ""],
    ["04", "Fraron", "Urbana", ""],
    ["05", "Industrial", "Urbana", ""]
  ]);
  abas.DASHBOARD = criarAba([["Num", "a", "b", "c", "Pdf", "d", "Bairro"]]);
  abas.Respostas = criarAba([
    ["Carimbo", "Nome", "Territorio", "Acao", "Data", "Email", "Tipo", "Obs", "Tag"],
    [d(300), "Ana Souza", "1", "Solicitar", d(300), "ana@exemplo.test", "Cidade"],
    [d(250), "Ana Souza", "1", "Devolver", d(250), "ana@exemplo.test", "Cidade", "", "COMPLETO"],
    [d(20), "Bruno Lima", "1", "Solicitar", d(20), "bruno@exemplo.test", "Cidade"],   // T1 em campo com Bruno há 20 dias
    [d(90), "Ana Souza", "2", "Solicitar", d(90), "ana@exemplo.test", "Cidade"],
    [d(30), "Ana Souza", "2", "Devolver", d(30), "ana@exemplo.test", "Cidade", "", "COMPLETO"], // T2 em descanso
    [d(10), "Carla Dias", "3", "Solicitar", d(10), "", "Rural"],                       // T3 em campo, linha antiga sem e-mail
    [d(400), "Bruno Lima", "4", "Solicitar", d(400), "bruno@exemplo.test", "Cidade"],
    [d(200), "Bruno Lima", "4", "Devolver", d(200), "bruno@exemplo.test", "Cidade", "", "COMPLETO"] // T4 disponível
  ]);
  abas.Predios = criarAba([["IdPredio", "NumeroTerritorio", "NomeEdificio", "Endereco", "Andares", "Apartamentos", "TipoInterfone", "TagsLogisticas", "ReferenciaComercial", "Latitude", "Longitude", "UltimaDataConclusao", "AptosTrabalhados"]]);
  abas.QuadrasTrabalhadas = criarAba([["NumeroTerritorio", "Pinos"], ["1", "[[-26.222,-52.672]]"]]);
  abas.Usuarios = criarAba([
    ["Id", "Nome", "Email", "Perfil", "Status", "CriadoEm", "CriadoPor", "UltimoAcesso", "UltimaAtividade"],
    ["USR-1", "Admin Raiz", "root@exemplo.test", "ADMIN", "ATIVO"],
    ["USR-2", "Ana Souza", "ana@exemplo.test", "PUBLICADOR", "ATIVO"],
    ["USR-3", "Bruno Lima", "bruno@exemplo.test", "PUBLICADOR", "ATIVO"],
    ["USR-4", "Carla Dias", "carla@exemplo.test", "PUBLICADOR", "ATIVO"],
    ["USR-5", "Davi Rocha", "davi@exemplo.test", "PUBLICADOR", "INATIVO"]
  ]);

  return { t: ctx.__t, ctx, abas, d, hojeIso: iso(new Date(agora)) };
}

const ADMIN = { nome: "Admin Raiz", email: "root@exemplo.test", perfil: "ADMIN" };
const corpo = r => JSON.parse(r.texto);
const terr = (a, n, usuario = ADMIN) => JSON.parse(JSON.stringify(a.t.listarTodosTerritoriosConsolidados(usuario, { fresco: true }))).find(t => t.numero === n);
const auditoria = a => (a.abas.Auditoria ? a.abas.Auditoria.dados : []).map(l => `${l[4]}|${l[5]}|${l[6]}`);

// --- 1. Designar um cartão disponível, fora da fila, com data de início no passado ---
{
  const a = criarAmbiente();
  const inicio = iso(a.d(5));
  const r = corpo(a.t.designarTerritorioAdminTransacional(ADMIN, { numeroTerritorio: 4, emailDirigente: "ANA@exemplo.test ", dataInicio: inicio }));
  assert.strictEqual(r.sucesso, true, r.erro);
  const t4 = terr(a, 4);
  assert.strictEqual(t4.statusReal, "OCUPADO");
  assert.strictEqual(t4.dirigente, "Ana Souza", "nome vem da whitelist");
  assert.strictEqual(t4.emailDirigente, "ana@exemplo.test");
  assert.strictEqual(t4.ultimaData, inicio, "data de início é a informada pelo ADMIN");
  assert.strictEqual(t4.ciclos[t4.ciclos.length - 1].dataDesignacao, inicio);
  assert.strictEqual(terr(a, 4, { nome: "Ana Souza", email: "ana@exemplo.test", perfil: "PUBLICADOR" }).emMinhaPosse, true, "dirigente designado passa a ter a posse");
  const linha = a.abas.Respostas.dados[a.abas.Respostas.dados.length - 1];
  assert.strictEqual(linha[3], "Solicitar");
  assert.strictEqual(linha[8], "DESIGNADO_ADMIN", "linha marcada como designação do ADMIN");
  assert.ok(auditoria(a).includes("ADMIN_DESIGNAR_TERRITORIO|4|SUCESSO"));
  assert.ok(String(a.abas.Usuarios.dados[2][8]).includes("Recebeu T-4"), "última atividade do dirigente registrada");
}

// --- 2. Designar cartão em descanso (ignora a quarentena) e cartão nunca usado ---
{
  const a = criarAmbiente();
  const r = corpo(a.t.designarTerritorioAdminTransacional(ADMIN, { numeroTerritorio: 2, emailDirigente: "carla@exemplo.test", dataInicio: a.hojeIso }));
  assert.strictEqual(r.sucesso, true, r.erro);
  assert.strictEqual(terr(a, 2).statusReal, "OCUPADO");
  assert.ok(a.abas.Auditoria.dados.some(l => String(l[7]).includes("cartão estava em descanso")));

  const r5 = corpo(a.t.designarTerritorioAdminTransacional(ADMIN, { numeroTerritorio: "05", emailDirigente: "bruno@exemplo.test", dataInicio: iso(a.d(800)) }));
  assert.strictEqual(r5.sucesso, true, "cartão nunca usado aceita qualquer data passada");
  assert.strictEqual(terr(a, 5).ultimaData, iso(a.d(800)));
}

// --- 3. Validações da designação ---
{
  const a = criarAmbiente();
  const tentar = p => corpo(a.t.designarTerritorioAdminTransacional(ADMIN, Object.assign({ numeroTerritorio: 4, emailDirigente: "ana@exemplo.test", dataInicio: a.hojeIso }, p)));
  const qtdAntes = a.abas.Respostas.dados.length;

  let r = tentar({ numeroTerritorio: 1 });
  assert.strictEqual(r.codigo, 409, "cartão em campo não pode ser designado");
  assert.ok(/Transferir/.test(r.erro));
  assert.strictEqual(tentar({ dataInicio: iso(new Date(a.d(0).getTime() + DIA)) }).codigo, 400, "data no futuro");
  assert.strictEqual(tentar({ dataInicio: "2026-02-30" }).codigo, 400, "data inexistente");
  assert.strictEqual(tentar({ dataInicio: "14/11/2026" }).codigo, 400, "formato inválido");
  r = tentar({ dataInicio: iso(a.d(201)) });
  assert.strictEqual(r.codigo, 400, "início antes da última devolução");
  assert.ok(/última devolução/.test(r.erro));
  assert.strictEqual(tentar({ dataInicio: iso(a.d(200)) }).sucesso, true, "início no mesmo dia da devolução é aceito");

  const b = criarAmbiente();
  const tentarB = p => corpo(b.t.designarTerritorioAdminTransacional(ADMIN, Object.assign({ numeroTerritorio: 4, emailDirigente: "ana@exemplo.test", dataInicio: b.hojeIso }, p)));
  assert.strictEqual(tentarB({ emailDirigente: "davi@exemplo.test" }).codigo, 400, "dirigente INATIVO");
  assert.strictEqual(tentarB({ emailDirigente: "ninguem@exemplo.test" }).codigo, 400, "dirigente fora da whitelist");
  assert.strictEqual(tentarB({ emailDirigente: "" }).codigo, 400);
  assert.strictEqual(tentarB({ numeroTerritorio: 99 }).codigo, 404);
  assert.strictEqual(tentarB({ numeroTerritorio: "abc" }).codigo, 400);
  assert.strictEqual(b.abas.Respostas.dados.length, qtdAntes, "nenhuma tentativa inválida grava na aba Respostas");
}

// --- 4. Transferir mantém a data de início e o histórico de quem estava com o cartão ---
{
  const a = criarAmbiente();
  const antes = terr(a, 1);
  const r = corpo(a.t.transferirTerritorioAdminTransacional(ADMIN, { numeroTerritorio: 1, emailDirigente: "carla@exemplo.test" }));
  assert.strictEqual(r.sucesso, true, r.erro);
  const depois = terr(a, 1);
  assert.strictEqual(depois.statusReal, "OCUPADO");
  assert.strictEqual(depois.dirigente, "Carla Dias");
  assert.strictEqual(depois.emailDirigente, "carla@exemplo.test");
  assert.strictEqual(depois.ultimaData, antes.ultimaData, "data de início mantida");
  assert.strictEqual(depois.ultimaData, iso(a.d(20)));
  assert.strictEqual(depois.ciclos.length, antes.ciclos.length, "não abre ciclo novo");
  assert.strictEqual(antes.quadrasTrabalhadas.length, 1);
  assert.deepStrictEqual(depois.quadrasTrabalhadas, antes.quadrasTrabalhadas, "progresso em campo segue com o cartão");
  assert.strictEqual(depois.ciclos[depois.ciclos.length - 1].dirigente, "Carla Dias");
  assert.strictEqual(depois.ciclos[depois.ciclos.length - 1].dataDesignacao, iso(a.d(20)));

  const linhaBruno = a.abas.Respostas.dados[3];
  assert.strictEqual(linhaBruno[3], "Transferido", "solicitação anterior marcada como transferida");
  assert.strictEqual(linhaBruno[8], "TRANSFERIDO");
  const histBruno = JSON.parse(JSON.stringify(a.t.listarHistoricoMovimentacoes({ nome: "Bruno Lima", email: "bruno@exemplo.test" }, false)));
  assert.ok(histBruno.some(h => h.numeroTerritorio === 1 && h.acao === "Transferido"), "Bruno vê no histórico que o cartão foi transferido");
  assert.strictEqual(terr(a, 1, { nome: "Bruno Lima", email: "bruno@exemplo.test", perfil: "PUBLICADOR" }).emMinhaPosse, false);
  assert.strictEqual(terr(a, 1, { nome: "Carla Dias", email: "carla@exemplo.test", perfil: "PUBLICADOR" }).emMinhaPosse, true);
  assert.ok(auditoria(a).includes("ADMIN_TRANSFERIR_TERRITORIO|1|SUCESSO"));

  // Transferir de novo continua com a mesma data, e a devolução fecha o ciclo normalmente
  assert.strictEqual(corpo(a.t.transferirTerritorioAdminTransacional(ADMIN, { numeroTerritorio: 1, emailDirigente: "ana@exemplo.test" })).sucesso, true);
  assert.strictEqual(terr(a, 1).ultimaData, iso(a.d(20)));
  const dev = corpo(a.t.devolverTerritorioTransacional({ nome: "Ana Souza", email: "ana@exemplo.test", perfil: "PUBLICADOR" }, { numeroTerritorio: 1, foiCompleto: true }));
  assert.strictEqual(dev.sucesso, true, dev.erro);
  const fechado = terr(a, 1);
  assert.strictEqual(fechado.statusReal, "RECENTE");
  const ultimoCiclo = fechado.ciclos[fechado.ciclos.length - 1];
  assert.deepStrictEqual([ultimoCiclo.dirigente, ultimoCiclo.dataDesignacao, ultimoCiclo.dataConclusao], ["Ana Souza", iso(a.d(20)), a.hojeIso]);
}

// --- 5. "Não iniciado" depois de uma transferência devolve o cartão ao estado anterior ---
{
  const a = criarAmbiente();
  corpo(a.t.transferirTerritorioAdminTransacional(ADMIN, { numeroTerritorio: 1, emailDirigente: "carla@exemplo.test" }));
  const r = corpo(a.t.devolverTerritorioTransacional({ nome: "Carla Dias", email: "carla@exemplo.test", perfil: "PUBLICADOR" }, { numeroTerritorio: 1, foiCompleto: false, motivoNaoCompleto: "NAO_INICIADO" }));
  assert.strictEqual(r.sucesso, true, r.erro);
  const t1 = terr(a, 1);
  assert.strictEqual(t1.statusReal, "DISPONÍVEL");
  assert.strictEqual(t1.ultimaData, iso(a.d(250)), "volta à antiguidade da última devolução real");
}

// --- 6. Transferir linha antiga sem e-mail e validações ---
{
  const a = criarAmbiente();
  assert.strictEqual(corpo(a.t.transferirTerritorioAdminTransacional(ADMIN, { numeroTerritorio: 3, emailDirigente: "carla@exemplo.test" })).codigo, 400,
    "linha antiga sem e-mail: reconhece pelo nome que já está com a Carla");
  const r = corpo(a.t.transferirTerritorioAdminTransacional(ADMIN, { numeroTerritorio: 3, emailDirigente: "bruno@exemplo.test" }));
  assert.strictEqual(r.sucesso, true, r.erro);
  assert.strictEqual(terr(a, 3).ultimaData, iso(a.d(10)));
  assert.strictEqual(terr(a, 3).tipo, "Rural");

  const tentar = p => corpo(a.t.transferirTerritorioAdminTransacional(ADMIN, Object.assign({ numeroTerritorio: 1, emailDirigente: "ana@exemplo.test" }, p)));
  assert.strictEqual(tentar({ numeroTerritorio: 4 }).codigo, 409, "cartão fora de campo não é transferido");
  assert.strictEqual(tentar({ emailDirigente: "bruno@exemplo.test" }).codigo, 400, "mesmo dirigente");
  assert.strictEqual(tentar({ emailDirigente: "davi@exemplo.test" }).codigo, 400, "dirigente INATIVO");
  assert.strictEqual(tentar({ numeroTerritorio: 99 }).codigo, 404);
}

// --- 7. Rotas: exclusivas de ADMIN e só por POST ---
{
  const a = criarAmbiente();
  for (const rota of ["admin/territorios/designar", "admin/territorios/transferir"]) {
    a.ctx.__sessaoDe("ana@exemplo.test");
    const negado = corpo(a.t.rotearRequisicao("POST", {}, { rota, sessionToken: "x", numeroTerritorio: 4, emailDirigente: "ana@exemplo.test", dataInicio: a.hojeIso }));
    assert.strictEqual(negado.codigo, 403, `${rota}: PUBLICADOR recebe 403`);

    a.ctx.__sessaoDe("root@exemplo.test");
    assert.strictEqual(corpo(a.t.rotearRequisicao("GET", { rota, sessionToken: "x" }, {})).sucesso, false, `${rota}: GET não é aceito`);
  }
  a.ctx.__sessaoDe("root@exemplo.test");
  const ok = corpo(a.t.rotearRequisicao("POST", {}, { rota: "admin/territorios/designar", sessionToken: "x", numeroTerritorio: 4, emailDirigente: "ana@exemplo.test", dataInicio: a.hojeIso }));
  assert.strictEqual(ok.sucesso, true, ok.erro);
  const tr = corpo(a.t.rotearRequisicao("POST", {}, { rota: "admin/territorios/transferir", sessionToken: "x", numeroTerritorio: 4, emailDirigente: "bruno@exemplo.test" }));
  assert.strictEqual(tr.sucesso, true, tr.erro);
  assert.strictEqual(terr(a, 4).dirigente, "Bruno Lima");
  assert.strictEqual(terr(a, 4).ultimaData, a.hojeIso);
}

console.log("designar-transferir: ok");
