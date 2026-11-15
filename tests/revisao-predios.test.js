/**
 * Revisão do cadastro de prédios (backend/Code.gs): quem está com o cartão sugere andares e
 * apartamentos por andar; a sugestão fica PENDENTE até um ADMIN aprovar ou recusar.
 * Planilha simulada em memória; posse e auditoria substituídas por dublês.
 */
const fs = require("fs"), vm = require("vm"), assert = require("assert"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "backend", "Code.gs"), "utf8");

function criarAba(linhas) {
  const dados = linhas.map(l => l.slice());
  const garantir = (lin, col) => {
    while (dados.length < lin) dados.push([]);
    while (dados[lin - 1].length < col) dados[lin - 1].push("");
  };
  return {
    dados,
    getDataRange: () => ({ getValues: () => dados.map(l => l.slice()) }),
    appendRow: l => { dados.push(l.slice()); },
    getRange: (lin, col, nLin = 1, nCol = 1) => ({
      getValue: () => (dados[lin - 1] || [])[col - 1],
      setValue: v => { garantir(lin, col); dados[lin - 1][col - 1] = v; },
      setValues: m => {
        for (let i = 0; i < nLin; i++) for (let j = 0; j < nCol; j++) {
          garantir(lin + i, col + j);
          dados[lin - 1 + i][col - 1 + j] = m[i][j];
        }
      }
    })
  };
}

const abas = {};
const ss = { getSheetByName: n => abas[n] || null, insertSheet: n => (abas[n] = criarAba([])) };
let uuid = 0;
const ctx = {
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  Utilities: {
    getUuid: () => "abcdef" + String(++uuid).padStart(2, "0") + "-x",
    formatDate: d => d.toISOString().slice(0, 16).replace("T", " ")
  },
  Session: { getScriptTimeZone: () => "America/Sao_Paulo" },
  SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
  Logger: { log() {} },
  console
};
vm.createContext(ctx);
vm.runInContext(src, ctx);

// Dublês: respostas como objetos, auditoria em memória, posse controlada pelo teste
const auditoria = [];
vm.runInContext(`
  respostaJson = function (o) { return o; };
  registrarAuditoria = function (acao, nome, email, terr, res, det) { __aud.push([acao, terr, det]); };
  validarPosseParaProgresso = function (usuario, numTerr) {
    if (usuario.perfil === "ADMIN" || (__posse[numTerr] === usuario.email)) return { territorio: { numero: Number(numTerr) } };
    return { erro: { sucesso: false, codigo: 403, erro: "sem posse" } };
  };
`, Object.assign(ctx, { __aud: auditoria, __posse: { "7": "pub@x.com" } }));
const run = code => vm.runInContext(code, ctx);
const json = v => JSON.parse(JSON.stringify(v));

const cab = ["IdPredio", "NumeroTerritorio", "NomeEdificio", "Endereco", "Andares", "Apartamentos", "TipoInterfone", "TagsLogisticas", "ReferenciaComercial", "Latitude", "Longitude", "UltimaDataConclusao", "AptosTrabalhados"];
abas.Predios = criarAba([
  cab,
  ["PRD-A", 7, "Ed. A", "Rua X, 1", 5, 0, "EXTERNO", "", "", -26.22, -52.67, "", ""],
  ["PRD-B", 8, "Ed. B", "Rua Y, 2", 4, 8, "EXTERNO", "", "", -26.22, -52.67, "", ""]
]);
const pub = { nome: "Publicador", email: "pub@x.com", perfil: "PUBLICADOR" };
const outro = { nome: "Outro", email: "outro@x.com", perfil: "PUBLICADOR" };
const admin = { nome: "Admin", email: "adm@x.com", perfil: "ADMIN" };
ctx.__u = { pub, outro, admin };
const sugerir = (u, p) => json(ctx.sugerirCadastroPredioTransacional(u, p));
const revisar = (u, p) => json(ctx.revisarCadastroPredioTransacional(u, p));

// --- Validação da sugestão ---
assert.strictEqual(sugerir(pub, { idPredio: "PRD-A", numeroTerritorio: 7, andares: 0, aptosPorAndar: 2 }).codigo, 400);
assert.strictEqual(sugerir(pub, { idPredio: "PRD-A", numeroTerritorio: 7, andares: 5, aptosPorAndar: 13 }).codigo, 400);
assert.strictEqual(sugerir(pub, { idPredio: "PRD-A", numeroTerritorio: 7, andares: 2.5, aptosPorAndar: 2 }).codigo, 400);
assert.strictEqual(sugerir(pub, { idPredio: "", numeroTerritorio: 7, andares: 5, aptosPorAndar: 2 }).codigo, 400);
assert.strictEqual(sugerir(outro, { idPredio: "PRD-A", numeroTerritorio: 7, andares: 5, aptosPorAndar: 2 }).codigo, 403, "sem a posse do cartão");
assert.strictEqual(sugerir(pub, { idPredio: "PRD-B", numeroTerritorio: 7, andares: 4, aptosPorAndar: 2 }).codigo, 403, "prédio de outro território");
assert.strictEqual(sugerir(pub, { idPredio: "PRD-Z", numeroTerritorio: 7, andares: 4, aptosPorAndar: 2 }).codigo, 404);
assert.strictEqual(abas.PrediosRevisoes, undefined, "nenhuma sugestão inválida grava a aba");

// --- Sugestão válida fica PENDENTE e não muda o cadastro ---
let r = sugerir(pub, { idPredio: "PRD-A", numeroTerritorio: 7, andares: 6, aptosPorAndar: 4, observacao: "=CMD() contei no local" });
assert.ok(r.sucesso && !r.aplicada, JSON.stringify(r));
const idPrimeira = r.idRevisao;
assert.deepStrictEqual(abas.Predios.dados[1].slice(4, 6), [5, 0], "cadastro só muda depois da revisão");
const linhaRev = abas.PrediosRevisoes.dados[1];
assert.strictEqual(linhaRev[13], "PENDENTE");
assert.ok(String(linhaRev[12]).startsWith("'="), "observação neutraliza fórmula");

// Listagem: a sugestão pendente aparece só com números e data
let porTerr = json(ctx.carregarPrediosPorTerritorio(ss, null));
assert.deepStrictEqual(Object.keys(porTerr["7"][0].revisaoPendente).sort(), ["andares", "aptosPorAndar", "criadaEm"]);
assert.strictEqual(porTerr["7"][0].revisaoPendente.andares, 6);
assert.strictEqual(porTerr["8"][0].revisaoPendente, null);
assert.ok(!JSON.stringify(porTerr).includes("pub@x.com"), "e-mail do autor não vai para a listagem");

// Nova sugestão do mesmo prédio substitui a anterior
r = sugerir(pub, { idPredio: "PRD-A", numeroTerritorio: 7, andares: 6, aptosPorAndar: 2 });
const idSegunda = r.idRevisao;
assert.strictEqual(abas.PrediosRevisoes.dados[1][13], "SUBSTITUIDA");
let lista = json(ctx.listarRevisoesPrediosAdmin(30));
assert.strictEqual(lista.pendentes.length, 1);
assert.deepStrictEqual(lista.pendentes[0].proposto, { andares: 6, aptosPorAndar: 2, apartamentos: 12 });
assert.deepStrictEqual(lista.pendentes[0].antes, { andares: 5, aptosPorAndar: 0, apartamentos: 0 });
assert.strictEqual(lista.pendentes[0].cadastroMudou, false);

// --- Revisão ---
assert.strictEqual(revisar(admin, { idRevisao: idPrimeira, decisao: "APROVAR" }).codigo, 409, "substituída não pode ser aprovada");
assert.strictEqual(revisar(admin, { idRevisao: idSegunda, decisao: "TALVEZ" }).codigo, 400);
assert.strictEqual(revisar(admin, { idRevisao: "REV-NAOEXISTE", decisao: "APROVAR" }).codigo, 404);
r = revisar(admin, { idRevisao: idSegunda, decisao: "APROVAR" });
assert.ok(r.sucesso, JSON.stringify(r));
assert.deepStrictEqual(abas.Predios.dados[1].slice(4, 6), [6, 12], "andares e total gravados");
assert.strictEqual(abas.Predios.dados[0][13], "AptosPorAndar", "cabeçalho da coluna nova criado");
assert.strictEqual(abas.Predios.dados[1][13], 2);
assert.strictEqual(revisar(admin, { idRevisao: idSegunda, decisao: "RECUSAR" }).codigo, 409, "não revisa duas vezes");
porTerr = json(ctx.carregarPrediosPorTerritorio(ss, null));
assert.strictEqual(porTerr["7"][0].aptosPorAndar, 2);
assert.strictEqual(porTerr["7"][0].revisaoPendente, null);

// Repetir os mesmos números: nada a sugerir
assert.strictEqual(sugerir(pub, { idPredio: "PRD-A", numeroTerritorio: 7, andares: 6, aptosPorAndar: 2 }).codigo, 409);

// Recusa com motivo não muda o cadastro
r = sugerir(pub, { idPredio: "PRD-A", numeroTerritorio: 7, andares: 9, aptosPorAndar: 2 });
assert.ok(revisar(admin, { idRevisao: r.idRevisao, decisao: "RECUSAR", motivo: "São 6 andares" }).sucesso);
assert.deepStrictEqual(abas.Predios.dados[1].slice(4, 6), [6, 12]);
lista = json(ctx.listarRevisoesPrediosAdmin(30));
assert.strictEqual(lista.pendentes.length, 0);
assert.strictEqual(lista.decididas[0].status, "RECUSADA");
assert.strictEqual(lista.decididas[0].motivo, "São 6 andares");

// Cadastro mudou depois da sugestão: a lista sinaliza (como PR desatualizado)
r = sugerir(pub, { idPredio: "PRD-A", numeroTerritorio: 7, andares: 7, aptosPorAndar: 2 });
abas.Predios.dados[1][4] = 8;
lista = json(ctx.listarRevisoesPrediosAdmin(30));
assert.strictEqual(lista.pendentes[0].cadastroMudou, true);

// ADMIN aplica direto e a pendente do prédio é substituída
r = sugerir(admin, { idPredio: "PRD-B", numeroTerritorio: 8, andares: 4, aptosPorAndar: 3 });
assert.ok(r.sucesso && r.aplicada);
assert.deepStrictEqual(abas.Predios.dados[2].slice(4, 6), [4, 12]);
assert.strictEqual(abas.Predios.dados[2][13], 3);
assert.ok(auditoria.some(a => a[0] === "PREDIO_CADASTRO_ATUALIZADO"));
assert.ok(auditoria.some(a => a[0] === "PREDIO_REVISAO_RECUSADA"));

console.log("REVISÃO DE CADASTRO DE PRÉDIOS: TODOS OS TESTES PASSARAM.");
