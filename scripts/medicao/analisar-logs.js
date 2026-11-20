#!/usr/bin/env node
/**
 * Spec 08, fase 0 — análise das linhas de medição do backend.
 *
 * Lê qualquer exportação/cópia do log do Apps Script e procura as linhas
 *   {"medicao":"requisicao","rota":...,"ms":...,"etapas":{...},"fontes":{...},"lock429":true,...}
 * Formatos aceitos (detectados sozinhos):
 *   - texto colado da página "Execuções" do Apps Script (uma ou várias linhas por entrada);
 *   - exportação JSON do Cloud Logging (array de entradas com textPayload/jsonPayload);
 *   - NDJSON (uma entrada JSON por linha).
 *
 * Uso:
 *   node scripts/medicao/analisar-logs.js <arquivo> [<arquivo>...] [--janela 08-11,15-17] [--json]
 *
 *   --janela  considera só as requisições cujo horário (Brasília) cai nas faixas dadas (hora inicial
 *             inclusive, final exclusive). Linhas sem horário reconhecido ficam de fora quando há janela.
 *   --json    imprime o resumo em JSON em vez da tabela.
 */
"use strict";
const fs = require("fs");

const ETAPAS = ["usuarios", "esperaLock", "dentroLock", "base", "prog", "auditoria"];
const FUSO_MIN = -180; // America/Sao_Paulo (sem horário de verão desde 2019)

// ---------------------------------------------------------------- extração

/** Extrai objetos JSON balanceados que começam em cada '{' de `texto` contendo "medicao". */
function extrairObjetosDeTexto(texto) {
  const achados = [];
  const re = /\{\s*"medicao"\s*:/g;
  let m;
  while ((m = re.exec(texto))) {
    const ini = m.index;
    let prof = 0, emStr = false, esc = false, fim = -1;
    for (let i = ini; i < texto.length; i++) {
      const c = texto[i];
      if (emStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') emStr = false;
        continue;
      }
      if (c === '"') emStr = true;
      else if (c === "{") prof++;
      else if (c === "}" && --prof === 0) { fim = i; break; }
    }
    if (fim < 0) continue;
    try {
      achados.push({ obj: JSON.parse(texto.slice(ini, fim + 1)), pos: ini, fim: fim + 1 });
      re.lastIndex = fim + 1;
    } catch (e) { /* trecho truncado: ignora */ }
  }
  return achados;
}

/** Converte um texto de horário em Date (ISO com fuso) ou em {h,m,s} local (sem data/fuso). */
function lerHorario(txt) {
  if (!txt) return null;
  const iso = /(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/.exec(txt);
  if (iso) {
    if (iso[5]) {
      const d = new Date(iso[0].replace(" ", "T"));
      if (!isNaN(d)) return { data: d };
    }
    return { local: { h: +iso[2], m: +iso[3], s: +iso[4] }, dia: iso[1] };
  }
  const hms = /\b(\d{1,2}):(\d{2}):(\d{2})\b/.exec(txt);
  if (hms && +hms[1] < 24) return { local: { h: +hms[1], m: +hms[2], s: +hms[3] } };
  return null;
}

/** Hora/minuto no horário de Brasília. */
function horaLocal(horario) {
  if (!horario) return null;
  if (horario.local) return horario.local;
  const t = new Date(horario.data.getTime() + FUSO_MIN * 60000);
  return { h: t.getUTCHours(), m: t.getUTCMinutes(), s: t.getUTCSeconds() };
}

function ehMedicaoRequisicao(o) {
  return o && typeof o === "object" && o.medicao === "requisicao" && typeof o.ms === "number";
}

/** Percorre JSON exportado (Cloud Logging ou outro) atrás de medições, herdando o timestamp da entrada. */
function varrerJson(no, horarioHerdado, saida) {
  if (Array.isArray(no)) { no.forEach(x => varrerJson(x, horarioHerdado, saida)); return; }
  if (typeof no === "string") {
    if (no.indexOf('"medicao"') >= 0) {
      for (const a of extrairObjetosDeTexto(no)) {
        if (ehMedicaoRequisicao(a.obj)) saida.push({ ...a.obj, _horario: horarioHerdado });
      }
    }
    return;
  }
  if (!no || typeof no !== "object") return;
  if (ehMedicaoRequisicao(no)) { saida.push({ ...no, _horario: horarioHerdado }); return; }
  const ts = no.timestamp || no.receiveTimestamp || no.time;
  const horario = (typeof ts === "string" && lerHorario(ts)) || horarioHerdado;
  for (const k of Object.keys(no)) varrerJson(no[k], horario, saida);
}

/** Texto livre: cada medição pega o último horário visto antes dela (mesma linha ou linhas acima). */
function varrerTexto(texto, saida) {
  const achados = extrairObjetosDeTexto(texto);
  let cursor = 0, ultimoHorario = null;
  for (const a of achados) {
    // procura horários no trecho entre a medição anterior e esta (sem olhar dentro do JSON)
    const trecho = texto.slice(cursor, a.pos);
    const linhas = trecho.split(/\r?\n/);
    for (const l of linhas) { const h = lerHorario(l); if (h) ultimoHorario = h; }
    cursor = a.fim;
    if (ehMedicaoRequisicao(a.obj)) saida.push({ ...a.obj, _horario: ultimoHorario });
  }
}

function extrairMedicoes(texto) {
  const saida = [];
  const limpo = texto.replace(/^﻿/, "");
  const t = limpo.trim();
  if (t.startsWith("[") || t.startsWith("{")) {
    try { varrerJson(JSON.parse(t), null, saida); return saida; } catch (e) { /* não é um JSON único */ }
    // NDJSON?
    const linhas = t.split(/\r?\n/).filter(Boolean);
    let ok = true;
    const tmp = [];
    for (const l of linhas) {
      try { varrerJson(JSON.parse(l), null, tmp); } catch (e) { ok = false; break; }
    }
    if (ok) { saida.push(...tmp); return saida; }
  }
  varrerTexto(limpo, saida);
  return saida;
}

// ---------------------------------------------------------------- estatística

function percentil(ordenados, p) {
  if (!ordenados.length) return null;
  const i = Math.min(ordenados.length - 1, Math.max(0, Math.ceil((p / 100) * ordenados.length) - 1));
  return ordenados[i];
}

function resumoNumeros(valores) {
  const v = valores.filter(x => typeof x === "number" && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const soma = v.reduce((a, b) => a + b, 0);
  return { n: v.length, media: Math.round(soma / v.length), p50: percentil(v, 50), p90: percentil(v, 90), p95: percentil(v, 95), max: v[v.length - 1], soma };
}

function parseJanela(txt) {
  if (!txt) return null;
  return txt.split(",").map(f => {
    const m = /^(\d{1,2})(?::(\d{2}))?-(\d{1,2})(?::(\d{2}))?$/.exec(f.trim());
    if (!m) throw new Error("Janela inválida: " + f + " (use p.ex. 08-11,15-17)");
    return { ini: +m[1] * 60 + (+m[2] || 0), fim: +m[3] * 60 + (+m[4] || 0) };
  });
}

function dentroDaJanela(med, janelas) {
  if (!janelas) return true;
  const h = horaLocal(med._horario);
  if (!h) return false;
  const min = h.h * 60 + h.m;
  return janelas.some(j => min >= j.ini && min < j.fim);
}

function analisar(medicoes, opcoes) {
  const janelas = opcoes && opcoes.janelas;
  const sel = medicoes.filter(m => dentroDaJanela(m, janelas));
  const r = {
    total: sel.length,
    ignoradasPelaJanela: medicoes.length - sel.length,
    semHorario: sel.filter(m => !m._horario).length,
    geral: resumoNumeros(sel.map(m => m.ms)),
    lock429: sel.filter(m => m.lock429).length,
    erro500: sel.filter(m => m.erro500).length,
    etapas: {},
    fontes: {},
    rotas: {},
    porHora: {},
    maisLentas: []
  };

  const somaTotal = r.geral.soma || 0;
  for (const e of ETAPAS) {
    const vals = sel.filter(m => m.etapas && typeof m.etapas[e] === "number").map(m => m.etapas[e]);
    const s = resumoNumeros(vals);
    s.fatiaDoTotal = somaTotal && s.n ? +(s.soma / somaTotal * 100).toFixed(1) : 0;
    r.etapas[e] = s;
  }
  // "outros" = tempo fora das etapas medidas (lógica da rota, serialização etc.)
  r.etapas.outros = resumoNumeros(sel.map(m => m.ms - ETAPAS.reduce((a, e) => a + ((m.etapas && m.etapas[e]) || 0), 0)));
  r.etapas.outros.fatiaDoTotal = somaTotal ? +(r.etapas.outros.soma / somaTotal * 100).toFixed(1) : 0;

  for (const m of sel) {
    for (const g of Object.keys(m.fontes || {})) {
      const alvo = r.fontes[g] = r.fontes[g] || {};
      for (const f of [].concat(m.fontes[g])) alvo[f] = (alvo[f] || 0) + 1;
    }
  }

  const porRota = {};
  for (const m of sel) (porRota[m.rota || "(sem rota)"] = porRota[m.rota || "(sem rota)"] || []).push(m);
  for (const rota of Object.keys(porRota)) {
    const lista = porRota[rota];
    const s = resumoNumeros(lista.map(m => m.ms));
    s.esperaLockP95 = percentil(lista.map(m => (m.etapas && m.etapas.esperaLock) || 0).sort((a, b) => a - b), 95);
    s.lock429 = lista.filter(m => m.lock429).length;
    s.erro500 = lista.filter(m => m.erro500).length;
    r.rotas[rota] = s;
  }

  for (const m of sel) {
    const h = horaLocal(m._horario);
    if (!h) continue;
    const k = String(h.h).padStart(2, "0") + "h";
    const b = r.porHora[k] = r.porHora[k] || { n: 0, lock429: 0, erro500: 0, _ms: [] };
    b.n++; if (m.lock429) b.lock429++; if (m.erro500) b.erro500++; b._ms.push(m.ms);
  }
  for (const k of Object.keys(r.porHora)) {
    const b = r.porHora[k]; const s = resumoNumeros(b._ms);
    b.p50 = s.p50; b.p95 = s.p95; b.max = s.max; delete b._ms;
  }

  r.maisLentas = sel.slice().sort((a, b) => b.ms - a.ms).slice(0, (opcoes && opcoes.top) || 10).map(m => {
    const h = horaLocal(m._horario);
    return {
      horario: h ? [h.h, h.m, h.s].map(x => String(x).padStart(2, "0")).join(":") : null,
      rota: m.rota, ms: m.ms, etapas: m.etapas || {}, fontes: m.fontes, lock429: !!m.lock429, erro500: !!m.erro500
    };
  });
  return r;
}

// ---------------------------------------------------------------- saída

function tabela(cab, linhas) {
  const larg = cab.map((c, i) => Math.max(String(c).length, ...linhas.map(l => String(l[i] == null ? "–" : l[i]).length)));
  const fmt = l => l.map((c, i) => {
    const s = String(c == null ? "–" : c);
    return i === 0 ? s.padEnd(larg[i]) : s.padStart(larg[i]);
  }).join("  ");
  return [fmt(cab), larg.map(n => "-".repeat(n)).join("  "), ...linhas.map(fmt)].join("\n");
}

function pct(a, b) { return b ? (a / b * 100).toFixed(1) + "%" : "–"; }

function formatarRelatorio(r) {
  const out = [];
  out.push("MEDIÇÃO POR REQUISIÇÃO — spec 08, fase 0");
  out.push(`Requisições: ${r.total}` + (r.ignoradasPelaJanela ? ` (fora da janela: ${r.ignoradasPelaJanela})` : "") + (r.semHorario ? ` · sem horário: ${r.semHorario}` : ""));
  if (!r.total) { out.push("\nNenhuma linha {\"medicao\":\"requisicao\"} encontrada."); return out.join("\n"); }
  const g = r.geral;
  out.push(`Tempo total (ms): média ${g.media} · p50 ${g.p50} · p90 ${g.p90} · p95 ${g.p95} · máx ${g.max}`);
  out.push(`lock429: ${r.lock429} (${pct(r.lock429, r.total)}) · erro500: ${r.erro500} (${pct(r.erro500, r.total)})`);

  out.push("\nETAPAS (ms; n = requisições que passaram pela etapa; fatia = % do tempo total somado)");
  out.push(tabela(["etapa", "n", "média", "p50", "p95", "máx", "fatia"],
    [...ETAPAS, "outros"].map(e => { const s = r.etapas[e]; return [e, s.n, s.media, s.p50, s.p95, s.max, s.n ? s.fatiaDoTotal + "%" : null]; })));

  const grupos = Object.keys(r.fontes);
  if (grupos.length) {
    out.push("\nFONTES DAS LEITURAS (cache = CacheService; planilha = leu a aba; fresco = leitura sem cache nas transações)");
    const tipos = ["cache", "planilha", "fresco"];
    out.push(tabela(["grupo", ...tipos, "% cache"], grupos.map(gr => {
      const f = r.fontes[gr]; const tot = Object.values(f).reduce((a, b) => a + b, 0);
      return [gr, ...tipos.map(t => f[t] || 0), pct(f.cache || 0, tot)];
    })));
  }

  out.push("\nPOR ROTA (ms)");
  const rotas = Object.keys(r.rotas).sort((a, b) => r.rotas[b].n - r.rotas[a].n);
  out.push(tabela(["rota", "n", "p50", "p95", "máx", "esperaLock p95", "lock429", "erro500"],
    rotas.map(k => { const s = r.rotas[k]; return [k, s.n, s.p50, s.p95, s.max, s.esperaLockP95, s.lock429, s.erro500]; })));

  const horas = Object.keys(r.porHora).sort();
  if (horas.length) {
    out.push("\nPOR HORA (Brasília)");
    out.push(tabela(["hora", "n", "p50", "p95", "máx", "lock429", "erro500"],
      horas.map(k => { const b = r.porHora[k]; return [k, b.n, b.p50, b.p95, b.max, b.lock429, b.erro500]; })));
  }

  out.push(`\nMAIS LENTAS (top ${r.maisLentas.length})`);
  out.push(tabela(["horário", "rota", "ms", "etapas", "flags"], r.maisLentas.map(m => [
    m.horario, m.rota, m.ms,
    Object.keys(m.etapas).map(e => `${e}=${m.etapas[e]}`).join(" ") || null,
    [m.lock429 && "lock429", m.erro500 && "erro500"].filter(Boolean).join(",") || null
  ])));
  return out.join("\n");
}

// ---------------------------------------------------------------- CLI

function main(argv) {
  const arquivos = [], opcoes = { top: 10 };
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--janela") opcoes.janelas = parseJanela(argv[++i]);
    else if (a === "--top") opcoes.top = +argv[++i] || 10;
    else if (a === "-h" || a === "--help") { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]); return 0; }
    else arquivos.push(a);
  }
  if (!arquivos.length) { console.error("Uso: node scripts/medicao/analisar-logs.js <arquivo> [...] [--janela 08-11,15-17] [--top N] [--json]"); return 2; }
  const medicoes = [];
  for (const f of arquivos) medicoes.push(...extrairMedicoes(fs.readFileSync(f, "utf8")));
  const r = analisar(medicoes, opcoes);
  console.log(json ? JSON.stringify(r, null, 2) : formatarRelatorio(r));
  return r.total ? 0 : 1;
}

module.exports = { extrairMedicoes, analisar, formatarRelatorio, parseJanela, percentil };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
