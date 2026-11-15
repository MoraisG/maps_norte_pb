/**
 * Fila de escritas de progresso (spec 06, fase 4).
 *
 * Marcações de prédio, apartamentos e quadras passam por aqui. Com rede, vão direto ao servidor.
 * Sem rede (ou em falha de comunicação), ficam gravadas no aparelho e são enviadas depois, na
 * ordem em que foram feitas.
 *
 * - Fusão por chave: essas rotas mandam o estado completo (lista de apartamentos, de alfinetes ou
 *   o marcado/desmarcado do prédio), então só a marcação mais recente de cada chave precisa ficar.
 *   Reenviar é seguro pelo mesmo motivo.
 * - Recusa do servidor (ex.: território devolvido ou com outro dirigente -> 403): o item não é
 *   descartado em silêncio; fica marcado como "não enviado", com o motivo, até o usuário ver.
 * - Solicitar e devolver NÃO passam pela fila: dependem da fila de territórios no servidor.
 */
const FilaEscrita = {
  MAX_TENTATIVAS: 8,          // falhas de comunicação seguidas antes de dar o item como não enviado
  _descarga: null,
  _aoMudar: null,

  /** Chamado sempre que a fila muda (para a tela atualizar o contador). */
  definirOuvinte(fn) {
    this._aoMudar = typeof fn === "function" ? fn : null;
  },

  _avisar() {
    if (this._aoMudar) {
      try { this._aoMudar(); } catch (e) {}
    }
  },

  _semRede() {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  },

  async _itens(email) {
    const dono = String(email || "").toLowerCase();
    return (await Armazenamento.filaListar()).filter(i => String(i.email || "").toLowerCase() === dono);
  },

  /**
   * Envia agora ou guarda para depois. Devolve a resposta do servidor ou { enfileirado: true }.
   * Recusa do servidor (erro com código) é lançada para quem chamou desfazer a marcação.
   */
  async enviar(rota, payload, chave, email) {
    const pendentes = (await this._itens(email)).some(i => i.chave === chave && !i.recusado);
    // Se já há marcação desta chave esperando, a nova entra na fila também (mantém a ordem)
    if (!pendentes && !this._semRede()) {
      try {
        return await ApiClient.request(rota, payload);
      } catch (erro) {
        if (!erro || !erro.semRede) throw erro;
      }
    }
    await this.enfileirar(rota, payload, chave, email);
    return { enfileirado: true };
  },

  async enfileirar(rota, payload, chave, email) {
    for (const item of await this._itens(email)) {
      if (item.chave === chave) await Armazenamento.filaRemover(item.id);
    }
    await Armazenamento.filaAdicionar({
      rota, payload, chave,
      email: String(email || "").toLowerCase(),
      criadoEm: Date.now(),
      tentativas: 0
    });
    this._avisar();
  },

  /** { pendentes, recusados } da conta informada. */
  async contar(email) {
    const itens = await this._itens(email);
    const recusados = itens.filter(i => i.recusado).length;
    return { pendentes: itens.length - recusados, recusados };
  },

  async listarRecusados(email) {
    return (await this._itens(email)).filter(i => i.recusado);
  },

  async descartarRecusados(email) {
    for (const item of await this.listarRecusados(email)) await Armazenamento.filaRemover(item.id);
    this._avisar();
  },

  /**
   * Envia o que estiver pendente, em ordem. Uma descarga por vez (chamadas simultâneas
   * compartilham a mesma). Devolve { enviados, recusados, restantes, precisaLogin }.
   */
  descarregar(email) {
    if (!this._descarga) {
      this._descarga = this._descarregar(email).finally(() => { this._descarga = null; });
    }
    return this._descarga;
  },

  async _descarregar(email) {
    const resultado = { enviados: 0, recusados: 0, restantes: 0, precisaLogin: false };
    const pendentes = (await this._itens(email)).filter(i => !i.recusado);
    if (!pendentes.length) return resultado;

    if (this._semRede()) {
      resultado.restantes = pendentes.length;
      return resultado;
    }
    if (!ApiClient.obterTokenSessao()) {
      resultado.restantes = pendentes.length;
      resultado.precisaLogin = true;
      return resultado;
    }

    for (let i = 0; i < pendentes.length; i++) {
      const item = pendentes[i];
      try {
        await ApiClient.request(item.rota, item.payload);
        await Armazenamento.filaRemover(item.id);
        resultado.enviados++;
      } catch (erro) {
        if (erro && erro.semRede) {
          // Rede caiu de novo: para aqui e tenta mais tarde (a ordem é preservada)
          item.tentativas = Number(item.tentativas || 0) + 1;
          if (item.tentativas >= this.MAX_TENTATIVAS) {
            item.recusado = { motivo: "Não foi possível enviar depois de várias tentativas.", em: Date.now() };
            resultado.recusados++;
          }
          await Armazenamento.filaAtualizar(item);
          if (!item.recusado) {
            resultado.restantes = pendentes.length - i;
            break;
          }
        } else if (erro && erro.codigo === 401) {
          // Sessão vencida: mantém tudo na fila; o envio continua depois do novo login
          resultado.restantes = pendentes.length - i;
          resultado.precisaLogin = true;
          break;
        } else {
          item.recusado = { motivo: String((erro && erro.message) || "Recusado pelo servidor."), em: Date.now() };
          await Armazenamento.filaAtualizar(item);
          resultado.recusados++;
        }
      }
    }
    this._avisar();
    return resultado;
  }
};

if (typeof module !== "undefined" && module.exports) module.exports = FilaEscrita;
