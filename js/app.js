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
  }
};

document.addEventListener("DOMContentLoaded", () => App.init());
