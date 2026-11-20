#!/usr/bin/env node
/**
 * Spec 05 — corrige numeração, rótulo e posição de quadras sem regerar a malha do OSM.
 * Grava o ajuste em scripts/quadras/ajustes-quadras.json e atualiza quadras.geojson na hora.
 * Depois: conferir no app (modo local), commitar os dois arquivos e abrir PR (subir ?v= do site).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Ajustes = require("./ajustes.js");

const RAIZ = path.resolve(__dirname, "..", "..");

const AJUDA = `
Ajustes manuais de quadras (spec 05)

  Ver as quadras de um território:
    node scripts/quadras/ajustar-quadras.js --terr=12 --listar

  Ajustar a quadra que hoje aparece com o número 3 no território 12:
    --terr=12 --quadra=3 --numero=5          muda o número (o rótulo acompanha)
    --terr=12 --quadra=3 --rotulo=3A         muda só o texto exibido no mapa
    --terr=12 --quadra=3 --posicao=-26.2301,-52.6712   move o rótulo (lat,lng)
    --terr=12 --quadra=3 --ocultar           não desenha a quadra (canteiro, rotatória, lasca)
    --terr=12 --quadra=3 --obs="texto"       anotação (só no arquivo de ajustes)
    --terr=12 --quadra=3 --desfazer          remove o ajuste e volta ao que o gerador fez

  Trocar dois números de lugar:
    --terr=12 --trocar=3,5

  Quadra oculta (não tem mais número visível): use o ID mostrado em --listar
    --terr=12 --id=Q12H3V9T --mostrar        (ou --desfazer)

  Só reaplicar tudo (ex.: depois de editar ajustes-quadras.json à mão):
    node scripts/quadras/ajustar-quadras.js --aplicar

  Opções gerais: --quadras=caminho.geojson  --ajustes=caminho.json
`;

function lerArgumentos(argv) {
  const op = {};
  for (const a of argv) {
    const i = a.indexOf("=");
    const chave = (i >= 0 ? a.slice(0, i) : a).replace(/^--/, "");
    op[chave] = i >= 0 ? a.slice(i + 1) : true;
  }
  return op;
}

function executar(argv, saidaLog) {
  const log = saidaLog || console.log;
  const op = lerArgumentos(argv);
  if (op.ajuda || op.h || !argv.length) { log(AJUDA); return 0; }

  const arqQuadras = path.resolve(op.quadras || path.join(RAIZ, "quadras.geojson"));
  const arqAjustes = path.resolve(op.ajustes || Ajustes.ARQUIVO_AJUSTES);
  const colecao = JSON.parse(fs.readFileSync(arqQuadras, "utf8"));
  const dados = Ajustes.lerAjustes(arqAjustes);
  const terr = op.terr !== undefined ? Number(op.terr) : null;
  const doTerr = () => colecao.features.filter(f => Number(f.properties.NUM_TERR) === terr);
  const exigirTerr = () => { if (!Number.isFinite(terr)) throw new Error("Informe o território: --terr=12"); };

  if (op.listar) {
    exigirTerr();
    const lista = doTerr().sort((a, b) => a.properties.NUM_QUADRA - b.properties.NUM_QUADRA);
    if (!lista.length) throw new Error(`O território ${terr} não tem quadras em quadras.geojson (rural?).`);
    log(`Território ${terr}: ${lista.length} quadra(s)\n  Nº   Rótulo  ID            Rótulo em (lat,lng)       Ajuste`);
    for (const f of lista) {
      const p = f.properties;
      const aj = dados.ajustes[p.ID_QUADRA];
      log(`  ${String(p.NUM_QUADRA).padStart(3)}  ${String(p.ROTULO).padEnd(6)}  ${p.ID_QUADRA.padEnd(12)}  ${String(p.LABEL_LAT).padEnd(10)},${String(p.LABEL_LNG).padEnd(11)}  ${aj ? (p.OCULTA ? "OCULTA " : "") + "ajustada" + (p._GER ? ` (gerador: nº ${p._GER.n})` : "") + (aj.obs ? ` — ${aj.obs}` : "") : ""}`);
    }
    return 0;
  }

  const achar = numero => {
    const f = doTerr().find(x => !x.properties.OCULTA && Number(x.properties.NUM_QUADRA) === Number(numero));
    if (!f) throw new Error(`Território ${terr}: não há quadra visível com o número ${numero} (veja --listar).`);
    return f.properties.ID_QUADRA;
  };
  const ajusteDe = id => (dados.ajustes[id] = dados.ajustes[id] || { terr });

  if (op.trocar) {
    exigirTerr();
    const [n1, n2] = String(op.trocar).split(",").map(Number);
    if (!Number.isFinite(n1) || !Number.isFinite(n2)) throw new Error("Use --trocar=3,5");
    const id1 = achar(n1), id2 = achar(n2);
    ajusteDe(id1).numero = n2; delete dados.ajustes[id1].rotulo;
    ajusteDe(id2).numero = n1; delete dados.ajustes[id2].rotulo;
    log(`Território ${terr}: quadras ${n1} e ${n2} trocadas.`);
  } else if (!op.aplicar) {
    exigirTerr();
    let id = op.id ? String(op.id) : null;
    if (id) {
      const f = colecao.features.find(x => x.properties.ID_QUADRA === id);
      if (!f || Number(f.properties.NUM_TERR) !== terr) throw new Error(`Quadra ${id} não encontrada no território ${terr}.`);
    } else if (op.quadra !== undefined) {
      id = achar(op.quadra);
    } else {
      throw new Error("Diga qual quadra: --quadra=3 (número atual) ou --id=Q... (veja --listar).");
    }

    if (op.desfazer) {
      delete dados.ajustes[id];
      log(`Ajuste da quadra ${id} removido.`);
    } else {
      const a = ajusteDe(id);
      let mudou = false;
      if (op.numero !== undefined) {
        const n = Number(op.numero);
        if (!Number.isInteger(n) || n < 1) throw new Error("--numero deve ser um inteiro positivo.");
        a.numero = n; mudou = true;
      }
      if (op.rotulo !== undefined) {
        const r = String(op.rotulo).trim();
        if (!r || r.length > 8) throw new Error("--rotulo deve ter de 1 a 8 caracteres.");
        a.rotulo = r; mudou = true;
      }
      if (op.posicao !== undefined) {
        const [lat, lng] = String(op.posicao).split(",").map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error("Use --posicao=lat,lng (ex.: -26.2301,-52.6712).");
        a.lat = lat; a.lng = lng; mudou = true;
      }
      if (op.ocultar) { a.oculta = true; mudou = true; }
      if (op.mostrar) { delete a.oculta; mudou = true; }
      if (op.obs !== undefined) { a.obs = String(op.obs).slice(0, 200); mudou = true; }
      if (!mudou) throw new Error("Nada a mudar: use --numero, --rotulo, --posicao, --ocultar, --mostrar, --obs ou --desfazer.");
      if (Object.keys(a).length === 1) delete dados.ajustes[id];   // só sobrou "terr"
      log(`Quadra ${id} do território ${terr} ajustada.`);
    }
  }

  const r = Ajustes.aplicarAjustes(colecao.features, dados);
  Ajustes.gravarAjustes(dados, arqAjustes);
  fs.writeFileSync(arqQuadras, Ajustes.serializarColecao(Object.assign({}, colecao, { features: r.features })));
  log(`quadras.geojson atualizado (${r.aplicados} ajuste(s) aplicado(s)).`);
  for (const a of r.avisos) log("  Aviso: " + a);
  log("Próximo passo: conferir no app (modo local), commitar quadras.geojson e ajustes-quadras.json e subir o ?v= do site.");
  return r.avisos.length ? 1 : 0;
}

module.exports = { executar };

if (require.main === module) {
  try {
    process.exitCode = executar(process.argv.slice(2));
  } catch (e) {
    console.error("Erro: " + e.message);
    process.exitCode = 2;
  }
}
