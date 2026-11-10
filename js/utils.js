/**
 * Utilitários de Segurança (Prevenção contra XSS, Formatação e Conversor WKT -> GeoJSON)
 */
const Utils = {
  DIAS_QUARENTENA_DEVOLUCAO: 120,

  // Escapa strings antes de inserir no DOM para impedir ataques XSS (Camada 7 e Seção 18 do Plano v2)
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
   * Centraliza rótulo e classes visuais de status do território (evita duplicação entre cards e modal)
   */
  obterEstiloStatus(t) {
    let badgeClass = "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    if (t.statusReal === "OCUPADO") badgeClass = "bg-amber-500/15 text-amber-300 border-amber-500/30";
    if (t.statusReal === "RECENTE") badgeClass = "bg-sky-500/15 text-sky-300 border-sky-500/30";
    if (t.emMinhaPosse) badgeClass = "bg-indigo-500/20 text-indigo-300 border-indigo-500/40";

    const label = t.emMinhaPosse ? "COM VOCÊ" : t.statusReal;
    return { badgeClass, label };
  },

  /**
   * Gera dinamicamente a lista de Anos de Serviço (01/09/AAAA até 31/08/AAAA+1)
   * garantindo suporte a 01/09/2025 até 31/08/2026 e aos anos subsequentes automaticamente.
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
   * Filtra uma lista de ciclos { dirigente, dataDesignacao, dataConclusao } para o Ano de Serviço (01/09/AAAA a 31/08/AAAA+1)
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
    el.className = "fixed bottom-5 right-5 z-50 max-w-sm px-4 py-3 rounded-xl shadow-2xl border text-xs font-semibold transition-all ";
    if (tipo === "erro") {
      el.className += "bg-rose-950 border-rose-700 text-rose-200";
    } else if (tipo === "aviso") {
      el.className += "bg-amber-950 border-amber-700 text-amber-200";
    } else {
      el.className += "bg-emerald-950 border-emerald-700 text-emerald-200";
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
