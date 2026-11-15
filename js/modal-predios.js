/**
 * Modal dedicada aos prédios de um cartão: o dirigente marca, sem abrir o mapa, quais
 * apartamentos e quais prédios já foram trabalhados.
 *
 * - Grade de apartamentos: quando o cadastro permite (andares e total de unidades divisível pelos
 *   andares), sugere a numeração usual andar + unidade (101, 102... 201...). Um toque marca ou
 *   desmarca. Numerações diferentes são digitadas no campo abaixo da grade.
 * - As marcações usam as mesmas ações do mapa (App.salvarApartamentosPredio e
 *   App.acaoAlternarPredioTrabalhado): mudam a tela na hora e, sem conexão, vão para a fila.
 * - LGPD: só o número da unidade é registrado; nenhum dado de morador.
 */
const ModalPredios = {
  numeroAberto: null,
  filtro: "TODOS",            // TODOS | FALTANDO | TRABALHADOS
  MAX_UNIDADES_POR_ANDAR: 12,
  MAX_ANDARES_GRADE: 40,

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
      (t.emMinhaPosse || (App.usuarioAtual && App.usuarioAtual.perfil === "ADMIN")));
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

  /**
   * Numeração sugerida por andar (101, 102... 201...). Só quando o total de unidades se divide
   * igualmente pelos andares; caso contrário devolve null e fica só o campo de digitação.
   */
  gradeSugerida(p) {
    const andares = Math.floor(Number(p.andares) || 0);
    const total = Math.floor(Number(p.apartamentos) || 0);
    if (andares < 1 || total < 1 || total % andares !== 0 || andares > this.MAX_ANDARES_GRADE) return null;
    const porAndar = total / andares;
    if (porAndar > this.MAX_UNIDADES_POR_ANDAR) return null;
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
    const grade = editar ? this.gradeSugerida(p) : null;
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
        <p class="mp-dica">Numeração sugerida (andar + unidade). Se no prédio for diferente, digite abaixo.</p>
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
      </div>` : "";

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
        ${gradeHtml}
        ${chips ? `<div class="mp-chips">${chips}</div>` : ""}
        ${campoHtml}
        ${botaoPredio}
      </section>`;
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
  // Enter no campo de apartamentos equivale a "Adicionar"
  modal.addEventListener("keydown", evento => {
    const campo = evento.target;
    if (evento.key !== "Enter" || !(campo instanceof HTMLInputElement) || !campo.dataset.aptoInput) return;
    evento.preventDefault();
    App.acaoAdicionarApartamentos(campo.dataset.aptoInput, ModalPredios.numeroAberto, campo);
  });
});
