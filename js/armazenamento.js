/**
 * Armazenamento local do app (IndexedDB) — spec 06.
 *
 * Guarda no aparelho o que permite abrir o app na hora e trabalhar sem sinal:
 *   - "kv":   pares chave/valor (retrato da última listagem, polígonos, dono dos dados);
 *   - "fila": escritas feitas sem conexão, aguardando envio (js/fila.js).
 *
 * Regras de privacidade:
 *   - os dados pertencem a UMA conta por aparelho: entrar com outra conta apaga tudo (definirDono);
 *   - o logout explícito apaga tudo (limparTudo);
 *   - o token de sessão NUNCA é gravado aqui (continua só em sessionStorage).
 *
 * Se o IndexedDB não existir ou falhar (modo privado de alguns navegadores), cai para a memória:
 * o app continua funcionando, apenas sem lembrar nada entre aberturas.
 */
const Armazenamento = {
  NOME_BANCO: "territorios-app",
  VERSAO_BANCO: 1,
  _bancoPromessa: null,
  _memoria: { kv: new Map(), fila: new Map(), proximoId: 1 },
  _usarMemoria: false,

  _abrir() {
    if (this._usarMemoria) return Promise.resolve(null);
    if (!this._bancoPromessa) {
      this._bancoPromessa = new Promise(resolve => {
        const desistir = () => { this._usarMemoria = true; resolve(null); };
        try {
          const fabrica = typeof indexedDB !== "undefined" ? indexedDB : null;
          if (!fabrica) return desistir();
          const pedido = fabrica.open(this.NOME_BANCO, this.VERSAO_BANCO);
          pedido.onupgradeneeded = () => {
            const banco = pedido.result;
            if (!banco.objectStoreNames.contains("kv")) banco.createObjectStore("kv");
            if (!banco.objectStoreNames.contains("fila")) banco.createObjectStore("fila", { keyPath: "id", autoIncrement: true });
          };
          pedido.onsuccess = () => {
            const banco = pedido.result;
            // Outra aba abriu uma versão mais nova do banco: solta a conexão antiga
            banco.onversionchange = () => { banco.close(); this._bancoPromessa = null; };
            resolve(banco);
          };
          pedido.onerror = desistir;
          pedido.onblocked = desistir;
        } catch (e) {
          desistir();
        }
      });
    }
    return this._bancoPromessa;
  },

  /** Executa uma operação em um repositório e devolve o resultado do pedido. */
  async _operar(repositorio, modo, acao) {
    const banco = await this._abrir();
    if (!banco) return undefined;
    return new Promise((resolve, reject) => {
      let resultado;
      try {
        const transacao = banco.transaction(repositorio, modo);
        const pedido = acao(transacao.objectStore(repositorio));
        if (pedido) pedido.onsuccess = () => { resultado = pedido.result; };
        transacao.oncomplete = () => resolve(resultado);
        transacao.onerror = () => reject(transacao.error);
        transacao.onabort = () => reject(transacao.error);
      } catch (e) {
        reject(e);
      }
    });
  },

  // ----------------------------------------------------------------------------------------
  // Chave/valor
  // ----------------------------------------------------------------------------------------
  async ler(chave) {
    try {
      const banco = await this._abrir();
      if (!banco) return this._memoria.kv.has(chave) ? this._memoria.kv.get(chave) : null;
      const valor = await this._operar("kv", "readonly", r => r.get(chave));
      return valor === undefined ? null : valor;
    } catch (e) {
      return null;
    }
  },

  async gravar(chave, valor) {
    try {
      const banco = await this._abrir();
      if (!banco) { this._memoria.kv.set(chave, valor); return true; }
      await this._operar("kv", "readwrite", r => r.put(valor, chave));
      return true;
    } catch (e) {
      return false;   // cota cheia ou banco indisponível: o app segue sem a cópia local
    }
  },

  async remover(chave) {
    try {
      const banco = await this._abrir();
      if (!banco) { this._memoria.kv.delete(chave); return; }
      await this._operar("kv", "readwrite", r => r.delete(chave));
    } catch (e) {}
  },

  // ----------------------------------------------------------------------------------------
  // Fila de escritas pendentes
  // ----------------------------------------------------------------------------------------
  async filaAdicionar(item) {
    const banco = await this._abrir().catch(() => null);
    if (!banco) {
      const id = this._memoria.proximoId++;
      this._memoria.fila.set(id, Object.assign({}, item, { id }));
      return id;
    }
    const copia = Object.assign({}, item);
    delete copia.id;
    return this._operar("fila", "readwrite", r => r.add(copia));
  },

  /** Itens em ordem de chegada. */
  async filaListar() {
    try {
      const banco = await this._abrir();
      if (!banco) return Array.from(this._memoria.fila.values()).sort((a, b) => a.id - b.id);
      return (await this._operar("fila", "readonly", r => r.getAll())) || [];
    } catch (e) {
      return [];
    }
  },

  async filaAtualizar(item) {
    try {
      const banco = await this._abrir();
      if (!banco) { this._memoria.fila.set(item.id, Object.assign({}, item)); return; }
      await this._operar("fila", "readwrite", r => r.put(item));
    } catch (e) {}
  },

  async filaRemover(id) {
    try {
      const banco = await this._abrir();
      if (!banco) { this._memoria.fila.delete(id); return; }
      await this._operar("fila", "readwrite", r => r.delete(id));
    } catch (e) {}
  },

  // ----------------------------------------------------------------------------------------
  // Dono dos dados e limpeza
  // ----------------------------------------------------------------------------------------
  async limparTudo() {
    this._memoria.kv.clear();
    this._memoria.fila.clear();
    try {
      const banco = await this._abrir();
      if (!banco) return;
      await this._operar("kv", "readwrite", r => r.clear());
      await this._operar("fila", "readwrite", r => r.clear());
    } catch (e) {}
  },

  /**
   * Declara quem é o dono dos dados locais. Se havia dados de outra conta, apaga tudo antes.
   * Devolve true quando houve limpeza (troca de conta neste aparelho).
   */
  async definirDono(email) {
    const novo = String(email || "").toLowerCase().trim();
    const atual = await this.ler("dono");
    const trocou = Boolean(atual && atual !== novo);
    if (trocou) await this.limparTudo();
    if (atual !== novo || trocou) await this.gravar("dono", novo);
    return trocou;
  },

  async obterDono() {
    return (await this.ler("dono")) || "";
  }
};

if (typeof module !== "undefined" && module.exports) module.exports = Armazenamento;
