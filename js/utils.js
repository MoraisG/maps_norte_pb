/**
 * Utilitários de Segurança (Prevenção contra XSS), Formatação, Modais Material 3 (ModalM3)
 * e Conversor WKT -> GeoJSON
 */
const Utils = {
  DIAS_QUARENTENA_DEVOLUCAO: 120,

  // Escapa strings antes de inserir no DOM para impedir ataques XSS
  escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  },

  formatarDataBr(isoDate) {
    if (!isoDate) return "Nunca trabalhado";
    const partes = String(isoDate).split("T")[0].split("-");
    if (partes.length === 3) {
      return `${partes[2]}/${partes[1]}/${partes[0]}`;
    }
    return this.escapeHtml(isoDate);
  },

  /**
   * Converte uma data (YYYY-MM-DD, DD/MM/YYYY ou ISO) em timestamp numérico (ms).
   * Retorna 0 quando vazio ("Nunca trabalhado"), garantindo prioridade máxima na ordenação por antiguidade.
   */
  obterTimestampData(isoDate) {
    if (!isoDate) return 0;
    const str = String(isoDate).split("T")[0].trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      const [ano, mes, dia] = str.split("-").map(Number);
      return new Date(ano, mes - 1, dia).getTime();
    }
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
      const [dia, mes, ano] = str.split("/").map(Number);
      return new Date(ano, mes - 1, dia).getTime();
    }
    const ts = Date.parse(isoDate);
    return isNaN(ts) ? 0 : ts;
  },

  /**
   * Calcula a quantidade de dias corridos desde uma data até hoje.
   * Retorna Infinity caso nunca tenha sido trabalhado/devolvido.
   */
  calcularDiasDesdeData(isoDate) {
    const ts = this.obterTimestampData(isoDate);
    if (!ts) return Infinity;
    const hoje = new Date();
    const hojeMeiaNoite = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()).getTime();
    const dataAlvo = new Date(ts);
    const alvoMeiaNoite = new Date(dataAlvo.getFullYear(), dataAlvo.getMonth(), dataAlvo.getDate()).getTime();
    return Math.floor((hojeMeiaNoite - alvoMeiaNoite) / (1000 * 60 * 60 * 24));
  },

  /**
   * Rótulo e classes visuais de status do território no padrão Google Material Design 3 (Tonal Pills)
   */
  obterEstiloStatus(t) {
    let badgeClass = "bg-[#e6f4ea] text-[#137333] border-[#ceead6]";
    if (t.statusReal === "OCUPADO") badgeClass = "bg-[#fef7e0] text-[#b06000] border-[#feefc3]";
    if (t.statusReal === "RECENTE") badgeClass = "bg-[#e8f0fe] text-[#1967d2] border-[#d2e3fc]";
    if (t.emMinhaPosse) badgeClass = "bg-[#0b57d0] text-white border-[#0b57d0]";

    const label = t.emMinhaPosse ? "COM VOCÊ" : t.statusReal;
    return { badgeClass, label };
  },

  /**
   * Traduz as tags logísticas fechadas (LGPD-safe) de um prédio em badges visuais amigáveis
   */
  obterBadgesPredio(p) {
    const badges = [];
    const interfone = String(p.tipoInterfone || "NAO_INFORMADO").toUpperCase();

    if (interfone === "EXTERNO") {
      badges.push({ texto: "🔔 Interfone Externo", classe: "bg-[#e6f4ea] text-[#137333] border-[#ceead6]" });
    } else if (interfone === "INTERNO") {
      badges.push({ texto: "🔔 Interfone Interno", classe: "bg-[#fef7e0] text-[#b06000] border-[#feefc3]" });
    } else if (interfone === "SEM_INTERFONE") {
      badges.push({ texto: "🚫 Sem Interfone", classe: "bg-[#fce8e6] text-[#c5221f] border-[#fad2cf]" });
    } else {
      badges.push({ texto: "❓ Interfone N/I", classe: "bg-slate-100 text-slate-600 border-slate-200" });
    }

    const tags = Array.isArray(p.tagsLogisticas)
      ? p.tagsLogisticas
      : String(p.tagsLogisticas || "").split(",").map(s => s.trim()).filter(Boolean);

    const mapaTags = {
      EXIGE_CODIGO: { texto: "🔐 Exige Código/PIN", classe: "bg-[#fef7e0] text-[#b06000] border-[#feefc3]" },
      PEDE_NUM_APTO: { texto: "🔢 Discar Nº Apto", classe: "bg-[#e8f0fe] text-[#1967d2] border-[#d2e3fc]" },
      INTERFONE_DIGITAL: { texto: "📟 Digital", classe: "bg-[#e8f0fe] text-[#1967d2] border-[#d2e3fc]" },
      COM_CAMERA: { texto: "📹 Com Câmera", classe: "bg-sky-50 text-sky-700 border-sky-200" },
      PORTARIA: { texto: "🛎️ Portaria", classe: "bg-indigo-50 text-indigo-700 border-indigo-200" },
      COM_ACESSO: { texto: "🔓 Com Acesso", classe: "bg-[#e6f4ea] text-[#137333] border-[#ceead6]" },
      SEM_ACESSO: { texto: "🔒 S/ Acesso Físico", classe: "bg-slate-100 text-slate-600 border-slate-200" },
      ACESSO_RESTRITO: { texto: "⚠️ Acesso Restrito", classe: "bg-[#fef7e0] text-[#b06000] border-[#feefc3]" },
      DOIS_BLOCOS: { texto: "🏢 2 Blocos/Torres", classe: "bg-purple-50 text-purple-700 border-purple-200" },
      TRES_BLOCOS: { texto: "🏢 3 Blocos", classe: "bg-purple-50 text-purple-700 border-purple-200" },
      CONDOMINIO_CASAS: { texto: "🏘️ Cond. Casas", classe: "bg-teal-50 text-teal-700 border-teal-200" },
      EM_REFORMA: { texto: "🚧 Em Reforma/Obra", classe: "bg-amber-50 text-amber-800 border-amber-200" }
    };

    for (const tag of tags) {
      if (mapaTags[tag]) badges.push(mapaTags[tag]);
    }
    return badges;
  },

  /**
   * Gera dinamicamente a lista de Anos de Serviço (01/09/AAAA até 31/08/AAAA+1)
   */
  obterAnosDeServicoDisponiveis() {
    const hoje = new Date();
    const anoAtual = hoje.getFullYear();
    const mesAtual = hoje.getMonth() + 1;
    const anoInicioVigente = mesAtual >= 9 ? anoAtual : anoAtual - 1;
    const primeiroAno = 2024;
    const ultimoAno = Math.max(anoInicioVigente + 1, 2026);

    const lista = [];
    for (let ano = ultimoAno; ano >= primeiroAno; ano--) {
      lista.push({
        anoInicio: ano,
        anoFim: ano + 1,
        label: `Ano de Serviço ${ano}/${ano + 1} (01/09/${ano} a 31/08/${ano + 1})`,
        periodo: `01/09/${ano} a 31/08/${ano + 1}`,
        vigente: ano === anoInicioVigente
      });
    }
    return lista;
  },

  /**
   * Filtra uma lista de ciclos { dirigente, dataDesignacao, dataConclusao } para o Ano de Serviço
   */
  filtrarCiclosPorAnoServico(ciclos, anoInicio) {
    if (!Array.isArray(ciclos) || !ciclos.length) return [];
    const inicioTs = new Date(Number(anoInicio), 8, 1, 0, 0, 0, 0).getTime();
    const fimTs = new Date(Number(anoInicio) + 1, 7, 31, 23, 59, 59, 999).getTime();

    return ciclos.filter(c => {
      const tsDesig = this.obterTimestampData(c.dataDesignacao);
      const tsConcl = this.obterTimestampData(c.dataConclusao);

      const desigNoPeriodo = tsDesig >= inicioTs && tsDesig <= fimTs;
      const conclNoPeriodo = tsConcl >= inicioTs && tsConcl <= fimTs;
      const emAbertoNoPeriodo = tsDesig > 0 && tsDesig < inicioTs && (!tsConcl || tsConcl >= inicioTs);
      return desigNoPeriodo || conclNoPeriodo || emAbertoNoPeriodo;
    });
  },

  mostrarToast(mensagem, tipo = "sucesso") {
    const el = document.getElementById("app-toast");
    if (!el) return;
    el.textContent = mensagem;
    el.className = "fixed bottom-5 right-5 z-[70] max-w-sm px-4 py-3 rounded-2xl shadow-lg border text-xs font-semibold transition-all ";
    if (tipo === "erro") {
      el.className += "bg-[#fce8e6] border-[#f6aea9] text-[#a50e0e]";
    } else if (tipo === "aviso") {
      el.className += "bg-[#fef7e0] border-[#fde293] text-[#b06000]";
    } else {
      el.className += "bg-[#e6f4ea] border-[#a8dab5] text-[#137333]";
    }
    el.classList.remove("hidden");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add("hidden"), 4500);
  },

  /**
   * Converte geometria WKT (MultiPolygon Z / Polygon) da aba 'BASE' em coordenadas Leaflet [lat, lng]
   */
  parseWktParaPoligonosLeaflet(wkt) {
    if (!wkt || typeof wkt !== "string") return [];
    const limpo = wkt.trim();
    const regexAnel = /\(\s*([^()]+)\s*\)/g;
    const poligonos = [];
    let match;

    while ((match = regexAnel.exec(limpo)) !== null) {
      const pares = match[1].split(",");
      const coordenadasAnel = [];
      for (const par of pares) {
        const nums = par.trim().split(/\s+/);
        if (nums.length >= 2) {
          const lng = parseFloat(nums[0]);
          const lat = parseFloat(nums[1]);
          if (!isNaN(lat) && !isNaN(lng)) {
            coordenadasAnel.push([lat, lng]);
          }
        }
      }
      if (coordenadasAnel.length >= 3) {
        poligonos.push(coordenadasAnel);
      }
    }
    return poligonos;
  }
};

/**
 * Sistema de Diálogos Customizados Padrão Google Material Design 3
 * Substitui 100% dos pop-ups nativos do navegador (window.confirm / window.alert)
 */
const ModalM3 = {
  _resolveAtual: null,

  fechar(resultado = null) {
    const container = document.getElementById("modal-m3-dialog");
    if (container) {
      container.classList.add("hidden");
      container.classList.remove("flex");
    }
    if (this._resolveAtual) {
      const fn = this._resolveAtual;
      this._resolveAtual = null;
      fn(resultado);
    }
  },

  /**
   * Exibe modal de confirmação Material 3 retornando Promise<boolean>
   */
  confirmar({ titulo, subtituloHtml, textoConfirmar = "Confirmar", textoCancelar = "Cancelar", variante = "primario", icone = "📌" }) {
    return new Promise(resolve => {
      this._resolveAtual = resolve;
      const container = document.getElementById("modal-m3-dialog");
      const content = document.getElementById("modal-m3-content");
      if (!container || !content) {
        resolve(false);
        return;
      }

      const btnColors = variante === "perigo"
        ? "bg-[#c5221f] hover:bg-[#a50e0e] text-white"
        : "bg-[#0b57d0] hover:bg-[#0842a0] text-white";

      const iconBg = variante === "perigo"
        ? "bg-[#fce8e6] text-[#c5221f]"
        : "bg-[#d3e3fd] text-[#041e49]";

      content.innerHTML = `
        <div class="p-6">
          <div class="w-11 h-11 rounded-full ${iconBg} flex items-center justify-center text-lg mb-4">
            ${icone}
          </div>
          <h3 class="text-lg font-bold text-[#1f1f1f] leading-snug">${Utils.escapeHtml(titulo)}</h3>
          <div class="mt-2.5 text-xs text-[#444746] leading-relaxed space-y-2">
            ${subtituloHtml || ""}
          </div>
          <div class="mt-6 flex items-center justify-end gap-2">
            ${textoCancelar ? `
              <button type="button" id="m3-btn-cancel" class="px-4 py-2.5 rounded-full text-xs font-semibold text-[#0b57d0] hover:bg-[#f0f6ff] transition">
                ${Utils.escapeHtml(textoCancelar)}
              </button>
            ` : ""}
            <button type="button" id="m3-btn-confirm" class="px-5 py-2.5 rounded-full text-xs font-semibold shadow-sm transition ${btnColors}">
              ${Utils.escapeHtml(textoConfirmar)}
            </button>
          </div>
        </div>
      `;

      container.classList.remove("hidden");
      container.classList.add("flex");

      const btnCancel = document.getElementById("m3-btn-cancel");
      const btnConfirm = document.getElementById("m3-btn-confirm");
      if (btnCancel) btnCancel.onclick = () => this.fechar(false);
      if (btnConfirm) {
        btnConfirm.onclick = () => this.fechar(true);
        setTimeout(() => btnConfirm.focus(), 50);
      }
    });
  },

  /**
   * Exibe modal de alerta informativo Material 3 (Ex: Conflito de Concorrência 409)
   */
  alerta({ titulo, subtituloHtml, textoBotao = "Entendi", icone = "⚠️" }) {
    return this.confirmar({
      titulo,
      subtituloHtml,
      textoConfirmar: textoBotao,
      textoCancelar: "",
      variante: "primario",
      icone
    });
  },

  /**
   * Fluxo de Devolução em Duas Etapas (Regra de Negócio 2):
   * Etapa 1: "Confirma que o território foi totalmente completo?" (Sim / Não)
   * Etapa 2 (se Não): Opções fechadas (Quadras faltantes, Prédios não trabalhados, Não iniciado)
   * Retorna Promise<{ confirmado: boolean, foiCompleto: boolean, motivoNaoCompleto: string } | null>
   */
  abrirDevolucaoDuasEtapas(territorio) {
    return new Promise(resolve => {
      this._resolveAtual = resolve;
      const container = document.getElementById("modal-m3-dialog");
      const content = document.getElementById("modal-m3-content");
      if (!container || !content) {
        resolve(null);
        return;
      }

      const num = Number(territorio.numero);
      const bairro = Utils.escapeHtml(territorio.bairro || "");
      const qtdPredios = Array.isArray(territorio.predios) ? territorio.predios.length : 0;

      const renderEtapa1 = () => {
        content.innerHTML = `
          <div class="p-6">
            <div class="w-11 h-11 rounded-full bg-[#d3e3fd] text-[#041e49] flex items-center justify-center text-lg mb-4">
              📋
            </div>
            <span class="text-[11px] font-semibold uppercase tracking-wider text-[#0b57d0]">Devolução de Cartão</span>
            <h3 class="text-lg font-bold text-[#1f1f1f] mt-0.5">Território ${num} — ${bairro}</h3>
            <div class="mt-3 p-3.5 rounded-2xl bg-[#f8fafc] border border-slate-200">
              <p class="text-sm font-semibold text-[#1f1f1f]">Confirma que o território foi totalmente completo?</p>
              <p class="text-xs text-[#444746] mt-1">
                Se confirmado como <strong>Sim</strong>, o território voltará para a fila como concluído e cumprirá o descanso de 120 dias.
              </p>
            </div>
            <div class="mt-6 flex flex-wrap items-center justify-end gap-2">
              <button type="button" id="m3-dev-cancel" class="px-4 py-2.5 rounded-full text-xs font-semibold text-[#444746] hover:bg-slate-100 transition mr-auto">
                Cancelar
              </button>
              <button type="button" id="m3-dev-nao" class="px-5 py-2.5 rounded-full text-xs font-semibold bg-[#f1f5f9] hover:bg-[#e2e8f0] text-[#1f1f1f] border border-slate-300 transition">
                Não
              </button>
              <button type="button" id="m3-dev-sim" class="px-5 py-2.5 rounded-full text-xs font-semibold bg-[#0b57d0] hover:bg-[#0842a0] text-white shadow-sm transition">
                Sim, foi completo
              </button>
            </div>
          </div>
        `;

        document.getElementById("m3-dev-cancel").onclick = () => this.fechar(null);
        document.getElementById("m3-dev-sim").onclick = () =>
          this.fechar({ confirmado: true, foiCompleto: true, motivoNaoCompleto: "COMPLETO" });
        document.getElementById("m3-dev-nao").onclick = () => renderEtapa2();
      };

      const renderEtapa2 = () => {
        let motivoSelecionado = "QUADRAS_FALTANTES";

        content.innerHTML = `
          <div class="p-6">
            <div class="flex items-center justify-between mb-3">
              <span class="text-[11px] font-semibold uppercase tracking-wider text-[#b06000] bg-[#fef7e0] px-2.5 py-1 rounded-full border border-[#feefc3]">
                Motivo da Devolução Parcial / Não Iniciada
              </span>
            </div>
            <h3 class="text-base font-bold text-[#1f1f1f]">Território ${num} — ${bairro}</h3>
            <p class="text-xs text-[#444746] mt-1">Selecione uma das opções abaixo para definir o destino do cartão na fila:</p>

            <div class="mt-4 space-y-2.5" id="m3-dev-opcoes">
              <label class="m3-radio-card selected flex items-start gap-3 p-3.5" data-motivo="QUADRAS_FALTANTES">
                <input type="radio" name="motivo_devolucao" value="QUADRAS_FALTANTES" checked class="mt-1 accent-[#0b57d0]" />
                <div>
                  <span class="block text-xs font-bold text-[#1f1f1f]">🏘️ Quadras faltantes</span>
                  <span class="block text-[11px] text-[#444746] mt-0.5">
                    O território foi trabalhado parcialmente. Volta para a fila como <strong>concluído</strong> (aguarda o ciclo de 120 dias).
                  </span>
                </div>
              </label>

              <label class="m3-radio-card flex items-start gap-3 p-3.5" data-motivo="PREDIOS_NAO_TRABALHADOS">
                <input type="radio" name="motivo_devolucao" value="PREDIOS_NAO_TRABALHADOS" class="mt-1 accent-[#0b57d0]" />
                <div>
                  <span class="block text-xs font-bold text-[#1f1f1f]">🏢 Prédios não trabalhados ${qtdPredios ? `(${qtdPredios} no cartão)` : ""}</span>
                  <span class="block text-[11px] text-[#444746] mt-0.5">
                    As quadras residenciais foram feitas, restando prédios. Volta para a fila como <strong>concluído</strong> (aguarda o ciclo de 120 dias).
                  </span>
                </div>
              </label>

              <label class="m3-radio-card flex items-start gap-3 p-3.5" data-motivo="NAO_INICIADO">
                <input type="radio" name="motivo_devolucao" value="NAO_INICIADO" class="mt-1 accent-[#0b57d0]" />
                <div>
                  <span class="block text-xs font-bold text-[#137333]">↩️ Não iniciado</span>
                  <span class="block text-[11px] text-[#444746] mt-0.5">
                    Não houve trabalho no cartão. Volta <strong>imediatamente para a fila como DISPONÍVEL</strong> e sem registrar data de início ou conclusão.
                  </span>
                </div>
              </label>
            </div>

            <div class="mt-6 flex items-center justify-between gap-2">
              <button type="button" id="m3-dev-voltar" class="px-4 py-2.5 rounded-full text-xs font-semibold text-[#444746] hover:bg-slate-100 transition">
                ← Voltar
              </button>
              <button type="button" id="m3-dev-confirmar-motivo" class="px-5 py-2.5 rounded-full text-xs font-semibold bg-[#0b57d0] hover:bg-[#0842a0] text-white shadow-sm transition">
                Confirmar Devolução
              </button>
            </div>
          </div>
        `;

        const cards = content.querySelectorAll(".m3-radio-card");
        cards.forEach(card => {
          card.addEventListener("click", () => {
            cards.forEach(c => c.classList.remove("selected"));
            card.classList.add("selected");
            const radio = card.querySelector("input[type='radio']");
            if (radio) {
              radio.checked = true;
              motivoSelecionado = radio.value;
            }
          });
        });

        document.getElementById("m3-dev-voltar").onclick = () => renderEtapa1();
        document.getElementById("m3-dev-confirmar-motivo").onclick = () =>
          this.fechar({
            confirmado: true,
            foiCompleto: false,
            motivoNaoCompleto: motivoSelecionado
          });
      };

      renderEtapa1();
      container.classList.remove("hidden");
      container.classList.add("flex");
    });
  }
};
