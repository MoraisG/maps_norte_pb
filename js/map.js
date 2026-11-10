/**
 * Módulo de Mapa Interativo GIS (Leaflet.js)
 * Renderiza os polígonos WKT reais da aba 'BASE' de Pato Branco - PR
 */
const MapaTerritorios = {
  map: null,
  layerGroup: null,
  inicializado: false,

  modalMap: null,
  modalLayerGroup: null,
  modalInicializado: false,

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

  inicializarModal() {
    if (this.modalInicializado) {
      setTimeout(() => this.modalMap.invalidateSize(), 100);
      return;
    }

    this.modalMap = L.map("modal-map-container", {
      center: [-26.2285, -52.6715],
      zoom: 15,
      zoomControl: true
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap | Gestão de Territórios"
    }).addTo(this.modalMap);

    this.modalLayerGroup = L.featureGroup().addTo(this.modalMap);
    this.modalInicializado = true;
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
        : `<p class="text-xs text-slate-400 mt-1">Última devolução: ${Utils.formatarDataBr(t.ultimaData)}</p>`;

      let botaoAcaoHtml = "";
      if (App.podeSolicitarTerritorio(t)) {
        botaoAcaoHtml = `<button onclick="App.acaoSolicitar(${Number(t.numero)})" class="mt-2.5 w-full py-1.5 px-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-lg">Solicitar Território ${Number(t.numero)}</button>`;
      } else if (t.statusReal === "OCUPADO" && (t.emMinhaPosse || (App.usuarioAtual && App.usuarioAtual.perfil === "ADMIN"))) {
        botaoAcaoHtml = `<button onclick="App.acaoDevolver(${Number(t.numero)})" class="mt-2.5 w-full py-1.5 px-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs rounded-lg">Devolver Território ${Number(t.numero)}</button>`;
      } else if (t.statusReal === "RECENTE") {
        botaoAcaoHtml = `<button disabled class="mt-2.5 w-full py-1.5 px-3 bg-slate-800 text-slate-500 font-bold text-xs rounded-lg cursor-not-allowed">Indisponível (&le; 120 dias)</button>`;
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

  /**
   * Abre modal exibindo exclusivamente o mapa do território selecionado
   */
  abrirModalTerritorio(numero) {
    const t = App.territorios.find(item => Number(item.numero) === Number(numero));
    if (!t || !t.wkt) {
      Utils.mostrarToast("Geometria do mapa não disponível para este território.", "aviso");
      return;
    }

    const aneis = Utils.parseWktParaPoligonosLeaflet(t.wkt);
    if (!aneis.length) {
      Utils.mostrarToast("Polígono inválido para este território.", "erro");
      return;
    }

    const modal = document.getElementById("modal-mapa-territorio");
    if (!modal) return;

    // Preenche informações de cabeçalho da modal
    document.getElementById("modal-mapa-tipo").textContent = t.tipo || "Cidade";
    document.getElementById("modal-mapa-titulo").textContent = `Território ${Number(t.numero)} — ${t.bairro}`;

    const { badgeClass, label } = Utils.obterEstiloStatus(t);
    const statusBadge = document.getElementById("modal-mapa-status");
    statusBadge.className = `px-2.5 py-0.5 text-[10px] font-bold rounded-full border ${badgeClass}`;
    statusBadge.textContent = label;

    const subtituloEl = document.getElementById("modal-mapa-subtitulo");
    if (t.statusReal === "OCUPADO") {
      subtituloEl.textContent = `👤 Em posse de: ${t.dirigente || "Dirigente"} desde ${Utils.formatarDataBr(t.ultimaData)}`;
    } else {
      subtituloEl.textContent = `📅 Última devolução: ${Utils.formatarDataBr(t.ultimaData)}`;
    }

    // Botão de ação no rodapé da modal
    const acoesEl = document.getElementById("modal-mapa-acoes");
    if (App.podeSolicitarTerritorio(t)) {
      acoesEl.innerHTML = `
        <button onclick="MapaTerritorios.fecharModalTerritorio(); App.acaoSolicitar(${Number(t.numero)});" class="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition">
          Solicitar Território ${Number(t.numero)}
        </button>`;
    } else if (t.statusReal === "OCUPADO" && (t.emMinhaPosse || (App.usuarioAtual && App.usuarioAtual.perfil === "ADMIN"))) {
      acoesEl.innerHTML = `
        <button onclick="MapaTerritorios.fecharModalTerritorio(); App.acaoDevolver(${Number(t.numero)});" class="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition">
          Devolver Território ${Number(t.numero)}
        </button>`;
    } else if (t.statusReal === "RECENTE") {
      acoesEl.innerHTML = `<span class="text-xs text-sky-300">⏳ Disponível para solicitação apenas após mais de 120 dias da última devolução.</span>`;
    } else {
      acoesEl.innerHTML = "";
    }

    modal.classList.remove("hidden");
    modal.classList.add("flex");

    this.inicializarModal();
    this.modalLayerGroup.clearLayers();

    const cor = this.obterCorStatus(t);
    const poly = L.polygon(aneis, {
      color: cor.borda,
      weight: 3,
      fillColor: cor.preenchimento,
      fillOpacity: 0.4
    });

    poly.bindTooltip(`Território ${Number(t.numero)} — ${Utils.escapeHtml(t.bairro)}`, {
      permanent: true,
      direction: "center",
      className: "territorio-label-tooltip"
    });

    this.modalLayerGroup.addLayer(poly);

    clearTimeout(this._modalTimer);
    this._modalTimer = setTimeout(() => {
      this.modalMap.invalidateSize();
      try {
        this.modalMap.fitBounds(poly.getBounds(), { maxZoom: 17, padding: [35, 35] });
      } catch (e) {}
    }, 150);
  },

  fecharModalTerritorio() {
    clearTimeout(this._modalTimer);
    const modal = document.getElementById("modal-mapa-territorio");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  },

  focarTerritorio(numero) {
    this.abrirModalTerritorio(numero);
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
