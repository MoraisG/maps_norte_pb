/**
 * Medição por requisição (spec 08, fase 0): uma linha JSON no log, sem mudar a resposta.
 * Confere: linha emitida para login e para escrita com lock (etapas usuarios/esperaLock/dentroLock/auditoria),
 * flag lock429 quando o lock não sai, e que falha no console não derruba a requisição.
 */
const fs = require("fs"), vm = require("vm"), assert = require("assert"), path = require("path");
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, "..", "backend", "Code.gs"), "utf8");

let agora = Date.parse("2026-11-11T12:00:00Z");
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { a.length ? super(...a) : super(agora); }
  static now() { return agora; }
}
const cache = {};
function mkSheet(name, rows) {
  return {
    name, rows,
    getName() { return name; },
    appendRow(r) { agora += 7; this.rows.push(r.slice()); },
    getDataRange() { const s = this; return { getValues: () => { agora += 3; return s.rows.map(r => r.slice()); } }; },
    getRange(row, col) { const s = this; return { setValue(v) { s.rows[row - 1][col - 1] = v; }, setValues() {} }; },
    getLastRow() { return this.rows.length; }
  };
}
const sheets = {
  Usuarios: mkSheet("Usuarios", [["Id", "Nome", "Email", "Perfil", "Status"], ["USR-001", "Admin", "admin@x.com", "ADMIN", "ATIVO"]]),
  Auditoria: mkSheet("Auditoria", [["h"]])
};
const logs = [];
let consoleQuebrado = false;
let lockLivre = true;
const AUD = "917012478113-2nq9p3io8j8cao95gscamjh0jqrp6u4p.apps.googleusercontent.com";
const tokenInfo = { email: "admin@x.com", email_verified: "true", aud: AUD, iss: "https://accounts.google.com", exp: String(Math.floor(agora / 1000) + 3600), name: "Admin" };

const ctx = {
  Date: FakeDate, JSON, Math, Number, String, Set, Object, Array, RegExp, Error, Buffer,
  console: { log: t => { if (consoleQuebrado) throw new Error("console indisponível"); logs.push(t); }, error() {}, warn() {} },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  CacheService: { getScriptCache: () => ({ get: k => { const e = cache[k]; return e && e.exp > agora ? e.v : null; }, put: (k, v, t) => { cache[k] = { v, exp: agora + t * 1000 }; }, remove: k => delete cache[k] }) },
  Utilities: { base64EncodeWebSafe: s => Buffer.from(s).toString("base64"), getUuid: () => require("crypto").randomUUID(), formatDate: () => "x" },
  LockService: { getScriptLock: () => ({ tryLock() { agora += 11; return lockLivre; }, releaseLock() {} }) },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = mkSheet(n, [])) }), flush() {} },
  UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(tokenInfo) }) },
  ContentService: { createTextOutput: t => ({ t, setMimeType() { return this; } }), MimeType: { JSON: 1 } },
  Session: { getScriptTimeZone: () => "America/Sao_Paulo", getEffectiveUser: () => ({ getEmail: () => "admin@x.com" }) },
  Logger: { log() {} }, MailApp: {}, DriveApp: {}
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const call = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).t);
const medicoes = () => logs.map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(m => m && m.medicao === "requisicao");

// 1) Login gera uma linha com a rota e o tempo total
let r = call({ rota: "auth/login", idToken: "aaa.bbb.ccc" });
assert.ok(r.sucesso, JSON.stringify(r));
const sessao = r.sessionToken;
let m = medicoes().pop();
assert.strictEqual(m.rota, "auth/login");
assert.ok(m.ms > 0, "tempo total medido");

// 2) Escrita com lock: etapas usuarios, esperaLock, dentroLock, auditoria
logs.length = 0;
r = call({ rota: "admin/usuarios/salvar", sessionToken: sessao, dadosUsuario: { nome: "Novo", email: "novo@x.com", perfil: "PUBLICADOR", status: "ATIVO" } });
assert.ok(r.sucesso, JSON.stringify(r));
const ms = medicoes();
assert.strictEqual(ms.length, 1, "uma linha por requisição");
m = ms[0];
assert.strictEqual(m.rota, "admin/usuarios/salvar");
for (const etapa of ["usuarios", "esperaLock", "dentroLock", "auditoria"]) assert.ok(m.etapas[etapa] > 0, "etapa " + etapa + ": " + JSON.stringify(m));
assert.ok(m.ms >= m.etapas.usuarios + m.etapas.esperaLock + m.etapas.dentroLock, "total cobre as etapas");
assert.ok(!m.lock429 && !m.erro500);
assert.ok(!JSON.stringify(m).includes("@"), "nenhum e-mail no log de medição");

// 3) Lock ocupado: resposta 429 igual a antes + flag na medição
logs.length = 0;
lockLivre = false;
r = call({ rota: "admin/usuarios/salvar", sessionToken: sessao, dadosUsuario: { nome: "Outro", email: "outro@x.com", perfil: "PUBLICADOR", status: "ATIVO" } });
assert.strictEqual(r.codigo, 429);
m = medicoes().pop();
assert.strictEqual(m.lock429, true);
assert.ok(!("dentroLock" in m.etapas), "não entrou no lock");
lockLivre = true;

// 4) Falha no console não derruba a requisição; a próxima começa limpa
consoleQuebrado = true;
r = call({ rota: "auth/me", sessionToken: sessao });
assert.ok(r.sucesso, "requisição segue mesmo sem log");
consoleQuebrado = false;
logs.length = 0;
call({ rota: "auth/me", sessionToken: sessao });
m = medicoes().pop();
assert.strictEqual(m.rota, "auth/me");
assert.ok(!("esperaLock" in m.etapas), "estado da requisição anterior não vaza");

console.log("TODOS OS TESTES DE MEDIÇÃO PASSARAM");
