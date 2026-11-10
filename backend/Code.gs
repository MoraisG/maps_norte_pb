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
  SESSION_TTL_SECONDS: 3600, // 1 hora de sessão ativa no CacheService
  DIAS_RECENTE: 120,         // Janela de quarentena após devolução
  GOOGLE_CLIENT_ID: "917012478113-2nq9p3io8j8cao95gscamjh0jqrp6u4p.apps.googleusercontent.com"
};

/**
 * Roteador HTTP GET (Consultas Autenticadas)
 */
function doGet(e) {
  return rotearRequisicao("GET", e.parameter || {}, null);
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
        return respostaJson({ sucesso: true, usuario: usuario });

      // --- DOMÍNIO: TERRITÓRIOS (PUBLICADOR + ADMIN) ---
      case "territorios/listar":
        return respostaJson({
          sucesso: true,
          usuario: usuario,
          territorios: listarTodosTerritoriosConsolidados(usuario)
        });

      case "territorios/solicitar":
        if (metodo !== "POST") return erroMetodoNaoPermitido();
        return executarComLock(() => solicitarTerritorioTransacional(usuario, payload.numeroTerritorio));

      case "territorios/devolver":
        if (metodo !== "POST") return erroMetodoNaoPermitido();
        return executarComLock(() => devolverTerritorioTransacional(usuario, payload.numeroTerritorio, payload.observacao));

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

  // Valida criptograficamente o JWT direto no servidor OAuth2 do Google
  const urlVerificacao = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken);
  let resp;
  try {
    resp = UrlFetchApp.fetch(urlVerificacao, { muteHttpExceptions: true });
  } catch (e) {
    return respostaJson({ sucesso: false, codigo: 503, erro: "Falha ao contatar serviço de identidade do Google." });
  }

  if (resp.getResponseCode() !== 200) {
    registrarAuditoria("LOGIN_TOKEN_INVALIDO", "Desconhecido", "-", "-", "ERRO", "ID Token rejeitado pelo Google");
    return respostaJson({ sucesso: false, codigo: 401, erro: "Credencial do Google inválida ou expirada." });
  }

  const tokenInfo = JSON.parse(resp.getContentText());
  if (tokenInfo.email_verified !== "true" && tokenInfo.email_verified !== true) {
    return respostaJson({ sucesso: false, codigo: 401, erro: "O endereço de e-mail da conta Google não está verificado." });
  }

  if (CONFIG.GOOGLE_CLIENT_ID && tokenInfo.aud !== CONFIG.GOOGLE_CLIENT_ID) {
    registrarAuditoria("LOGIN_AUD_MISMATCH", tokenInfo.name || "", tokenInfo.email || "", "-", "NEGADO", "Client ID divergente");
    return respostaJson({ sucesso: false, codigo: 401, erro: "Token emitido para outra aplicação cliente." });
  }

  const emailAutenticado = String(tokenInfo.email || "").toLowerCase().trim();
  const nomeGoogle = String(tokenInfo.name || emailAutenticado.split("@")[0]).trim();

  // Garante que as abas de segurança ('Usuarios' e 'Auditoria') existam
  inicializarAbasSegurancaSeNecessario();

  // Consulta a Whitelist (Aba 'Usuarios')
  const usuario = buscarUsuarioAutorizado(emailAutenticado, true);
  if (!usuario) {
    registrarAuditoria("LOGIN", nomeGoogle, emailAutenticado, "-", "NEGADO", "E-mail não consta na Whitelist (Usuarios)");
    return respostaJson({
      sucesso: false,
      codigo: 403,
      erro: "Acesso restrito. Seu usuário não possui autorização para utilizar este sistema."
    });
  }

  if (usuario.status !== "ATIVO") {
    registrarAuditoria("LOGIN", usuario.nome, emailAutenticado, "-", "NEGADO", "Usuário com Status INATIVO");
    return respostaJson({
      sucesso: false,
      codigo: 403,
      erro: "Acesso restrito. Seu cadastro encontra-se inativo."
    });
  }

  // Gera Token de Sessão opaco e armazena no CacheService com TTL de 1 hora
  const sessionToken = Utilities.getUuid() + "-" + Utilities.getUuid();
  const expiraEm = Date.now() + (CONFIG.SESSION_TTL_SECONDS * 1000);
  const dadosSessao = {
    email: usuario.email,
    nome: usuario.nome,
    perfil: usuario.perfil,
    expiraEm: expiraEm
  };

  CacheService.getScriptCache().put("SESS_" + sessionToken, JSON.stringify(dadosSessao), CONFIG.SESSION_TTL_SECONDS);
  registrarAuditoria("LOGIN", usuario.nome, usuario.email, "-", "SUCESSO", `Perfil: ${usuario.perfil}`);

  return respostaJson({
    sucesso: true,
    sessionToken: sessionToken,
    expiraEm: expiraEm,
    usuario: usuario
  });
}

function validarSessao(sessionToken) {
  if (!sessionToken) return null;
  const cache = CacheService.getScriptCache();
  const raw = cache.get("SESS_" + sessionToken);
  if (!raw) return null;

  try {
    const sessao = JSON.parse(raw);
    // Renova o TTL deslizante a cada atividade válida
    cache.put("SESS_" + sessionToken, raw, CONFIG.SESSION_TTL_SECONDS);
    return sessao;
  } catch (e) {
    return null;
  }
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
      sheet.getRange(u.linhaPlanilha, 9).setValue(`${descricaoAtividade} (${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm")})`);
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
            dataDesignacao: "",
            dataConclusao: dataIso
          });
        }
      }
    }
    if (cicloAberto) {
      ciclos.push(cicloAberto);
    }

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
      ciclos: ciclos
    });
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

function solicitarTerritorioTransacional(usuario, numeroRaw) {
  const num = String(numeroRaw || "").trim().replace(/^0+/, "");
  if (!num || isNaN(Number(num))) {
    return respostaJson({ sucesso: false, codigo: 400, erro: "Número de território inválido." });
  }

  const todos = listarTodosTerritoriosConsolidados(usuario);
  const territorio = todos.find(t => String(t.numero) === num);

  if (!territorio) {
    registrarAuditoria("SOLICITAR_TERRITORIO", usuario.nome, usuario.email, num, "ERRO", "Território inexistente");
    return respostaJson({ sucesso: false, codigo: 404, erro: `O território ${num} não existe na base.` });
  }

  if (territorio.statusReal === "OCUPADO") {
    registrarAuditoria("SOLICITAR_TERRITORIO", usuario.nome, usuario.email, num, "NEGADO_CONCORRENCIA", `Já ocupado por ${territorio.dirigente}`);
    return respostaJson({
      sucesso: false,
      codigo: 409,
      erro: `Indisponível: o território ${num} (${territorio.bairro}) já está em posse de ${territorio.dirigente}.`
    });
  }

  if (territorio.statusReal !== "DISPONÍVEL") {
    registrarAuditoria("SOLICITAR_TERRITORIO", usuario.nome, usuario.email, num, "NEGADO_QUARENTENA", `Última devolução em ${territorio.ultimaData} (<= ${CONFIG.DIAS_RECENTE} dias)`);
    return respostaJson({
      sucesso: false,
      codigo: 409,
      erro: `Indisponível: o território ${num} (${territorio.bairro}) foi devolvido recentemente (${territorio.ultimaData}) e só pode ser solicitado após mais de ${CONFIG.DIAS_RECENTE} dias.`
    });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetResp = ss.getSheetByName("Respostas");
  const agora = new Date();
  const dataSomente = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());

  sheetResp.appendRow([
    agora,
    usuario.nome,
    Number(num),
    "Solicitar",
    dataSomente,
    usuario.email,
    territorio.tipo || "Cidade",
    "",
    ""
  ]);

  SpreadsheetApp.flush();
  atualizarUltimaAtividadeUsuario(usuario.email, `Solicitou T-${num}`);
  registrarAuditoria("SOLICITAR_TERRITORIO", usuario.nome, usuario.email, num, "SUCESSO", `Bairro: ${territorio.bairro}`);

  return respostaJson({
    sucesso: true,
    mensagem: `Território ${num} (${territorio.bairro}) reservado com sucesso para ${usuario.nome}!`
  });
}

function devolverTerritorioTransacional(usuario, numeroRaw, observacao) {
  const num = String(numeroRaw || "").trim().replace(/^0+/, "");
  if (!num || isNaN(Number(num))) {
    return respostaJson({ sucesso: false, codigo: 400, erro: "Número de território inválido." });
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

  // Teste 5 Obrigatório do Plano v2: Publicador comum só pode devolver território que está sob sua posse
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

  sheetResp.appendRow([
    agora,
    usuario.nome,
    Number(num),
    "Devolver",
    dataSomente,
    usuario.email,
    territorio.tipo || "Cidade",
    "",
    String(observacao || "").trim()
  ]);

  SpreadsheetApp.flush();
  atualizarUltimaAtividadeUsuario(usuario.email, `Devolveu T-${num}`);
  registrarAuditoria("DEVOLVER_TERRITORIO", usuario.nome, usuario.email, num, "SUCESSO", `Devolvido por ${usuario.email}`);

  return respostaJson({
    sucesso: true,
    mensagem: `Devolução do território ${num} (${territorio.bairro}) registrada com sucesso!`
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
  const nomeAlvo = String(dadosUsuario.nome).trim();
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
      sheet.getRange(i + 1, 2).setValue(nomeAlvo);
      sheet.getRange(i + 1, 4).setValue(perfilAlvo);
      sheet.getRange(i + 1, 5).setValue(statusAlvo);
      SpreadsheetApp.flush();

      registrarAuditoria("ALTERAR_USUARIO", adminExecutor.nome, adminExecutor.email, "-", "SUCESSO", `Alvo: ${emailAlvo} | Perfil=${perfilAlvo} | Status=${statusAlvo}`);
      return respostaJson({ sucesso: true, mensagem: `Usuário ${nomeAlvo} (${emailAlvo}) atualizado com sucesso.` });
    }
  }

  const novoId = "USR-" + String(dados.length).padStart(3, "0");
  sheet.appendRow([
    novoId,
    nomeAlvo,
    emailAlvo,
    perfilAlvo,
    statusAlvo,
    new Date(),
    adminExecutor.email,
    "",
    ""
  ]);
  SpreadsheetApp.flush();

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
    sheet.appendRow([
      "AUD-" + Utilities.getUuid().slice(0, 8).toUpperCase(),
      new Date(),
      nomeUsuario || "-",
      emailUsuario || "-",
      acao,
      territorio || "-",
      resultado || "INFO",
      detalhes || ""
    ]);
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
  const chaveConfigurada = PropertiesService.getScriptProperties().getProperty("CLI_DIAGNOSTIC_KEY");
  const chaveRecebida = String(payload.diagnosticKey || "").trim();

  if (!chaveConfigurada || !chaveRecebida || chaveRecebida !== chaveConfigurada) {
    registrarAuditoria("INSPECAO_CLI_NEGADA", "CLI/Agente", "-", "-", "NEGADO", "Chave de diagnóstico ausente ou inválida");
    return respostaJson({
      sucesso: false,
      codigo: 403,
      erro: "Chave de diagnóstico inválida ou não configurada no PropertiesService (CLI_DIAGNOSTIC_KEY)."
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

  return respostaJson({ sucesso: false, codigo: 400, erro: `Operação '${operacao}' não reconhecida.` });
}
