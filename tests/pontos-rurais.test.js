/**
 * Casas do interior (spec 07, fase 2): importador local do KMZ (minimização, agrupamento,
 * território) e backend (importação pelo ADMIN, visibilidade, "visitado" e ciclo na devolução).
 */
const fs = require("fs"), vm = require("vm"), assert = require("assert"), path = require("path");
const I = require(path.join(__dirname, "..", "scripts", "rurais", "importar-pontos-kmz.js"));
const json = v => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------- importador (local)
const pm = (lng, lat, dados, nome) => `<Placemark><name>${nome || "Fulano de Tal"}</name><description>Fulano mora aqui</description><ExtendedData>
${Object.entries(dados).map(([k, v]) => `<Data name="${k}"><value>${v}</value></Data>`).join("")}</ExtendedData>
<Point><coordinates>${lng},${lat},0</coordinates></Point></Placemark>`;
const kml = `<kml><Document>
${pm(-52.70001, -26.20001, { Logradouro: "LINHA SAO ROQUE", Localidade: "SAO ROQUE", Tipo: "LEITE", Ref: "casa azul" })}
${pm(-52.700012, -26.200008, { Logradouro: "LINHA SAO ROQUE", Localidade: "SAO ROQUE", Tipo: "SOJA" })}
${pm(-52.71, -26.21, { Logradouro: "ESTRADA X", Endereco: "rua tal 123" })}
${pm(-53.5, -26.5, { Logradouro: "FORA" })}
<Placemark><name>contorno</name><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Document></kml>`;
const brutos = I.lerPontosKml(kml);
assert.strictEqual(brutos.length, 4, "só placemarks de ponto");
assert.deepStrictEqual(Object.keys(brutos[0]).sort(), ["lat", "lng", "localidade", "logradouro"], "nome, Tipo, Ref, descrição e Endereco descartados");

const quadrado = (lng, lat, d) => [[[[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]]];
const territorios = I.prepararTerritorios({ features: [
  { properties: { NUM_TERR: 20 }, geometry: { type: "MultiPolygon", coordinates: quadrado(-52.72, -26.22, 0.03) } }
] });
const { pontos, descartados, porTerritorio } = I.montarPontos(brutos, territorios);
assert.strictEqual(descartados, 1, "ponto fora dos territórios descartado");
assert.strictEqual(pontos.length, 2, "dois domicílios na mesma posição (5 casas) viram um ponto");
const agrupado = pontos.find(p => p.dom === 2);
assert.ok(agrupado && agrupado.terr === 20 && agrupado.log === "LINHA SAO ROQUE" && agrupado.loc === "SAO ROQUE");
assert.deepStrictEqual(porTerritorio, { 20: 2 });
assert.ok(/^PR[0-9A-Z]{7}$/.test(agrupado.id));
assert.strictEqual(I.idDoPonto(-26.20001, -52.70001), I.idDoPonto(-26.20001, -52.70001), "id estável");
assert.notStrictEqual(I.idDoPonto(-26.20001, -52.70001), I.idDoPonto(-26.20002, -52.70001));
assert.ok(!JSON.stringify(pontos).match(/Fulano|LEITE|SOJA|azul|rua tal/), "nenhum dado descartado vaza");

// ---------------------------------------------------------------- backend
const src = fs.readFileSync(path.join(__dirname, "..", "backend", "Code.gs"), "utf8");
function criarAba(linhas) {
  const dados = linhas.map(l => l.slice());
  const garantir = (lin, col) => { while (dados.length < lin) dados.push([]); while (dados[lin - 1].length < col) dados[lin - 1].push(""); };
  return {
    dados,
    getDataRange: () => ({ getValues: () => dados.map(l => l.slice()) }),
    appendRow: l => { dados.push(l.slice()); },
    clearContents: () => { dados.length = 0; },
    getRange: (lin, col, nLin = 1, nCol = 1) => ({
      getValue: () => (dados[lin - 1] || [])[col - 1],
      setValue: v => { garantir(lin, col); dados[lin - 1][col - 1] = v; },
      setValues: m => { for (let i = 0; i < nLin; i++) for (let j = 0; j < nCol; j++) { garantir(lin + i, col + j); dados[lin - 1 + i][col - 1 + j] = m[i][j]; } }
    })
  };
}
const abas = {};
const ss = { getSheetByName: n => abas[n] || null, insertSheet: n => (abas[n] = criarAba([])) };
const ctx = {
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  Utilities: { getUuid: () => "abcdef12-x", formatDate: d => d.toISOString().slice(0, 10) },
  Session: { getScriptTimeZone: () => "America/Sao_Paulo" },
  SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
  Logger: { log() {} },
  console, __aud: [], __posse: { "20": "pub@x.com" }
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
vm.runInContext(`
  respostaJson = function (o) { return o; };
  registrarAuditoria = function (acao, nome, email, terr, res, det) { __aud.push([acao, terr, det]); };
  validarPosseParaProgresso = function (usuario, numTerr) {
    if (usuario.perfil === "ADMIN" || __posse[numTerr] === usuario.email) return { territorio: { numero: Number(numTerr) } };
    return { erro: { sucesso: false, codigo: 403, erro: "sem posse" } };
  };
  listarTodosTerritoriosConsolidados = function () { return [{ numero: 20 }, { numero: 21 }]; };
`, ctx);
const pub = { nome: "Pub", email: "pub@x.com", perfil: "PUBLICADOR" };
const outro = { nome: "Outro", email: "outro@x.com", perfil: "PUBLICADOR" };
const admin = { nome: "Admin", email: "adm@x.com", perfil: "ADMIN" };

// Importação: validação "tudo ou nada"
const p1 = { id: "PRAAAA001", terr: 20, lat: -26.2, lng: -52.7, dom: 2, log: "LINHA SAO ROQUE", loc: "SAO ROQUE" };
const p2 = { id: "PRAAAA002", terr: 20, lat: -26.21, lng: -52.71, dom: 1, log: "=CMD()", loc: "" };
const p3 = { id: "PRAAAA003", terr: 21, lat: -26.25, lng: -52.75, dom: 1, log: "ESTRADA", loc: "" };
const importar = (u, pontos) => json(ctx.importarPontosRuraisAdmin(u, { pontos }));
assert.strictEqual(importar(admin, []).codigo, 400);
assert.strictEqual(importar(admin, [p1, Object.assign({}, p2, { terr: 999 })]).codigo, 400, "território inexistente");
assert.strictEqual(importar(admin, [p1, Object.assign({}, p2, { lat: 10 })]).codigo, 400, "fora da região");
assert.strictEqual(importar(admin, [p1, Object.assign({}, p2, { id: "x" })]).codigo, 400, "id inválido");
assert.strictEqual(importar(admin, [p1, Object.assign({}, p2, { id: p1.id })]).codigo, 400, "id repetido");
assert.strictEqual(abas.PontosRurais, undefined, "nada gravado em importação inválida");
let r = importar(admin, [p1, p2, p3]);
assert.ok(r.sucesso && r.total === 3 && r.territorios === 2, JSON.stringify(r));
assert.deepStrictEqual(abas.PontosRurais.dados[0], ["IdPonto", "NumeroTerritorio", "Latitude", "Longitude", "Domicilios", "Logradouro", "Localidade", "VisitadoEm"]);
assert.ok(String(abas.PontosRurais.dados[2][5]).startsWith("'="), "texto neutraliza fórmula");

// Visitado: só quem está com o cartão (ou ADMIN), ponto do território certo
const marcar = (u, p) => json(ctx.marcarPontoVisitadoTransacional(u, p));
assert.strictEqual(marcar(outro, { idPonto: p1.id, numeroTerritorio: 20, visitado: true }).codigo, 403);
assert.strictEqual(marcar(pub, { idPonto: p3.id, numeroTerritorio: 20, visitado: true }).codigo, 403, "ponto de outro território");
assert.strictEqual(marcar(pub, { idPonto: "PRNAOEXISTE", numeroTerritorio: 20, visitado: true }).codigo, 404);
r = marcar(pub, { idPonto: p1.id, numeroTerritorio: 20, visitado: true });
assert.ok(r.sucesso && r.visitado && /^\d{4}-\d{2}-\d{2}$/.test(r.visitadoEm));
assert.ok(ctx.__aud.some(a => a[0] === "PONTO_VISITADO"));

// Leitura agrupada por território
const porTerr = json(ctx.carregarPontosRuraisPorTerritorio(ss, new Set(["20", "21"])));
assert.strictEqual(porTerr["20"].length, 2);
assert.strictEqual(porTerr["20"].find(p => p.idPonto === p1.id).visitadoEm, r.visitadoEm);
assert.strictEqual(porTerr["20"].find(p => p.idPonto === p1.id).domicilios, 2);

// Reimportação preserva as visitas dos pontos que continuam
r = importar(admin, [p1, p3]);
assert.ok(r.sucesso && r.visitasPreservadas === 1);
assert.strictEqual(abas.PontosRurais.dados.length, 3, "p2 saiu");

// Devolução: com casa faltando, as visitas ficam; com todas visitadas, o ciclo recomeça
let ciclo = json(ctx.encerrarCicloPontosNaDevolucao(ss, "21"));
assert.deepStrictEqual(ciclo, { totalPontos: 1, pontosVisitados: 0, cicloPontosCompleto: false });
ciclo = json(ctx.encerrarCicloPontosNaDevolucao(ss, "20"));
assert.deepStrictEqual(ciclo, { totalPontos: 1, pontosVisitados: 1, cicloPontosCompleto: true });
assert.strictEqual(abas.PontosRurais.dados[1][7], "", "visita apagada ao completar o ciclo");

// Projeção: endereços só para quem está com o cartão ou ADMIN; os demais só a contagem
const base = { territorios: [{ numero: 20, _chave: "20", statusReal: "OCUPADO", _emailPosse: "pub@x.com", _dirigente: "Pub", _ciclos: [], wkt: "" }] };
const progresso = { predios: {}, quadras: {}, pontos: { "20": [{ idPonto: "PRX", lat: -26.2, lng: -52.7, domicilios: 1, logradouro: "L", localidade: "", visitadoEm: "2026-11-15" }] } };
const proj = u => json(ctx.projetarTerritoriosParaUsuario(base, progresso, u))[0];
assert.strictEqual(proj(pub).pontosRurais.length, 1);
assert.strictEqual(proj(admin).pontosRurais.length, 1);
assert.deepStrictEqual(proj(outro).pontosRurais, [], "sem endereços para quem não está com o cartão");
assert.strictEqual(proj(outro).totalPontosRurais, 1);
assert.strictEqual(proj(outro).pontosRuraisVisitados, 1);

console.log("CASAS DO INTERIOR (PONTOS RURAIS): TODOS OS TESTES PASSARAM.");
