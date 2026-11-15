/**
 * Estradas rurais offline (spec 07, fase 1): gerador scripts/rurais/gerar-vias-rurais.js,
 * arquivo vias-rurais.geojson (só atributos públicos do OSM, só territórios rurais, na casca
 * do service worker) e camada do mapa do cartão (js/map.js) com Leaflet simulado.
 */
const fs = require("fs"), vm = require("vm"), path = require("path"), assert = require("assert");
const RAIZ = path.join(__dirname, "..");
const ler = arq => fs.readFileSync(path.join(RAIZ, arq), "utf8");
const Geo = require("../js/geo.js");
const Osm = require("../scripts/lib/overpass.js");
const Vias = require("../scripts/rurais/gerar-vias-rurais.js");

(async () => {
  // -------------------------------------------------------------------------------------------
  // Geometria do gerador
  // -------------------------------------------------------------------------------------------
  const densa = Vias.densificar([[0, 0], [100, 0]], 40);
  assert.deepStrictEqual(densa.map(p => p[0]), [0, 100 / 3, 200 / 3, 100], "densificar: trechos de no máximo 40 m");

  const reta = [[0, 0], [10, 0.5], [20, -0.5], [30, 0], [40, 20]];
  assert.deepStrictEqual(Vias.simplificarLinha(reta, 3), [[0, 0], [30, 0], [40, 20]], "Douglas-Peucker remove desvios < 3 m");
  assert.deepStrictEqual(Vias.simplificarLinha([[0, 0], [1, 1]], 3), [[0, 0], [1, 1]]);

  // Território quadrado de 1 km; linha que o atravessa de oeste a leste, de -2 km a +3 km
  const quadrado = [[[0, 0], [1000, 0], [1000, 1000], [0, 1000]]];
  const trechos = Vias.recortarLinha([[-2000, 500], [3000, 500]], [quadrado], 300, 40);
  assert.strictEqual(trechos.length, 1, "um trecho contínuo");
  const xs = trechos[0].map(p => p[0]);
  assert.ok(Math.min(...xs) >= -300 - 40 - 1e-6 && Math.min(...xs) <= -300 + 1e-6, "começa na margem de 300 m (+ 1 ponto)");
  assert.ok(Math.max(...xs) >= 1300 - 1e-6 && Math.max(...xs) <= 1340 + 1e-6, "termina na margem de 300 m (+ 1 ponto)");
  assert.deepStrictEqual(Vias.recortarLinha([[-2000, 3000], [3000, 3000]], [quadrado], 300, 40), [], "linha distante fica de fora");
  // Linha que sai e volta: dois trechos
  const zigue = Vias.recortarLinha([[500, 500], [500, 3000], [600, 3000], [600, 500]], [quadrado], 300, 40);
  assert.strictEqual(zigue.length, 2, "sai da área e volta: dois trechos");

  // -------------------------------------------------------------------------------------------
  // Atributos: só classe, nome/referência e superfície
  // -------------------------------------------------------------------------------------------
  assert.deepStrictEqual(
    Vias.atributosVia({ highway: "unclassified", name: "Estrada X", surface: "unpaved", operator: "Fulano", access: "private", "addr:housenumber": "12", note: "casa do João" }),
    { h: "unclassified", n: "Estrada X", s: "unpaved" });
  assert.deepStrictEqual(Vias.atributosVia({ highway: "trunk", ref: "BR-158" }), { h: "trunk", n: "BR-158" });
  assert.deepStrictEqual(Vias.atributosVia({ highway: "track" }), { h: "track" });

  const via = (id, tags, pts) => ({ type: "way", id, tags, geometry: pts.map(([lat, lon]) => ({ lat, lon })) });
  assert.ok(Vias.viaAceita(via(1, { highway: "track" }, [[0, 0], [0, 1]])));
  assert.ok(!Vias.viaAceita(via(1, { highway: "footway" }, [[0, 0], [0, 1]])), "caminho de pedestre fica de fora");
  assert.ok(!Vias.viaAceita(via(1, { highway: "service", service: "parking_aisle" }, [[0, 0], [0, 1]])));
  assert.ok(!Vias.viaAceita(via(1, { highway: "residential", area: "yes" }, [[0, 0], [0, 1]])));

  // -------------------------------------------------------------------------------------------
  // gerarFeatures com um território sintético (~1,1 km x 1,1 km)
  // -------------------------------------------------------------------------------------------
  const t = { numero: 7, partes: [[[[-52.70, -26.10], [-52.689, -26.10], [-52.689, -26.09], [-52.70, -26.09], [-52.70, -26.10]]]] };
  const osm = {
    elements: [
      via(20, { highway: "track", surface: "dirt" }, [[-26.095, -52.71], [-26.095, -52.68]]),
      via(10, { highway: "unclassified", name: "Estrada Linha Teste", surface: "unpaved", operator: "x" }, [[-26.099, -52.695], [-26.091, -52.695]]),
      via(30, { highway: "secondary" }, [[-26.20, -52.80], [-26.21, -52.81]]),   // longe
      via(40, { highway: "path" }, [[-26.095, -52.70], [-26.095, -52.69]])        // classe ignorada
    ]
  };
  const feats = Vias.gerarFeatures(osm, [t], { margemM: 300, toleranciaM: 3 });
  assert.strictEqual(feats.length, 2);
  assert.deepStrictEqual(feats.map(f => f.properties.h), ["unclassified", "track"], "ordem: classe mais importante primeiro");
  assert.deepStrictEqual(feats[0].properties, { NUM_TERR: 7, h: "unclassified", n: "Estrada Linha Teste", s: "unpaved" });
  for (const f of feats) {
    assert.strictEqual(f.geometry.type, "LineString");
    for (const c of f.geometry.coordinates) {
      for (const v of c) assert.ok(Math.abs(v * 1e5 - Math.round(v * 1e5)) < 1e-6, "5 casas decimais");
    }
  }
  // O carreador de 3 km foi recortado: só ~1,1 km + 2 x 300 m de margem
  const lngs = feats[1].geometry.coordinates.map(c => c[0]);
  assert.ok(Math.min(...lngs) > -52.705 && Math.max(...lngs) < -52.684, "carreador recortado no contorno + margem");
  const texto = Vias.serializar(feats, "2026-01-01T00:00:00Z");
  const reparse = JSON.parse(texto);
  assert.match(reparse.fonte, /OpenStreetMap contributors \(ODbL\)/);
  assert.strictEqual(reparse.features.length, 2);

  // Download com cache: a segunda chamada não vai à rede; a consulta só leva caixa e filtro
  const os = require("os");
  const pastaCache = fs.mkdtempSync(path.join(os.tmpdir(), "vias-cache-"));
  const pedidos = [];
  const fetchFalso = async (url, init) => {
    pedidos.push({ url, corpo: decodeURIComponent(init.body) });
    if (pedidos.length === 1) return { ok: false, status: 502 };
    return { ok: true, text: async () => JSON.stringify(osm) };
  };
  const opBaixar = { tipos: ["track", "unclassified"], cache: pastaCache, prefixo: "teste", fetch: fetchFalso, semEspera: true };
  const baixado = await Osm.baixarMalhaViaria([-26.1, -52.7, -26.09, -52.69], opBaixar);
  assert.strictEqual(baixado.elements.length, 4);
  assert.strictEqual(pedidos.length, 2, "tenta outro servidor depois do HTTP 502");
  assert.notStrictEqual(pedidos[0].url, pedidos[1].url);
  assert.strictEqual(pedidos[1].corpo, 'data=[out:json][timeout:180];way["highway"~"^(track|unclassified)$"](-26.1,-52.7,-26.09,-52.69);out tags geom;');
  await Osm.baixarMalhaViaria([-26.1, -52.7, -26.09, -52.69], opBaixar);
  assert.strictEqual(pedidos.length, 2, "segunda vez vem do cache local");
  fs.rmSync(pastaCache, { recursive: true, force: true });

  // -------------------------------------------------------------------------------------------
  // Arquivo publicado
  // -------------------------------------------------------------------------------------------
  const geo = JSON.parse(ler("vias-rurais.geojson"));
  assert.strictEqual(geo.type, "FeatureCollection");
  assert.match(geo.fonte, /© OpenStreetMap contributors \(ODbL\)/, "crédito ODbL no arquivo");
  assert.ok(geo.features.length > 100, "arquivo tem as vias");
  const territorios = Osm.classificarPorArea(Osm.carregarTerritorios(path.join(RAIZ, "territorios_nortpb.geojson")), { areaMaxUrbanoHa: 60 });
  const rurais = new Set(territorios.filter(x => !x.urbano).map(x => x.numero));
  const permitidos = new Set(["NUM_TERR", "h", "n", "s"]);
  const comVias = new Set();
  for (const f of geo.features) {
    for (const k of Object.keys(f.properties)) assert.ok(permitidos.has(k), `atributo não permitido no arquivo público: ${k}`);
    assert.ok(Vias.CLASSES_VIA.includes(f.properties.h), `classe inesperada: ${f.properties.h}`);
    assert.ok(rurais.has(f.properties.NUM_TERR), `via de território não rural: ${f.properties.NUM_TERR}`);
    assert.strictEqual(f.geometry.type, "LineString");
    assert.ok(f.geometry.coordinates.length >= 2);
    comVias.add(f.properties.NUM_TERR);
  }
  assert.ok(comVias.size >= rurais.size - 2, "quase todos os rurais têm estradas");
  assert.ok(fs.statSync(path.join(RAIZ, "vias-rurais.geojson")).size < 1.5 * 1024 * 1024, "arquivo cabe na casca (< 1,5 MB)");

  // Na casca do service worker, com a mesma versão
  const sw = ler("sw.js");
  assert.ok(sw.includes("`./vias-rurais.geojson?v=${VERSAO}`"), "vias-rurais.geojson na casca do service worker");
  assert.ok(ler("js/map.js").includes("vias-rurais.geojson?v=${this.VERSAO_QUADRAS_GEO}"), "map.js pede a mesma versão da casca");
  // Nenhum ponto de casa / KMZ entra por aqui
  assert.ok(!/kmz|kml/i.test(ler("scripts/rurais/gerar-vias-rurais.js").replace(/\/\*[\s\S]*?\*\//, "")), "gerador de vias não lê KML/KMZ");

  // -------------------------------------------------------------------------------------------
  // Camada no mapa do cartão (Leaflet simulado)
  // -------------------------------------------------------------------------------------------
  const desenhos = [];
  const criarGrupo = () => {
    const camadas = [];
    return { camadas, addLayer(c) { camadas.push(c); return this; }, clearLayers() { camadas.length = 0; return this; } };
  };
  const classes = new Set();
  const mapaFalso = {
    zoom: 13,
    getZoom() { return this.zoom; },
    getContainer() { return { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } }; }
  };
  const contexto = {
    console,
    L: {
      polyline: (pontos, opcoes) => { const p = { tipo: "linha", pontos, opcoes }; desenhos.push(p); return p; },
      marker: (pos, opcoes) => ({ tipo: "rotulo", pos, opcoes }),
      divIcon: o => o
    },
    Utils: { escapeHtml: s => String(s) },
    fetch: async url => {
      contexto.urlPedida = url;
      return { ok: true, json: async () => geoTeste };
    }
  };
  const geoTeste = {
    features: [
      { properties: { NUM_TERR: 18, h: "unclassified", n: "Estrada A", s: "unpaved" }, geometry: { type: "LineString", coordinates: [[-52.6, -26.1], [-52.61, -26.11], [-52.62, -26.12]] } },
      { properties: { NUM_TERR: 18, h: "trunk", n: "BR-158" }, geometry: { type: "LineString", coordinates: [[-52.6, -26.1], [-52.6, -26.2]] } },
      { properties: { NUM_TERR: 18, h: "track" }, geometry: { type: "LineString", coordinates: [[-52.6, -26.1], [-52.7, -26.2]] } },
      { properties: { NUM_TERR: 5, h: "residential" }, geometry: { type: "LineString", coordinates: [[-52.6, -26.1], [-52.6, -26.2]] } },
      { properties: { NUM_TERR: 18, h: "track" }, geometry: { type: "Point", coordinates: [-52.6, -26.1] } }
    ]
  };
  vm.createContext(contexto);
  const Mapa = vm.runInContext(ler("js/map.js") + "\n;MapaTerritorios", contexto);

  const indice = Mapa.indexarViasRurais(geoTeste);
  assert.strictEqual(indice.get(18).length, 3, "ignora geometria que não é linha");
  assert.strictEqual(JSON.stringify(indice.get(18)[1].pontos), "[[-26.1,-52.6],[-26.2,-52.6]]", "converte [lng, lat] → [lat, lng]");
  assert.strictEqual(Mapa.estiloVia({ classe: "unclassified", superficie: "unpaved" }).dashArray, "7 5", "estrada de terra tracejada");
  assert.strictEqual(Mapa.estiloVia({ classe: "unclassified", superficie: "asphalt" }).dashArray, null);
  assert.ok(Mapa.estiloVia({ classe: "trunk", superficie: "" }).weight > Mapa.estiloVia({ classe: "track", superficie: "" }).weight, "asfalto mais grosso que carreador");
  assert.strictEqual(Mapa.estiloVia({ classe: "secondary_link", superficie: "" }).color, Mapa.estiloVia({ classe: "secondary", superficie: "" }).color);

  Mapa.modalMap = mapaFalso;
  Mapa.modalViasRuraisLayer = criarGrupo();
  Mapa._rendererVias = { canvas: true };

  // Território urbano: nada é desenhado nem baixado
  Mapa.territorioModalAtual = 5;
  Mapa.renderizarViasRuraisModal({ numero: 5, tipo: "Cidade" });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(Mapa.modalViasRuraisLayer.camadas.length, 0);
  assert.strictEqual(contexto.urlPedida, undefined, "cartão urbano não pede o arquivo de vias");

  // Território rural
  Mapa.territorioModalAtual = 18;
  Mapa.renderizarViasRuraisModal({ numero: 18, tipo: "Rural" });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(contexto.urlPedida, `vias-rurais.geojson?v=${Mapa.VERSAO_QUADRAS_GEO}`);
  const linhas = Mapa.modalViasRuraisLayer.camadas.filter(c => c.tipo === "linha");
  const rotulos = Mapa.modalViasRuraisLayer.camadas.filter(c => c.tipo === "rotulo");
  assert.strictEqual(linhas.length, 6, "3 vias, cada uma com contorno claro + traço");
  assert.ok(linhas.every(l => l.opcoes.interactive === false && l.opcoes.renderer === Mapa._rendererVias), "canvas, sem interação");
  assert.strictEqual(rotulos.length, 2, "um nome por estrada com nome");
  assert.ok(rotulos.every(r => r.opcoes.pane === "rotulosQuadras" && r.opcoes.interactive === false));
  assert.ok(!classes.has("vias-nomes-visiveis"), "zoom 13: nomes ocultos");
  mapaFalso.zoom = 14;
  Mapa.atualizarNomesVias(mapaFalso);
  assert.ok(classes.has("vias-nomes-visiveis"), "zoom 14: nomes visíveis");

  // Trocar de cartão antes do arquivo chegar não desenha no cartão errado
  Mapa._viasRuraisPromessa = null;
  Mapa.modalViasRuraisLayer.clearLayers();
  Mapa.territorioModalAtual = 18;
  Mapa.renderizarViasRuraisModal({ numero: 18, tipo: "Rural" });
  Mapa.territorioModalAtual = 20;
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(Mapa.modalViasRuraisLayer.camadas.length, 0, "não desenha vias de outro cartão");

  // Sem o arquivo (falha de rede sem cache): não quebra e tenta de novo depois
  Mapa._viasRuraisPromessa = null;
  contexto.fetch = async () => { throw new Error("offline"); };
  Mapa.territorioModalAtual = 18;
  Mapa.renderizarViasRuraisModal({ numero: 18, tipo: "Rural" });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(Mapa._viasRuraisPromessa, null, "falha não fica guardada");

  // Fundo "Sem mapa" entre as opções de camada base
  assert.ok(/"Sem mapa": this\.criarFundoNeutro\(\)/.test(ler("js/map.js")));
  assert.ok(/\.mapa-sem-fundo\s*\{/.test(ler("css/styles.css")));

  console.log("vias-rurais: ok");
})().catch(e => { console.error(e); process.exit(1); });
