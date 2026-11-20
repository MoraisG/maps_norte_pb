/**
 * Módulo de Mapa Interativo GIS (Leaflet.js)
 * Renderiza os polígonos WKT reais da aba 'BASE' e os pinos georreferenciados dos prédios da Congregação Norte
 */
const MapaTerritorios = {
  map: null,
  layerGroup: null,
  prediosLayerGroup: null,
  inicializado: false,

  modalMap: null,
  modalLayerGroup: null,
  modalMarkersPorId: {},
  territorioModalAtual: null,
  modalInicializado: false,

  // Quadras trabalhadas (alfinetes) do cartão aberto na modal
  LIMITE_PINOS_QUADRAS: 80,
  quadrasLayerGroup: null,
  quadrasEdicao: null,       // { numero, pinos: [{lat,lng}], alterado } enquanto o dirigente edita
  modalLimitesTerritorio: null,
  _pontosModal: [],

  // Camadas base, rótulos e quadras numeradas (geometria de quadras.geojson — não confundir com
  // os alfinetes de "quadras trabalhadas" acima)
  CHAVE_CAMADA_BASE: "mapa.camadaBase",
  CAMADA_BASE_PADRAO: "Mapa claro",
  CHAVE_NUMEROS_QUADRAS: "mapa.numerosQuadras", // "1" = exibir números das quadras no mapa geral (padrão: não)
  // Chave de API da Esri (ArcGIS Location Platform) para o fundo de satélite.
  // NÃO fica no código: o backend a entrega depois do login (ScriptProperty ESRI_API_KEY, em
  // territorios/listar -> config.chaveEsri) e definirChaveEsri() a aplica. Vazia = endereço
  // antigo sem chave. Renovação: spec/runbooks/mapas-esri-satelite.md
  CHAVE_ESRI: "",
  FALHAS_SATELITE_PARA_DESISTIR: 4,
  ZOOM_MIN_DETALHES: 15,          // quadras numeradas e pinos de prédios só a partir deste zoom
  VERSAO_QUADRAS_GEO: 29,         // manter igual à VERSAO de sw.js (vale também para vias-rurais.geojson)
  ZOOM_MIN_NOMES_VIAS: 14,        // nomes das estradas rurais só a partir deste zoom
  ATRIBUICAO_OSM: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
  _localizacao: new Map(),        // mapa -> estado do "minha posição" (GPS)
  _mapasComCamadas: [],           // [{ map, camadas }] para sincronizar a preferência entre os mapas
  rotulosLayerGroup: null,
  quadrasGeoLayer: null,          // mapa geral
  modalQuadrasGeoLayer: null,     // mapa do cartão
  modalViasRuraisLayer: null,     // estradas do OSM no cartão rural (vias-rurais.geojson)
  abaModal: "cartao",             // aba da janela do cartão: cartao | quadras | predios
  modalPontosRuraisLayer: null,   // casas do interior (aba PontosRurais; só para quem está com o cartão)
  _rendererPontos: null,
  _controlePontos: null,
  _rendererVias: null,
  _viasRurais: null,              // Map(numeroTerritorio → [via])
  _viasRuraisPromessa: null,
  modalContextoLayer: null,       // máscara do entorno + territórios vizinhos
  minimapa: null,
  minimapaLayer: null,
  _quadrasGeo: null,              // Map(numeroTerritorio → [{ rotulo, lat, lng, partes, raioMetros }])
  _quadrasGeoPromessa: null,
  _rotulosTerritorios: [],
  _rotulosModal: [],
  _limitesUrbanos: null,
  _limitesTodos: null,
  _enquadrado: false,
  _vendoRurais: false,
  _contornoSelecao: null,
  _modalEnquadradoPara: null,

  inicializar() {
    if (this.inicializado) {
      setTimeout(() => this.map.invalidateSize(), 150);
      return;
    }

    this.map = L.map("map-container", {
      center: [-26.2265, -52.6725],
      zoom: 14,
      zoomControl: true
    });

    this.criarPainesRotulos(this.map);
    this.layerGroup = L.featureGroup().addTo(this.map);
    this.quadrasGeoLayer = L.layerGroup().addTo(this.map);
    this.prediosLayerGroup = L.featureGroup();
    this.rotulosLayerGroup = L.layerGroup().addTo(this.map);
    // Sem sobreposição "Quadras numeradas" aqui: no mapa geral os números são controlados
    // apenas pela caixa "Exibir números das quadras" (os contornos continuam aparecendo de perto).
    this.criarCamadasBase(this.map);

    const togglePredios = document.getElementById("toggle-map-predios");
    if (togglePredios) {
      togglePredios.addEventListener("change", () => this.atualizarDetalhesPorZoom());
    }

    const toggleQuadras = document.getElementById("toggle-map-quadras");
    if (toggleQuadras) {
      toggleQuadras.checked = this.lerPreferenciaNumerosQuadras();
      toggleQuadras.addEventListener("change", () => {
        try { localStorage.setItem(this.CHAVE_NUMEROS_QUADRAS, toggleQuadras.checked ? "1" : "0"); } catch (e) {}
        this.atualizarQuadrasGeoMapaGeral();
      });
    }

    this.map.on("zoomend", () => {
      this.atualizarRotulos(this.map, this._rotulosTerritorios);
      this.atualizarDetalhesPorZoom();
    });
    this.map.on("moveend", () => this.atualizarQuadrasGeoMapaGeral());
    this.map.on("popupclose", () => this.limparSelecao());

    this.renderizarLegenda();
    this.carregarQuadrasGeo().then(() => this.atualizarQuadrasGeoMapaGeral());
    this.inicializado = true;
  },

  inicializarModal() {
    if (this.modalInicializado) {
      setTimeout(() => this.modalMap.invalidateSize(), 100);
      return;
    }

    this.modalMap = L.map("modal-map-container", {
      center: [-26.2265, -52.6725],
      zoom: 16,
      zoomControl: true,
      zoomSnap: 0.5 // enquadra melhor o cartão em telas pequenas
    });

    this.criarPainesRotulos(this.modalMap);
    // Ordem de inclusão = ordem de desenho: entorno, território + prédios, quadras numeradas, alfinetes
    this.modalContextoLayer = L.layerGroup().addTo(this.modalMap);
    this.modalLayerGroup = L.featureGroup().addTo(this.modalMap);
    this.modalQuadrasGeoLayer = L.layerGroup().addTo(this.modalMap);
    this.quadrasLayerGroup = L.featureGroup().addTo(this.modalMap);
    // Estradas rurais: canvas num pane abaixo dos polígonos (leve com centenas de trechos).
    // O grupo leva o crédito do OSM, que assim aparece também sobre o satélite e o "Sem mapa".
    this._rendererVias = L.canvas({ pane: "viasRurais", padding: 0.3 });
    this.modalViasRuraisLayer = L.layerGroup([], { attribution: this.ATRIBUICAO_OSM }).addTo(this.modalMap);
    // Casas do interior: canvas num pane próprio, acima dos territórios e clicável
    const panePontos = this.modalMap.createPane("pontosRurais");
    panePontos.style.zIndex = 610;
    this._rendererPontos = L.canvas({ pane: "pontosRurais", padding: 0.3, tolerance: 6 });
    this.modalPontosRuraisLayer = L.layerGroup().addTo(this.modalMap);
    this.criarCamadasBase(this.modalMap, {
      "Quadras numeradas": this.modalQuadrasGeoLayer,
      "Estradas (rurais)": this.modalViasRuraisLayer,
      "Casas (rurais)": this.modalPontosRuraisLayer
    });
    this.criarMinimapa(this.modalMap);

    this.modalMap.on("zoomend", () => {
      this.atualizarRotulos(this.modalMap, this._rotulosModal);
      this.atualizarNomesVias(this.modalMap);
    });
    this.atualizarNomesVias(this.modalMap);
    this.modalMap.on("click", evento => this.aoClicarMapaModal(evento));
    this.modalInicializado = true;
  },

  /**
   * ==========================================================================
   * CAMADAS BASE, CONTROLES E RÓTULOS (compartilhados pelo mapa geral e pelo mapa do cartão)
   * ==========================================================================
   */

  /** Painéis próprios: nenhum deles recebe clique, para não atrapalhar polígonos e alfinetes. */
  criarPainesRotulos(map) {
    const criar = (nome, zIndex) => {
      const pane = map.createPane(nome);
      pane.style.zIndex = zIndex;
      pane.style.pointerEvents = "none";
    };
    criar("viasRurais", 350);       // estradas rurais (canvas), acima do fundo e abaixo dos territórios (400)
    criar("quadrasGeo", 420);       // contornos das quadras, acima dos territórios (400)
    criar("nomesRuas", 450);        // nomes de rua da camada base acima dos polígonos
    criar("rotulosQuadras", 590);   // números das quadras, abaixo dos pinos/alfinetes (600)
    criar("rotulosTerritorios", 650);
  },

  lerPreferenciaCamada() {
    try {
      return localStorage.getItem(this.CHAVE_CAMADA_BASE) || this.CAMADA_BASE_PADRAO;
    } catch (e) {
      return this.CAMADA_BASE_PADRAO;
    }
  },

  /** Camadas de fundo (uma instância por mapa). O ladrilho de nomes de rua fica acima dos polígonos. */
  criarLadrilhosBase() {
    const osm = this.ATRIBUICAO_OSM;
    // Os basemaps da CARTO (Positron/Voyager) passaram a exigir chave de API; por isso o fundo
    // claro é o próprio ladrilho do OpenStreetMap dessaturado por CSS (.ladrilhos-claros).
    const ladrilhoOsm = opcoes => L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", Object.assign({
      maxZoom: 20,
      maxNativeZoom: 19,
      attribution: osm
    }, opcoes));
    const satelite = this.criarCamadasSatelite();
    const grupoSatelite = L.layerGroup([satelite.imagem, satelite.nomes]);
    grupoSatelite.camadaImagem = satelite.imagem;

    return {
      "Mapa claro": ladrilhoOsm({ className: "ladrilhos-claros" }),
      "Ruas": ladrilhoOsm(),
      // No satélite, os nomes das vias vêm num ladrilho transparente desenhado acima dos polígonos
      "Satélite": grupoSatelite,
      // Sem ladrilhos: fundo neutro para usar sem internet (estradas rurais, contorno e "minha posição")
      "Sem mapa": this.criarFundoNeutro()
    };
  },

  /** Camada vazia que só troca a cor de fundo do mapa enquanto está ativa. */
  criarFundoNeutro() {
    const FundoNeutro = L.Layer.extend({
      onAdd(map) { map.getContainer().classList.add("mapa-sem-fundo"); },
      onRemove(map) { map.getContainer().classList.remove("mapa-sem-fundo"); }
    });
    return new FundoNeutro();
  },

  /** Foto de satélite + ladrilho transparente de nomes de vias, conforme haja ou não chave da Esri. */
  criarCamadasSatelite() {
    const atribEsri = 'Imagens &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">Esri</a>, Maxar, Earthstar Geographics e comunidade GIS';
    const modelos = this.modelosSatelite();
    const camada = (modelo, opcoes) => L.tileLayer(modelo.url, Object.assign({
      maxZoom: 20,
      maxNativeZoom: modelo.zoomNativoMax,
      attribution: atribEsri
    }, modelo.ladrilho512 ? { tileSize: 512, zoomOffset: -1 } : {}, opcoes));
    return {
      imagem: camada(modelos.imagem),
      // Nomes e traçado das vias sobre o satélite, desenhados acima dos polígonos (pane nomesRuas)
      nomes: camada(modelos.nomes, { pane: "nomesRuas" })
    };
  },

  /**
   * Endereços dos ladrilhos de satélite (foto + nomes de vias), conforme haja ou não chave da Esri.
   * Fonte única para as camadas de satélite do mapa.
   * ladrilho512: ladrilhos de 512 px pedidos um nível de zoom abaixo do zoom do mapa.
   */
  modelosSatelite() {
    // Com chave: serviço oficial de mapas-base (ibasemaps-api). Sem chave: endereço antigo.
    const chaveEsri = String(this.CHAVE_ESRI || "").trim();
    const baseEsri = chaveEsri
      ? "https://ibasemaps-api.arcgis.com/arcgis/rest/services"
      : "https://server.arcgisonline.com/ArcGIS/rest/services";
    const sufixoEsri = chaveEsri ? `?token=${encodeURIComponent(chaveEsri)}` : "";
    const esri = servico => `${baseEsri}/${servico}/MapServer/tile/{z}/{y}/{x}${sufixoEsri}`;
    return {
      imagem: { url: esri("World_Imagery"), zoomNativoMax: 18, ladrilho512: false },
      // Com chave: estilo transparente "arcgis/imagery/labels" do serviço Static Basemap Tiles
      // (ladrilhos de 512 px). Sem chave: ladrilho de referência do endereço antigo.
      nomes: chaveEsri
        ? { url: `https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/arcgis/imagery/labels/static/tile/{z}/{y}/{x}${sufixoEsri}`, zoomNativoMax: 19, ladrilho512: true }
        : { url: esri("Reference/World_Transportation"), zoomNativoMax: 18, ladrilho512: false }
    };
  },

  /** Troca o fundo de um mapa já criado (sem alterar a preferência salva do usuário). */
  usarCamadaBase(map, nome) {
    const item = this._mapasComCamadas.find(m => m.map === map);
    if (!item || !item.camadas[nome] || map.hasLayer(item.camadas[nome])) return;
    // O controle de camadas do Leaflet também avisa trocas feitas por código: marca esta
    // como automática para não virar preferência nem ser replicada aos outros mapas
    this._trocaAutomaticaCamada = true;
    try {
      Object.values(item.camadas).forEach(camada => map.removeLayer(camada));
      map.addLayer(item.camadas[nome]);
    } finally {
      this._trocaAutomaticaCamada = false;
    }
  },

  /**
   * Recebe a chave da Esri entregue pelo backend. Se mudou, recria as camadas de satélite dos
   * mapas já abertos (o grupo "Satélite" é o mesmo; só o conteúdo é trocado).
   */
  definirChaveEsri(chave) {
    const nova = String(chave || "").trim();
    if (nova === this.CHAVE_ESRI) return;
    this.CHAVE_ESRI = nova;
    this._avisouFalhaSatelite = false;
    for (const item of this._mapasComCamadas) {
      const grupo = item.camadas["Satélite"];
      if (!grupo) continue;
      const satelite = this.criarCamadasSatelite();
      grupo.clearLayers();
      grupo.addLayer(satelite.imagem);
      grupo.addLayer(satelite.nomes);
      grupo.camadaImagem = satelite.imagem;
      this.vigiarFalhaSatelite(item.map, item.camadas);
    }
  },

  /**
   * Se o satélite falhar repetidamente (chave vencida, cota esgotada, serviço fora do ar),
   * avisa uma vez e volta ao fundo padrão em vez de deixar o mapa cinza.
   */
  vigiarFalhaSatelite(map, camadas) {
    const grupo = camadas["Satélite"];
    const imagem = grupo && grupo.camadaImagem;
    if (!imagem) return;
    let falhasSeguidas = 0;
    imagem.on("tileload", () => { falhasSeguidas = 0; });
    imagem.on("tileerror", () => {
      // Sem rede, ladrilho faltando é esperado: não troca o fundo nem avisa
      if (navigator.onLine === false) return;
      falhasSeguidas++;
      if (falhasSeguidas < this.FALHAS_SATELITE_PARA_DESISTIR || !map.hasLayer(grupo)) return;
      falhasSeguidas = 0;
      map.removeLayer(grupo);
      map.addLayer(camadas[this.CAMADA_BASE_PADRAO]);
      try { localStorage.setItem(this.CHAVE_CAMADA_BASE, this.CAMADA_BASE_PADRAO); } catch (e) {}
      if (!this._avisouFalhaSatelite) {
        this._avisouFalhaSatelite = true;
        Utils.mostrarToast("O fundo de satélite está indisponível no momento. Voltamos ao mapa claro.", "aviso");
      }
    });
  },

  /**
   * Ponto único de criação das camadas base + seletor, escala, norte e atribuição.
   * A escolha do usuário fica em localStorage e vale para todos os mapas.
   */
  criarCamadasBase(map, sobreposicoes) {
    const camadas = this.criarLadrilhosBase();
    const preferida = this.lerPreferenciaCamada();
    camadas[camadas[preferida] ? preferida : this.CAMADA_BASE_PADRAO].addTo(map);

    L.control.layers(camadas, sobreposicoes || {}, { position: "topright", collapsed: true }).addTo(map);
    L.control.scale({ imperial: false, maxWidth: 120, position: "bottomleft" }).addTo(map);
    this.criarControleNorte().addTo(map);
    this.criarControleLocalizacao(map).addTo(map);
    if (map.attributionControl) map.attributionControl.setPrefix("Congregação Norte PB");

    this.vigiarFalhaSatelite(map, camadas);
    this._mapasComCamadas.push({ map, camadas });
    map.on("baselayerchange", evento => {
      if (this._trocaAutomaticaCamada) return;
      try { localStorage.setItem(this.CHAVE_CAMADA_BASE, evento.name); } catch (e) {}
      // Replica a escolha nos outros mapas já criados
      for (const outro of this._mapasComCamadas) {
        if (outro.map === map || !outro.camadas[evento.name] || outro.map.hasLayer(outro.camadas[evento.name])) continue;
        Object.values(outro.camadas).forEach(camada => outro.map.removeLayer(camada));
        outro.map.addLayer(outro.camadas[evento.name]);
      }
    });
    return camadas;
  },

  /**
   * ==========================================================================
   * MINHA POSIÇÃO (GPS do aparelho; funciona sem internet)
   * ==========================================================================
   * A posição fica só na tela: não é enviada ao servidor nem gravada.
   */
  criarControleLocalizacao(map) {
    const self = this;
    const Controle = L.Control.extend({
      options: { position: "topleft" },
      onAdd() {
        const el = L.DomUtil.create("button", "leaflet-bar controle-localizacao");
        el.type = "button";
        el.title = "Mostrar minha posição";
        el.setAttribute("aria-label", "Mostrar minha posição no mapa");
        el.setAttribute("aria-pressed", "false");
        el.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="currentColor"/><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
        L.DomEvent.disableClickPropagation(el);
        L.DomEvent.on(el, "click", () => self.alternarLocalizacao(map, el));
        return el;
      }
    });
    return new Controle();
  },

  alternarLocalizacao(map, botao) {
    if (this._localizacao.has(map)) {
      this.pararLocalizacao(map);
      return;
    }
    if (!navigator.geolocation) {
      Utils.mostrarToast("Este aparelho ou navegador não informa a localização.", "aviso");
      return;
    }
    const estado = { botao, marcador: null, circulo: null, primeira: true, avisouErro: false, id: null };
    this._localizacao.set(map, estado);
    botao.setAttribute("aria-pressed", "true");
    botao.classList.add("ativo");
    estado.id = navigator.geolocation.watchPosition(
      posicao => this.aoReceberPosicao(map, estado, posicao),
      erro => {
        if (erro && erro.code === 1) {
          this.pararLocalizacao(map);
          Utils.mostrarToast("Permissão de localização negada. Libere a localização para este app nas configurações do navegador.", "aviso");
        } else if (!estado.avisouErro) {
          estado.avisouErro = true;
          Utils.mostrarToast("Ainda não foi possível obter sua posição. Em área aberta o GPS costuma responder melhor.", "aviso");
        }
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 }
    );
  },

  aoReceberPosicao(map, estado, posicao) {
    if (this._localizacao.get(map) !== estado) return;   // já foi desligado
    const ponto = [posicao.coords.latitude, posicao.coords.longitude];
    const precisao = Math.max(5, Number(posicao.coords.accuracy) || 0);
    if (!estado.marcador) {
      estado.circulo = L.circle(ponto, { radius: precisao, color: "#1a73e8", weight: 1, fillColor: "#1a73e8", fillOpacity: 0.12, interactive: false }).addTo(map);
      estado.marcador = L.circleMarker(ponto, { radius: 7, color: "#ffffff", weight: 2.5, fillColor: "#1a73e8", fillOpacity: 1, interactive: false }).addTo(map);
    } else {
      estado.circulo.setLatLng(ponto).setRadius(precisao);
      estado.marcador.setLatLng(ponto);
    }
    estado.marcador.bringToFront();
    if (estado.primeira) {
      estado.primeira = false;
      // Só move o mapa se a pessoa estiver fora da área visível
      if (!map.getBounds().contains(ponto)) map.panTo(ponto);
    }
  },

  pararLocalizacao(map) {
    const estado = this._localizacao.get(map);
    if (!estado) return;
    this._localizacao.delete(map);
    try { navigator.geolocation.clearWatch(estado.id); } catch (e) {}
    if (estado.marcador) map.removeLayer(estado.marcador);
    if (estado.circulo) map.removeLayer(estado.circulo);
    estado.botao.setAttribute("aria-pressed", "false");
    estado.botao.classList.remove("ativo");
  },

  /**
   * ==========================================================================
   * PACOTE OFFLINE (mapa de satélite do território rural sem internet)
   * ==========================================================================
   */
  criarControleNorte() {
    const Controle = L.Control.extend({
      options: { position: "topleft" },
      onAdd() {
        const el = L.DomUtil.create("div", "leaflet-bar controle-norte");
        el.title = "Norte";
        el.setAttribute("aria-label", "Indicação do norte");
        el.innerHTML = '<svg viewBox="0 0 24 30" width="22" height="28" aria-hidden="true"><path d="M12 9 L18 27 L12 23 L6 27 Z" fill="#1f2937"/><path d="M12 9 L12 23 L6 27 Z" fill="#9ca3af"/><text x="12" y="8" text-anchor="middle" font-size="9" font-weight="700" fill="#1f2937">N</text></svg>';
        L.DomEvent.disableClickPropagation(el);
        return el;
      }
    });
    return new Controle();
  },

  /** Opções de L.polygon para um status (ver Utils.ESTILO_STATUS). */
  estiloPoligono(chave) {
    const e = Utils.ESTILO_STATUS[chave] || Utils.ESTILO_STATUS.AGUARDANDO;
    return {
      color: e.borda,
      weight: e.peso,
      fillColor: e.preenchimento,
      fillOpacity: e.opacidade,
      dashArray: e.tracejado || null,
      lineJoin: "round",
      className: e.hachura ? "poligono-hachura-ocupado" : ""
    };
  },

  hexParaRgba(hex, alfa) {
    const n = parseInt(String(hex).replace("#", ""), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alfa})`;
  },

  /** Legenda gerada da mesma tabela que colore os polígonos. */
  renderizarLegenda() {
    const el = document.getElementById("mapa-legenda");
    if (!el) return;
    el.innerHTML = Object.keys(Utils.ESTILO_STATUS).filter(chave => !Utils.ESTILO_STATUS[chave].soGestao || App.pode("gestao.visualizar")).map(chave => {
      const e = Utils.ESTILO_STATUS[chave];
      const fundo = e.hachura
        ? `repeating-linear-gradient(45deg, ${this.hexParaRgba(e.preenchimento, 0.3)} 0 3px, ${this.hexParaRgba(e.borda, 0.75)} 3px 4.5px)`
        : this.hexParaRgba(e.preenchimento, Math.min(1, e.opacidade + 0.15));
      const borda = `${Math.max(1, Math.round(e.peso))}px ${e.tracejado ? "dashed" : "solid"} ${e.borda}`;
      return `<span class="flex items-center gap-1.5"><span class="legenda-amostra" style="background:${fundo};border:${borda}"></span>${Utils.escapeHtml(e.rotulo)}</span>`;
    }).join("");
  },

  tamanhoRotuloPorZoom(zoom) {
    if (zoom >= 17) return 17;
    if (zoom >= 16) return 15;
    if (zoom >= 15) return 13;
    if (zoom >= 14) return 12;
    if (zoom >= 13) return 11;
    return 10;
  },

  /** Marcador de texto não interativo (número do território ou da quadra). */
  criarRotulo(lat, lng, texto, classe, pane) {
    return L.marker([lat, lng], {
      icon: L.divIcon({ className: "rotulo-mapa", html: `<span class="${classe}">${Utils.escapeHtml(texto)}</span>`, iconSize: [0, 0] }),
      interactive: false,
      keyboard: false,
      pane
    });
  },

  /**
   * Tamanho por zoom e visibilidade sem motor de colisão: o rótulo aparece quando o maior
   * círculo inscrito no polígono (em pixels) comporta o texto.
   * rotulos = [{ marker, lat, raioMetros, texto, escala?, sempre? }]
   */
  atualizarRotulos(map, rotulos) {
    if (!map) return;
    const zoom = map.getZoom();
    const tamanho = this.tamanhoRotuloPorZoom(zoom);
    const container = map.getContainer();
    container.dataset.z = String(Math.round(zoom));
    container.style.setProperty("--rotulo-px", `${tamanho}px`);

    for (const r of rotulos || []) {
      const el = r.marker.getElement();
      if (!el) continue;
      const metrosPorPixel = (156543.03392 * Math.cos((r.lat * Math.PI) / 180)) / Math.pow(2, zoom);
      const larguraTexto = String(r.texto).length * tamanho * (r.escala || 1.2) * 0.62;
      const visivel = r.sempre || zoom >= 17 || r.raioMetros / metrosPorPixel >= 0.5 * larguraTexto;
      el.classList.toggle("rotulo-oculto", !visivel);
    }
  },

  /** Pinos de prédios só aparecem de perto (e se a caixa "Exibir pinos" estiver marcada). */
  atualizarDetalhesPorZoom() {
    if (!this.map) return;
    const toggle = document.getElementById("toggle-map-predios");
    const mostrar = (!toggle || toggle.checked) && this.map.getZoom() >= this.ZOOM_MIN_DETALHES;
    if (mostrar && !this.map.hasLayer(this.prediosLayerGroup)) this.map.addLayer(this.prediosLayerGroup);
    if (!mostrar && this.map.hasLayer(this.prediosLayerGroup)) this.map.removeLayer(this.prediosLayerGroup);
  },

  /** Contorno duplo no território selecionado (popup aberto). */
  selecionarPoligono(poly, partes) {
    this.limparSelecao();
    this._contornoSelecao = L.polygon(partes, {
      fill: false, color: "#111827", weight: (poly.options.weight || 2) + 5, opacity: 0.85, interactive: false, lineJoin: "round"
    }).addTo(this.map);
    poly.bringToFront();
  },

  limparSelecao() {
    if (this._contornoSelecao) {
      this.map.removeLayer(this._contornoSelecao);
      this._contornoSelecao = null;
    }
  },

  /**
   * ==========================================================================
   * CASAS DO INTERIOR (pontos rurais) — spec 07, fase 2
   * ==========================================================================
   * Laranja = falta visitar; verde = visitada. Quem está com o cartão marca pelo popup.
   * Os endereços só chegam a quem está com o cartão (ou ADMIN); os demais veem a contagem.
   */
  COR_PONTO_PENDENTE: "#e8710a",
  COR_PONTO_VISITADO: "#146c2e",

  renderizarPontosRuraisModal(t) {
    if (!this.modalPontosRuraisLayer) return;
    this.modalPontosRuraisLayer.clearLayers();
    if (this._controlePontos) { this._controlePontos.remove(); this._controlePontos = null; }
    if (!t) return;
    const pontos = Array.isArray(t.pontosRurais) ? t.pontosRurais : [];
    const total = Number(t.totalPontosRurais) || pontos.length;
    if (!total) return;

    const podeMarcar = t.statusReal === "OCUPADO" && (t.emMinhaPosse || App.pode("progresso.alheio"));
    for (const p of pontos) {
      const visitado = Boolean(p.visitadoEm);
      const marcador = L.circleMarker([p.lat, p.lng], {
        renderer: this._rendererPontos,
        radius: Number(p.domicilios) > 1 ? 8 : 6.5,
        color: "#ffffff",
        weight: 2,
        fillColor: visitado ? this.COR_PONTO_VISITADO : this.COR_PONTO_PENDENTE,
        fillOpacity: 0.95
      });
      marcador.bindPopup(() => this.htmlPopupPonto(t, p, podeMarcar), { className: "popup-ponto", maxWidth: 260 });
      this.modalPontosRuraisLayer.addLayer(marcador);
    }

    const visitados = pontos.length ? pontos.filter(p => p.visitadoEm).length : (Number(t.pontosRuraisVisitados) || 0);
    const Controle = L.Control.extend({
      options: { position: "bottomright" },
      onAdd: () => {
        const el = L.DomUtil.create("div", "leaflet-bar controle-pontos");
        el.innerHTML = pontos.length
          ? `<span class="cp-item"><i class="cp-cor" style="background:${this.COR_PONTO_PENDENTE}"></i>Falta</span>
             <span class="cp-item"><i class="cp-cor" style="background:${this.COR_PONTO_VISITADO}"></i>Visitada</span>
             <b>🏠 ${visitados} de ${pontos.length} casas visitadas</b>`
          : `<b>🏠 ${visitados} de ${total} casas visitadas</b><span>Endereços visíveis para quem estiver com o cartão.</span>`;
        L.DomEvent.disableClickPropagation(el);
        return el;
      }
    });
    this._controlePontos = new Controle().addTo(this.modalMap);
  },

  htmlPopupPonto(t, p, podeMarcar) {
    const visitado = Boolean(p.visitadoEm);
    const dom = Number(p.domicilios) || 1;
    return `
      <div class="pp">
        <p class="pp-titulo">${Utils.escapeHtml(p.logradouro || "Casa do interior")}</p>
        <p class="pp-meta">${p.localidade ? Utils.escapeHtml(p.localidade) + " • " : ""}${dom} domicílio(s) neste ponto</p>
        <p class="pp-status ${visitado ? "ok" : ""}">${visitado ? `✓ Visitada em ${Utils.formatarDataBr(p.visitadoEm)}` : "Ainda não visitada"}</p>
        ${podeMarcar ? `<button type="button" data-acao="ponto-visitado" data-num="${Number(t.numero)}" data-id-ponto="${Utils.escapeHtml(p.idPonto)}"
            data-visitado="${!visitado}" class="pp-botao ${visitado ? "desfazer" : ""}">${visitado ? "Desfazer" : "Marcar como visitada"}</button>` : ""}
      </div>`;
  },

  ehRural(t) {
    return String((t && t.tipo) || "").trim().toLowerCase() === "rural";
  },

  /** Alterna o enquadramento entre a área urbana e todos os territórios (inclui rurais). */
  alternarVistaRurais() {
    if (!this.map) return;
    this._vendoRurais = !this._vendoRurais;
    this.enquadrarMapaGeral();
  },

  enquadrarMapaGeral() {
    const urbanos = this._limitesUrbanos && this._limitesUrbanos.isValid() ? this._limitesUrbanos : null;
    const todos = this._limitesTodos && this._limitesTodos.isValid() ? this._limitesTodos : null;
    const alvo = this._vendoRurais ? todos : (urbanos || todos);
    if (!alvo) return false;
    this.map.fitBounds(alvo, { padding: [20, 20] });
    const btn = document.getElementById("btn-mapa-rurais");
    if (btn) {
      btn.textContent = this._vendoRurais ? "Ver área urbana" : "Ver rurais";
      // Sem territórios rurais (ou só rurais) não há o que alternar
      btn.classList.toggle("hidden", !urbanos || !todos || urbanos.equals(todos));
    }
    return true;
  },

  /**
   * ==========================================================================
   * QUADRAS NUMERADAS (quadras.geojson, gerado por scripts/quadras/gerar-quadras.js)
   * Contornos e números nunca são interativos: o clique atravessa até o território/mapa.
   * ==========================================================================
   */
  carregarQuadrasGeo() {
    if (!this._quadrasGeoPromessa) {
      this._quadrasGeoPromessa = fetch(`quadras.geojson?v=${this.VERSAO_QUADRAS_GEO}`)
        .then(resposta => (resposta.ok ? resposta.json() : Promise.reject(new Error(`HTTP ${resposta.status}`))))
        .then(geo => {
          const indice = new Map();
          for (const f of geo.features || []) {
            const p = f.properties || {};
            const g = f.geometry || {};
            const poligonos = g.type === "Polygon" ? [g.coordinates] : (g.type === "MultiPolygon" ? g.coordinates : []);
            const partes = poligonos.map(pol => pol.map(anel => anel.map(c => [c[1], c[0]])));
            if (!partes.length) continue;
            const numero = Number(p.NUM_TERR);
            if (!indice.has(numero)) indice.set(numero, []);
            indice.get(numero).push({
              id: String(p.ID_QUADRA || ""),
              rotulo: String(p.ROTULO || p.NUM_QUADRA || ""),
              lat: Number(p.LABEL_LAT),
              lng: Number(p.LABEL_LNG),
              partes,
              raioMetros: null
            });
          }
          this._quadrasGeo = indice;
        })
        .catch(() => {
          // Sem o arquivo (ou offline sem cache) o mapa segue funcionando só com os territórios
          this._quadrasGeo = new Map();
        });
    }
    return this._quadrasGeoPromessa;
  },

  /** Preferência do mapa geral: exibir os números das quadras? Sem escolha salva, não. */
  lerPreferenciaNumerosQuadras() {
    try {
      return localStorage.getItem(this.CHAVE_NUMEROS_QUADRAS) === "1";
    } catch (e) {
      return false;
    }
  },

  /**
   * Desenha quadras (contorno fino tracejado + número) em um grupo de camadas.
   * comNumeros = false desenha só os contornos (mapa geral com a caixa desmarcada).
   */
  desenharQuadrasGeo(grupo, quadras, rotulos, comNumeros = true) {
    for (const q of quadras) {
      grupo.addLayer(L.polygon(q.partes, {
        pane: "quadrasGeo", interactive: false, fill: false,
        color: "#334155", weight: 0.8, opacity: 0.9, dashArray: "4 3"
      }));
      if (!comNumeros || !q.rotulo || !isFinite(q.lat) || !isFinite(q.lng)) continue;
      if (q.raioMetros === null) {
        const ponto = Geo.pontoRotuloLatLng(q.partes, 2);
        q.raioMetros = ponto ? ponto.raioMetros : 0;
      }
      const marker = this.criarRotulo(q.lat, q.lng, q.rotulo, "rotulo-quadra", "rotulosQuadras");
      grupo.addLayer(marker);
      rotulos.push({ marker, lat: q.lat, raioMetros: q.raioMetros, texto: q.rotulo, escala: 0.8 });
    }
  },

  /**
   * Mapa geral: só as quadras da área visível, e apenas de perto (zoom ≥ 15).
   * Os contornos sempre aparecem; os números, só com a caixa "Exibir números das quadras" marcada.
   */
  atualizarQuadrasGeoMapaGeral() {
    if (!this.map || !this.quadrasGeoLayer) return;
    this.quadrasGeoLayer.clearLayers();
    if (!this._quadrasGeo || this.map.getZoom() < this.ZOOM_MIN_DETALHES) return;
    const toggle = document.getElementById("toggle-map-quadras");
    const comNumeros = toggle ? toggle.checked : this.lerPreferenciaNumerosQuadras();

    const limites = this.map.getBounds().pad(0.15);
    const visiveis = [];
    for (const lista of this._quadrasGeo.values()) {
      for (const q of lista) if (limites.contains([q.lat, q.lng])) visiveis.push(q);
    }
    const rotulos = [];
    this.desenharQuadrasGeo(this.quadrasGeoLayer, visiveis, rotulos, comNumeros);
    this.atualizarRotulos(this.map, rotulos);
  },

  /** Mapa do cartão: todas as quadras do território aberto. */
  renderizarQuadrasGeoModal() {
    if (!this.modalQuadrasGeoLayer) return;
    const numero = this.territorioModalAtual;
    this.carregarQuadrasGeo().then(() => {
      if (numero !== this.territorioModalAtual) return;
      this.modalQuadrasGeoLayer.clearLayers();
      this._rotulosModal = this._rotulosModal.filter(r => !r.quadra);
      const rotulos = [];
      this.desenharQuadrasGeo(this.modalQuadrasGeoLayer, this._quadrasGeo.get(numero) || [], rotulos);
      rotulos.forEach(r => { r.quadra = true; });
      this._rotulosModal = this._rotulosModal.concat(rotulos);
      this.atualizarRotulos(this.modalMap, this._rotulosModal);
    });
  },

  /**
   * ==========================================================================
   * ESTRADAS RURAIS (vias-rurais.geojson, gerado por scripts/rurais/gerar-vias-rurais.js)
   * Dados públicos do OpenStreetMap, guardados pelo service worker: funcionam sem internet.
   * Desenhadas em canvas, sem interação (o clique atravessa até o mapa).
   * ==========================================================================
   */
  carregarViasRurais() {
    if (!this._viasRuraisPromessa) {
      this._viasRuraisPromessa = fetch(`vias-rurais.geojson?v=${this.VERSAO_QUADRAS_GEO}`)
        .then(resposta => (resposta.ok ? resposta.json() : Promise.reject(new Error(`HTTP ${resposta.status}`))))
        .then(geo => { this._viasRurais = this.indexarViasRurais(geo); })
        .catch(() => {
          // Sem o arquivo o cartão segue só com o fundo e o contorno; tenta de novo na próxima abertura
          this._viasRurais = new Map();
          this._viasRuraisPromessa = null;
        });
    }
    return this._viasRuraisPromessa || Promise.resolve();
  },

  /** Map(numeroTerritorio → [{ classe, nome, superficie, pontos: [[lat, lng], ...] }]) */
  indexarViasRurais(geo) {
    const indice = new Map();
    for (const f of (geo && geo.features) || []) {
      const p = f.properties || {};
      const g = f.geometry || {};
      if (g.type !== "LineString" || !Array.isArray(g.coordinates) || g.coordinates.length < 2) continue;
      const numero = Number(p.NUM_TERR);
      if (!indice.has(numero)) indice.set(numero, []);
      indice.get(numero).push({
        classe: String(p.h || ""),
        nome: String(p.n || ""),
        superficie: String(p.s || ""),
        pontos: g.coordinates.map(c => [c[1], c[0]])
      });
    }
    return indice;
  },

  /** Estilo da estrada: asfalto mais grosso; terra em marrom tracejado; carreador fino. */
  estiloVia(via) {
    const terra = /^(unpaved|dirt|earth|ground|gravel|fine_gravel|compacted|sand|grass|mud|pebblestone|rock)$/.test(via.superficie);
    const c = via.classe.replace(/_link$/, "");
    if (c === "motorway" || c === "trunk" || c === "primary") return { color: "#b45309", weight: 5, dashArray: null };
    if (c === "secondary" || c === "tertiary") return { color: terra ? "#92400e" : "#d97706", weight: 4, dashArray: terra ? "8 5" : null };
    if (c === "track") return { color: "#92400e", weight: 1.8, dashArray: "3 4" };
    if (c === "service") return { color: terra ? "#a16207" : "#78716c", weight: 2, dashArray: terra ? "5 4" : null };
    // unclassified (estradas municipais), residential, road, living_street
    return { color: terra ? "#92400e" : "#57534e", weight: 3, dashArray: terra ? "7 5" : null };
  },

  /** Desenha as estradas do território aberto no cartão — só para território rural (tipo da BASE). */
  renderizarViasRuraisModal(t) {
    if (!this.modalViasRuraisLayer) return;
    this.modalViasRuraisLayer.clearLayers();
    if (!t || !this.ehRural(t)) return;
    const numero = Number(t.numero);
    this.carregarViasRurais().then(() => {
      if (numero !== this.territorioModalAtual || !this._viasRurais) return;
      this.modalViasRuraisLayer.clearLayers();
      const vias = this._viasRurais.get(numero) || [];
      const base = { renderer: this._rendererVias, interactive: false, lineCap: "round", lineJoin: "round" };
      // Contorno claro por baixo: contraste sobre o satélite e sobre o fundo neutro
      for (const via of vias) {
        const e = this.estiloVia(via);
        this.modalViasRuraisLayer.addLayer(L.polyline(via.pontos, Object.assign({}, base, { color: "#ffffff", weight: e.weight + 2.5, opacity: 0.8 })));
      }
      for (const via of vias) {
        this.modalViasRuraisLayer.addLayer(L.polyline(via.pontos, Object.assign({}, base, this.estiloVia(via), { opacity: 0.95 })));
      }
      // Nome de cada estrada uma vez, no meio do trecho mais longo com aquele nome
      const maisLongo = new Map();
      for (const via of vias) {
        if (!via.nome) continue;
        const atual = maisLongo.get(via.nome);
        if (!atual || via.pontos.length > atual.pontos.length) maisLongo.set(via.nome, via);
      }
      for (const via of maisLongo.values()) {
        const meio = via.pontos[Math.floor(via.pontos.length / 2)];
        this.modalViasRuraisLayer.addLayer(this.criarRotulo(meio[0], meio[1], via.nome, "rotulo-via", "rotulosQuadras"));
      }
      this.atualizarNomesVias(this.modalMap);
    });
  },

  /** Nomes das estradas só de perto (classe no contêiner; o CSS esconde abaixo do zoom mínimo). */
  atualizarNomesVias(map) {
    if (!map) return;
    map.getContainer().classList.toggle("vias-nomes-visiveis", map.getZoom() >= this.ZOOM_MIN_NOMES_VIAS);
  },

  /** Minimapa de localização no canto do mapa do cartão (some em telas estreitas, via CSS). */
  criarMinimapa(mapaPai) {
    const self = this;
    const Controle = L.Control.extend({
      options: { position: "bottomright" },
      onAdd() {
        const el = L.DomUtil.create("div", "minimapa-cartao");
        el.setAttribute("aria-hidden", "true");
        L.DomEvent.disableClickPropagation(el);
        L.DomEvent.disableScrollPropagation(el);
        self.minimapa = L.map(el, {
          zoomControl: false, attributionControl: false, dragging: false, touchZoom: false, doubleClickZoom: false,
          scrollWheelZoom: false, boxZoom: false, keyboard: false, zoomSnap: 0.25
        });
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, className: "ladrilhos-claros" }).addTo(self.minimapa);
        self.minimapaLayer = L.layerGroup().addTo(self.minimapa);
        self.minimapa.setView([-26.2265, -52.6725], 11);
        return el;
      }
    });
    new Controle().addTo(mapaPai);
  },

  /**
   * Geometria já convertida de cada território (partes do Leaflet, limites e ponto de rótulo),
   * recalculada só quando a lista de territórios muda.
   */
  obterGeometrias() {
    if (this._geometriasRef !== App.territorios) {
      const itens = new Map();
      const urbanos = L.latLngBounds([]);
      const todos = L.latLngBounds([]);
      for (const t of App.territorios || []) {
        if (!t.wkt) continue;
        const partes = Utils.parseWktParaPoligonosLeaflet(t.wkt);
        if (!partes.length) continue;
        const limites = L.latLngBounds([]);
        partes.forEach(parte => limites.extend(parte[0]));
        todos.extend(limites);
        if (!this.ehRural(t)) urbanos.extend(limites);
        itens.set(Number(t.numero), { partes, limites, rotulo: Geo.pontoRotuloLatLng(partes) });
      }
      this._geometrias = { itens, urbanos, todos };
      this._geometriasRef = App.territorios;
    }
    return this._geometrias;
  },

  obterClassePinoPredio(p) {
    if (p.trabalhadoNesteCiclo || p.ultimaDataConclusao) return "pin-done";
    if (p.tipoInterfone === "SEM_INTERFONE") return "pin-red";
    const tags = Array.isArray(p.tagsLogisticas) ? p.tagsLogisticas : [];
    if (tags.includes("EXIGE_CODIGO") || tags.includes("COM_CAMERA") || tags.includes("ACESSO_RESTRITO") || tags.includes("SEM_ACESSO")) {
      return "pin-amber";
    }
    return "pin-green";
  },

  /**
   * Evita que prédios muito próximos fiquem exatamente sobrepostos no mapa
   */
  deslocarCoordenadasProximas(predios) {
    const vistos = {};
    return (predios || []).map((p, idx) => {
      const latBase = Number(p.latitude || 0);
      const lngBase = Number(p.longitude || 0);
      const chave = `${latBase.toFixed(4)}_${lngBase.toFixed(4)}`;
      const ordem = vistos[chave] || 0;
      vistos[chave] = ordem + 1;

      if (ordem === 0) {
        return { predio: p, ordemPin: idx + 1, lat: latBase, lng: lngBase };
      }
      const angulo = (ordem * 137.5 * Math.PI) / 180;
      const raioGraus = 0.000055 * Math.ceil(ordem / 2);
      return {
        predio: p,
        ordemPin: idx + 1,
        lat: latBase + Math.sin(angulo) * raioGraus,
        lng: lngBase + Math.cos(angulo) * raioGraus
      };
    });
  },

  renderizarPoligonos(territorios) {
    if (!this.inicializado) this.inicializar();
    this.limparSelecao();
    this.layerGroup.clearLayers();
    this.prediosLayerGroup.clearLayers();
    this.rotulosLayerGroup.clearLayers();
    this._rotulosTerritorios = [];

    let temPoligonos = false;
    const filaTop5Set = new Set((App.obterFilaCincoDisponiveis ? App.obterFilaCincoDisponiveis() : []).map(x => Number(x.numero)));
    const geometrias = this.obterGeometrias();
    const temPonteiro = !window.matchMedia || window.matchMedia("(hover: hover)").matches;

    for (const t of territorios) {
      const geometria = geometrias.itens.get(Number(t.numero));
      if (!geometria) continue;
      const aneis = geometria.partes;

      temPoligonos = true;
      const naFilaTop5 = filaTop5Set.has(Number(t.numero));
      const estilo = this.estiloPoligono(Utils.chaveStatus(t, naFilaTop5));
      const cor = { borda: estilo.color, preenchimento: estilo.fillColor };
      const qtdPredios = Array.isArray(t.predios) ? t.predios.length : 0;

      const poly = L.polygon(aneis, estilo);

      // Realce ao passar o mouse (em telas de toque só existe a seleção, pelo popup)
      if (temPonteiro) {
        poly.on("mouseover", () => {
          poly.setStyle({ weight: estilo.weight + 1.5, fillOpacity: Math.min(0.6, estilo.fillOpacity + 0.15) });
        });
        poly.on("mouseout", () => poly.setStyle({ weight: estilo.weight, fillOpacity: estilo.fillOpacity }));
      }
      poly.on("popupopen", () => this.selecionarPoligono(poly, aneis));

      // Número do território no polo de inacessibilidade da maior parte (sempre dentro do polígono)
      if (geometria.rotulo) {
        const texto = String(Number(t.numero));
        const marker = this.criarRotulo(geometria.rotulo.lat, geometria.rotulo.lng, texto, "rotulo-territorio", "rotulosTerritorios");
        this.rotulosLayerGroup.addLayer(marker);
        this._rotulosTerritorios.push({ marker, lat: geometria.rotulo.lat, raioMetros: geometria.rotulo.raioMetros, texto });
      }

      const dirInfo = t.statusReal === "OCUPADO"
        ? `<p class="text-xs text-[#b06000] font-medium mt-1">👤 Com: <strong>${Utils.escapeHtml(t.dirigente || "Dirigente")}</strong></p>`
        : `<p class="text-xs text-slate-500 mt-1">Última conclusão: ${Utils.formatarDataBr(t.ultimaData)}</p>`;

      const prediosInfo = qtdPredios > 0
        ? `<p class="text-xs text-[#0b57d0] font-semibold mt-1">🏢 ${qtdPredios} prédio(s) mapeado(s) neste cartão</p>`
        : `<p class="text-[11px] text-slate-400 mt-1">Sem prédios verticais mapeados</p>`;

      let botaoAcaoHtml = `
        <button data-acao="abrir-mapa" data-num="${Number(t.numero)}" class="mt-2.5 w-full py-1.5 px-3 bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold text-xs rounded-full transition">
          Ver Cartão e Prédios (${qtdPredios})
        </button>`;

      if (App.podeSolicitarTerritorio(t)) {
        botaoAcaoHtml += `<button data-acao="solicitar" data-num="${Number(t.numero)}" class="mt-1.5 w-full py-1.5 px-3 bg-[#0b57d0] hover:bg-[#0842a0] text-white font-semibold text-xs rounded-full transition">Solicitar Território ${Number(t.numero)}</button>`;
      } else if (t.statusReal === "OCUPADO" && (t.emMinhaPosse || App.pode("territorios.devolverAlheio"))) {
        botaoAcaoHtml += `<button data-acao="devolver" data-num="${Number(t.numero)}" class="mt-1.5 w-full py-1.5 px-3 bg-[#0b57d0] hover:bg-[#0842a0] text-white font-semibold text-xs rounded-full transition">Devolver Território ${Number(t.numero)}</button>`;
      }

      const popupHtml = `
        <div class="min-w-[210px] p-1">
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm font-bold text-slate-900">Território ${Number(t.numero)}</span>
            <span class="px-2 py-0.5 text-[10px] font-bold rounded-full" style="background:${this.hexParaRgba(cor.preenchimento, 0.14)};color:${cor.borda};border:1px solid ${this.hexParaRgba(cor.borda, 0.35)}">${Utils.escapeHtml(naFilaTop5 ? "NA FILA" : t.statusReal)}</span>
          </div>
          <p class="text-xs text-slate-600 font-medium mt-0.5">${Utils.escapeHtml(t.bairro)} (${Utils.escapeHtml(t.tipo)})</p>
          ${dirInfo}
          ${prediosInfo}
          ${botaoAcaoHtml}
        </div>
      `;

      poly.bindPopup(popupHtml);
      this.layerGroup.addLayer(poly);

      // Pinos dos prédios no Mapa Geral
      if (qtdPredios > 0) {
        const pontos = this.deslocarCoordenadasProximas(t.predios);
        for (const item of pontos) {
          const p = item.predio;
          if (!item.lat || !item.lng) continue;
          const pinClass = this.obterClassePinoPredio(p);
          const icon = L.divIcon({
            className: "",
            html: `<div class="predio-pin-marker ${pinClass}" title="${Utils.escapeHtml(p.nomeEdificio)}">${item.ordemPin}</div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
          });
          const marker = L.marker([item.lat, item.lng], { icon });
          const { interfoneBadge, tagsBadges } = Utils.obterBadgesPredio(p);
          marker.bindPopup(`
            <div class="min-w-[200px] p-1">
              <p class="text-[10px] font-bold uppercase text-[#0b57d0]">Território ${Number(t.numero)} • Prédio #${item.ordemPin}</p>
              <p class="text-xs font-bold text-slate-900 mt-0.5">${Utils.escapeHtml(p.nomeEdificio)}</p>
              <p class="text-[11px] text-slate-600">${Utils.escapeHtml(p.endereco)}</p>
              <div class="mt-1.5 flex flex-wrap gap-1">
                <span class="px-2 py-0.5 text-[10px] font-semibold rounded-full ${interfoneBadge.cls}">${interfoneBadge.texto}</span>
                ${tagsBadges.map(b => `<span class="px-2 py-0.5 text-[10px] font-medium rounded-full ${b.cls}">${b.texto}</span>`).join("")}
              </div>
              <button data-acao="abrir-mapa" data-num="${Number(t.numero)}" data-id-predio="${Utils.escapeHtml(p.idPredio)}" class="mt-2 w-full py-1 px-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold text-[11px] rounded-full transition">
                Abrir Guia do Cartão ${Number(t.numero)}
              </button>
            </div>
          `);
          this.prediosLayerGroup.addLayer(marker);
        }
      }
    }

    this._limitesUrbanos = geometrias.urbanos;
    this._limitesTodos = geometrias.todos;
    this.atualizarRotulos(this.map, this._rotulosTerritorios);
    this.atualizarDetalhesPorZoom();

    if (temPoligonos) {
      setTimeout(() => {
        this.map.invalidateSize();
        // Enquadra só na primeira renderização visível (área urbana); depois preserva a vista do usuário
        const container = this.map.getContainer();
        if (this._enquadrado || !container.offsetWidth || !container.offsetHeight) return;
        try {
          this._enquadrado = this.enquadrarMapaGeral();
        } catch (e) {}
      }, 200);
    }
  },

  /**
   * Abre modal exibindo o mapa do território + pinos numerados dos prédios + guia de apoio ao dirigente
   */
  abrirModalTerritorio(numero, idPredioDestaque) {
    const t = App.territorios.find(item => Number(item.numero) === Number(numero));
    if (!t || !t.wkt) {
      Utils.mostrarToast("Geometria do mapa não disponível para este território.", "aviso");
      return;
    }

    const aneis = Utils.parseWktParaPoligonosLeaflet(t.wkt);
    if (!aneis.length) {
      Utils.mostrarToast("Polígono inválido para este território.", "erro");
      return;
    }

    // Uma edição de quadras em andamento sobrevive à re-renderização do mesmo cartão (ex.: sincronização)
    if (this.quadrasEdicao && this.quadrasEdicao.numero !== Number(t.numero)) {
      this.quadrasEdicao = null;
    }

    // Outro cartão volta para a aba Cartão; redesenho do mesmo cartão (ex.: marcar prédio) mantém a aba
    if (this.territorioModalAtual !== Number(t.numero)) this.abaModal = "cartao";
    this.territorioModalAtual = Number(t.numero);
    const modal = document.getElementById("modal-mapa-territorio");
    if (!modal) return;
    this.definirAbaModal(this.abaModal, { semAjuste: true });

    document.getElementById("modal-mapa-tipo").textContent = t.tipo || "Cidade";
    document.getElementById("modal-mapa-titulo").textContent = `Território ${Number(t.numero)} — ${t.bairro}`;

    const filaTop5Set = new Set((App.obterFilaCincoDisponiveis ? App.obterFilaCincoDisponiveis() : []).map(x => Number(x.numero)));
    const { badgeClass, label } = Utils.obterEstiloStatus(t, filaTop5Set.has(Number(t.numero)));
    const statusBadge = document.getElementById("modal-mapa-status");
    statusBadge.className = `px-2.5 py-0.5 text-[10px] font-bold rounded-full border ${badgeClass}`;
    statusBadge.textContent = label;

    const predios = Array.isArray(t.predios) ? t.predios : [];
    const contAbaPredios = document.getElementById("modal-aba-predios-count");
    if (contAbaPredios) contAbaPredios.textContent = predios.length ? String(predios.length) : "";
    const contAbaQuadras = document.getElementById("modal-aba-quadras-count");
    if (contAbaQuadras) {
      const nQuadras = Array.isArray(t.quadrasTrabalhadas) ? t.quadrasTrabalhadas.length : 0;
      contAbaQuadras.textContent = nQuadras ? `${nQuadras} ✓` : "";
    }
    const countBadge = document.getElementById("modal-mapa-predios-count");
    if (countBadge) {
      if (predios.length > 0) {
        const concluidos = predios.filter(p => p.trabalhadoNesteCiclo || p.ultimaDataConclusao).length;
        countBadge.textContent = `🏢 ${predios.length} prédio(s) • ${concluidos} trabalhado(s)`;
        countBadge.classList.remove("hidden");
      } else {
        countBadge.classList.add("hidden");
      }
    }

    const subtituloEl = document.getElementById("modal-mapa-subtitulo");
    if (t.statusReal === "OCUPADO") {
      subtituloEl.textContent = `👤 Em posse de: ${t.dirigente || "Dirigente"} desde ${Utils.formatarDataBr(t.ultimaData)}`;
    } else {
      subtituloEl.textContent = `📅 Última conclusão registrada: ${Utils.formatarDataBr(t.ultimaData)}`;
    }

    // Botão de ação no rodapé da modal
    const acoesEl = document.getElementById("modal-mapa-acoes");
    if (App.podeSolicitarTerritorio(t)) {
      acoesEl.innerHTML = `
        <button data-acao="modal-solicitar" data-num="${Number(t.numero)}" class="m3-btn-filled text-xs">
          Solicitar Território ${Number(t.numero)}
        </button>`;
    } else if (t.statusReal === "OCUPADO" && (t.emMinhaPosse || App.pode("territorios.devolverAlheio"))) {
      acoesEl.innerHTML = `
        <button data-acao="modal-devolver" data-num="${Number(t.numero)}" class="m3-btn-filled text-xs">
          Devolver Território ${Number(t.numero)}
        </button>`;
    } else if (t.statusReal === "INATIVO") {
      const motivo = t.inativacao ? Utils.rotuloMotivoInativacao(t.inativacao.motivo) : "";
      acoesEl.innerHTML = `<span class="text-xs text-slate-500">🚫 Inativo${t.inativacao && t.inativacao.em ? " desde " + Utils.formatarDataBr(t.inativacao.em) : ""}${motivo ? " — " + Utils.escapeHtml(motivo) : ""}.</span>`;
    } else if (t.statusReal === "RECENTE") {
      acoesEl.innerHTML = `<span class="text-xs text-slate-500">⏳ Em período de descanso de 120 dias após conclusão.</span>`;
    } else {
      acoesEl.innerHTML = `<span class="text-xs text-slate-500">Consulte os prédios e limites deste cartão no mapa acima.</span>`;
    }
    // Spec 03: ADMIN inativa / reativa pelo cartão
    if (App.pode("territorios.inativar")) {
      acoesEl.innerHTML = `<div class="flex flex-wrap items-center gap-2">${acoesEl.innerHTML}${t.statusReal === "INATIVO"
        ? `<button data-acao="reativar-territorio" data-num="${Number(t.numero)}" class="m3-btn-tonal text-xs">Reativar</button>`
        : `<button data-acao="inativar-territorio" data-num="${Number(t.numero)}" class="px-3 py-1.5 rounded-full text-xs font-semibold text-[#b3261e] hover:bg-[#fce8e6] transition">Inativar</button>`}</div>`;
    }

    modal.classList.remove("hidden");
    modal.classList.add("flex");

    this.inicializarModal();
    this.modalLayerGroup.clearLayers();
    this.modalMarkersPorId = {};

    // Entorno esmaecido (máscara invertida) + vizinhos em traço fino com o número
    this.modalContextoLayer.clearLayers();
    this._rotulosModal = [];
    this.desenharContextoTerritorio(this.modalContextoLayer, t, aneis, this._rotulosModal, { opacidadeMascara: 0.35 });
    // Contorno branco por baixo do traço do território: contraste garantido também sobre o satélite
    this.modalContextoLayer.addLayer(L.polygon(aneis, { fill: false, color: "#ffffff", weight: 7, opacity: 0.9, lineJoin: "round", interactive: false }));

    // No cartão o preenchimento é leve para a base (ruas e nomes) continuar legível
    const estilo = this.estiloPoligono(Utils.chaveStatus(t, filaTop5Set.has(Number(t.numero))));
    const poly = L.polygon(aneis, Object.assign({}, estilo, {
      weight: 3,
      dashArray: null,
      className: "",
      fillOpacity: Math.min(estilo.fillOpacity, 0.12)
    }));

    this.modalLayerGroup.addLayer(poly);
    this.modalLimitesTerritorio = poly.getBounds().pad(0.08);

    // Plotar pinos numerados dos prédios do cartão
    const pontos = this.deslocarCoordenadasProximas(predios);
    for (const item of pontos) {
      const p = item.predio;
      if (!item.lat || !item.lng) continue;
      const pinClass = this.obterClassePinoPredio(p);
      const icon = L.divIcon({
        className: "",
        html: `<div class="predio-pin-marker ${pinClass}">${item.ordemPin}</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });

      const marker = L.marker([item.lat, item.lng], { icon });
      const { interfoneBadge, tagsBadges, metaStr } = Utils.obterBadgesPredio(p);
      marker.bindPopup(`
        <div class="min-w-[210px] p-1">
          <div class="flex items-center justify-between gap-2">
            <span class="text-[11px] font-bold text-[#0b57d0]">Prédio #${item.ordemPin}</span>
            <span class="px-2 py-0.5 text-[10px] font-semibold rounded-full ${interfoneBadge.cls}">${interfoneBadge.texto}</span>
          </div>
          <p class="text-xs font-bold text-slate-900 mt-1">${Utils.escapeHtml(p.nomeEdificio)}</p>
          <p class="text-[11px] text-slate-700 font-medium">${Utils.escapeHtml(p.endereco)}</p>
          ${metaStr ? `<p class="text-[11px] text-slate-500 mt-0.5">${Utils.escapeHtml(metaStr)}</p>` : ""}
          ${p.referenciaComercial ? `<p class="text-[11px] text-slate-600 mt-0.5">📍 ${Utils.escapeHtml(p.referenciaComercial)}</p>` : ""}
          ${tagsBadges.length ? `<div class="mt-1.5 flex flex-wrap gap-1">${tagsBadges.map(b => `<span class="px-2 py-0.5 text-[10px] font-medium rounded-full ${b.cls}">${b.texto}</span>`).join("")}</div>` : ""}
          ${this.htmlAcoesBalaoPredio(t, p)}
        </div>
      `);

      this.modalLayerGroup.addLayer(marker);
      this.modalMarkersPorId[p.idPredio] = { marker, lat: item.lat, lng: item.lng };
    }

    this._pontosModal = pontos;
    this.renderizarListaPrediosModal(t, pontos);
    this.renderizarQuadrasModal();
    this.renderizarQuadrasGeoModal();
    this.renderizarViasRuraisModal(t);
    this.renderizarPontosRuraisModal(t);
    this.atualizarRotulos(this.modalMap, this._rotulosModal);


    const limitesCartao = poly.getBounds();
    clearTimeout(this._modalTimer);
    this._modalTimer = setTimeout(() => {
      this.modalMap.invalidateSize();
      try {
        if (idPredioDestaque && this.modalMarkersPorId[idPredioDestaque] && this.abaModal !== "predios") {
          this.focarPredioNoModal(idPredioDestaque);
        } else if (this._modalEnquadradoPara !== Number(t.numero)) {
          // Reabrir o mesmo cartão (ex.: sincronização) não desfaz o zoom/posição do usuário
          this.modalMap.fitBounds(limitesCartao, { maxZoom: 18, padding: [16, 16] });
        }
        this._modalEnquadradoPara = Number(t.numero);
        this.atualizarMinimapa(aneis, limitesCartao);
      } catch (e) {}
    }, 150);
  },

  /**
   * Máscara invertida (escurece tudo fora do território) e territórios vizinhos em traço fino,
   * com o número de cada um. Nada aqui é interativo.
   */
  desenharContextoTerritorio(grupo, t, partes, rotulos, opcoes) {
    const op = opcoes || {};
    const mundo = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
    grupo.addLayer(L.polygon([mundo].concat(partes.map(parte => parte[0])), {
      stroke: false, fillColor: op.corMascara || "#0f172a", fillOpacity: op.opacidadeMascara, interactive: false
    }));

    const geometrias = this.obterGeometrias();
    const atual = geometrias.itens.get(Number(t.numero));
    if (!atual) return;
    const alcance = atual.limites.pad(0.6);
    for (const [numero, g] of geometrias.itens) {
      if (numero === Number(t.numero) || !alcance.intersects(g.limites)) continue;
      grupo.addLayer(L.polygon(g.partes, {
        fill: false, color: op.corVizinhos || "#475569", weight: 1, opacity: 0.8, dashArray: "2 4", interactive: false
      }));
      if (g.rotulo && alcance.contains([g.rotulo.lat, g.rotulo.lng])) {
        const marker = this.criarRotulo(g.rotulo.lat, g.rotulo.lng, String(numero), "rotulo-vizinho", "rotulosQuadras");
        grupo.addLayer(marker);
        rotulos.push({ marker, lat: g.rotulo.lat, raioMetros: g.rotulo.raioMetros, texto: String(numero) });
      }
    }
  },

  atualizarMinimapa(partes, limitesCartao) {
    if (!this.minimapa) return;
    const geometrias = this.obterGeometrias();
    this.minimapaLayer.clearLayers();
    const contexto = L.latLngBounds(limitesCartao.getSouthWest(), limitesCartao.getNorthEast());
    if (geometrias.urbanos.isValid()) contexto.extend(geometrias.urbanos);
    this.minimapaLayer.addLayer(L.polygon(partes, { color: "#b91c1c", weight: 2, fillColor: "#ef4444", fillOpacity: 0.6, interactive: false }));
    // Território pequeno demais para aparecer no minimapa ganha um ponto de destaque
    this.minimapaLayer.addLayer(L.circleMarker(limitesCartao.getCenter(), { radius: 4, color: "#b91c1c", weight: 2, fillColor: "#ef4444", fillOpacity: 0.9, interactive: false }));
    this.minimapa.invalidateSize();
    this.minimapa.fitBounds(contexto, { padding: [6, 6] });
  },

  renderizarListaPrediosModal(t, pontosNumerados) {
    const listaEl = document.getElementById("modal-predios-lista");
    const resumoEl = document.getElementById("modal-predios-resumo");
    if (!listaEl) return;

    const predios = Array.isArray(t.predios) ? t.predios : [];
    if (!predios.length) {
      if (resumoEl) resumoEl.textContent = "Este cartão não possui edifícios verticais cadastrados.";
      listaEl.innerHTML = `
        <div class="p-6 text-center text-xs text-slate-500">
          Nenhum prédio mapeado dentro dos limites do Território ${Number(t.numero)}.
        </div>`;
      return;
    }

    const concluidos = predios.filter(p => p.trabalhadoNesteCiclo || p.ultimaDataConclusao).length;
    if (resumoEl) {
      resumoEl.textContent = `${predios.length} prédio(s) no cartão • ${concluidos} marcado(s) como trabalhado(s)`;
    }

    const podeMarcarPredio = t.statusReal === "OCUPADO" && (t.emMinhaPosse || App.pode("progresso.alheio"));

    listaEl.innerHTML = pontosNumerados.map(item => {
      const p = item.predio;
      const concluido = Boolean(p.trabalhadoNesteCiclo || p.ultimaDataConclusao);
      const { interfoneBadge, tagsBadges, metaStr } = Utils.obterBadgesPredio(p);
      const pinClass = this.obterClassePinoPredio(p);

      const btnMarcarHtml = podeMarcarPredio
        ? `<button type="button" data-acao="alternar-predio" data-num="${Number(t.numero)}" data-id-predio="${Utils.escapeHtml(p.idPredio)}" data-trabalhado="${!concluido}" class="mt-2.5 w-full py-1.5 px-3 rounded-full text-[11px] font-semibold transition flex items-center justify-center gap-1.5 ${concluido ? "bg-[#e6f4ea] text-[#146c2e] border border-[#a8dab5]" : "bg-slate-100 hover:bg-[#d3e3fd] text-slate-700 hover:text-[#041e49]"}">
            <span>${concluido ? `✓ Trabalhado (${Utils.formatarDataBr(p.ultimaDataConclusao)}) — Desfazer` : "✓ Marcar Prédio como Trabalhado"}</span>
          </button>`
        : (concluido
          ? `<p class="mt-2 text-[11px] font-semibold text-[#146c2e]">✓ Trabalhado neste ciclo (${Utils.formatarDataBr(p.ultimaDataConclusao)})</p>`
          : "");

      const aptosHtml = this.criarHtmlApartamentos(t, p, podeMarcarPredio);

      return `
        <div id="card-predio-${Utils.escapeHtml(p.idPredio)}" class="scroll-mt-3 p-3 rounded-2xl border ${concluido ? "bg-[#f4fbf6] border-[#a8dab5]" : "bg-white border-slate-200"} transition">
          <div class="flex items-start justify-between gap-2">
            <div class="flex items-start gap-2.5 min-w-0">
              <span class="predio-pin-marker ${pinClass} shrink-0 mt-0.5">${item.ordemPin}</span>
              <div class="min-w-0">
                <h5 class="text-xs font-bold text-slate-900 leading-snug truncate">${Utils.escapeHtml(p.nomeEdificio)}</h5>
                <p class="text-[11px] font-medium text-slate-600 mt-0.5">${Utils.escapeHtml(p.endereco)}</p>
                ${metaStr ? `<p class="text-[11px] text-slate-500 mt-0.5">${Utils.escapeHtml(metaStr)}</p>` : ""}
                ${p.referenciaComercial ? `<p class="text-[11px] text-slate-500 mt-0.5">📍 ${Utils.escapeHtml(p.referenciaComercial)}</p>` : ""}
              </div>
            </div>
            ${item.lat && item.lng ? `<button type="button" data-acao="focar-predio" data-id-predio="${Utils.escapeHtml(p.idPredio)}" class="shrink-0 px-2 py-1 rounded-full text-[11px] font-semibold text-[#0b57d0] hover:bg-[#e8f0fe]">🗺️ Ver no mapa</button>` : ""}
          </div>

          <div class="mt-2 flex flex-wrap gap-1">
            <span class="px-2 py-0.5 text-[10px] font-semibold rounded-full ${interfoneBadge.cls}">${interfoneBadge.texto}</span>
            ${tagsBadges.map(b => `<span class="px-2 py-0.5 text-[10px] font-medium rounded-full ${b.cls}">${b.texto}</span>`).join("")}
          </div>

          ${aptosHtml}
          ${btnMarcarHtml}
        </div>
      `;
    }).join("");

    // Enter no campo de apartamentos equivale ao botão "Adicionar" (ligado uma única vez)
    if (!listaEl.dataset.enterAptos) {
      listaEl.dataset.enterAptos = "1";
      listaEl.addEventListener("keydown", evento => {
        if (evento.key !== "Enter" || !(evento.target instanceof HTMLInputElement) || !evento.target.dataset.aptoInput) return;
        evento.preventDefault();
        App.acaoAdicionarApartamentos(evento.target.dataset.aptoInput, this.territorioModalAtual);
      });
    }
  },

  /**
   * Bloco "apartamentos já trabalhados" de um prédio. O histórico acompanha o prédio entre
   * devoluções e só é zerado quando todos os prédios do cartão forem concluídos.
   */
  criarHtmlApartamentos(t, p, podeEditar) {
    const aptos = Array.isArray(p.aptosTrabalhados) ? p.aptosTrabalhados : [];
    if (!podeEditar && !aptos.length) return "";

    const idPredio = Utils.escapeHtml(p.idPredio);
    const total = Number(p.apartamentos) > 0 ? Number(p.apartamentos) : 0;
    const contagem = total ? `${aptos.length} de ${total}` : `${aptos.length}`;

    const chips = aptos.map(a => podeEditar
      ? `<button type="button" data-acao="remover-apto" data-num="${Number(t.numero)}" data-id-predio="${idPredio}" data-apto="${Utils.escapeHtml(a)}" title="Remover apartamento ${Utils.escapeHtml(a)}" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#e6f4ea] text-[#146c2e] border border-[#a8dab5] hover:bg-[#fce8e6] hover:text-[#b3261e] hover:border-[#f2b8b5] transition">${Utils.escapeHtml(a)} <span aria-hidden="true">×</span></button>`
      : `<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#e6f4ea] text-[#146c2e] border border-[#a8dab5]">${Utils.escapeHtml(a)}</span>`
    ).join("");

    const formHtml = podeEditar
      ? `<div class="mt-2 flex items-center gap-1.5">
           <input type="text" data-apto-input="${idPredio}" inputmode="text" autocomplete="off" maxlength="120" placeholder="Ex.: 101, 102, 201" aria-label="Apartamentos trabalhados em ${Utils.escapeHtml(p.nomeEdificio)}" class="flex-1 min-w-0 px-3 py-1.5 rounded-full border border-slate-300 bg-white text-[11px] text-slate-800 focus:outline-none focus:border-[#0b57d0]" />
           <button type="button" data-acao="adicionar-aptos" data-num="${Number(t.numero)}" data-id-predio="${idPredio}" class="shrink-0 px-3 py-1.5 rounded-full bg-[#d3e3fd] hover:bg-[#c2d7fc] text-[#041e49] text-[11px] font-semibold transition">Adicionar</button>
         </div>
         <p class="mp-erro" data-apto-erro="${idPredio}" role="alert" hidden></p>`
      : "";

    return `
      <div data-acao="bloco-aptos" data-escopo-aptos class="mt-2.5 p-2.5 rounded-xl bg-slate-50 border border-slate-200/90 cursor-default">
        <p class="text-[11px] font-bold text-slate-700">🚪 Apartamentos já trabalhados <span class="font-semibold text-slate-500">(${contagem})</span></p>
        ${aptos.length
          ? `<div class="mt-1.5 flex flex-wrap gap-1">${chips}</div>`
          : `<p class="mt-1 text-[11px] text-slate-500">Nenhum apartamento registrado ainda.</p>`}
        ${formHtml}
      </div>`;
  },

  /**
   * Re-renderiza apenas a lista de prédios (sem mexer no enquadramento do mapa) após registrar apartamentos
   */
  atualizarListaPrediosModal(idPredioFoco) {
    const t = App.territorios.find(item => Number(item.numero) === this.territorioModalAtual);
    if (!t) return;
    this.renderizarListaPrediosModal(t, this._pontosModal);
    if (idPredioFoco) {
      const campo = Array.from(document.querySelectorAll("#modal-predios-lista input[data-apto-input]"))
        .find(el => el.dataset.aptoInput === idPredioFoco);
      if (campo) campo.focus({ preventScroll: true });
    }
  },

  /**
   * ==========================================================================
   * QUADRAS TRABALHADAS: alfinetes que o dirigente coloca sobre as quadras já feitas.
   * Valem apenas enquanto o cartão está em posse (são apagados na devolução).
   * ==========================================================================
   */
  podeEditarQuadras(t) {
    return Boolean(t && t.statusReal === "OCUPADO" && (t.emMinhaPosse || App.pode("progresso.alheio")));
  },

  renderizarQuadrasModal() {
    const barra = document.getElementById("modal-quadras-barra");
    const t = App.territorios.find(item => Number(item.numero) === this.territorioModalAtual);
    if (!t || !this.quadrasLayerGroup) return;

    const editando = Boolean(this.quadrasEdicao);
    const pinos = editando ? this.quadrasEdicao.pinos : (Array.isArray(t.quadrasTrabalhadas) ? t.quadrasTrabalhadas : []);

    this.quadrasLayerGroup.clearLayers();
    pinos.forEach((p, idx) => {
      const icon = L.divIcon({
        className: "",
        html: `<div class="quadra-pin-marker ${editando ? "quadra-pin-editando" : ""}"><span>✓</span></div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 31]
      });
      const marker = L.marker([p.lat, p.lng], { icon, zIndexOffset: 500, keyboard: false });
      marker.bindTooltip(editando ? "Toque para remover" : "Quadra trabalhada", { direction: "top", offset: [0, -30] });
      if (editando) {
        marker.on("click", () => {
          this.quadrasEdicao.pinos.splice(idx, 1);
          this.quadrasEdicao.alterado = true;
          this.renderizarQuadrasModal();
        });
      }
      this.quadrasLayerGroup.addLayer(marker);
    });

    const containerMapa = document.getElementById("modal-map-container");
    if (containerMapa) containerMapa.classList.toggle("modo-marcar-quadras", editando);

    if (!barra) return;
    const podeEditar = this.podeEditarQuadras(t);
    if (!podeEditar && !pinos.length) {
      barra.innerHTML = `<p class="text-[11px] text-slate-600">📍 Os números no mapa são as quadras do cartão. Para marcar as quadras trabalhadas, o cartão precisa estar com você.</p>`;
      barra.className = "flex flex-wrap items-center gap-2 px-3 py-2 rounded-2xl border border-slate-200 bg-white";
      return;
    }

    if (editando) {
      barra.innerHTML = `
        <p class="text-[11px] text-[#041e49] font-medium flex-1 min-w-[180px]">
          📍 <strong>Toque no mapa</strong> sobre cada quadra já trabalhada. Toque em um alfinete para removê-lo.
        </p>
        <div class="flex items-center gap-1.5">
          <button type="button" data-acao="quadras-cancelar" class="px-3 py-1.5 rounded-full text-[11px] font-semibold text-slate-700 hover:bg-slate-200 transition">Cancelar</button>
          <button type="button" data-acao="quadras-limpar" ${pinos.length ? "" : "disabled"} class="px-3 py-1.5 rounded-full text-[11px] font-semibold border border-slate-300 text-slate-700 hover:bg-slate-100 transition disabled:opacity-40 disabled:cursor-not-allowed">Limpar</button>
          <button type="button" data-acao="quadras-salvar" class="px-3.5 py-1.5 rounded-full text-[11px] font-semibold bg-[#0b57d0] hover:bg-[#0842a0] text-white transition">Salvar (${pinos.length})</button>
        </div>`;
      barra.className = "flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-2xl border border-[#a8c7fa] bg-[#e8f0fe]";
    } else {
      const resumo = pinos.length
        ? `📍 <strong>${pinos.length}</strong> quadra(s) marcada(s) como trabalhada(s)`
        : "📍 Nenhuma quadra marcada como trabalhada ainda";
      barra.innerHTML = `
        <p class="text-[11px] text-slate-700 flex-1 min-w-[160px]">${resumo}</p>
        ${podeEditar
          ? `<button type="button" data-acao="quadras-editar" class="px-3.5 py-1.5 rounded-full text-[11px] font-semibold bg-[#d3e3fd] hover:bg-[#c2d7fc] text-[#041e49] transition">${pinos.length ? "Editar quadras trabalhadas" : "Marcar quadras trabalhadas"}</button>`
          : ""}`;
      barra.className = "flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-2xl border border-slate-200 bg-white";
    }
  },

  iniciarEdicaoQuadras() {
    const t = App.territorios.find(item => Number(item.numero) === this.territorioModalAtual);
    if (!this.podeEditarQuadras(t)) return;
    if (this.abaModal !== "quadras") this.definirAbaModal("quadras");
    this.quadrasEdicao = {
      numero: Number(t.numero),
      pinos: (Array.isArray(t.quadrasTrabalhadas) ? t.quadrasTrabalhadas : []).map(p => ({ lat: p.lat, lng: p.lng })),
      alterado: false
    };
    this.modalMap.closePopup();
    this.renderizarQuadrasModal();
  },

  cancelarEdicaoQuadras() {
    this.quadrasEdicao = null;
    this.renderizarQuadrasModal();
  },

  limparEdicaoQuadras() {
    if (!this.quadrasEdicao) return;
    this.quadrasEdicao.pinos = [];
    this.quadrasEdicao.alterado = true;
    this.renderizarQuadrasModal();
  },

  aoClicarMapaModal(evento) {
    if (!this.quadrasEdicao || !evento || !evento.latlng || this.abaModal !== "quadras") return;
    if (this.modalLimitesTerritorio && !this.modalLimitesTerritorio.contains(evento.latlng)) {
      Utils.mostrarToast("Toque dentro da área do território para marcar a quadra.", "aviso");
      return;
    }
    if (this.quadrasEdicao.pinos.length >= this.LIMITE_PINOS_QUADRAS) {
      Utils.mostrarToast(`Limite de ${this.LIMITE_PINOS_QUADRAS} alfinetes por cartão atingido.`, "aviso");
      return;
    }
    this.quadrasEdicao.pinos.push({
      lat: Math.round(evento.latlng.lat * 1e6) / 1e6,
      lng: Math.round(evento.latlng.lng * 1e6) / 1e6
    });
    this.quadrasEdicao.alterado = true;
    this.renderizarQuadrasModal();
  },

  /** Botões do balão do prédio: ir para a lista e marcar/desfazer "trabalhado" (só quem pode marcar). */
  htmlAcoesBalaoPredio(t, p) {
    const id = Utils.escapeHtml(p.idPredio);
    const num = Number(t.numero);
    const concluido = Boolean(p.trabalhadoNesteCiclo || p.ultimaDataConclusao);
    const podeMarcar = t.statusReal === "OCUPADO" && (t.emMinhaPosse || App.pode("progresso.alheio"));
    return `
      <div class="balao-predio-acoes">
        <button type="button" data-acao="predio-na-lista" data-id-predio="${id}" class="balao-btn">🏢 Abrir na lista de prédios</button>
        ${podeMarcar
          ? `<button type="button" data-acao="alternar-predio" data-num="${num}" data-id-predio="${id}" data-trabalhado="${!concluido}"
              class="balao-btn ${concluido ? "desfazer" : "primario"}">${concluido ? `✓ Trabalhado (${Utils.formatarDataBr(p.ultimaDataConclusao)}) — Desfazer` : "Marcar prédio como trabalhado"}</button>`
          : (concluido ? `<p class="balao-feito">✓ Trabalhado neste ciclo (${Utils.formatarDataBr(p.ultimaDataConclusao)})</p>` : "")}
      </div>`;
  },

  /** Do balão no mapa para a aba Prédios, rolando até o prédio e destacando-o. */
  mostrarPredioNaLista(idPredio) {
    if (this.modalMap) this.modalMap.closePopup();
    this.definirAbaModal("predios");
    const card = document.getElementById(`card-predio-${idPredio}`);
    if (!card) return;
    setTimeout(() => {
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      card.classList.add("ring-2", "ring-[#0b57d0]");
      setTimeout(() => card.classList.remove("ring-2", "ring-[#0b57d0]"), 2000);
    }, 50);
  },

  focarPredioNoModal(idPredio) {
    const info = this.modalMarkersPorId[idPredio];
    if (!info || !this.modalMap) return;
    if (this.abaModal === "predios") this.definirAbaModal("cartao");
    this.modalMap.setView([info.lat, info.lng], 18, { animate: true });
    info.marker.openPopup();
  },

  /**
   * Abas da janela do cartão. Cartão e Quadras usam o mesmo mapa (não é recriado); Prédios mostra
   * a lista em largura total. A aba Quadras é a única em que tocar no mapa marca quadra.
   */
  definirAbaModal(aba, opcoes) {
    const valida = ["cartao", "quadras", "predios"].includes(aba) ? aba : "cartao";
    if (this.quadrasEdicao && valida !== "quadras" && !(opcoes && opcoes.semAjuste)) {
      if (this.quadrasEdicao.alterado) {
        Utils.mostrarToast("Salve ou cancele as quadras marcadas antes de trocar de aba.", "aviso");
        return;
      }
      this.quadrasEdicao = null;
      this.renderizarQuadrasModal();
    }
    this.abaModal = valida;
    const modal = document.getElementById("modal-mapa-territorio");
    if (!modal) return;
    modal.dataset.aba = valida;
    modal.querySelectorAll("[data-acao='mapa-aba']").forEach(botao => {
      const ativa = botao.dataset.aba === valida;
      botao.classList.toggle("ativa", ativa);
      botao.setAttribute("aria-selected", String(ativa));
    });
    // O mapa estava escondido na aba Prédios: recalcula o tamanho ao voltar
    if (valida !== "predios" && this.modalMap && !(opcoes && opcoes.semAjuste)) {
      setTimeout(() => this.modalMap && this.modalMap.invalidateSize(), 60);
    }
  },

  fecharModalTerritorio() {
    clearTimeout(this._modalTimer);
    if (this.quadrasEdicao && this.quadrasEdicao.alterado) {
      Utils.mostrarToast("Marcações de quadras não salvas foram descartadas.", "aviso");
    }
    this.quadrasEdicao = null;
    this.territorioModalAtual = null;
    this._modalEnquadradoPara = null;
    if (this.modalMap) this.pararLocalizacao(this.modalMap);
    this.limparLinkDireto("#t=");
    const modal = document.getElementById("modal-mapa-territorio");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  },

  focarTerritorio(numero) {
    this.abrirModalTerritorio(numero);
  },

  /** Remove da barra de endereços um link direto já atendido (#t=12 ou #cartao/12). */
  limparLinkDireto(prefixo) {
    try {
      if (location.hash.startsWith(prefixo)) history.replaceState(null, "", location.pathname + location.search);
    } catch (e) {}
  },

  /**
   * ==========================================================================
   * CARTÃO IMPRIMÍVEL (A5 paisagem): cartela, mapa com quadras numeradas e prédios, norte,
   * escala, lista de prédios e QR com o link direto do cartão. Sai pelo diálogo de impressão
   * do navegador (PDF vetorial em "Salvar como PDF").
   * ==========================================================================
   */
  cartaoMap: null,
  _rotulosCartao: [],

  abrirCartaoImpressao(numero) {
    const t = App.territorios.find(item => Number(item.numero) === Number(numero));
    const geometria = this.obterGeometrias().itens.get(Number(numero));
    const overlay = document.getElementById("cartao-impressao");
    if (!t || !geometria || !overlay) {
      Utils.mostrarToast("Geometria do mapa não disponível para este território.", "aviso");
      return;
    }
    const num = Number(t.numero);
    const predios = Array.isArray(t.predios) ? t.predios : [];
    const pontos = this.deslocarCoordenadasProximas(predios);

    document.getElementById("cartao-titulo").textContent = `Território ${num}`;
    document.getElementById("cartao-subtitulo").textContent = [t.bairro, t.tipo].filter(Boolean).join(" • ");
    document.getElementById("cartao-data").textContent = `Emitido em ${new Date().toLocaleDateString("pt-BR")}`;

    // QR com o link direto do cartão (abre o app, que exige login, já neste território)
    const qrEl = document.getElementById("cartao-qr");
    qrEl.innerHTML = "";
    if (typeof qrcode === "function") {
      try {
        const qr = qrcode(0, "M");
        qr.addData(`${location.origin}${location.pathname}#t=${num}`);
        qr.make();
        qrEl.innerHTML = qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true });
      } catch (e) {}
    }

    const listaEl = document.getElementById("cartao-predios");
    listaEl.innerHTML = pontos.length
      ? pontos.map(item => `
          <li><span class="cartao-predio-num">${item.ordemPin}</span><span><strong>${Utils.escapeHtml(item.predio.nomeEdificio)}</strong><br>${Utils.escapeHtml(item.predio.endereco)}</span></li>`).join("")
      : `<li class="cartao-sem-predios">Sem prédios cadastrados neste cartão.</li>`;

    overlay.classList.remove("hidden");
    document.body.classList.add("imprimindo-cartao");

    if (this.cartaoMap) this.cartaoMap.remove();
    const mapa = L.map("cartao-mapa", { zoomControl: false, zoomSnap: 0.25, center: geometria.limites.getCenter(), zoom: 16 });
    this.cartaoMap = mapa;
    this.criarPainesRotulos(mapa);
    this.criarLadrilhosBase()["Ruas"].addTo(mapa);
    L.control.scale({ imperial: false, maxWidth: 120, position: "bottomleft" }).addTo(mapa);
    this.criarControleNorte().addTo(mapa);
    mapa.attributionControl.setPrefix("Congregação Norte PB");

    const rotulos = [];
    const grupo = L.layerGroup().addTo(mapa);
    this.desenharContextoTerritorio(grupo, t, geometria.partes, rotulos, { corMascara: "#ffffff", opacidadeMascara: 0.55 });
    grupo.addLayer(L.polygon(geometria.partes, { fill: false, color: "#111827", weight: 3, lineJoin: "round", interactive: false }));

    for (const item of pontos) {
      if (!item.lat || !item.lng) continue;
      grupo.addLayer(L.marker([item.lat, item.lng], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: "",
          html: `<div class="predio-pin-marker pin-impressao">${item.ordemPin}</div>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11]
        })
      }));
    }

    this._rotulosCartao = rotulos;
    mapa.on("zoomend", () => this.atualizarRotulos(mapa, this._rotulosCartao));
    this.carregarQuadrasGeo().then(() => {
      if (this.cartaoMap !== mapa) return;
      this.desenharQuadrasGeo(grupo, this._quadrasGeo.get(num) || [], rotulos);
      // No cartão impresso todos os números de quadra aparecem
      rotulos.forEach(r => { if (r.escala) r.sempre = true; });
      this.atualizarRotulos(mapa, rotulos);
    });

    setTimeout(() => {
      if (this.cartaoMap !== mapa) return;
      mapa.invalidateSize();
      mapa.fitBounds(geometria.limites, { padding: [14, 14] });
      this.atualizarRotulos(mapa, rotulos);
    }, 120);
  },

  fecharCartaoImpressao() {
    const overlay = document.getElementById("cartao-impressao");
    if (overlay) overlay.classList.add("hidden");
    document.body.classList.remove("imprimindo-cartao");
    if (this.cartaoMap) {
      this.cartaoMap.remove();
      this.cartaoMap = null;
    }
    this._rotulosCartao = [];
    this.limparLinkDireto("#cartao/");
  },

  imprimirCartao() {
    if (this.cartaoMap) window.print();
  }
};
