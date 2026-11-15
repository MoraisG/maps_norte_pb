/**
 * Instalação do app (PWA) na tela de início.
 *
 * - Android / computador (Chrome, Edge): o navegador avisa com "beforeinstallprompt" quando o app
 *   pode ser instalado; guardamos o evento e o botão "Instalar" abre o diálogo do próprio navegador.
 * - iPhone / iPad: não existe esse evento; o botão mostra o caminho manual (Compartilhar ->
 *   Adicionar à Tela de Início).
 * - App já instalado (aberto pelo ícone) ou convite dispensado há pouco: a faixa não aparece.
 */
const Instalacao = {
  _eventoPendente: null,
  CHAVE_DISPENSADO: "INSTALACAO_DISPENSADA_EM",
  DIAS_SEM_CONVIDAR: 30,

  jaInstalado() {
    const modoApp = typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches;
    return Boolean(modoApp || window.navigator.standalone === true);
  },

  ehAparelhoApple() {
    const ua = String(window.navigator.userAgent || "");
    // iPadOS se apresenta como Mac; a tela de toque denuncia o tablet
    const ipadComoMac = /Macintosh/.test(ua) && Number(window.navigator.maxTouchPoints || 0) > 1;
    return /iPhone|iPad|iPod/.test(ua) || ipadComoMac;
  },

  /** Quem tocou em "Agora não" fica um período sem ver o convite de novo. */
  foiDispensado() {
    try {
      const quando = Number(localStorage.getItem(this.CHAVE_DISPENSADO) || 0);
      return quando > 0 && Date.now() - quando < this.DIAS_SEM_CONVIDAR * 86400000;
    } catch (e) {
      return false;
    }
  },

  iniciar() {
    const botao = document.getElementById("btn-instalar");
    if (!botao || this.jaInstalado()) return;

    window.addEventListener("beforeinstallprompt", evento => {
      // Segura o aviso padrão do navegador para oferecer a instalação pelo nosso convite
      evento.preventDefault();
      this._eventoPendente = evento;
      this.mostrarConvite(true);
    });

    window.addEventListener("appinstalled", () => {
      this._eventoPendente = null;
      this.mostrarConvite(false);
      Utils.mostrarToast("App instalado! Abra pelo ícone na tela de início.", "sucesso");
    });

    botao.addEventListener("click", () => this.aoClicar());
    document.getElementById("btn-dispensar-instalar")?.addEventListener("click", () => {
      try { localStorage.setItem(this.CHAVE_DISPENSADO, String(Date.now())); } catch (e) {}
      this.mostrarConvite(false);
    });

    if (this.ehAparelhoApple()) this.mostrarConvite(true);
  },

  mostrarConvite(visivel) {
    const faixa = document.getElementById("faixa-instalar");
    if (faixa) faixa.hidden = !(visivel && !this.foiDispensado());
  },

  async aoClicar() {
    const evento = this._eventoPendente;
    if (evento) {
      // O evento só pode ser usado uma vez; o navegador emite outro se a instalação for recusada
      this._eventoPendente = null;
      evento.prompt();
      const escolha = await evento.userChoice.catch(() => null);
      if (escolha && escolha.outcome === "accepted") this.mostrarConvite(false);
      return;
    }

    if (this.ehAparelhoApple()) {
      await ModalM3.alerta({
        titulo: "Instalar no iPhone ou iPad",
        mensagem: "No Safari, toque em Compartilhar (o quadrado com a seta para cima) e depois em \"Adicionar à Tela de Início\". O app passa a abrir pelo ícone, em tela cheia.",
        textoBotao: "Entendi",
        icone: "📲"
      });
    }
  }
};

document.addEventListener("DOMContentLoaded", () => Instalacao.iniciar());
