// Os modelos de IA do servidor: lidos do ambiente na hora da chamada e
// passados pela guarda do modelo concreto (regra do CLAUDE.md da raiz). Um
// alias já apontou para um modelo de 20 requisições por dia e derrubou a IA
// em produção.
//
// São duas guardas, porque os destinos são dois:
//  - o ÁUDIO (LLM_AUDIO_MODEL e a reserva) vai sempre à API do Gemini, com o
//    id na URL (/models/<id>:generateContent): só passa o formato fechado
//    gemini-<versão>;
//  - o TEXTO (LLM_MODEL) vai ao LLM_API_URL, que pode ser qualquer endpoint
//    compatível com a API da OpenAI, com o id no corpo JSON: passa id de outro
//    provedor (gpt-4o-2024-08-06), e só cai o que com certeza é alias.
//
// A guarda é um piso, não uma prova: um id com versão ainda pode ser apelido
// que o provedor resolve sozinho. O que a chave do Gemini enxerga de fato,
// scripts/listar-modelos-gemini.mjs lista.

// Padrão do áudio e do texto até a bancada A escolher. O gemini-3.5-flash
// entrou no lugar do 2.5 Flash, descontinuado para chaves novas; que ele seja
// id concreto ainda está em aberto: não constava da página de preços do Gemini
// em outubro de 2026.
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
    console.warn(`[IA] ${origem} recusado (${comoAparecerNoLog(valor)}): ${guarda.pede}. Usando o padrão ${padrao}.`);
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

// LLM_MODEL vale para as chamadas de texto (extração, tradução, FAQ, Memória).
// O `model` de quem chama invokeLLM é herança do proxy Manus: nenhum caminho o
// passa hoje, e ele só conta sem a variável. Os dois passam pela guarda do texto.
export function modeloDeTexto(doChamador?: string): string {
  const doAmbiente = process.env.LLM_MODEL;
  if (doAmbiente) return exigirModeloDeTexto(doAmbiente, MODELO_DE_TEXTO_PADRAO, "LLM_MODEL");
  return exigirModeloDeTexto(doChamador, MODELO_DE_TEXTO_PADRAO, "invokeLLM({ model })");
}

// A linha do boot com os modelos que valem, já depois da guarda: quem lê o log
// do Render vê o que está em uso sem abrir o painel. Nunca leva a chave: o id
// do texto que não parece do Gemini sai como "fora do log" (ver acima).
export function linhaDosModelosDeIa(): string {
  const audio = modeloDeAudio();
  const reserva = modeloDeAudioReserva();
  const reservaDesligada = reserva === audio ? " (igual ao áudio: não dispara)" : "";
  const texto = modeloDeTexto();
  const textoNoLog = PARECE_ID_DO_GEMINI.test(texto) ? texto : "(id de outro provedor, fora do log)";
  return `[IA] áudio ${audio} · reserva ${reserva}${reservaDesligada} · texto ${textoNoLog}`;
}
