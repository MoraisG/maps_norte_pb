/**
 * Módulo de Mapa Interativo GIS (Leaflet.js)
 * Renderiza os polígonos WKT reais da aba 'BASE' de Pato Branco - PR
 */
const MapaTerritorios = {
  map: null,
  layerGroup: null,
  inicializado: false,

  inicializar() {
    if (this.inicializado) {
      setTimeout(() => this.map.invalidateSize(), 150);
      return;
    }

    // Coordenadas centrais de Pato Branco - PR
    this.map = L.map("map-container", {
      center: [-26.2285, -52.6715],
      zoom: 14,
      zoomControl: true
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap | Gestão de Territórios"
    }).addTo(this.map);

    this.layerGroup = L.featureGroup().addTo(this.map);
    this.inicializado = true;
  },

  renderizarPoligonos(territorios) {
    if (!this.inicializado) this.inicializar();
    this.layerGroup.clearLayers();

    let temPoligonos = false;

    for (const t of territorios) {
      if (!t.wkt) continue;
      const aneis = Utils.parseWktParaPoligonosLeaflet(t.wkt);
      if (!aneis.length) continue;

      temPoligonos = true;
      const cor = this.obterCorStatus(t);

      const poly = L.polygon(aneis, {
        color: cor.borda,
        weight: t.emMinhaPosse ? 3 : 1.8,
        fillColor: cor.preenchimento,
        fillOpacity: t.emMinhaPosse ? 0.55 : 0.35
      });

      poly.bindTooltip(`${t.numero}`, {
        permanent: true,
        direction: "center",
        className: "territorio-label-tooltip"
      });

      const dirInfo = t.statusReal === "OCUPADO"
        ? `<p class="text-xs text-amber-300 mt-1">👤 Com: <strong>${Utils.escapeHtml(t.dirigente || "Dirigente")}</strong></p>`
        : `<p class="text-xs text-slate-400 mt-1">Última data: ${Utils.formatarDataBr(t.ultimaData)}</p>`;

      let botaoAcaoHtml = "";
      if (t.statusReal !== "OCUPADO") {
        botaoAcaoHtml = `<button onclick="App.acaoSolicitar(${Number(t.numero)})" class="mt-2.5 w-full py-1.5 px-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-lg">Solicitar Território ${Number(t.numero)}</button>`;
      } else if (t.emMinhaPosse || (App.usuarioAtual && App.usuarioAtual.perfil === "ADMIN")) {
        botaoAcaoHtml = `<button onclick="App.acaoDevolver(${Number(t.numero)})" class="mt-2.5 w-full py-1.5 px-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs rounded-lg">Devolver Território ${Number(t.numero)}</button>`;
      }

      const popupHtml = `
        <div class="min-w-[190px] p-1">
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm font-bold text-white">Território ${Number(t.numero)}</span>
            <span class="px-2 py-0.5 text-[10px] font-bold rounded-full" style="background:${cor.preenchimento}33;color:${cor.borda};border:1px solid ${cor.borda}">${Utils.escapeHtml(t.statusReal)}</span>
          </div>
          <p class="text-xs text-slate-300 font-medium mt-0.5">${Utils.escapeHtml(t.bairro)} (${Utils.escapeHtml(t.tipo)})</p>
          ${dirInfo}
          ${botaoAcaoHtml}
        </div>
      `;

      poly.bindPopup(popupHtml);
      this.layerGroup.addLayer(poly);
    }

    if (temPoligonos) {
      setTimeout(() => {
        this.map.invalidateSize();
        try {
          this.map.fitBounds(this.layerGroup.getBounds(), { padding: [20, 20] });
        } catch (e) {}
      }, 200);
    }
  },

  focarTerritorio(numero) {
    App.alternarAba("tab-mapa");
    setTimeout(() => {
      this.layerGroup.eachLayer(layer => {
        const tooltip = layer.getTooltip();
        if (tooltip && String(tooltip.getContent()).trim() === String(numero)) {
          this.map.fitBounds(layer.getBounds(), { maxZoom: 17, padding: [40, 40] });
          layer.openPopup();
        }
      });
    }, 250);
  },

  obterCorStatus(t) {
    if (t.emMinhaPosse) {
      return { borda: "#818cf8", preenchimento: "#6366f1" }; // Indigo (Comigo)
    }
    if (t.statusReal === "OCUPADO") {
      return { borda: "#fbbf24", preenchimento: "#f59e0b" }; // Amber (Ocupado)
    }
    if (t.statusReal === "RECENTE") {
      return { borda: "#38bdf8", preenchimento: "#0ea5e9" }; // Sky (Recente <= 120d)
    }
    return { borda: "#34d399", preenchimento: "#10b981" };   // Emerald (Disponível)
  }
};
