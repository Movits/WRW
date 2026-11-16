// Relatório e ritmo do exame de produção (scripts/checar-producao.mjs).
//
// Módulo PURO: sem mysql2, dotenv ou node:fs, sem process.env, sem efeito de topo,
// para o teste (server/exame-de-producao.test.ts) provar as regras sem I/O:
// - exceção no meio, limpeza com erro, ALERTA e LIMITE (429 persistente) REPROVAM;
//   o exame antigo imprimia "produção saudável" com código 0 depois de uma exceção;
// - PULADO é prefixo próprio, contado à parte e repetido no resumo como bloco NÃO
//   PROVADO, para "passou" nunca ser confundido com "não foi testado";
// - o relatório nunca imprime valor vindo do servidor (nome, e-mail, texto de
//   usuária): só contagens, status HTTP, nomes de chaves e literais do exame. A
//   saída é colada em PR pública.

export const PREFIXO = {
  ok: "OK    ",
  falha: "FALHA ",
  pulado: "PULADO",
  alerta: "ALERTA",
  limite: "LIMITE",
  info: "INFO  ",
  excecao: "EXCECAO",
  limpeza: "LIMPEZA COM ERRO",
};

const REPROVAM = new Set(["falha", "alerta", "limite", "excecao", "limpeza"]);

export class Relatorio {
  constructor() {
    this.linhas = [];
    this.pulados = [];
    this.houveExcecao = false;
    this.houveLimite = false;
    this.houveErroDeLimpeza = false;
  }

  #linha(tipo, nome, extra = "") {
    const texto = `${PREFIXO[tipo]} ${nome}${extra ? " | " + extra : ""}`;
    this.linhas.push({ tipo, nome, extra, texto });
    return texto;
  }

  /** Checagem comum: OK quando `condicao` é verdadeira, FALHA quando não. Devolve a condição. */
  ok(nome, condicao, extra = "") {
    if (condicao) this.#linha("ok", nome, extra);
    else this.#linha("falha", nome, extra);
    return Boolean(condicao);
  }

  falha(nome, extra = "") { this.#linha("falha", nome, extra); return false; }

  /** Não foi possível provar: conta à parte e aparece no resumo como NÃO PROVADO. */
  pulado(nome, motivo) { this.pulados.push(nome); this.#linha("pulado", nome, motivo); return false; }

  /** Funcionou pela metade e alguém precisa olhar: reprova. */
  alerta(nome, extra) { this.#linha("alerta", nome, extra); return false; }

  /** 429 que persistiu: o exame fica incompleto e reprova. */
  limite(nome, extra = "") { this.houveLimite = true; this.#linha("limite", nome, extra); return false; }

  info(texto) { this.#linha("info", texto); }

  /**
   * Exceção que derrubou o exame.
   *
   * Em 09/09 o exame parou em 58 OK com a mensagem "exame interrompido por
   * exceção: investigue antes de seguir" e MAIS NADA: nem o erro, nem onde. Com
   * a mensagem cortada em 200 caracteres e sem pilha, não havia o que investigar.
   *
   * Agora a linha carrega o tipo do erro, a mensagem inteira, o código quando
   * existe (ECONNRESET, ETIMEDOUT, ER_*) e a ÚLTIMA checagem que o exame tinha
   * anunciado antes de morrer — que é a resposta prática para "parou onde?". A
   * pilha vai em linhas próprias logo abaixo.
   *
   * Nada aqui imprime valor vindo do servidor: só o texto do erro e nomes de
   * checagem, que são literais deste repositório.
   */
  excecao(erro) {
    this.houveExcecao = true;
    const tipo = erro && erro.name ? erro.name : "Erro";
    const mensagem = String(erro && erro.message ? erro.message : erro);
    const codigo = erro && erro.code ? ` [${erro.code}]` : "";
    const ultima = this.ultimaChecagem();
    const onde = ultima ? ` | parou depois de: ${ultima}` : " | parou antes da primeira checagem";
    this.#linha("excecao", `${tipo}${codigo}: ${mensagem}${onde}`);
    const pilha = erro && typeof erro.stack === "string" ? erro.stack.split("\n").slice(1, 6) : [];
    for (const quadro of pilha) this.#linha("excecao", `  ${quadro.trim()}`);
  }

  /** Nome da última checagem anunciada, para situar a exceção. */
  ultimaChecagem() {
    for (let i = this.linhas.length - 1; i >= 0; i--) {
      const l = this.linhas[i];
      if (l.tipo === "excecao") continue;
      return l.nome;
    }
    return null;
  }

  limpezaComErro(texto) { this.houveErroDeLimpeza = true; this.#linha("limpeza", texto); }

  /** Checagens que não puderam rodar porque algo anterior faltou (ex.: sem sessão). */
  naoExecutada(nome, motivo) { this.#linha("falha", nome, `NÃO EXECUTADA (${motivo})`); return false; }

  contagens() {
    const c = { ok: 0, falhas: 0, pulados: 0 };
    for (const l of this.linhas) {
      if (l.tipo === "ok") c.ok++;
      else if (l.tipo === "pulado") c.pulados++;
      else if (REPROVAM.has(l.tipo)) c.falhas++;
    }
    return c;
  }

  codigoDeSaida() {
    const { falhas } = this.contagens();
    return falhas > 0 || this.houveExcecao || this.houveLimite || this.houveErroDeLimpeza ? 1 : 0;
  }

  /** A última linha do exame; "produção saudável" só sem nada reprovando. */
  resumo() {
    const { ok, falhas, pulados } = this.contagens();
    let veredito;
    if (this.houveExcecao) veredito = "exame interrompido por exceção: investigue antes de seguir";
    else if (this.houveLimite) veredito = "exame incompleto por limite de requisições: repita em um minuto";
    else if (this.houveErroDeLimpeza) veredito = "limpeza incompleta: há dado do exame sobrando em produção";
    else if (falhas > 0) veredito = "investigue as FALHAs antes de seguir";
    else veredito = "produção saudável";
    const naoProvado = pulados > 0 ? ` | NÃO PROVADO (${pulados}): ${this.pulados.join("; ")}` : "";
    return `${ok} OK, ${falhas} falha(s), ${pulados} pulado(s) | ${veredito}${naoProvado}`;
  }

  texto() {
    return this.linhas.map(l => l.texto).join("\n") + "\n\n" + this.resumo();
  }
}

/**
 * Julga uma resposta do cliente tRPC do exame ({ status, dado, erro, codigo }).
 * Exige status 200 ANTES de olhar o conteúdo: o exame antigo aceitava "lista vazia"
 * vinda de um 401/403/429, e isolamento passava com o servidor quebrado.
 *
 * Devolve { ok, motivo, detalhe }:
 *   motivo "limite"    -> 429 (o chamador decide retentar ou marcar LIMITE)
 *   motivo "status"    -> outro status que não 200
 *   motivo "zod"       -> 400: o EXAME chamou errado, não a produção
 *   motivo "predicado" -> 200 mas o conteúdo não satisfez
 *   motivo ""          -> ok
 * `detalhe` traz só status, código do tRPC e no máximo 40 caracteres da mensagem
 * de erro do servidor (mensagens são texto do código, não dado de usuária).
 */
export function avaliar(resposta, predicado = () => true) {
  const status = resposta && resposta.status;
  if (status === 429) return { ok: false, motivo: "limite", detalhe: "status 429" };
  if (status === 400) return { ok: false, motivo: "zod", detalhe: `input do exame inválido: ${resumirErro(resposta)}` };
  if (status !== 200) return { ok: false, motivo: "status", detalhe: `status ${status}${resumirErro(resposta, " ")}` };
  if (resposta.erro) return { ok: false, motivo: "status", detalhe: `200 com erro no envelope: ${resumirErro(resposta)}` };
  try {
    const resultado = predicado(resposta.dado);
    return resultado ? { ok: true, motivo: "", detalhe: "" } : { ok: false, motivo: "predicado", detalhe: "" };
  } catch (erro) {
    return { ok: false, motivo: "predicado", detalhe: `predicado lançou: ${String(erro && erro.message || erro).slice(0, 40)}` };
  }
}

/** Uma resposta de erro "esperada" (403, 401, 500 NOT_FOUND...) casa com o que o exame pediu? */
export function avaliarNegativa(resposta, aceitas) {
  const status = resposta && resposta.status;
  if (status === 429) return { ok: false, motivo: "limite", detalhe: "status 429" };
  const casou = aceitas.some(regra => regra(status, (resposta && resposta.erro) || "", (resposta && resposta.codigo) || ""));
  if (casou) return { ok: true, motivo: "", detalhe: `status ${status}` };
  return { ok: false, motivo: "status", detalhe: `barrado por motivo errado: status ${status}${resumirErro(resposta, " ")}` };
}

export function resumirErro(resposta, separador = "") {
  const codigo = resposta && resposta.codigo ? String(resposta.codigo) : "";
  const mensagem = resposta && resposta.erro ? String(resposta.erro).slice(0, 40) : "";
  const partes = [codigo, mensagem].filter(Boolean);
  return partes.length ? separador + partes.join(" ") : "";
}

/**
 * Termo Geral de Uso vigente em `document_versions` (contagem de isCurrent = 1).
 *
 * Sem versão vigente, `profile.completeOnboarding` lança PRECONDITION_FAILED
 * (server/termo-geral-de-uso.ts) e NENHUM cadastro novo conclui. A migração 0013
 * só abre o valor no enum; a versão nasce à mão, com publicar-documento.mjs,
 * depois de a 0013 estar aplicada. Sem esta checagem o exame pós-deploy saía
 * verde com o cadastro travado. Mais de uma vigente também reprova: o índice
 * único de document_versions deveria impedir, e `getCurrentDocument` pegaria uma
 * qualquer (LIMIT 1 sem ordem).
 */
export const COMANDO_PUBLICAR_TERMO_GERAL =
  "node scripts/publicar-documento.mjs termo_geral_de_uso docs/termos/termo-geral-de-uso.md --sem-aviso --confirmo-producao";

export function avaliarTermoGeralVigente(vigentes) {
  const n = Number(vigentes);
  if (n === 1) return { ok: true, detalhe: "1 versão vigente" };
  if (n === 0) {
    return {
      ok: false,
      detalhe: `NENHUMA versão vigente: todo cadastro novo para na última etapa. Com autorização do Roberto: ${COMANDO_PUBLICAR_TERMO_GERAL}`,
    };
  }
  return { ok: false, detalhe: `${Number.isFinite(n) ? n : "?"} versões vigentes: getCurrentDocument escolhe uma qualquer` };
}

/**
 * O 307 do proxy /manus-storage/ para uma IMAGEM da dona (a do exame é um PNG
 * em contexts/), aberta duas vezes seguidas, como a tela reaberta.
 *
 * Desde a PR #149, imagem de contato, de contexto e gerada sai com
 * `private, max-age=300` no 307 e com a MESMA URL assinada por 50 minutos
 * (server/_core/storageProxy.ts, politicaDeCacheDaChave): é o que evita baixar
 * de novo os mesmos bytes do bucket a cada abertura. A checagem antiga exigia
 * `no-store` e reprovaria o primeiro exame depois do merge.
 *
 * O cabeçalho é comparado INTEIRO: uma CDN ou a borda do Render que o
 * reescreva (outro max-age, `public`) aparece aqui. E a segunda abertura tem de
 * trazer o MESMO Location: é a prova, em produção, de que a URL é reaproveitada.
 *
 * `detalhe` nunca leva o Location: a URL assinada abre o arquivo sem sessão por
 * até uma hora, e a saída do exame é colada em PR pública. O Cache-Control entra
 * cortado em 40 caracteres, como as mensagens do servidor.
 *
 * Recebe { status, cacheControl, location } de cada abertura.
 */
export const CACHE_DO_307_DE_IMAGEM_DA_DONA = "private, max-age=300";

export function avaliarRedirecionamentoComCache(primeira, segunda) {
  const status = primeira && primeira.status;
  const cache = String((primeira && primeira.cacheControl) || "");
  const location = (primeira && primeira.location) || "";
  const problemas = [];
  if (status !== 307) problemas.push(`status ${status}`);
  if (cache !== CACHE_DO_307_DE_IMAGEM_DA_DONA) {
    problemas.push(`Cache-Control "${cache.slice(0, 40)}" (esperado "${CACHE_DO_307_DE_IMAGEM_DA_DONA}")`);
  }
  if (!location) problemas.push("sem Location");
  const statusDeNovo = segunda && segunda.status;
  if (statusDeNovo !== 307) problemas.push(`segunda abertura: status ${statusDeNovo}`);
  else if (location && ((segunda && segunda.location) || "") !== location) {
    problemas.push("segunda abertura: outra URL assinada (o proxy não reaproveitou a URL)");
  }
  if (problemas.length) return { ok: false, detalhe: problemas.join("; ") };
  return { ok: true, detalhe: "307 e a mesma URL assinada nas duas aberturas" };
}

/** Cabeçalho combinado RateLimit (draft-7): "limit=100, remaining=87, reset=42". */
export function analisarRateLimit(valor) {
  if (!valor || typeof valor !== "string") return null;
  const saida = {};
  for (const parte of valor.split(",")) {
    const [chave, numero] = parte.split("=").map(s => s.trim());
    if (chave && numero !== undefined && /^\d+$/.test(numero)) saida[chave] = Number(numero);
  }
  return "remaining" in saida ? saida : null;
}

/**
 * Ritmo das requisições: janela deslizante local (rede de segurança) mais o
 * orçamento que o SERVIDOR informa no cabeçalho RateLimit. O apiLimiter da
 * produção é 100 req/min por IP; o exame faz ~70 chamadas em /api/trpc, e duas
 * execuções seguidas estourariam. Relógio e sono injetáveis para o teste.
 */
export class Ritmo {
  constructor({ limite = 85, janelaMs = 60_000, folgaServidor = 10, agora = () => Date.now(), dormir = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    this.limite = limite;
    this.janelaMs = janelaMs;
    this.folgaServidor = folgaServidor;
    this.agora = agora;
    this.dormir = dormir;
    this.carimbos = [];
    this.servidor = null; // { remaining, resetEm }
    this.esperasMs = 0;
  }

  /** Quanto esperar agora, em ms, antes da próxima requisição (puro). */
  esperaNecessaria() {
    const t = this.agora();
    this.carimbos = this.carimbos.filter(c => t - c < this.janelaMs);
    let espera = 0;
    if (this.carimbos.length >= this.limite) espera = Math.max(espera, this.carimbos[0] + this.janelaMs - t);
    if (this.servidor && this.servidor.remaining < this.folgaServidor && this.servidor.resetEm > t) {
      espera = Math.max(espera, this.servidor.resetEm - t);
    }
    return espera;
  }

  async antes() {
    const espera = this.esperaNecessaria();
    if (espera > 0) {
      this.esperasMs += espera;
      await this.dormir(espera);
    }
    this.carimbos.push(this.agora());
  }

  /** Lê o orçamento devolvido pelo servidor (cabeçalhos RateLimit e Retry-After). */
  depois(headers) {
    if (!headers || typeof headers.get !== "function") return;
    const combinado = analisarRateLimit(headers.get("ratelimit"));
    if (combinado) {
      this.servidor = { remaining: combinado.remaining, resetEm: this.agora() + (combinado.reset ?? 60) * 1000 };
    }
    const retry = headers.get("retry-after");
    if (retry && /^\d+$/.test(retry)) {
      this.servidor = { remaining: 0, resetEm: this.agora() + Number(retry) * 1000 };
    }
  }

  /** Depois de um 429: quanto esperar antes da única retentativa. */
  esperaAposLimite() {
    const t = this.agora();
    if (this.servidor && this.servidor.resetEm > t) return this.servidor.resetEm - t;
    return this.janelaMs;
  }
}
