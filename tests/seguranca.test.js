const fs = require("fs"), vm = require("vm"), assert = require("assert");
const src = fs.readFileSync(process.argv[2] || require("path").join(__dirname, "..", "backend", "Code.gs"), "utf8");
const store = {};
const ctx = {
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => store[k] || null }) },
  CacheService: { getScriptCache: () => ({ get: k => store["c_"+k] || null, put: (k,v) => { store["c_"+k]=v; }, remove: k => delete store["c_"+k] }) },
  Utilities: { base64EncodeWebSafe: s => Buffer.from(s).toString("base64") },
  Session: {}, SpreadsheetApp: {}, Logger: { log(){} }, console
};
vm.createContext(ctx);
vm.runInContext(src + "\nthis.__t={sanitizarCelula,sanitizarLinha,compararSeguro,calcularNumerosElegiveisFila,consumirCota,usuarioPublico,CONFIG,PREDIOS_SEMENTE_NORTE};", ctx);
const t = ctx.__t;
// F1
assert.strictEqual(t.sanitizarCelula('=IMPORTXML("x")'), `'=IMPORTXML("x")`);
assert.strictEqual(t.sanitizarCelula("+1"), "'+1");
assert.strictEqual(t.sanitizarCelula("@a"), "'@a");
assert.strictEqual(t.sanitizarCelula("-"), "'-");
assert.strictEqual(t.sanitizarCelula("João Silva"), "João Silva");
assert.strictEqual(t.sanitizarCelula(42), 42);
const d = new Date(); assert.strictEqual(t.sanitizarCelula(d), d);
assert.strictEqual(t.sanitizarCelula("x".repeat(2000), 10).length, 10);
// F2
assert.ok(t.compararSeguro("abc","abc")); assert.ok(!t.compararSeguro("abc","abd")); assert.ok(!t.compararSeguro("abc","abcd")); assert.ok(!t.compararSeguro("",""+"x"));
// F6
let ok=0; for (let i=0;i<70;i++) if (t.consumirCota("T",60,60)) ok++; assert.strictEqual(ok,60);
// F5
assert.deepStrictEqual(Object.keys(t.usuarioPublico({id:1,nome:"a",email:"e",perfil:"P",status:"ATIVO",linhaPlanilha:9})).sort(), ["email","id","nome","perfil","status"]);
// F7 fila
const semente = new Set(t.PREDIOS_SEMENTE_NORTE.map(r=>String(r[1])));
const lista = [];
for (let n=1;n<=40;n++) lista.push({numero:n, statusReal: n%7===0?"OCUPADO":"DISPONÍVEL", tipo: n>30?"Rural":"Cidade", predios:[]});
const ord = lista.filter(x=>x.statusReal!=="OCUPADO").concat(lista.filter(x=>x.statusReal==="OCUPADO"));
const el = t.calcularNumerosElegiveisFila(ord);
["1","2","3","4","5","31","32","33","34","36"].forEach(n=>assert.ok(el.has(n), "esperado "+n));
assert.ok(!el.has("6") || semente.has("6"));
assert.ok(!el.has("20") || semente.has("20") );
console.log("TODOS OS TESTES PASSARAM. Elegíveis:", [...el].sort((a,b)=>a-b).join(","), "| territórios com semente:", [...semente].join(","));
