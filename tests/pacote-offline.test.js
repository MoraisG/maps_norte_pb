/**
 * Pacote offline de ladrilhos (spec 06, fase 5): cálculo dos ladrilhos de uma área (js/geo.js),
 * montagem dos endereços (js/pacote-offline.js) e o trecho do service worker que baixa, guarda
 * e serve os ladrilhos (sw.js em ambiente simulado).
 */
const fs = require("fs"), vm = require("vm"), path = require("path"), assert = require("assert");
const RAIZ = path.join(__dirname, "..");
const Geo = require(path.join(RAIZ, "js", "geo.js"));
global.Geo = Geo;
global.Armazenamento = require(path.join(RAIZ, "js", "armazenamento.js"));
const PacoteOffline = require(path.join(RAIZ, "js", "pacote-offline.js"));

// ---------------------------------------------------------------------------------------------
// Geo.ladrilhosDaArea
// ---------------------------------------------------------------------------------------------
// Limites de um ladrilho (inverso da fórmula), para conferir a cobertura de forma independente
const limitesLadrilho = ({ z, x, y }) => {
  const n = 2 ** z;
  const lat = yy => Math.atan(Math.sinh(Math.PI * (1 - 2 * yy / n))) * 180 / Math.PI;
  return { oeste: x / n * 360 - 180, leste: (x + 1) / n * 360 - 180, norte: lat(y), sul: lat(y + 1) };
};
// Área rural de ~5 km x 5 km perto de Pato Branco
const AREA = { sul: -26.30, norte: -26.255, oeste: -52.75, leste: -52.70 };

assert.deepStrictEqual(Geo.ladrilhosDaArea(AREA, [0]), [{ z: 0, x: 0, y: 0 }]);
assert.deepStrictEqual(Geo.ladrilhosDaArea(AREA, [1]), [{ z: 1, x: 0, y: 1 }], "hemisférios sul e oeste");

for (const z of [13, 15, 17]) {
  const ladrilhos = Geo.ladrilhosDaArea(AREA, [z]);
  const uniao = ladrilhos.map(limitesLadrilho).reduce((a, b) => ({
    oeste: Math.min(a.oeste, b.oeste), leste: Math.max(a.leste, b.leste), sul: Math.min(a.sul, b.sul), norte: Math.max(a.norte, b.norte)
  }));
  assert.ok(uniao.oeste <= AREA.oeste && uniao.leste >= AREA.leste && uniao.sul <= AREA.sul && uniao.norte >= AREA.norte, `zoom ${z}: cobre a área inteira`);
  // Sem sobra: toda coluna e toda linha da grade tocam a área
  for (const l of ladrilhos.map(limitesLadrilho)) {
    assert.ok(l.leste > AREA.oeste && l.oeste < AREA.leste && l.norte > AREA.sul && l.sul < AREA.norte, `zoom ${z}: nenhum ladrilho fora da área`);
  }
  assert.strictEqual(new Set(ladrilhos.map(l => `${l.x}/${l.y}`)).size, ladrilhos.length, "sem repetição");
}
const n16 = Geo.ladrilhosDaArea(AREA, [16]).length, n17 = Geo.ladrilhosDaArea(AREA, [17]).length;
assert.ok(n17 > n16 * 3 && n17 <= n16 * 4, "cada zoom a mais multiplica por ~4");
assert.ok(n17 > 250 && n17 < 500, `5 km x 5 km no zoom 17: algumas centenas de ladrilhos (${n17})`);
assert.ok(Geo.ladrilhosDaArea(AREA, [17], 300).length > n17, "margem aumenta a cobertura");
assert.strictEqual(Geo.ladrilhosDaArea(AREA, [13, 14]).length, Geo.ladrilhosDaArea(AREA, [13]).length + Geo.ladrilhosDaArea(AREA, [14]).length);
// Ponto único (território minúsculo): um ladrilho por zoom
assert.strictEqual(Geo.ladrilhosDaArea({ sul: -26.2265, norte: -26.2265, oeste: -52.6725, leste: -52.6725 }, [17]).length, 1);

// ---------------------------------------------------------------------------------------------
// PacoteOffline.montarUrls / estimar
// ---------------------------------------------------------------------------------------------
const MODELOS_COM_CHAVE = {
  imagem: { url: "https://img.exemplo/tile/{z}/{y}/{x}?token=SEGREDO", zoomNativoMax: 18, ladrilho512: false },
  nomes: { url: "https://nomes.exemplo/tile/{z}/{y}/{x}?token=SEGREDO", zoomNativoMax: 19, ladrilho512: true }
};
const urls = PacoteOffline.montarUrls(AREA, MODELOS_COM_CHAVE);
const zoomsDe = host => Array.from(new Set(urls.filter(u => u.includes(host)).map(u => Number(/tile\/(\d+)\//.exec(u)[1])))).sort((a, b) => a - b);
assert.deepStrictEqual(zoomsDe("img.exemplo"), [13, 14, 15, 16, 17], "foto: zooms do mapa");
assert.deepStrictEqual(zoomsDe("nomes.exemplo"), [12, 13, 14, 15, 16], "nomes em 512 px: um zoom abaixo do mapa");
assert.ok(urls.every(u => /\/tile\/\d+\/\d+\/\d+\?token=SEGREDO$/.test(u)), "endereços no formato z/y/x");
assert.strictEqual(new Set(urls).size, urls.length);
const umLadrilho = Geo.ladrilhosDaArea(AREA, [17], PacoteOffline.MARGEM_METROS)[0];
assert.ok(urls.includes(`https://img.exemplo/tile/17/${umLadrilho.y}/${umLadrilho.x}?token=SEGREDO`), "ordem y antes de x, como no serviço da Esri");
const estimativa = PacoteOffline.estimar(AREA, MODELOS_COM_CHAVE);
assert.strictEqual(estimativa.ladrilhos, urls.length);
assert.ok(estimativa.megabytes >= 5 && estimativa.megabytes <= 30, `estimativa plausível (${estimativa.megabytes} MB)`);
assert.ok(urls.length < PacoteOffline.LIMITE_LADRILHOS);

// ---------------------------------------------------------------------------------------------
// Service worker: baixar, guardar sem o token e servir do pacote
// ---------------------------------------------------------------------------------------------
function criarSw(cachesIniciais = {}) {
  const ORIGEM = "https://app.exemplo";
  const ouvintes = {};
  const armazens = new Map(Object.entries(cachesIniciais).map(([nome, itens]) => [nome, new Map(Object.entries(itens))]));
  const rede = new Map(), chamadas = [];
  let emVoo = 0, picoEmVoo = 0;
  const resposta = (corpo, status = 200) => ({ corpo, status, ok: status >= 200 && status < 300, clone() { return resposta(corpo, status); } });
  const url = alvo => (typeof alvo === "string" ? alvo : alvo.url);
  const abrir = nome => {
    if (!armazens.has(nome)) armazens.set(nome, new Map());
    const m = armazens.get(nome);
    return { put: async (r, v) => { m.set(url(r), v); }, match: async r => m.get(url(r)) };
  };
  const caches = {
    open: async nome => abrir(nome),
    keys: async () => Array.from(armazens.keys()),
    delete: async nome => armazens.delete(nome),
    match: async r => { for (const m of armazens.values()) if (m.has(url(r))) return m.get(url(r)); }
  };
  const fetchSimulado = async (req, init = {}) => {
    const u = url(req);
    chamadas.push({ url: u, mode: init.mode, credentials: init.credentials });
    emVoo++; picoEmVoo = Math.max(picoEmVoo, emVoo);
    await new Promise(r => setImmediate(r));
    emVoo--;
    const regra = rede.get(u);
    if (!regra || regra.falha) throw new Error("sem rede");
    return resposta(regra.corpo, regra.status || 200);
  };
  const self = { location: { origin: ORIGEM }, addEventListener: (t, fn) => { ouvintes[t] = fn; }, skipWaiting() {}, clients: { claim: async () => {} } };
  const ctx = vm.createContext({ self, caches, fetch: fetchSimulado, URL, Promise, Set, Array, setTimeout, console, Request: function (u) { this.url = u; }, Response: { error: () => resposta("erro", 0) } });
  vm.runInContext(fs.readFileSync(path.join(RAIZ, "sw.js"), "utf8"), ctx);
  const disparar = (tipo, dados) => {
    const pendentes = []; let resp;
    ouvintes[tipo](Object.assign({ waitUntil: p => pendentes.push(Promise.resolve(p)), respondWith: p => { resp = Promise.resolve(p); } }, dados));
    return { resposta: resp, espera: () => Promise.all(pendentes) };
  };
  const imagem = u => ({ url: u, method: "GET", mode: "no-cors", destination: "image" });
  return { armazens, rede, chamadas, disparar, imagem, pico: () => picoEmVoo, resposta };
}
const assentar = () => new Promise(r => setTimeout(r, 5));
// Objetos criados dentro do vm têm outro protótipo: compara pelo conteúdo
const simples = v => JSON.parse(JSON.stringify(v));

(async () => {
  const T = n => `https://img.exemplo/tile/17/${n}/1?token=SEGREDO`;
  const SEM_TOKEN = n => `https://img.exemplo/tile/17/${n}/1`;

  // Sem nenhum pacote: imagens de outras origens não são interceptadas (comportamento de sempre)
  {
    const s = criarSw(); await assentar();
    assert.strictEqual(s.disparar("fetch", { request: s.imagem(T(1)) }).resposta, undefined);
  }

  // Download: guarda sem o token, em paralelo limitado, e avisa o andamento
  {
    const s = criarSw(); await assentar();
    const lista = [];
    for (let i = 0; i < 25; i++) { lista.push(T(i)); s.rede.set(T(i), { corpo: "ladrilho-" + i }); }
    s.rede.set(T(7), { corpo: "nao-encontrado", status: 404 });
    s.rede.set(T(8), { falha: true });
    const mensagens = [];
    const ev = s.disparar("message", { data: { tipo: "PACOTE_BAIXAR", numero: 12, urls: lista }, ports: [{ postMessage: m => mensagens.push(m) }] });
    await ev.espera();
    const cache = s.armazens.get("territorios-tiles-12");
    assert.strictEqual(cache.size, 23, "23 de 25 guardados (um 404 e uma falha de rede)");
    assert.ok(cache.has(SEM_TOKEN(3)) && !Array.from(cache.keys()).some(k => k.includes("SEGREDO")), "a chave de acesso não fica gravada no cache");
    assert.ok(s.chamadas.every(c => c.mode === "cors" && c.credentials === "omit"));
    assert.ok(s.pico() <= 6 && s.pico() >= 2, `downloads em paralelo limitado (pico ${s.pico()})`);
    const fim = mensagens[mensagens.length - 1];
    assert.deepStrictEqual(simples(fim), { tipo: "FIM", total: 25, falhas: 2, cancelado: false });
    assert.ok(mensagens.some(m => m.tipo === "PROGRESSO" && m.feitos === 10 && m.total === 25));

    // Depois do download, o mapa recebe o ladrilho guardado mesmo sem rede e com outro token
    s.rede.clear();
    const servido = await s.disparar("fetch", { request: s.imagem(SEM_TOKEN(3) + "?token=OUTRA-CHAVE") }).resposta;
    assert.strictEqual(servido.corpo, "ladrilho-3", "ladrilho servido do pacote, independente do token");
    // Ladrilho fora do pacote: tenta a rede (e falha, offline)
    await assert.rejects(s.disparar("fetch", { request: s.imagem(T(99)) }).resposta, /sem rede/);
    // Não-imagens de outras origens continuam fora (fontes, scripts)
    assert.strictEqual(s.disparar("fetch", { request: { url: "https://fonts.exemplo/a.woff2", method: "GET", destination: "font" } }).resposta, undefined);

    // Retomar: só o que falta é pedido de novo
    s.chamadas.length = 0;
    s.rede.set(T(7), { corpo: "ladrilho-7" }); s.rede.set(T(8), { corpo: "ladrilho-8" });
    const msgs2 = [];
    await s.disparar("message", { data: { tipo: "PACOTE_BAIXAR", numero: 12, urls: lista }, ports: [{ postMessage: m => msgs2.push(m) }] }).espera();
    assert.deepStrictEqual(s.chamadas.map(c => c.url).sort(), [T(7), T(8)].sort(), "retomada baixa só os ladrilhos faltantes");
    assert.deepStrictEqual(simples(msgs2[msgs2.length - 1]), { tipo: "FIM", total: 25, falhas: 0, cancelado: false });
  }

  // Cancelamento: para logo e reporta o que faltou
  {
    const s = criarSw(); await assentar();
    const lista = [];
    for (let i = 0; i < 60; i++) { lista.push(T(i)); s.rede.set(T(i), { corpo: "x" }); }
    const msgs = [];
    const ev = s.disparar("message", { data: { tipo: "PACOTE_BAIXAR", numero: 5, urls: lista }, ports: [{ postMessage: m => { msgs.push(m); if (m.tipo === "PROGRESSO" && m.feitos === 10) s.disparar("message", { data: { tipo: "PACOTE_CANCELAR", numero: 5 } }); } }] });
    await ev.espera();
    const fim = msgs[msgs.length - 1];
    assert.ok(fim.cancelado === true && fim.falhas > 0 && fim.falhas < 60, "cancelado no meio");
    assert.ok(s.chamadas.length < 60);
  }

  // Service worker reiniciado com pacote já existente: serve do pacote; após remoção, deixa de interceptar
  {
    const s = criarSw({ "territorios-tiles-3": {} });
    s.armazens.get("territorios-tiles-3").set(SEM_TOKEN(1), s.resposta("guardado"));
    await assentar();
    assert.strictEqual((await s.disparar("fetch", { request: s.imagem(T(1)) }).resposta).corpo, "guardado");
    s.armazens.delete("territorios-tiles-3");
    await s.disparar("message", { data: { tipo: "PACOTES_MUDARAM" } }).espera();
    assert.strictEqual(s.disparar("fetch", { request: s.imagem(T(1)) }).resposta, undefined, "sem pacotes: volta ao comportamento padrão");
    // Ativação não apaga pacotes
    s.armazens.set("territorios-tiles-9", new Map());
    await s.disparar("activate").espera();
    assert.ok(s.armazens.has("territorios-tiles-9"));
  }

  console.log("PACOTE OFFLINE: TODOS OS TESTES PASSARAM.");
})().catch(erro => { console.error(erro); process.exit(1); });
