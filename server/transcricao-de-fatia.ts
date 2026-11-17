import { IDIOMA_DA_REUNIAO_PADRAO, idiomaDaReuniao, nomeDoIdioma, type IdiomaDaReuniao } from "@shared/idioma-da-reuniao";
import { gerarComAudioNoGemini } from "./gemini";

/**
 * A transcrição de UMA fatia da reunião em partes (G6 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md).
 *
 * Contrato do segmento (fixado antes desta PR): `{inicio, fim, falante, texto,
 * lacuna?}`. O tempo vai em segundos ABSOLUTOS da reunião; o falante é gravado
 * como `F1`, `F2`... (o rótulo "Falante 1" só existe na tela); o trecho que não
 * chegou é um segmento com `lacuna: true` e texto vazio.
 *
 * Cada fatia (~10 min) é uma chamada ao Gemini, com o áudio inline e a resposta
 * em JSON. A fatia leva adiante as vozes já identificadas e as últimas falas da
 * fatia anterior, para o mesmo `F<n>` continuar sendo a mesma pessoa.
 *
 * O modelo escreve o tempo DENTRO da fatia como texto "MM:SS" (o formato em que
 * o Gemini marca tempo de áudio), e o servidor o converte em segundos. Pedido
 * como número de segundos ("de 0 a 600"), ele escrevia os minutos e os segundos
 * juntos (1:00 virava 100): a fala depois dos ~6 min de cada parte era achatada
 * no fim dela ou nem vinha, já que, contando assim, aos 6 min ele chegava ao
 * "600" do pedido (bancada da tela do pacote 4a, 17/11/2026).
 *
 * O raciocínio do modelo tem orçamento FIXO e baixo: ele conta dentro do teto
 * de saída, e num áudio de 38 min o gemini-3.5-flash parou em MAX_TOKENS com
 * 62,9 mil tokens de raciocínio e só 2,6 mil de texto (14/11/2026). Resposta
 * cortada (MAX_TOKENS) é erro, nunca transcrição pela metade gravada como se
 * fosse a inteira.
 */
export type Segmento = { inicio: number; fim: number; falante: string; texto: string; lacuna?: true };

/** O que a fatia anterior passa adiante. */
export type ContextoDaFatiaAnterior = { falantes: string[]; ultimasFalas: Segmento[] };

export const DURACAO_DA_FATIA_SEGUNDOS = 600;
// As últimas falas que vão no prompt da fatia seguinte, e o teto de letras delas.
const FALAS_DE_CONTEXTO = 4;
const LETRAS_DE_CONTEXTO = 1_200;
// Folga para o modelo marcar um fim um pouco depois do fim declarado da fatia.
const FOLGA_DO_FIM_SEGUNDOS = 2;
const FALANTE_VALIDO = /^F([1-9]\d?)$/;
// O tempo que o modelo escreve: "MM:SS" ou, a partir de uma hora, "H:MM:SS"
// (décimos aceitos na leitura, embora o esquema não os peça). O texto só com
// número ("105") não casa aqui: é lido como número (leituraDosNumeros).
const TEMPO_EM_TEXTO = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{1,2})(?:[.,](\d+))?$/;
const NUMERO_EM_TEXTO = /^\d+(?:[.,]\d+)?$/;
// O mesmo formato no esquema, sem atalhos de regex, para o decodificador do
// Gemini: "07:05", "7:05" ou "1:02:05".
const PADRAO_DO_TEMPO = "^([0-9]+:)?[0-5]?[0-9]:[0-5][0-9]$";
const DESCRICAO_DO_TEMPO = 'Tempo dentro deste trecho, contado do começo dele, como texto "MM:SS" (a partir de uma hora, "H:MM:SS").';

// O responseSchema do Gemini (subconjunto do OpenAPI), com os tipos em
// maiúsculas, como a API os define. O tempo é TEXTO com padrão, nunca número:
// ver o cabeçalho. A ordem das propriedades é a do contrato (propertyOrdering):
// sem ela, a API pode gerá-las em ordem alfabética, com o fim antes do início.
const ESQUEMA_DA_RESPOSTA = {
  type: "OBJECT",
  properties: {
    segmentos: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          inicio: { type: "STRING", description: DESCRICAO_DO_TEMPO, pattern: PADRAO_DO_TEMPO },
          fim: { type: "STRING", description: DESCRICAO_DO_TEMPO, pattern: PADRAO_DO_TEMPO },
          falante: { type: "STRING" },
          texto: { type: "STRING" },
        },
        required: ["inicio", "fim", "falante", "texto"],
        propertyOrdering: ["inicio", "fim", "falante", "texto"],
      },
    },
  },
  required: ["segmentos"],
} as const;

/** Segundos como o modelo os escreve: "MM:SS" ou, com horas, "H:MM:SS". */
export function tempoEmTexto(segundos: number, comHoras = segundos >= 3600): string {
  const total = Math.max(0, Math.round(segundos));
  const doisDigitos = (n: number) => String(n).padStart(2, "0");
  const horas = Math.floor(total / 3600);
  const minutosESegundos = `${doisDigitos(Math.floor((total % 3600) / 60))}:${doisDigitos(total % 60)}`;
  return comHoras || horas ? `${horas}:${minutosESegundos}` : minutosESegundos;
}

export function promptDaFatia(input: { idioma: IdiomaDaReuniao; duracaoSegundos: number; anterior?: ContextoDaFatiaAnterior }): string {
  // As partes têm até 12 min (DURACAO_MAXIMA_DA_PARTE_SEGUNDOS); o "H:MM:SS"
  // só vale para a bancada, que aceita parte de qualquer tamanho.
  const comHoras = input.duracaoSegundos >= 3600;
  const fimDoTrecho = tempoEmTexto(input.duracaoSegundos, comHoras);
  const formato = comHoras
    ? '"H:MM:SS" (horas, minutos e segundos: "0:00:07", "0:01:05", "1:02:30")'
    : '"MM:SS" (minutos e segundos, cada um com dois dígitos: "00:07", "01:05", "09:58")';
  const linhas = [
    "Transcreva integralmente a fala deste trecho de áudio de uma reunião.",
    `O idioma predominante esperado é ${nomeDoIdioma(input.idioma)}; transcreva cada fala no idioma em que foi dita, sem traduzir.`,
    "Regras:",
    "1) Transcrição literal: não resuma, não corrija e não invente. Preserve nomes próprios, empresas, números, telefones e e-mails.",
    `2) "inicio" e "fim" são o tempo da fala DENTRO deste trecho, contado do começo dele, escrito como texto ${formato}, de "${tempoEmTexto(0, comHoras)}" a "${fimDoTrecho}". Nunca escreva o tempo como número. O trecho tem ${fimDoTrecho} de áudio: transcreva até o fim dele.`,
    '3) Separe as vozes: cada fala é um item, e "falante" é "F1", "F2", "F3"... A mesma voz fica sempre com o mesmo rótulo. Nunca use nomes de pessoas no rótulo.',
    "4) Quebre falas longas em itens de até 1 minuto, com o mesmo falante.",
    "5) Trecho que não dá para entender, música ou ruído longo: uma marca curta entre colchetes, na língua da fala em volta (em português: [inaudível], [música], [ruído]). Silêncio não vira item.",
  ];
  if (input.anterior && (input.anterior.falantes.length || input.anterior.ultimasFalas.length)) {
    linhas.push(`6) Este trecho continua o anterior. Vozes já identificadas: ${input.anterior.falantes.join(", ") || "nenhuma"}. Reconheça as mesmas vozes e use os mesmos rótulos; voz nova recebe o próximo número livre.`);
    // Sem o tempo: o da fala anterior é absoluto (passa dos 600 s), e a regra 2
    // pede o tempo DENTRO do trecho; um exemplo com [10:23] ensinaria o modelo
    // a devolver tempos que o teto da parte achataria.
    let letras = 0;
    const falas: string[] = [];
    for (const fala of input.anterior.ultimasFalas.slice(-FALAS_DE_CONTEXTO).reverse()) {
      const linha = `${fala.falante}: ${fala.texto}`;
      if (letras + linha.length > LETRAS_DE_CONTEXTO) {
        // A fala mais recente é a que mais ajuda a reconhecer a voz: longa
        // demais, vai cortada, e não some.
        if (!falas.length) falas.unshift(`${linha.slice(0, LETRAS_DE_CONTEXTO)}…`);
        break;
      }
      letras += linha.length;
      falas.unshift(linha);
    }
    if (falas.length) linhas.push("Últimas falas do trecho anterior (só para reconhecer as vozes; não as transcreva de novo):", ...falas);
  }
  return linhas.join("\n");
}

/** Um tempo da resposta, em segundos, e se ele veio como número (ou texto só com número). */
export type TempoLido = { segundos: number; numero: boolean };

/**
 * Lê um tempo da resposta do modelo. Texto "MM:SS" ou "H:MM:SS" vira segundos
 * (segundos de 60 em diante, ou minutos de 60 em diante depois da hora, não são
 * tempo). Número, ou texto só com número ("105"), volta marcado como número:
 * quem decide o que ele quer dizer é leituraDosNumeros, olhando a resposta
 * inteira. Negativo, vazio ou qualquer outra coisa: null.
 */
export function lerTempo(valor: unknown): TempoLido | null {
  if (typeof valor === "number") return Number.isFinite(valor) && valor >= 0 ? { segundos: valor, numero: true } : null;
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  if (NUMERO_EM_TEXTO.test(texto)) return { segundos: Number(texto.replace(",", ".")), numero: true };
  const partes = TEMPO_EM_TEXTO.exec(texto);
  if (!partes) return null;
  const [, horas, minutos, segundos, decimos] = partes;
  const s = Number(`${segundos}.${decimos ?? "0"}`);
  if (s >= 60 || (horas !== undefined && Number(minutos) >= 60)) return null;
  return { segundos: Number(horas ?? 0) * 3600 + Number(minutos) * 60 + s, numero: false };
}

/** O número com os minutos e os segundos juntos (105 = 1:05), em segundos; null se ele não tem essa forma. */
function minutosESegundosJuntos(n: number): number | null {
  const inteiro = Math.floor(n);
  const segundos = (inteiro % 100) + (n - inteiro);
  return segundos < 60 ? Math.floor(inteiro / 100) * 60 + segundos : null;
}

/**
 * Como ler os tempos que vieram como NÚMERO: o formato de antes desta correção,
 * ou um modelo que fuja do texto pedido. A leitura só vale se for coerente com
 * a parte inteira:
 * - em segundos, se nenhuma fala começa depois do fim da parte (o fim que passa
 *   um pouco dele é comum, e fica preso nele);
 * - em minutos e segundos juntos (1:00 escrito 100, o defeito de 17/11), se
 *   alguma começa depois do fim e TODOS os tempos cabem na parte nessa leitura;
 * - se nenhuma das duas é coerente, em segundos, e o que passa do fim fica
 *   preso nele, sem perder a fala.
 * Na dúvida (todos cabem nas duas leituras), fica em segundos: a resposta
 * antiga com fala só nos primeiros 6 min de cada parte não se distingue, e é o
 * esquema em texto que evita o caso.
 */
function leituraDosNumeros(inicios: number[], todos: number[], teto: number): { ler: (n: number) => number; juntos: boolean } {
  const emSegundos = { ler: (n: number) => n, juntos: false };
  if (inicios.every(n => n <= teto)) return emSegundos;
  if (!todos.every(n => { const lido = minutosESegundosJuntos(n); return lido !== null && lido <= teto; })) return emSegundos;
  return { ler: n => minutosESegundosJuntos(n) ?? n, juntos: true };
}

/**
 * Converte a resposta do modelo em segmentos do contrato: tempos absolutos
 * (somados ao início da fatia), em ordem, sem texto vazio. NENHUMA fala com
 * texto se perde por causa do tempo: a que passa do fim da parte fica presa
 * nele (com a folga de 2 s), e a sem tempo legível fica com o início da
 * anterior. A ordenação é pelo início e estável: falas com o mesmo início (as
 * presas no fim, a sem tempo logo depois da anterior) ficam na ordem em que o
 * modelo as escreveu. Falante fora do formato `F<n>` vira o último falante
 * válido (ou F1): o rótulo é dado de tela, e um nome inventado pelo modelo não
 * pode ir ao banco.
 */
export function normalizarSegmentos(bruto: unknown, inicioSegundos: number, duracaoSegundos: number): Segmento[] {
  const itens = (bruto as { segmentos?: unknown })?.segmentos;
  if (!Array.isArray(itens)) throw new Error("A transcrição da parte veio sem a lista de falas.");
  const teto = duracaoSegundos + FOLGA_DO_FIM_SEGUNDOS;
  const falas: Array<{ inicio: TempoLido | null; fim: TempoLido | null; falante: unknown; texto: string }> = [];
  for (const item of itens) {
    const { inicio, fim, falante, texto } = (item ?? {}) as Record<string, unknown>;
    if (typeof texto !== "string" || !texto.trim()) continue;
    falas.push({ inicio: lerTempo(inicio), fim: lerTempo(fim), falante, texto: texto.trim() });
  }
  // Os números se leem juntos, porque um só não diz se 105 é 1:45 ou 1:05.
  const numeros = (lidos: Array<TempoLido | null>) => lidos.filter((t): t is TempoLido => !!t?.numero).map(t => t.segundos);
  const iniciosEmNumero = numeros(falas.map(f => f.inicio));
  const todosEmNumero = numeros(falas.flatMap(f => [f.inicio, f.fim]));
  const leitura = leituraDosNumeros(iniciosEmNumero, todosEmNumero, teto);
  const emSegundos = (t: TempoLido | null) => (t === null ? null : t.numero ? leitura.ler(t.segundos) : t.segundos);

  const segmentos: Segmento[] = [];
  let ultimoFalante = "F1";
  let inicioAnterior = 0;
  let rotulosTrocados = 0;
  let semTempo = 0;
  let presasNoFim = 0;
  for (const fala of falas) {
    const lidoDe = emSegundos(fala.inicio);
    if (lidoDe === null) semTempo++;
    else if (lidoDe > teto) presasNoFim++;
    const de = Math.min(lidoDe ?? inicioAnterior, teto);
    const ate = Math.min(Math.max(emSegundos(fala.fim) ?? de, de), teto);
    inicioAnterior = de;
    const valido = typeof fala.falante === "string" && FALANTE_VALIDO.test(fala.falante.trim());
    if (!valido) rotulosTrocados++;
    const rotulo = valido ? (fala.falante as string).trim() : ultimoFalante;
    ultimoFalante = rotulo;
    segmentos.push({
      inicio: arredondar(inicioSegundos + de),
      fim: arredondar(inicioSegundos + ate),
      falante: rotulo,
      texto: fala.texto,
    });
  }
  // Avisos para quem acompanha a bancada e o log (só contagens, nunca a fala):
  // o rótulo trocado funde vozes, o tempo fora do formato pede atenção ao
  // modelo, e uma parte longa sem fala nenhuma pode ser falha dele, não silêncio.
  if (todosEmNumero.length) console.warn(`[Transcrição] ${todosEmNumero.length} tempos vieram como número, e não como "MM:SS"; lidos como ${leitura.juntos ? "minutos e segundos juntos (105 = 1:05)" : "segundos"}`);
  if (presasNoFim) console.warn(`[Transcrição] ${presasNoFim} de ${segmentos.length} falas começavam depois do fim da parte (${Math.round(duracaoSegundos)} s) e ficaram presas nele`);
  if (semTempo) console.warn(`[Transcrição] ${semTempo} de ${segmentos.length} falas vieram sem tempo legível e ficaram com o início da anterior`);
  if (rotulosTrocados) console.warn(`[Transcrição] ${rotulosTrocados} de ${segmentos.length} falas vieram sem rótulo F<n> e ficaram com o falante anterior`);
  if (!segmentos.length && duracaoSegundos > 30) console.warn(`[Transcrição] parte de ${Math.round(duracaoSegundos)} s sem nenhuma fala`);
  return segmentos.sort((a, b) => a.inicio - b.inicio);
}

function arredondar(segundos: number) {
  return Math.round(segundos * 10) / 10;
}

/** As vozes e as últimas falas que a fatia passa à seguinte. */
export function contextoParaAProxima(segmentos: Segmento[], anterior?: ContextoDaFatiaAnterior): ContextoDaFatiaAnterior {
  const falantes = new Set(anterior?.falantes ?? []);
  for (const s of segmentos) if (!s.lacuna) falantes.add(s.falante);
  const falas = segmentos.filter(s => !s.lacuna);
  return {
    falantes: Array.from(falantes).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
    ultimasFalas: falas.length ? falas.slice(-FALAS_DE_CONTEXTO) : (anterior?.ultimasFalas ?? []),
  };
}

export async function transcreverFatia(input: {
  audio: Buffer;
  mimeType: string;
  idioma?: string;
  inicioSegundos: number;
  duracaoSegundos: number;
  anterior?: ContextoDaFatiaAnterior;
}): Promise<{ segmentos: Segmento[]; idioma: IdiomaDaReuniao; modelo: string }> {
  const idioma = idiomaDaReuniao(input.idioma) ?? IDIOMA_DA_REUNIAO_PADRAO;
  const { texto, modelo } = await gerarComAudioNoGemini({
    audio: input.audio,
    mimeType: input.mimeType,
    prompt: promptDaFatia({ idioma, duracaoSegundos: input.duracaoSegundos, anterior: input.anterior }),
    esquemaJson: ESQUEMA_DA_RESPOSTA,
  });
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch (erro) {
    throw new Error("A transcrição da parte veio num formato inválido.", { cause: erro });
  }
  return { segmentos: normalizarSegmentos(bruto, input.inicioSegundos, input.duracaoSegundos), idioma, modelo };
}

/**
 * Junta as fatias numa transcrição só. `fatias` traz cada parte que chegou,
 * pelo número (seq, a partir de 0), com o início e a duração dela; as partes
 * que faltam até `partesEsperadas` viram um segmento `lacuna` no lugar delas.
 * O texto corrido (o que a extração, a tradução e a Memória leem) é a sequência
 * das falas, sem o rótulo do falante: o rótulo é dado da tela.
 */
export function montarTranscricao(
  fatias: Array<{ seq: number; inicioSegundos: number; duracaoSegundos: number; segmentos: Segmento[] }>,
  partesEsperadas: number,
): { segmentos: Segmento[]; texto: string } {
  // Parte repetida ou fora da contagem é erro de quem chama (a fila), não algo
  // a resolver em silêncio: descartar uma delas perderia fala.
  const porSeq = new Map<number, (typeof fatias)[number]>();
  for (const f of fatias) {
    if (!Number.isInteger(f.seq) || f.seq < 0 || f.seq >= partesEsperadas) throw new Error(`Parte ${f.seq} fora das ${partesEsperadas} esperadas.`);
    if (porSeq.has(f.seq)) throw new Error(`Parte ${f.seq} repetida.`);
    porSeq.set(f.seq, f);
  }
  const segmentos: Segmento[] = [];
  let cursor = 0;
  // Só emenda na lacuna que acabou de ser aberta: uma parte que chegou sem fala
  // (silêncio) fica entre as duas, e o trecho dela não vira "não recebido".
  let lacunaAberta: Segmento | null = null;
  for (let seq = 0; seq < partesEsperadas; seq++) {
    const fatia = porSeq.get(seq);
    if (fatia) {
      segmentos.push(...fatia.segmentos);
      cursor = fatia.inicioSegundos + fatia.duracaoSegundos;
      lacunaAberta = null;
      continue;
    }
    // A parte não chegou: o buraco vai do fim da anterior ao início da próxima
    // que chegou (ou fica com a duração padrão, se não há próxima).
    const proxima = Array.from(porSeq.values()).filter(f => f.seq > seq).sort((a, b) => a.seq - b.seq)[0];
    const fim = Math.max(cursor, proxima ? proxima.inicioSegundos : cursor + DURACAO_DA_FATIA_SEGUNDOS);
    if (lacunaAberta) lacunaAberta.fim = fim;
    else {
      lacunaAberta = { inicio: cursor, fim, falante: "", texto: "", lacuna: true };
      segmentos.push(lacunaAberta);
    }
    cursor = fim;
  }
  const texto = segmentos.filter(s => !s.lacuna).map(s => s.texto).join("\n");
  return { segmentos, texto };
}
