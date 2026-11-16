// Lista os modelos do Gemini que a chave enxerga, para escolher LLM_AUDIO_MODEL,
// LLM_AUDIO_MODEL_RESERVA e LLM_MODEL (quando o texto também vai ao Gemini)
// entre ids que existem de fato.
//
// Não toca banco e não lê o .env: a chave vem do AMBIENTE (LLM_API_KEY ou, sem
// ela, GOOGLE_API_KEY, a mesma ordem de server/_core/env.ts), vai no cabeçalho
// x-goog-api-key, e não na URL, que aparece em log de proxy e em mensagem de
// erro, e nunca é impressa. Para não digitá-la na linha de comando, onde fica
// no histórico do shell, leia-a sem eco e passe-a SÓ ao comando (Git Bash):
//   read -rsp "Chave do Gemini: " CHAVE; echo; LLM_API_KEY="$CHAVE" node scripts/listar-modelos-gemini.mjs --conferir id1,id2; unset CHAVE
// Sem export, de propósito: exportada, a chave fica no terminal, e o pnpm dev e
// o pnpm test rodados ali depois passam a usá-la no lugar da LLM_API_KEY do
// .env, porque o dotenv não sobrescreve variável que já está no ambiente. Com a
// chave de produção, o servidor local gastaria a cota da produção sem aviso.
//
// Uso:
//   node scripts/listar-modelos-gemini.mjs                     tabela de todos os modelos
//   node scripts/listar-modelos-gemini.mjs --conferir a,b,c    diz se cada id existe e aceita generateContent
//   node scripts/listar-modelos-gemini.mjs --ajuda
//
// EXISTIR NÃO PROVA QUE O ID É CONCRETO: os aliases (gemini-flash-latest e
// afins) também aparecem na lista. A guarda do servidor
// (server/_core/modelos-de-ia.ts) recusa "latest" e id sem número de versão (e,
// no áudio, todo id fora do formato gemini-<versão>), mas um id com versão
// ainda pode ser apelido que o Google resolve sozinho.
//
// Saída: 0 deu certo; 1 o --conferir não achou algum id ou achou um sem
// generateContent, o método de gerar conteúdo; 2 sem chave, argumento
// inválido ou falha ao falar com a API.

import { pathToFileURL } from "node:url";

export const URL_DOS_MODELOS = "https://generativelanguage.googleapis.com/v1beta/models";
// 1000 é o máximo que a API aceita por página.
const TAMANHO_DA_PAGINA = 1000;
// Folga enorme (20 mil modelos): só impede girar sem fim se a API errar.
const LIMITE_DE_PAGINAS = 20;
const TETO_POR_CHAMADA_MS = 20_000;

const AVISO_DE_ALIAS = "Existir não prova que o id é concreto: aliases (gemini-flash-latest e afins) também aparecem na lista.";

export const AJUDA = [
  "Lista os modelos do Gemini que a chave do ambiente enxerga.",
  "",
  "  node scripts/listar-modelos-gemini.mjs                     tabela: modelo, generateContent e limites de tokens",
  "  node scripts/listar-modelos-gemini.mjs --conferir a,b,c    diz se cada id existe e aceita generateContent;",
  "                                                             sai com 1 se faltar algum ou se algum não aceitar",
  "",
  "A chave vem do ambiente (LLM_API_KEY ou GOOGLE_API_KEY). O script não lê o .env,",
  "não toca banco e nunca imprime a chave.",
  "",
  "Existir NÃO prova que o id é concreto: aliases (gemini-flash-latest e afins)",
  'também aparecem na lista. A guarda do servidor recusa "latest" e id sem número de',
  "versão; que o id é concreto, só a documentação de modelos do Gemini diz.",
  "",
  "Saída: 0 deu certo; 1 o --conferir não achou algum id ou achou um sem generateContent;",
  "2 sem chave, argumento inválido ou falha da API.",
].join("\n");

export class ErroDaApi extends Error {
  constructor(status, detalhe) {
    super(`A API do Gemini respondeu HTTP ${status}.`);
    this.status = status;
    this.detalhe = detalhe;
  }
}

export function chaveDoAmbiente(ambiente) {
  return ambiente.LLM_API_KEY || ambiente.GOOGLE_API_KEY || "";
}

export function lerArgumentos(argumentos) {
  const lidos = { ajuda: false, conferir: null };
  for (let i = 0; i < argumentos.length; i++) {
    const argumento = argumentos[i];
    if (argumento === "--ajuda" || argumento === "--help" || argumento === "-h") {
      lidos.ajuda = true;
    } else if (argumento === "--conferir" || argumento.startsWith("--conferir=")) {
      const lista = argumento === "--conferir" ? argumentos[++i] : argumento.slice("--conferir=".length);
      const ids = String(lista ?? "")
        .split(",")
        .map(id => id.trim().replace(/^models\//, ""))
        .filter(Boolean);
      if (!ids.length || ids.some(id => id.startsWith("-"))) {
        return { erro: "--conferir precisa da lista de ids: --conferir gemini-3.5-flash,gemini-3.5-flash-lite" };
      }
      lidos.conferir = ids;
    } else if (argumento.startsWith("-")) {
      // Só o nome da opção: o valor depois do "=" pode ser a chave.
      return { erro: `Opção desconhecida: ${argumento.split("=")[0].slice(0, 40)}` };
    } else {
      // Sem repetir o texto: quem passa a chave como argumento a veria impressa.
      return { erro: "Argumento solto não é aceito (não o repito aqui, porque pode ser a chave). A chave vai no ambiente." };
    }
  }
  return lidos;
}

export async function listarModelos({ chave, buscar = globalThis.fetch }) {
  const modelos = [];
  const paginasVistas = new Set();
  let token = "";
  for (let pagina = 0; pagina < LIMITE_DE_PAGINAS; pagina++) {
    const url = new URL(URL_DOS_MODELOS);
    url.searchParams.set("pageSize", String(TAMANHO_DA_PAGINA));
    if (token) url.searchParams.set("pageToken", token);
    const resposta = await buscar(url.toString(), {
      headers: { "x-goog-api-key": chave },
      signal: AbortSignal.timeout(TETO_POR_CHAMADA_MS),
    });
    if (!resposta.ok) throw new ErroDaApi(resposta.status, await resposta.text().catch(() => ""));
    const corpo = await resposta.json();
    if (Array.isArray(corpo?.models)) modelos.push(...corpo.models);
    token = typeof corpo?.nextPageToken === "string" ? corpo.nextPageToken : "";
    if (!token) return modelos;
    if (paginasVistas.has(token)) throw new Error("A API repetiu a página seguinte; parei para não girar sem fim.");
    paginasVistas.add(token);
  }
  throw new Error(`A lista passou de ${LIMITE_DE_PAGINAS} páginas; parei para não girar sem fim.`);
}

export function resumirModelo(modelo) {
  const metodos = Array.isArray(modelo?.supportedGenerationMethods) ? modelo.supportedGenerationMethods : [];
  return {
    id: String(modelo?.name ?? "").replace(/^models\//, ""),
    generateContent: metodos.includes("generateContent"),
    entrada: Number.isFinite(modelo?.inputTokenLimit) ? modelo.inputTokenLimit : null,
    saida: Number.isFinite(modelo?.outputTokenLimit) ? modelo.outputTokenLimit : null,
  };
}

export function montarTabela(resumos) {
  const titulos = ["modelo", "generateContent", "entrada (tokens)", "saída (tokens)"];
  const linhas = [...resumos]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(resumo => [resumo.id, resumo.generateContent ? "sim" : "não", resumo.entrada ?? "—", resumo.saida ?? "—"].map(String));
  const larguras = titulos.map((titulo, coluna) => Math.max(titulo.length, ...linhas.map(linha => linha[coluna].length)));
  const alinhar = celulas => celulas.map((celula, coluna) => celula.padEnd(larguras[coluna])).join("  ").trimEnd();
  return [alinhar(titulos), alinhar(larguras.map(largura => "-".repeat(largura))), ...linhas.map(alinhar)].join("\n");
}

export function conferirIds(ids, resumos) {
  const porId = new Map(resumos.map(resumo => [resumo.id, resumo]));
  return ids.map(id => ({ id, existe: porId.has(id), generateContent: porId.get(id)?.generateContent ?? false }));
}

export async function principal({ argumentos, ambiente, buscar, escrever, escreverErro }) {
  const lidos = lerArgumentos(argumentos);
  if (lidos.erro) {
    escreverErro(`${lidos.erro}\nUse --ajuda.`);
    return 2;
  }
  if (lidos.ajuda) {
    escrever(AJUDA);
    return 0;
  }
  const chave = chaveDoAmbiente(ambiente);
  if (!chave) {
    escreverErro("Defina LLM_API_KEY (ou GOOGLE_API_KEY) no ambiente deste terminal: o script não lê o .env. Veja --ajuda.");
    return 2;
  }
  // Defesa a mais: nada do que sai na tela leva a chave, nem um erro da API que a repita.
  const semChave = texto => String(texto).split(chave).join("[chave omitida]");
  const dizer = texto => escrever(semChave(texto));
  const queixar = texto => escreverErro(semChave(texto));

  let resumos;
  try {
    resumos = (await listarModelos({ chave, buscar })).map(resumirModelo);
  } catch (erro) {
    if (erro instanceof ErroDaApi) {
      // A chave sai ANTES do corte: cortado antes, o começo dela, quando cai
      // perto do fim do trecho, não casaria mais com a chave inteira.
      queixar(`${erro.message} ${semChave(erro.detalhe).slice(0, 300)}`.trim());
    } else {
      const causa = erro?.cause?.message ? ` (${erro.cause.message})` : "";
      queixar(`Não consegui listar os modelos: ${erro instanceof Error ? erro.message : String(erro)}${causa}`);
    }
    return 2;
  }

  if (!lidos.conferir) {
    dizer(montarTabela(resumos));
    dizer(`\n${resumos.length} modelo(s) visível(is) para esta chave. ${AVISO_DE_ALIAS}`);
    return 0;
  }
  const conferidos = conferirIds(lidos.conferir, resumos);
  for (const { id, existe, generateContent } of conferidos) {
    if (!existe) dizer(`${id}: NÃO existe para esta chave`);
    else if (!generateContent) dizer(`${id}: existe, mas SEM generateContent: o servidor não consegue usá-lo`);
    else dizer(`${id}: existe (generateContent: sim)`);
  }
  dizer(AVISO_DE_ALIAS);
  // O servidor usa o modelo para gerar conteúdo (a transcrição chama
  // :generateContent): um id que existe sem esse método não serve para
  // nenhuma das três variáveis, então também reprova.
  return conferidos.every(item => item.existe && item.generateContent) ? 0 : 1;
}

// Rodado direto (e não importado), executa. Importado pelos testes, só define
// as funções: nenhuma leitura do ambiente, nenhuma ida à rede.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await principal({
    argumentos: process.argv.slice(2),
    ambiente: process.env,
    buscar: globalThis.fetch,
    escrever: texto => console.log(texto),
    escreverErro: texto => console.error(texto),
  });
}
