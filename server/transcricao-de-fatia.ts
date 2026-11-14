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

// O responseSchema do Gemini (subconjunto do OpenAPI), com os tipos em
// maiúsculas, como a API os define.
const ESQUEMA_DA_RESPOSTA = {
  type: "OBJECT",
  properties: {
    segmentos: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          inicio: { type: "NUMBER" },
          fim: { type: "NUMBER" },
          falante: { type: "STRING" },
          texto: { type: "STRING" },
        },
        required: ["inicio", "fim", "falante", "texto"],
      },
    },
  },
  required: ["segmentos"],
} as const;

export function promptDaFatia(input: { idioma: IdiomaDaReuniao; duracaoSegundos: number; anterior?: ContextoDaFatiaAnterior }): string {
  const linhas = [
    "Transcreva integralmente a fala deste trecho de áudio de uma reunião.",
    `O idioma predominante esperado é ${nomeDoIdioma(input.idioma)}; transcreva cada fala no idioma em que foi dita, sem traduzir.`,
    "Regras:",
    "1) Transcrição literal: não resuma, não corrija e não invente. Preserve nomes próprios, empresas, números, telefones e e-mails.",
    `2) "inicio" e "fim" são os segundos dentro DESTE trecho, de 0 a ${Math.round(input.duracaoSegundos)}.`,
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

/**
 * Converte a resposta do modelo em segmentos do contrato: tempos absolutos
 * (somados ao início da fatia), presos à duração dela, em ordem, sem texto
 * vazio. Falante fora do formato `F<n>` vira o último falante válido (ou F1):
 * o rótulo é dado de tela, e um nome inventado pelo modelo não pode ir ao banco.
 */
export function normalizarSegmentos(bruto: unknown, inicioSegundos: number, duracaoSegundos: number): Segmento[] {
  const itens = (bruto as { segmentos?: unknown })?.segmentos;
  if (!Array.isArray(itens)) throw new Error("A transcrição da parte veio sem a lista de falas.");
  const teto = duracaoSegundos + FOLGA_DO_FIM_SEGUNDOS;
  const segmentos: Segmento[] = [];
  let ultimoFalante = "F1";
  let rotulosTrocados = 0;
  for (const item of itens) {
    const { inicio, fim, falante, texto } = (item ?? {}) as Record<string, unknown>;
    if (typeof texto !== "string" || !texto.trim()) continue;
    const de = Math.min(Math.max(Number.isFinite(inicio) ? Number(inicio) : 0, 0), teto);
    const ate = Math.min(Math.max(Number.isFinite(fim) ? Number(fim) : de, de), teto);
    const valido = typeof falante === "string" && FALANTE_VALIDO.test(falante.trim());
    if (!valido) rotulosTrocados++;
    const rotulo = valido ? (falante as string).trim() : ultimoFalante;
    ultimoFalante = rotulo;
    segmentos.push({
      inicio: arredondar(inicioSegundos + de),
      fim: arredondar(inicioSegundos + ate),
      falante: rotulo,
      texto: texto.trim(),
    });
  }
  // Avisos para quem acompanha a bancada e o log: o rótulo trocado funde vozes,
  // e uma parte longa sem fala nenhuma pode ser falha do modelo, não silêncio.
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
