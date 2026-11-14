/**
 * Pacote offline de um território rural (spec 06, fase 5).
 *
 * Baixa para o aparelho os ladrilhos de satélite (foto + nomes de vias) que cobrem o território,
 * para o mapa funcionar sem sinal. O download é feito pelo service worker (sw.js), que guarda
 * cada ladrilho em um cache próprio do território ("territorios-tiles-<numero>") e passa a
 * responder por ele quando o mapa pedir.
 *
 * IMPORTANTE (licença): guardar ladrilhos para uso offline depende dos termos do provedor de
 * imagens. Por isso o recurso nasce DESLIGADO e só aparece quando o backend informa
 * config.offlineSatelite = true (ScriptProperty OFFLINE_SATELITE_PERMITIDO).
 */
const PacoteOffline = {
  PREFIXO_CACHE: "territorios-tiles-",
  ZOOM_MIN: 13,
  ZOOM_MAX: 17,              // 18 quadruplica o tamanho; subir só se o 17 não bastar para ver as casas
  MARGEM_METROS: 300,
  LIMITE_PACOTES: 3,         // pacotes guardados por aparelho
  LIMITE_LADRILHOS: 4000,    // proteção contra áreas enormes (cota do provedor e espaço do aparelho)
  KB_POR_LADRILHO: 20,       // média usada só na estimativa mostrada antes de baixar

  permitido: false,
  _registro: {},             // numero -> { baixadoEm, ladrilhos, falhas, zoomMax, completo }
  _progresso: null,          // { numero, feitos, total } enquanto um download está em andamento

  async iniciar() {
    this._registro = (await Armazenamento.ler("pacotes")) || {};
  },

  definirPermitido(valor) {
    this.permitido = valor === true;
  },

  info(numero) {
    return this._registro[String(Number(numero))] || null;
  },

  tem(numero) {
    return Boolean(this.info(numero));
  },

  progresso(numero) {
    return this._progresso && this._progresso.numero === Number(numero) ? this._progresso : null;
  },

  /**
   * Endereços de todos os ladrilhos do pacote. limites = { sul, oeste, norte, leste }.
   * modelos = MapaTerritorios.modelosSatelite(). Camadas de 512 px usam um zoom abaixo do mapa.
   */
  montarUrls(limites, modelos) {
    const urls = [];
    for (const modelo of [modelos.imagem, modelos.nomes]) {
      const zooms = new Set();
      for (let z = this.ZOOM_MIN; z <= this.ZOOM_MAX; z++) {
        zooms.add(Math.min(modelo.zoomNativoMax, modelo.ladrilho512 ? z - 1 : z));
      }
      for (const { z, x, y } of Geo.ladrilhosDaArea(limites, Array.from(zooms), this.MARGEM_METROS)) {
        urls.push(modelo.url.replace("{z}", z).replace("{y}", y).replace("{x}", x));
      }
    }
    return urls;
  },

  estimar(limites, modelos) {
    const ladrilhos = this.montarUrls(limites, modelos).length;
    return { ladrilhos, megabytes: Math.max(1, Math.round(ladrilhos * this.KB_POR_LADRILHO / 1024)) };
  },

  _controlador() {
    return typeof navigator !== "undefined" && navigator.serviceWorker ? navigator.serviceWorker.controller : null;
  },

  /**
   * Baixa (ou completa) o pacote de um território. aoProgresso({ feitos, total }) é opcional.
   * Devolve { total, falhas, cancelado }. Lança Error com mensagem pronta para o usuário.
   */
  async baixar(numero, limites, modelos, aoProgresso) {
    const num = Number(numero);
    if (!this.permitido) throw new Error("O download de mapas para uso offline não está habilitado.");
    if (this._progresso) throw new Error("Já existe um download em andamento. Aguarde terminar.");
    const controlador = this._controlador();
    if (!controlador) throw new Error("O app ainda está se preparando para funcionar offline. Recarregue a página e tente de novo.");
    if (!this.tem(num) && Object.keys(this._registro).length >= this.LIMITE_PACOTES) {
      throw new Error(`Este aparelho já guarda ${this.LIMITE_PACOTES} territórios para uso offline. Remova um deles antes de baixar outro.`);
    }
    const urls = this.montarUrls(limites, modelos);
    if (urls.length > this.LIMITE_LADRILHOS) {
      throw new Error("Este território é grande demais para baixar de uma vez. Avise o administrador para ajustar o limite.");
    }

    // Pede ao navegador para não apagar estes dados sozinho quando faltar espaço
    try {
      if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
    } catch (e) {}

    this._progresso = { numero: num, feitos: 0, total: urls.length };
    if (aoProgresso) aoProgresso(this._progresso);
    try {
      const fim = await new Promise((resolve, reject) => {
        const canal = new MessageChannel();
        canal.port1.onmessage = evento => {
          const d = evento.data || {};
          if (d.tipo === "PROGRESSO") {
            this._progresso = { numero: num, feitos: d.feitos, total: d.total };
            if (aoProgresso) aoProgresso(this._progresso);
          } else if (d.tipo === "FIM") {
            resolve(d);
          } else if (d.tipo === "ERRO") {
            reject(new Error("Não foi possível guardar o mapa neste aparelho (espaço insuficiente?)."));
          }
        };
        controlador.postMessage({ tipo: "PACOTE_BAIXAR", numero: num, urls }, [canal.port2]);
      });

      const baixados = fim.total - fim.falhas;
      if (!baixados) {
        await this.remover(num);
        throw new Error("Nenhuma imagem pôde ser baixada. Verifique a conexão e tente de novo.");
      }
      this._registro[String(num)] = {
        baixadoEm: Date.now(),
        ladrilhos: fim.total,
        falhas: fim.falhas,
        zoomMax: this.ZOOM_MAX,
        completo: !fim.cancelado && fim.falhas === 0
      };
      await Armazenamento.gravar("pacotes", this._registro);
      return { total: fim.total, falhas: fim.falhas, cancelado: Boolean(fim.cancelado) };
    } finally {
      this._progresso = null;
    }
  },

  cancelar(numero) {
    const controlador = this._controlador();
    if (controlador) controlador.postMessage({ tipo: "PACOTE_CANCELAR", numero: Number(numero) });
  },

  _avisarServiceWorker() {
    const controlador = this._controlador();
    if (controlador) controlador.postMessage({ tipo: "PACOTES_MUDARAM" });
  },

  async remover(numero) {
    const num = Number(numero);
    try {
      if (typeof caches !== "undefined") await caches.delete(this.PREFIXO_CACHE + num);
    } catch (e) {}
    delete this._registro[String(num)];
    await Armazenamento.gravar("pacotes", this._registro);
    this._avisarServiceWorker();
  },

  /** Apaga todos os pacotes do aparelho (logout ou troca de conta), mesmo os sem registro. */
  async removerTodos() {
    try {
      if (typeof caches !== "undefined") {
        for (const nome of await caches.keys()) {
          if (nome.startsWith(this.PREFIXO_CACHE)) await caches.delete(nome);
        }
      }
    } catch (e) {}
    this._registro = {};
    await Armazenamento.remover("pacotes");
    this._avisarServiceWorker();
  }
};

if (typeof module !== "undefined" && module.exports) module.exports = PacoteOffline;
