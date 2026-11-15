/**
 * Utilitários de Segurança (Prevenção contra XSS), Formatação, Modais Material 3 (ModalM3)
 * e Conversor WKT -> GeoJSON
 */
const Utils = {
  DIAS_QUARENTENA_DEVOLUCAO: 120,
  LIMITE_FILA_EXIBICAO: 5,
  LIMITE_SELECAO_LOTE: 3,

  // Escapa strings antes de inserir no DOM para impedir ataques XSS
  escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  },

  formatarDataBr(isoDate) {
    if (!isoDate) return "Nunca trabalhado";
    const partes = String(isoDate).split("T")[0].split("-");
    if (partes.length === 3) {
      return `${partes[2]}/${partes[1]}/${partes[0]}`;
    }
    return this.escapeHtml(isoDate);
  },

  /**
   * Converte uma data (YYYY-MM-DD, DD/MM/YYYY ou ISO) em timestamp numérico (ms).
   * Retorna 0 quando vazio ("Nunca trabalhado"), garantindo prioridade máxima na ordenação por antiguidade.
   */
  obterTimestampData(isoDate) {
    if (!isoDate) return 0;
    const str = String(isoDate).split("T")[0].trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      const [ano, mes, dia] = str.split("-").map(Number);
      return new Date(ano, mes - 1, dia).getTime();
    }
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
      const [dia, mes, ano] = str.split("/").map(Number);
      return new Date(ano, mes - 1, dia).getTime();
    }
    const ts = Date.parse(isoDate);
    return isNaN(ts) ? 0 : ts;
  },

  /**
   * Calcula a quantidade de dias corridos desde uma data até hoje.
   * Retorna Infinity caso nunca tenha sido trabalhado/devolvido.
   */
  calcularDiasDesdeData(isoDate) {
    const ts = this.obterTimestampData(isoDate);
    if (!ts) return Infinity;
    const hoje = new Date();
    const hojeMeiaNoite = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()).getTime();
    const dataAlvo = new Date(ts);
    const alvoMeiaNoite = new Date(dataAlvo.getFullYear(), dataAlvo.getMonth(), dataAlvo.getDate()).getTime();
    return Math.floor((hojeMeiaNoite - alvoMeiaNoite) / (1000 * 60 * 60 * 24));
  },

  /**
   * Fonte única do estilo por status: polígonos do mapa, legenda e etiquetas (badges).
   * Paleta Okabe-Ito (segura para daltonismo) com um segundo sinal além da cor:
   * espessura do traço, hachura (Ocupado), tracejado (Recente) ou ausência de preenchimento.
   * A ordem das chaves é a ordem da legenda.
   */
  ESTILO_STATUS: {
    COMIGO: {
      rotulo: "Comigo", preenchimento: "#0072B2", opacidade: 0.35, borda: "#004B76", peso: 3,
      badgeClass: "bg-[#0b57d0] text-white border-[#0b57d0]"
    },
    FILA: {
      rotulo: "Na fila (Top 5)", preenchimento: "#009E73", opacidade: 0.3, borda: "#00664A", peso: 2.5,
      badgeClass: "bg-[#e6f4ea] text-[#137333] border-[#ceead6]"
    },
    OCUPADO: {
      rotulo: "Ocupado", preenchimento: "#E69F00", opacidade: 0.25, borda: "#8A5F00", peso: 1.5, hachura: true,
      badgeClass: "bg-[#fef7e0] text-[#b06000] border-[#feefc3]"
    },
    RECENTE: {
      rotulo: "Recente (descanso)", preenchimento: "#999999", opacidade: 0.2, borda: "#666666", peso: 1, tracejado: "5 4",
      badgeClass: "bg-slate-100 text-slate-600 border-slate-300"
    },
    AGUARDANDO: {
      rotulo: "Aguardando fila", preenchimento: "#FFFFFF", opacidade: 0.1, borda: "#64748B", peso: 1,
      badgeClass: "bg-[#e6f4ea] text-[#137333] border-[#ceead6]"
    }
  },

  /** Chave de ESTILO_STATUS correspondente à situação do território para o usuário atual. */
  chaveStatus(t, naFilaTop5 = false) {
    if (t.emMinhaPosse) return "COMIGO";
    if (t.statusReal === "OCUPADO") return "OCUPADO";
    if (t.statusReal === "RECENTE") return "RECENTE";
    return naFilaTop5 ? "FILA" : "AGUARDANDO";
  },

  /**
   * Rótulo e classes visuais de status do território no padrão Google Material Design 3 (Tonal Pills)
   */
  obterEstiloStatus(t, naFilaTop5 = false) {
    const badgeClass = this.ESTILO_STATUS[this.chaveStatus(t, naFilaTop5)].badgeClass;

    let label = t.statusReal;
    if (t.emMinhaPosse) {
      label = "COM VOCÊ";
    } else if (naFilaTop5 && t.statusReal === "DISPONÍVEL") {
      label = "DISPONÍVEL NA FILA";
    }
    return { badgeClass, label };
  },

  /**
   * Traduz as tags logísticas fechadas (LGPD-safe) de um prédio em estrutura de badges + metadados para o mapa e cartão
   */
  obterBadgesPredio(p) {
    const interfone = String((p && p.tipoInterfone) || "NAO_INFORMADO").toUpperCase();
    let interfoneBadge = {
      texto: "❓ Interfone N/I",
      cls: "bg-slate-100 text-slate-700 border border-slate-200"
    };

    if (interfone === "EXTERNO") {
      interfoneBadge = {
        texto: "🔔 Interfone Externo",
        cls: "bg-[#e6f4ea] text-[#137333] border border-[#ceead6]"
      };
    } else if (interfone === "INTERNO") {
      interfoneBadge = {
        texto: "🔔 Interfone Interno",
        cls: "bg-[#fef7e0] text-[#b06000] border border-[#feefc3]"
      };
    } else if (interfone === "SEM_INTERFONE") {
      interfoneBadge = {
        texto: "🚫 Sem Interfone",
        cls: "bg-[#fce8e6] text-[#c5221f] border border-[#fad2cf]"
      };
    }

    const tags = Array.isArray(p && p.tagsLogisticas)
      ? p.tagsLogisticas
      : String((p && p.tagsLogisticas) || "").split(",").map(s => s.trim()).filter(Boolean);

    const mapaTags = {
      EXIGE_CODIGO: { texto: "🔐 Exige Código", cls: "bg-[#fef7e0] text-[#b06000] border border-[#feefc3]" },
      PEDE_NUM_APTO: { texto: "🔢 Discar Nº Apto", cls: "bg-[#e8f0fe] text-[#1967d2] border border-[#d2e3fc]" },
      INTERFONE_DIGITAL: { texto: "📟 Digital", cls: "bg-[#e8f0fe] text-[#1967d2] border border-[#d2e3fc]" },
      COM_CAMERA: { texto: "📹 Câmera", cls: "bg-sky-50 text-sky-700 border border-sky-200" },
      PORTARIA: { texto: "🛎️ Portaria", cls: "bg-indigo-50 text-indigo-700 border border-indigo-200" },
      COM_ACESSO: { texto: "🔓 Com Acesso", cls: "bg-[#e6f4ea] text-[#137333] border border-[#ceead6]" },
      SEM_ACESSO: { texto: "🔒 S/ Acesso", cls: "bg-slate-100 text-slate-600 border border-slate-200" },
      ACESSO_RESTRITO: { texto: "⚠️ Acesso Restrito", cls: "bg-[#fef7e0] text-[#b06000] border border-[#feefc3]" },
      DOIS_BLOCOS: { texto: "🏢 2 Blocos", cls: "bg-purple-50 text-purple-700 border border-purple-200" },
      TRES_BLOCOS: { texto: "🏢 3 Blocos", cls: "bg-purple-50 text-purple-700 border border-purple-200" },
      CONDOMINIO_CASAS: { texto: "🏘️ Cond. Casas", cls: "bg-teal-50 text-teal-700 border border-teal-200" },
      EM_REFORMA: { texto: "🚧 Em Reforma", cls: "bg-amber-50 text-amber-800 border border-amber-200" }
    };

    const tagsBadges = [];
    for (const tag of tags) {
      if (mapaTags[tag]) tagsBadges.push(mapaTags[tag]);
    }

    const partesMeta = [];
    if (p && Number(p.andares) > 0) partesMeta.push(`${Number(p.andares)} andar(es)`);
    if (p && Number(p.apartamentos) > 0) partesMeta.push(`${Number(p.apartamentos)} apto(s)/unid.`);
    const metaStr = partesMeta.join(" • ");

    return { interfoneBadge, tagsBadges, metaStr };
  },

  _mapaPrediosCache: null,
  obterPrediosPadraoTerritorio(numeroTerritorio) {
    if (!this._mapaPrediosCache) {
      this._mapaPrediosCache = {};
      for (const r of PREDIOS_SEMENTE_NORTE_FRONTEND) {
        const num = String(r[1]);
        if (!this._mapaPrediosCache[num]) this._mapaPrediosCache[num] = [];
        this._mapaPrediosCache[num].push({
          idPredio: r[0],
          numeroTerritorio: Number(r[1]),
          nomeEdificio: r[2],
          endereco: r[3],
          andares: Number(r[4] || 0),
          apartamentos: Number(r[5] || 0),
          tipoInterfone: r[6] || "NAO_INFORMADO",
          tagsLogisticas: r[7] ? String(r[7]).split(",").filter(Boolean) : [],
          referenciaComercial: r[8] || "",
          latitude: Number(r[9]),
          longitude: Number(r[10]),
          ultimaDataConclusao: "",
          trabalhadoNesteCiclo: false
        });
      }
    }
    return this._mapaPrediosCache[String(numeroTerritorio)] || [];
  },

  /**
   * Gera dinamicamente a lista de Anos de Serviço (01/09/AAAA até 31/08/AAAA+1)
   */
  obterAnosDeServicoDisponiveis() {
    const hoje = new Date();
    const anoAtual = hoje.getFullYear();
    const mesAtual = hoje.getMonth() + 1;
    const anoInicioVigente = mesAtual >= 9 ? anoAtual : anoAtual - 1;
    const primeiroAno = 2024;
    const ultimoAno = Math.max(anoInicioVigente + 1, 2026);

    const lista = [];
    for (let ano = ultimoAno; ano >= primeiroAno; ano--) {
      lista.push({
        anoInicio: ano,
        anoFim: ano + 1,
        label: `Ano de Serviço ${ano}/${ano + 1} (01/09/${ano} a 31/08/${ano + 1})`,
        periodo: `01/09/${ano} a 31/08/${ano + 1}`,
        vigente: ano === anoInicioVigente
      });
    }
    return lista;
  },

  /**
   * Filtra uma lista de ciclos { dirigente, dataDesignacao, dataConclusao } para o Ano de Serviço
   */
  filtrarCiclosPorAnoServico(ciclos, anoInicio) {
    if (!Array.isArray(ciclos) || !ciclos.length) return [];
    const inicioTs = new Date(Number(anoInicio), 8, 1, 0, 0, 0, 0).getTime();
    const fimTs = new Date(Number(anoInicio) + 1, 7, 31, 23, 59, 59, 999).getTime();

    return ciclos.filter(c => {
      const tsDesig = this.obterTimestampData(c.dataDesignacao);
      const tsConcl = this.obterTimestampData(c.dataConclusao);

      const desigNoPeriodo = tsDesig >= inicioTs && tsDesig <= fimTs;
      const conclNoPeriodo = tsConcl >= inicioTs && tsConcl <= fimTs;
      const emAbertoNoPeriodo = tsDesig > 0 && tsDesig < inicioTs && (!tsConcl || tsConcl >= inicioTs);
      return desigNoPeriodo || conclNoPeriodo || emAbertoNoPeriodo;
    });
  },

  /**
   * Sinaliza "ocupado" em um botão enquanto uma ação assíncrona não termina: spinner (CSS),
   * aria-busy e trava contra clique duplo (data-ocupado, conferido antes de disparar a ação).
   * Não mexe em `disabled`: várias telas ligam/desligam esse atributo por conta própria.
   * Aceita qualquer retorno; só age quando é uma Promise.
   */
  sinalizarOcupado(el, resultado) {
    if (!el || !resultado || typeof resultado.then !== "function") return resultado;
    el.dataset.ocupado = "1";
    el.setAttribute("aria-busy", "true");
    el.classList.add("acao-ocupada");
    const liberar = () => {
      delete el.dataset.ocupado;
      el.removeAttribute("aria-busy");
      el.classList.remove("acao-ocupada");
    };
    resultado.then(liberar, liberar);
    return resultado;
  },

  /** true quando o elemento já tem uma ação assíncrona em andamento (clique repetido deve ser ignorado). */
  estaOcupado(el) {
    return Boolean(el && el.dataset && el.dataset.ocupado === "1");
  },

  mostrarToast(mensagem, tipo = "sucesso") {
    const el = document.getElementById("app-toast");
    if (!el) return;
    el.textContent = mensagem;
    el.className = "fixed bottom-5 right-5 z-[70] max-w-sm px-4 py-3 rounded-2xl shadow-lg border text-xs font-semibold transition-all ";
    if (tipo === "erro") {
      el.className += "bg-[#fce8e6] border-[#f6aea9] text-[#a50e0e]";
    } else if (tipo === "aviso") {
      el.className += "bg-[#fef7e0] border-[#fde293] text-[#b06000]";
    } else {
      el.className += "bg-[#e6f4ea] border-[#a8dab5] text-[#137333]";
    }
    el.classList.remove("hidden");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add("hidden"), 4500);
  },

  /**
   * Converte geometria WKT (MultiPolygon Z / Polygon) da aba 'BASE' em partes do Leaflet:
   * [[anelExterno, ...furos], ...] com pontos [lat, lng]. Cada parte de um MultiPolygon é um
   * polígono próprio (antes as partes extras eram tratadas como furos da primeira).
   * L.polygon aceita este formato diretamente.
   */
  parseWktParaPoligonosLeaflet(wkt) {
    return Geo.parseWktPartes(wkt);
  }
};

/**
 * Sistema de Diálogos Customizados Padrão Google Material Design 3
 * Substitui 100% dos pop-ups nativos do navegador (window.confirm / window.alert)
 */
const ModalM3 = {
  _resolveAtual: null,

  _obterElementos() {
    const container = document.getElementById("modal-m3-dialog");
    if (!container) return { container: null, content: null };
    let content = document.getElementById("modal-m3-content");
    if (!content) {
      content = document.createElement("div");
      content.id = "modal-m3-content";
      content.className = "m3-dialog-surface w-full max-w-md overflow-hidden";
      container.appendChild(content);
      container.addEventListener("click", e => {
        if (e.target === container) this.fechar(null);
      });
    }
    return { container, content };
  },

  fechar(resultado = null) {
    const container = document.getElementById("modal-m3-dialog");
    if (container) {
      container.classList.add("hidden");
      container.classList.remove("flex");
    }
    if (this._resolveAtual) {
      const fn = this._resolveAtual;
      this._resolveAtual = null;
      fn(resultado);
    }
  },

  /**
   * Exibe modal de confirmação Material 3 retornando Promise<boolean>
   */
  confirmar({ titulo, mensagem = "", detalhesHtml = "", subtituloHtml = "", textoConfirmar = "Confirmar", textoCancelar = "Cancelar", variante = "primario", icone = "📌" }) {
    return new Promise(resolve => {
      this._resolveAtual = val => resolve(Boolean(val));
      const { container, content } = this._obterElementos();
      if (!container || !content) {
        resolve(false);
        return;
      }

      const btnColors = variante === "perigo"
        ? "bg-[#c5221f] hover:bg-[#a50e0e] text-white"
        : "bg-[#0b57d0] hover:bg-[#0842a0] text-white";

      const iconBg = variante === "perigo"
        ? "bg-[#fce8e6] text-[#c5221f]"
        : "bg-[#d3e3fd] text-[#041e49]";

      const corpoHtml = subtituloHtml || `
        ${mensagem ? `<p>${Utils.escapeHtml(mensagem)}</p>` : ""}
        ${detalhesHtml || ""}
      `;

      content.innerHTML = `
        <div class="p-6">
          <div class="w-11 h-11 rounded-full ${iconBg} flex items-center justify-center text-lg mb-4">
            ${icone}
          </div>
          <h3 class="text-lg font-bold text-[#1f1f1f] leading-snug">${Utils.escapeHtml(titulo)}</h3>
          <div class="mt-2.5 text-xs text-[#444746] leading-relaxed space-y-2.5">
            ${corpoHtml}
          </div>
          <div class="mt-6 flex items-center justify-end gap-2">
            ${textoCancelar ? `
              <button type="button" id="m3-btn-cancel" class="px-4 py-2.5 rounded-full text-xs font-semibold text-[#0b57d0] hover:bg-[#f0f6ff] transition">
                ${Utils.escapeHtml(textoCancelar)}
              </button>
            ` : ""}
            <button type="button" id="m3-btn-confirm" class="px-5 py-2.5 rounded-full text-xs font-semibold shadow-sm transition ${btnColors}">
              ${Utils.escapeHtml(textoConfirmar)}
            </button>
          </div>
        </div>
      `;

      container.classList.remove("hidden");
      container.classList.add("flex");

      const btnCancel = document.getElementById("m3-btn-cancel");
      const btnConfirm = document.getElementById("m3-btn-confirm");
      if (btnCancel) btnCancel.onclick = () => this.fechar(false);
      if (btnConfirm) {
        btnConfirm.onclick = () => this.fechar(true);
        setTimeout(() => btnConfirm.focus(), 50);
      }
    });
  },

  /**
   * Exibe modal de alerta informativo Material 3 (Ex: Conflito de Concorrência 409)
   */
  alerta({ titulo, mensagem = "", subtituloHtml = "", textoBotao = "Entendi", icone = "⚠️" }) {
    return this.confirmar({
      titulo,
      mensagem,
      subtituloHtml,
      textoConfirmar: textoBotao,
      textoCancelar: "",
      variante: "primario",
      icone
    });
  },

  /**
   * Fluxo de Devolução em Duas Etapas (Regra de Negócio 2):
   * Etapa 1: "Confirma que o território foi totalmente completo?" (Sim / Não)
   * Etapa 2 (se Não): Opções fechadas (Quadras faltantes, Prédios não trabalhados, Não iniciado)
   * Retorna Promise<{ confirmado: boolean, foiCompleto: boolean, motivoNaoCompleto: string } | null>
   */
  abrirDevolucaoDuasEtapas(territorio) {
    return new Promise(resolve => {
      this._resolveAtual = resolve;
      const { container, content } = this._obterElementos();
      if (!container || !content) {
        resolve(null);
        return;
      }

      const num = Number(territorio.numero);
      const bairro = Utils.escapeHtml(territorio.bairro || "");
      const qtdPredios = Array.isArray(territorio.predios) ? territorio.predios.length : 0;

      const renderEtapa1 = () => {
        content.innerHTML = `
          <div class="p-6">
            <div class="w-11 h-11 rounded-full bg-[#d3e3fd] text-[#041e49] flex items-center justify-center text-lg mb-4">
              📋
            </div>
            <span class="text-[11px] font-semibold uppercase tracking-wider text-[#0b57d0]">Devolução de Cartão</span>
            <h3 class="text-lg font-bold text-[#1f1f1f] mt-0.5">Território ${num} — ${bairro}</h3>
            <div class="mt-3 p-3.5 rounded-2xl bg-[#f8fafc] border border-slate-200">
              <p class="text-sm font-semibold text-[#1f1f1f]">Confirma que o território foi totalmente completo?</p>
              <p class="text-xs text-[#444746] mt-1">
                Se responder <strong>Sim</strong>, o território volta para a fila como concluído e fica indisponível até completar o ciclo de 120 dias.
              </p>
            </div>
            <p class="text-[11px] text-[#444746] mt-3">
              📍 Os alfinetes de quadras trabalhadas são apagados na devolução.${qtdPredios ? " 🏢 O histórico de prédios e apartamentos é mantido até que todos os prédios do cartão sejam concluídos." : ""}
            </p>
            <div class="mt-6 flex flex-wrap items-center justify-end gap-2">
              <button type="button" id="m3-dev-cancel" class="px-4 py-2.5 rounded-full text-xs font-semibold text-[#444746] hover:bg-slate-100 transition mr-auto">
                Cancelar
              </button>
              <button type="button" id="m3-dev-nao" class="px-5 py-2.5 rounded-full text-xs font-semibold bg-[#f1f5f9] hover:bg-[#e2e8f0] text-[#1f1f1f] border border-slate-300 transition">
                Não
              </button>
              <button type="button" id="m3-dev-sim" class="px-5 py-2.5 rounded-full text-xs font-semibold bg-[#0b57d0] hover:bg-[#0842a0] text-white shadow-sm transition">
                Sim
              </button>
            </div>
          </div>
        `;

        document.getElementById("m3-dev-cancel").onclick = () => this.fechar(null);
        document.getElementById("m3-dev-sim").onclick = () =>
          this.fechar({ confirmado: true, foiCompleto: true, motivoNaoCompleto: "COMPLETO" });
        document.getElementById("m3-dev-nao").onclick = () => renderEtapa2();
      };

      const renderEtapa2 = () => {
        let motivoSelecionado = "QUADRAS_FALTANTES";

        content.innerHTML = `
          <div class="p-6">
            <div class="flex items-center justify-between mb-3">
              <span class="text-[11px] font-semibold uppercase tracking-wider text-[#b06000] bg-[#fef7e0] px-2.5 py-1 rounded-full border border-[#feefc3]">
                Motivo da Devolução
              </span>
            </div>
            <h3 class="text-base font-bold text-[#1f1f1f]">Território ${num} — ${bairro}</h3>
            <p class="text-xs text-[#444746] mt-1">Selecione o motivo pelo qual o território não foi totalmente completo:</p>

            <div class="mt-4 space-y-2.5" id="m3-dev-opcoes">
              <label class="m3-radio-card selected flex items-start gap-3 p-3.5" data-motivo="QUADRAS_FALTANTES">
                <input type="radio" name="motivo_devolucao" value="QUADRAS_FALTANTES" checked class="mt-1 accent-[#0b57d0]" />
                <div>
                  <span class="block text-xs font-bold text-[#1f1f1f]">🏘️ Quadras faltantes</span>
                  <span class="block text-[11px] text-[#444746] mt-0.5">
                    Volta para a fila como <strong>concluído</strong> conforme a regra principal (indisponível por 120 dias).
                  </span>
                </div>
              </label>

              <label class="m3-radio-card flex items-start gap-3 p-3.5" data-motivo="PREDIOS_NAO_TRABALHADOS">
                <input type="radio" name="motivo_devolucao" value="PREDIOS_NAO_TRABALHADOS" class="mt-1 accent-[#0b57d0]" />
                <div>
                  <span class="block text-xs font-bold text-[#1f1f1f]">🏢 Prédios não trabalhados ${qtdPredios ? `(${qtdPredios} no cartão)` : ""}</span>
                  <span class="block text-[11px] text-[#444746] mt-0.5">
                    Volta para a fila como <strong>concluído</strong> conforme a regra principal (indisponível por 120 dias).
                  </span>
                </div>
              </label>

              <label class="m3-radio-card flex items-start gap-3 p-3.5" data-motivo="NAO_INICIADO">
                <input type="radio" name="motivo_devolucao" value="NAO_INICIADO" class="mt-1 accent-[#0b57d0]" />
                <div>
                  <span class="block text-xs font-bold text-[#137333]">↩️ Não iniciado</span>
                  <span class="block text-[11px] text-[#444746] mt-0.5">
                    Não foi trabalhado nele: volta para a fila <strong>imediatamente como DISPONÍVEL</strong> e sem data de iniciado nem concluído.
                  </span>
                </div>
              </label>
            </div>

            <div class="mt-6 flex items-center justify-between gap-2">
              <button type="button" id="m3-dev-voltar" class="px-4 py-2.5 rounded-full text-xs font-semibold text-[#444746] hover:bg-slate-100 transition">
                ← Voltar
              </button>
              <button type="button" id="m3-dev-confirmar-motivo" class="px-5 py-2.5 rounded-full text-xs font-semibold bg-[#0b57d0] hover:bg-[#0842a0] text-white shadow-sm transition">
                Confirmar Devolução
              </button>
            </div>
          </div>
        `;

        const cards = content.querySelectorAll(".m3-radio-card");
        cards.forEach(card => {
          card.addEventListener("click", () => {
            cards.forEach(c => c.classList.remove("selected"));
            card.classList.add("selected");
            const radio = card.querySelector("input[type='radio']");
            if (radio) {
              radio.checked = true;
              motivoSelecionado = radio.value;
            }
          });
        });

        document.getElementById("m3-dev-voltar").onclick = () => renderEtapa1();
        document.getElementById("m3-dev-confirmar-motivo").onclick = () => {
          const checkedRadio = content.querySelector("input[name='motivo_devolucao']:checked");
          const motivoFinal = checkedRadio ? checkedRadio.value : motivoSelecionado;
          this.fechar({
            confirmado: true,
            foiCompleto: false,
            motivoNaoCompleto: motivoFinal
          });
        };
      };

      renderEtapa1();
      container.classList.remove("hidden");
      container.classList.add("flex");
    });
  }
};

const PREDIOS_SEMENTE_NORTE_FRONTEND = [
  ["PRD-206",32,"Residencial Leoni","Rua Tapejara, 314",6,0,"EXTERNO","PEDE_NUM_APTO","",-26.222283,-52.674172],
  ["PRD-207",32,"Ed. Luiza","Rua Tapejara, 320",4,0,"EXTERNO","EXIGE_CODIGO","",-26.222238,-52.674189],
  ["PRD-208",32,"Ed. Ana Luiza","Trav. Tapejara, 346",7,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.223348,-52.673036],
  ["PRD-209",32,"Ed. Maria Maria","Rua Tapajós, 827",4,0,"NAO_INFORMADO","DOIS_BLOCOS","",-26.221815,-52.673145],
  ["PRD-212",32,"Residencial Delta","Rua Tapajós, 656",7,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.222576,-52.672972],
  ["PRD-019",3,"Condomínio do Ed Resid e Com Osvaldo Pia","Rua Tapajós, 250",4,10,"NAO_INFORMADO","","Sobre a Quitanda do Aroma",-26.224679,-52.672422],
  ["PRD-021",3,"Edificio da Raffer","Rua Itabira, 1343",4,0,"NAO_INFORMADO","","",-26.224126,-52.671824],
  ["PRD-022",3,"Edificio Frei Policarpio","Rua Itabira, 1315",19,39,"EXTERNO","SEM_ACESSO","",-26.224203,-52.672054],
  ["PRD-023",65,"Ed. Ponto Nobre","Rua Caramuru, 700",7,28,"EXTERNO","SEM_ACESSO","",-26.224826,-52.674908],
  ["PRD-024",3,"Edificio Awada","Avenida Tupi, 2000",4,26,"SEM_INTERFONE","COM_ACESSO","Sobre a barbearia",-26.222718,-52.671491],
  ["PRD-025",3,"Condominio Galeazzi","Rua Tapir, 1212",2,1,"EXTERNO","","Ao lado da Galeazzi",-26.223008,-52.672113],
  ["PRD-026",3,"Residencial Awada","Rua Itabira, 1183",0,12,"EXTERNO","SEM_ACESSO","Sobre a lotérica",-26.224735,-52.673355],
  ["PRD-027",65,"Ed. Ulisses Roldo","Rua Caramuru, 678",3,6,"EXTERNO","SEM_ACESSO","",-26.225218,-52.674673],
  ["PRD-196",65,"Edifício s/ nome","Rua Guarani, 830",6,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","Sobre a Parzianello Materiais de Construção",-26.222576,-52.675062],
  ["PRD-203",3,"Ed. Octaviano Marcante","Rua Tapejara, 36",10,0,"NAO_INFORMADO","PEDE_NUM_APTO","Ao lado do nº 61",-26.223702,-52.673624],
  ["PRD-204",3,"Resid. Janes Tomazi Piacentini","Rua Tapejara, 61",9,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.223702,-52.673624],
  ["PRD-205",3,"Residencial Sonté","Rua Tapejara, 138",4,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.223702,-52.673624],
  ["PRD-210",32,"Edificio Bruno Ceni","Rua Tapajós, 460",5,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.223247,-52.672787],
  ["PRD-211",3,"Ed. Aldemar A. Cattuci","Rua Tapajós, 513",4,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.223341,-52.672762],
  ["PRD-028",65,"Prédio Comercial (Salão)","Rua Caramuru, 741",3,0,"EXTERNO","SEM_ACESSO","Sobre o Salão de Beleza",-26.224576,-52.675058],
  ["PRD-029",65,"Predio Balbinotti","Rua Caramuru, 913",3,1,"EXTERNO","SEM_ACESSO","",-26.223204,-52.675883],
  ["PRD-030",65,"Edifício s/ nome","Rua Caramuru, 687",3,3,"EXTERNO","SEM_ACESSO","",-26.22507,-52.674762],
  ["PRD-031",2,"Residencial","Rua Tapir, 785",1,1,"SEM_INTERFONE","SEM_ACESSO","",-26.224879,-52.676074],
  ["PRD-032",2,"Residencial","Rua Tapir, 623",4,2,"EXTERNO","SEM_ACESSO","",-26.225699,-52.677764],
  ["PRD-033",38,"Edifício s/ nome","Rua Itabira, 1121",1,1,"EXTERNO","SEM_ACESSO","",-26.224992,-52.673859],
  ["PRD-034",38,"Edifício s/ nome","Rua Itabira, 939",1,2,"EXTERNO","SEM_ACESSO","",-26.225245,-52.67439],
  ["PRD-035",38,"Residencial","Rua Itabira, 1099",3,0,"EXTERNO","SEM_ACESSO","Sobre a Mecânica Pagnoncelli",-26.225122,-52.67413],
  ["PRD-036",2,"Predio Esquina","Rua Tamoio, 1013",1,0,"SEM_INTERFONE","SEM_ACESSO","",-26.225287,-52.676078],
  ["PRD-037",2,"Residencial Vitória","Rua Tamoio, 1200",3,2,"EXTERNO","SEM_ACESSO","",-26.223794,-52.677041],
  ["PRD-228",2,"Residencial Alphaville","Rua Tapir, 833",5,0,"EXTERNO","EXIGE_CODIGO,DOIS_BLOCOS","",-26.224668,-52.675644],
  ["PRD-229",2,"Edifício Monteiro Lobato","Avenida Brasil, 942",5,3,"EXTERNO","EXIGE_CODIGO,COM_CAMERA,DOIS_BLOCOS","",-26.225635,-52.677132],
  ["PRD-230",2,"Edifício Vasti","Avenida Brasil, 890",8,15,"EXTERNO","COM_CAMERA","",-26.226026,-52.676898],
  ["PRD-231",38,"Residencial Porto Vitória","Rua Tamoio, 934",8,4,"EXTERNO","COM_CAMERA","",-26.22603,-52.675648],
  ["PRD-236",38,"Edifício s/ nome","Rua Itabira, 1115",4,0,"EXTERNO","","",-26.225017,-52.673911],
  ["PRD-238",65,"Edifício s/ nome","Rua Caramuru, 709",9,0,"EXTERNO","SEM_ACESSO","",-26.224771,-52.674941],
  ["PRD-038",2,"Resid. Otavio Bezzinatto","Rua Osvaldo Aranha, 125",3,3,"EXTERNO","SEM_ACESSO","",-26.223371,-52.677049],
  ["PRD-240",2,"Edifício Tarsila do Amaral","Rua Tamoio, 1302",6,0,"EXTERNO","COM_CAMERA","",-26.222981,-52.677672],
  ["PRD-223",12,"Residencial Polarys","Rua Tocantins, 3435",9,0,"EXTERNO","SEM_ACESSO","",-26.217108,-52.670296],
  ["PRD-242",12,"Residencial Dona Alexandrina","Rua Assis Brasil, 650",4,4,"EXTERNO","SEM_ACESSO,PEDE_NUM_APTO","",-26.218662,-52.671957],
  ["PRD-243",48,"Edifício s/ nome","Rua Nereu Ramos, 631",4,16,"EXTERNO","SEM_ACESSO","",-26.216857,-52.671438],
  ["PRD-222",12,"Resid. Luciano de Souza","Rua Tocantins, 3265",8,0,"EXTERNO","SEM_ACESSO","",-26.21835,-52.669758],
  ["PRD-225",79,"Residencial Cecília Digo","Rua Silveira Martins, 247",8,0,"EXTERNO","","",-26.221042,-52.669831],
  ["PRD-226",78,"Edifício s/ nome","Rua Brasília, 193",4,0,"EXTERNO","","",-26.22125,-52.66633],
  ["PRD-227",13,"Edifício Dona Cesira","Rua Salgado Filho, 230",13,0,"EXTERNO","PORTARIA","",-26.220318,-52.666131],
  ["PRD-001",3,"Predio Hadatur","Rua Tapir, 1967",2,6,"SEM_INTERFONE","ACESSO_RESTRITO","Prédio da Agência Hadatur",-26.222779,-52.671623],
  ["PRD-002",3,"Edifício Imperatriz","Av. Tupi, 1997",11,61,"EXTERNO","SEM_ACESSO,COM_CAMERA","",-26.222718,-52.671491],
  ["PRD-003",3,"Edificio Av Central","Av. Tupi, 2015",11,0,"EXTERNO","","",-26.222718,-52.671491],
  ["PRD-004",35,"Prédio Piacentinp","Rua Itabira",0,1,"SEM_INTERFONE","","",-26.223912,-52.669817],
  ["PRD-006",35,"Prédio Três Marias","Rua Itabira",10,3,"EXTERNO","COM_ACESSO,COM_CAMERA","",-26.22393,-52.669671],
  ["PRD-007",48,"Ed. Rio Tãmisa","Rua Carlos Roberto Carraro, 50",4,16,"NAO_INFORMADO","","",-26.215212,-52.670188],
  ["PRD-008",78,"Edifício Bella Citta","Rua Tocantins, 2740",7,4,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.221477,-52.669537],
  ["PRD-009",24,"Edifício Ômega","Rua Itabira, 1565",6,0,"EXTERNO","SEM_ACESSO,COM_CAMERA","",-26.223895,-52.670501],
  ["PRD-010",78,"Residencial Montese","Rua Tocantins, 2708",7,0,"EXTERNO","SEM_ACESSO,COM_CAMERA","",-26.221623,-52.669561],
  ["PRD-011",24,"Ed. Dalla Costa","Rua Itabira, 1695",1,1,"NAO_INFORMADO","","",-26.2239,-52.669931],
  ["PRD-012",14,"Prédio Esquina","Rua Aimoré, 1011",1,4,"NAO_INFORMADO","","Em frente ao Ed. Ana Terra",-26.222402,-52.667516],
  ["PRD-013",35,"Ed. ...prina B.","Rua Itabira",0,4,"EXTERNO","COM_ACESSO","",-26.22393,-52.669671],
  ["PRD-014",24,"Ed. Siena","Rua Itabira",4,8,"SEM_INTERFONE","SEM_ACESSO","",-26.223889,-52.670128],
  ["PRD-015",3,"Prédio sem nome","Rua Itabira, 1143",0,3,"EXTERNO","COM_ACESSO,COM_CAMERA","",-26.224901,-52.673667],
  ["PRD-016",38,"Residencial Ana Terra","Rua Itabira, 1020",7,14,"NAO_INFORMADO","","",-26.225161,-52.674212],
  ["PRD-017",35,"Ed. Angela","Rua Itabira, 1789",4,0,"NAO_INFORMADO","","",-26.223903,-52.669885],
  ["PRD-018",24,"Ed. Rio Sena","Ladeira do Beto, 67",4,48,"EXTERNO","ACESSO_RESTRITO,PEDE_NUM_APTO,TRES_BLOCOS","",-26.223346,-52.669833],
  ["PRD-039",24,"Ed. Fanser Modas","Rua Itabira, 1488",2,6,"EXTERNO","PEDE_NUM_APTO","Fundos nº 1488 (frente p/ Av. Tupi)",-26.223902,-52.670987],
  ["PRD-040",24,"Ed. Maria Angelica","Rua Itabira, 1522",8,24,"EXTERNO","SEM_ACESSO,PEDE_NUM_APTO","",-26.223899,-52.670772],
  ["PRD-041",24,"Ed. Lucia","Rua Itabira, 1532",3,12,"EXTERNO","SEM_ACESSO","",-26.223898,-52.670709],
  ["PRD-042",24,"R. Treviso (?)","Rua Itabira, 1680",3,0,"EXTERNO","SEM_ACESSO","",-26.223895,-52.670003],
  ["PRD-043",24,"R. Piacenza","Rua Itabira, 1650",7,0,"EXTERNO","SEM_ACESSO,COM_CAMERA","",-26.223889,-52.670109],
  ["PRD-045",24,"R. Milano","Rua Itabira, 1700",3,0,"EXTERNO","SEM_ACESSO","",-26.223901,-52.669906],
  ["PRD-046",35,"E. Monte Morió","Rua Itabira, 1730",4,0,"EXTERNO","SEM_ACESSO","",-26.223903,-52.669885],
  ["PRD-047",35,"Edifício Imola","Rua Jaciretã, 240",4,8,"EXTERNO","SEM_ACESSO","",-26.224971,-52.668445],
  ["PRD-048",35,"Residencial Verona","Rua Jaciretã, 232",5,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.224978,-52.668374],
  ["PRD-049",34,"Residencial Florence","Rua Ibiporã, 907",5,11,"NAO_INFORMADO","SEM_ACESSO","",-26.225937,-52.668365],
  ["PRD-050",34,"Edifício Mônaco","Rua Ibiporã, 913",4,8,"EXTERNO","SEM_ACESSO","",-26.225931,-52.668418],
  ["PRD-051",72,"Residencial Torino","Rua Ibiporã, 1091",3,14,"EXTERNO","SEM_ACESSO","",-26.22614,-52.666604],
  ["PRD-052",72,"Residencial Toscana","Rua Ibiporã, 1151",3,23,"EXTERNO","SEM_ACESSO","",-26.226207,-52.666013],
  ["PRD-053",72,"Residencial Taurus","Rua Tupinambá, 182",7,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.225194,-52.665701],
  ["PRD-054",72,"Edifício s/ nome","Rua Tupinambá",3,0,"SEM_INTERFONE","SEM_ACESSO","Sobre o Sublime Pilates",-26.225105,-52.665689],
  ["PRD-056",35,"Bellario I","Rua Itabira, 1770",6,24,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.223903,-52.669885],
  ["PRD-057",35,"Bellario II","Rua Itabira, 1778",3,24,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.223903,-52.669885],
  ["PRD-058",35,"Predio Maqsom","Rua Itabira",2,0,"EXTERNO","","",-26.224043,-52.668556],
  ["PRD-059",72,"Ed. Residencial Petra","Rua Itapuã, 961",7,0,"EXTERNO","INTERFONE_DIGITAL","",-26.225158,-52.666845],
  ["PRD-060",34,"Ed. Dona Frida","Rua Ibiporã, 983",4,8,"EXTERNO","","",-26.225986,-52.667907],
  ["PRD-061",35,"Ed. condomínio Araucária","Rua Aimoré, 90",3,14,"EXTERNO","","",-26.224834,-52.66787],
  ["PRD-062",35,"D. Champs Elicés","Rua Jaciretã, 346",4,0,"EXTERNO","EXIGE_CODIGO","",-26.224978,-52.668374],
  ["PRD-063",35,"Ed. Porto Belo","Rua Jaciretã, 170",4,8,"NAO_INFORMADO","PEDE_NUM_APTO","",-26.224934,-52.6688],
  ["PRD-064",24,"Residencial Palermo","Rua Itabira, 1630",6,0,"EXTERNO","EXIGE_CODIGO","",-26.223889,-52.670109],
  ["PRD-065",35,"Residencial Acopillco","Rua Itabira",15,0,"EXTERNO","","",-26.224043,-52.668556],
  ["PRD-066",35,"Ed. Vitória Piassa","Rua Tocantins, 2362",3,0,"SEM_INTERFONE","SEM_ACESSO","",-26.224579,-52.669969],
  ["PRD-067",35,"Ed. Jatobá","Rua Tocantins, 2396",7,0,"NAO_INFORMADO","COM_CAMERA","",-26.224285,-52.669932],
  ["PRD-068",35,"Condominio Ettore","Rua Goianazes, 625",8,0,"EXTERNO","PEDE_NUM_APTO","",-26.224696,-52.668921],
  ["PRD-069",35,"Ed. Luiz Parzianello","Rua Goianazes, 599",5,0,"NAO_INFORMADO","","",-26.224608,-52.66891],
  ["PRD-071",24,"Edifício s/ nome","Rua Ibiporã, 688",3,0,"SEM_INTERFONE","SEM_ACESSO","",-26.225669,-52.67099],
  ["PRD-072",24,"Edifício s/ nome","Rua Ibiporã, 676",0,1,"EXTERNO","","Esquina c/ Av. Tupi (sobre a loja Brincarão)",-26.225657,-52.671119],
  ["PRD-073",34,"Resid. Barancelli","Rua Ibiporã, 784",6,32,"EXTERNO","PEDE_NUM_APTO","",-26.225771,-52.66991],
  ["PRD-074",24,"Edifício s/ nome","Rua Ibiporã, 742",3,8,"EXTERNO","SEM_ACESSO,PEDE_NUM_APTO","Sobre a loja Intermezzo",-26.225722,-52.670408],
  ["PRD-075",3,"Edifício s/ nome","Rua Itabira, 1266",1,0,"NAO_INFORMADO","COM_ACESSO","Sobre clínica odontológica",-26.224354,-52.672509],
  ["PRD-076",38,"Prédio Pastelaria","Rua Caramuru, 566",1,0,"SEM_INTERFONE","SEM_ACESSO","",-26.226103,-52.674149],
  ["PRD-078",38,"Edificio Rostirola","Rua Caramuru, 586",6,9,"EXTERNO","","",-26.225887,-52.674277],
  ["PRD-079",38,"Edificio Monte Oliveiras","Rua Caramuru, 596",8,0,"EXTERNO","SEM_ACESSO","",-26.225783,-52.674338],
  ["PRD-080",38,"Edificio Aurea","Rua Caramuru, 650",3,7,"EXTERNO","","",-26.22547,-52.674523],
  ["PRD-081",3,"Prédio Chilli Beans","Rua Guarani, 425",3,0,"NAO_INFORMADO","SEM_ACESSO","",-26.225078,-52.673548],
  ["PRD-085",3,"Ed. Alberto Carlos Menosso","Rua Ibiporã, 421",2,2,"EXTERNO","SEM_ACESSO,PEDE_NUM_APTO","",-26.225557,-52.672162],
  ["PRD-086",3,"Prédio Lacqua di Fiori","Rua Ibiporã, 310",1,1,"NAO_INFORMADO","SEM_ACESSO","Entrada lateral (Ed. Atelier Elisa)",-26.225557,-52.672162],
  ["PRD-087",3,"Lojão Sudoeste","Rua Guarani, 365",3,0,"NAO_INFORMADO","COM_ACESSO","Acesso pela escadaria lateral",-26.225579,-52.673245],
  ["PRD-088",3,"Edifício s/ nome","Rua Tapajós, 107",4,8,"EXTERNO","SEM_ACESSO","",-26.225517,-52.6722],
  ["PRD-089",3,"Edifício s/ nome","Rua Ibiporã, 534",1,1,"NAO_INFORMADO","SEM_ACESSO","Sobre a Brasil Cacau",-26.225557,-52.672162],
  ["PRD-090",3,"Edifício s/ nome","Rua Ibiporã, 490",1,1,"NAO_INFORMADO","COM_ACESSO","Sobre a loja Hering",-26.225557,-52.672162],
  ["PRD-091",3,"Edifício s/ nome","Rua Ibiporã, 512",1,1,"SEM_INTERFONE","SEM_ACESSO","Em frente ao O Boticário",-26.225557,-52.672162],
  ["PRD-092",3,"Ed. João Viganó","Rua Tapajós, 104",3,20,"EXTERNO","SEM_ACESSO","",-26.225532,-52.672196],
  ["PRD-093",39,"Residencial Picolo","Avenida Tupi, 2538",3,0,"EXTERNO","SEM_ACESSO,PEDE_NUM_APTO","",-26.228937,-52.671616],
  ["PRD-094",3,"Loja Colombo","Avenida Tupi",3,0,"EXTERNO","SEM_ACESSO,PEDE_NUM_APTO","Sobre a Loja Colombo",-26.226493,-52.67133],
  ["PRD-095",3,"Prédio Boccata","Rua Itabira, 1272",1,1,"SEM_INTERFONE","SEM_ACESSO","Sobre a Boccata",-26.224319,-52.672405],
  ["PRD-096",3,"Edifício s/ nome","Rua Tapajós, 205",1,0,"SEM_INTERFONE","SEM_ACESSO","Sobre a loja de música",-26.225081,-52.672316],
  ["PRD-097",3,"Predio Dentistas","Rua Tapajós, 219",4,0,"SEM_INTERFONE","SEM_ACESSO","Edifício de consultórios odontológicos",-26.224956,-52.672349],
  ["PRD-098",3,"Edifício s/ nome","Avenida Tupi, 141",13,12,"EXTERNO","COM_ACESSO","Em frente à praça",-26.224395,-52.67123],
  ["PRD-195",3,"Prédio Conti Joias","Rua Guarani, 422",4,7,"EXTERNO","SEM_ACESSO","",-26.225103,-52.673533],
  ["PRD-213",3,"Edifício s/ nome","Rua Tapajós, 200",4,6,"NAO_INFORMADO","COM_ACESSO","Prédio da Olímpica Esportes",-26.225125,-52.672304],
  ["PRD-214",3,"Ed. Tapajós","Rua Tapajós, 222",8,18,"EXTERNO","SEM_ACESSO","",-26.224929,-52.672356],
  ["PRD-215",3,"Residencial Bodanese","Avenida Tupi, 2368",7,24,"EXTERNO","SEM_ACESSO","",-26.226634,-52.67135],
  ["PRD-216",3,"Ed. Center Ville","Avenida Tupi, 2200",6,0,"NAO_INFORMADO","","Prédio da Icon",-26.224931,-52.671228],
  ["PRD-246",3,"Edifício s/ nome","Rua Tapajós, 206",3,6,"EXTERNO","SEM_ACESSO","Sobre a sorveteria DG Pop",-26.225072,-52.672318],
  ["PRD-100",38,"Residencial Alpha","Rua Itabira, 1100",8,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.225122,-52.67413],
  ["PRD-102",38,"Residencial Monte Sião","Rua Tamoio, 900",9,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.226383,-52.675427],
  ["PRD-103",38,"Residencial Monte Sinai","Rua Tamoio, 836",9,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.226992,-52.675053],
  ["PRD-104",38,"Edifício Via Duomo","Rua Tamoio, 845",4,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.226921,-52.675093],
  ["PRD-105",38,"Edifício Tamoio","Rua Tamoio, 857",4,8,"EXTERNO","SEM_ACESSO","",-26.22683,-52.675148],
  ["PRD-106",38,"Resid. Monte Morida","Rua Tamoio, 865",10,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.226747,-52.6752],
  ["PRD-107",62,"Edifício Golden Park","Avenida Brasil, 720",3,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.227316,-52.676144],
  ["PRD-108",62,"Ed. Monte Tabor","Avenida Brasil, 736",4,0,"EXTERNO","SEM_ACESSO","",-26.227193,-52.676215],
  ["PRD-109",62,"Resid. Monte Carmelo","Avenida Brasil, 746",11,0,"EXTERNO","EXIGE_CODIGO,DOIS_BLOCOS","Torre 1",-26.227116,-52.67626],
  ["PRD-110",62,"Resid. Monte Hermon","Avenida Brasil, 756",11,0,"EXTERNO","EXIGE_CODIGO,DOIS_BLOCOS","Torre 2",-26.22704,-52.676304],
  ["PRD-111",62,"Edifício s/ nome","Avenida Brasil, 773",3,0,"EXTERNO","COM_ACESSO,EXIGE_CODIGO","",-26.22691,-52.676379],
  ["PRD-112",62,"Edifício Villa Realli","Avenida Brasil, 757",4,36,"EXTERNO","SEM_ACESSO","",-26.227032,-52.676308],
  ["PRD-113",38,"Condomínio Edifício Imperio do Sol","Rua Caramuru, 599",11,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","Sobre a Barbearia Don Ferdinando",-26.225764,-52.674349],
  ["PRD-114",38,"Edifício s/ nome","Rua Caramuru, 623",3,4,"EXTERNO","SEM_ACESSO","Sobre o Empório do Pão",-26.225614,-52.674438],
  ["PRD-115",38,"Edf Estilo Construçoes","Rua Caramuru, 635",3,2,"EXTERNO","COM_ACESSO","",-26.225539,-52.674483],
  ["PRD-116",3,"Resid. Albino Franciosi","Rua Ibiporã, 101",5,0,"EXTERNO","SEM_ACESSO","",-26.225557,-52.672162],
  ["PRD-117",3,"Residencial Ibiporã","Rua Ibiporã, 181",7,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.225557,-52.672162],
  ["PRD-118",3,"Liberty Center","Rua Ibiporã, 283",4,24,"EXTERNO","SEM_ACESSO","",-26.225557,-52.672162],
  ["PRD-217",39,"Edifício s/ nome","Rua Tamoio, s/n",9,36,"NAO_INFORMADO","","",-26.228101,-52.674421],
  ["PRD-218",39,"Condominio Iguatemi","Rua Tamoio, s/n",7,28,"EXTERNO","SEM_ACESSO","",-26.228078,-52.674436],
  ["PRD-219",62,"Ed. Fornari","Rua Ibiporã, s/n",7,28,"EXTERNO","SEM_ACESSO","",-26.226928,-52.675212],
  ["PRD-244",38,"Edifício s/ nome","Rua Caramuru, 495",3,12,"EXTERNO","SEM_ACESSO","Sobre a loja Tralalá",-26.226547,-52.673877],
  ["PRD-232",1,"Edifício s/ nome","Rua Argentina, 2",8,8,"EXTERNO","EXIGE_CODIGO","",-26.228133,-52.678051],
  ["PRD-249",1,"Edifício Vila Veneza","Rua Argentina, 147",3,8,"EXTERNO","","",-26.228664,-52.678258],
  ["PRD-250",7,"Edifício Vila Veneza","Rua Argentina, 229",3,12,"EXTERNO","COM_ACESSO","",-26.229381,-52.67855],
  ["PRD-251",7,"Edifício s/ nome","Rua Chile, 94",3,3,"EXTERNO","EXIGE_CODIGO","",-26.228627,-52.678993],
  ["PRD-253",43,"Residencial Miraggio","Rua Vicente Machado, 191",3,0,"EXTERNO","EXIGE_CODIGO,COM_CAMERA","",-26.23154,-52.685184],
  ["PRD-235",62,"Edifício s/ nome","Rua Itabira, 649",4,4,"NAO_INFORMADO","SEM_ACESSO","",-26.226814,-52.677693],
  ["PRD-239",2,"Edifício José Nacir","Rua Paraná, 1077",4,0,"EXTERNO","SEM_ACESSO","",-26.226456,-52.678084],
  ["PRD-252",80,"Edifício s/ nome","Travessa José Rodrigues Pinto, 172",3,6,"EXTERNO","EXIGE_CODIGO","",-26.227037,-52.679396],
  ["PRD-121",54,"Residencial Efeso","Rua Nelson Germardt, 77",5,5,"EXTERNO","","Bloco 3",-26.211072,-52.688137],
  ["PRD-122",54,"Condominio","Rua Nelson Germardt, 105",6,6,"EXTERNO","","",-26.211066,-52.688143],
  ["PRD-123",54,"Condominio","Rua Nelson Germardt, 131",6,6,"EXTERNO","","",-26.210993,-52.688148],
  ["PRD-124",54,"Resid. Sophalara Pelinson","Rua Ademi Conico, 87",0,4,"NAO_INFORMADO","COM_ACESSO","Rua sem saída",-26.211177,-52.690203],
  ["PRD-125",54,"Res. Jerusalém Bloco III","Rua Clevelândia, 1014",0,0,"EXTERNO","SEM_ACESSO,PEDE_NUM_APTO","",-26.210046,-52.698717],
  ["PRD-126",54,"Condominio Sobrado","Rua Clevelândia, 1163",0,2,"NAO_INFORMADO","","",-26.210063,-52.699044],
  ["PRD-127",54,"Condominio S/N","Rua Clevelândia, 1230",0,2,"EXTERNO","","Sobre o mercado Zanela",-26.210059,-52.69896],
  ["PRD-128",54,"Residencial Betez","Rua Campo Seguro",0,20,"EXTERNO","SEM_ACESSO,CONDOMINIO_CASAS","",-26.209571,-52.698975],
  ["PRD-129",54,"Residencial Jerusalém I","Rua Campo Seguro, 83",0,0,"EXTERNO","SEM_ACESSO","",-26.209568,-52.698892],
  ["PRD-130",54,"Residencial Jerusalém II","Rua Campo Seguro, 75",0,0,"EXTERNO","SEM_ACESSO","",-26.209568,-52.698892],
  ["PRD-131",55,"Condominio","Rua José Fraron, 959",0,10,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.207347,-52.690089],
  ["PRD-132",54,"Residencial","R. Maria Martino Levesso, 186",0,4,"EXTERNO","SEM_ACESSO","",-26.208019,-52.690503],
  ["PRD-134",52,"Condominio S/N","Rua Vinicius de Moraes, 391",0,4,"SEM_INTERFONE","COM_ACESSO","",-26.211679,-52.685831],
  ["PRD-135",52,"Condominio S/N","Rua José Tato, 552",0,5,"EXTERNO","SEM_ACESSO,CONDOMINIO_CASAS","",-26.211808,-52.683238],
  ["PRD-136",52,"Condominio S/N","Rua Joaquim Nabuco, 440",0,6,"SEM_INTERFONE","SEM_ACESSO,CONDOMINIO_CASAS","",-26.211644,-52.684949],
  ["PRD-137",52,"Condominio S/N","Rua Joaquim Nabuco, 25",0,5,"SEM_INTERFONE","SEM_ACESSO,CONDOMINIO_CASAS","",-26.21156,-52.684945],
  ["PRD-138",52,"Condominio S/N","Rua Joaquim Nabuco, 35",0,0,"SEM_INTERFONE","SEM_ACESSO,CONDOMINIO_CASAS","",-26.211476,-52.68494],
  ["PRD-139",52,"Condominio S/N","Rua Joaquim Nabuco, 39",0,0,"SEM_INTERFONE","SEM_ACESSO,CONDOMINIO_CASAS","",-26.211392,-52.684936],
  ["PRD-140",52,"Condominio S/N","Rua Joaquim Nabuco, 45",0,0,"SEM_INTERFONE","SEM_ACESSO,CONDOMINIO_CASAS","",-26.211886,-52.684961],
  ["PRD-141",52,"Condominio S/N","Rua Joaquim Nabuco, 109",0,0,"SEM_INTERFONE","COM_ACESSO,CONDOMINIO_CASAS","",-26.211813,-52.684959],
  ["PRD-142",52,"Condominio Castel Verde","Rua Joaquim Nabuco, 385",0,3,"NAO_INFORMADO","CONDOMINIO_CASAS","Casas 385, 387 e 389",-26.211728,-52.684954],
  ["PRD-237",53,"Corteo residence","Rua José Fraron, 160",4,0,"EXTERNO","SEM_ACESSO","",-26.206977,-52.682858],
  ["PRD-241",48,"Edifício s/ nome","Rua Nereu Ramos, 1075",4,0,"EXTERNO","SEM_ACESSO,PEDE_NUM_APTO","",-26.217251,-52.673526],
  ["PRD-248",49,"Edifício s/ nome","Rua Manuel Ribas, 469",3,0,"EXTERNO","","Sobre a Refrigeração Escopel",-26.216145,-52.663343],
  ["PRD-146",71,"Edifício Compagnoni","Rua Iguaçu, 1265",2,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.227424,-52.664714],
  ["PRD-147",71,"Ed. Residencial Genova","Rua Tupinambá, 177",8,0,"EXTERNO","EXIGE_CODIGO","",-26.226764,-52.665915],
  ["PRD-148",72,"Prédio Amora Cosméticos","Rua Ibiporã, 1166",3,4,"EXTERNO","SEM_ACESSO","",-26.226225,-52.665852],
  ["PRD-149",72,"Prédio Ciber tech","Rua Ibiporã, 1180",3,4,"EXTERNO","PEDE_NUM_APTO","",-26.226242,-52.665701],
  ["PRD-150",3,"Prédio Farmacia Bela Vita","Rua Itabira, 1200",2,4,"SEM_INTERFONE","COM_ACESSO","",-26.224644,-52.673179],
  ["PRD-221",67,"Residencial Atlantes","Trav. Indus, 51",6,0,"EXTERNO","EXIGE_CODIGO","",-26.228904,-52.66604],
  ["PRD-247",71,"Edifício s/ nome","Rua Daniel Pagnoncelli, 334",3,6,"EXTERNO","EXIGE_CODIGO","",-26.226996,-52.6627],
  ["PRD-151",34,"Edifício s/ nome","Rua Iguaçu, 892",2,4,"EXTERNO","SEM_ACESSO","",-26.22696,-52.668874],
  ["PRD-152",34,"Lebron","Rua Iguaçu, 888",4,0,"EXTERNO","SEM_ACESSO","Edifício misto (comercial e residencial)",-26.226955,-52.668924],
  ["PRD-153",37,"Edifício Premium","Avenida Tupi, 2695",10,14,"EXTERNO","SEM_ACESSO","",-26.229507,-52.671594],
  ["PRD-154",36,"Ed. Clotilde Amadora","Rua Tocantins, 260",11,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO,COM_CAMERA","",-26.228133,-52.670481],
  ["PRD-155",36,"Ed. Ottilio Amadori","Rua Tocantins, 2075",19,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.22802,-52.670465],
  ["PRD-197",36,"Residencial Parma","Rua Itapuã, 804",7,0,"EXTERNO","EXIGE_CODIGO","",-26.22902,-52.667396],
  ["PRD-202",36,"Ed. Aimoré","Rua Aimoré, 312",8,0,"EXTERNO","PEDE_NUM_APTO,COM_CAMERA","",-26.22847,-52.66838],
  ["PRD-220",36,"Prédio da Dimare","Rua Goianazes, 365",7,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO","",-26.228587,-52.669468],
  ["PRD-224",36,"Sunset Yellow","Rua Goianazes, 510",6,23,"NAO_INFORMADO","","",-26.228855,-52.669506],
  ["PRD-234",36,"Residencial Bergamo","Rua Goianazes, 331",6,0,"EXTERNO","SEM_ACESSO,COM_CAMERA","",-26.228587,-52.669468],
  ["PRD-245",39,"Ed. Cancún","Rua Araribóia, 628",3,0,"EXTERNO","","",-26.228659,-52.674088],
  ["PRD-158",39,"Edifício s/ nome","Avenida Tupi, 55",3,4,"EXTERNO","SEM_ACESSO","Prédio da Paraná Plástico",-26.228937,-52.671616],
  ["PRD-159",39,"Edifício s/ nome","Avenida Tupi, 47",3,0,"NAO_INFORMADO","COM_ACESSO","Sobre a Magazine Avenida",-26.228937,-52.671616],
  ["PRD-160",39,"Edifício s/ nome","Avenida Tupi, 2574",2,0,"EXTERNO","SEM_ACESSO","",-26.228937,-52.671616],
  ["PRD-161",39,"Ed. Palacio dos Arcos","Rua Pedro Ramires de Mello, 47",4,12,"NAO_INFORMADO","COM_ACESSO","",-26.227911,-52.672528],
  ["PRD-162",39,"Ed. Cavazzole","Rua Pedro Ramires de Mello, 21",10,18,"EXTERNO","ACESSO_RESTRITO","",-26.227821,-52.672348],
  ["PRD-163",3,"Edifício s/ nome","Rua Guarani, 2574",2,0,"NAO_INFORMADO","","Ao lado do Hotel San Pietro",-26.22637,-52.672769],
  ["PRD-164",39,"Ed. Janaina Cent","Rua Caramuru",3,12,"EXTERNO","SEM_ACESSO","",-26.229887,-52.672711],
  ["PRD-165",39,"Edifício s/ nome","Rua Caramuru, 107",3,12,"EXTERNO","SEM_ACESSO","",-26.229563,-52.672666],
  ["PRD-167",39,"Hotel Luz","Rua Araribóia",3,74,"NAO_INFORMADO","","",-26.228753,-52.673181],
  ["PRD-168",39,"Condominío Ouro Negro","Rua Caramuru, 331",6,6,"EXTERNO","SEM_ACESSO","Esquina c/ Rua Pedro Ramires de Mello",-26.227965,-52.673021],
  ["PRD-169",63,"Condomínio Leonardo Frederico","Rua Pedro Ramires de Mello",2,10,"EXTERNO","SEM_ACESSO","",-26.228749,-52.674281],
  ["PRD-170",63,"Residencial Ágape II","Rua Pedro Ramires de Mello",11,44,"EXTERNO","SEM_ACESSO","",-26.228704,-52.674185],
  ["PRD-171",39,"Ed. Dom Pedro","Rua Caramuru",13,48,"EXTERNO","SEM_ACESSO","",-26.229887,-52.672711],
  ["PRD-172",39,"Condomínio Eugênio","Avenida Tupi, 2660",6,0,"EXTERNO","","",-26.229357,-52.67165],
  ["PRD-173",37,"Ed. Vivaldi","Avenida Tupi, 2692",14,0,"EXTERNO","INTERFONE_DIGITAL","",-26.229446,-52.671589],
  ["PRD-174",37,"Ed. Colibri","Rua Itacolomi, 830",8,0,"EXTERNO","SEM_ACESSO","",-26.230117,-52.671647],
  ["PRD-175",3,"Edifício s/ nome","Rua Guarani, 141",12,0,"NAO_INFORMADO","SEM_ACESSO","Próximo à Leve Confecções",-26.227245,-52.672251],
  ["PRD-176",39,"Resid. Verissimo Rizzi","Rua Pedro Ramires de Mello, 20",16,0,"EXTERNO","SEM_ACESSO,INTERFONE_DIGITAL","",-26.227818,-52.672341],
  ["PRD-177",3,"Edifício s/ nome","Rua Guarani, 27",3,6,"EXTERNO","","Ao lado da Paraná Plástico",-26.228139,-52.67174],
  ["PRD-178",63,"Ed. Centro Médico","Rua Pedro Ramires de Mello, 396",4,0,"SEM_INTERFONE","COM_ACESSO","",-26.229637,-52.676133],
  ["PRD-179",63,"Ed. Monte Ararate","Rua Paraná, 804",8,0,"EXTERNO","SEM_ACESSO,EXIGE_CODIGO,COM_CAMERA","",-26.228978,-52.676626],
  ["PRD-180",63,"Condominio Unicenter","Rua Pedro Ramires de Mello, 326",3,0,"SEM_INTERFONE","SEM_ACESSO","",-26.229187,-52.675208],
  ["PRD-181",39,"Edificio Tonetti","Rua Tamoio, 633",2,4,"EXTERNO","SEM_ACESSO","",-26.228589,-52.67413],
  ["PRD-182",39,"Resid. Monte Efraim","Rua Tamoio, 600",9,4,"NAO_INFORMADO","EM_REFORMA","",-26.228845,-52.673971],
  ["PRD-183",63,"Edifício s/ nome","Rua Pedro Ramires de Mello, 274",0,4,"EXTERNO","COM_ACESSO","Edifício misto (4 aptos residenciais)",-26.22886,-52.674517],
  ["PRD-184",63,"Edificio Lorenzo","Rua Pedro Ramires de Mello, 258",9,0,"EXTERNO","EXIGE_CODIGO","",-26.22876,-52.674304],
  ["PRD-185",63,"Edificio Hospital de Olhos","Rua Pedro Ramires de Mello, 256",3,0,"SEM_INTERFONE","COM_ACESSO","Edifício comercial (Hospital de Olhos)",-26.228748,-52.674278],
  ["PRD-186",39,"Edifício s/ nome","Rua Pedro Ramires de Mello, 76",3,12,"NAO_INFORMADO","SEM_ACESSO","Esquina c/ Papelaria Apolo",-26.227988,-52.672682],
  ["PRD-187",39,"Edifício s/ nome","Rua Pedro Ramires de Mello, 60",2,3,"SEM_INTERFONE","COM_ACESSO","Sobre a Papelaria Apolo",-26.227922,-52.672551],
  ["PRD-188",39,"Edifício s/ nome","Rua Araribóia, 774",3,0,"NAO_INFORMADO","SEM_ACESSO,EM_REFORMA","",-26.228659,-52.674088],
  ["PRD-189",39,"Cora Coralina","Rua Araribóia, 784",6,0,"EXTERNO","SEM_ACESSO","",-26.228659,-52.674088],
  ["PRD-199",67,"Ed. Adão de Oliveira","Rua Sergipe, 55",5,0,"EXTERNO","SEM_ACESSO,PEDE_NUM_APTO","",-26.230374,-52.664263],
  ["PRD-200",67,"Ed. Leonidas de Oliveira","Rua Sergipe, 23",4,0,"EXTERNO","SEM_ACESSO","",-26.230374,-52.664263],
  ["PRD-201",39,"Ed. Maria de Oliveira","Rua Araribóia, 1032",5,0,"EXTERNO","SEM_ACESSO","",-26.228659,-52.674088],
  ["PRD-198",14,"Condominio Vila Nova","Rua Itapuã, 605",4,0,"EXTERNO","","",-26.222616,-52.666459]
];
