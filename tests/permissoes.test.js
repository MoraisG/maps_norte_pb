/**
 * Spec 02 — matriz de permissões e perfil SUPERVISOR.
 * Decisões de 2026-11-20: SUPERVISOR vê gestão (nomes, Em Campo, S-13) e devolve cartão alheio
 * (ScriptProperty SUPERVISOR_PODE_DEVOLVER_ALHEIO, padrão true); vê só a auditoria de territórios,
 * sem e-mails. PUBLICADOR não vê S-13/dashboard. Admin raiz intocável; inativar usuário com cartão
 * em campo pede confirmação e, confirmado, devolve os cartões.
 */
const fs = require("fs"), vm = require("vm"), path = require("path"), assert = require("assert");
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, "..", "backend", "Code.gs"), "utf8");

const DIA = 86400000;
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function criarAmbiente(props) {
  const agora = new Date(2026, 10, 14, 10, 0, 0).getTime();
  const cacheDados = {};
  const propriedades = Object.assign({}, props || {});

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
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in propriedades ? propriedades[k] : null) }) },
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
  vm.runInContext(src + `\nthis.__t={normalizarPerfil,temPermissao,permissoesDoUsuario,usuarioPublico,
    listarTodosTerritoriosConsolidados,rotearRequisicao};
    this.__sessaoDe = function (email) { validarSessao = function () { return { email: email, nome: "x" }; }; };`, ctx);

  const d = dias => new Date(agora - dias * DIA);
  abas.BASE = criarAba([
    ["NUM_TER", "DESC_TERRITORIO", "SITUACAO", "wkt_geom"],
    ["01", "Centro", "Urbana", ""],
    ["02", "Bortot", "Urbana", ""],
    ["03", "Fraron", "Urbana", ""]
  ]);
  abas.DASHBOARD = criarAba([["Num", "a", "b", "c", "Pdf", "d", "Bairro"]]);
  abas.Respostas = criarAba([
    ["Carimbo", "Nome", "Territorio", "Acao", "Data", "Email", "Tipo", "Obs", "Tag"],
    [d(300), "Ana Souza", "1", "Solicitar", d(300), "ana@exemplo.test", "Cidade"],
    [d(250), "Ana Souza", "1", "Devolver", d(250), "ana@exemplo.test", "Cidade", "", "COMPLETO"],
    [d(20), "Bruno Lima", "1", "Solicitar", d(20), "bruno@exemplo.test", "Cidade"],  // T1 com Bruno
    [d(15), "Bruno Lima", "2", "Solicitar", d(15), "bruno@exemplo.test", "Cidade"]   // T2 com Bruno
  ]);
  abas.Predios = criarAba([["IdPredio", "NumeroTerritorio", "NomeEdificio", "Endereco", "Andares", "Apartamentos", "TipoInterfone", "TagsLogisticas", "ReferenciaComercial", "Latitude", "Longitude", "UltimaDataConclusao", "AptosTrabalhados"]]);
  abas.Usuarios = criarAba([
    ["Id", "Nome", "Email", "Perfil", "Status", "CriadoEm", "CriadoPor", "UltimoAcesso", "UltimaAtividade"],
    ["USR-1", "Admin Raiz", "root@exemplo.test", "ADMIN", "ATIVO"],
    ["USR-2", "Ana Souza", "ana@exemplo.test", "PUBLICADOR", "ATIVO"],
    ["USR-3", "Bruno Lima", "bruno@exemplo.test", "PUBLICADOR", "ATIVO"],
    ["USR-4", "Sara Supervisora", "sara@exemplo.test", "SUPERVISOR", "ATIVO"],
    ["USR-5", "Otto Admin", "otto@exemplo.test", "admin", "ATIVO"],
    ["USR-6", "Perfil Estranho", "x@exemplo.test", "GERENTE", "ATIVO"]
  ]);
  abas.Auditoria = criarAba([
    ["IdOperacao", "DataHora", "Usuario", "Email", "Acao", "Territorio", "Resultado", "Detalhes"],
    ["AUD-1", d(3), "Ana Souza", "ana@exemplo.test", "SOLICITAR_TERRITORIO", "1", "SUCESSO", "Pedido por ana@exemplo.test"],
    ["AUD-2", d(2), "Admin Raiz", "root@exemplo.test", "ALTERAR_USUARIO", "-", "SUCESSO", "Alvo: ana@exemplo.test"],
    ["AUD-3", d(1), "Bruno Lima", "bruno@exemplo.test", "DEVOLVER_TERRITORIO", "3", "SUCESSO", "Devolvido por bruno@exemplo.test"]
  ]);

  const chamar = (email, rota, extra) => {
    ctx.__sessaoDe(email);
    const r = ctx.__t.rotearRequisicao("POST", {}, Object.assign({ rota: rota, sessionToken: "s" }, extra || {}));
    return JSON.parse(r.texto);
  };
  return { t: ctx.__t, abas, chamar };
}

const U = {
  admin: { nome: "Admin Raiz", email: "root@exemplo.test", perfil: "ADMIN" },
  sup: { nome: "Sara Supervisora", email: "sara@exemplo.test", perfil: "SUPERVISOR" },
  pub: { nome: "Ana Souza", email: "ana@exemplo.test", perfil: "PUBLICADOR" }
};

// --- 1. Matriz: perfis, permissões e normalização ---
{
  const { t } = criarAmbiente();
  assert.strictEqual(t.normalizarPerfil(" supervisor "), "SUPERVISOR");
  assert.strictEqual(t.normalizarPerfil("GERENTE"), "PUBLICADOR", "perfil desconhecido vira PUBLICADOR");
  assert.ok(t.temPermissao(U.sup, "gestao.visualizar"));
  assert.ok(t.temPermissao(U.sup, "territorios.devolverAlheio"), "Q1: supervisor devolve alheio por padrão");
  assert.ok(t.temPermissao(U.sup, "auditoria.territorios"));
  for (const acao of ["auditoria.completa", "usuarios.verEmail", "usuarios.gerenciar", "territorios.designar", "lembretes.disparar", "progresso.alheio"]) {
    assert.ok(!t.temPermissao(U.sup, acao), "supervisor sem " + acao);
  }
  for (const acao of ["gestao.visualizar", "territorios.devolverAlheio", "auditoria.territorios"]) {
    assert.ok(!t.temPermissao(U.pub, acao), "publicador sem " + acao);
  }
  assert.ok(!t.temPermissao(null, "gestao.visualizar"));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t.usuarioPublico(Object.assign({ id: "USR-4", status: "ATIVO" }, U.sup)).permissoes)),
    ["gestao.visualizar", "territorios.devolverAlheio", "auditoria.territorios"]);
  const desligado = criarAmbiente({ SUPERVISOR_PODE_DEVOLVER_ALHEIO: "false" });
  assert.ok(!desligado.t.temPermissao(U.sup, "territorios.devolverAlheio"), "ScriptProperty desliga a devolução alheia");
  assert.ok(desligado.t.temPermissao(U.admin, "territorios.devolverAlheio"));
}

// --- 2. Rotas: PUBLICADOR barrado em gestão/S-13/auditoria; auth/me traz permissões ---
{
  const a = criarAmbiente();
  for (const rota of ["relatorios/ano-servico", "gestao/dashboard", "admin/dashboard", "admin/auditoria", "admin/usuarios/listar"]) {
    const r = a.chamar("ana@exemplo.test", rota);
    assert.strictEqual(r.codigo, 403, rota + " → " + JSON.stringify(r));
  }
  assert.ok(a.abas.Auditoria.dados.some(l => l[4] === "ACESSO_NEGADO"), "negação auditada");
  const me = a.chamar("ana@exemplo.test", "auth/me");
  assert.deepStrictEqual(me.usuario.permissoes, []);
  const meOtto = a.chamar("otto@exemplo.test", "auth/me");
  assert.strictEqual(meOtto.usuario.perfil, "ADMIN", "perfil minúsculo na planilha é normalizado");
}

// --- 3. SUPERVISOR: gestão sim, usuários não; auditoria só de territórios e sem e-mails ---
{
  const a = criarAmbiente();
  assert.strictEqual(a.chamar("sara@exemplo.test", "gestao/dashboard").sucesso, true);
  assert.strictEqual(a.chamar("sara@exemplo.test", "relatorios/ano-servico").sucesso, true);
  assert.strictEqual(a.chamar("sara@exemplo.test", "admin/usuarios/listar").codigo, 403);
  assert.strictEqual(a.chamar("sara@exemplo.test", "admin/territorios/designar", { numeroTerritorio: 3, emailDirigente: "ana@exemplo.test", dataInicio: "2026-11-14" }).codigo, 403);

  const logs = a.chamar("sara@exemplo.test", "admin/auditoria").logs;
  assert.deepStrictEqual(logs.map(l => l.acao).filter(x => x !== "ACESSO_NEGADO"), ["DEVOLVER_TERRITORIO", "SOLICITAR_TERRITORIO"], "sem ações de usuários");
  assert.ok(!JSON.stringify(logs).includes("@"), "nenhum e-mail para o supervisor");
  assert.ok(logs.some(l => l.detalhes.includes("[e-mail]")));

  const logsAdmin = a.chamar("root@exemplo.test", "admin/auditoria").logs;
  assert.ok(logsAdmin.some(l => l.acao === "ALTERAR_USUARIO") && logsAdmin.some(l => l.email === "ana@exemplo.test"), "ADMIN vê tudo");
}

// --- 4. Listagem: supervisor vê nomes nos ciclos, mas não e-mails nem endereços de casas ---
{
  const a = criarAmbiente();
  const t1 = u => JSON.parse(JSON.stringify(a.t.listarTodosTerritoriosConsolidados(u, { fresco: true }))).find(t => t.numero === 1);
  const sup = t1(U.sup), pub = t1(U.pub), adm = t1(U.admin);
  assert.ok(sup.ciclos.some(c => c.dirigente === "Ana Souza"), "supervisor vê nomes do histórico");
  assert.strictEqual(sup.emailDirigente, "", "supervisor não vê e-mail");
  assert.strictEqual(adm.emailDirigente, "bruno@exemplo.test");
  assert.ok(pub.ciclos.every(c => c.dirigente === "" || c.dirigente === "Ana Souza"), "publicador só vê o próprio nome");
  assert.strictEqual(pub.dirigente, "Bruno Lima", "nome de quem está em campo continua visível");
}

// --- 5. Devolver cartão alheio: supervisor pode; publicador não; ScriptProperty desliga ---
{
  const a = criarAmbiente();
  const pub = a.chamar("ana@exemplo.test", "territorios/devolver", { numeroTerritorio: 1, foiCompleto: true });
  assert.strictEqual(pub.codigo, 403);
  const sup = a.chamar("sara@exemplo.test", "territorios/devolver", { numeroTerritorio: 1, foiCompleto: true });
  assert.strictEqual(sup.sucesso, true, sup.erro);

  const b = criarAmbiente({ SUPERVISOR_PODE_DEVOLVER_ALHEIO: "false" });
  assert.strictEqual(b.chamar("sara@exemplo.test", "territorios/devolver", { numeroTerritorio: 1, foiCompleto: true }).codigo, 403);
}

// --- 6. Cadastro: salva SUPERVISOR; admin raiz intocável ---
{
  const a = criarAmbiente();
  let r = a.chamar("root@exemplo.test", "admin/usuarios/salvar", { dadosUsuario: { nome: "Ana Souza", email: "ana@exemplo.test", perfil: "SUPERVISOR", status: "ATIVO" } });
  assert.strictEqual(r.sucesso, true, r.erro);
  assert.strictEqual(a.abas.Usuarios.dados[2][3], "SUPERVISOR", "perfil SUPERVISOR gravado (antes virava PUBLICADOR)");
  assert.ok(a.abas.Auditoria.dados.some(l => String(l[7]).includes("PUBLICADOR→SUPERVISOR")), "auditoria com antes→depois");

  r = a.chamar("otto@exemplo.test", "admin/usuarios/salvar", { dadosUsuario: { nome: "Admin Raiz", email: "root@exemplo.test", perfil: "PUBLICADOR", status: "ATIVO" } });
  assert.strictEqual(r.codigo, 400, "admin raiz não pode ser rebaixado");
  assert.strictEqual(a.abas.Usuarios.dados[1][3], "ADMIN");

  r = a.chamar("root@exemplo.test", "admin/usuarios/salvar", { dadosUsuario: { nome: "Otto Admin", email: "otto@exemplo.test", perfil: "PUBLICADOR", status: "ATIVO" } });
  assert.strictEqual(r.sucesso, true, "outro ADMIN pode ser rebaixado quando resta o raiz");

  r = a.chamar("sara@exemplo.test", "admin/usuarios/salvar", { dadosUsuario: { nome: "Sara Supervisora", email: "sara@exemplo.test", perfil: "ADMIN", status: "ATIVO" } });
  assert.strictEqual(r.codigo, 403, "supervisor não se promove");
}

// --- 7. Inativar quem está com cartões: pede confirmação; confirmado, devolve e audita ---
{
  const a = criarAmbiente();
  const dados = { nome: "Bruno Lima", email: "bruno@exemplo.test", perfil: "PUBLICADOR", status: "INATIVO" };
  let r = a.chamar("root@exemplo.test", "admin/usuarios/salvar", { dadosUsuario: dados });
  assert.strictEqual(r.codigo, 409);
  assert.strictEqual(r.confirmacaoNecessaria, true);
  assert.deepStrictEqual(r.territorios.map(t => t.numero).sort(), [1, 2]);
  assert.strictEqual(a.abas.Usuarios.dados[3][4], "ATIVO", "nada muda sem confirmação");

  r = a.chamar("root@exemplo.test", "admin/usuarios/salvar", { dadosUsuario: Object.assign({ forcar: true }, dados) });
  assert.strictEqual(r.sucesso, true, r.erro);
  assert.deepStrictEqual(r.devolvidos.sort(), ["T-1", "T-2"]);
  assert.strictEqual(a.abas.Usuarios.dados[3][4], "INATIVO");
  const emCampo = JSON.parse(JSON.stringify(a.t.listarTodosTerritoriosConsolidados(U.admin, { fresco: true }))).filter(t => t.statusReal === "OCUPADO");
  assert.strictEqual(emCampo.length, 0, "cartões devolvidos");
  assert.strictEqual(a.abas.Auditoria.dados.filter(l => l[4] === "DEVOLVER_POR_INATIVACAO" && l[6] === "SUCESSO").length, 2);

  // Sem cartões em campo: inativa direto
  r = a.chamar("root@exemplo.test", "admin/usuarios/salvar", { dadosUsuario: { nome: "Ana Souza", email: "ana@exemplo.test", perfil: "PUBLICADOR", status: "INATIVO" } });
  assert.strictEqual(r.sucesso, true, r.erro);
}

console.log("permissoes: ok");
