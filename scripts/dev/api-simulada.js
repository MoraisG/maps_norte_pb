/**
 * API SIMULADA para desenvolvimento local (carregada apenas por scripts/dev/servidor-local.js).
 *
 * Substitui o ApiClient por uma versão em memória: não há login Google, nenhuma chamada ao
 * Apps Script e nenhum dado real. Os territórios vêm de territorios_nortpb.geojson e os prédios
 * da semente do frontend; dirigentes, datas e status são fictícios. Recarregar a página zera tudo.
 *
 * Este arquivo nunca é referenciado pelo site publicado.
 */
(function () {
  "use strict";

  if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    console.error("API simulada ignorada: só funciona em localhost.");
    return;
  }

  const perfil = new URLSearchParams(location.search).get("perfil") === "PUBLICADOR" ? "PUBLICADOR" : "ADMIN";
  const usuario = { id: 1, nome: "Dirigente Local", email: "local@exemplo.test", perfil: perfil, status: "ATIVO" };
  const OUTROS = ["Ana Teste", "Bruno Teste", "Carla Teste", "Diego Teste"];

  // Mesma regra do gerador de quadras: territórios acima de 60 ha são tratados como rurais
  const RURAIS = new Set([18, 20, 21, 22, 23, 29, 30, 46, 50, 54, 55, 57, 58, 59, 60, 61, 68, 69, 90, 94, 97, 98]);
  const DIAS_RECENTE = 120;

  let territorios = null;      // estado em memória
  let configLocal = {};        // scripts/dev/config.local.json (chave de mapas), se existir
  const historico = [];
  const auditoria = [];

  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const diasAtras = n => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
  const hoje = () => iso(new Date());
  const copiar = v => JSON.parse(JSON.stringify(v));

  function erro(codigo, mensagem) {
    const e = new Error(mensagem);
    e.codigo = codigo;
    e.conflitos = [];
    e.territorios = null;
    return e;
  }

  function geometriaParaWkt(geom) {
    const poligonos = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    const partes = poligonos.map(aneis =>
      "(" + aneis.map(anel => "(" + anel.map(c => `${c[0]} ${c[1]}`).join(", ") + ")").join(", ") + ")");
    return `MultiPolygon (${partes.join(", ")})`;
  }

  function registrar(acao, numero, detalhes) {
    const agora = new Date();
    auditoria.unshift({
      dataHora: agora.toLocaleString("pt-BR"), usuario: usuario.nome, email: usuario.email,
      acao: acao, territorio: String(numero), resultado: "SUCESSO", detalhes: detalhes || ""
    });
  }

  function movimentar(t, acao) {
    historico.unshift({
      dataFormatada: new Date().toLocaleDateString("pt-BR"), numeroTerritorio: t.numero, acao: acao, tipo: t.tipo
    });
  }

  async function carregar() {
    if (territorios) return territorios;
    try {
      configLocal = await (await fetch("/__dev/config-local.json", { cache: "no-store" })).json();
    } catch (e) {
      configLocal = {};
    }
    const resposta = await fetch("territorios_nortpb.geojson", { cache: "no-store" });
    const geo = await resposta.json();
    const numeros = geo.features.map(f => Number(f.properties.NUM_TERR)).sort((a, b) => a - b);
    const porNumero = {};
    geo.features.forEach(f => { porNumero[Number(f.properties.NUM_TERR)] = f; });

    // Os dois primeiros territórios urbanos com prédios ficam "comigo" para testar marcações
    const comPredios = numeros.filter(n => !RURAIS.has(n) && Utils.obterPrediosPadraoTerritorio(n).length > 0);
    const meus = new Set(comPredios.slice(0, 2));

    territorios = numeros.map((n, i) => {
      const predios = copiar(Utils.obterPrediosPadraoTerritorio(n)).map(p => Object.assign(p, {
        numeroTerritorio: n, ultimaDataConclusao: "", trabalhadoNesteCiclo: false, aptosTrabalhados: []
      }));
      const t = {
        numero: n,
        bairro: `Bairro Exemplo ${n}`,
        tipo: RURAIS.has(n) ? "Rural" : "Cidade",
        statusReal: "DISPONÍVEL",
        ultimaAcao: "Devolver",
        ultimaData: diasAtras(130 + ((n * 37) % 400)),
        dirigente: "",
        emailDirigente: "",
        emMinhaPosse: false,
        nomePdf: `Mapa_Exemplo_${n}.pdf`,
        wkt: geometriaParaWkt(porNumero[n].geometry),
        ciclos: [],
        predios: predios,
        totalPredios: predios.length,
        quadrasTrabalhadas: []
      };
      t.codigoComposto = `${n} - ${t.bairro}`;

      if (meus.has(n)) {
        Object.assign(t, { statusReal: "OCUPADO", ultimaAcao: "Solicitar", ultimaData: diasAtras(12), dirigente: usuario.nome, emailDirigente: usuario.email, emMinhaPosse: true });
      } else if (i % 9 === 4) {
        Object.assign(t, { statusReal: "OCUPADO", ultimaAcao: "Solicitar", ultimaData: diasAtras(20 + (n % 60)), dirigente: OUTROS[n % OUTROS.length] });
      } else if (i % 6 === 2) {
        Object.assign(t, { statusReal: "RECENTE", ultimaData: diasAtras(5 + (n % 100)), dirigente: OUTROS[n % OUTROS.length] });
      } else if (i % 17 === 7) {
        Object.assign(t, { ultimaAcao: "Nunca Usado", ultimaData: "" });
      }

      if (t.statusReal === "OCUPADO") {
        t.ciclos.push({ dirigente: t.dirigente, dataDesignacao: t.ultimaData, dataConclusao: "" });
      } else if (t.ultimaData) {
        t.ciclos.push({ dirigente: OUTROS[n % OUTROS.length], dataDesignacao: diasAtras(60 + 130 + ((n * 37) % 400)), dataConclusao: t.ultimaData });
      }
      return t;
    });
    return territorios;
  }

  function listar() {
    return copiar(territorios).map(t => {
      if (perfil !== "ADMIN") {
        t.emailDirigente = "";
        if (t.statusReal !== "OCUPADO") t.dirigente = "";
      }
      return t;
    });
  }

  function acharTerritorio(numero) {
    const t = territorios.find(x => x.numero === Number(numero));
    if (!t) throw erro(404, "Território não encontrado.");
    return t;
  }

  function exigirPosse(t) {
    if (t.statusReal !== "OCUPADO" || (perfil !== "ADMIN" && !t.emMinhaPosse)) {
      throw erro(403, "Apenas o dirigente que está com o território em mãos (ou um Administrador) pode registrar o que já foi trabalhado.");
    }
  }

  function acharPredio(t, idPredio) {
    const p = t.predios.find(x => x.idPredio === idPredio);
    if (!p) throw erro(404, "Prédio não encontrado.");
    return p;
  }

  const ROTAS = {
    "auth/logout": () => ({ mensagem: "Sessão simulada encerrada." }),
    "auth/refresh": () => ({ sessionToken: "token-local", expiraEm: Date.now() + 3600000 }),

    "territorios/listar": () => ({ usuario: usuario, config: { chaveEsri: String(configLocal.chaveEsri || "") }, territorios: listar() }),

    "territorios/solicitar": p => {
      const numeros = (Array.isArray(p.numerosTerritorios) ? p.numerosTerritorios : [p.numeroTerritorio]).map(Number).filter(Boolean);
      if (!numeros.length) throw erro(400, "Nenhum território informado.");
      const alvos = numeros.map(acharTerritorio);
      const indisponivel = alvos.find(t => t.statusReal !== "DISPONÍVEL");
      if (indisponivel) throw erro(409, `O território ${indisponivel.numero} não está disponível.`);
      alvos.forEach(t => {
        Object.assign(t, { statusReal: "OCUPADO", ultimaAcao: "Solicitar", ultimaData: hoje(), dirigente: usuario.nome, emailDirigente: usuario.email, emMinhaPosse: true });
        t.ciclos.push({ dirigente: usuario.nome, dataDesignacao: hoje(), dataConclusao: "" });
        movimentar(t, "Solicitar");
        registrar("SOLICITAR_TERRITORIO", t.numero);
      });
      return { mensagem: `Território(s) ${numeros.join(", ")} reservado(s) (simulação).` };
    },

    "territorios/devolver": p => {
      const t = acharTerritorio(p.numeroTerritorio);
      if (t.statusReal !== "OCUPADO") throw erro(409, `O território ${t.numero} não consta como ocupado no momento.`);
      if (perfil !== "ADMIN" && !t.emMinhaPosse) throw erro(403, "Operação negada: o território está com outro dirigente.");

      const naoIniciado = p.foiCompleto === false && p.motivoNaoCompleto === "NAO_INICIADO";
      t.quadrasTrabalhadas = []; // alfinetes são sempre apagados na devolução

      const concluidos = t.predios.filter(x => x.ultimaDataConclusao).length;
      const cicloCompleto = t.predios.length > 0 && concluidos === t.predios.length;
      if (cicloCompleto) {
        t.predios.forEach(x => { x.ultimaDataConclusao = ""; x.trabalhadoNesteCiclo = false; x.aptosTrabalhados = []; });
      }

      const cicloAberto = t.ciclos[t.ciclos.length - 1];
      Object.assign(t, { emMinhaPosse: false, emailDirigente: "" });
      if (naoIniciado) {
        t.ciclos.pop();
        const anterior = t.ciclos[t.ciclos.length - 1];
        Object.assign(t, { statusReal: "DISPONÍVEL", ultimaAcao: anterior ? "Devolver" : "Nunca Usado", ultimaData: anterior ? anterior.dataConclusao : "", dirigente: "" });
        movimentar(t, "Cancelado_NaoIniciado");
        registrar("DEVOLVER_NAO_INICIADO", t.numero);
        return { statusRetorno: "DISPONÍVEL", mensagem: `O território ${t.numero} retornou para a fila de disponíveis (Não Iniciado).` };
      }

      if (cicloAberto) cicloAberto.dataConclusao = hoje();
      Object.assign(t, { statusReal: "RECENTE", ultimaAcao: "Devolver", ultimaData: hoje() });
      movimentar(t, "Devolver");
      registrar("DEVOLVER_TERRITORIO", t.numero, `Prédios: ${concluidos}/${t.predios.length}`);
      const nota = !t.predios.length ? ""
        : cicloCompleto ? " Todos os prédios foram trabalhados: o histórico de prédios foi zerado para o próximo ciclo."
        : ` O histórico de prédios/apartamentos foi mantido (${concluidos}/${t.predios.length} prédios concluídos) para quem pegar o cartão em seguida.`;
      return {
        statusRetorno: "RECENTE", cicloPrediosCompleto: cicloCompleto,
        mensagem: `Devolução do território ${t.numero} registrada como concluída! O cartão entrou no ciclo de descanso de ${DIAS_RECENTE} dias.${nota}`
      };
    },

    "predios/marcar-trabalhado": p => {
      const t = acharTerritorio(p.numeroTerritorio);
      exigirPosse(t);
      const predio = acharPredio(t, p.idPredio);
      predio.ultimaDataConclusao = p.trabalhado ? hoje() : "";
      predio.trabalhadoNesteCiclo = Boolean(p.trabalhado);
      registrar(p.trabalhado ? "PREDIO_TRABALHADO" : "PREDIO_DESMARCADO", t.numero, predio.idPredio);
      return {
        idPredio: predio.idPredio, numeroTerritorio: t.numero, trabalhado: Boolean(p.trabalhado),
        ultimaDataConclusao: predio.ultimaDataConclusao,
        mensagem: p.trabalhado ? "Prédio marcado como trabalhado neste ciclo!" : "Marcação do prédio removida."
      };
    },

    "predios/marcar-apartamentos": p => {
      const t = acharTerritorio(p.numeroTerritorio);
      exigirPosse(t);
      const predio = acharPredio(t, p.idPredio);
      const lista = Array.isArray(p.apartamentos) ? p.apartamentos.map(a => String(a).toUpperCase().trim()) : null;
      if (!lista || lista.some(a => !/^[A-Z0-9][A-Z0-9 \-]{0,9}$/.test(a)) || new Set(lista).size !== lista.length) {
        throw erro(400, "Informe apenas o número/identificação de cada apartamento (até 10 letras ou números), sem repetir.");
      }
      predio.aptosTrabalhados = lista.sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
      registrar("APTOS_TRABALHADOS", t.numero, `${predio.idPredio}: ${lista.length} apto(s)`);
      return {
        idPredio: predio.idPredio, numeroTerritorio: t.numero, aptosTrabalhados: predio.aptosTrabalhados.slice(),
        mensagem: `${lista.length} apartamento(s) registrado(s) como trabalhado(s) neste prédio.`
      };
    },

    "quadras/salvar": p => {
      const t = acharTerritorio(p.numeroTerritorio);
      exigirPosse(t);
      const pinos = Array.isArray(p.pinos) ? p.pinos : null;
      if (!pinos || pinos.length > 80 || pinos.some(x => !isFinite(Number(x.lat)) || !isFinite(Number(x.lng)))) {
        throw erro(400, "Alfinetes inválidos: marque no máximo 80 pontos, todos dentro da área do território.");
      }
      t.quadrasTrabalhadas = pinos.map(x => ({ lat: Number(x.lat), lng: Number(x.lng) }));
      registrar("QUADRAS_TRABALHADAS", t.numero, `${pinos.length} alfinete(s)`);
      return {
        numeroTerritorio: t.numero, quadrasTrabalhadas: copiar(t.quadrasTrabalhadas),
        mensagem: pinos.length ? `${pinos.length} quadra(s) marcada(s) como trabalhada(s) no Território ${t.numero}.` : `Marcações de quadras do Território ${t.numero} removidas.`
      };
    },

    "movimentacoes/minhas": () => ({ historico: copiar(historico) }),

    "relatorios/ano-servico": () => ({
      relatorio: { territorios: copiar(territorios).sort((a, b) => a.numero - b.numero).map(t => ({ numero: t.numero, bairro: t.bairro, tipo: t.tipo, ciclos: t.ciclos })) }
    }),

    "admin/usuarios/listar": () => ({
      usuarios: [Object.assign({ ultimaAtividade: "Agora (simulação)" }, usuario)]
        .concat(OUTROS.map((nome, i) => ({ id: i + 2, nome: nome, email: `usuario${i + 1}@exemplo.test`, perfil: "PUBLICADOR", status: "ATIVO", ultimaAtividade: "" })))
    }),
    "admin/auditoria": () => ({ logs: copiar(auditoria) }),
    "admin/usuarios/salvar": () => ({ mensagem: "Simulação: o usuário não foi gravado (modo local)." }),
    "admin/lembretes/disparar": () => ({ mensagem: "Simulação: nenhum e-mail foi enviado (modo local)." })
  };

  // ---- Troca do cliente real pelo simulado ----
  ApiClient.getApiUrl = () => "simulada://local";
  ApiClient.obterTokenSessao = () => "token-local";
  ApiClient.obterUsuarioSessao = () => usuario;
  ApiClient.salvarSessao = () => {};
  ApiClient.limparSessaoLocal = () => {};
  ApiClient.precisaRenovarSessao = () => false;
  ApiClient.renovarSessaoSeNecessario = async () => {};
  ApiClient._enviar = async () => { throw new Error("Modo local: chamadas ao servidor real estão desligadas."); };

  ApiClient.request = async function (rota, payload) {
    await carregar();
    await new Promise(r => setTimeout(r, 150)); // pequena latência para os estados de "carregando" aparecerem
    const tratador = ROTAS[rota];
    if (!tratador) throw erro(404, `Rota '${rota}' não existe na API simulada.`);
    if (rota.startsWith("admin/") && perfil !== "ADMIN") throw erro(403, "403 Forbidden — Operação exclusiva para perfil ADMIN.");
    const resposta = tratador(payload || {});
    console.debug("[API simulada]", rota, payload || {}, resposta);
    return Object.assign({ sucesso: true }, resposta);
  };

  // ---- Faixa de aviso: deixa claro que os dados não são reais ----
  document.addEventListener("DOMContentLoaded", () => {
    const faixa = document.createElement("div");
    faixa.textContent = `MODO LOCAL — dados simulados, sem login e sem planilha real (perfil ${perfil})`;
    faixa.setAttribute("role", "status");
    faixa.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:4px 10px;background:#b06000;color:#fff;font:600 11px/1.4 system-ui,sans-serif;text-align:center;pointer-events:none";
    document.body.appendChild(faixa);
  });
})();
