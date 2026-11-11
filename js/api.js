/**
 * Cliente HTTP da API do Google Apps Script com Controle de Sessão Efêmera (sessionStorage)
 * Segue a Camada 3 e 4 do Plano Técnico v2 (Sem credenciais fixas, sessões com expiração e POST text/plain para evitar bloqueio CORS do Apps Script).
 */
const ApiClient = {
  DEFAULT_API_URL: "https://script.google.com/macros/s/AKfycbwc4E6uP1hPc04h6rECqLgywaxD5KjG5VfhPaTf0d6Tp2_3l_FSaicv4O9Qs3QCad90Jw/exec",
  DEFAULT_GOOGLE_CLIENT_ID: "917012478113-2nq9p3io8j8cao95gscamjh0jqrp6u4p.apps.googleusercontent.com",

  getApiUrl() {
    return this.DEFAULT_API_URL;
  },

  getClientId() {
    return this.DEFAULT_GOOGLE_CLIENT_ID;
  },

  // Sessão armazenada apenas em sessionStorage (expira ao fechar o navegador ou pelo TTL do servidor)
  salvarSessao(sessionToken, usuario, expiraEm) {
    sessionStorage.setItem("AUTH_SESSION_TOKEN", sessionToken);
    sessionStorage.setItem("AUTH_USER", JSON.stringify(usuario));
    sessionStorage.setItem("AUTH_EXPIRES_AT", String(expiraEm || 0));
  },

  obterTokenSessao() {
    const token = sessionStorage.getItem("AUTH_SESSION_TOKEN");
    const expiraEm = Number(sessionStorage.getItem("AUTH_EXPIRES_AT") || 0);
    if (!token || (expiraEm && Date.now() > expiraEm)) {
      this.limparSessaoLocal();
      return null;
    }
    return token;
  },

  obterUsuarioSessao() {
    const raw = sessionStorage.getItem("AUTH_USER");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  },

  limparSessaoLocal() {
    sessionStorage.removeItem("AUTH_SESSION_TOKEN");
    sessionStorage.removeItem("AUTH_USER");
    sessionStorage.removeItem("AUTH_EXPIRES_AT");
  },

  /**
   * Executa chamada autenticada para o Google Apps Script
   */
  async request(rota, payload = {}, exigirSessao = true) {
    const apiUrl = this.getApiUrl();
    if (!apiUrl) {
      throw new Error("Configure a URL do Aplicativo da Web (Google Apps Script) nas configurações de conexão.");
    }

    const sessionToken = this.obterTokenSessao();
    if (exigirSessao && !sessionToken) {
      window.dispatchEvent(new CustomEvent("sessao-expirada"));
      throw new Error("Sessão expirada. Faça login novamente.");
    }

    const corpo = JSON.stringify({
      rota: rota,
      sessionToken: sessionToken,
      ...payload
    });

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        // Content-Type text/plain evita que o navegador falhe no OPTIONS preflight do Google Apps Script
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: corpo,
      redirect: "follow"
    });

    if (!response.ok) {
      throw new Error(`Falha de comunicação HTTP (${response.status})`);
    }

    const data = await response.json();

    if (!data.sucesso) {
      if (data.codigo === 401) {
        this.limparSessaoLocal();
        window.dispatchEvent(new CustomEvent("sessao-expirada"));
      }
      const err = new Error(data.erro || "Operação recusada pelo servidor.");
      err.codigo = data.codigo || 400;
      err.conflitos = data.conflitos || [];
      err.territorios = data.territorios || null;
      throw err;
    }

    return data;
  }
};
