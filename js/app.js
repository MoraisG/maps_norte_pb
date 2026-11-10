/**
 * Controlador Principal da Aplicação PWA — Gestão de Territórios
 */
const App = {
  usuarioAtual: null,
  territorios: [],
  usuariosAdmin: [],

  init() {
    this.registrarServiceWorker();
    this.configurarEventosUI();

    // Verifica se já existe sessão ativa válida no sessionStorage
    const token = ApiClient.obterTokenSessao();
    const usr = ApiClient.obterUsuarioSessao();
    if (token && usr) {
      this.usuarioAtual = usr;
      this.entrarModoAutenticado();
    } else {
      this.inicializarBotaoGoogle();
    }

    window.addEventListener("sessao-expirada", () => {
      this.sairParaTelaLogin("Sua sessão expirou. Por favor, entre novamente com o Google.");
    });
  },

  registrarServiceWorker() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  },

  configurarEventosUI() {
    // Logout e Refresh
    document.getElementById("btn-logout").addEventListener("click", () => this.executarLogout());
    document.getElementById("btn-refresh").addEventListener("click", () => this.sincronizarDados());

    // Navegação entre Abas
    document.querySelectorAll(".nav-tab").forEach(btn => {
      btn.addEventListener("click", () => this.alternarAba(btn.dataset.tab));
    });

    // Filtros em Tempo Real
    document.getElementById("filter-search").addEventListener("input", () => this.renderizarCardsTerritorios());
    document.getElementById("filter-status").addEventListener("change", () => this.renderizarCardsTerritorios());
    document.getElementById("filter-tipo").addEventListener("change", () => this.renderizarCardsTerritorios());

    // Eventos do Dashboard de Ocupação e Relatório PDF por Ano de Serviço
    this.inicializarSeletorAnoServico();
    const inputDashSearch = document.getElementById("dash-search-ocupados");
    if (inputDashSearch) {
      inputDashSearch.addEventListener("input", () => this.renderizarDashboardOcupacao());
    }
    const btnGerarPdf = document.getElementById("btn-gerar-pdf-ano-servico");
    if (btnGerarPdf) {
      btnGerarPdf.addEventListener("click", () => this.exportarRelatorioPdfAnoServico());
    }

    // Eventos da Modal de Mapa Individual do Território
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

    // Eventos exclusivos do Painel Admin
    document.getElementById("form-admin-usuario").addEventListener("submit", e => {
      e.preventDefault();
      this.salvarUsuarioWhitelist();
    });

    document.getElementById("btn-admin-lembretes").addEventListener("click", () => this.dispararLembretesAdmin());
    document.getElementById("btn-refresh-audit").addEventListener("click", () => this.carregarDadosAdmin());
  },

  /**
   * Inicializa o botão oficial "Entrar com Google" (Google Identity Services)
   */
  inicializarBotaoGoogle() {
    const clientId = ApiClient.getClientId();
    const container = document.getElementById("google-btn-container");

    if (!clientId) {
      container.innerHTML = `
        <p class="text-xs text-rose-300 bg-rose-950/50 border border-rose-700/50 px-3.5 py-2.5 rounded-xl">
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
      theme: "filled_blue",
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
    if (this.usuarioAtual.perfil === "ADMIN") {
      btnAdmin.classList.remove("hidden");
      badgeRole.className = "px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40";
    } else {
      btnAdmin.classList.add("hidden");
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
      Utils.mostrarToast("Sincronizando territórios com a planilha...", "aviso");
      const res = await ApiClient.request("territorios/listar");
      const listaBruta = res.territorios || [];
      this.territorios = this.ordenarPorAntiguidade(this.normalizarTerritorios(listaBruta));
      this.atualizarIndicadores();
      this.renderizarCardsTerritorios();
      this.renderizarMeusTerritorios();
      this.renderizarDashboardOcupacao();

      if (MapaTerritorios.inicializado) {
        MapaTerritorios.renderizarPoligonos(this.territorios);
      }
      Utils.mostrarToast("Dados atualizados com sucesso!", "sucesso");
    } catch (err) {
      Utils.mostrarToast(err.message, "erro");
    } finally {
      this.sincronizando = false;
    }
  },

  /**
   * Normaliza o status de cada território garantindo que somente fique DISPONÍVEL
   * quando tiver mais de 120 dias desde a última devolução (ou nunca trabalhado).
   */
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
   * Verifica se o território cumpre o requisito de mais de 120 dias desde a última devolução
   */
  podeSolicitarTerritorio(t) {
    if (!t || t.statusReal === "OCUPADO") return false;
    const dias = Utils.calcularDiasDesdeData(t.ultimaData);
    return dias > Utils.DIAS_QUARENTENA_DEVOLUCAO && t.statusReal === "DISPONÍVEL";
  },

  /**
   * Ordena sempre pelo critério de antiguidade:
   * 1. Territórios nunca trabalhados ou devolvidos há mais tempo primeiro
   * 2. Territórios atualmente ocupados ao final
   */
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

    document.getElementById("kpi-disponiveis").textContent = disp;
    document.getElementById("kpi-ocupados").textContent = ocup;
    document.getElementById("kpi-recentes").textContent = rec;
    document.getElementById("kpi-comigo").textContent = meus;
    document.getElementById("count-all").textContent = this.territorios.length;
    document.getElementById("count-mine").textContent = meus;
    const badgeOcupNav = document.getElementById("count-ocupados-nav");
    if (badgeOcupNav) badgeOcupNav.textContent = ocup;
  },

  renderizarCardsTerritorios() {
    const busca = document.getElementById("filter-search").value.toLowerCase().trim();
    const filtroStatus = document.getElementById("filter-status").value;
    const filtroTipo = document.getElementById("filter-tipo").value;

    const filtrados = this.ordenarPorAntiguidade(
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

    const container = document.getElementById("grid-territorios");
    if (!filtrados.length) {
      container.innerHTML = `<div class="col-span-full text-center py-10 text-slate-400 text-xs">Nenhum território encontrado para os filtros selecionados.</div>`;
      return;
    }

    container.innerHTML = filtrados.map(t => this.criarHtmlCardTerritorio(t)).join("");
  },

  renderizarMeusTerritorios() {
    const meus = this.territorios.filter(t => t.emMinhaPosse);
    const container = document.getElementById("grid-meus-territorios");

    if (!meus.length) {
      container.innerHTML = `
        <div class="col-span-full bg-slate-900/60 border border-slate-800 rounded-xl p-8 text-center">
          <p class="text-sm font-semibold text-slate-300">Você não possui territórios pendentes em sua posse no momento.</p>
          <p class="text-xs text-slate-400 mt-1">Vá até a aba "Territórios" ou "Mapa Interativo" para solicitar um novo cartão.</p>
        </div>`;
      return;
    }

    container.innerHTML = meus.map(t => this.criarHtmlCardTerritorio(t)).join("");
  },

  criarHtmlCardTerritorio(t) {
    const { badgeClass, label: statusLabel } = Utils.obterEstiloStatus(t);

    const infoPosse = t.statusReal === "OCUPADO"
      ? `<p class="text-xs text-amber-300/90 mt-2">👤 Em posse de: <strong>${Utils.escapeHtml(t.dirigente || "Dirigente")}</strong> desde ${Utils.formatarDataBr(t.ultimaData)}</p>`
      : `<p class="text-xs text-slate-400 mt-2">📅 Última devolução: ${Utils.formatarDataBr(t.ultimaData)}</p>`;

    let btnPrincipal = "";
    if (this.podeSolicitarTerritorio(t)) {
      btnPrincipal = `
        <button onclick="App.acaoSolicitar(${Number(t.numero)})" class="flex-1 py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition">
          Solicitar
        </button>`;
    } else if (t.statusReal === "OCUPADO" && (t.emMinhaPosse || (this.usuarioAtual && this.usuarioAtual.perfil === "ADMIN"))) {
      btnPrincipal = `
        <button onclick="App.acaoDevolver(${Number(t.numero)})" class="flex-1 py-2 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition">
          Devolver
        </button>`;
    } else if (t.statusReal === "RECENTE") {
      btnPrincipal = `
        <button disabled title="Disponível somente após mais de 120 dias da última devolução" class="flex-1 py-2 px-3 rounded-lg bg-slate-800 text-slate-500 font-semibold text-xs cursor-not-allowed">
          Indisponível (&le; 120 dias)
        </button>`;
    } else {
      btnPrincipal = `
        <button disabled class="flex-1 py-2 px-3 rounded-lg bg-slate-800 text-slate-500 font-semibold text-xs cursor-not-allowed">
          Ocupado
        </button>`;
    }

    const btnMapa = t.wkt
      ? `<button onclick="MapaTerritorios.abrirModalTerritorio(${Number(t.numero)})" class="py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition" title="Visualizar mapa deste território">🗺️ Mapa</button>`
      : "";

    return `
      <article class="bg-slate-900 border ${t.emMinhaPosse ? "border-indigo-500/60" : "border-slate-800"} rounded-xl p-4 flex flex-col justify-between shadow-sm">
        <div>
          <div class="flex items-start justify-between gap-2">
            <div>
              <span class="text-xs font-semibold text-slate-400 uppercase tracking-wider">${Utils.escapeHtml(t.tipo)}</span>
              <h4 class="text-base font-bold text-white leading-snug">Território ${Number(t.numero)} — ${Utils.escapeHtml(t.bairro)}</h4>
            </div>
            <span class="px-2.5 py-0.5 text-[10px] font-bold rounded-full border ${badgeClass}">
              ${Utils.escapeHtml(statusLabel)}
            </span>
          </div>
          ${infoPosse}
        </div>
        <div class="mt-4 pt-3 border-t border-slate-800/80 flex items-center gap-2">
          ${btnPrincipal}
          ${btnMapa}
        </div>
      </article>
    `;
  },

  async acaoSolicitar(numero) {
    const t = this.territorios.find(item => Number(item.numero) === Number(numero));
    if (!this.podeSolicitarTerritorio(t)) {
      Utils.mostrarToast("Este território só pode ficar disponível para solicitação quando tiver mais de 120 dias desde a sua última devolução.", "erro");
      return;
    }
    if (!confirm(`Confirmar solicitação do Território ${numero}?`)) return;
    try {
      Utils.mostrarToast(`Registrando solicitação do território ${numero}...`, "aviso");
      const res = await ApiClient.request("territorios/solicitar", { numeroTerritorio: numero });
      Utils.mostrarToast(res.mensagem, "sucesso");
      await this.sincronizarDados();
    } catch (err) {
      Utils.mostrarToast(err.message, "erro");
    }
  },

  async acaoDevolver(numero) {
    if (!confirm(`Confirmar a devolução do Território ${numero}?`)) return;
    try {
      Utils.mostrarToast(`Registrando devolução do território ${numero}...`, "aviso");
      const res = await ApiClient.request("territorios/devolver", { numeroTerritorio: numero });
      Utils.mostrarToast(res.mensagem, "sucesso");
      await this.sincronizarDados();
    } catch (err) {
      Utils.mostrarToast(err.message, "erro");
    }
  },

  async carregarMeuHistorico() {
    const tbody = document.getElementById("tbody-meu-historico");
    tbody.innerHTML = `<tr><td colspan="4" class="py-4 px-4 text-slate-400">Carregando histórico...</td></tr>`;
    try {
      const res = await ApiClient.request("movimentacoes/minhas");
      const hist = res.historico || [];
      if (!hist.length) {
        tbody.innerHTML = `<tr><td colspan="4" class="py-4 px-4 text-slate-400">Nenhuma movimentação encontrada para seu usuário.</td></tr>`;
        return;
      }
      tbody.innerHTML = hist.map(h => `
        <tr class="hover:bg-slate-800/40">
          <td class="py-2.5 px-4 text-slate-300">${Utils.escapeHtml(h.dataFormatada)}</td>
          <td class="py-2.5 px-4 font-bold text-white">Território ${Number(h.numeroTerritorio)}</td>
          <td class="py-2.5 px-4">
            <span class="px-2 py-0.5 rounded text-[10px] font-bold ${h.acao === "Solicitar" ? "bg-amber-500/20 text-amber-300" : "bg-emerald-500/20 text-emerald-300"}">
              ${Utils.escapeHtml(h.acao)}
            </span>
          </td>
          <td class="py-2.5 px-4 text-slate-400">${Utils.escapeHtml(h.tipo)}</td>
        </tr>
      `).join("");
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4" class="py-4 px-4 text-rose-400">${Utils.escapeHtml(err.message)}</td></tr>`;
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
        <tr class="hover:bg-slate-800/40">
          <td class="py-2 px-3 font-medium text-white">${Utils.escapeHtml(u.nome)}</td>
          <td class="py-2 px-3 text-slate-300">${Utils.escapeHtml(u.email)}</td>
          <td class="py-2 px-3">
            <span class="px-2 py-0.5 rounded text-[10px] font-bold ${u.perfil === "ADMIN" ? "bg-amber-500/20 text-amber-300" : "bg-slate-800 text-slate-300"}">
              ${Utils.escapeHtml(u.perfil)}
            </span>
          </td>
          <td class="py-2 px-3">
            <span class="px-2 py-0.5 rounded text-[10px] font-bold ${u.status === "ATIVO" ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"}">
              ${Utils.escapeHtml(u.status)}
            </span>
          </td>
          <td class="py-2 px-3 text-slate-400 text-[11px]">${Utils.escapeHtml(u.ultimaAtividade || "-")}</td>
          <td class="py-2 px-3">
            <button onclick="App.preencherFormUsuario(${idx})" class="text-indigo-400 hover:underline font-semibold">Editar</button>
          </td>
        </tr>
      `).join("");

      const logs = resAudit.logs || [];
      const tbodyAudit = document.getElementById("tbody-admin-auditoria");
      tbodyAudit.innerHTML = logs.map(l => `
        <tr class="hover:bg-slate-800/40">
          <td class="py-2 px-3 text-slate-400 whitespace-nowrap">${Utils.escapeHtml(l.dataHora)}</td>
          <td class="py-2 px-3 text-white">${Utils.escapeHtml(l.usuario)}</td>
          <td class="py-2 px-3 text-slate-300">${Utils.escapeHtml(l.email)}</td>
          <td class="py-2 px-3 font-semibold text-indigo-300">${Utils.escapeHtml(l.acao)}</td>
          <td class="py-2 px-3 text-center">${Utils.escapeHtml(l.territorio)}</td>
          <td class="py-2 px-3">
            <span class="px-2 py-0.5 rounded text-[10px] font-bold ${l.resultado === "SUCESSO" ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"}">
              ${Utils.escapeHtml(l.resultado)}
            </span>
          </td>
          <td class="py-2 px-3 text-slate-400">${Utils.escapeHtml(l.detalhes)}</td>
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
    if (!confirm("Deseja disparar agora os e-mails de lembrete (com mapas em PDF anexados) para todos os dirigentes que estão com territórios ocupados?")) return;
    try {
      Utils.mostrarToast("Enviando lembretes consolidados por e-mail...", "aviso");
      const res = await ApiClient.request("admin/lembretes/disparar", {});
      Utils.mostrarToast(res.mensagem, "sucesso");
      await this.carregarDadosAdmin();
    } catch (err) {
      Utils.mostrarToast(err.message, "erro");
    }
  },

  /**
   * ==========================================================================
   * ITEM 2: DASHBOARD DE TERRITÓRIOS TRABALHADOS / OCUPADOS
   * ==========================================================================
   */
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

    // Contabiliza dirigentes únicos e métricas
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

    // Renderiza chips de resumo por dirigente
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
              class="px-2.5 py-1 rounded-full text-[11px] font-semibold border transition flex items-center gap-1.5 ${
                ativo
                  ? "bg-indigo-600 text-white border-indigo-400"
                  : "bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-700"
              }">
              <span>👤 ${nomeEscapado}</span>
              <span class="px-1.5 py-0.2 rounded-full text-[10px] bg-slate-800 text-amber-300 font-bold">${qtd}</span>
            </button>
          `;
        }).join("");
      }
    }

    // Filtra e renderiza linhas da tabela de ocupados
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
          <td colspan="6" class="py-8 px-4 text-center text-slate-400 text-xs">
            Nenhum território ocupado encontrado para o filtro informado.
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = filtrados.map(t => {
      let badgeTempoClass = "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
      if (t.diasEmPosse > 60) {
        badgeTempoClass = "bg-rose-500/20 text-rose-300 border-rose-500/40";
      } else if (t.diasEmPosse >= 30) {
        badgeTempoClass = "bg-amber-500/20 text-amber-300 border-amber-500/40";
      }

      const btnMapa = t.wkt
        ? `<button onclick="MapaTerritorios.abrirModalTerritorio(${Number(t.numero)})" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-medium transition">🗺️ Mapa</button>`
        : "";

      const podeDevolver = t.emMinhaPosse || (this.usuarioAtual && this.usuarioAtual.perfil === "ADMIN");
      const btnDevolver = podeDevolver
        ? `<button onclick="App.acaoDevolver(${Number(t.numero)})" class="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-semibold transition">Devolver</button>`
        : "";

      return `
        <tr class="hover:bg-slate-800/40">
          <td class="py-2.5 px-4">
            <span class="font-bold text-white">Território ${Number(t.numero)}</span>
            <span class="block text-[11px] text-slate-400">${Utils.escapeHtml(t.bairro)}</span>
          </td>
          <td class="py-2.5 px-4 text-slate-300">${Utils.escapeHtml(t.tipo)}</td>
          <td class="py-2.5 px-4">
            <span class="font-semibold text-amber-300">👤 ${Utils.escapeHtml(t.dirigente || "Dirigente")}</span>
          </td>
          <td class="py-2.5 px-4 text-slate-300 whitespace-nowrap">${Utils.formatarDataBr(t.ultimaData)}</td>
          <td class="py-2.5 px-4 whitespace-nowrap">
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold border ${badgeTempoClass}">
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

  /**
   * ==========================================================================
   * ITEM 1: RELATÓRIO EM PDF DO REGISTRO DE TERRITÓRIOS POR ANO DE SERVIÇO
   * (Período: 01/09/AAAA até 31/08/AAAA+1 e assim sucessivamente)
   * ==========================================================================
   */
  inicializarSeletorAnoServico() {
    const select = document.getElementById("select-ano-servico");
    if (!select) return;

    const anos = Utils.obterAnosDeServicoDisponiveis();
    // Seleciona por padrão 2025/2026 (01/09/2025 a 31/08/2026) ou o ano vigente
    const anoPadrao = anos.find(a => a.vigente) || anos.find(a => a.anoInicio === 2025) || anos[0];

    select.innerHTML = anos.map(a => `
      <option value="${a.anoInicio}" ${a.anoInicio === anoPadrao.anoInicio ? "selected" : ""}>
        ${Utils.escapeHtml(a.label)}${a.vigente ? " — Atual" : ""}
      </option>
    `).join("");
  },

  async obterCiclosHistoricosParaRelatorio(anoInicio) {
    // 1. Se territorios/listar já trouxe 'ciclos' do backend atualizado, usa diretamente
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

    // 2. Tenta consultar a rota dedicada 'relatorios/ano-servico'
    try {
      const res = await ApiClient.request("relatorios/ano-servico", { anoInicio });
      if (res && res.relatorio && Array.isArray(res.relatorio.territorios)) {
        return res.relatorio.territorios;
      }
    } catch (e) {}

    // 3. Fallback inteligente caso o backend ainda esteja na versão anterior:
    // Reconstrói os ciclos a partir do histórico disponível e do estado atual dos territórios
    let movs = [];
    try {
      if (this.usuarioAtual && this.usuarioAtual.perfil === "ADMIN") {
        const resAdmin = await ApiClient.request("admin/dashboard");
        movs = resAdmin.historicoRecente || [];
      } else {
        const resMinhas = await ApiClient.request("movimentacoes/minhas");
        movs = resMinhas.historico || [];
      }
    } catch (e) {}

    const movsPorTerritorio = {};
    for (const m of movs) {
      const num = Number(m.numeroTerritorio);
      if (!num) continue;
      if (!movsPorTerritorio[num]) movsPorTerritorio[num] = [];
      const dataBr = String(m.dataFormatada || "").split(" ")[0];
      movsPorTerritorio[num].push({
        timestamp: m.timestamp || Utils.obterTimestampData(dataBr),
        acao: m.acao,
        dirigente: m.dirigente || "",
        dataIso: dataBr
      });
    }

    return [...this.territorios]
      .sort((a, b) => Number(a.numero) - Number(b.numero))
      .map(t => {
        const listaMov = (movsPorTerritorio[Number(t.numero)] || []).sort((a, b) => a.timestamp - b.timestamp);
        const ciclos = [];
        let aberto = null;

        for (const m of listaMov) {
          if (m.acao === "Solicitar") {
            if (aberto) ciclos.push(aberto);
            aberto = { dirigente: m.dirigente, dataDesignacao: m.dataIso, dataConclusao: "" };
          } else if (m.acao === "Devolver") {
            if (aberto) {
              aberto.dataConclusao = m.dataIso;
              if (!aberto.dirigente && m.dirigente) aberto.dirigente = m.dirigente;
              ciclos.push(aberto);
              aberto = null;
            } else {
              ciclos.push({ dirigente: m.dirigente, dataDesignacao: "", dataConclusao: m.dataIso });
            }
          }
        }
        if (aberto) ciclos.push(aberto);

        // Garante também o último registro consolidado do território caso não estivesse nos logs recentes
        if (!ciclos.length && t.ultimaData) {
          if (t.statusReal === "OCUPADO") {
            ciclos.push({ dirigente: t.dirigente || "Dirigente", dataDesignacao: t.ultimaData, dataConclusao: "" });
          } else {
            ciclos.push({ dirigente: t.dirigente || "-", dataDesignacao: "", dataConclusao: t.ultimaData });
          }
        }

        return {
          numero: t.numero,
          bairro: t.bairro,
          tipo: t.tipo,
          ciclos: Utils.filtrarCiclosPorAnoServico(ciclos, anoInicio)
        };
      });
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
      Utils.mostrarToast("Permita pop-ups no navegador para visualizar e salvar o PDF.", "erro");
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
      font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
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
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .toolbar button {
      cursor: pointer;
      border: none;
      padding: 8px 14px;
      border-radius: 6px;
      font-weight: 700;
      font-size: 12px;
    }
    .btn-print { background: #4f46e5; color: #ffffff; }
    .btn-close { background: #334155; color: #e2e8f0; }
    .sheet {
      max-width: 960px;
      margin: 0 auto;
      background: #ffffff;
      padding: 28px;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
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
      border-radius: 6px;
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
      <strong>Relatório Pronto (${periodoStr})</strong> — Clique em "Salvar como PDF / Imprimir" e escolha o destino "Salvar como PDF".
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
