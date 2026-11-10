/**
 * Utilitários de Segurança (Prevenção contra XSS, Formatação e Conversor WKT -> GeoJSON)
 */
const Utils = {
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
    if (!isoDate) return "Sem registro";
    const partes = String(isoDate).split("T")[0].split("-");
    if (partes.length === 3) {
      return `${partes[2]}/${partes[1]}/${partes[0]}`;
    }
    return this.escapeHtml(isoDate);
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
