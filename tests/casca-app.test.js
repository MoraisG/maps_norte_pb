/**
 * Casca do app (spec 06, fase 1): service worker "cache primeiro", versão única dos arquivos,
 * instalação (manifest + ícones) e sinalização de ação em andamento (Utils.sinalizarOcupado).
 * O service worker roda em um ambiente simulado (caches, fetch e relógio em memória).
 */
const fs = require("fs"), vm = require("vm"), path = require("path"), assert = require("assert");
const RAIZ = path.join(__dirname, "..");
const ler = arq => fs.readFileSync(path.join(RAIZ, arq), "utf8");
const ORIGEM = "https://app.exemplo";

// ---------------------------------------------------------------------------------------------
// Ambiente simulado do service worker
// ---------------------------------------------------------------------------------------------
function criarAmbienteSw() {
  const ouvintes = {};
  const armazens = new Map();      // nome do cache -> Map(url absoluta -> resposta)
  const rede = new Map();          // url absoluta -> { corpo, atrasoMs, falha, status }
  const chamadasRede = [];
  const temporizadores = [];
  let relogio = 0;

  const absoluta = alvo => new URL(typeof alvo === "string" ? alvo : alvo.url, ORIGEM + "/").href;
  const criarResposta = (corpo, status = 200) => ({
    corpo, status, ok: status >= 200 && status < 300,
    clone() { return criarResposta(corpo, status); }
  });

  class Request {
    constructor(url, init = {}) {
      this.url = absoluta(url);
      this.method = init.method || "GET";
      this.mode = init.mode || "no-cors";
      this.cache = init.cache || "default";
    }
  }

  const abrirCache = nome => {
    if (!armazens.has(nome)) armazens.set(nome, new Map());
    const mapa = armazens.get(nome);
    return {
      put: async (req, resp) => { mapa.set(absoluta(req), resp); },
      match: async req => mapa.get(absoluta(req))
    };
  };

  const caches = {
    open: async nome => abrirCache(nome),
    keys: async () => Array.from(armazens.keys()),
    delete: async nome => armazens.delete(nome),
    match: async req => {
      for (const mapa of armazens.values()) {
        const achado = mapa.get(absoluta(req));
        if (achado) return achado;
      }
      return undefined;
    }
  };

  // Relógio controlado pelo teste: avancar(ms) dispara os temporizadores vencidos
  const agendar = (fn, ms) => { temporizadores.push({ quando: relogio + (ms || 0), fn }); };
  const avancar = async ms => {
    relogio += ms;
    for (let volta = 0; volta < 20; volta++) {
      const vencidos = temporizadores.filter(t => t.quando <= relogio);
      for (const t of vencidos) { temporizadores.splice(temporizadores.indexOf(t), 1); t.fn(); }
      await new Promise(r => setImmediate(r));
      if (!vencidos.length) break;
    }
  };

  const fetchSimulado = (req, init = {}) => {
    const url = absoluta(req);
    chamadasRede.push({ url, cache: init.cache || req.cache || "default" });
    const regra = rede.get(url) || { falha: true };
    return new Promise((resolve, reject) => {
      const concluir = () => regra.falha ? reject(new Error("sem rede")) : resolve(criarResposta(regra.corpo, regra.status || 200));
      if (regra.atrasoMs) agendar(concluir, regra.atrasoMs); else concluir();
    });
  };

  const self = {
    location: { origin: ORIGEM },
    addEventListener: (tipo, fn) => { ouvintes[tipo] = fn; },
    skipWaiting: () => {},
    clients: { claim: async () => {} }
  };

  const contexto = vm.createContext({
    self, caches, fetch: fetchSimulado, Request, URL, Promise, setTimeout: agendar, console,
    Response: { error: () => criarResposta("erro-de-rede", 0) }
  });
  // Deixa constantes do topo (const VERSAO, STATIC_ASSETS...) acessíveis ao teste
  vm.runInContext(ler("sw.js") + "\n;globalThis.__sw = { VERSAO, CACHE_NAME, STATIC_ASSETS, ESPERA_NAVEGACAO_MS };", contexto);

  /** Dispara um evento e devolve { resposta (Promise ou undefined), espera (Promise de todos os waitUntil) }. */
  const disparar = (tipo, dados = {}) => {
    const pendentes = [];
    let resposta;
    const evento = Object.assign({
      waitUntil: p => { pendentes.push(Promise.resolve(p)); },
      respondWith: p => { resposta = Promise.resolve(p); }
    }, dados);
    ouvintes[tipo](evento);
    return { resposta, espera: () => Promise.all(pendentes) };
  };

  return { sw: contexto.__sw, armazens, rede, chamadasRede, disparar, avancar, Request, absoluta, criarResposta };
}

(async () => {
  // --- Instalação: guarda a casca; ativação: remove só cascas antigas ---
  {
    const a = criarAmbienteSw();
    for (const arq of a.sw.STATIC_ASSETS) a.rede.set(a.absoluta(arq), { corpo: "v-nova:" + arq });
    a.armazens.set("territorios-pwa-shell-v13", new Map([[ORIGEM + "/velho.js", a.criarResposta("velho")]]));
    a.armazens.set("territorios-tiles-12", new Map([[ORIGEM + "/ladrilho", a.criarResposta("ladrilho")]]));

    await a.disparar("install").espera();
    const casca = a.armazens.get(a.sw.CACHE_NAME);
    assert.strictEqual(casca.size, a.sw.STATIC_ASSETS.length, "instalação guarda todos os arquivos da casca");

    await a.disparar("activate").espera();
    assert.ok(!a.armazens.has("territorios-pwa-shell-v13"), "casca antiga removida na ativação");
    assert.ok(a.armazens.has("territorios-tiles-12"), "caches que não são da casca (pacotes offline) são preservados");
    assert.ok(a.armazens.has(a.sw.CACHE_NAME), "casca atual preservada");
  }

  // --- Arquivo em cache: responde na hora, sem esperar a rede, e atualiza a cópia depois ---
  {
    const a = criarAmbienteSw();
    const url = `${ORIGEM}/js/app.js?v=${a.sw.VERSAO}`;
    a.armazens.set(a.sw.CACHE_NAME, new Map([[url, a.criarResposta("copia-antiga")]]));
    a.rede.set(url, { corpo: "copia-nova", atrasoMs: 8000 });

    const ev = a.disparar("fetch", { request: new a.Request(url) });
    const resposta = await ev.resposta;
    assert.strictEqual(resposta.corpo, "copia-antiga", "serve o cache sem esperar a rede lenta");
    assert.strictEqual(a.chamadasRede[0].cache, "no-cache", "revalidação ignora o cache HTTP");

    await a.avancar(8000);
    await ev.espera();
    assert.strictEqual(a.armazens.get(a.sw.CACHE_NAME).get(url).corpo, "copia-nova", "cópia atualizada em segundo plano");
  }

  // --- Arquivo fora do cache: vem da rede e fica guardado; sem rede, falha (não inventa resposta) ---
  {
    const a = criarAmbienteSw();
    const url = `${ORIGEM}/assets/icon-192.png`;
    a.rede.set(url, { corpo: "icone" });
    const ev = a.disparar("fetch", { request: new a.Request(url) });
    assert.strictEqual((await ev.resposta).corpo, "icone");
    await ev.espera();
    assert.strictEqual(a.armazens.get(a.sw.CACHE_NAME).get(url).corpo, "icone", "primeira visita guarda o arquivo");

    const semRede = a.disparar("fetch", { request: new a.Request(`${ORIGEM}/js/nao-existe.js`) });
    await assert.rejects(semRede.resposta, /sem rede/);
  }

  // --- Resposta de erro (404/500) não substitui a cópia boa ---
  {
    const a = criarAmbienteSw();
    const url = `${ORIGEM}/css/styles.css?v=${a.sw.VERSAO}`;
    a.armazens.set(a.sw.CACHE_NAME, new Map([[url, a.criarResposta("css-bom")]]));
    a.rede.set(url, { corpo: "pagina de erro", status: 500 });
    const ev = a.disparar("fetch", { request: new a.Request(url) });
    await ev.resposta; await ev.espera();
    assert.strictEqual(a.armazens.get(a.sw.CACHE_NAME).get(url).corpo, "css-bom", "erro do servidor não vai para o cache");
  }

  // --- Navegação: rede primeiro quando ela responde dentro do limite ---
  {
    const a = criarAmbienteSw();
    const url = `${ORIGEM}/index.html`;
    a.armazens.set(a.sw.CACHE_NAME, new Map([[url, a.criarResposta("index-antigo")]]));
    a.rede.set(url, { corpo: "index-novo", atrasoMs: 500 });
    const ev = a.disparar("fetch", { request: new a.Request(url, { mode: "navigate" }) });
    await a.avancar(500);
    assert.strictEqual((await ev.resposta).corpo, "index-novo", "com rede, o index.html publicado prevalece");
    assert.strictEqual(a.chamadasRede[0].cache, "no-store");
    await ev.espera();
    assert.strictEqual(a.armazens.get(a.sw.CACHE_NAME).get(url).corpo, "index-novo");
  }

  // --- Navegação: rede lenta -> cache ao vencer o limite; a resposta atrasada ainda atualiza a cópia ---
  {
    const a = criarAmbienteSw();
    const url = `${ORIGEM}/`;
    a.armazens.set(a.sw.CACHE_NAME, new Map([[url, a.criarResposta("index-em-cache")]]));
    a.rede.set(url, { corpo: "index-atrasado", atrasoMs: 20000 });
    const ev = a.disparar("fetch", { request: new a.Request(url, { mode: "navigate" }) });
    let resolvida = false;
    ev.resposta.then(() => { resolvida = true; });

    await a.avancar(a.sw.ESPERA_NAVEGACAO_MS - 1);
    assert.strictEqual(resolvida, false, "antes do limite continua esperando a rede");
    await a.avancar(1);
    assert.strictEqual((await ev.resposta).corpo, "index-em-cache", "vencido o limite, abre com a cópia em cache");

    await a.avancar(20000);
    await ev.espera();
    assert.strictEqual(a.armazens.get(a.sw.CACHE_NAME).get(url).corpo, "index-atrasado");
  }

  // --- Navegação sem rede: cache; endereço com parâmetros cai no index.html guardado ---
  {
    const a = criarAmbienteSw();
    a.armazens.set(a.sw.CACHE_NAME, new Map([[`${ORIGEM}/index.html`, a.criarResposta("index-offline")]]));
    const ev = a.disparar("fetch", { request: new a.Request(`${ORIGEM}/index.html?origem=qr`, { mode: "navigate" }) });
    assert.strictEqual((await ev.resposta).corpo, "index-offline", "offline abre pelo cache");
  }

  // --- Navegação: rede lenta e nada em cache (primeira visita) -> espera a rede ---
  {
    const a = criarAmbienteSw();
    const url = `${ORIGEM}/index.html`;
    a.rede.set(url, { corpo: "primeira-visita", atrasoMs: 9000 });
    const ev = a.disparar("fetch", { request: new a.Request(url, { mode: "navigate" }) });
    await a.avancar(9000);
    assert.strictEqual((await ev.resposta).corpo, "primeira-visita");
  }

  // --- Fora do alcance do service worker: API, login Google, escritas e ladrilhos de mapa ---
  {
    const a = criarAmbienteSw();
    const fora = [
      new a.Request("https://script.google.com/macros/s/abc/exec", { method: "POST" }),
      new a.Request("https://script.googleusercontent.com/macros/echo?x=1"),
      new a.Request("https://accounts.google.com/gsi/client"),
      new a.Request("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/15/1/2"),
      new a.Request("https://tile.openstreetmap.org/15/1/2.png"),
      new a.Request(`${ORIGEM}/qualquer`, { method: "POST" })
    ];
    for (const request of fora) {
      assert.strictEqual(a.disparar("fetch", { request }).resposta, undefined, `não intercepta ${request.method} ${request.url}`);
    }
    assert.strictEqual(a.chamadasRede.length, 0);
  }

  // ---------------------------------------------------------------------------------------------
  // Versão única e arquivos da casca
  // ---------------------------------------------------------------------------------------------
  const { sw } = criarAmbienteSw();
  const index = ler("index.html");

  const versoesIndex = new Set(Array.from(index.matchAll(/\?v=(\d+)"/g), m => Number(m[1])));
  assert.deepStrictEqual(Array.from(versoesIndex), [sw.VERSAO], "index.html usa um único ?v=, igual à VERSAO do sw.js");
  const versaoQuadras = Number(/VERSAO_QUADRAS_GEO:\s*(\d+)/.exec(ler("js/map.js"))[1]);
  assert.strictEqual(versaoQuadras, sw.VERSAO, "VERSAO_QUADRAS_GEO (js/map.js) acompanha a VERSAO do sw.js");

  for (const arq of sw.STATIC_ASSETS) {
    const caminho = arq.replace(/^\.\//, "").replace(/\?.*$/, "") || "index.html";
    assert.ok(fs.existsSync(path.join(RAIZ, caminho)), `arquivo da casca existe: ${caminho}`);
  }
  // Todo script/estilo local do index.html está na casca (senão a abertura offline quebra)
  const locais = Array.from(index.matchAll(/<(?:script|link)[^>]+(?:src|href)="((?:js|css|vendor)\/[^"]+)"/g), m => "./" + m[1]);
  assert.ok(locais.length >= 8);
  for (const local of locais) {
    assert.ok(sw.STATIC_ASSETS.includes(local), `${local} do index.html precisa estar em STATIC_ASSETS`);
  }

  // ---------------------------------------------------------------------------------------------
  // Instalação: manifest e ícones
  // ---------------------------------------------------------------------------------------------
  const manifest = JSON.parse(ler("manifest.json"));
  const dimensoesPng = arq => {
    const buf = fs.readFileSync(path.join(RAIZ, arq));
    assert.strictEqual(buf.toString("latin1", 1, 4), "PNG", `${arq} é PNG`);
    return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
  };
  for (const icone of manifest.icons) {
    assert.ok(fs.existsSync(path.join(RAIZ, icone.src)), `ícone existe: ${icone.src}`);
    if (icone.type === "image/png") assert.strictEqual(dimensoesPng(icone.src), icone.sizes, `tamanho real de ${icone.src}`);
  }
  const pngAny = manifest.icons.filter(i => i.type === "image/png" && i.purpose === "any").map(i => i.sizes);
  assert.ok(pngAny.includes("192x192") && pngAny.includes("512x512"), "ícones PNG 192 e 512 (exigidos para instalar no Android)");
  assert.ok(manifest.icons.some(i => i.purpose === "maskable"), "ícone maskable próprio");
  assert.strictEqual(manifest.display, "standalone");
  const appleIcone = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(index)[1];
  assert.strictEqual(dimensoesPng(appleIcone), "180x180", "apple-touch-icon em PNG 180x180");

  // ---------------------------------------------------------------------------------------------
  // Ação em andamento: spinner + trava contra clique duplo
  // ---------------------------------------------------------------------------------------------
  const ctxUtils = vm.createContext({ console, document: { getElementById: () => null } });
  vm.runInContext(ler("js/utils.js") + "\n;globalThis.__Utils = Utils;", ctxUtils);
  const Utils = ctxUtils.__Utils;

  const criarBotao = () => {
    const classes = new Set(), atributos = {};
    return {
      dataset: {}, atributos, classes,
      setAttribute: (k, v) => { atributos[k] = v; },
      removeAttribute: k => { delete atributos[k]; },
      classList: { add: c => classes.add(c), remove: c => classes.delete(c) }
    };
  };

  {
    const botao = criarBotao();
    let concluir;
    const promessa = new Promise(r => { concluir = r; });
    assert.strictEqual(Utils.sinalizarOcupado(botao, promessa), promessa, "devolve a própria Promise");
    assert.ok(Utils.estaOcupado(botao), "ocupado enquanto a ação não termina");
    assert.strictEqual(botao.atributos["aria-busy"], "true");
    assert.ok(botao.classes.has("acao-ocupada"));
    concluir();
    await promessa; await new Promise(r => setImmediate(r));
    assert.ok(!Utils.estaOcupado(botao), "liberado ao terminar");
    assert.ok(!("aria-busy" in botao.atributos) && !botao.classes.has("acao-ocupada"));
  }
  {
    const botao = criarBotao();
    const falha = Promise.reject(new Error("recusado"));
    Utils.sinalizarOcupado(botao, falha);
    await falha.catch(() => {}); await new Promise(r => setImmediate(r));
    assert.ok(!Utils.estaOcupado(botao), "liberado também quando a ação falha");
  }
  {
    const botao = criarBotao();
    Utils.sinalizarOcupado(botao, undefined);
    Utils.sinalizarOcupado(botao, 42);
    assert.ok(!Utils.estaOcupado(botao), "ação síncrona não sinaliza nada");
    assert.strictEqual(Utils.sinalizarOcupado(null, Promise.resolve()) instanceof Promise, true, "sem elemento: só repassa");
  }

  console.log("CASCA DO APP (SERVICE WORKER, INSTALAÇÃO, AÇÃO EM ANDAMENTO): TODOS OS TESTES PASSARAM.");
})().catch(erro => { console.error(erro); process.exit(1); });
