// Os modelos de IA do servidor: lidos do ambiente na hora da chamada e
// passados pela guarda do modelo concreto (regra do CLAUDE.md da raiz). Um
// alias já apontou para um modelo de 20 requisições por dia e derrubou a IA
// em produção.
//
// São duas guardas, porque os destinos são dois:
//  - o ÁUDIO (LLM_AUDIO_MODEL e a reserva) vai sempre à API do Gemini, com o
//    id na URL (/models/<id>:generateContent): só passa o formato fechado
//    gemini-<versão>;
//  - o TEXTO (LLM_MODEL e as variáveis por função, LLM_MODEL_<FUNÇÃO>) vai ao
//    LLM_API_URL, que pode ser qualquer endpoint compatível com a API da
//    OpenAI, com o id no corpo JSON: passa id de outro provedor
//    (gpt-4o-2024-08-06), e só cai o que com certeza é alias.
//
// A guarda é um piso, não uma prova: um id com versão ainda pode ser apelido
// que o provedor resolve sozinho. O que a chave do Gemini enxerga de fato,
// scripts/listar-modelos-gemini.mjs lista.

// Padrão do áudio e do texto até a bancada A escolher. O gemini-3.5-flash
// entrou no lugar do 2.5 Flash, descontinuado para chaves novas; que ele seja
// id concreto ainda está em aberto: não constava da página de preços do Gemini
// em outubro de 2026. A bancada A de texto (16/11/2026) manteve o Flash como
// padrão do texto e levou só a extração ao Lite (FUNCOES_DE_TEXTO, abaixo).
export const MODELO_DE_AUDIO_PADRAO = "gemini-3.5-flash";
export const MODELO_DE_TEXTO_PADRAO = "gemini-3.5-flash";
// Reserva para quando o modelo de áudio está lotado (503) ou com a cota do dia
// esgotada (429 do plano gratuito). Duas regras aprendidas a dor:
//  1. Modelo CONCRETO, nunca alias -latest — um alias já apontou para modelo
//     com cota gratuita de 20/dia e derrubou a IA em produção (CLAUDE.md).
//  2. DIFERENTE do principal — a versão anterior lia LLM_MODEL, que em
//     produção é exatamente o gemini-3.5-flash principal, e a guarda de
//     igualdade em transcribeWithGemini pulava a reserva: ela NUNCA disparou
//     na prática.
// gemini-3.5-flash-lite aceita áudio (entradas: texto, imagem, vídeo, áudio e
// PDF — docs oficiais do Gemini) e tem cota separada da do principal.
// LLM_AUDIO_MODEL_RESERVA permite trocar sem deploy; se o valor apontado não
// existir, o catch da reserva registra e devolve o erro original — nunca pior
// do que não ter reserva.
export const MODELO_DE_AUDIO_RESERVA_PADRAO = "gemini-3.5-flash-lite";

// O TEXTO POR FUNÇÃO. Cada função que a bancada A de texto mediu (16/11/2026)
// tem a sua variável e pode ter um padrão no código. A ordem, sempre pela
// guarda do texto:
//   LLM_MODEL_<FUNÇÃO> > o padrão da função no código, se houver >
//   LLM_MODEL > MODELO_DE_TEXTO_PADRAO.
// A variável recusada cai no degrau seguinte, e não direto no padrão fixo.
// Quem chama sem função (tradução, FAQ, Memória, recomendações, complementos
// de contato...) fica no LLM_MODEL, como antes: a bancada não os mediu.
export type FuncaoDeTexto = "extracao" | "resumo" | "pergunta";

type ModeloDaFuncao = {
  /** A variável que troca o modelo da função sem deploy. */
  variavel: string;
  /** O padrão no código, acima do LLM_MODEL; null segue o LLM_MODEL. */
  padrao: string | null;
  /** O nome na linha [IA] do boot. */
  nomeNoLog: string;
};

export const FUNCOES_DE_TEXTO: Readonly<Record<FuncaoDeTexto, ModeloDaFuncao>> = {
  // Extração da reunião (Tenho/Preciso e contatos): o Lite ganhou nos dois
  // juízes e nas 3 rodadas (média 8,5 contra 7,25 do Flash), respondeu 5 vezes
  // mais rápido e custou 78% menos por chamada. Com o padrão aqui, o deploy
  // leva a extração ao Lite sem mexer no painel; LLM_MODEL_EXTRACAO a devolve
  // ao Flash sem deploy.
  extracao: { variavel: "LLM_MODEL_EXTRACAO", padrao: "gemini-3.5-flash-lite", nomeNoLog: "extração" },
  // Resumo guardado: segue o LLM_MODEL (o Flash). Na bancada, o Flash esqueceu
  // menos (o próximo encontro, o perfil), e a espera não pesa: o resumo roda
  // na fila.
  resumo: { variavel: "LLM_MODEL_RESUMO", padrao: null, nomeNoLog: "resumo" },
  // Pergunte à reunião: segue o LLM_MODEL até a rodada de confirmação do Lite
  // (reunião de 1 h e perguntas sem resposta). Se ela passar,
  // LLM_MODEL_PERGUNTA o leva ao Lite sem deploy.
  pergunta: { variavel: "LLM_MODEL_PERGUNTA", padrao: null, nomeNoLog: "pergunta" },
};

// Áudio: "gemini-", o número de versão (3.5, 2.5, 3) e o resto em minúsculas,
// dígitos, ponto e hífen. Nome de família sem versão (gemini-pro,
// gemini-flash) é alias que o Google redireciona sozinho; e o formato fechado
// impede que a variável enfie outro caminho na URL da API.
const ID_DO_GEMINI_COM_VERSAO = /^gemini-\d+(?:\.\d+)*(?:-[a-z0-9.]+)*$/;

export function ehModeloDeAudioConcreto(id: string): boolean {
  return ID_DO_GEMINI_COM_VERSAO.test(id) && !/latest/i.test(id);
}

// Texto: sem "latest" e com número de versão, ou seja, ao menos um dígito
// (gemini-pro e gemini-flash não têm). O formato do id fica com o provedor.
export function ehModeloDeTextoConcreto(id: string): boolean {
  return /\d/.test(id) && !/latest/i.test(id);
}

// No log só entra valor com cara de id do Gemini: uma chave colada no campo
// errado do painel não pode parar no log do Render. Id de outro provedor fica
// de fora pelo mesmo motivo: a guarda do texto o aceita, mas não o distingue
// de uma chave.
const PARECE_ID_DO_GEMINI = /^(?:models\/)?gemini[\w.:/-]{0,80}$/i;

function comoAparecerNoLog(valor: string): string {
  const id = valor.trim();
  if (!id) return "vazio";
  return PARECE_ID_DO_GEMINI.test(id) ? `"${id}"` : "valor fora do log: só id do Gemini aparece aqui";
}

// Um id que já passou pela guarda, como pode ir ao log. O padrão de uma
// variável de função pode vir do LLM_MODEL, e não só do código: também ele
// passa por aqui.
function idNoLog(id: string): string {
  return PARECE_ID_DO_GEMINI.test(id) ? id : "(id de outro provedor, fora do log)";
}

type Guarda = { aceita: (id: string) => boolean; pede: string };

const GUARDA_DO_AUDIO: Guarda = {
  aceita: ehModeloDeAudioConcreto,
  pede: 'use um id do Gemini concreto, no formato gemini-<versão> e sem "latest" (confira com node scripts/listar-modelos-gemini.mjs)',
};
const GUARDA_DO_TEXTO: Guarda = {
  aceita: ehModeloDeTextoConcreto,
  pede: 'use um id concreto, com número de versão e sem "latest" (no Gemini, confira com node scripts/listar-modelos-gemini.mjs)',
};

const recusasAvisadas = new Set<string>();

// Ausente ou vazio usa o padrão em silêncio: é o jeito documentado de não
// configurar. Recusado avisa no log uma vez por origem e valor (invokeLLM
// passa por aqui a cada chamada) e também usa o padrão.
function exigir(valor: string | undefined, padrao: string, origem: string, guarda: Guarda): string {
  if (valor === undefined || valor === "") return padrao;
  const id = valor.trim();
  if (guarda.aceita(id)) return id;
  const marca = `${origem}\n${valor}`;
  if (!recusasAvisadas.has(marca)) {
    recusasAvisadas.add(marca);
    console.warn(`[IA] ${origem} recusado (${comoAparecerNoLog(valor)}): ${guarda.pede}. Usando o padrão ${idNoLog(padrao)}.`);
  }
  return padrao;
}

export function exigirModeloDeAudio(valor: string | undefined, padrao: string, origem: string): string {
  return exigir(valor, padrao, origem, GUARDA_DO_AUDIO);
}

export function exigirModeloDeTexto(valor: string | undefined, padrao: string, origem: string): string {
  return exigir(valor, padrao, origem, GUARDA_DO_TEXTO);
}

export function modeloDeAudio(): string {
  return exigirModeloDeAudio(process.env.LLM_AUDIO_MODEL, MODELO_DE_AUDIO_PADRAO, "LLM_AUDIO_MODEL");
}

export function modeloDeAudioReserva(): string {
  return exigirModeloDeAudio(process.env.LLM_AUDIO_MODEL_RESERVA, MODELO_DE_AUDIO_RESERVA_PADRAO, "LLM_AUDIO_MODEL_RESERVA");
}

// O modelo de uma chamada de texto, pela função (ver FUNCOES_DE_TEXTO). Sem
// função, vale o LLM_MODEL, e sem ele o padrão. Quem chama não escolhe o id:
// o `model` que invokeLLM aceitava, herança do proxy Manus, saiu, porque
// nenhum caminho o passava e ele ficaria fora desta ordem.
export function modeloDeTexto(funcao?: FuncaoDeTexto): string {
  const geral = exigirModeloDeTexto(process.env.LLM_MODEL, MODELO_DE_TEXTO_PADRAO, "LLM_MODEL");
  if (!funcao) return geral;
  const { variavel, padrao } = FUNCOES_DE_TEXTO[funcao];
  // O padrão da função é id do Gemini, e só serve quando o texto vai ao
  // Gemini. Com o LLM_MODEL em outro provedor (o LLM_API_URL aponta para ele),
  // esse id daria erro lá: vale o LLM_MODEL, até alguém definir a variável da
  // função.
  const degrauSeguinte = padrao && PARECE_ID_DO_GEMINI.test(geral) ? padrao : geral;
  return exigirModeloDeTexto(process.env[variavel], degrauSeguinte, variavel);
}

// A linha do boot com os modelos que valem, já depois da guarda: quem lê o log
// do Render vê o que está em uso sem abrir o painel, inclusive o de cada função
// do texto. Nunca leva a chave: o id do texto que não parece do Gemini sai como
// "fora do log" (ver acima).
export function linhaDosModelosDeIa(): string {
  const audio = modeloDeAudio();
  const reserva = modeloDeAudioReserva();
  const reservaDesligada = reserva === audio ? " (igual ao áudio: não dispara)" : "";
  const porFuncao = (Object.keys(FUNCOES_DE_TEXTO) as FuncaoDeTexto[]).map(
    funcao => `${FUNCOES_DE_TEXTO[funcao].nomeNoLog} ${idNoLog(modeloDeTexto(funcao))}`
  );
  return [`[IA] áudio ${audio}`, `reserva ${reserva}${reservaDesligada}`, `texto ${idNoLog(modeloDeTexto())}`, ...porFuncao].join(" · ");
}
