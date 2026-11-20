/**
 * Script de análise da medição (spec 08, fase 0): extrai as linhas {"medicao":"requisicao"} de
 * texto colado da página Execuções, de exportação JSON do Cloud Logging e de NDJSON, e resume
 * tempos por etapa/rota/hora, lock429/erro500 e fontes (cache/planilha/fresco).
 */
const assert = require("assert"), path = require("path");
const { extrairMedicoes, analisar, formatarRelatorio, parseJanela, percentil } =
  require(path.join(__dirname, "..", "scripts", "medicao", "analisar-logs.js"));

const L = o => JSON.stringify(Object.assign({ medicao: "requisicao" }, o));

// 1) Texto da página Execuções: horário na mesma linha, ruído e a medição antiga de territorios/listar
const texto = [
  "21 de nov. de 2026 08:05:10\tInformação\t" + L({ rota: "auth/login", ms: 900, etapas: { usuarios: 600 } }),
  "08:06:00\tInformação\t" + JSON.stringify({ medicao: "territorios/listar", tipo: "x", ms: 50 }),
  "08:06:01\tInformação\t" + L({ rota: "territorios/listar", ms: 400, etapas: { usuarios: 100, base: 200 }, fontes: { base: ["cache"] } }),
  "Execução concluída",
  "09:30:00",
  "Informação",
  L({ rota: "respostas/salvar", ms: 31000, etapas: { usuarios: 100, esperaLock: 30000 }, lock429: true }),
  "15:10:00\tErro\t" + L({ rota: "respostas/salvar", ms: 2500, etapas: { usuarios: 100, esperaLock: 300, dentroLock: 1500, prog: 900, auditoria: 400 }, fontes: { prog: ["fresco"] } }),
  "18:00:00\tInformação\t" + L({ rota: "territorios/listar", ms: 3000, etapas: { base: 2500 }, fontes: { base: ["planilha"] }, erro500: true })
].join("\n");

const meds = extrairMedicoes(texto);
assert.strictEqual(meds.length, 5, "ignora a medição antiga (territorios/listar) e acha as 5 de requisição");
assert.deepStrictEqual(meds.map(m => m._horario && m._horario.local.h), [8, 8, 9, 15, 18], "horário da linha ou de linhas acima");

const r = analisar(meds);
assert.strictEqual(r.total, 5);
assert.strictEqual(r.lock429, 1);
assert.strictEqual(r.erro500, 1);
assert.strictEqual(r.geral.max, 31000);
assert.strictEqual(r.etapas.esperaLock.n, 2);
assert.strictEqual(r.etapas.esperaLock.max, 30000);
assert.strictEqual(r.rotas["respostas/salvar"].n, 2);
assert.strictEqual(r.rotas["respostas/salvar"].lock429, 1);
assert.deepStrictEqual(r.fontes.base, { cache: 1, planilha: 1 });
assert.deepStrictEqual(r.fontes.prog, { fresco: 1 });
assert.strictEqual(r.porHora["08h"].n, 2);
assert.strictEqual(r.maisLentas[0].ms, 31000);
assert.strictEqual(r.maisLentas[0].horario, "09:30:00");
// "outros" = ms - soma das etapas
assert.strictEqual(r.etapas.outros.n, 5);
assert.strictEqual(r.etapas.outros.max, 900); // 31000 - 30100

// 2) Janela 08–11 e 15–17 (horário de Brasília): fica fora a das 18h
const rj = analisar(meds, { janelas: parseJanela("08-11,15-17") });
assert.strictEqual(rj.total, 4);
assert.strictEqual(rj.ignoradasPelaJanela, 1);
assert.throws(() => parseJanela("8 às 11"));

// 3) Exportação JSON do Cloud Logging: timestamp UTC convertido para Brasília (11:05Z -> 08:05)
const cloud = JSON.stringify([
  { timestamp: "2026-11-21T11:05:00.123Z", textPayload: L({ rota: "auth/login", ms: 700, etapas: { usuarios: 500 } }) },
  { timestamp: "2026-11-21T18:20:00Z", jsonPayload: { message: L({ rota: "respostas/salvar", ms: 1200, etapas: { dentroLock: 800 } }) } },
  { timestamp: "2026-11-21T18:21:00Z", jsonPayload: { medicao: "requisicao", rota: "x", ms: 10, etapas: {} } },
  { timestamp: "2026-11-21T18:22:00Z", textPayload: "outra coisa qualquer" }
]);
const mc = extrairMedicoes(cloud);
assert.strictEqual(mc.length, 3);
const rc = analisar(mc, { janelas: parseJanela("08-11,15-17") });
assert.strictEqual(rc.total, 3);
assert.deepStrictEqual(Object.keys(rc.porHora).sort(), ["08h", "15h"]);

// 4) NDJSON
const nd = [
  JSON.stringify({ timestamp: "2026-11-21T12:00:00Z", textPayload: L({ rota: "a", ms: 100, etapas: {} }) }),
  JSON.stringify({ timestamp: "2026-11-21T12:01:00Z", textPayload: L({ rota: "a", ms: 300, etapas: {} }) })
].join("\n");
const rn = analisar(extrairMedicoes(nd));
assert.strictEqual(rn.total, 2);
assert.strictEqual(rn.rotas.a.p50, 100);

// 5) Percentil por posição (nearest-rank) e relatório sem quebrar
assert.strictEqual(percentil([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
assert.strictEqual(percentil([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
const txt = formatarRelatorio(r);
assert.ok(txt.includes("lock429: 1") && txt.includes("POR ROTA") && txt.includes("MAIS LENTAS"));
assert.ok(formatarRelatorio(analisar([])).includes("Nenhuma linha"));

console.log("analisar-medicao: ok");
