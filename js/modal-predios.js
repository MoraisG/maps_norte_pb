/**
 * Modal dedicada aos prédios de um cartão: o dirigente marca, sem abrir o mapa, quais
 * apartamentos e quais prédios já foram trabalhados.
 *
 * - Grade de apartamentos: com o número de andares cadastrado, sugere a numeração usual
 *   andar + unidade (101, 102... 201...). Unidades por andar = "AptosPorAndar" do cadastro ou,
 *   sem ele, total ÷ andares arredondado para cima. Um toque marca ou desmarca. Numerações
 *   diferentes são digitadas no campo abaixo da grade.
 * - Corrigir cadastro: quem está com o cartão informa andares e apartamentos por andar; a
 *   sugestão vai para revisão de um ADMIN (como um pull request) e, enquanto isso, a grade já usa
 *   os números sugeridos. Sugestão de ADMIN é aplicada direto.
 * - As marcações usam as mesmas ações do mapa (App.salvarApartamentosPredio e
 *   App.acaoAlternarPredioTrabalhado): mudam a tela na hora e, sem conexão, vão para a fila.
 * - LGPD: só o número da unidade é registrado; nenhum dado de morador.
 */
const ModalPredios = {
  numeroAberto: null,
  filtro: "TODOS",            // TODOS | FALTANDO | TRABALHADOS
  MAX_UNIDADES_POR_ANDAR: 12,
  MAX_ANDARES_GRADE: 40,
  editandoCadastro: null,     // idPredio com o formulário "Corrigir cadastro" aberto
  rascunhoCadastro: {},       // valores digitados, preservados quando a lista é redesenhada

  elementos() {
    return {
      modal: document.getElementById("modal-predios"),
      titulo: document.getElementById("modal-predios-titulo"),
      resumo: document.getElementById("modal-predios-resumo-geral"),
      lista: document.getElementById("modal-predios-conteudo"),
      filtros: document.getElementById("modal-predios-filtros"),
      rodape: document.getElementById("modal-predios-rodape")
    };
  },

  territorio() {
    return App.territorios.find(t => Number(t.numero) === this.numeroAberto) || null;
  },

  podeEditar(t) {
    return Boolean(t && t.statusReal === "OCUPADO" &&
      (t.emMinhaPosse || App.pode("progresso.alheio")));
  },

  abrir(numero, idPredioFoco) {
    const el = this.elementos();
    if (!el.modal) return;
    this.numeroAberto = Number(numero);
    this.filtro = "TODOS";
    if (!this.territorio()) return;
    el.modal.classList.remove("hidden");
    el.modal.classList.add("flex");
    this.renderizar();
    el.lista.scrollTop = 0;
    if (idPredioFoco) {
      const alvo = document.getElementById(`mp-predio-${idPredioFoco}`);
      if (alvo) alvo.scrollIntoView({ block: "start" });
    }
  },

  fechar() {
    const el = this.elementos();
    this.numeroAberto = null;
    if (!el.modal) return;
    el.modal.classList.add("hidden");
    el.modal.classList.remove("flex");
  },

  estaAberta() {
    return this.numeroAberto !== null;
  },

  /** Chamado depois de qualquer mudança nos dados: redesenha só se a modal deste cartão estiver aberta. */
  atualizarSeAberto(numero) {
    if (!this.estaAberta()) return;
    if (numero !== undefined && Number(numero) !== this.numeroAberto) return;
    if (!this.territorio()) {
      this.fechar();
      return;
    }
    this.renderizar();
  },

  definirFiltro(filtro) {
    this.filtro = filtro;
    this.renderizar();
    this.elementos().lista.scrollTop = 0;
  },

  /** Unidades por andar pelo cadastro: "AptosPorAndar" ou total ÷ andares arredondado para cima (0 = sem dado). */
  porAndarDoCadastro(p) {
    const informado = Math.floor(Number(p.aptosPorAndar) || 0);
    if (informado >= 1) return informado;
    const andares = Math.floor(Number(p.andares) || 0);
    const total = Math.floor(Number(p.apartamentos) || 0);
    if (andares < 1 || total < 1) return 0;
    return Math.ceil(total / andares);
  },

  /** Números que a grade usa: a sugestão em revisão (se houver) ou o cadastro. */
  dadosEfetivos(p) {
    const r = p && p.revisaoPendente;
    if (r && Number(r.andares) >= 1 && Number(r.aptosPorAndar) >= 1) {
      return { andares: Number(r.andares), aptosPorAndar: Number(r.aptosPorAndar), emRevisao: true };
    }
    return { andares: p.andares, aptosPorAndar: p.aptosPorAndar, apartamentos: p.apartamentos, emRevisao: false };
  },

  /**
   * Numeração sugerida por andar (101, 102... 201...). Precisa do número de andares; as unidades
   * por andar vêm de porAndarForcado ou do cadastro (ver porAndarDoCadastro).
   * Sem dado suficiente (ou fora dos limites) devolve null e fica só o campo de digitação.
   */
  gradeSugerida(p, porAndarForcado) {
    const andares = Math.floor(Number(p.andares) || 0);
    if (andares < 1 || andares > this.MAX_ANDARES_GRADE) return null;
    const porAndar = Math.floor(Number(porAndarForcado) || 0) || this.porAndarDoCadastro(p);
    if (porAndar < 1 || porAndar > this.MAX_UNIDADES_POR_ANDAR) return null;
    const linhas = [];
    for (let andar = andares; andar >= 1; andar--) {   // andar mais alto em cima, como no prédio
      const unidades = [];
      for (let u = 1; u <= porAndar; u++) unidades.push(String(andar * 100 + u));
      linhas.push({ andar, unidades });
    }
    return linhas;
  },

  concluido(p) {
    return Boolean(p.trabalhadoNesteCiclo || p.ultimaDataConclusao);
  },

  renderizar() {
    const el = this.elementos();
    const t = this.territorio();
    if (!t || !el.modal) return;
    const predios = Array.isArray(t.predios) ? t.predios : [];
    const editar = this.podeEditar(t);
    const concluidos = predios.filter(p => this.concluido(p)).length;

    el.titulo.textContent = `Prédios — Território ${Number(t.numero)}`;
    el.resumo.textContent = predios.length
      ? `${t.bairro ? t.bairro + " • " : ""}${concluidos} de ${predios.length} prédio(s) trabalhado(s)` +
        (editar ? "" : " • somente consulta")
      : "Este cartão não possui prédios cadastrados.";

    const contagens = { TODOS: predios.length, FALTANDO: predios.length - concluidos, TRABALHADOS: concluidos };
    const rotulos = { TODOS: "Todos", FALTANDO: "Faltando", TRABALHADOS: "Trabalhados" };
    el.filtros.innerHTML = Object.keys(rotulos).map(chave => `
      <button type="button" data-acao="predios-filtro" data-filtro="${chave}" aria-pressed="${this.filtro === chave}"
        class="mp-filtro ${this.filtro === chave ? "ativo" : ""}">${rotulos[chave]} (${contagens[chave]})</button>`).join("");

    const visiveis = predios.filter(p =>
      this.filtro === "TODOS" || (this.filtro === "TRABALHADOS" ? this.concluido(p) : !this.concluido(p)));

    // Redesenhar não pode fazer a lista pular de volta ao topo enquanto o dirigente marca
    const rolagem = el.lista.scrollTop;
    const focoId = document.activeElement && el.lista.contains(document.activeElement) ? document.activeElement.dataset.aptoInput : null;
    el.lista.innerHTML = visiveis.length
      ? visiveis.map(p => this.htmlPredio(t, p, predios.indexOf(p) + 1, editar)).join("")
      : `<p class="mp-vazio">${predios.length ? "Nenhum prédio neste filtro." : "Nenhum prédio cadastrado neste cartão."}</p>`;
    el.lista.scrollTop = rolagem;
    if (focoId) {
      const campo = el.lista.querySelector(`input[data-apto-input="${CSS.escape(focoId)}"]`);
      if (campo) campo.focus();
    }

    el.rodape.innerHTML = t.wkt
      ? `<button type="button" data-acao="predios-ver-mapa" data-num="${Number(t.numero)}" class="mp-botao secundario">🗺️ Ver no mapa</button>`
      : "";
  },

  htmlPredio(t, p, ordem, editar) {
    const id = Utils.escapeHtml(p.idPredio);
    const num = Number(t.numero);
    const concluido = this.concluido(p);
    const aptos = Array.isArray(p.aptosTrabalhados) ? p.aptosTrabalhados : [];
    const marcados = new Set(aptos);
    const total = Math.floor(Number(p.apartamentos) || 0);
    const { interfoneBadge, metaStr } = Utils.obterBadgesPredio(p);
    const efetivo = this.dadosEfetivos(p);
    const grade = editar ? this.gradeSugerida(efetivo) : null;
    const cadastroHtml = this.htmlCadastro(p, num, editar, grade);
    const naGrade = new Set(grade ? grade.flatMap(l => l.unidades) : []);
    const foraDaGrade = aptos.filter(a => !naGrade.has(a));

    const gradeHtml = grade ? `
      <div class="mp-grade" role="group" aria-label="Apartamentos de ${Utils.escapeHtml(p.nomeEdificio)}">
        ${grade.map(linha => `
          <div class="mp-andar">
            <span class="mp-andar-rotulo">${linha.andar}º</span>
            ${linha.unidades.map(u => `<button type="button" data-acao="alternar-apto" data-num="${num}" data-id-predio="${id}" data-apto="${u}"
                aria-pressed="${marcados.has(u)}" title="${marcados.has(u) ? `Desmarcar ${u}` : `Marcar ${u} como trabalhado`}"
                class="mp-apto ${marcados.has(u) ? "marcado" : ""}">${u}</button>`).join("")}
          </div>`).join("")}
        <p class="mp-dica">Numeração sugerida (andar + unidade)${efetivo.emRevisao ? ", pelos números em revisão" : ""}. Se no prédio for diferente, corrija o cadastro ou digite abaixo.</p>
      </div>` : "";

    const chips = (grade ? foraDaGrade : aptos).map(a => editar
      ? `<button type="button" data-acao="remover-apto" data-num="${num}" data-id-predio="${id}" data-apto="${Utils.escapeHtml(a)}" title="Remover ${Utils.escapeHtml(a)}" class="mp-chip">${Utils.escapeHtml(a)} <span aria-hidden="true">×</span></button>`
      : `<span class="mp-chip">${Utils.escapeHtml(a)}</span>`).join("");

    const campoHtml = editar ? `
      <div class="mp-campo">
        <input type="text" data-apto-input="${id}" inputmode="text" autocomplete="off" maxlength="120"
          placeholder="${grade ? "Outros números (ex.: 12B, Cobertura)" : "Ex.: 101, 102, 201"}"
          aria-label="Apartamentos trabalhados em ${Utils.escapeHtml(p.nomeEdificio)}" />
        <button type="button" data-acao="adicionar-aptos" data-num="${num}" data-id-predio="${id}" class="mp-botao">Adicionar</button>
      </div>
      <p class="mp-erro" data-apto-erro="${id}" role="alert" hidden></p>` : "";

    const botaoPredio = editar
      ? `<button type="button" data-acao="alternar-predio" data-num="${num}" data-id-predio="${id}" data-trabalhado="${!concluido}" class="mp-botao-predio ${concluido ? "feito" : ""}">
          ${concluido ? `✓ Prédio trabalhado (${Utils.formatarDataBr(p.ultimaDataConclusao)}) — Desfazer` : "Marcar prédio como trabalhado"}
        </button>`
      : (concluido ? `<p class="mp-feito">✓ Trabalhado neste ciclo (${Utils.formatarDataBr(p.ultimaDataConclusao)})</p>` : "");

    return `
      <section id="mp-predio-${id}" class="mp-predio ${concluido ? "feito" : ""}" data-escopo-aptos>
        <header class="mp-predio-topo">
          <span class="mp-ordem">${ordem}</span>
          <div class="mp-predio-info">
            <h4>${Utils.escapeHtml(p.nomeEdificio)}</h4>
            <p>${Utils.escapeHtml(p.endereco)}${metaStr ? ` • ${Utils.escapeHtml(metaStr)}` : ""}</p>
          </div>
          ${t.wkt ? `<button type="button" data-acao="abrir-mapa" data-num="${num}" data-id-predio="${id}" class="mp-link" title="Ver este prédio no mapa">Mapa</button>` : ""}
        </header>
        <div class="mp-selos">
          <span class="px-2 py-0.5 text-[10px] font-semibold rounded-full ${interfoneBadge.cls}">${interfoneBadge.texto}</span>
          <span class="mp-progresso">🚪 ${aptos.length}${total ? ` de ${total}` : ""} apto(s) trabalhado(s)</span>
        </div>
        ${cadastroHtml}
        ${gradeHtml}
        ${chips ? `<div class="mp-chips">${chips}</div>` : ""}
        ${campoHtml}
        ${botaoPredio}
      </section>`;
  },

  /**
   * Bloco "Cadastro": selo da sugestão em revisão e o formulário para corrigir andares e
   * apartamentos por andar (só para quem está com o cartão ou ADMIN).
   */
  htmlCadastro(p, num, editar, grade) {
    const id = Utils.escapeHtml(p.idPredio);
    const r = p.revisaoPendente;
    const selo = r ? `<p class="mp-revisao">⏳ Correção em revisão: ${Number(r.andares)} andar(es) × ${Number(r.aptosPorAndar)} apto(s) por andar${r.criadaEm ? ` • enviada em ${Utils.escapeHtml(r.criadaEm)}` : ""}</p>` : "";
    if (!editar) return selo;

    const ehAdmin = App.pode("predios.revisar");
    if (this.editandoCadastro !== p.idPredio) {
      const convite = grade ? "Corrigir andares/aptos" : "Informar andares e aptos por andar";
      return `${selo}<button type="button" data-acao="predio-cadastro-editar" data-id-predio="${id}" class="mp-link-cadastro">✏️ ${convite}</button>`;
    }

    const efetivo = this.dadosEfetivos(p);
    const rasc = this.rascunhoCadastro[p.idPredio] || {};
    const andares = rasc.andares !== undefined ? rasc.andares : (Math.floor(Number(efetivo.andares) || 0) || "");
    const porAndar = rasc.porAndar !== undefined ? rasc.porAndar : (this.porAndarDoCadastro(efetivo) || "");
    const obs = rasc.obs !== undefined ? rasc.obs : "";
    return `${selo}
      <div class="mp-cadastro" data-cad-form="${id}">
        <p class="mp-cadastro-titulo">${ehAdmin ? "Atualizar cadastro do prédio" : "Sugerir correção do cadastro"}</p>
        <div class="mp-cadastro-campos">
          <label>Andares<input type="number" inputmode="numeric" min="1" max="60" step="1" data-cad-andares="${id}" value="${Utils.escapeHtml(String(andares))}" /></label>
          <label>Aptos por andar<input type="number" inputmode="numeric" min="1" max="${this.MAX_UNIDADES_POR_ANDAR}" step="1" data-cad-por-andar="${id}" value="${Utils.escapeHtml(String(porAndar))}" /></label>
          <span class="mp-cadastro-total" data-cad-total="${id}">${this.textoTotal(andares, porAndar)}</span>
        </div>
        <input type="text" maxlength="200" data-cad-obs="${id}" placeholder="Observação para quem revisa (opcional)" value="${Utils.escapeHtml(String(obs))}" class="mp-cadastro-obs" />
        <p class="mp-erro" data-cad-erro="${id}" role="alert" hidden></p>
        <div class="mp-cadastro-acoes">
          <button type="button" data-acao="predio-cadastro-enviar" data-num="${num}" data-id-predio="${id}" class="mp-botao">${ehAdmin ? "Salvar no cadastro" : "Enviar para revisão"}</button>
          <button type="button" data-acao="predio-cadastro-cancelar" class="mp-botao secundario">Cancelar</button>
        </div>
        ${ehAdmin ? "" : `<p class="mp-dica">Um administrador confere antes de mudar o cadastro. Enquanto isso, a grade já usa estes números.</p>`}
      </div>`;
  },

  textoTotal(andares, porAndar) {
    const a = Math.floor(Number(andares) || 0), b = Math.floor(Number(porAndar) || 0);
    return a >= 1 && b >= 1 ? `= ${a * b} apartamento(s)` : "";
  },

  abrirEdicaoCadastro(idPredio) {
    this.editandoCadastro = idPredio;
    delete this.rascunhoCadastro[idPredio];
    this.renderizar();
    const campo = document.querySelector(`input[data-cad-andares="${CSS.escape(idPredio)}"]`);
    if (campo) campo.focus();
  },

  cancelarEdicaoCadastro() {
    if (this.editandoCadastro) delete this.rascunhoCadastro[this.editandoCadastro];
    this.editandoCadastro = null;
    this.renderizar();
  },

  /** Valida o formulário; devolve { andares, aptosPorAndar, observacao } ou { erro }. */
  validarCadastro(andares, porAndar, obs) {
    const a = Number(andares), b = Number(porAndar);
    if (!Number.isInteger(a) || a < 1 || a > 60) return { erro: "Informe o número de andares (1 a 60)." };
    if (!Number.isInteger(b) || b < 1 || b > this.MAX_UNIDADES_POR_ANDAR) {
      return { erro: `Informe os apartamentos por andar (1 a ${this.MAX_UNIDADES_POR_ANDAR}).` };
    }
    return { andares: a, aptosPorAndar: b, observacao: String(obs || "").trim().slice(0, 200) };
  },

  async enviarCadastro(idPredio, numeroTerritorio) {
    const sel = s => document.querySelector(`[${s}="${CSS.escape(idPredio)}"]`);
    const erroEl = sel("data-cad-erro");
    const mostrarErro = msg => {
      if (erroEl) { erroEl.textContent = msg; erroEl.hidden = false; } else Utils.mostrarToast(msg, "aviso");
    };
    const dados = this.validarCadastro(sel("data-cad-andares")?.value, sel("data-cad-por-andar")?.value, sel("data-cad-obs")?.value);
    if (dados.erro) return mostrarErro(dados.erro);
    if (App.semConexao()) return mostrarErro("Sem conexão: a correção do cadastro precisa de internet para ser enviada.");

    try {
      const res = await ApiClient.request("predios/sugerir-cadastro", Object.assign({ idPredio, numeroTerritorio: Number(numeroTerritorio) }, dados));
      const p = App.acharPredio(numeroTerritorio, idPredio);
      if (p) {
        if (res.aplicada) {
          p.andares = dados.andares;
          p.aptosPorAndar = dados.aptosPorAndar;
          p.apartamentos = dados.andares * dados.aptosPorAndar;
          p.revisaoPendente = null;
        } else {
          p.revisaoPendente = { andares: dados.andares, aptosPorAndar: dados.aptosPorAndar, criadaEm: "agora" };
        }
        App.agendarSalvarRetrato();
      }
      delete this.rascunhoCadastro[idPredio];
      this.editandoCadastro = null;
      this.renderizar();
      if (typeof App.atualizarContagemRevisoes === "function") App.atualizarContagemRevisoes();
      Utils.mostrarToast(res.mensagem || "Sugestão enviada.", "sucesso");
    } catch (erro) {
      mostrarErro(String((erro && erro.message) || "Não foi possível enviar a correção."));
    }
  },

  /** Toque em um apartamento da grade: marca ou desmarca. */
  alternarApto(idPredio, numeroTerritorio, apto) {
    const p = App.acharPredio(numeroTerritorio, idPredio);
    if (!p) return undefined;
    const atuais = Array.isArray(p.aptosTrabalhados) ? p.aptosTrabalhados : [];
    const novaLista = atuais.includes(apto) ? atuais.filter(a => a !== apto) : [...atuais, apto];
    // Sem aviso a cada toque: a própria grade mostra o resultado
    return App.salvarApartamentosPredio(idPredio, numeroTerritorio, novaLista);
  }
};

document.addEventListener("DOMContentLoaded", () => {
  const modal = document.getElementById("modal-predios");
  if (!modal) return;
  modal.addEventListener("click", e => {
    if (e.target === modal) ModalPredios.fechar();
  });
  document.getElementById("modal-predios-fechar")?.addEventListener("click", () => ModalPredios.fechar());
  // Formulário "Corrigir cadastro": guarda o rascunho e atualiza o total
  modal.addEventListener("input", evento => {
    const campo = evento.target;
    if (!(campo instanceof HTMLInputElement)) return;
    const id = campo.dataset.cadAndares || campo.dataset.cadPorAndar || campo.dataset.cadObs;
    if (!id) return;
    const rasc = ModalPredios.rascunhoCadastro[id] || (ModalPredios.rascunhoCadastro[id] = {});
    if (campo.dataset.cadAndares) rasc.andares = campo.value;
    else if (campo.dataset.cadPorAndar) rasc.porAndar = campo.value;
    else rasc.obs = campo.value;
    const form = campo.closest("[data-cad-form]");
    if (form) {
      const total = form.querySelector("[data-cad-total]");
      if (total) total.textContent = ModalPredios.textoTotal(form.querySelector("[data-cad-andares]").value, form.querySelector("[data-cad-por-andar]").value);
      const erro = form.querySelector("[data-cad-erro]");
      if (erro) erro.hidden = true;
    }
  });
  // Digitar no campo limpa o aviso de campo vazio/inválido (vale também para a lista do mapa)
  document.addEventListener("input", evento => {
    const campo = evento.target;
    if (campo instanceof HTMLInputElement && campo.dataset.aptoInput) App.limparErroCampoApto(campo);
  });
  // Enter no campo de apartamentos equivale a "Adicionar"
  modal.addEventListener("keydown", evento => {
    const campo = evento.target;
    if (evento.key !== "Enter" || !(campo instanceof HTMLInputElement) || !campo.dataset.aptoInput) return;
    evento.preventDefault();
    App.acaoAdicionarApartamentos(campo.dataset.aptoInput, ModalPredios.numeroAberto, campo);
  });
});
