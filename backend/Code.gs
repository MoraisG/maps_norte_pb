/**
 * ============================================================================
 * SISTEMA DE GESTÃO DE TERRITÓRIOS — BACKEND API REST (PLANO TÉCNICO v2)
 * ============================================================================
 * Camadas de Segurança Implementadas:
 * 1. Identidade: Validação criptográfica de ID Token (Google Identity) via endpoint tokeninfo do Google.
 * 2. Autorização: Consulta estrita à aba 'Usuarios' (Whitelist + Status ATIVO).
 * 3. Sessão: Tokens de sessão de curta duração via CacheService (expiração, renovação e revogação).
 * 4. RBAC no Backend: Separação rígida entre PUBLICADOR e ADMIN por rota.
 * 5. Concorrência: LockService.getScriptLock() em todas as transações de escrita.
 * 6. Dados Completos: Cruzamento entre abas 'BASE', 'DASHBOARD' e 'Respostas' (todos os 94 territórios + WKT).
 * 7. Auditoria: Registro detalhado na aba 'Auditoria' com timestamp, usuário, ação, território, status e origem.
 */

const CONFIG = {
  get ID_PASTA_MAPAS() {
    return PropertiesService.getScriptProperties().getProperty("ID_PASTA_MAPAS") || "1CPC5pwlLp4o_Bkws2nTUOpCP_wb0YxIG";
  },
  get ADMIN_ROOT_EMAIL() {
    return PropertiesService.getScriptProperties().getProperty("ADMIN_ROOT_EMAIL") || Session.getEffectiveUser().getEmail();
  },
  SESSION_TTL_SECONDS: 3600,        // Sessão FIXA de 1 hora (não desliza com a atividade)
  SESSION_REFRESH_JANELA_SECONDS: 900, // Renovação só é aceita nos últimos 15 min da sessão
  SESSION_GRACE_SECONDS: 60,        // Token antigo continua válido 60 s após a renovação (requisições em voo)
  SESSION_MAX_AGE_SECONDS: 43200,   // Cadeia de renovações limitada a 12 h desde o login com Google
  DIAS_RECENTE: 120,                // Janela de quarentena após devolução
  LIMITE_FILA: 5,                   // Regra da Fila Top 5 (validada também no servidor)
  LOGIN_LIMITE_POR_MINUTO: 60,      // Teto global (tokens inválidos sem e-mail identificável)
  LOGIN_FALHAS_MAX: 5,              // Falhas por e-mail antes de entrar na Blacklist
  LOGIN_FALHAS_JANELA_SECONDS: 21600, // Janela de contagem das falhas (6 h, máximo do CacheService)
  DIAG_FALHAS_MAX_10MIN: 5,         // Chaves de diagnóstico inválidas antes do bloqueio temporário
  GOOGLE_CLIENT_ID: "917012478113-2nq9p3io8j8cao95gscamjh0jqrp6u4p.apps.googleusercontent.com",
  GOOGLE_ISSUERS: ["accounts.google.com", "https://accounts.google.com"],
  // Abas nunca expostas pela rota de diagnóstico (PII de usuários e trilha de auditoria)
  ABAS_BLOQUEADAS_DIAGNOSTICO: ["Usuarios", "Auditoria", "Blacklist"]
};

/**
 * Lê uma ScriptProperty opcional (configurações operacionais sem alterar código).
 */
function lerPropriedade(chave, padrao) {
  try {
    const v = PropertiesService.getScriptProperties().getProperty(chave);
    return v === null || v === undefined || v === "" ? padrao : v;
  } catch (e) {
    return padrao;
  }
}

/**
 * ============================================================================
 * SANITIZAÇÃO DE ESCRITA NA PLANILHA (Prevenção de Formula/CSV Injection)
 * ============================================================================
 * Qualquer texto iniciado por = + - @ TAB ou CR seria interpretado como fórmula
 * pelo Google Sheets. O prefixo ' força o armazenamento como texto puro (o
 * apóstrofo não aparece na célula nem retorna em getValues()).
 */
function sanitizarCelula(valor, tamanhoMax) {
  if (valor === null || valor === undefined) return "";
  if (typeof valor !== "string") return valor; // Date, number e boolean são seguros
  let s = valor.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  const max = tamanhoMax || 1000;
  if (s.length > max) s = s.slice(0, max);
  if (/^[=+\-@\t\r\n]/.test(s)) s = "'" + s;
  return s;
}

function sanitizarLinha(valores, tamanhoMax) {
  return valores.map(v => sanitizarCelula(v, tamanhoMax));
}

/**
 * Rate limit simples por janela fixa usando CacheService.
 * Retorna true se a operação ainda está dentro do limite.
 */
function consumirCota(chave, limite, janelaSegundos) {
  try {
    const cache = CacheService.getScriptCache();
    const janela = Math.floor(Date.now() / (janelaSegundos * 1000));
    const k = "RL_" + chave + "_" + janela;
    const atual = Number(cache.get(k) || 0);
    if (atual >= limite) return false;
    cache.put(k, String(atual + 1), janelaSegundos + 5);
    return true;
  } catch (e) {
    return true; // Falha do cache não deve derrubar o login
  }
}

/**
 * Grava auditoria no máximo 1 vez por janela para a mesma chave
 * (evita que tentativas anônimas em massa inchem a aba Auditoria).
 */
function registrarAuditoriaLimitada(chaveDedupe, janelaSegundos, acao, nome, email, territorio, resultado, detalhes) {
  try {
    const cache = CacheService.getScriptCache();
    const k = "AUDDEDUP_" + Utilities.base64EncodeWebSafe(String(chaveDedupe)).slice(0, 200);
    if (cache.get(k)) return;
    cache.put(k, "1", janelaSegundos);
  } catch (e) {}
  registrarAuditoria(acao, nome, email, territorio, resultado, detalhes);
}

/**
 * ============================================================================
 * BLACKLIST DE LOGIN (aba 'Blacklist')
 * ============================================================================
 * Após CONFIG.LOGIN_FALHAS_MAX tentativas inválidas do mesmo e-mail, ele é
 * bloqueado de forma persistente. Para liberar: o ADMIN cadastra/salva o usuário
 * pelo painel (libera automaticamente) ou muda o Status da linha para LIBERADO.
 */
const CABECALHO_BLACKLIST = ["Email", "Motivo", "Tentativas", "BloqueadoEm", "UltimaTentativa", "Status", "LiberadoPor"];

function obterAbaBlacklist() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Blacklist");
  if (!sheet) {
    sheet = ss.insertSheet("Blacklist");
    sheet.appendRow(CABECALHO_BLACKLIST);
  }
  return sheet;
}

function carregarEmailsBloqueados() {
  const cache = CacheService.getScriptCache();
  const raw = cache.get("BLACKLIST_V1");
  if (raw) {
    try { return new Set(JSON.parse(raw)); } catch (e) {}
  }
  const sheet = obterAbaBlacklist();
  const dados = sheet.getDataRange().getValues();
  const lista = [];
  for (let i = 1; i < dados.length; i++) {
    const email = String(dados[i][0] || "").toLowerCase().trim();
    const status = String(dados[i][5] || "BLOQUEADO").toUpperCase().trim();
    if (email && status === "BLOQUEADO") lista.push(email);
  }
  try { cache.put("BLACKLIST_V1", JSON.stringify(lista), 300); } catch (e) {}
  return new Set(lista);
}

function emailEstaBloqueado(email) {
  if (!email) return false;
  return carregarEmailsBloqueados().has(String(email).toLowerCase().trim());
}

/**
 * Conta uma falha de login para o e-mail. Na 5ª falha o e-mail entra na Blacklist.
 * Retorna true se o e-mail acabou de ser bloqueado.
 */
function registrarFalhaLogin(email, motivo) {
  const emailLimpo = String(email || "").toLowerCase().trim();
  if (!emailLimpo) return false;

  const cache = CacheService.getScriptCache();
  const k = "LOGINFAIL_" + Utilities.base64EncodeWebSafe(emailLimpo);
  const tentativas = Number(cache.get(k) || 0) + 1;
  cache.put(k, String(tentativas), CONFIG.LOGIN_FALHAS_JANELA_SECONDS);

  if (tentativas < CONFIG.LOGIN_FALHAS_MAX) {
    registrarAuditoria("LOGIN", "-", emailLimpo, "-", "NEGADO", `${motivo} (tentativa ${tentativas}/${CONFIG.LOGIN_FALHAS_MAX})`);
    return false;
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    if (!emailEstaBloqueado(emailLimpo)) {
      const agora = new Date();
      obterAbaBlacklist().appendRow(sanitizarLinha([emailLimpo, motivo, tentativas, agora, agora, "BLOQUEADO", ""], 254));
      cache.remove("BLACKLIST_V1");
      registrarAuditoria("BLACKLIST_ADICIONADO", "-", emailLimpo, "-", "BLOQUEADO", `${tentativas} tentativas inválidas. Último motivo: ${motivo}`);
    }
  } catch (e) {
    Logger.log("Falha ao gravar blacklist: " + e.message);
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
  return true;
}

function limparFalhasLogin(email) {
  try {
    CacheService.getScriptCache().remove("LOGINFAIL_" + Utilities.base64EncodeWebSafe(String(email || "").toLowerCase().trim()));
  } catch (e) {}
}

/**
 * Libera um e-mail da Blacklist (chamado quando o ADMIN cadastra/salva o usuário).
 * Retorna true se havia bloqueio ativo.
 */
function liberarEmailBlacklist(email, liberadoPor) {
  const emailLimpo = String(email || "").toLowerCase().trim();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Blacklist");
  if (!sheet || !emailLimpo) return false;
  const dados = sheet.getDataRange().getValues();
  let liberou = false;
  for (let i = 1; i < dados.length; i++) {
    const e = String(dados[i][0] || "").toLowerCase().trim();
    const status = String(dados[i][5] || "").toUpperCase().trim();
    if (e === emailLimpo && status === "BLOQUEADO") {
      sheet.getRange(i + 1, 6, 1, 2).setValues([["LIBERADO", sanitizarCelula(liberadoPor || "", 254)]]);
      liberou = true;
    }
  }
  if (liberou) {
    CacheService.getScriptCache().remove("BLACKLIST_V1");
    limparFalhasLogin(emailLimpo);
  }
  return liberou;
}

/**
 * Comparação de strings em tempo constante (evita timing attack na chave de diagnóstico).
 */
function compararSeguro(a, b) {
  const sa = String(a || "");
  const sb = String(b || "");
  let diff = sa.length ^ sb.length;
  const n = Math.max(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    diff |= (sa.charCodeAt(i) || 0) ^ (sb.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Remove campos internos antes de devolver o usuário ao cliente.
 */
function usuarioPublico(usuario) {
  if (!usuario) return null;
  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    perfil: usuario.perfil,
    status: usuario.status
  };
}

/**
 * Roteador HTTP GET: desativado. Toda a API usa POST (o token de sessão nunca
 * deve trafegar em query string, onde fica registrado em logs e histórico).
 */
function doGet(e) {
  return erroMetodoNaoPermitido();
}

/**
 * Roteador HTTP POST (Autenticação, Sessão e Escrita Transacional)
 * Nota: Aceita text/plain com JSON para evitar bloqueio de preflight CORS no navegador ao chamar Apps Script.
 */
function doPost(e) {
  let body = {};
  try {
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
  } catch (err) {
    return respostaJson({ sucesso: false, codigo: 400, erro: "Payload JSON malformado." });
  }
  return rotearRequisicao("POST", e.parameter || {}, body);
}

/**
 * Middleware Central: authenticate() -> authorize() -> validate() -> execute() -> audit()
 */
function rotearRequisicao(metodo, queryParams, body) {
  const payload = metodo === "POST" ? body : queryParams;
  const rota = String(payload.rota || payload.acao || "").trim();

  try {
    // Rota Pública de Autenticação Inicial (Exige Google ID Token real)
    if (metodo === "POST" && rota === "auth/login") {
      return autenticarGoogleIdentity(payload.idToken);
    }

    // Rota Segura de Inspeção/Diagnóstico da Planilha via Chave Criptográfica (PropertiesService)
    if (metodo === "POST" && rota === "dev/inspecionar-planilha") {
      return processarInspecaoSeguraPlanilha(payload);
    }

    // 1. AUTENTICAÇÃO E VALIDAÇÃO DE SESSÃO
    const tokenSessao = String(payload.sessionToken || "").trim();
    const sessao = validarSessao(tokenSessao);
    if (!sessao) {
      return respostaJson({
        sucesso: false,
        codigo: 401,
        erro: "Sessão inválida ou expirada. Faça login novamente com sua conta Google."
      });
    }

    // Rota de Logout (Revoga imediatamente a sessão no servidor)
    if (metodo === "POST" && rota === "auth/logout") {
      revogarSessao(tokenSessao, sessao.email);
      return respostaJson({ sucesso: true, mensagem: "Sessão encerrada com segurança." });
    }

    // 2. AUTORIZAÇÃO EM TEMPO REAL (Revalida status ATIVO e Perfil na aba Usuarios)
    const usuario = buscarUsuarioAutorizado(sessao.email);
    if (!usuario || usuario.status !== "ATIVO") {
      revogarSessao(tokenSessao, sessao.email);
      registrarAuditoria("ACESSO_REVOGADO", sessao.nome, sessao.email, "-", "NEGADO", "Usuário inativado ou removido da whitelist");
      return respostaJson({
        sucesso: false,
        codigo: 403,
        erro: "Acesso restrito. Seu usuário não possui autorização ativa para utilizar este sistema."
      });
    }

    // 3. ROTEAMENTO POR DOMÍNIO + RBAC
    switch (rota) {
      // --- DOMÍNIO: AUTH ---
      case "auth/me":
        return respostaJson({ sucesso: true, usuario: usuarioPublico(usuario), expiraEm: sessao.expiraEm });

      case "auth/refresh":
        if (metodo !== "POST") return erroMetodoNaoPermitido();
        if (sessao.substituida) {
          // Token já trocado por outro: impede bifurcação de sessões a partir do mesmo token
          return respostaJson({ sucesso: false, codigo: 401, erro: "Sessão já renovada em outra requisição. Faça login novamente." });
        }
        return renovarSessao(tokenSessao, sessao, usuario);

      // --- DOMÍNIO: TERRITÓRIOS (PUBLICADOR + ADMIN) ---
      case "territorios/listar":
        return respostaJson({
          sucesso: true,
          usuario: usuarioPublico(usuario),
          territorios: listarTodosTerritoriosConsolidados(usuario)
        });

      case "territorios/solicitar":
        if (metodo !== "POST") return erroMetodoNaoPermitido();
        return executarComLock(() => solicitarTerritorioTransacional(usuario, payload));

      case "territorios/devolver":
        if (metodo !== "POST") return erroMetodoNaoPermitido();
        return executarComLock(() => devolverTerritorioTransacional(usuario, payload));

      case "predios/marcar-trabalhado":
        if (metodo !== "POST") return erroMetodoNaoPermitido();
        return executarComLock(() => alternarPredioTrabalhadoTransacional(usuario, payload));

      // --- DOMÍNIO: MOVIMENTAÇÕES E RELATÓRIOS ---
      case "movimentacoes/minhas":
        return respostaJson({
          sucesso: true,
          historico: listarHistoricoMovimentacoes(usuario, false)
        });

      case "relatorios/ano-servico":
        return respostaJson({
          sucesso: true,
          relatorio: gerarDadosRelatorioAnoServico(usuario, payload.anoInicio)
        });

      // --- DOMÍNIO: ADMINISTRAÇÃO (EXCLUSIVO ADMIN) ---
      case "admin/dashboard":
        exigirPerfilAdmin(usuario, rota);
        return respostaJson({
          sucesso: true,
          resumo: obterIndicadoresAdmin(usuario),
          historicoRecente: listarHistoricoMovimentacoes(usuario, true).slice(0, 100)
        });

      case "admin/usuarios/listar":
        exigirPerfilAdmin(usuario, rota);
        return respostaJson({
          sucesso: true,
          usuarios: listarTodosUsuariosAdmin()
        });

      case "admin/usuarios/salvar":
        if (metodo !== "POST") return erroMetodoNaoPermitido();
        exigirPerfilAdmin(usuario, rota);
        return executarComLock(() => salvarOuAlterarUsuarioAdmin(usuario, payload.dadosUsuario));

      case "admin/auditoria":
        exigirPerfilAdmin(usuario, rota);
        return respostaJson({
          sucesso: true,
          logs: listarAuditoriaAdmin(150)
        });

      case "admin/lembretes/disparar":
        if (metodo !== "POST") return erroMetodoNaoPermitido();
        exigirPerfilAdmin(usuario, rota);
        const relatorio = dispararLembretesPorEmail(usuario);
        return respostaJson({
          sucesso: true,
          mensagem: `Processamento concluído: ${relatorio.enviados} e-mail(s) enviado(s).`,
          relatorio: relatorio
        });

      default:
        return respostaJson({ sucesso: false, codigo: 404, erro: `Rota '${rota}' não encontrada na API.` });
    }

  } catch (err) {
    if (err.message === "FORBIDDEN_ADMIN") {
      return respostaJson({ sucesso: false, codigo: 403, erro: "403 Forbidden — Operação exclusiva para perfil ADMIN." });
    }
    Logger.log("Erro na API: " + err.stack);
    return respostaJson({ sucesso: false, codigo: 500, erro: "Erro interno ao processar a solicitação." });
  }
}

/**
 * ============================================================================
 * CAMADA 1, 2 e 3: IDENTIDADE GOOGLE, WHITELIST E SESSÃO (CacheService)
 * ============================================================================
 */
function autenticarGoogleIdentity(idToken) {
  if (!idToken) {
    return respostaJson({ sucesso: false, codigo: 401, erro: "Token de identidade do Google ausente." });
  }

  // Validação estrutural barata ANTES de gastar quota de UrlFetch (JWT = 3 segmentos base64url)
  const tokenStr = String(idToken);
  if (tokenStr.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(tokenStr)) {
    return respostaJson({ sucesso: false, codigo: 401, erro: "Credencial do Google inválida ou expirada." });
  }

  // Rate limit global: protege quotas de UrlFetch/execução e a aba Auditoria
  if (!consumirCota("LOGIN_GLOBAL", CONFIG.LOGIN_LIMITE_POR_MINUTO, 60)) {
    return respostaJson({ sucesso: false, codigo: 429, erro: "Muitas tentativas de login no momento. Aguarde um minuto e tente novamente." });
  }

  // Valida criptograficamente o JWT direto no servidor OAuth2 do Google
  const urlVerificacao = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken);
  let resp;
  try {
    resp = UrlFetchApp.fetch(urlVerificacao, { muteHttpExceptions: true });
  } catch (e) {
    return respostaJson({ sucesso: false, codigo: 503, erro: "Falha ao contatar serviço de identidade do Google." });
  }

  if (resp.getResponseCode() !== 200) {
    registrarAuditoriaLimitada("LOGIN_TOKEN_INVALIDO", 300, "LOGIN_TOKEN_INVALIDO", "Desconhecido", "-", "-", "ERRO", "ID Token rejeitado pelo Google (registro agregado a cada 5 min)");
    return respostaJson({ sucesso: false, codigo: 401, erro: "Credencial do Google inválida ou expirada." });
  }

  let tokenInfo;
  try {
    tokenInfo = JSON.parse(resp.getContentText());
  } catch (e) {
    return respostaJson({ sucesso: false, codigo: 401, erro: "Credencial do Google inválida ou expirada." });
  }

  // Nome e e-mail vêm do perfil Google do próprio solicitante (dado não confiável): sempre sanitizados
  const emailAutenticado = String(tokenInfo.email || "").toLowerCase().trim().slice(0, 254);
  const nomeGoogle = sanitizarCelula(String(tokenInfo.name || emailAutenticado.split("@")[0]).trim(), 120);

  // E-mail na Blacklist: recusa imediata, sem consultar whitelist nem gravar auditoria repetida
  if (emailEstaBloqueado(emailAutenticado)) {
    registrarAuditoriaLimitada("BL_" + emailAutenticado, 3600, "LOGIN_BLACKLIST", "-", emailAutenticado, "-", "BLOQUEADO", "Tentativa de e-mail bloqueado (registro agregado a cada 1 h)");
    return respostaBloqueioBlacklist();
  }

  // Cada recusa abaixo conta como tentativa inválida para o e-mail (5 → Blacklist)
  const recusar = (codigo, motivo, mensagem) => {
    const bloqueou = registrarFalhaLogin(emailAutenticado, motivo);
    return bloqueou ? respostaBloqueioBlacklist() : respostaJson({ sucesso: false, codigo: codigo, erro: mensagem });
  };

  if (tokenInfo.email_verified !== "true" && tokenInfo.email_verified !== true) {
    return recusar(401, "E-mail Google não verificado", "O endereço de e-mail da conta Google não está verificado.");
  }

  if (CONFIG.GOOGLE_CLIENT_ID && tokenInfo.aud !== CONFIG.GOOGLE_CLIENT_ID) {
    return recusar(401, "Client ID divergente (token de outra aplicação)", "Token emitido para outra aplicação cliente.");
  }

  if (CONFIG.GOOGLE_ISSUERS.indexOf(String(tokenInfo.iss || "")) === -1) {
    return recusar(401, "Emissor do token não é o Google", "Credencial do Google inválida ou expirada.");
  }

  const expSeg = Number(tokenInfo.exp || 0);
  if (!expSeg || expSeg * 1000 < Date.now()) {
    // Token expirado é situação normal (aba aberta há muito tempo): não conta como tentativa inválida
    return respostaJson({ sucesso: false, codigo: 401, erro: "Credencial do Google inválida ou expirada." });
  }

  // Garante que as abas de segurança ('Usuarios' e 'Auditoria') existam
  inicializarAbasSegurancaSeNecessario();

  // Consulta a Whitelist (Aba 'Usuarios')
  const usuario = buscarUsuarioAutorizado(emailAutenticado, true);
  if (!usuario) {
    return recusar(403, "E-mail não consta na Whitelist (Usuarios)", "Acesso restrito. Seu usuário não possui autorização para utilizar este sistema.");
  }

  if (usuario.status !== "ATIVO") {
    return recusar(403, "Usuário com Status INATIVO", "Acesso restrito. Seu cadastro encontra-se inativo.");
  }

  limparFalhasLogin(emailAutenticado);
  const novaSessao = criarSessao(usuario, Date.now());
  registrarAuditoria("LOGIN", usuario.nome, usuario.email, "-", "SUCESSO", `Perfil: ${usuario.perfil}`);

  return respostaJson({
    sucesso: true,
    sessionToken: novaSessao.sessionToken,
    expiraEm: novaSessao.expiraEm,
    usuario: usuarioPublico(usuario)
  });
}

function respostaBloqueioBlacklist() {
  return respostaJson({
    sucesso: false,
    codigo: 403,
    erro: "Acesso bloqueado após tentativas inválidas repetidas. Procure o administrador do sistema para liberar seu e-mail."
  });
}

/**
 * Cria uma sessão opaca de duração FIXA (CONFIG.SESSION_TTL_SECONDS).
 * origemEm = momento do login com Google (preservado nas renovações para limitar a cadeia).
 */
function criarSessao(usuario, origemEm) {
  const sessionToken = Utilities.getUuid() + "-" + Utilities.getUuid();
  const agora = Date.now();
  const expiraEm = agora + (CONFIG.SESSION_TTL_SECONDS * 1000);
  const dadosSessao = {
    email: usuario.email,
    nome: usuario.nome,
    perfil: usuario.perfil,
    origemEm: origemEm || agora,
    criadoEm: agora,
    expiraEm: expiraEm
  };
  CacheService.getScriptCache().put("SESS_" + sessionToken, JSON.stringify(dadosSessao), CONFIG.SESSION_TTL_SECONDS);
  return { sessionToken: sessionToken, expiraEm: expiraEm };
}

function validarSessao(sessionToken) {
  if (!sessionToken || sessionToken.length > 200) return null;
  const cache = CacheService.getScriptCache();
  const raw = cache.get("SESS_" + sessionToken);
  if (!raw) return null;

  try {
    const sessao = JSON.parse(raw);
    // Sessão fixa: SEM renovação automática a cada requisição (a renovação é explícita via auth/refresh)
    if (!sessao.expiraEm || Date.now() > sessao.expiraEm) {
      cache.remove("SESS_" + sessionToken);
      return null;
    }
    return sessao;
  } catch (e) {
    return null;
  }
}

/**
 * auth/refresh — Renova a sessão SOMENTE quando necessário:
 * - aceita apenas nos últimos CONFIG.SESSION_REFRESH_JANELA_SECONDS da sessão (antes disso devolve a atual);
 * - o usuário já foi revalidado na whitelist (ATIVO) pelo middleware antes de chegar aqui;
 * - emite um token NOVO e encurta o antigo para um período de tolerância (requisições em andamento);
 * - a cadeia de renovações não ultrapassa CONFIG.SESSION_MAX_AGE_SECONDS desde o login com Google.
 */
function renovarSessao(tokenAtual, sessao, usuario) {
  const restanteMs = sessao.expiraEm - Date.now();
  if (restanteMs > CONFIG.SESSION_REFRESH_JANELA_SECONDS * 1000) {
    return respostaJson({ sucesso: true, renovada: false, sessionToken: tokenAtual, expiraEm: sessao.expiraEm });
  }

  const origemEm = sessao.origemEm || sessao.criadoEm || Date.now();
  if (Date.now() - origemEm > CONFIG.SESSION_MAX_AGE_SECONDS * 1000) {
    return respostaJson({ sucesso: false, codigo: 401, erro: "Sua sessão atingiu o tempo máximo. Faça login novamente com sua conta Google." });
  }

  const nova = criarSessao(usuario, origemEm);

  // Token antigo: mantém só pelo período de tolerância, já marcado como substituído
  const cache = CacheService.getScriptCache();
  const graca = Math.min(CONFIG.SESSION_GRACE_SECONDS, Math.max(1, Math.floor(restanteMs / 1000)));
  sessao.expiraEm = Math.min(sessao.expiraEm, Date.now() + graca * 1000);
  sessao.substituida = true;
  cache.put("SESS_" + tokenAtual, JSON.stringify(sessao), graca);

  return respostaJson({ sucesso: true, renovada: true, sessionToken: nova.sessionToken, expiraEm: nova.expiraEm });
}

function revogarSessao(sessionToken, email) {
  if (!sessionToken) return;
  CacheService.getScriptCache().remove("SESS_" + sessionToken);
  registrarAuditoria("LOGOUT", "-", email || "-", "-", "SUCESSO", "Sessão revogada");
}

function exigirPerfilAdmin(usuario, rota) {
  if (!usuario || usuario.perfil !== "ADMIN") {
    registrarAuditoria("ACESSO_ADMIN_NEGADO", usuario ? usuario.nome : "-", usuario ? usuario.email : "-", "-", "NEGADO", `Tentativa de acesso à rota ${rota}`);
    throw new Error("FORBIDDEN_ADMIN");
  }
}

/**
 * Inicializa e popula automaticamente as abas 'Usuarios' e 'Auditoria' caso ainda não existam
 */
function inicializarAbasSegurancaSeNecessario() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheetUsuarios = ss.getSheetByName("Usuarios");

  if (!sheetUsuarios) {
    sheetUsuarios = ss.insertSheet("Usuarios");
    sheetUsuarios.appendRow([
      "Id", "Nome", "Email", "Perfil", "Status", "CriadoEm", "CriadoPor", "UltimoAcesso", "UltimaAtividade"
    ]);
    const agora = new Date();
    const emailProprietario = String(CONFIG.ADMIN_ROOT_EMAIL || "").toLowerCase().trim();
    if (emailProprietario) {
      sheetUsuarios.appendRow([
        "USR-001", "Administrador", emailProprietario, "ADMIN", "ATIVO", agora, "SISTEMA", agora, "BOOT"
      ]);
    }
  }

  let sheetAuditoria = ss.getSheetByName("Auditoria");
  if (!sheetAuditoria) {
    sheetAuditoria = ss.insertSheet("Auditoria");
    sheetAuditoria.appendRow([
      "IdOperacao", "DataHora", "Usuario", "Email", "Acao", "Territorio", "Resultado", "Detalhes"
    ]);
  }
}

/**
 * Busca usuário na aba 'Usuarios' utilizando o e-mail como identificador único
 */
function buscarUsuarioAutorizado(email, atualizarAcesso) {
  if (!email) return null;
  const emailLimpo = String(email).toLowerCase().trim();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Usuarios");

  if (!sheet) {
    inicializarAbasSegurancaSeNecessario();
    sheet = ss.getSheetByName("Usuarios");
  }

  const dados = sheet.getDataRange().getValues();
  for (let i = 1; i < dados.length; i++) {
    const rowEmail = String(dados[i][2] || "").toLowerCase().trim();
    if (rowEmail === emailLimpo) {
      if (atualizarAcesso) {
        sheet.getRange(i + 1, 8).setValue(new Date());
      }
      return {
        id: String(dados[i][0] || `USR-${i}`),
        nome: String(dados[i][1] || "").trim(),
        email: rowEmail,
        perfil: String(dados[i][3] || "PUBLICADOR").toUpperCase().trim(),
        status: String(dados[i][4] || "INATIVO").toUpperCase().trim(),
        linhaPlanilha: i + 1
      };
    }
  }
  return null;
}

function atualizarUltimaAtividadeUsuario(email, descricaoAtividade) {
  try {
    const u = buscarUsuarioAutorizado(email, false);
    if (u && u.linhaPlanilha) {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Usuarios");
      sheet.getRange(u.linhaPlanilha, 9).setValue("'" + `${descricaoAtividade} (${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm")})`);
    }
  } catch (e) {}
}

/**
 * ============================================================================
 * CAMADA 5: LEITURA E REGRAS DE NEGÓCIO DOS 94 TERRITÓRIOS + GEOMETRIA MAPA
 * ============================================================================
 */
function listarTodosTerritoriosConsolidados(usuarioSolicitante) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetBase = ss.getSheetByName("BASE");
  const sheetDash = ss.getSheetByName("DASHBOARD");
  const sheetResp = ss.getSheetByName("Respostas");

  // 1. Mapear metadados e polígonos WKT da aba 'BASE'
  const mapaBase = {};
  if (sheetBase) {
    const dadosBase = sheetBase.getDataRange().getValues();
    const cabecalho = dadosBase[0].map(c => String(c).trim());
    const idxWkt = cabecalho.indexOf("wkt_geom");
    const idxSit = cabecalho.indexOf("SITUACAO");
    const idxNum = cabecalho.indexOf("NUM_TER");
    const idxDesc = cabecalho.indexOf("DESC_TERRITORIO");

    for (let i = 1; i < dadosBase.length; i++) {
      const num = String(dadosBase[i][idxNum] || "").trim().replace(/^0+/, "");
      if (!num) continue;
      mapaBase[num] = {
        numero: num,
        bairro: String(dadosBase[i][idxDesc] || "Centro").trim(),
        tipo: String(dadosBase[i][idxSit] || "Urbana").trim() === "Rural" ? "Rural" : "Cidade",
        wkt: idxWkt >= 0 ? String(dadosBase[i][idxWkt] || "") : ""
      };
    }
  }

  // 2. Mapear links de PDF da aba 'DASHBOARD' (se houver)
  const mapaPdf = {};
  if (sheetDash) {
    const dadosDash = sheetDash.getDataRange().getValues();
    for (let i = 1; i < dadosDash.length; i++) {
      const num = String(dadosDash[i][0] || "").trim().replace(/^0+/, "");
      if (!num) continue;
      mapaPdf[num] = {
        nomePdf: String(dadosDash[i][4] || "").trim(),
        bairroDash: String(dadosDash[i][6] || "").trim()
      };
    }
  }

  // 3. Processar todo o histórico da aba 'Respostas' de forma 100% independente da ordem das linhas
  const emailPorNomeFallback = {};
  const historicoPorTerritorio = {};

  if (sheetResp) {
    const dadosResp = sheetResp.getDataRange().getValues();
    for (let i = 1; i < dadosResp.length; i++) {
      const carimboRaw = dadosResp[i][0];
      const nomeDirigente = String(dadosResp[i][1] || "").trim();
      const num = String(dadosResp[i][2] || "").trim().replace(/^0+/, "");
      const acao = String(dadosResp[i][3] || "").trim();
      const dataControleRaw = dadosResp[i][4];
      const emailRaw = String(dadosResp[i][5] || "").toLowerCase().trim();
      const tipoResp = String(dadosResp[i][6] || "").trim();

      if (!num || (acao !== "Solicitar" && acao !== "Devolver")) continue;

      if (emailRaw && emailRaw.includes("@") && !emailRaw.endsWith(".comf")) {
        emailPorNomeFallback[nomeDirigente.toLowerCase()] = emailRaw;
      }

      const ts = extrairTimestamp(carimboRaw) || extrairTimestamp(dataControleRaw) || 0;
      const dtControleTs = extrairTimestamp(dataControleRaw) || ts;

      if (!historicoPorTerritorio[num]) historicoPorTerritorio[num] = [];
      historicoPorTerritorio[num].push({
        timestamp: ts,
        dataControleTs: dtControleTs,
        nome: nomeDirigente,
        acao: acao,
        email: emailRaw,
        tipo: tipoResp
      });
    }
  }

  // Unificar lista de todos os números de territórios (BASE + DASHBOARD + Respostas)
  const todosNumerosSet = new Set([
    ...Object.keys(mapaBase),
    ...Object.keys(mapaPdf),
    ...Object.keys(historicoPorTerritorio)
  ]);

  const listaNumeros = Array.from(todosNumerosSet).sort((a, b) => Number(a) - Number(b));
  const agora = new Date();
  const hojeMeiaNoiteMs = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).getTime();
  const fusoScript = Session.getScriptTimeZone();
  const resultado = [];
  const emailSolicitante = usuarioSolicitante ? String(usuarioSolicitante.email || "").toLowerCase() : "";
  const podeVerNomesHistorico =
    (usuarioSolicitante && usuarioSolicitante.perfil === "ADMIN") ||
    lerPropriedade("EXPOR_NOMES_HISTORICO", "false") === "true";

  for (const num of listaNumeros) {
    const infoBase = mapaBase[num] || { numero: num, bairro: (mapaPdf[num] && mapaPdf[num].bairroDash) || "Território " + num, tipo: "Cidade", wkt: "" };
    const hist = historicoPorTerritorio[num] || [];

    // Ordenação decrescente imune à ordem da planilha (Carimbo desc -> "Devolver" > "Solicitar")
    hist.sort((a, b) => {
      if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
      if (a.acao !== b.acao) return a.acao === "Devolver" ? -1 : 1;
      return 0;
    });

    let ultimaAcao = "Nunca Usado";
    let ultimaDataIso = "";
    let statusReal = "DISPONÍVEL";
    let dirigenteAtual = "";
    let emailAtual = "";
    let emPosseDoUsuarioAtual = false;

    if (hist.length > 0) {
      const ultimo = hist[0];
      ultimaAcao = ultimo.acao;
      const tsRef = ultimo.dataControleTs || ultimo.timestamp;
      ultimaDataIso = tsRef ? Utilities.formatDate(new Date(tsRef), fusoScript, "yyyy-MM-dd") : "";
      const emailResolvido = ultimo.email || emailPorNomeFallback[ultimo.nome.toLowerCase()] || "";

      if (ultimo.acao === "Solicitar") {
        statusReal = "OCUPADO";
        dirigenteAtual = ultimo.nome;
        emailAtual = emailResolvido;
        // Identificador único por e-mail (ou match de primeiro nome caso linha manual antiga não tenha e-mail)
        if (usuarioSolicitante) {
          emPosseDoUsuarioAtual =
            (emailResolvido && emailResolvido === usuarioSolicitante.email) ||
            (!emailResolvido && ultimo.nome.toLowerCase() === usuarioSolicitante.nome.toLowerCase());
        }
      } else {
        const dtRef = new Date(tsRef);
        const dtRefMeiaNoiteMs = new Date(dtRef.getFullYear(), dtRef.getMonth(), dtRef.getDate()).getTime();
        const diasCorridos = Math.floor((hojeMeiaNoiteMs - dtRefMeiaNoiteMs) / (1000 * 60 * 60 * 24));
        statusReal = diasCorridos <= CONFIG.DIAS_RECENTE ? "RECENTE" : "DISPONÍVEL";
        dirigenteAtual = ultimo.nome;
      }
    }

    // Montar ciclos históricos (Solicitar -> Devolver) em ordem cronológica
    const histCronologico = [...hist].reverse();
    const ciclos = [];
    let cicloAberto = null;

    for (const mov of histCronologico) {
      const tsMov = mov.dataControleTs || mov.timestamp;
      const dataIso = tsMov ? Utilities.formatDate(new Date(tsMov), fusoScript, "yyyy-MM-dd") : "";
      if (mov.acao === "Solicitar") {
        if (cicloAberto) {
          ciclos.push(cicloAberto);
        }
        cicloAberto = {
          dirigente: mov.nome,
          _email: mov.email || emailPorNomeFallback[mov.nome.toLowerCase()] || "",
          dataDesignacao: dataIso,
          dataConclusao: ""
        };
      } else if (mov.acao === "Devolver") {
        if (cicloAberto) {
          cicloAberto.dataConclusao = dataIso;
          if (!cicloAberto.dirigente && mov.nome) cicloAberto.dirigente = mov.nome;
          ciclos.push(cicloAberto);
          cicloAberto = null;
        } else {
          ciclos.push({
            dirigente: mov.nome,
            _email: mov.email || emailPorNomeFallback[mov.nome.toLowerCase()] || "",
            dataDesignacao: "",
            dataConclusao: dataIso
          });
        }
      }
    }
    if (cicloAberto) {
      ciclos.push(cicloAberto);
    }

    // LGPD (minimização): o nome de quem trabalhou cada ciclo só é enviado a ADMIN
    // ou ao próprio dirigente. Reverter com a ScriptProperty EXPOR_NOMES_HISTORICO = true.
    const ciclosPublicos = ciclos.map(c => ({
      dirigente: (podeVerNomesHistorico || (emailSolicitante && c._email === emailSolicitante)) ? c.dirigente : "",
      dataDesignacao: c.dataDesignacao,
      dataConclusao: c.dataConclusao
    }));

    resultado.push({
      numero: Number(num),
      codigoComposto: `${num} - ${infoBase.bairro}`,
      bairro: infoBase.bairro,
      tipo: infoBase.tipo,
      statusReal: statusReal,
      ultimaAcao: ultimaAcao,
      ultimaData: ultimaDataIso,
      dirigente: usuarioSolicitante.perfil === "ADMIN" || statusReal === "OCUPADO" ? dirigenteAtual : "",
      emailDirigente: usuarioSolicitante.perfil === "ADMIN" ? emailAtual : "",
      emMinhaPosse: emPosseDoUsuarioAtual,
      nomePdf: (mapaPdf[num] && mapaPdf[num].nomePdf) || `Mapa_PatoBranco_${infoBase.bairro}_${num}.pdf`,
      wkt: infoBase.wkt,
      ciclos: ciclosPublicos,
      predios: [],
      totalPredios: 0
    });
  }

  // Anexar prédios georreferenciados da Congregação Norte (descartando qualquer item fora dos 94 territórios ativos)
  const mapaPredios = carregarPrediosPorTerritorio(ss, todosNumerosSet);
  for (let i = 0; i < resultado.length; i++) {
    const listaP = mapaPredios[String(resultado[i].numero)] || [];
    resultado[i].predios = listaP;
    resultado[i].totalPredios = listaP.length;
  }

  // Ordenação padrão por antiguidade (nunca trabalhados ou devolvidos há mais tempo primeiro)
  resultado.sort((a, b) => {
    const aOcupado = a.statusReal === "OCUPADO" ? 1 : 0;
    const bOcupado = b.statusReal === "OCUPADO" ? 1 : 0;
    if (aOcupado !== bOcupado) return aOcupado - bOcupado;

    if (a.ultimaData !== b.ultimaData) {
      if (!a.ultimaData) return -1;
      if (!b.ultimaData) return 1;
      return a.ultimaData.localeCompare(b.ultimaData);
    }
    return Number(a.numero) - Number(b.numero);
  });

  return resultado;
}

/**
 * ============================================================================
 * CAMADA 10: OPERAÇÕES TRANSACIONAIS COM CONTROLE DE CONCORRÊNCIA (LockService)
 * ============================================================================
 */
function executarComLock(callbackTransacional) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return respostaJson({
      sucesso: false,
      codigo: 429,
      erro: "Concorrência detectada: outro dirigente está registrando uma operação neste exato instante. Aguarde alguns segundos e tente novamente."
    });
  }
  try {
    return callbackTransacional();
  } finally {
    lock.releaseLock();
  }
}

function solicitarTerritorioTransacional(usuario, payload) {
  let listaBruta = [];
  if (payload && Array.isArray(payload.numerosTerritorios)) {
    listaBruta = payload.numerosTerritorios;
  } else if (payload && payload.numeroTerritorio !== undefined) {
    listaBruta = [payload.numeroTerritorio];
  } else if (typeof payload === "number" || typeof payload === "string") {
    listaBruta = [payload];
  }

  const numeros = Array.from(new Set(
    listaBruta
      .map(n => String(n || "").trim().replace(/^0+/, ""))
      .filter(n => n && !isNaN(Number(n)))
  ));

  if (numeros.length === 0) {
    return respostaJson({ sucesso: false, codigo: 400, erro: "Selecione ao menos 1 território válido." });
  }
  if (numeros.length > 3) {
    return respostaJson({ sucesso: false, codigo: 400, erro: "Você pode selecionar no máximo 3 territórios por solicitação." });
  }

  const todos = listarTodosTerritoriosConsolidados(usuario);
  const selecionados = [];
  const conflitos = [];

  for (const num of numeros) {
    const territorio = todos.find(t => String(t.numero) === num);
    if (!territorio) {
      registrarAuditoria("SOLICITAR_TERRITORIO", usuario.nome, usuario.email, num, "ERRO", "Território inexistente");
      return respostaJson({ sucesso: false, codigo: 404, erro: `O território ${num} não existe na base.` });
    }
    if (territorio.statusReal !== "DISPONÍVEL") {
      conflitos.push({
        numero: territorio.numero,
        bairro: territorio.bairro,
        statusReal: territorio.statusReal,
        dirigente: territorio.dirigente || "",
        ultimaData: territorio.ultimaData || ""
      });
    } else {
      selecionados.push(territorio);
    }
  }

  if (conflitos.length > 0) {
    const descConflitos = conflitos.map(c =>
      c.statusReal === "OCUPADO"
        ? `T-${c.numero} (${c.bairro} - já retirado por ${c.dirigente || "outro dirigente"})`
        : `T-${c.numero} (${c.bairro} - em quarentena de ${CONFIG.DIAS_RECENTE} dias)`
    ).join(", ");
    registrarAuditoria("SOLICITAR_TERRITORIO", usuario.nome, usuario.email, numeros.join(","), "NEGADO_CONCORRENCIA", descConflitos);
    return respostaJson({
      sucesso: false,
      codigo: 409,
      erro: `Indisponível por concorrência ou quarentena: ${descConflitos}. A fila foi atualizada automaticamente.`,
      conflitos: conflitos,
      territorios: todos
    });
  }

  // Regra da Fila Top 5 validada NO SERVIDOR (antes existia só no frontend e podia ser contornada via fetch)
  if (usuario.perfil !== "ADMIN") {
    const elegiveis = calcularNumerosElegiveisFila(todos);
    const foraDaFila = selecionados.filter(t => !elegiveis.has(String(t.numero)));
    if (foraDaFila.length > 0) {
      const desc = foraDaFila.map(t => `T-${t.numero}`).join(", ");
      registrarAuditoria("SOLICITAR_TERRITORIO", usuario.nome, usuario.email, numeros.join(","), "NEGADO_FORA_DA_FILA", desc);
      return respostaJson({
        sucesso: false,
        codigo: 409,
        erro: `${desc} não está entre os ${CONFIG.LIMITE_FILA} mais antigos da fila. A fila foi atualizada automaticamente.`,
        territorios: todos
      });
    }

    // Limite opcional de territórios simultâneos por dirigente (ScriptProperty LIMITE_POSSE_POR_PUBLICADOR; 0 = sem limite)
    const limitePosse = Number(lerPropriedade("LIMITE_POSSE_POR_PUBLICADOR", "0")) || 0;
    if (limitePosse > 0) {
      const emPosse = todos.filter(t => t.emMinhaPosse && t.statusReal === "OCUPADO").length;
      if (emPosse + selecionados.length > limitePosse) {
        registrarAuditoria("SOLICITAR_TERRITORIO", usuario.nome, usuario.email, numeros.join(","), "NEGADO_LIMITE_POSSE", `Em posse: ${emPosse}, limite: ${limitePosse}`);
        return respostaJson({
          sucesso: false,
          codigo: 409,
          erro: `Você já está com ${emPosse} território(s). O limite é de ${limitePosse} território(s) simultâneos por dirigente.`
        });
      }
    }
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetResp = ss.getSheetByName("Respostas");
  const agora = new Date();
  const dataSomente = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());

  for (const territorio of selecionados) {
    sheetResp.appendRow(sanitizarLinha([
      agora,
      usuario.nome,
      Number(territorio.numero),
      "Solicitar",
      dataSomente,
      usuario.email,
      territorio.tipo || "Cidade",
      "",
      ""
    ], 200));
  }

  SpreadsheetApp.flush();
  const resumoNums = selecionados.map(t => `T-${t.numero}`).join(", ");
  atualizarUltimaAtividadeUsuario(usuario.email, `Solicitou ${resumoNums}`);
  registrarAuditoria("SOLICITAR_TERRITORIO", usuario.nome, usuario.email, selecionados.map(t => t.numero).join(","), "SUCESSO", `Territórios reservados: ${resumoNums}`);

  return respostaJson({
    sucesso: true,
    numerosReservados: selecionados.map(t => t.numero),
    mensagem: selecionados.length === 1
      ? `Território ${selecionados[0].numero} (${selecionados[0].bairro}) reservado com sucesso para ${usuario.nome}!`
      : `${selecionados.length} territórios (${resumoNums}) reservados com sucesso para ${usuario.nome}!`
  });
}

/**
 * Espelha a regra da Fila Top 5 do frontend (App.obterFilaCincoDisponiveis):
 * um território é elegível se estiver entre os 5 mais antigos DISPONÍVEIS em
 * qualquer um dos filtros oferecidos na tela (Geral, Com Prédios, Urbano, Rural).
 * A lista recebida já vem ordenada por antiguidade por listarTodosTerritoriosConsolidados.
 */
function calcularNumerosElegiveisFila(todosOrdenados) {
  const limite = CONFIG.LIMITE_FILA;
  const disponiveis = todosOrdenados.filter(t => t.statusReal === "DISPONÍVEL");

  // O frontend usa prédios-semente como fallback quando a aba Predios não tem itens do território
  const numerosComSemente = new Set(PREDIOS_SEMENTE_NORTE.map(r => String(r[1])));
  const temPredios = t => (Array.isArray(t.predios) && t.predios.length > 0) || numerosComSemente.has(String(t.numero));

  const grupos = [
    disponiveis,
    disponiveis.filter(temPredios),
    disponiveis.filter(t => t.tipo === "Cidade"),
    disponiveis.filter(t => t.tipo === "Rural")
  ];

  const elegiveis = new Set();
  for (const g of grupos) {
    g.slice(0, limite).forEach(t => elegiveis.add(String(t.numero)));
  }
  return elegiveis;
}

function devolverTerritorioTransacional(usuario, payload) {
  const numeroRaw = (payload && payload.numeroTerritorio !== undefined) ? payload.numeroTerritorio : payload;
  const num = String(numeroRaw || "").trim().replace(/^0+/, "");
  if (!num || isNaN(Number(num))) {
    return respostaJson({ sucesso: false, codigo: 400, erro: "Número de território inválido." });
  }

  const foiCompleto = (payload && typeof payload.foiCompleto === "boolean") ? payload.foiCompleto : true;
  const motivoRaw = String((payload && (payload.motivoNaoCompleto || payload.observacao)) || "").toUpperCase().trim();
  const MOTIVOS_PERMITIDOS = ["QUADRAS_FALTANTES", "PREDIOS_NAO_TRABALHADOS", "NAO_INICIADO"];

  if (!foiCompleto && MOTIVOS_PERMITIDOS.indexOf(motivoRaw) === -1) {
    return respostaJson({
      sucesso: false,
      codigo: 400,
      erro: "Selecione um motivo válido para a devolução parcial ou não iniciada."
    });
  }

  const todos = listarTodosTerritoriosConsolidados(usuario);
  const territorio = todos.find(t => String(t.numero) === num);

  if (!territorio) {
    return respostaJson({ sucesso: false, codigo: 404, erro: `O território ${num} não existe na base.` });
  }

  if (territorio.statusReal !== "OCUPADO") {
    registrarAuditoria("DEVOLVER_TERRITORIO", usuario.nome, usuario.email, num, "NEGADO", "Território já consta como devolvido");
    return respostaJson({
      sucesso: false,
      codigo: 409,
      erro: `O território ${num} não consta como ocupado no momento.`
    });
  }

  if (usuario.perfil !== "ADMIN" && !territorio.emMinhaPosse) {
    registrarAuditoria("DEVOLVER_TERRITORIO_ALHEIO", usuario.nome, usuario.email, num, "NEGADO", `Pertence a ${territorio.dirigente}`);
    return respostaJson({
      sucesso: false,
      codigo: 403,
      erro: `Operação negada: o território ${num} consta em posse de ${territorio.dirigente}. Apenas o próprio dirigente ou um Administrador pode devolvê-lo.`
    });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetResp = ss.getSheetByName("Respostas");
  const agora = new Date();
  const dataSomente = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());

  // Regra "Não Iniciado": cancela a solicitação aberta sem gerar data de início nem de conclusão,
  // retornando imediatamente à fila como DISPONÍVEL com sua antiguidade original preservada.
  if (!foiCompleto && motivoRaw === "NAO_INICIADO") {
    const dadosResp = sheetResp.getDataRange().getValues();
    let linhaSolicitacaoAberta = -1;
    let maxTs = -1;

    for (let i = dadosResp.length - 1; i >= 1; i--) {
      const nLinha = String(dadosResp[i][2] || "").trim().replace(/^0+/, "");
      const acaoLinha = String(dadosResp[i][3] || "").trim();
      if (nLinha === num && acaoLinha === "Solicitar") {
        const tsLinha = extrairTimestamp(dadosResp[i][0]) || extrairTimestamp(dadosResp[i][4]) || i;
        if (tsLinha >= maxTs) {
          maxTs = tsLinha;
          linhaSolicitacaoAberta = i + 1;
        }
      }
    }

    if (linhaSolicitacaoAberta > 0) {
      sheetResp.getRange(linhaSolicitacaoAberta, 4).setValue("Cancelado_NaoIniciado");
      sheetResp.getRange(linhaSolicitacaoAberta, 9).setValue("NAO_INICIADO");
    }

    resetarPrediosDoTerritorio(ss, num);
    SpreadsheetApp.flush();
    atualizarUltimaAtividadeUsuario(usuario.email, `Devolveu T-${num} (Não Iniciado)`);
    registrarAuditoria("DEVOLVER_NAO_INICIADO", usuario.nome, usuario.email, num, "SUCESSO", "Retornou para a fila como DISPONÍVEL sem datas de início/conclusão");

    return respostaJson({
      sucesso: true,
      statusRetorno: "DISPONÍVEL",
      mensagem: `O território ${num} (${territorio.bairro}) retornou imediatamente para a fila de disponíveis (Não Iniciado).`
    });
  }

  const tagFechada = foiCompleto ? "COMPLETO" : motivoRaw;
  sheetResp.appendRow(sanitizarLinha([
    agora,
    usuario.nome,
    Number(num),
    "Devolver",
    dataSomente,
    usuario.email,
    territorio.tipo || "Cidade",
    "",
    tagFechada
  ], 200));

  resetarPrediosDoTerritorio(ss, num);
  SpreadsheetApp.flush();
  atualizarUltimaAtividadeUsuario(usuario.email, `Devolveu T-${num} (${tagFechada})`);
  registrarAuditoria("DEVOLVER_TERRITORIO", usuario.nome, usuario.email, num, "SUCESSO", `Tag: ${tagFechada} | Devolvido por ${usuario.email}`);

  return respostaJson({
    sucesso: true,
    statusRetorno: "RECENTE",
    mensagem: `Devolução do território ${num} (${territorio.bairro}) registrada como concluída! O cartão entrou no ciclo de descanso de ${CONFIG.DIAS_RECENTE} dias.`
  });
}

/**
 * ============================================================================
 * HISTÓRICO, ADMINISTRAÇÃO DE USUÁRIOS, AUDITORIA E LEMBRETES
 * ============================================================================
 */
function listarHistoricoMovimentacoes(usuario, todosOsUsuarios) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetResp = ss.getSheetByName("Respostas");
  if (!sheetResp) return [];

  const dados = sheetResp.getDataRange().getValues();
  const lista = [];

  for (let i = 1; i < dados.length; i++) {
    const carimboRaw = dados[i][0];
    const nome = String(dados[i][1] || "").trim();
    const num = String(dados[i][2] || "").trim().replace(/^0+/, "");
    const acao = String(dados[i][3] || "").trim();
    const dataControleRaw = dados[i][4];
    const email = String(dados[i][5] || "").toLowerCase().trim();
    const tipo = String(dados[i][6] || "Cidade").trim();

    if (!num || !acao) continue;

    const pertenceAoUsuario =
      email === usuario.email ||
      (!email && nome.toLowerCase() === usuario.nome.toLowerCase());

    if (todosOsUsuarios || pertenceAoUsuario) {
      const ts = extrairTimestamp(carimboRaw) || extrairTimestamp(dataControleRaw) || 0;
      lista.push({
        timestamp: ts,
        dataFormatada: ts ? Utilities.formatDate(new Date(ts), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm") : "-",
        dirigente: nome,
        email: email,
        numeroTerritorio: Number(num),
        acao: acao,
        tipo: tipo
      });
    }
  }

  lista.sort((a, b) => b.timestamp - a.timestamp);
  return lista;
}

/**
 * Filtra os ciclos de trabalho de todos os territórios dentro de um Ano de Serviço (01/09/AAAA a 31/08/AAAA+1)
 */
function gerarDadosRelatorioAnoServico(usuario, anoInicioParam) {
  const hoje = new Date();
  const anoPadrao = (hoje.getMonth() + 1) >= 9 ? hoje.getFullYear() : hoje.getFullYear() - 1;
  const anoInicio = Number(anoInicioParam) || anoPadrao;
  const anoFim = anoInicio + 1;

  const dataInicioIso = `${anoInicio}-09-01`;
  const dataFimIso = `${anoFim}-08-31`;

  const territorios = listarTodosTerritoriosConsolidados(usuario)
    .sort((a, b) => Number(a.numero) - Number(b.numero));

  const itens = territorios.map(t => {
    const ciclosPeriodo = (t.ciclos || []).filter(c => {
      const desig = c.dataDesignacao || "";
      const concl = c.dataConclusao || "";
      const desigNoPeriodo = desig >= dataInicioIso && desig <= dataFimIso;
      const conclNoPeriodo = concl >= dataInicioIso && concl <= dataFimIso;
      const atravessaPeriodo = desig && desig < dataInicioIso && (!concl || concl >= dataInicioIso);
      return desigNoPeriodo || conclNoPeriodo || atravessaPeriodo;
    });

    return {
      numero: t.numero,
      bairro: t.bairro,
      tipo: t.tipo,
      statusAtual: t.statusReal,
      dirigenteAtual: t.dirigente,
      ultimaData: t.ultimaData,
      ciclos: ciclosPeriodo
    };
  });

  return {
    anoInicio: anoInicio,
    anoFim: anoFim,
    periodoFormatado: `01/09/${anoInicio} a 31/08/${anoFim}`,
    territorios: itens
  };
}

function obterIndicadoresAdmin(usuarioAdmin) {
  const territorios = listarTodosTerritoriosConsolidados(usuarioAdmin);
  const ocupados = territorios.filter(t => t.statusReal === "OCUPADO");
  const disponiveis = territorios.filter(t => t.statusReal === "DISPONÍVEL");
  const recentes = territorios.filter(t => t.statusReal === "RECENTE");

  return {
    totalTerritorios: territorios.length,
    totalOcupados: ocupados.length,
    totalDisponiveis: disponiveis.length,
    totalRecentes: recentes.length,
    ocupadosPorDirigente: ocupados
  };
}

function listarTodosUsuariosAdmin() {
  inicializarAbasSegurancaSeNecessario();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Usuarios");
  const dados = sheet.getDataRange().getValues();
  const usuarios = [];

  for (let i = 1; i < dados.length; i++) {
    if (!dados[i][2]) continue;
    usuarios.push({
      id: String(dados[i][0] || ""),
      nome: String(dados[i][1] || ""),
      email: String(dados[i][2] || "").toLowerCase().trim(),
      perfil: String(dados[i][3] || "PUBLICADOR").toUpperCase().trim(),
      status: String(dados[i][4] || "ATIVO").toUpperCase().trim(),
      criadoEm: dados[i][5] ? String(dados[i][5]) : "",
      ultimoAcesso: dados[i][7] ? String(dados[i][7]) : "",
      ultimaAtividade: String(dados[i][8] || "")
    });
  }
  return usuarios;
}

function salvarOuAlterarUsuarioAdmin(adminExecutor, dadosUsuario) {
  if (!dadosUsuario || !dadosUsuario.email || !dadosUsuario.nome) {
    return respostaJson({ sucesso: false, codigo: 400, erro: "Nome e E-mail são obrigatórios." });
  }

  const emailAlvo = String(dadosUsuario.email).toLowerCase().trim();
  const nomeAlvo = String(dadosUsuario.nome).trim().replace(/\s+/g, " ");

  if (emailAlvo.length > 254 || !/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(emailAlvo)) {
    return respostaJson({ sucesso: false, codigo: 400, erro: "Informe um e-mail válido." });
  }
  if (nomeAlvo.length < 3 || nomeAlvo.length > 80 || /[<>]/.test(nomeAlvo) || /^[=+\-@]/.test(nomeAlvo)) {
    return respostaJson({ sucesso: false, codigo: 400, erro: "O nome deve ter entre 3 e 80 caracteres, sem os símbolos < > e sem iniciar com = + - @." });
  }
  const perfilAlvo = String(dadosUsuario.perfil || "PUBLICADOR").toUpperCase().trim() === "ADMIN" ? "ADMIN" : "PUBLICADOR";
  const statusAlvo = String(dadosUsuario.status || "ATIVO").toUpperCase().trim() === "INATIVO" ? "INATIVO" : "ATIVO";

  // Impede que o último administrador raiz inative a si mesmo acidentalmente
  if (emailAlvo === adminExecutor.email && (statusAlvo !== "ATIVO" || perfilAlvo !== "ADMIN")) {
    return respostaJson({ sucesso: false, codigo: 400, erro: "Você não pode remover seu próprio acesso de Administrador ativo." });
  }

  inicializarAbasSegurancaSeNecessario();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Usuarios");
  const dados = sheet.getDataRange().getValues();

  for (let i = 1; i < dados.length; i++) {
    const emailLinha = String(dados[i][2] || "").toLowerCase().trim();
    if (emailLinha === emailAlvo) {
      sheet.getRange(i + 1, 2).setValue(sanitizarCelula(nomeAlvo, 80));
      sheet.getRange(i + 1, 4).setValue(perfilAlvo);
      sheet.getRange(i + 1, 5).setValue(statusAlvo);
      SpreadsheetApp.flush();

      if (statusAlvo === "ATIVO" && liberarEmailBlacklist(emailAlvo, adminExecutor.email)) {
        registrarAuditoria("BLACKLIST_LIBERADO", adminExecutor.nome, adminExecutor.email, "-", "SUCESSO", `Alvo: ${emailAlvo}`);
      }
      registrarAuditoria("ALTERAR_USUARIO", adminExecutor.nome, adminExecutor.email, "-", "SUCESSO", `Alvo: ${emailAlvo} | Perfil=${perfilAlvo} | Status=${statusAlvo}`);
      return respostaJson({ sucesso: true, mensagem: `Usuário ${nomeAlvo} (${emailAlvo}) atualizado com sucesso.` });
    }
  }

  // Id = maior número existente + 1 (evita repetição quando linhas são apagadas manualmente)
  let maiorId = 0;
  for (let i = 1; i < dados.length; i++) {
    const m = String(dados[i][0] || "").match(/^USR-(\d+)$/);
    if (m) maiorId = Math.max(maiorId, Number(m[1]));
  }
  const novoId = "USR-" + String(maiorId + 1).padStart(3, "0");
  sheet.appendRow(sanitizarLinha([
    novoId,
    nomeAlvo,
    emailAlvo,
    perfilAlvo,
    statusAlvo,
    new Date(),
    adminExecutor.email,
    "",
    ""
  ], 254));
  SpreadsheetApp.flush();

  // Pessoa que tentou entrar antes de ser cadastrada pode ter caído na Blacklist: o cadastro libera
  if (statusAlvo === "ATIVO" && liberarEmailBlacklist(emailAlvo, adminExecutor.email)) {
    registrarAuditoria("BLACKLIST_LIBERADO", adminExecutor.nome, adminExecutor.email, "-", "SUCESSO", `Alvo: ${emailAlvo}`);
  }

  registrarAuditoria("CRIAR_USUARIO", adminExecutor.nome, adminExecutor.email, "-", "SUCESSO", `Novo: ${emailAlvo} (${perfilAlvo})`);
  return respostaJson({ sucesso: true, mensagem: `Usuário ${nomeAlvo} cadastrado na Whitelist com sucesso!` });
}

function listarAuditoriaAdmin(limite) {
  inicializarAbasSegurancaSeNecessario();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Auditoria");
  const dados = sheet.getDataRange().getValues();
  const logs = [];

  for (let i = dados.length - 1; i >= 1 && logs.length < (limite || 100); i--) {
    logs.push({
      idOperacao: String(dados[i][0] || ""),
      dataHora: dados[i][1] ? Utilities.formatDate(new Date(dados[i][1]), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm:ss") : "",
      usuario: String(dados[i][2] || ""),
      email: String(dados[i][3] || ""),
      acao: String(dados[i][4] || ""),
      territorio: String(dados[i][5] || ""),
      resultado: String(dados[i][6] || ""),
      detalhes: String(dados[i][7] || "")
    });
  }
  return logs;
}

function registrarAuditoria(acao, nomeUsuario, emailUsuario, territorio, resultado, detalhes) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName("Auditoria");
    if (!sheet) {
      sheet = ss.insertSheet("Auditoria");
      sheet.appendRow(["IdOperacao", "DataHora", "Usuario", "Email", "Acao", "Territorio", "Resultado", "Detalhes"]);
    }
    sheet.appendRow(sanitizarLinha([
      "AUD-" + Utilities.getUuid().slice(0, 8).toUpperCase(),
      new Date(),
      nomeUsuario || "-",
      emailUsuario || "-",
      acao,
      territorio || "-",
      resultado || "INFO",
      detalhes || ""
    ], 500));
  } catch (e) {
    Logger.log("Falha ao gravar auditoria: " + e.message);
  }
}

/**
 * Disparo de Lembretes Consolidados por E-mail (Acionável pelo Painel Admin ou Trigger)
 */
function enviarLembretesTerritorios() {
  return dispararLembretesPorEmail({ nome: "Gatilho Automático", email: "sistema@interno", perfil: "ADMIN" });
}

function dispararLembretesPorEmail(executor) {
  const territorios = listarTodosTerritoriosConsolidados({ nome: "Admin", email: CONFIG.ADMIN_ROOT_EMAIL, perfil: "ADMIN" });
  const ocupados = territorios.filter(t => t.statusReal === "OCUPADO");

  const lembretesPorEmail = {};
  for (const t of ocupados) {
    const email = t.emailDirigente;
    if (!email) continue;

    if (!lembretesPorEmail[email]) {
      const primeiroNome = String(t.dirigente || "Irmão").split(" ")[0];
      lembretesPorEmail[email] = { nome: primeiroNome, territorios: [] };
    }
    lembretesPorEmail[email].territorios.push(t);
  }

  const arquivosPasta = [];
  try {
    const pasta = DriveApp.getFolderById(CONFIG.ID_PASTA_MAPAS);
    const iter = pasta.getFiles();
    while (iter.hasNext()) {
      const arq = iter.next();
      arquivosPasta.push({ nome: arq.getName(), file: arq });
    }
  } catch (e) {
    Logger.log("Aviso: Pasta do Drive não acessível no momento: " + e.message);
  }

  let enviados = 0;
  const destinatarios = [];

  for (const email in lembretesPorEmail) {
    const dados = lembretesPorEmail[email];
    const anexos = [];
    const linhasTexto = [];

    dados.territorios.sort((a, b) => a.numero - b.numero);

    for (const t of dados.territorios) {
      linhasTexto.push(`📌 Território ${t.numero} — ${t.bairro} (${t.tipo})`);
      const numLimpo = String(t.numero);
      const numPad = numLimpo.padStart(2, "0");
      const regex = new RegExp(`(^|[\\s_\\-])${numLimpo}(\\.pdf)$|(^|[\\s_\\-])${numPad}(\\.pdf)$`, "i");
      const pdf = arquivosPasta.find(a => regex.test(a.nome));
      if (pdf) {
        try { anexos.push(pdf.file.getAs(MimeType.PDF)); } catch (err) {}
      }
    }

    const corpo =
      `Olá, ${dados.nome}!\n\n` +
      `Consta em nosso sistema que você está com o(s) seguinte(s) território(s):\n\n` +
      `${linhasTexto.join("\n")}\n\n` +
      `Caso já tenha finalizado o trabalho, por favor, realize a devolução pelo aplicativo PWA.\n\n` +
      `Bom trabalho!`;

    try {
      MailApp.sendEmail({
        to: email,
        subject: "Lembrete: Cartões de Território em sua posse",
        body: corpo,
        attachments: anexos
      });
      enviados++;
      destinatarios.push({ email: email, qtdTerritorios: dados.territorios.length });
    } catch (e) {
      Logger.log(`Erro ao enviar e-mail para ${email}: ${e.message}`);
    }
  }

  registrarAuditoria("DISPARAR_LEMBRETES", executor.nome, executor.email, "-", "SUCESSO", `Enviados: ${enviados} e-mails`);
  return { enviados: enviados, destinatarios: destinatarios };
}

/**
 * Utilitários de Data e Resposta HTTP JSON
 */
function extrairTimestamp(valor) {
  if (!valor) return 0;
  if (Object.prototype.toString.call(valor) === "[object Date]") {
    return isNaN(valor.getTime()) ? 0 : valor.getTime();
  }
  const str = String(valor).trim();
  if (!str) return 0;

  const matchBR = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (matchBR) {
    return new Date(
      parseInt(matchBR[3], 10),
      parseInt(matchBR[2], 10) - 1,
      parseInt(matchBR[1], 10),
      parseInt(matchBR[4] || "0", 10),
      parseInt(matchBR[5] || "0", 10),
      parseInt(matchBR[6] || "0", 10)
    ).getTime();
  }

  const parsed = new Date(str);
  return isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function erroMetodoNaoPermitido() {
  return respostaJson({ sucesso: false, codigo: 405, erro: "Método HTTP não permitido para esta rota. Utilize POST." });
}

function respostaJson(objeto) {
  return ContentService
    .createTextOutput(JSON.stringify(objeto))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * ============================================================================
 * CAMADA DE ACESSO SEGURO À PLANILHA (CLI / AUTOMAÇÃO / DIAGNÓSTICO)
 * ============================================================================
 * Execute a função 'gerarChaveDiagnosticoSegura()' uma única vez no editor do
 * Google Apps Script para criar a chave em PropertiesService (fora do código-fonte).
 */
function gerarChaveDiagnosticoSegura() {
  const novaChave = "DIAG_" + Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  PropertiesService.getScriptProperties().setProperty("CLI_DIAGNOSTIC_KEY", novaChave);
  Logger.log("Chave gerada e salva em ScriptProperties (copie para o seu arquivo .env local): " + novaChave);
  return novaChave;
}

function processarInspecaoSeguraPlanilha(payload) {
  // Rota DESLIGADA por padrão. Para usar temporariamente, defina a ScriptProperty
  // DIAGNOSTICO_HABILITADO = true no editor do Apps Script e remova ao terminar.
  if (lerPropriedade("DIAGNOSTICO_HABILITADO", "false") !== "true") {
    return respostaJson({ sucesso: false, codigo: 404, erro: "Rota 'dev/inspecionar-planilha' não encontrada na API." });
  }

  // Bloqueio por excesso de tentativas inválidas (força bruta / DoS)
  const cache = CacheService.getScriptCache();
  const janela = Math.floor(Date.now() / 600000);
  const chaveFalhas = "RL_DIAG_FAIL_" + janela;
  const falhas = Number(cache.get(chaveFalhas) || 0);
  if (falhas >= CONFIG.DIAG_FALHAS_MAX_10MIN) {
    return respostaJson({ sucesso: false, codigo: 429, erro: "Muitas tentativas inválidas. Tente novamente em alguns minutos." });
  }

  const chaveConfigurada = lerPropriedade("CLI_DIAGNOSTIC_KEY", "");
  const chaveRecebida = String(payload.diagnosticKey || "").trim();

  if (!chaveConfigurada || !chaveRecebida || !compararSeguro(chaveRecebida, chaveConfigurada)) {
    cache.put(chaveFalhas, String(falhas + 1), 660);
    registrarAuditoriaLimitada("DIAG_NEGADO", 600, "INSPECAO_CLI_NEGADA", "CLI/Agente", "-", "-", "NEGADO", "Chave de diagnóstico ausente ou inválida (registro agregado a cada 10 min)");
    return respostaJson({
      sucesso: false,
      codigo: 403,
      erro: "Chave de diagnóstico inválida."
    });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const operacao = String(payload.operacao || "resumo").trim();

  if (operacao === "resumo") {
    const abas = ss.getSheets().map(s => {
      const ultimaLinha = s.getLastRow();
      const ultimaColuna = s.getLastColumn();
      const cabecalhos = ultimaLinha > 0 && ultimaColuna > 0
        ? s.getRange(1, 1, 1, ultimaColuna).getValues()[0].map(c => String(c))
        : [];
      return {
        nome: s.getName(),
        totalLinhas: ultimaLinha,
        totalColunas: ultimaColuna,
        cabecalhos: cabecalhos
      };
    });

    registrarAuditoria("INSPECAO_CLI_RESUMO", "CLI/Agente", "automacao@local", "-", "SUCESSO", "Leitura de metadados das abas");
    return respostaJson({
      sucesso: true,
      planilhaNome: ss.getName(),
      abas: abas
    });
  }

  if (operacao === "ler-aba") {
    const nomeAba = String(payload.aba || "Respostas").trim();
    if (CONFIG.ABAS_BLOQUEADAS_DIAGNOSTICO.some(a => a.toLowerCase() === nomeAba.toLowerCase())) {
      registrarAuditoria("INSPECAO_CLI_ABA_BLOQUEADA", "CLI/Agente", "automacao@local", "-", "NEGADO", `Aba sensível: ${nomeAba}`);
      return respostaJson({ sucesso: false, codigo: 403, erro: `A aba '${nomeAba}' contém dados sensíveis e não pode ser lida pela rota de diagnóstico.` });
    }
    const limite = Math.min(Math.max(Number(payload.limite) || 50, 1), 500);
    const sheet = ss.getSheetByName(nomeAba);

    if (!sheet) {
      return respostaJson({ sucesso: false, codigo: 404, erro: `Aba '${nomeAba}' não encontrada na planilha.` });
    }

    const dados = sheet.getDataRange().getDisplayValues();
    const cabecalhos = dados.length > 0 ? dados[0] : [];
    const linhas = dados.slice(1);
    const recorte = payload.ultimas ? linhas.slice(-limite) : linhas.slice(0, limite);

    registrarAuditoria("INSPECAO_CLI_ABA", "CLI/Agente", "automacao@local", "-", "SUCESSO", `Aba: ${nomeAba} (${recorte.length} linhas)`);
    return respostaJson({
      sucesso: true,
      aba: nomeAba,
      totalLinhasDados: linhas.length,
      cabecalhos: cabecalhos,
      linhas: recorte
    });
  }

  if (operacao === "inicializar-predios") {
    const sheetPredios = inicializarOuObterAbaPredios(ss);
    const total = Math.max(0, sheetPredios.getLastRow() - 1);
    registrarAuditoria("INICIALIZAR_ABA_PREDIOS", "CLI/Agente", "automacao@local", "-", "SUCESSO", `Total prédios: ${total}`);
    return respostaJson({
      sucesso: true,
      aba: "Predios",
      totalPredios: total
    });
  }

  return respostaJson({ sucesso: false, codigo: 400, erro: `Operação '${operacao}' não reconhecida.` });
}

/**
 * ============================================================================
 * CAMADA 11: GESTÃO DE PRÉDIOS POR TERRITÓRIO (CONFORMIDADE LGPD PRIVACY BY DESIGN)
 * ============================================================================
 * - Armazena exclusivamente metadados logísticos do edifício e data macro de conclusão.
 * - Descarta automaticamente qualquer registro fora dos 94 territórios ativos da Congregação Norte.
 */
function inicializarOuObterAbaPredios(ss) {
  let sheet = ss.getSheetByName("Predios");
  if (!sheet) {
    sheet = ss.insertSheet("Predios");
    sheet.appendRow([
      "IdPredio",
      "NumeroTerritorio",
      "NomeEdificio",
      "Endereco",
      "Andares",
      "Apartamentos",
      "TipoInterfone",
      "TagsLogisticas",
      "ReferenciaComercial",
      "Latitude",
      "Longitude",
      "UltimaDataConclusao"
    ]);
    if (PREDIOS_SEMENTE_NORTE.length > 0) {
      const linhasIniciais = PREDIOS_SEMENTE_NORTE.map(r => [
        r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], ""
      ]);
      sheet.getRange(2, 1, linhasIniciais.length, 12).setValues(linhasIniciais);
    }
    SpreadsheetApp.flush();
  }
  return sheet;
}

function carregarPrediosPorTerritorio(ss, territoriosAtivosSet) {
  const sheet = inicializarOuObterAbaPredios(ss);
  const dados = sheet.getDataRange().getValues();
  const fuso = Session.getScriptTimeZone();
  const porTerritorio = {};

  for (let i = 1; i < dados.length; i++) {
    const idPredio = String(dados[i][0] || "").trim();
    const numTerr = String(dados[i][1] || "").trim().replace(/^0+/, "");
    if (!idPredio || !numTerr) continue;

    // Descarta estritamente qualquer prédio cujo território não pertença aos 94 cartões ativos da Congregação Norte
    if (territoriosAtivosSet && !territoriosAtivosSet.has(numTerr)) continue;

    const tagsRaw = String(dados[i][7] || "").trim();
    const dtConclRaw = dados[i][11];
    let ultimaDataConclusao = "";
    if (dtConclRaw) {
      const ts = extrairTimestamp(dtConclRaw);
      ultimaDataConclusao = ts ? Utilities.formatDate(new Date(ts), fuso, "yyyy-MM-dd") : String(dtConclRaw).trim();
    }

    if (!porTerritorio[numTerr]) porTerritorio[numTerr] = [];
    porTerritorio[numTerr].push({
      idPredio: idPredio,
      numeroTerritorio: Number(numTerr),
      nomeEdificio: String(dados[i][2] || "Edifício s/ nome").trim(),
      endereco: String(dados[i][3] || "").trim(),
      andares: Number(dados[i][4] || 0),
      apartamentos: Number(dados[i][5] || 0),
      tipoInterfone: String(dados[i][6] || "NAO_INFORMADO").trim(),
      tagsLogisticas: tagsRaw ? tagsRaw.split(",").map(s => s.trim()).filter(Boolean) : [],
      referenciaComercial: String(dados[i][8] || "").trim(),
      latitude: Number(dados[i][9] || 0),
      longitude: Number(dados[i][10] || 0),
      ultimaDataConclusao: ultimaDataConclusao,
      trabalhadoNesteCiclo: Boolean(ultimaDataConclusao)
    });
  }

  return porTerritorio;
}

function alternarPredioTrabalhadoTransacional(usuario, payload) {
  const idPredio = String((payload && payload.idPredio) || "").trim();
  const numTerr = String((payload && payload.numeroTerritorio) || "").trim().replace(/^0+/, "");
  const trabalhado = Boolean(payload && payload.trabalhado);

  if (!idPredio || !numTerr) {
    return respostaJson({ sucesso: false, codigo: 400, erro: "Identificador do prédio e território são obrigatórios." });
  }

  const todos = listarTodosTerritoriosConsolidados(usuario);
  const territorio = todos.find(t => String(t.numero) === numTerr);
  if (!territorio) {
    return respostaJson({ sucesso: false, codigo: 404, erro: "Território não encontrado." });
  }

  if (usuario.perfil !== "ADMIN" && (!territorio.emMinhaPosse || territorio.statusReal !== "OCUPADO")) {
    return respostaJson({
      sucesso: false,
      codigo: 403,
      erro: "Apenas o dirigente que está com o território em mãos (ou um Administrador) pode marcar prédios trabalhados."
    });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = inicializarOuObterAbaPredios(ss);
  const dados = sheet.getDataRange().getValues();
  const dataIso = trabalhado ? Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd") : "";

  for (let i = 1; i < dados.length; i++) {
    if (String(dados[i][0] || "").trim() === idPredio) {
      // O prédio precisa pertencer ao território cuja posse foi validada acima
      const numTerrPredio = String(dados[i][1] || "").trim().replace(/^0+/, "");
      if (numTerrPredio !== numTerr) {
        registrarAuditoria("PREDIO_TERRITORIO_DIVERGENTE", usuario.nome, usuario.email, numTerr, "NEGADO", `${idPredio} pertence ao T-${numTerrPredio}`);
        return respostaJson({ sucesso: false, codigo: 403, erro: "Este prédio não pertence ao território informado." });
      }
      sheet.getRange(i + 1, 12).setValue(dataIso);
      SpreadsheetApp.flush();
      registrarAuditoria(
        trabalhado ? "PREDIO_TRABALHADO" : "PREDIO_DESMARCADO",
        usuario.nome,
        usuario.email,
        numTerr,
        "SUCESSO",
        idPredio + " (" + String(dados[i][2] || "") + ")"
      );
      return respostaJson({
        sucesso: true,
        idPredio: idPredio,
        numeroTerritorio: Number(numTerr),
        trabalhado: trabalhado,
        ultimaDataConclusao: dataIso,
        mensagem: trabalhado ? "Prédio marcado como trabalhado neste ciclo!" : "Marcação do prédio removida."
      });
    }
  }

  return respostaJson({ sucesso: false, codigo: 404, erro: "Prédio não encontrado na base da Congregação Norte." });
}

function resetarPrediosDoTerritorio(ss, numeroTerritorio) {
  try {
    const numAlvo = String(numeroTerritorio || "").trim().replace(/^0+/, "");
    const sheet = ss.getSheetByName("Predios");
    if (!sheet) return;
    const dados = sheet.getDataRange().getValues();
    for (let i = 1; i < dados.length; i++) {
      const nLinha = String(dados[i][1] || "").trim().replace(/^0+/, "");
      if (nLinha === numAlvo && dados[i][11]) {
        sheet.getRange(i + 1, 12).setValue("");
      }
    }
  } catch (e) {
    Logger.log("Aviso ao resetar prédios do território: " + e.message);
  }
}

const PREDIOS_SEMENTE_NORTE = [
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
