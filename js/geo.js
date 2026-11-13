/**
 * Geometria pura (sem DOM e sem Leaflet): parser WKT por parte, polo de inacessibilidade
 * (polylabel), ponto-em-polígono, numeração de quadras em serpentina e ID estável de quadra.
 * Usado pelo navegador (global `Geo`), pelos testes e por scripts/quadras/gerar-quadras.js.
 */
const Geo = {
  RAIO_TERRA_M: 6371008.8,

  /**
   * Converte WKT (Polygon / MultiPolygon, com ou sem Z) em partes no formato do Leaflet:
   * [[anelExterno, ...furos], ...], cada anel como lista de [lat, lng].
   * Cada parte de um MultiPolygon é um polígono independente (não um furo da primeira).
   */
  parseWktPartes(wkt) {
    if (!wkt || typeof wkt !== "string") return [];
    const texto = wkt.trim();
    const inicio = texto.indexOf("(");
    if (inicio < 0) return [];
    const multi = /^\s*(SRID=\d+;)?\s*MULTIPOLYGON/i.test(texto);
    const profundidadeAnel = multi ? 3 : 2;

    const partes = [];
    let parteAtual = null;
    let profundidade = 0;
    let inicioAnel = -1;

    for (let i = inicio; i < texto.length; i++) {
      const c = texto[i];
      if (c === "(") {
        profundidade++;
        if (profundidade === profundidadeAnel - 1) parteAtual = [];
        if (profundidade === profundidadeAnel) inicioAnel = i + 1;
      } else if (c === ")") {
        if (profundidade === profundidadeAnel && inicioAnel >= 0 && parteAtual) {
          const anel = Geo._lerAnelWkt(texto.slice(inicioAnel, i));
          // Um anel externo inválido descarta a parte inteira; furo inválido é apenas ignorado
          if (anel.length >= 3) parteAtual.push(anel);
          else if (!parteAtual.length) parteAtual = null;
          inicioAnel = -1;
        }
        if (profundidade === profundidadeAnel - 1) {
          if (parteAtual && parteAtual.length) partes.push(parteAtual);
          parteAtual = null;
        }
        profundidade--;
      }
    }
    return partes;
  },

  _lerAnelWkt(trecho) {
    const anel = [];
    for (const par of trecho.split(",")) {
      const nums = par.trim().split(/\s+/);
      if (nums.length < 2) continue;
      const lng = parseFloat(nums[0]);
      const lat = parseFloat(nums[1]);
      if (!isNaN(lat) && !isNaN(lng)) anel.push([lat, lng]);
    }
    return anel;
  },

  /** Área com sinal de um anel de pontos [x, y] (positiva no sentido anti-horário). */
  areaAnel(anel) {
    let soma = 0;
    for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
      soma += anel[j][0] * anel[i][1] - anel[i][0] * anel[j][1];
    }
    return soma / 2;
  },

  /** Área de um polígono [externo, ...furos] em unidades do plano. */
  areaPoligono(poligono) {
    let area = 0;
    poligono.forEach((anel, i) => {
      const a = Math.abs(Geo.areaAnel(anel));
      area += i === 0 ? a : -a;
    });
    return area;
  },

  pontoEmAnel(x, y, anel) {
    let dentro = false;
    for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
      const xi = anel[i][0], yi = anel[i][1];
      const xj = anel[j][0], yj = anel[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
    }
    return dentro;
  },

  /** Ponto dentro do anel externo e fora de todos os furos. */
  pontoEmPoligono(x, y, poligono) {
    if (!poligono.length || !Geo.pontoEmAnel(x, y, poligono[0])) return false;
    for (let i = 1; i < poligono.length; i++) {
      if (Geo.pontoEmAnel(x, y, poligono[i])) return false;
    }
    return true;
  },

  _distSegmentoQuadrada(px, py, a, b) {
    let x = a[0], y = a[1];
    let dx = b[0] - x, dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; }
      else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = px - x;
    dy = py - y;
    return dx * dx + dy * dy;
  },

  /** Distância do ponto à borda do polígono: positiva dentro, negativa fora. */
  distanciaAssinada(x, y, poligono) {
    let dentro = false;
    let minimo = Infinity;
    for (const anel of poligono) {
      for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
        const a = anel[i], b = anel[j];
        if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) dentro = !dentro;
        minimo = Math.min(minimo, Geo._distSegmentoQuadrada(x, y, a, b));
      }
    }
    return (dentro ? 1 : -1) * Math.sqrt(minimo);
  },

  /**
   * Polo de inacessibilidade (algoritmo "polylabel"): o ponto interno mais distante da borda.
   * Diferente do centroide, sempre cai dentro do polígono (formas em L, U, com furos).
   * @param poligono [externo, ...furos] com pontos [x, y] em unidades métricas
   * @param precisao tolerância na mesma unidade
   * @returns {{x:number, y:number, distancia:number}} distancia = raio do maior círculo inscrito
   */
  polylabel(poligono, precisao = 1) {
    const externo = poligono && poligono[0];
    if (!externo || externo.length < 3) return { x: 0, y: 0, distancia: 0 };

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of externo) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
    const largura = maxX - minX, altura = maxY - minY;
    const lado = Math.min(largura, altura);
    if (lado <= 0) return { x: minX, y: minY, distancia: 0 };

    const criar = (x, y, h) => {
      const d = Geo.distanciaAssinada(x, y, poligono);
      return { x, y, h, d, max: d + h * Math.SQRT2 };
    };

    const fila = [];
    const metade = lado / 2;
    for (let x = minX; x < maxX; x += lado) {
      for (let y = minY; y < maxY; y += lado) fila.push(criar(x + metade, y + metade, metade));
    }

    // Candidatos iniciais: centroide do anel externo e centro da caixa
    let melhor = criar(minX + largura / 2, minY + altura / 2, 0);
    const area = Geo.areaAnel(externo);
    if (area !== 0) {
      let cx = 0, cy = 0;
      for (let i = 0, j = externo.length - 1; i < externo.length; j = i++) {
        const f = externo[j][0] * externo[i][1] - externo[i][0] * externo[j][1];
        cx += (externo[j][0] + externo[i][0]) * f;
        cy += (externo[j][1] + externo[i][1]) * f;
      }
      const centroide = criar(cx / (6 * area), cy / (6 * area), 0);
      if (centroide.d > melhor.d) melhor = centroide;
    }

    while (fila.length) {
      // Retira a célula mais promissora (maior distância potencial)
      let idx = 0;
      for (let i = 1; i < fila.length; i++) if (fila[i].max > fila[idx].max) idx = i;
      const celula = fila[idx];
      fila[idx] = fila[fila.length - 1];
      fila.pop();

      if (celula.d > melhor.d) melhor = celula;
      if (celula.max - melhor.d <= precisao) continue;

      const h = celula.h / 2;
      fila.push(criar(celula.x - h, celula.y - h, h));
      fila.push(criar(celula.x + h, celula.y - h, h));
      fila.push(criar(celula.x - h, celula.y + h, h));
      fila.push(criar(celula.x + h, celula.y + h, h));
    }
    return { x: melhor.x, y: melhor.y, distancia: Math.max(0, melhor.d) };
  },

  /** Projeção métrica local (equirretangular) em torno de um ponto de referência. */
  criarProjecao(lat0, lng0) {
    const k = (Math.PI / 180) * Geo.RAIO_TERRA_M;
    const kx = k * Math.cos((lat0 * Math.PI) / 180);
    return {
      paraXY: (lat, lng) => [(lng - lng0) * kx, (lat - lat0) * k],
      paraLatLng: (x, y) => [lat0 + y / k, lng0 + x / kx]
    };
  },

  /**
   * Ponto de rótulo de um território/quadra dado em partes do Leaflet ([lat, lng]):
   * polo de inacessibilidade da maior parte, com o raio inscrito em metros.
   * @returns {{lat:number, lng:number, raioMetros:number, indiceParte:number}|null}
   */
  pontoRotuloLatLng(partes, precisaoMetros) {
    if (!Array.isArray(partes) || !partes.length) return null;
    const ref = partes[0][0][0];
    const proj = Geo.criarProjecao(ref[0], ref[1]);
    let maior = null, maiorArea = -1, indiceParte = 0;
    partes.forEach((parte, i) => {
      const poligono = parte.map(anel => anel.map(p => proj.paraXY(p[0], p[1])));
      const area = Geo.areaPoligono(poligono);
      if (area > maiorArea) { maiorArea = area; maior = poligono; indiceParte = i; }
    });
    if (!maior) return null;
    const precisao = precisaoMetros || Math.max(0.5, Math.sqrt(Math.max(maiorArea, 0)) / 100);
    const polo = Geo.polylabel(maior, precisao);
    const ll = proj.paraLatLng(polo.x, polo.y);
    return { lat: ll[0], lng: ll[1], raioMetros: polo.distancia, indiceParte, areaM2: maiorArea };
  },

  /**
   * Orientação dominante da malha: ângulo (rad, em [-45°, 45°)) das arestas tomadas módulo 90°,
   * ponderadas pelo comprimento. Malhas em xadrez giradas resultam no giro da grade.
   */
  orientacaoDominante(aneis) {
    let somaSen = 0, somaCos = 0;
    for (const anel of aneis) {
      for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
        const dx = anel[i][0] - anel[j][0], dy = anel[i][1] - anel[j][1];
        const comprimento = Math.hypot(dx, dy);
        if (!comprimento) continue;
        const angulo4 = 4 * Math.atan2(dy, dx);
        somaSen += comprimento * Math.sin(angulo4);
        somaCos += comprimento * Math.cos(angulo4);
      }
    }
    if (!somaSen && !somaCos) return 0;
    return Math.atan2(somaSen, somaCos) / 4;
  },

  /**
   * Numeração em serpentina: alinha a malha pela orientação dominante, agrupa as quadras em
   * fileiras de norte para sul e percorre oeste→leste, invertendo o sentido nas fileiras pares.
   * @param quadras lista de { x, y, anel } em metros (x,y = ponto de rótulo; anel = contorno externo)
   * @returns {number[]} numeros[i] = número (1..n) da quadra de índice i
   */
  numerarSerpentina(quadras) {
    const n = quadras.length;
    if (!n) return [];
    const angulo = Geo.orientacaoDominante(quadras.map(q => q.anel || []));
    const cos = Math.cos(-angulo), sen = Math.sin(-angulo);
    const girar = (x, y) => [x * cos - y * sen, x * sen + y * cos];

    const itens = quadras.map((q, indice) => {
      const [x, y] = girar(q.x, q.y);
      let minY = Infinity, maxY = -Infinity;
      for (const p of q.anel || []) {
        const yr = girar(p[0], p[1])[1];
        if (yr < minY) minY = yr;
        if (yr > maxY) maxY = yr;
      }
      return { indice, x, y, altura: maxY > minY ? maxY - minY : 0 };
    });

    const alturas = itens.map(i => i.altura).filter(a => a > 0).sort((a, b) => a - b);
    const alturaMediana = alturas.length ? alturas[Math.floor(alturas.length / 2)] : 0;
    const limiteQuebra = 0.5 * alturaMediana;

    // Norte → sul; desempate estável por x e índice para o resultado ser reproduzível
    itens.sort((a, b) => b.y - a.y || a.x - b.x || a.indice - b.indice);
    const fileiras = [];
    let fileira = null, somaY = 0;
    for (const item of itens) {
      // Compara com a média da fileira corrente (evita o efeito corrente de diferenças pequenas)
      if (!fileira || (somaY / fileira.length) - item.y > limiteQuebra) {
        fileira = [];
        somaY = 0;
        fileiras.push(fileira);
      }
      fileira.push(item);
      somaY += item.y;
    }

    const numeros = new Array(n);
    let proximo = 1;
    fileiras.forEach((linha, i) => {
      linha.sort((a, b) => a.x - b.x || a.indice - b.indice);
      if (i % 2 === 1) linha.reverse();
      for (const item of linha) numeros[item.indice] = proximo++;
    });
    return numeros;
  },

  /**
   * Identificador permanente de quadra: hash (FNV-1a) do ponto de rótulo numa grade de ~5 m.
   * Reexecuções que movam o ponto menos que a grade preservam o ID.
   */
  idQuadra(lat, lng) {
    const passo = 0.00005; // ≈ 5,5 m em latitude
    const chave = `${Math.round(lat / passo)}:${Math.round(lng / passo)}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < chave.length; i++) {
      h ^= chave.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return "Q" + h.toString(36).toUpperCase().padStart(7, "0");
  }
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = Geo;
}
