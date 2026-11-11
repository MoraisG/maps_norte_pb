/**
 * Módulo de Mapa Interativo GIS (Leaflet.js)
 * Renderiza os polígonos WKT reais da aba 'BASE' e os pinos georreferenciados dos prédios da Congregação Norte
 */
const MapaTerritorios = {
  map: null,
  layerGroup: null,
  prediosLayerGroup: null,
  inicializado: false,

  modalMap: null,
  modalLayerGroup: null,
  modalMarkersPorId: {},
  territorioModalAtual: null,
  modalInicializado: false,

  inicializar() {
    if (this.inicializado) {
      setTimeout(() => this.map.invalidateSize(), 150);
      return;
    }

    this.map = L.map("map-container", {
      center: [-26.2265, -52.6725],
      zoom: 14,
      zoomControl: true
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap | Congregação Norte PB"
    }).addTo(this.map);

    this.layerGroup = L.featureGroup().addTo(this.map);
    this.prediosLayerGroup = L.featureGroup().addTo(this.map);

    const togglePredios = document.getElementById("toggle-map-predios");
    if (togglePredios) {
      togglePredios.addEventListener("change", () => {
        if (togglePredios.checked) {
          this.map.addLayer(this.prediosLayerGroup);
        } else {
          this.map.removeLayer(this.prediosLayerGroup);
        }
      });
    }

    this.inicializado = true;
  },

  inicializarModal() {
    if (this.modalInicializado) {
      setTimeout(() => this.modalMap.invalidateSize(), 100);
      return;
    }

    this.modalMap = L.map("modal-map-container", {
      center: [-26.2265, -52.6725],
      zoom: 16,
      zoomControl: true
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap | Congregação Norte PB"
    }).addTo(this.modalMap);

    this.modalLayerGroup = L.featureGroup().addTo(this.modalMap);
    this.modalInicializado = true;
  },

  obterClassePinoPredio(p) {
    if (p.trabalhadoNesteCiclo || p.ultimaDataConclusao) return "pin-done";
    if (p.tipoInterfone === "SEM_INTERFONE") return "pin-red";
    const tags = Array.isArray(p.tagsLogisticas) ? p.tagsLogisticas : [];
    if (tags.includes("EXIGE_CODIGO") || tags.includes("COM_CAMERA") || tags.includes("ACESSO_RESTRITO") || tags.includes("SEM_ACESSO")) {
      return "pin-amber";
    }
    return "pin-green";
  },

  /**
   * Evita que prédios muito próximos fiquem exatamente sobrepostos no mapa
   */
  deslocarCoordenadasProximas(predios) {
    const vistos = {};
    return (predios || []).map((p, idx) => {
      const latBase = Number(p.latitude || 0);
      const lngBase = Number(p.longitude || 0);
      const chave = `${latBase.toFixed(4)}_${lngBase.toFixed(4)}`;
      const ordem = vistos[chave] || 0;
      vistos[chave] = ordem + 1;

      if (ordem === 0) {
        return { predio: p, ordemPin: idx + 1, lat: latBase, lng: lngBase };
      }
      const angulo = (ordem * 137.5 * Math.PI) / 180;
      const raioGraus = 0.000055 * Math.ceil(ordem / 2);
      return {
        predio: p,
        ordemPin: idx + 1,
        lat: latBase + Math.sin(angulo) * raioGraus,
        lng: lngBase + Math.cos(angulo) * raioGraus
      };
    });
  },

  renderizarPoligonos(territorios) {
    if (!this.inicializado) this.inicializar();
    this.layerGroup.clearLayers();
    this.prediosLayerGroup.clearLayers();

    let temPoligonos = false;
    const filaTop5Set = new Set((App.obterFilaCincoDisponiveis ? App.obterFilaCincoDisponiveis() : []).map(x => Number(x.numero)));

    for (const t of territorios) {
      if (!t.wkt) continue;
      const aneis = Utils.parseWktParaPoligonosLeaflet(t.wkt);
      if (!aneis.length) continue;

      temPoligonos = true;
      const naFilaTop5 = filaTop5Set.has(Number(t.numero));
      const cor = this.obterCorStatus(t, naFilaTop5);
      const qtdPredios = Array.isArray(t.predios) ? t.predios.length : 0;

      const poly = L.polygon(aneis, {
        color: cor.borda,
        weight: t.emMinhaPosse || naFilaTop5 ? 2.6 : 1.5,
        fillColor: cor.preenchimento,
        fillOpacity: t.emMinhaPosse ? 0.45 : (naFilaTop5 ? 0.35 : 0.22)
      });

      const labelTooltip = qtdPredios > 0 ? `${t.numero} (${qtdPredios}🏢)` : `${t.numero}`;
      poly.bindTooltip(labelTooltip, {
        permanent: true,
        direction: "center",
        className: "territorio-label-tooltip"
      });

      const dirInfo = t.statusReal === "OCUPADO"
        ? `<p class="text-xs text-[#b06000] font-medium mt-1">👤 Com: <strong>${Utils.escapeHtml(t.dirigente || "Dirigente")}</strong></p>`
        : `<p class="text-xs text-slate-500 mt-1">Última conclusão: ${Utils.formatarDataBr(t.ultimaData)}</p>`;

      const prediosInfo = qtdPredios > 0
        ? `<p class="text-xs text-[#0b57d0] font-semibold mt-1">🏢 ${qtdPredios} prédio(s) mapeado(s) neste cartão</p>`
        : `<p class="text-[11px] text-slate-400 mt-1">Sem prédios verticais mapeados</p>`;

      let botaoAcaoHtml = `
        <button onclick="MapaTerritorios.abrirModalTerritorio(${Number(t.numero)})" class="mt-2.5 w-full py-1.5 px-3 bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold text-xs rounded-full transition">
          Ver Cartão e Prédios (${qtdPredios})
        </button>`;

      if (App.podeSolicitarTerritorio(t)) {
        botaoAcaoHtml += `<button onclick="App.acaoSolicitar(${Number(t.numero)})" class="mt-1.5 w-full py-1.5 px-3 bg-[#0b57d0] hover:bg-[#0842a0] text-white font-semibold text-xs rounded-full transition">Solicitar Território ${Number(t.numero)}</button>`;
      } else if (t.statusReal === "OCUPADO" && (t.emMinhaPosse || (App.usuarioAtual && App.usuarioAtual.perfil === "ADMIN"))) {
        botaoAcaoHtml += `<button onclick="App.acaoDevolver(${Number(t.numero)})" class="mt-1.5 w-full py-1.5 px-3 bg-[#0b57d0] hover:bg-[#0842a0] text-white font-semibold text-xs rounded-full transition">Devolver Território ${Number(t.numero)}</button>`;
      }

      const popupHtml = `
        <div class="min-w-[210px] p-1">
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm font-bold text-slate-900">Território ${Number(t.numero)}</span>
            <span class="px-2 py-0.5 text-[10px] font-bold rounded-full" style="background:${cor.preenchimento}22;color:${cor.borda};border:1px solid ${cor.borda}55">${Utils.escapeHtml(naFilaTop5 ? "NA FILA" : t.statusReal)}</span>
          </div>
          <p class="text-xs text-slate-600 font-medium mt-0.5">${Utils.escapeHtml(t.bairro)} (${Utils.escapeHtml(t.tipo)})</p>
          ${dirInfo}
          ${prediosInfo}
          ${botaoAcaoHtml}
        </div>
      `;

      poly.bindPopup(popupHtml);
      this.layerGroup.addLayer(poly);

      // Pinos dos prédios no Mapa Geral
      if (qtdPredios > 0) {
        const pontos = this.deslocarCoordenadasProximas(t.predios);
        for (const item of pontos) {
          const p = item.predio;
          if (!item.lat || !item.lng) continue;
          const pinClass = this.obterClassePinoPredio(p);
          const icon = L.divIcon({
            className: "",
            html: `<div class="predio-pin-marker ${pinClass}" title="${Utils.escapeHtml(p.nomeEdificio)}">${item.ordemPin}</div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
          });
          const marker = L.marker([item.lat, item.lng], { icon });
          const { interfoneBadge, tagsBadges } = Utils.obterBadgesPredio(p);
          marker.bindPopup(`
            <div class="min-w-[200px] p-1">
              <p class="text-[10px] font-bold uppercase text-[#0b57d0]">Território ${Number(t.numero)} • Prédio #${item.ordemPin}</p>
              <p class="text-xs font-bold text-slate-900 mt-0.5">${Utils.escapeHtml(p.nomeEdificio)}</p>
              <p class="text-[11px] text-slate-600">${Utils.escapeHtml(p.endereco)}</p>
              <div class="mt-1.5 flex flex-wrap gap-1">
                <span class="px-2 py-0.5 text-[10px] font-semibold rounded-full ${interfoneBadge.cls}">${interfoneBadge.texto}</span>
                ${tagsBadges.map(b => `<span class="px-2 py-0.5 text-[10px] font-medium rounded-full ${b.cls}">${b.texto}</span>`).join("")}
              </div>
              <button onclick="MapaTerritorios.abrirModalTerritorio(${Number(t.numero)}, '${Utils.escapeHtml(p.idPredio)}')" class="mt-2 w-full py-1 px-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold text-[11px] rounded-full transition">
                Abrir Guia do Cartão ${Number(t.numero)}
              </button>
            </div>
          `);
          this.prediosLayerGroup.addLayer(marker);
        }
      }
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
   * Abre modal exibindo o mapa do território + pinos numerados dos prédios + guia de apoio ao dirigente
   */
  abrirModalTerritorio(numero, idPredioDestaque) {
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

    this.territorioModalAtual = Number(t.numero);
    const modal = document.getElementById("modal-mapa-territorio");
    if (!modal) return;

    document.getElementById("modal-mapa-tipo").textContent = t.tipo || "Cidade";
    document.getElementById("modal-mapa-titulo").textContent = `Território ${Number(t.numero)} — ${t.bairro}`;

    const filaTop5Set = new Set((App.obterFilaCincoDisponiveis ? App.obterFilaCincoDisponiveis() : []).map(x => Number(x.numero)));
    const { badgeClass, label } = Utils.obterEstiloStatus(t, filaTop5Set.has(Number(t.numero)));
    const statusBadge = document.getElementById("modal-mapa-status");
    statusBadge.className = `px-2.5 py-0.5 text-[10px] font-bold rounded-full border ${badgeClass}`;
    statusBadge.textContent = label;

    const predios = Array.isArray(t.predios) ? t.predios : [];
    const countBadge = document.getElementById("modal-mapa-predios-count");
    if (countBadge) {
      if (predios.length > 0) {
        const concluidos = predios.filter(p => p.trabalhadoNesteCiclo || p.ultimaDataConclusao).length;
        countBadge.textContent = `🏢 ${predios.length} prédio(s) • ${concluidos} trabalhado(s)`;
        countBadge.classList.remove("hidden");
      } else {
        countBadge.classList.add("hidden");
      }
    }

    const subtituloEl = document.getElementById("modal-mapa-subtitulo");
    if (t.statusReal === "OCUPADO") {
      subtituloEl.textContent = `👤 Em posse de: ${t.dirigente || "Dirigente"} desde ${Utils.formatarDataBr(t.ultimaData)}`;
    } else {
      subtituloEl.textContent = `📅 Última conclusão registrada: ${Utils.formatarDataBr(t.ultimaData)}`;
    }

    // Botão de ação no rodapé da modal
    const acoesEl = document.getElementById("modal-mapa-acoes");
    if (App.podeSolicitarTerritorio(t)) {
      acoesEl.innerHTML = `
        <button onclick="MapaTerritorios.fecharModalTerritorio(); App.acaoSolicitar(${Number(t.numero)});" class="m3-btn-filled text-xs">
          Solicitar Território ${Number(t.numero)}
        </button>`;
    } else if (t.statusReal === "OCUPADO" && (t.emMinhaPosse || (App.usuarioAtual && App.usuarioAtual.perfil === "ADMIN"))) {
      acoesEl.innerHTML = `
        <button onclick="MapaTerritorios.fecharModalTerritorio(); App.acaoDevolver(${Number(t.numero)});" class="m3-btn-filled text-xs">
          Devolver Território ${Number(t.numero)}
        </button>`;
    } else if (t.statusReal === "RECENTE") {
      acoesEl.innerHTML = `<span class="text-xs text-slate-500">⏳ Em período de descanso de 120 dias após conclusão.</span>`;
    } else {
      acoesEl.innerHTML = `<span class="text-xs text-slate-500">Consulte os prédios e limites deste cartão no mapa acima.</span>`;
    }

    modal.classList.remove("hidden");
    modal.classList.add("flex");

    this.inicializarModal();
    this.modalLayerGroup.clearLayers();
    this.modalMarkersPorId = {};

    const cor = this.obterCorStatus(t, filaTop5Set.has(Number(t.numero)));
    const poly = L.polygon(aneis, {
      color: cor.borda,
      weight: 3,
      fillColor: cor.preenchimento,
      fillOpacity: 0.22
    });

    poly.bindTooltip(`Território ${Number(t.numero)} — ${Utils.escapeHtml(t.bairro)}`, {
      permanent: false,
      direction: "center",
      className: "territorio-label-tooltip"
    });

    this.modalLayerGroup.addLayer(poly);

    // Plotar pinos numerados dos prédios do cartão
    const pontos = this.deslocarCoordenadasProximas(predios);
    for (const item of pontos) {
      const p = item.predio;
      if (!item.lat || !item.lng) continue;
      const pinClass = this.obterClassePinoPredio(p);
      const icon = L.divIcon({
        className: "",
        html: `<div class="predio-pin-marker ${pinClass}">${item.ordemPin}</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });

      const marker = L.marker([item.lat, item.lng], { icon });
      const { interfoneBadge, tagsBadges, metaStr } = Utils.obterBadgesPredio(p);
      marker.bindPopup(`
        <div class="min-w-[210px] p-1">
          <div class="flex items-center justify-between gap-2">
            <span class="text-[11px] font-bold text-[#0b57d0]">Prédio #${item.ordemPin}</span>
            <span class="px-2 py-0.5 text-[10px] font-semibold rounded-full ${interfoneBadge.cls}">${interfoneBadge.texto}</span>
          </div>
          <p class="text-xs font-bold text-slate-900 mt-1">${Utils.escapeHtml(p.nomeEdificio)}</p>
          <p class="text-[11px] text-slate-700 font-medium">${Utils.escapeHtml(p.endereco)}</p>
          ${metaStr ? `<p class="text-[11px] text-slate-500 mt-0.5">${Utils.escapeHtml(metaStr)}</p>` : ""}
          ${p.referenciaComercial ? `<p class="text-[11px] text-slate-600 mt-0.5">📍 ${Utils.escapeHtml(p.referenciaComercial)}</p>` : ""}
          ${tagsBadges.length ? `<div class="mt-1.5 flex flex-wrap gap-1">${tagsBadges.map(b => `<span class="px-2 py-0.5 text-[10px] font-medium rounded-full ${b.cls}">${b.texto}</span>`).join("")}</div>` : ""}
        </div>
      `);

      marker.on("click", () => {
        const cardEl = document.getElementById(`card-predio-${p.idPredio}`);
        if (cardEl) {
          cardEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
          cardEl.classList.add("ring-2", "ring-[#0b57d0]");
          setTimeout(() => cardEl.classList.remove("ring-2", "ring-[#0b57d0]"), 1800);
        }
      });

      this.modalLayerGroup.addLayer(marker);
      this.modalMarkersPorId[p.idPredio] = { marker, lat: item.lat, lng: item.lng };
    }

    this.renderizarListaPrediosModal(t, pontos);

    clearTimeout(this._modalTimer);
    this._modalTimer = setTimeout(() => {
      this.modalMap.invalidateSize();
      try {
        if (idPredioDestaque && this.modalMarkersPorId[idPredioDestaque]) {
          this.focarPredioNoModal(idPredioDestaque);
        } else {
          this.modalMap.fitBounds(this.modalLayerGroup.getBounds(), { maxZoom: 17, padding: [30, 30] });
        }
      } catch (e) {}
    }, 150);
  },

  renderizarListaPrediosModal(t, pontosNumerados) {
    const listaEl = document.getElementById("modal-predios-lista");
    const resumoEl = document.getElementById("modal-predios-resumo");
    if (!listaEl) return;

    const predios = Array.isArray(t.predios) ? t.predios : [];
    if (!predios.length) {
      if (resumoEl) resumoEl.textContent = "Este cartão não possui edifícios verticais cadastrados.";
      listaEl.innerHTML = `
        <div class="p-6 text-center text-xs text-slate-500">
          Nenhum prédio mapeado dentro dos limites do Território ${Number(t.numero)}.
        </div>`;
      return;
    }

    const concluidos = predios.filter(p => p.trabalhadoNesteCiclo || p.ultimaDataConclusao).length;
    if (resumoEl) {
      resumoEl.textContent = `${predios.length} prédio(s) no cartão • ${concluidos} marcado(s) como trabalhado(s)`;
    }

    const podeMarcarPredio = t.statusReal === "OCUPADO" && (t.emMinhaPosse || (App.usuarioAtual && App.usuarioAtual.perfil === "ADMIN"));

    listaEl.innerHTML = pontosNumerados.map(item => {
      const p = item.predio;
      const concluido = Boolean(p.trabalhadoNesteCiclo || p.ultimaDataConclusao);
      const { interfoneBadge, tagsBadges, metaStr } = Utils.obterBadgesPredio(p);
      const pinClass = this.obterClassePinoPredio(p);

      const btnMarcarHtml = podeMarcarPredio
        ? `<button type="button" onclick="event.stopPropagation(); App.acaoAlternarPredioTrabalhado('${Utils.escapeHtml(p.idPredio)}', ${Number(t.numero)}, ${!concluido})" class="mt-2.5 w-full py-1.5 px-3 rounded-full text-[11px] font-semibold transition flex items-center justify-center gap-1.5 ${concluido ? "bg-[#e6f4ea] text-[#146c2e] border border-[#a8dab5]" : "bg-slate-100 hover:bg-[#d3e3fd] text-slate-700 hover:text-[#041e49]"}">
            <span>${concluido ? `✓ Trabalhado (${Utils.formatarDataBr(p.ultimaDataConclusao)}) — Desfazer` : "✓ Marcar Prédio como Trabalhado"}</span>
          </button>`
        : (concluido
          ? `<p class="mt-2 text-[11px] font-semibold text-[#146c2e]">✓ Trabalhado neste ciclo (${Utils.formatarDataBr(p.ultimaDataConclusao)})</p>`
          : "");

      return `
        <div id="card-predio-${Utils.escapeHtml(p.idPredio)}" onclick="MapaTerritorios.focarPredioNoModal('${Utils.escapeHtml(p.idPredio)}')" class="p-3 rounded-2xl border ${concluido ? "bg-[#f4fbf6] border-[#a8dab5]" : "bg-white border-slate-200 hover:border-slate-300"} cursor-pointer transition">
          <div class="flex items-start justify-between gap-2">
            <div class="flex items-start gap-2.5 min-w-0">
              <span class="predio-pin-marker ${pinClass} shrink-0 mt-0.5">${item.ordemPin}</span>
              <div class="min-w-0">
                <h5 class="text-xs font-bold text-slate-900 leading-snug truncate">${Utils.escapeHtml(p.nomeEdificio)}</h5>
                <p class="text-[11px] font-medium text-slate-600 mt-0.5">${Utils.escapeHtml(p.endereco)}</p>
                ${metaStr ? `<p class="text-[11px] text-slate-500 mt-0.5">${Utils.escapeHtml(metaStr)}</p>` : ""}
                ${p.referenciaComercial ? `<p class="text-[11px] text-slate-500 mt-0.5">📍 ${Utils.escapeHtml(p.referenciaComercial)}</p>` : ""}
              </div>
            </div>
          </div>

          <div class="mt-2 flex flex-wrap gap-1">
            <span class="px-2 py-0.5 text-[10px] font-semibold rounded-full ${interfoneBadge.cls}">${interfoneBadge.texto}</span>
            ${tagsBadges.map(b => `<span class="px-2 py-0.5 text-[10px] font-medium rounded-full ${b.cls}">${b.texto}</span>`).join("")}
          </div>

          ${btnMarcarHtml}
        </div>
      `;
    }).join("");
  },

  focarPredioNoModal(idPredio) {
    const info = this.modalMarkersPorId[idPredio];
    if (!info || !this.modalMap) return;
    this.modalMap.setView([info.lat, info.lng], 18, { animate: true });
    info.marker.openPopup();
  },

  fecharModalTerritorio() {
    clearTimeout(this._modalTimer);
    this.territorioModalAtual = null;
    const modal = document.getElementById("modal-mapa-territorio");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  },

  focarTerritorio(numero) {
    this.abrirModalTerritorio(numero);
  },

  obterCorStatus(t, naFilaTop5 = false) {
    if (t.emMinhaPosse) {
      return { borda: "#0b57d0", preenchimento: "#0b57d0" }; // Azul Google M3 (Em minha posse)
    }
    if (t.statusReal === "OCUPADO") {
      return { borda: "#b06000", preenchimento: "#f59e0b" }; // Âmbar (Ocupado)
    }
    if (t.statusReal === "RECENTE") {
      return { borda: "#64748b", preenchimento: "#94a3b8" }; // Neutro (Recente <= 120d)
    }
    if (naFilaTop5) {
      return { borda: "#146c2e", preenchimento: "#16a34a" }; // Verde Destaque (Na Fila Top 5)
    }
    return { borda: "#475569", preenchimento: "#cbd5e1" };   // Disponível aguardando fila
  }
};
