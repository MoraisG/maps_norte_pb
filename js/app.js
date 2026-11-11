/**
 * Controlador Principal da Aplicação PWA — Gestão de Territórios Congregação Norte PB
 * Padrão Visual: Google Material Design 3 Minimalista
 * Regras de Negócio:
 * - Fila estrita dos 5 territórios mais antigos disponíveis (seleção de até 3 por vez com LockService anti-concorrência)
 * - Devolução em 2 etapas (Completo -> 120d | Não Completo -> Quadras faltantes, Prédios não trabalhados ou Não iniciado)
 * - Guia de Prédios integrado ao cartão com marcação macro de prédio trabalhado (LGPD Privacy by Design)
 */
const App = {
  usuarioAtual: null,
  territorios: [],
  usuariosAdmin: [],
  territoriosSelecionados: new Set(),

  init() {
    this.registrarServiceWorker();
    this.configurarEventosUI();

    const token = ApiClient.obterTokenSessao();
    const usr = ApiClient.obterUsuarioSessao();
    if (token && usr) {
      this.usuarioAtual = usr;
      this.entrarModoAutenticado();
    } else {
      this.inicializarBotaoGoogle();
    }

    window.addEventListener("sessao-expirada", () => {
      this.sairParaTelaLogin("Sua sessão expirou. Por favor, entre novamente com sua conta Google.");
    });
  },

  registrarServiceWorker() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  },

  configurarEventosUI() {
    document.getElementById("btn-logout").addEventListener("click", () => this.executarLogout());
    document.getElementById("btn-refresh").addEventListener("click", () => this.sincronizarDados());

    document.querySelectorAll(".nav-tab").forEach(btn => {
      btn.addEventListener("click", () => this.alternarAba(btn.dataset.tab));
    });

    document.getElementById("filter-search").addEventListener("input", () => this.renderizarCardsTerritorios());
    document.getElementById("filter-status").addEventListener("change", () => {
      this.limparSelecaoLote();
      this.renderizarCardsTerritorios();
    });
    document.getElementById("filter-tipo").addEventListener("change", () => {
      this.limparSelecaoLote();
      this.renderizarCardsTerritorios();
    });

    // Barra flutuante de seleção em lote (até 3 de 5)
    const btnLimparSel = document.getElementById("btn-limpar-selecao");
    const btnSolicitarLote = document.getElementById("btn-solicitar-lote");
    if (btnLimparSel) {
      btnLimparSel.addEventListener("click", () => this.limparSelecaoLote());
    }
    if (btnSolicitarLote) {
      btnSolicitarLote.addEventListener("click", () => this.acaoSolicitarLote());
    }

    // Dashboard e Relatório S-13
    this.inicializarSeletorAnoServico();
    const inputDashSearch = document.getElementById("dash-search-ocupados");
    if (inputDashSearch) {
      inputDashSearch.addEventListener("input", () => this.renderizarDashboardOcupacao());
    }
    const btnGerarPdf = document.getElementById("btn-gerar-pdf-ano-servico");
    if (btnGerarPdf) {
      btnGerarPdf.addEventListener("click", () => this.exportarRelatorioPdfAnoServico());
    }

    // Modal do Mapa e Prédios do Cartão
    const btnCloseModal = document.getElementById("btn-close-modal-mapa");
    const btnFecharModal = document.getElementById("btn-fechar-modal-mapa");
    const modalMapa = document.getElementById("modal-mapa-territorio");

    if (btnCloseModal) {
      btnCloseModal.addEventListener("click", () => MapaTerritorios.fecharModalTerritorio());
    }
    if (btnFecharModal) {
      btnFecharModal.addEventListener("click", () => MapaTerritorios.fecharModalTerritorio());
    }
    if (modalMapa) {
      modalMapa.addEventListener("click", e => {
        if (e.target === modalMapa) MapaTerritorios.fecharModalTerritorio();
      });
    }
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") MapaTerritorios.fecharModalTerritorio();
    });

    // Painel Admin
    document.getElementById("form-admin-usuario").addEventListener("submit", e => {
      e.preventDefault();
      this.salvarUsuarioWhitelist();
    });

    document.getElementById("btn-admin-lembretes").addEventListener("click", () => this.dispararLembretesAdmin());
    document.getElementById("btn-refresh-audit").addEventListener("click", () => this.carregarDadosAdmin());
  },

  inicializarBotaoGoogle() {
    const clientId = ApiClient.getClientId();
    const container = document.getElementById("google-btn-container");

    if (!clientId) {
      container.innerHTML = `
        <p class="text-xs text-[#b3261e] bg-[#fce8e6] border border-[#f6aea9] px-3.5 py-2.5 rounded-2xl">
          Serviço de autenticação indisponível no momento. Contate o administrador.
        </p>`;
      return;
    }

    if (!window.google || !window.google.accounts || !window.google.accounts.id) {
      setTimeout(() => this.inicializarBotaoGoogle(), 400);
      return;
    }

    container.innerHTML = "";
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: response => this.processarCallbackGoogle(response),
      auto_select: false
    });

    window.google.accounts.id.renderButton(container, {
      theme: "outline",
      size: "large",
      shape: "pill",
      text: "signin_with",
      locale: "pt-BR",
      width: 280
    });
  },

  async processarCallbackGoogle(response) {
    const alertBox = document.getElementById("login-alert");
    const loadingText = document.getElementById("login-loading");
    alertBox.classList.add("hidden");
    loadingText.classList.remove("hidden");

    try {
      const res = await ApiClient.request("auth/login", { idToken: response.credential }, false);
      ApiClient.salvarSessao(res.sessionToken, res.usuario, res.expiraEm);
      this.usuarioAtual = res.usuario;
      this.entrarModoAutenticado();
    } catch (err) {
      document.getElementById("login-alert-msg").textContent =
        err.message || "Seu usuário não possui autorização para utilizar este sistema.";
      alertBox.classList.remove("hidden");
    } finally {
      loadingText.classList.add("hidden");
    }
  },

  entrarModoAutenticado() {
    document.getElementById("view-login").classList.add("hidden");
    document.getElementById("view-app").classList.remove("hidden");

    document.getElementById("header-user-info").textContent =
      `${this.usuarioAtual.nome} (${this.usuarioAtual.email})`;

    const badgeRole = document.getElementById("badge-role");
    badgeRole.textContent = this.usuarioAtual.perfil;

    const btnAdmin = document.getElementById("nav-btn-admin");
    const selectStatus = document.getElementById("filter-status");
    const inputSearch = document.getElementById("filter-search");

    if (this.usuarioAtual.perfil === "ADMIN") {
      btnAdmin.classList.remove("hidden");
      if (selectStatus) selectStatus.classList.remove("hidden");
      if (inputSearch) inputSearch.classList.remove("hidden");
      badgeRole.className = "px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full bg-[#fef7e0] text-[#b06000] border border-[#f5d087]";
    } else {
      btnAdmin.classList.add("hidden");
      if (selectStatus) {
        selectStatus.value = "FILA_5";
        selectStatus.classList.add("hidden");
      }
      if (inputSearch) {
        inputSearch.value = "";
        inputSearch.classList.add("hidden");
      }
      badgeRole.className = "px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded-full bg-[#d3e3fd] text-[#041e49]";
    }

    this.sincronizarDados();
  },

  async executarLogout() {
    try {
      await ApiClient.request("auth/logout", {});
    } catch (e) {}
    this.sairParaTelaLogin();
  },

  sairParaTelaLogin(mensagemErro = "") {
    ApiClient.limparSessaoLocal();
    this.usuarioAtual = null;
    this.territoriosSelecionados.clear();
    this.atualizarBarraSelecaoFlutuante();
    document.getElementById("view-app").classList.add("hidden");
    document.getElementById("view-login").classList.remove("hidden");

    if (mensagemErro) {
      document.getElementById("login-alert-msg").textContent = mensagemErro;
      document.getElementById("login-alert").classList.remove("hidden");
    } else {
      document.getElementById("login-alert").classList.add("hidden");
    }
    this.inicializarBotaoGoogle();
  },

  alternarAba(tabId) {
    document.querySelectorAll(".tab-panel").forEach(sec => sec.classList.add("hidden"));
    document.querySelectorAll(".nav-tab").forEach(btn => btn.classList.remove("active-tab"));

    const alvo = document.getElementById(tabId);
    if (alvo) alvo.classList.remove("hidden");

    const btnAtivo = document.querySelector(`.nav-tab[data-tab="${tabId}"]`);
    if (btnAtivo) btnAtivo.classList.add("active-tab");

    if (tabId !== "tab-territorios") {
      document.getElementById("floating-selection-bar")?.classList.add("hidden");
      document.getElementById("floating-selection-bar")?.classList.remove("flex");
    } else {
      this.atualizarBarraSelecaoFlutuante();
    }

    if (tabId === "tab-mapa") {
      MapaTerritorios.inicializar();
      MapaTerritorios.renderizarPoligonos(this.territorios);
    } else if (tabId === "tab-dashboard") {
      this.renderizarDashboardOcupacao();
    } else if (tabId === "tab-historico") {
      this.carregarMeuHistorico();
    } else if (tabId === "tab-admin" && this.usuarioAtual && this.usuarioAtual.perfil === "ADMIN") {
      this.carregarDadosAdmin();
    }
  },

  async sincronizarDados() {
    if (this.sincronizando) return;
    this.sincronizando = true;
    try {
      const res = await ApiClient.request("territorios/listar");
      const listaBruta = res.territorios || [];
      this.aplicarListaTerritoriosServidor(listaBruta);
      Utils.mostrarToast(" Fila e mapas sincronizados!", "sucesso");
    } catch (err) {
      Utils.mostrarToast(err.message, "erro");
    } finally {
      this.sincronizando = false;
    }
  },

  aplicarListaTerritoriosServidor(listaBruta) {
    this.territorios = this.ordenarPorAntiguidade(this.normalizarTerritorios(listaBruta));

    // Remove da seleção qualquer território que não esteja mais disponível na fila de 5
    const fila5Set = new Set(this.obterFilaCincoDisponiveis().map(t => Number(t.numero)));
    for (const numSel of Array.from(this.territoriosSelecionados)) {
      if (!fila5Set.has(Number(numSel))) {
        this.territoriosSelecionados.delete(numSel);
      }
    }

    this.atualizarIndicadores();
    this.renderizarCardsTerritorios();
    this.renderizarMeusTerritorios();
    this.renderizarDashboardOcupacao();
    this.atualizarBarraSelecaoFlutuante();

    if (MapaTerritorios.inicializado) {
      MapaTerritorios.renderizarPoligonos(this.territorios);
    }
    if (MapaTerritorios.territorioModalAtual) {
      MapaTerritorios.abrirModalTerritorio(MapaTerritorios.territorioModalAtual);
    }
  },

  normalizarTerritorios(lista) {
    return lista.map(t => {
      const copia = { ...t };
      if (copia.statusReal !== "OCUPADO") {
        const dias = Utils.calcularDiasDesdeData(copia.ultimaData);
        copia.diasDesdeDevolucao = dias;
        copia.statusReal = dias > Utils.DIAS_QUARENTENA_DEVOLUCAO ? "DISPONÍVEL" : "RECENTE";
      } else {
        copia.diasDesdeDevolucao = 0;
      }
      return copia;
    });
  },

  /**
   * Retorna os 5 territórios mais antigos atualmente disponíveis para solicitação (Regra da Fila Top 5)
   */
  obterFilaCincoDisponiveis(filtroTipoOpcional) {
    const filtroTipo = filtroTipoOpcional || (document.getElementById("filter-tipo")?.value || "TODOS");
    const disponiveisOrdenados = this.ordenarPorAntiguidade(
      this.territorios.filter(t => {
        if (t.statusReal !== "DISPONÍVEL") return false;
        const dias = Utils.calcularDiasDesdeData(t.ultimaData);
        if (dias <= Utils.DIAS_QUARENTENA_DEVOLUCAO) return false;
        if (filtroTipo !== "TODOS" && t.tipo !== filtroTipo) return false;
        return true;
      })
    );
    return disponiveisOrdenados.slice(0, Utils.LIMITE_FILA_EXIBICAO);
  },

  /**
   * Verifica se o território pode ser solicitado:
   * - Deve estar DISPONÍVEL (> 120 dias)
   * - Para publicadores (ou modo Fila Top 5), deve constar nos 5 primeiros da fila de antiguidade
   */
  podeSolicitarTerritorio(t) {
    if (!t || t.statusReal === "OCUPADO") return false;
    const dias = Utils.calcularDiasDesdeData(t.ultimaData);
    if (dias <= Utils.DIAS_QUARENTENA_DEVOLUCAO || t.statusReal !== "DISPONÍVEL") return false;

    const modoStatus = document.getElementById("filter-status")?.value || "FILA_5";
    if (this.usuarioAtual && this.usuarioAtual.perfil === "ADMIN" && modoStatus !== "FILA_5") {
      return true;
    }
    const fila5 = this.obterFilaCincoDisponiveis();
    return fila5.some(item => Number(item.numero) === Number(t.numero));
  },

  ordenarPorAntiguidade(lista) {
    return [...lista].sort((a, b) => {
      const aOcupado = a.statusReal === "OCUPADO" ? 1 : 0;
      const bOcupado = b.statusReal === "OCUPADO" ? 1 : 0;
      if (aOcupado !== bOcupado) return aOcupado - bOcupado;

      const tsA = Utils.obterTimestampData(a.ultimaData);
      const tsB = Utils.obterTimestampData(b.ultimaData);
      if (tsA !== tsB) return tsA - tsB;

      return Number(a.numero) - Number(b.numero);
    });
  },

  atualizarIndicadores() {
    const disp = this.territorios.filter(t => t.statusReal === "DISPONÍVEL").length;
    const ocup = this.territorios.filter(t => t.statusReal === "OCUPADO").length;
    const rec = this.territorios.filter(t => t.statusReal === "RECENTE").length;
    const meus = this.territorios.filter(t => t.emMinhaPosse).length;
    const fila5 = this.obterFilaCincoDisponiveis();

    document.getElementById("kpi-disponiveis").textContent = disp;
    document.getElementById("kpi-ocupados").textContent = ocup;
    document.getElementById("kpi-recentes").textContent = rec;
    document.getElementById("kpi-comigo").textContent = meus;
    document.getElementById("count-all").textContent = fila5.length;
    document.getElementById("count-mine").textContent = meus;
    const badgeOcupNav = document.getElementById("count-ocupados-nav");
    if (badgeOcupNav) badgeOcupNav.textContent = ocup;
  },

  alternarSelecaoTerritorio(numero) {
    const num = Number(numero);
    if (this.territoriosSelecionados.has(num)) {
      this.territoriosSelecionados.delete(num);
    } else {
      if (this.territoriosSelecionados.size >= Utils.LIMITE_SELECAO_LOTE) {
        Utils.mostrarToast(`Você pode selecionar no máximo ${Utils.LIMITE_SELECAO_LOTE} territórios dos ${Utils.LIMITE_FILA_EXIBICAO} disponíveis na fila.`, "aviso");
        return;
      }
      this.territoriosSelecionados.add(num);
    }
    this.renderizarCardsTerritorios();
    this.atualizarBarraSelecaoFlutuante();
  },

  limparSelecaoLote() {
    this.territoriosSelecionados.clear();
    this.renderizarCardsTerritorios();
    this.atualizarBarraSelecaoFlutuante();
  },

  atualizarBarraSelecaoFlutuante() {
    const qtd = this.territoriosSelecionados.size;
    const badgeTop = document.getElementById("queue-selection-badge");
    if (badgeTop) {
      badgeTop.textContent = `${qtd} de ${Utils.LIMITE_SELECAO_LOTE} selecionados`;
      badgeTop.className = qtd > 0
        ? "px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-[#0b57d0] text-white"
        : "px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-700";
    }

    const bar = document.getElementById("floating-selection-bar");
    if (!bar) return;

    const abaTerritoriosAtiva = !document.getElementById("tab-territorios")?.classList.contains("hidden");
    if (qtd === 0 || !abaTerritoriosAtiva) {
      bar.classList.add("hidden");
      bar.classList.remove("flex");
      return;
    }

    const nums = Array.from(this.territoriosSelecionados).sort((a, b) => a - b);
    document.getElementById("floating-selection-count").textContent = String(qtd);
    document.getElementById("floating-selection-label").textContent =
      `${qtd} de ${Utils.LIMITE_SELECAO_LOTE} território(s): ${nums.map(n => `T-${n}`).join(", ")}`;
    document.getElementById("floating-selection-sub").textContent =
      `Reserva protegida contra concorrência`;

    bar.classList.remove("hidden");
    bar.classList.add("flex");
  },

  renderizarCardsTerritorios() {
    const busca = (document.getElementById("filter-search")?.value || "").toLowerCase().trim();
    const filtroStatus = document.getElementById("filter-status")?.value || "FILA_5";
    const filtroTipo = document.getElementById("filter-tipo")?.value || "TODOS";

    const fila5 = this.obterFilaCincoDisponiveis(filtroTipo);
    const fila5MapPosicao = new Map();
    fila5.forEach((t, idx) => fila5MapPosicao.set(Number(t.numero), idx + 1));

    let listaExibicao = [];
    if (filtroStatus === "FILA_5" || !this.usuarioAtual || this.usuarioAtual.perfil !== "ADMIN") {
      listaExibicao = fila5;
    } else {
      listaExibicao = this.ordenarPorAntiguidade(
        this.territorios.filter(t => {
          if (filtroStatus !== "TODOS" && t.statusReal !== filtroStatus) return false;
          if (filtroTipo !== "TODOS" && t.tipo !== filtroTipo) return false;
          if (busca) {
            const texto = `${t.numero} ${t.bairro} ${t.dirigente || ""}`.toLowerCase();
            if (!texto.includes(busca)) return false;
          }
          return true;
        })
      );
    }

    const container = document.getElementById("grid-territorios");
    if (!listaExibicao.length) {
      container.innerHTML = `
        <div class="col-span-full bg-white border border-slate-200 rounded-2xl text-center py-10 px-4 text-slate-500 text-xs">
          Nenhum território disponível na fila para o filtro selecionado no momento.
        </div>`;
      return;
    }

    container.innerHTML = listaExibicao.map(t =>
      this.criarHtmlCardTerritorio(t, fila5MapPosicao.get(Number(t.numero)) || null)
    ).join("");
  },

  renderizarMeusTerritorios() {
    const meus = this.territorios.filter(t => t.emMinhaPosse);
    const container = document.getElementById("grid-meus-territorios");

    if (!meus.length) {
      container.innerHTML = `
        <div class="col-span-full bg-white border border-slate-200 rounded-2xl p-8 text-center">
          <p class="text-sm font-bold text-slate-800">Você não possui cartões de território em sua posse no momento.</p>
          <p class="text-xs text-slate-500 mt-1">Acesse a aba "Solicitar" para escolher até 3 dos 5 territórios da fila de antiguidade.</p>
        </div>`;
      return;
    }

    container.innerHTML = meus.map(t => this.criarHtmlCardTerritorio(t, null)).join("");
  },

  criarHtmlCardTerritorio(t, posicaoFila = null) {
    const num = Number(t.numero);
    const naFila5 = Boolean(posicaoFila);
    const selecionado = this.territoriosSelecionados.has(num);
    const { badgeClass, label: statusLabel } = Utils.obterEstiloStatus(t, naFila5);
    const predios = Array.isArray(t.predios) ? t.predios : [];
    const qtdPredios = predios.length;
    const prediosConcluidos = predios.filter(p => p.trabalhadoNesteCiclo || p.ultimaDataConclusao).length;

    const infoPosse = t.statusReal === "OCUPADO"
      ? `<p class="text-xs text-[#b06000] font-medium mt-2">👤 Com: <strong>${Utils.escapeHtml(t.dirigente || "Dirigente")}</strong> desde ${Utils.formatarDataBr(t.ultimaData)}</p>`
      : `<p class="text-xs text-slate-500 mt-2">📅 Última conclusão: <strong>${Utils.formatarDataBr(t.ultimaData)}</strong></p>`;

    const infoPredios = qtdPredios > 0
      ? `<div class="mt-2.5 flex items-center justify-between gap-2 px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-200/80">
          <span class="text-[11px] font-semibold text-slate-700">🏢 ${qtdPredios} prédio(s) no cartão</span>
          <button type="button" onclick="MapaTerritorios.abrirModalTerritorio(${num})" class="text-[11px] font-bold text-[#0b57d0] hover:underline">
            ${t.statusReal === "OCUPADO" ? `${prediosConcluidos}/${qtdPredios} trabalhados →` : "Ver interfones →"}
          </button>
        </div>`
      : `<div class="mt-2.5 px-3 py-1.5 rounded-xl bg-slate-50/60 border border-slate-100 text-[11px] text-slate-400">
          Residencial horizontal (sem prédios verticais)
        </div>`;

    let areaAcoes = "";
    if (this.podeSolicitarTerritorio(t)) {
      areaAcoes = `
        <button type="button" onclick="App.alternarSelecaoTerritorio(${num})"
          class="flex-1 py-2 px-3 rounded-full text-xs font-semibold transition flex items-center justify-center gap-1.5 ${
            selecionado
              ? "bg-[#0b57d0] text-white shadow-xs"
              : "bg-[#d3e3fd] hover:bg-[#c2d7fc] text-[#041e49]"
          }">
          <span>${selecionado ? "✓ Selecionado" : "Selecionar"}</span>
        </button>
        <button type="button" onclick="App.acaoSolicitar(${num})"
          class="py-2 px-3.5 rounded-full border border-[#0b57d0] text-[#0b57d0] hover:bg-[#f0f6ff] font-semibold text-xs transition"
          title="Solicitar apenas este território imediatamente">
          Solicitar 1
        </button>
      `;
    } else if (t.statusReal === "OCUPADO" && (t.emMinhaPosse || (this.usuarioAtual && this.usuarioAtual.perfil === "ADMIN"))) {
      areaAcoes = `
        <button type="button" onclick="App.acaoDevolver(${num})" class="flex-1 m3-btn-filled text-xs">
          Devolver Território
        </button>`;
    } else if (t.statusReal === "RECENTE") {
      areaAcoes = `
        <button disabled class="flex-1 py-2 px-3 rounded-full bg-slate-100 text-slate-400 font-semibold text-xs cursor-not-allowed">
          Em descanso (&le; 120 dias)
        </button>`;
    } else {
      areaAcoes = `
        <button disabled class="flex-1 py-2 px-3 rounded-full bg-slate-100 text-slate-400 font-semibold text-xs cursor-not-allowed">
          ${t.statusReal === "OCUPADO" ? "Em Campo" : "Aguardando Fila"}
        </button>`;
    }

    const btnMapa = t.wkt
      ? `<button type="button" onclick="MapaTerritorios.abrirModalTerritorio(${num})" class="py-2 px-3.5 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition" title="Abrir mapa e guia de prédios">
          🗺️ Mapa${qtdPredios ? ` (${qtdPredios})` : ""}
        </button>`
      : "";

    const badgeFila = posicaoFila
      ? `<span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-[#d3e3fd] text-[#041e49]">#${posicaoFila} da Fila</span>`
      : "";

    return `
      <article class="m3-card p-4 flex flex-col justify-between ${selecionado || t.emMinhaPosse ? "selected-card" : ""}">
        <div>
          <div class="flex items-start justify-between gap-2">
            <div>
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">${Utils.escapeHtml(t.tipo)}</span>
                ${badgeFila}
              </div>
              <h4 class="text-base font-bold text-slate-900 leading-snug mt-0.5">Território ${num} — ${Utils.escapeHtml(t.bairro)}</h4>
            </div>
            <span class="px-2.5 py-0.5 text-[10px] font-bold rounded-full border shrink-0 ${badgeClass}">
              ${Utils.escapeHtml(statusLabel)}
            </span>
          </div>
          ${infoPosse}
          ${infoPredios}
        </div>
        <div class="mt-4 pt-3 border-t border-slate-100 flex items-center gap-2">
          ${areaAcoes}
          ${btnMapa}
        </div>
      </article>
    `;
  },

  /**
   * Solicitação individual ou em lote (até 3 territórios da fila de 5) com Modal Material 3 e tratamento de concorrência 409
   */
  async acaoSolicitar(numero) {
    await this.executarFluxoSolicitacao([Number(numero)]);
  },

  async acaoSolicitarLote() {
    const numeros = Array.from(this.territoriosSelecionados).sort((a, b) => a - b);
    if (!numeros.length) return;
    await this.executarFluxoSolicitacao(numeros);
  },

  async executarFluxoSolicitacao(numeros) {
    if (!numeros.length) return;
    if (numeros.length > Utils.LIMITE_SELECAO_LOTE) {
      await ModalM3.alerta({
        icone: "⚠️",
        titulo: "Limite de seleção atingido",
        mensagem: `Você pode solicitar no máximo ${Utils.LIMITE_SELECAO_LOTE} territórios por vez dentre os ${Utils.LIMITE_FILA_EXIBICAO} disponíveis na fila.`
      });
      return;
    }

    const objetos = numeros.map(n => this.territorios.find(item => Number(item.numero) === Number(n))).filter(Boolean);
    for (const t of objetos) {
      if (!this.podeSolicitarTerritorio(t)) {
        await ModalM3.alerta({
          icone: "⏳",
          titulo: "Território fora da fila de solicitação",
          mensagem: `O Território ${t.numero} (${t.bairro}) não está disponível nos 5 primeiros da fila no momento.`
        });
        return;
      }
    }

    const listaHtml = `
      <div class="space-y-1.5">
        ${objetos.map(t => `
          <div class="px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between text-xs">
            <span class="font-bold text-slate-900">Território ${Number(t.numero)} — ${Utils.escapeHtml(t.bairro)}</span>
            <span class="text-slate-500">${Array.isArray(t.predios) && t.predios.length ? `🏢 ${t.predios.length} prédio(s)` : Utils.escapeHtml(t.tipo)}</span>
          </div>
        `).join("")}
      </div>`;

    const confirmado = await ModalM3.confirmar({
      icone: "📌",
      titulo: objetos.length === 1
        ? `Solicitar Território ${objetos[0].numero}?`
        : `Solicitar ${objetos.length} Territórios da Fila?`,
      mensagem: objetos.length === 1
        ? `O cartão ficará registrado sob sua responsabilidade imediatamente.`
        : `Os ${objetos.length} cartões selecionados serão reservados simultaneamente para você.`,
      detalhesHtml: listaHtml,
      textoConfirmar: objetos.length === 1 ? "Confirmar Solicitação" : `Solicitar ${objetos.length} Territórios`,
      textoCancelar: "Cancelar"
    });

    if (!confirmado) return;

    try {
      Utils.mostrarToast("Verificando disponibilidade e registrando reserva...", "aviso");
      const res = await ApiClient.request("territorios/solicitar", { numerosTerritorios: numeros });
      this.territoriosSelecionados.clear();
      this.atualizarBarraSelecaoFlutuante();
      Utils.mostrarToast(res.mensagem, "sucesso");
      await this.sincronizarDados();
    } catch (err) {
      // Tratamento de Concorrência (HTTP 409): outro usuário retirou algum dos territórios da fila de 5
      if (err.codigo === 409) {
        if (Array.isArray(err.territorios)) {
          this.aplicarListaTerritoriosServidor(err.territorios);
        } else {
          await this.sincronizarDados();
        }
        await ModalM3.alerta({
          icone: "⚡",
          titulo: "Território retirado por outro dirigente",
          mensagem: err.message || "Um ou mais territórios selecionados acabaram de ser solicitados por outro usuário. A fila de 5 territórios foi atualizada automaticamente.",
          textoBotao: "Ver Fila Atualizada"
        });
        return;
      }
      Utils.mostrarToast(err.message, "erro");
    }
  },

  /**
   * Regra de Devolução em Duas Etapas (Modal M3):
   * 1. "Confirma que o território foi totalmente completo?"
   *    - SIM -> Concluído (quarentena 120 dias)
   *    - NÃO -> Modal com 3 opções:
   *      * Quadras faltantes -> Concluído (quarentena 120 dias)
   *      * Prédios não trabalhados -> Concluído (quarentena 120 dias)
   *      * Não iniciado -> Volta para a fila como DISPONÍVEL sem data de início e sem data de conclusão
   */
  async acaoDevolver(numero) {
    const t = this.territorios.find(item => Number(item.numero) === Number(numero));
    if (!t) return;

    const decisao = await ModalM3.abrirDevolucaoDuasEtapas(t);
    if (!decisao) return;

    try {
      Utils.mostrarToast(`Registrando devolução do Território ${numero}...`, "aviso");
      const res = await ApiClient.request("territorios/devolver", {
        numeroTerritorio: Number(numero),
        foiCompleto: decisao.foiCompleto,
        motivoNaoCompleto: decisao.motivoNaoCompleto
      });
      Utils.mostrarToast(res.mensagem, "sucesso");
      await this.sincronizarDados();
    } catch (err) {
      Utils.mostrarToast(err.message, "erro");
    }
  },

  /**
   * Marca ou desmarca um prédio como trabalhado neste ciclo (LGPD-safe: apenas timestamp macro do prédio)
   */
  async acaoAlternarPredioTrabalhado(idPredio, numeroTerritorio, trabalhado) {
    try {
      const res = await ApiClient.request("predios/marcar-trabalhado", {
        idPredio,
        numeroTerritorio: Number(numeroTerritorio),
        trabalhado: Boolean(trabalhado)
      });

      const t = this.territorios.find(item => Number(item.numero) === Number(numeroTerritorio));
      if (t && Array.isArray(t.predios)) {
        const p = t.predios.find(item => item.idPredio === idPredio);
        if (p) {
          p.trabalhadoNesteCiclo = Boolean(res.trabalhado);
          p.ultimaDataConclusao = res.ultimaDataConclusao || "";
        }
      }

      this.renderizarCardsTerritorios();
      this.renderizarMeusTerritorios();
      if (MapaTerritorios.territorioModalAtual === Number(numeroTerritorio)) {
        MapaTerritorios.abrirModalTerritorio(Number(numeroTerritorio), idPredio);
      }
      Utils.mostrarToast(res.mensagem, "sucesso");
    } catch (err) {
      Utils.mostrarToast(err.message, "erro");
    }
  },

  async carregarMeuHistorico() {
    const tbody = document.getElementById("tbody-meu-historico");
    tbody.innerHTML = `<tr><td colspan="4" class="py-4 px-4 text-slate-500">Carregando histórico...</td></tr>`;
    try {
      const res = await ApiClient.request("movimentacoes/minhas");
      const hist = res.historico || [];
      if (!hist.length) {
        tbody.innerHTML = `<tr><td colspan="4" class="py-4 px-4 text-slate-500">Nenhuma movimentação encontrada para seu usuário.</td></tr>`;
        return;
      }
      tbody.innerHTML = hist.map(h => `
        <tr class="hover:bg-slate-50">
          <td class="py-2.5 px-4 text-slate-600">${Utils.escapeHtml(h.dataFormatada)}</td>
          <td class="py-2.5 px-4 font-bold text-slate-900">Território ${Number(h.numeroTerritorio)}</td>
          <td class="py-2.5 px-4">
            <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold ${
              h.acao === "Solicitar"
                ? "bg-[#fef7e0] text-[#b06000]"
                : h.acao === "Cancelado_NaoIniciado"
                ? "bg-slate-100 text-slate-600"
                : "bg-[#e6f4ea] text-[#146c2e]"
            }">
              ${Utils.escapeHtml(h.acao === "Cancelado_NaoIniciado" ? "Devolvido (Não Iniciado)" : h.acao)}
            </span>
          </td>
          <td class="py-2.5 px-4 text-slate-500">${Utils.escapeHtml(h.tipo)}</td>
        </tr>
      `).join("");
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4" class="py-4 px-4 text-[#b3261e]">${Utils.escapeHtml(err.message)}</td></tr>`;
    }
  },

  async carregarDadosAdmin() {
    try {
      const [resUsers, resAudit] = await Promise.all([
        ApiClient.request("admin/usuarios/listar"),
        ApiClient.request("admin/auditoria")
      ]);

      this.usuariosAdmin = resUsers.usuarios || [];
      document.getElementById("count-usuarios").textContent = this.usuariosAdmin.length;

      const tbodyUsers = document.getElementById("tbody-admin-usuarios");
      tbodyUsers.innerHTML = this.usuariosAdmin.map((u, idx) => `
        <tr class="hover:bg-slate-50">
          <td class="py-2 px-3 font-semibold text-slate-900">${Utils.escapeHtml(u.nome)}</td>
          <td class="py-2 px-3 text-slate-600">${Utils.escapeHtml(u.email)}</td>
          <td class="py-2 px-3">
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${u.perfil === "ADMIN" ? "bg-[#fef7e0] text-[#b06000]" : "bg-slate-100 text-slate-700"}">
              ${Utils.escapeHtml(u.perfil)}
            </span>
          </td>
          <td class="py-2 px-3">
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${u.status === "ATIVO" ? "bg-[#e6f4ea] text-[#146c2e]" : "bg-[#fce8e6] text-[#b3261e]"}">
              ${Utils.escapeHtml(u.status)}
            </span>
          </td>
          <td class="py-2 px-3 text-slate-500 text-[11px]">${Utils.escapeHtml(u.ultimaAtividade || "-")}</td>
          <td class="py-2 px-3">
            <button onclick="App.preencherFormUsuario(${idx})" class="text-[#0b57d0] hover:underline font-semibold">Editar</button>
          </td>
        </tr>
      `).join("");

      const logs = resAudit.logs || [];
      const tbodyAudit = document.getElementById("tbody-admin-auditoria");
      tbodyAudit.innerHTML = logs.map(l => `
        <tr class="hover:bg-slate-50">
          <td class="py-2 px-3 text-slate-500 whitespace-nowrap">${Utils.escapeHtml(l.dataHora)}</td>
          <td class="py-2 px-3 font-medium text-slate-900">${Utils.escapeHtml(l.usuario)}</td>
          <td class="py-2 px-3 text-slate-600">${Utils.escapeHtml(l.email)}</td>
          <td class="py-2 px-3 font-semibold text-[#0b57d0]">${Utils.escapeHtml(l.acao)}</td>
          <td class="py-2 px-3 text-center text-slate-700">${Utils.escapeHtml(l.territorio)}</td>
          <td class="py-2 px-3">
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${l.resultado === "SUCESSO" ? "bg-[#e6f4ea] text-[#146c2e]" : "bg-[#fce8e6] text-[#b3261e]"}">
              ${Utils.escapeHtml(l.resultado)}
            </span>
          </td>
          <td class="py-2 px-3 text-slate-500">${Utils.escapeHtml(l.detalhes)}</td>
        </tr>
      `).join("");
    } catch (err) {
      Utils.mostrarToast(err.message, "erro");
    }
  },

  preencherFormUsuario(idx) {
    const u = this.usuariosAdmin[idx];
    if (!u) return;
    document.getElementById("usr-nome").value = u.nome;
    document.getElementById("usr-email").value = u.email;
    document.getElementById("usr-perfil").value = u.perfil;
    document.getElementById("usr-status").value = u.status;
  },

  async salvarUsuarioWhitelist() {
    const dadosUsuario = {
      nome: document.getElementById("usr-nome").value.trim(),
      email: document.getElementById("usr-email").value.trim(),
      perfil: document.getElementById("usr-perfil").value,
      status: document.getElementById("usr-status").value
    };

    try {
      const res = await ApiClient.request("admin/usuarios/salvar", { dadosUsuario });
      Utils.mostrarToast(res.mensagem, "sucesso");
      document.getElementById("form-admin-usuario").reset();
      await this.carregarDadosAdmin();
    } catch (err) {
      Utils.mostrarToast(err.message, "erro");
    }
  },

  async dispararLembretesAdmin() {
    const ok = await ModalM3.confirmar({
      icone: "📧",
      titulo: "Disparar lembretes por e-mail?",
      mensagem: "Serão enviados e-mails consolidados (com os mapas em PDF anexados) para todos os dirigentes que possuem territórios em aberto.",
      textoConfirmar: "Enviar E-mails",
      textoCancelar: "Cancelar"
    });
    if (!ok) return;

    try {
      Utils.mostrarToast("Enviando lembretes consolidados por e-mail...", "aviso");
      const res = await ApiClient.request("admin/lembretes/disparar", {});
      Utils.mostrarToast(res.mensagem, "sucesso");
      await this.carregarDadosAdmin();
    } catch (err) {
      Utils.mostrarToast(err.message, "erro");
    }
  },

  filtrarDashboardPorDirigente(nomeDirigente) {
    const input = document.getElementById("dash-search-ocupados");
    if (!input) return;
    input.value = input.value === nomeDirigente ? "" : nomeDirigente;
    this.renderizarDashboardOcupacao();
  },

  renderizarDashboardOcupacao() {
    const ocupados = this.territorios
      .filter(t => t.statusReal === "OCUPADO")
      .map(t => {
        const diasEmPosse = Utils.calcularDiasDesdeData(t.ultimaData);
        return {
          ...t,
          diasEmPosse: Number.isFinite(diasEmPosse) ? Math.max(0, diasEmPosse) : 0
        };
      })
      .sort((a, b) => {
        const tsA = Utils.obterTimestampData(a.ultimaData) || Infinity;
        const tsB = Utils.obterTimestampData(b.ultimaData) || Infinity;
        if (tsA !== tsB) return tsA - tsB;
        return Number(a.numero) - Number(b.numero);
      });

    const mapaPorDirigente = {};
    let somaDias = 0;
    let qtdAlerta = 0;

    for (const t of ocupados) {
      const dir = (t.dirigente || "Não informado").trim();
      mapaPorDirigente[dir] = (mapaPorDirigente[dir] || 0) + 1;
      somaDias += t.diasEmPosse;
      if (t.diasEmPosse > 60) qtdAlerta++;
    }

    const totalDirigentes = Object.keys(mapaPorDirigente).length;
    const mediaDias = ocupados.length ? Math.round(somaDias / ocupados.length) : 0;

    const elOcup = document.getElementById("dash-kpi-ocupados");
    const elDir = document.getElementById("dash-kpi-dirigentes");
    const elMedia = document.getElementById("dash-kpi-media-dias");
    const elAlerta = document.getElementById("dash-kpi-alerta");

    if (elOcup) elOcup.textContent = `${ocupados.length} / ${this.territorios.length}`;
    if (elDir) elDir.textContent = String(totalDirigentes);
    if (elMedia) elMedia.textContent = `${mediaDias} dias`;
    if (elAlerta) elAlerta.textContent = String(qtdAlerta);

    const chipsContainer = document.getElementById("dash-resumo-dirigentes");
    const buscaAtual = (document.getElementById("dash-search-ocupados")?.value || "").toLowerCase().trim();

    if (chipsContainer) {
      const entradasDirigentes = Object.entries(mapaPorDirigente).sort((a, b) => b[1] - a[1]);
      if (!entradasDirigentes.length) {
        chipsContainer.innerHTML = "";
      } else {
        chipsContainer.innerHTML = entradasDirigentes.map(([nome, qtd]) => {
          const ativo = buscaAtual === nome.toLowerCase();
          const nomeEscapado = Utils.escapeHtml(nome);
          const nomeJs = nome.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
          return `
            <button type="button" onclick="App.filtrarDashboardPorDirigente('${nomeJs}')"
              class="px-3 py-1 rounded-full text-[11px] font-semibold border transition flex items-center gap-1.5 ${
                ativo
                  ? "bg-[#0b57d0] text-white border-[#0b57d0]"
                  : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
              }">
              <span>👤 ${nomeEscapado}</span>
              <span class="px-1.5 py-0.2 rounded-full text-[10px] ${ativo ? "bg-white/20 text-white" : "bg-[#fef7e0] text-[#b06000]"} font-bold">${qtd}</span>
            </button>
          `;
        }).join("");
      }
    }

    const tbody = document.getElementById("tbody-dash-ocupados");
    if (!tbody) return;

    const filtrados = ocupados.filter(t => {
      if (!buscaAtual) return true;
      const texto = `${t.numero} ${t.bairro} ${t.dirigente || ""} ${t.tipo || ""}`.toLowerCase();
      return texto.includes(buscaAtual);
    });

    if (!filtrados.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="py-8 px-4 text-center text-slate-500 text-xs">
            Nenhum território ocupado encontrado para o filtro informado.
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = filtrados.map(t => {
      let badgeTempoClass = "bg-[#e6f4ea] text-[#146c2e] border-[#a8dab5]";
      if (t.diasEmPosse > 60) {
        badgeTempoClass = "bg-[#fce8e6] text-[#b3261e] border-[#f6aea9]";
      } else if (t.diasEmPosse >= 30) {
        badgeTempoClass = "bg-[#fef7e0] text-[#b06000] border-[#f5d087]";
      }

      const qtdPredios = Array.isArray(t.predios) ? t.predios.length : 0;
      const btnMapa = t.wkt
        ? `<button onclick="MapaTerritorios.abrirModalTerritorio(${Number(t.numero)})" class="px-3 py-1 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-semibold transition">🗺️ Mapa${qtdPredios ? ` (${qtdPredios})` : ""}</button>`
        : "";

      const podeDevolver = t.emMinhaPosse || (this.usuarioAtual && this.usuarioAtual.perfil === "ADMIN");
      const btnDevolver = podeDevolver
        ? `<button onclick="App.acaoDevolver(${Number(t.numero)})" class="px-3 py-1 rounded-full bg-[#0b57d0] hover:bg-[#0842a0] text-white text-[11px] font-semibold transition">Devolver</button>`
        : "";

      return `
        <tr class="hover:bg-slate-50">
          <td class="py-2.5 px-4">
            <span class="font-bold text-slate-900">Território ${Number(t.numero)}</span>
            <span class="block text-[11px] text-slate-500">${Utils.escapeHtml(t.bairro)}</span>
          </td>
          <td class="py-2.5 px-4 text-slate-600">${Utils.escapeHtml(t.tipo)}</td>
          <td class="py-2.5 px-4">
            <span class="font-semibold text-[#b06000]">👤 ${Utils.escapeHtml(t.dirigente || "Dirigente")}</span>
          </td>
          <td class="py-2.5 px-4 text-slate-600 whitespace-nowrap">${Utils.formatarDataBr(t.ultimaData)}</td>
          <td class="py-2.5 px-4 whitespace-nowrap">
            <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${badgeTempoClass}">
              ${t.diasEmPosse} dia(s)
            </span>
          </td>
          <td class="py-2.5 px-4 text-right whitespace-nowrap space-x-1">
            ${btnMapa}
            ${btnDevolver}
          </td>
        </tr>
      `;
    }).join("");
  },

  inicializarSeletorAnoServico() {
    const select = document.getElementById("select-ano-servico");
    if (!select) return;

    const anos = Utils.obterAnosDeServicoDisponiveis();
    const anoPadrao = anos.find(a => a.vigente) || anos.find(a => a.anoInicio === 2025) || anos[0];

    select.innerHTML = anos.map(a => `
      <option value="${a.anoInicio}" ${a.anoInicio === anoPadrao.anoInicio ? "selected" : ""}>
        ${Utils.escapeHtml(a.label)}${a.vigente ? " — Atual" : ""}
      </option>
    `).join("");
  },

  async obterCiclosHistoricosParaRelatorio(anoInicio) {
    const possuiCiclosEmbutidos = this.territorios.some(t => Array.isArray(t.ciclos));
    if (possuiCiclosEmbutidos) {
      return [...this.territorios]
        .sort((a, b) => Number(a.numero) - Number(b.numero))
        .map(t => ({
          numero: t.numero,
          bairro: t.bairro,
          tipo: t.tipo,
          ciclos: Utils.filtrarCiclosPorAnoServico(t.ciclos || [], anoInicio)
        }));
    }

    try {
      const res = await ApiClient.request("relatorios/ano-servico", { anoInicio });
      if (res && res.relatorio && Array.isArray(res.relatorio.territorios)) {
        return res.relatorio.territorios;
      }
    } catch (e) {}

    return [...this.territorios]
      .sort((a, b) => Number(a.numero) - Number(b.numero))
      .map(t => ({
        numero: t.numero,
        bairro: t.bairro,
        tipo: t.tipo,
        ciclos: Utils.filtrarCiclosPorAnoServico(t.ciclos || [], anoInicio)
      }));
  },

  async exportarRelatorioPdfAnoServico() {
    const selectAno = document.getElementById("select-ano-servico");
    const selectEscopo = document.getElementById("select-escopo-relatorio");
    const anoInicio = Number(selectAno?.value) || 2025;
    const anoFim = anoInicio + 1;
    const escopo = selectEscopo?.value || "TODOS";
    const periodoStr = `01/09/${anoInicio} a 31/08/${anoFim}`;

    Utils.mostrarToast(`Gerando relatório do Ano de Serviço ${periodoStr}...`, "aviso");

    const dadosTerritorios = await this.obterCiclosHistoricosParaRelatorio(anoInicio);
    const filtrados = escopo === "TRABALHADOS"
      ? dadosTerritorios.filter(t => t.ciclos && t.ciclos.length > 0)
      : dadosTerritorios;

    const totalTerritoriosBase = dadosTerritorios.length;
    const totalTrabalhadosPeriodo = dadosTerritorios.filter(t => t.ciclos && t.ciclos.length > 0).length;
    const totalDesignacoesPeriodo = dadosTerritorios.reduce((acc, t) => acc + (t.ciclos ? t.ciclos.length : 0), 0);
    const dataEmissao = new Date().toLocaleString("pt-BR");

    const linhasHtml = filtrados.map(t => {
      const ciclos = t.ciclos || [];
      if (!ciclos.length) {
        return `
          <tr>
            <td class="col-num">${Number(t.numero)}</td>
            <td>${Utils.escapeHtml(t.bairro)}</td>
            <td>${Utils.escapeHtml(t.tipo)}</td>
            <td class="sem-reg" colspan="3">Sem registro de trabalho neste Ano de Serviço</td>
          </tr>
        `;
      }

      return ciclos.map((c, idx) => `
        <tr>
          ${idx === 0 ? `<td class="col-num" rowspan="${ciclos.length}">${Number(t.numero)}</td>` : ""}
          ${idx === 0 ? `<td rowspan="${ciclos.length}">${Utils.escapeHtml(t.bairro)}</td>` : ""}
          ${idx === 0 ? `<td rowspan="${ciclos.length}">${Utils.escapeHtml(t.tipo)}</td>` : ""}
          <td><strong>${Utils.escapeHtml(c.dirigente || "-")}</strong></td>
          <td class="col-data">${c.dataDesignacao ? Utils.formatarDataBr(c.dataDesignacao) : "-"}</td>
          <td class="col-data">${
            c.dataConclusao
              ? Utils.formatarDataBr(c.dataConclusao)
              : `<span class="badge-campo">Em campo</span>`
          }</td>
        </tr>
      `).join("");
    }).join("");

    const janelaPdf = window.open("", "_blank");
    if (!janelaPdf) {
      await ModalM3.alerta({
        icone: "🖨️",
        titulo: "Pop-up bloqueado pelo navegador",
        mensagem: "Permita a abertura de janelas pop-up para este site para visualizar e salvar o relatório em PDF."
      });
      return;
    }

    const htmlDocumento = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>Registro de Designação de Território — Ano de Serviço ${anoInicio}/${anoFim}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #0f172a;
      background: #f8fafc;
      margin: 0;
      padding: 24px;
      font-size: 12px;
    }
    .toolbar {
      max-width: 960px;
      margin: 0 auto 16px auto;
      background: #0f172a;
      color: #f8fafc;
      padding: 12px 16px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .toolbar button {
      cursor: pointer;
      border: none;
      padding: 8px 16px;
      border-radius: 999px;
      font-weight: 700;
      font-size: 12px;
    }
    .btn-print { background: #0b57d0; color: #ffffff; }
    .btn-close { background: #334155; color: #e2e8f0; }
    .sheet {
      max-width: 960px;
      margin: 0 auto;
      background: #ffffff;
      padding: 28px;
      border: 1px solid #cbd5e1;
      border-radius: 12px;
    }
    .header {
      border-bottom: 2px solid #0f172a;
      padding-bottom: 12px;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .header h1 {
      margin: 0;
      font-size: 18px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .header p {
      margin: 4px 0 0 0;
      color: #475569;
      font-size: 12px;
    }
    .kpis {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-bottom: 16px;
    }
    .kpi {
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 8px 12px;
      background: #f8fafc;
    }
    .kpi span { display: block; font-size: 10px; color: #64748b; text-transform: uppercase; }
    .kpi strong { font-size: 16px; color: #0f172a; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
    }
    th, td {
      border: 1px solid #94a3b8;
      padding: 6px 8px;
      text-align: left;
      vertical-align: middle;
    }
    th {
      background: #e2e8f0;
      font-weight: 700;
      text-transform: uppercase;
      font-size: 10px;
      color: #1e293b;
    }
    .col-num { width: 65px; text-align: center; font-weight: 700; }
    .col-data { width: 110px; text-align: center; }
    .sem-reg { color: #94a3b8; font-style: italic; text-align: center; }
    .badge-campo {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      background: #fef3c7;
      color: #92400e;
      font-weight: 700;
      font-size: 10px;
    }
    @media print {
      body { background: #ffffff; padding: 0; }
      .toolbar { display: none !important; }
      .sheet { border: none; padding: 0; max-width: 100%; }
      tr { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div>
      <strong>Relatório Pronto (${periodoStr})</strong> — Clique em "Salvar como PDF / Imprimir".
    </div>
    <div>
      <button class="btn-print" onclick="window.print()">🖨️ Salvar como PDF / Imprimir</button>
      <button class="btn-close" onclick="window.close()">Fechar</button>
    </div>
  </div>

  <div class="sheet">
    <div class="header">
      <div>
        <h1>Registro de Designação de Território</h1>
        <p><strong>Ano de Serviço ${anoInicio}/${anoFim}:</strong> Período de ${periodoStr}</p>
      </div>
      <div style="text-align: right; font-size: 11px; color: #475569;">
        <div>Congregação Norte — Pato Branco</div>
        <div>Emitido em: ${Utils.escapeHtml(dataEmissao)}</div>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi">
        <span>Total de Territórios</span>
        <strong>${totalTerritoriosBase}</strong>
      </div>
      <div class="kpi">
        <span>Trabalhados no Período</span>
        <strong>${totalTrabalhadosPeriodo} (${totalTerritoriosBase ? Math.round((totalTrabalhadosPeriodo / totalTerritoriosBase) * 100) : 0}%)</strong>
      </div>
      <div class="kpi">
        <span>Sem Trabalho no Período</span>
        <strong>${totalTerritoriosBase - totalTrabalhadosPeriodo}</strong>
      </div>
      <div class="kpi">
        <span>Designações no Ano de Serviço</span>
        <strong>${totalDesignacoesPeriodo}</strong>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th class="col-num">Território</th>
          <th>Bairro / Descrição</th>
          <th>Tipo</th>
          <th>Designado a (Dirigente)</th>
          <th class="col-data">Data da Designação</th>
          <th class="col-data">Data da Conclusão</th>
        </tr>
      </thead>
      <tbody>
        ${linhasHtml}
      </tbody>
    </table>
  </div>

  <script>
    window.addEventListener("load", () => {
      setTimeout(() => window.print(), 350);
    });
  </script>
</body>
</html>`;

    janelaPdf.document.open();
    janelaPdf.document.write(htmlDocumento);
    janelaPdf.document.close();
    Utils.mostrarToast("Relatório PDF gerado com sucesso!", "sucesso");
  }
};

document.addEventListener("DOMContentLoaded", () => App.init());
