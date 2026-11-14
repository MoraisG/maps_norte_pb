/**
 * Listagem consolidada com cache (spec 06, fase 2).
 * Planilha, CacheService (com validade), relógio e LockService simulados em memória.
 * Confere: resultado idêntico com e sem cache, leituras de planilha evitadas, resposta
 * "não modificado", invalidação por escrita/edição/virada do dia, corrida leitura x escrita,
 * geometria separada e, principalmente, que a visibilidade por usuário não vaza pelo cache.
 */
const fs = require("fs"), vm = require("vm"), path = require("path"), assert = require("assert");
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, "..", "backend", "Code.gs"), "utf8");

const DIA = 86400000;
const json = v => JSON.parse(JSON.stringify(v));

function criarAmbiente(opcoes = {}) {
  let agora = new Date(2026, 10, 14, 10, 0, 0).getTime();
  const leituras = {};                       // nome da aba -> nº de getDataRange().getValues()
  const propriedades = Object.assign({}, opcoes.propriedades);
  const cacheDados = {};
  let escritasCache = 0;

  const criarAba = (nome, linhas) => {
    const dados = linhas.map(l => l.slice());
    return {
      dados,
      getDataRange: () => ({ getValues: () => { leituras[nome] = (leituras[nome] || 0) + 1; return dados.map(l => l.slice()); } }),
      getLastColumn: () => Math.max(...dados.map(l => l.length)),
      getLastRow: () => dados.length,
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
  };

  const abas = {};
  const ss = { getSheetByName: n => abas[n] || null, insertSheet: n => (abas[n] = criarAba(n, [])) };

  const cache = {
    get: k => { const e = cacheDados[k]; return e && e.exp > agora ? e.v : null; },
    put: (k, v, ttl) => {
      if (String(v).length > 100000) throw new Error("Argument too large: value");
      escritasCache++;
      cacheDados[k] = { v: String(v), exp: agora + (ttl || 600) * 1000 };
    },
    remove: k => { delete cacheDados[k]; },
    getAll: chaves => { const r = {}; for (const k of chaves) { const v = cache.get(k); if (v !== null) r[k] = v; } return r; },
    putAll: (valores, ttl) => { for (const k in valores) cache.put(k, valores[k], ttl); }
  };
  if (opcoes.cacheSimples) { delete cache.getAll; delete cache.putAll; }
  if (opcoes.cacheQuebrado) {
    for (const metodo of Object.keys(cache)) cache[metodo] = () => { throw new Error("Service unavailable: Cache"); };
  }

  class DataSimulada extends Date {
    constructor(...args) { if (args.length) super(...args); else super(agora); }
    static now() { return agora; }
  }

  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in propriedades ? propriedades[k] : null) }) },
    CacheService: { getScriptCache: () => cache },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: {
      formatDate: d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
      getUuid: () => "uuid",
      base64EncodeWebSafe: s => Buffer.from(s).toString("base64")
    },
    Session: { getScriptTimeZone: () => "America/Sao_Paulo", getEffectiveUser: () => ({ getEmail: () => "root@exemplo.test" }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    ContentService: { createTextOutput: t => ({ texto: t, setMimeType() { return this; } }), MimeType: { JSON: "json" } },
    Logger: { log() {} },
    console: { log() {}, error() {}, warn() {} },
    Date: DataSimulada
  };
  vm.createContext(ctx);
  vm.runInContext(src + `\nthis.__t={listarTodosTerritoriosConsolidados,responderListagemTerritorios,executarComLock,
    invalidarCacheListagem,obterBaseTerritorios,obterProgressoCampo,lerGeracaoListagem,gravarConsolidacaoEmCache,
    lerConsolidacaoEmCache,consolidarBaseTerritorios,resumirConteudo,onEdit,alternarPredioTrabalhadoTransacional,
    salvarQuadrasTrabalhadasTransacional,CACHE_LISTAGEM};`, ctx);

  return {
    t: ctx.__t, abas, criarAba, leituras, propriedades, cacheDados,
    avancar: ms => { agora += ms; },
    agora: () => agora,
    totalLeituras: () => Object.values(leituras).reduce((a, b) => a + b, 0),
    zerarLeituras: () => { for (const k in leituras) delete leituras[k]; },
    escritasCache: () => escritasCache
  };
}

const WKT = n => `MultiPolygonZ (((-52.67${n} -26.225 0, -52.66${n} -26.225 0, -52.66${n} -26.220 0, -52.67${n} -26.220 0, -52.67${n} -26.225 0)))`;
const CAB_PREDIOS = ["IdPredio", "NumeroTerritorio", "NomeEdificio", "Endereco", "Andares", "Apartamentos", "TipoInterfone", "TagsLogisticas", "ReferenciaComercial", "Latitude", "Longitude", "UltimaDataConclusao", "AptosTrabalhados"];

function popular(a, wktGrande) {
  const d = dias => new Date(a.agora() - dias * DIA);
  a.abas.BASE = a.criarAba("BASE", [
    ["NUM_TER", "DESC_TERRITORIO", "SITUACAO", "wkt_geom"],
    ["01", "Centro", "Urbana", wktGrande || WKT(1)],
    ["02", "Bortot", "Urbana", WKT(2)],
    ["03", "Passo da Pedra", "Rural", WKT(3)],
    ["04", "Fraron", "Urbana", WKT(4)],
    ["05", "Industrial", "Urbana", ""]
  ]);
  a.abas.DASHBOARD = a.criarAba("DASHBOARD", [
    ["Num", "a", "b", "c", "Pdf", "d", "Bairro"],
    ["1", "", "", "", "Mapa_1.pdf", "", "Centro"]
  ]);
  // Carimbo, Nome, Território, Ação, Data de controle, E-mail, Tipo
  a.abas.Respostas = a.criarAba("Respostas", [
    ["Carimbo", "Nome", "Territorio", "Acao", "Data", "Email", "Tipo"],
    [d(300), "Ana Souza", "1", "Solicitar", d(300), "ana@exemplo.test", "Cidade"],
    [d(250), "Ana Souza", "1", "Devolver", d(250), "ana@exemplo.test", "Cidade"],
    [d(20), "Bruno Lima", "1", "Solicitar", d(20), "bruno@exemplo.test", "Cidade"],   // T1 em campo com Bruno
    [d(90), "Ana Souza", "2", "Solicitar", d(90), "ana@exemplo.test", "Cidade"],
    [d(30), "Ana Souza", "2", "Devolver", d(30), "ana@exemplo.test", "Cidade"],       // T2 recente
    [d(10), "Carla Dias", "3", "Solicitar", d(10), "", "Rural"],                       // T3 em campo, linha antiga sem e-mail
    [d(400), "Bruno Lima", "4", "Solicitar", d(400), "bruno@exemplo.test", "Cidade"],
    [d(200), "Bruno Lima", "4", "Devolver", d(200), "bruno@exemplo.test", "Cidade"]   // T4 disponível
  ]);
  a.abas.Predios = a.criarAba("Predios", [
    CAB_PREDIOS,
    ["PRD-1", 1, "Ed. Um", "Rua X, 1", 3, 6, "EXTERNO", "COM_ACESSO", "", -26.222, -52.672, "", '["101"]'],
    ["PRD-2", 1, "Ed. Dois", "Rua X, 2", 3, 6, "EXTERNO", "", "", -26.223, -52.673, d(5), ""],
    ["PRD-9", 99, "Ed. Fora", "Rua Y", 1, 1, "EXTERNO", "", "", 0, 0, "", ""]          // território inexistente: descartado
  ]);
  a.abas.QuadrasTrabalhadas = a.criarAba("QuadrasTrabalhadas", [
    ["NumeroTerritorio", "Pinos"],
    ["1", "[[-26.222,-52.672],[-26.223,-52.673]]"],
    ["2", "[[-26.221,-52.671]]"]                                                       // T2 não está em campo: não aparece
  ]);
}

const ADMIN = { nome: "Admin Raiz", email: "root@exemplo.test", perfil: "ADMIN" };
const BRUNO = { nome: "Bruno Lima", email: "bruno@exemplo.test", perfil: "PUBLICADOR" };
const CARLA = { nome: "Carla Dias", email: "carla@exemplo.test", perfil: "PUBLICADOR" };
const ANA = { nome: "Ana Souza", email: "ana@exemplo.test", perfil: "PUBLICADOR" };
const corpo = resposta => JSON.parse(resposta.texto);
const porNumero = (lista, n) => lista.find(t => t.numero === n);

// --- 1. Regras de negócio e de visibilidade preservadas (com cache frio) ---
{
  const a = criarAmbiente(); popular(a);
  const admin = json(a.t.listarTodosTerritoriosConsolidados(ADMIN));
  assert.deepStrictEqual(admin.map(t => t.numero), [5, 4, 2, 1, 3], "ordem: nunca usado, devolvidos há mais tempo, em campo por último");
  assert.strictEqual(porNumero(admin, 1).statusReal, "OCUPADO");
  assert.strictEqual(porNumero(admin, 2).statusReal, "RECENTE");
  assert.strictEqual(porNumero(admin, 4).statusReal, "DISPONÍVEL");
  assert.strictEqual(porNumero(admin, 5).ultimaAcao, "Nunca Usado");
  assert.strictEqual(porNumero(admin, 3).tipo, "Rural");
  assert.strictEqual(porNumero(admin, 1).emailDirigente, "bruno@exemplo.test", "ADMIN vê o e-mail de quem está com o cartão");
  assert.strictEqual(porNumero(admin, 2).dirigente, "Ana Souza", "ADMIN vê quem devolveu por último");
  assert.strictEqual(porNumero(admin, 1).ciclos[0].dirigente, "Ana Souza", "ADMIN vê nomes do histórico");
  assert.strictEqual(porNumero(admin, 1).predios.length, 2);
  assert.deepStrictEqual(porNumero(admin, 1).predios[0].aptosTrabalhados, ["101"]);
  assert.strictEqual(porNumero(admin, 1).quadrasTrabalhadas.length, 2);
  assert.deepStrictEqual(porNumero(admin, 2).quadrasTrabalhadas, [], "quadras só aparecem com o cartão em campo");
  assert.ok(!admin.some(t => t.predios.some(p => p.idPredio === "PRD-9")), "prédio de território inexistente é descartado");

  const bruno = json(a.t.listarTodosTerritoriosConsolidados(BRUNO));
  assert.strictEqual(porNumero(bruno, 1).emMinhaPosse, true);
  assert.strictEqual(porNumero(bruno, 3).emMinhaPosse, false);
  assert.strictEqual(porNumero(bruno, 1).dirigente, "Bruno Lima", "quem está com o cartão em campo é visível");
  assert.strictEqual(porNumero(bruno, 2).dirigente, "", "PUBLICADOR não vê quem devolveu por último");
  assert.ok(bruno.every(t => t.emailDirigente === ""), "PUBLICADOR nunca recebe e-mail de dirigente");
  assert.deepStrictEqual(porNumero(bruno, 1).ciclos.map(c => c.dirigente), ["", "Bruno Lima"], "histórico: só o próprio nome");
  assert.deepStrictEqual(porNumero(bruno, 4).ciclos.map(c => c.dirigente), ["Bruno Lima"]);

  const carla = json(a.t.listarTodosTerritoriosConsolidados(CARLA));
  assert.strictEqual(porNumero(carla, 3).emMinhaPosse, true, "linha antiga sem e-mail: posse reconhecida pelo nome");
  assert.strictEqual(porNumero(carla, 1).emMinhaPosse, false);
}

// --- 2. Com cache quente o resultado é idêntico ao da leitura nova, para cada perfil ---
for (const cacheSimples of [false, true]) {
  const a = criarAmbiente({ cacheSimples }); popular(a);
  for (const usuario of [ADMIN, BRUNO, CARLA, ANA]) {
    const fresco = json(a.t.listarTodosTerritoriosConsolidados(usuario, { fresco: true }));
    const frio = json(a.t.listarTodosTerritoriosConsolidados(usuario));
    const quente = json(a.t.listarTodosTerritoriosConsolidados(usuario));
    assert.deepStrictEqual(frio, fresco, `cache frio = leitura nova (${usuario.nome})`);
    assert.deepStrictEqual(quente, fresco, `cache quente = leitura nova (${usuario.nome})`);
  }
  // Nenhum campo interno escapa, nem do cache nem da leitura nova
  for (const usuario of [ADMIN, BRUNO]) {
    const texto = JSON.stringify(a.t.listarTodosTerritoriosConsolidados(usuario));
    assert.ok(!/"_[a-zA-Z]+"\s*:/.test(texto), "campos internos (_...) nunca saem na resposta");
  }
  const textoBruno = JSON.stringify(a.t.listarTodosTerritoriosConsolidados(BRUNO));
  assert.ok(!textoBruno.includes("ana@exemplo.test") && !textoBruno.includes("Ana Souza"),
    "cache gravado numa consulta de ADMIN não vaza nome/e-mail de terceiros para PUBLICADOR");
}

// --- 3. Cache quente não lê a planilha; fresco sempre lê ---
{
  const a = criarAmbiente(); popular(a);
  a.t.listarTodosTerritoriosConsolidados(ADMIN);
  assert.deepStrictEqual(json(a.leituras), { BASE: 1, DASHBOARD: 1, Respostas: 1, Predios: 1, QuadrasTrabalhadas: 1 });
  a.zerarLeituras();
  a.t.listarTodosTerritoriosConsolidados(BRUNO);
  a.t.listarTodosTerritoriosConsolidados(ADMIN);
  assert.strictEqual(a.totalLeituras(), 0, "listagens seguintes vêm do cache, para qualquer usuário");

  a.t.listarTodosTerritoriosConsolidados(BRUNO, { fresco: true });
  assert.strictEqual(a.totalLeituras(), 5, "transações (fresco) sempre leem a planilha");
  const escritasAntes = a.escritasCache();
  a.t.listarTodosTerritoriosConsolidados(BRUNO, { fresco: true });
  assert.strictEqual(a.escritasCache(), escritasAntes, "leitura fresca não grava no cache");
}

// --- 4. Rota: versão, "não modificado" e invalidação por escrita ---
{
  const a = criarAmbiente(); popular(a);
  const r1 = corpo(a.t.responderListagemTerritorios(BRUNO, {}));
  assert.ok(r1.sucesso && r1.versao && r1.territorios.length === 5);
  assert.ok(r1.territorios[0].wkt !== undefined, "cliente antigo (sem geometriaSeparada) continua recebendo wkt");
  assert.ok(r1.usuario && r1.config, "usuario e config sempre presentes");

  a.zerarLeituras();
  const r2 = corpo(a.t.responderListagemTerritorios(BRUNO, { versaoConhecida: r1.versao }));
  assert.strictEqual(r2.naoModificado, true);
  assert.strictEqual(r2.territorios, undefined, "não modificado: sem lista");
  assert.ok(r2.usuario && r2.config);
  assert.strictEqual(a.totalLeituras(), 0, "não modificado com cache quente: nenhuma leitura de planilha");

  // A versão é por usuário: a de Bruno não serve para o ADMIN (visões diferentes)
  const rAdmin = corpo(a.t.responderListagemTerritorios(ADMIN, { versaoConhecida: r1.versao }));
  assert.ok(!rAdmin.naoModificado && rAdmin.territorios.length === 5);
  assert.notStrictEqual(rAdmin.versao, r1.versao);
  const outroBruno = { nome: "Bruno Lima", email: "outro@exemplo.test", perfil: "PUBLICADOR" };
  assert.ok(!corpo(a.t.responderListagemTerritorios(outroBruno, { versaoConhecida: r1.versao })).naoModificado, "outra conta: outra versão");

  // Escrita de progresso (marcar prédio) invalida só o PROGRESSO
  a.zerarLeituras();
  const marcado = corpo(a.t.executarComLock(() => a.t.alternarPredioTrabalhadoTransacional(BRUNO, { idPredio: "PRD-1", numeroTerritorio: 1, trabalhado: true }), ["PROG"]));
  assert.strictEqual(marcado.sucesso, true);
  assert.ok(!a.leituras.BASE && !a.leituras.Respostas, "validar a posse não reconsolida a planilha (usa a BASE em cache)");
  a.zerarLeituras();
  const r3 = corpo(a.t.responderListagemTerritorios(BRUNO, { versaoConhecida: r1.versao }));
  assert.ok(!r3.naoModificado, "depois da escrita a versão conhecida não vale mais");
  assert.notStrictEqual(r3.versao, r1.versao);
  assert.strictEqual(porNumero(r3.territorios, 1).predios[0].trabalhadoNesteCiclo, true, "listagem reflete a marcação");
  assert.deepStrictEqual(json(a.leituras), { Predios: 1, QuadrasTrabalhadas: 1 }, "só o progresso é relido; BASE e Respostas continuam em cache");

  // Quem não tem a posse continua barrado, mesmo com a BASE vinda do cache
  const negado = corpo(a.t.executarComLock(() => a.t.alternarPredioTrabalhadoTransacional(ANA, { idPredio: "PRD-1", numeroTerritorio: 1, trabalhado: false }), ["PROG"]));
  assert.strictEqual(negado.codigo, 403);
  const semPosseQuadras = corpo(a.t.executarComLock(() => a.t.salvarQuadrasTrabalhadasTransacional(ANA, { numeroTerritorio: 1, pinos: [] }), ["PROG"]));
  assert.strictEqual(semPosseQuadras.codigo, 403);

  // Escrita que mexe em tudo (padrão do executarComLock): relê as cinco abas
  a.t.executarComLock(() => { a.abas.Respostas.appendRow([new Date(a.agora()), "Bruno Lima", "1", "Devolver", new Date(a.agora()), "bruno@exemplo.test", "Cidade"]); return null; });
  a.zerarLeituras();
  const r4 = corpo(a.t.responderListagemTerritorios(BRUNO, { versaoConhecida: r3.versao }));
  assert.strictEqual(porNumero(r4.territorios, 1).statusReal, "RECENTE", "devolução aparece na listagem seguinte");
  assert.strictEqual(a.totalLeituras(), 5);

  // Conteúdo igual após reconstrução -> mesma versão -> "não modificado" (sem depender de cache quente)
  a.t.invalidarCacheListagem();
  const r5 = corpo(a.t.responderListagemTerritorios(BRUNO, { versaoConhecida: r4.versao }));
  assert.strictEqual(r5.naoModificado, true, "invalidação sem mudança de conteúdo não força baixar a lista de novo");
}

// --- 5. Edição manual (onEdit), validade (TTL) e virada do dia ---
{
  const a = criarAmbiente(); popular(a);
  a.t.listarTodosTerritoriosConsolidados(ADMIN);

  // Edição direta na planilha sem onEdit: o cache ainda responde (até o TTL)...
  a.abas.BASE.dados[2][1] = "Bortot Novo";
  assert.strictEqual(porNumero(json(a.t.listarTodosTerritoriosConsolidados(ADMIN)), 2).bairro, "Bortot");
  // ...com o gatilho onEdit a mudança aparece na hora
  a.t.onEdit();
  assert.strictEqual(porNumero(json(a.t.listarTodosTerritoriosConsolidados(ADMIN)), 2).bairro, "Bortot Novo");

  // Sem gatilho (ex.: formulário): aparece ao vencer o TTL padrão
  a.abas.BASE.dados[2][1] = "Bortot Terceiro";
  a.avancar((a.t.CACHE_LISTAGEM.TTL_PADRAO_SECONDS - 5) * 1000);
  assert.strictEqual(porNumero(json(a.t.listarTodosTerritoriosConsolidados(ADMIN)), 2).bairro, "Bortot Novo");
  a.avancar(10 * 1000);
  assert.strictEqual(porNumero(json(a.t.listarTodosTerritoriosConsolidados(ADMIN)), 2).bairro, "Bortot Terceiro");
}
{
  // Virada do dia: RECENTE -> DISPONÍVEL não pode ficar preso no cache
  const a = criarAmbiente({ propriedades: { CACHE_LISTAGEM_TTL_SECONDS: "21600" } }); popular(a);
  a.abas.Respostas.dados.push([new Date(a.agora() - 120 * DIA), "Ana Souza", "5", "Devolver", new Date(a.agora() - 120 * DIA), "ana@exemplo.test", "Cidade"]);
  assert.strictEqual(porNumero(json(a.t.listarTodosTerritoriosConsolidados(ADMIN)), 5).statusReal, "RECENTE", "120 dias: ainda em quarentena");
  a.zerarLeituras();
  a.avancar(15 * 3600 * 1000);   // 10h -> 1h do dia seguinte (TTL de 6 h já venceu de qualquer forma)
  assert.strictEqual(porNumero(json(a.t.listarTodosTerritoriosConsolidados(ADMIN)), 5).statusReal, "DISPONÍVEL", "121 dias: liberado");
}
{
  // Mesmo com o cache ainda válido pelo relógio, cópia de ontem é recusada
  const a = criarAmbiente({ propriedades: { CACHE_LISTAGEM_TTL_SECONDS: "21600" } }); popular(a);
  a.avancar(11 * 3600 * 1000);   // 21h
  a.t.listarTodosTerritoriosConsolidados(ADMIN);
  a.zerarLeituras();
  a.avancar(4 * 3600 * 1000);    // 1h do dia seguinte, dentro das 6 h de validade
  a.t.listarTodosTerritoriosConsolidados(ADMIN);
  assert.strictEqual(a.totalLeituras(), 5, "virou o dia: reconsolida");
}
{
  // TTL = 0 desliga o cache (chave de emergência)
  const a = criarAmbiente({ propriedades: { CACHE_LISTAGEM_TTL_SECONDS: "0" } }); popular(a);
  a.t.listarTodosTerritoriosConsolidados(ADMIN);
  a.t.listarTodosTerritoriosConsolidados(ADMIN);
  assert.strictEqual(a.totalLeituras(), 10, "cache desligado: toda listagem lê a planilha");
  assert.strictEqual(a.escritasCache(), 0);
  const r = corpo(a.t.responderListagemTerritorios(ADMIN, {}));
  assert.strictEqual(corpo(a.t.responderListagemTerritorios(ADMIN, { versaoConhecida: r.versao })).naoModificado, true,
    "\"não modificado\" funciona pelo conteúdo, mesmo sem cache");
}

// --- 6. Corrida: leitura que começou antes de uma escrita não deixa dado antigo no cache ---
{
  const a = criarAmbiente(); popular(a);
  const geracaoAntes = a.t.lerGeracaoListagem("BASE");
  const baseAntiga = a.t.consolidarBaseTerritorios();          // leitor leu a planilha...
  baseAntiga.versao = "antiga";
  a.abas.BASE.dados[1][1] = "Centro Atualizado";               // ...um escritor alterou e invalidou...
  a.t.invalidarCacheListagem(["BASE"]);
  a.t.gravarConsolidacaoEmCache("BASE", baseAntiga, geracaoAntes);   // ...e só então o leitor gravou a cópia velha
  assert.strictEqual(a.t.lerConsolidacaoEmCache("BASE"), null, "cópia de geração anterior é ignorada");
  assert.strictEqual(porNumero(json(a.t.listarTodosTerritoriosConsolidados(ADMIN)), 1).bairro, "Centro Atualizado");
}

// --- 7. Valores grandes: divisão em partes abaixo do limite por chave ---
{
  const a = criarAmbiente();
  const pontos = [];
  for (let i = 0; i < 9000; i++) pontos.push(`-52.${600000 + i} -26.${200000 + i} 0`);
  const wktGrande = `MultiPolygonZ (((${pontos.join(", ")})))`;
  assert.ok(wktGrande.length > 200000);
  popular(a, wktGrande);
  const frio = json(a.t.listarTodosTerritoriosConsolidados(ADMIN));
  a.zerarLeituras();
  const quente = json(a.t.listarTodosTerritoriosConsolidados(ADMIN));
  assert.strictEqual(a.totalLeituras(), 0, "listagem grande também é servida do cache");
  assert.deepStrictEqual(quente, frio);
  assert.strictEqual(porNumero(quente, 1).wkt, wktGrande, "remontagem das partes preserva o conteúdo");
  const partes = Object.keys(a.cacheDados).filter(k => /^LST1_BASE_.+_\d+$/.test(k));
  assert.ok(partes.length >= 5, "valor dividido em várias chaves");
  assert.ok(partes.every(k => a.cacheDados[k].v.length <= a.t.CACHE_LISTAGEM.TAMANHO_PARTE));

  // Parte perdida (expulsa do cache): reconstrói em vez de devolver lixo
  delete a.cacheDados[partes[1]];
  a.zerarLeituras();
  assert.deepStrictEqual(json(a.t.listarTodosTerritoriosConsolidados(ADMIN)), frio);
  assert.ok(a.leituras.BASE === 1, "parte faltando -> reconsolida");
}

// --- 8. Geometria separada da listagem ---
{
  const a = criarAmbiente(); popular(a);
  const r1 = corpo(a.t.responderListagemTerritorios(BRUNO, { geometriaSeparada: true }));
  assert.ok(r1.territorios.every(t => !("wkt" in t)), "com geometriaSeparada os territórios não carregam wkt");
  assert.deepStrictEqual(Object.keys(r1.geometria.wkts).sort(), ["1", "2", "3", "4"], "território sem polígono não entra");
  assert.strictEqual(r1.geometria.wkts["3"], WKT(3));

  // Marcação muda a listagem, mas não a geometria: polígonos não são reenviados
  a.t.executarComLock(() => a.t.alternarPredioTrabalhadoTransacional(BRUNO, { idPredio: "PRD-1", numeroTerritorio: 1, trabalhado: true }), ["PROG"]);
  const r2 = corpo(a.t.responderListagemTerritorios(BRUNO, { geometriaSeparada: true, versaoConhecida: r1.versao, versaoGeometria: r1.geometria.versao }));
  assert.ok(r2.territorios && !r2.naoModificado);
  assert.strictEqual(r2.geometria.versao, r1.geometria.versao);
  assert.strictEqual(r2.geometria.wkts, undefined, "geometria inalterada não é reenviada");
  assert.ok(JSON.stringify(r2).length < JSON.stringify(r1).length);

  // Polígono alterado na planilha: nova versão e reenvio
  a.abas.BASE.dados[3][3] = WKT(7);
  a.t.onEdit();
  const r3 = corpo(a.t.responderListagemTerritorios(BRUNO, { geometriaSeparada: true, versaoConhecida: r2.versao, versaoGeometria: r2.geometria.versao }));
  assert.notStrictEqual(r3.geometria.versao, r2.geometria.versao);
  assert.strictEqual(r3.geometria.wkts["3"], WKT(7));
}

// --- 9. Cache indisponível não derruba a listagem nem a escrita ---
{
  const ref = criarAmbiente(); popular(ref);
  const esperado = json(ref.t.listarTodosTerritoriosConsolidados(ADMIN, { fresco: true }));

  const a = criarAmbiente({ cacheQuebrado: true }); popular(a);
  assert.deepStrictEqual(json(a.t.listarTodosTerritoriosConsolidados(ADMIN)), esperado, "sem cache, lê da planilha");
  const r = corpo(a.t.responderListagemTerritorios(BRUNO, { geometriaSeparada: true }));
  assert.ok(r.sucesso && r.territorios.length === 5);
  const marcado = corpo(a.t.executarComLock(() => a.t.alternarPredioTrabalhadoTransacional(BRUNO, { idPredio: "PRD-1", numeroTerritorio: 1, trabalhado: true }), ["PROG"]));
  assert.strictEqual(marcado.sucesso, true, "escrita conclui mesmo com o cache fora do ar");
}

// --- 10. Resumo de conteúdo: estável e sensível a mudanças ---
{
  const a = criarAmbiente();
  assert.strictEqual(a.t.resumirConteudo("abc"), a.t.resumirConteudo("abc"));
  assert.notStrictEqual(a.t.resumirConteudo("abc"), a.t.resumirConteudo("abd"));
  assert.notStrictEqual(a.t.resumirConteudo("ab"), a.t.resumirConteudo("ba"));
  assert.ok(/^[0-9a-z]+-[0-9a-z]+$/.test(a.t.resumirConteudo("ção ✓")));
}

console.log("CACHE DA LISTAGEM: TODOS OS TESTES PASSARAM.");
