import crypto from "crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import {
  meetingAudioSlices,
  meetingContactSuggestions,
  meetingEntities,
  meetingRecordings,
  meetings,
  meetingTranscripts,
  meetingTranscriptTranslations,
  meetingSummaries,
  meetingSummaryItems,
  meetingSummaryTranslations,
} from "../drizzle/schema";
import { CODIGO_ERRO_INTERROMPIDO, ENVIO_UNICO_BYTES_MAX, ENVIO_UNICO_SEGUNDOS_MAX, FORMATO_DO_FALANTE, LIMITE_PROCESSAMENTO_MS, margemDoReprocesso, MENSAGEM_AUDIO_GUARDADO_AUSENTE, NOME_DO_FALANTE_MAX, nomesDosFalantes } from "@shared/const";
import { tokensDoTermo } from "@shared/direcao-do-termo";
import { IDIOMA_DA_REUNIAO_PADRAO, IDIOMAS_DA_REUNIAO, idiomaDaReuniao, nomeDoIdioma } from "@shared/idioma-da-reuniao";
import { linkMostraOsNomes } from "./autorizacao-do-link-aberto";
import { descreverErroDeBanco, ehErroDeBancoIndisponivel, ehErroDoDriverDeBanco, MENSAGEM_ERRO_DE_CONSULTA } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { ehColisaoDeChave } from "./network-codigo-anonimo";
import { invokeLLM } from "./_core/llm";
import { raciocinioDaFuncao } from "./_core/raciocinio-de-ia";
import { dividirEmJanelas } from "./janelas-de-texto";
import { limparRotulos } from "./trecho-da-transcricao";
import {
  chaveDoStorageDaDona, CONCORRENCIA_DO_EXPURGO_DO_AUDIO, ehAcessoNegadoNoBucket, ObjetoAusenteNoStorageError,
  storageApagarTodasAsVersoes, storageGetBytes, storagePut,
} from "./storage";
import { comConcorrenciaLimitada } from "./concorrencia-limitada";
import { GeminiIndisponivelError, transcribeWithGemini } from "./gemini";
import {
  apagarPendenciasDaReuniao, emailEstaNaFonte, expressaoEstaNaFonte, gravarPendencias, pendenciasDaPessoaNaReuniao,
  REGRAS_DAS_TRES_DIMENSOES, telefoneEstaNaFonte, type ItemProposto,
} from "./network-extracao";
import { registrarConsumoDeMinutos } from "./minutos-de-reuniao";
import { medirDuracaoDoAudio } from "./duracao-do-audio";

/**
 * Os tetos do ENVIO ÚNICO (10 MB e 10 min), que moram em shared/const.ts porque
 * a tela confere os mesmos. Os nomes de sempre ficam aqui para os imports não
 * mudarem; quem os usa é o envio único e o reprocesso dele. A gravação em
 * partes não passa por eles: tem o teto próprio (GRAVACAO_EM_PARTES_SEGUNDOS_MAX,
 * em server/fatias-de-reuniao.ts), que desde a G13b é também o limite por
 * reunião do painel de minutos (server/minutos-de-reuniao.ts).
 */
export const MAX_MEETING_AUDIO_BYTES = ENVIO_UNICO_BYTES_MAX;
export const MAX_MEETING_DURATION_SECONDS = ENVIO_UNICO_SEGUNDOS_MAX;
/**
 * Quanto o áudio de uma reunião fica guardado: 30 dias contados do envio. No
 * envio único, do momento em que o áudio inteiro chega (a tomada para
 * 'processing'). Na gravação em partes, da chegada da ÚLTIMA parte: a cada
 * parte que chega, o prazo de todas as partes da reunião passa a ser o dela
 * (receberParte, em fatias-de-reuniao.ts), e elas vencem e saem juntas, como o
 * áudio inteiro do envio único. A transcrição fica até a dona excluir a reunião.
 *
 * Quem cumpre o prazo é a varredura (limparGravacoesVencidas), no boot e a cada
 * 5 min (server/varredura-de-gravacoes.ts), e a leitura da reunião vencida
 * (gravacaoParaOuvir). As duas tiram o objeto do bucket com todas as versões
 * antes de apagar a linha.
 */
export const MEETING_AUDIO_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MENSAGEM_REUNIAO_LONGA_DEMAIS = "No modo atual, cada reunião pode ter no máximo 10 minutos.";
export const MENSAGEM_DURACAO_ILEGIVEL = "Não foi possível ler a duração deste áudio. Envie o arquivo em MP3, M4A, WAV, OGG ou WebM.";
/**
 * Folga sobre o limite medido: o gravador da tela para aos 600 s pelo relógio
 * (consulta a cada 500 ms) e o contêiner fecha alguns décimos depois.
 */
export const FOLGA_DA_DURACAO_MEDIDA_SECONDS = 5;

/**
 * A duração que vale para o limite gratuito e para o contador de minutos: a
 * MEDIDA nos bytes (duracao-do-audio.ts), nunca a que o navegador declarou —
 * sem ler a duração, a tela mandava 60 s, e um .webm de 25 minutos passava e
 * entrava no contador como 1 minuto. Sem medida, recusa: não há como aplicar
 * o limite a um áudio cuja duração ninguém conhece.
 */
export function duracaoConferidaDoAudio(audio: Buffer): number {
  const medida = medirDuracaoDoAudio(audio);
  if (medida === null) throw new Error(MENSAGEM_DURACAO_ILEGIVEL);
  if (medida > MAX_MEETING_DURATION_SECONDS + FOLGA_DA_DURACAO_MEDIDA_SECONDS) throw new Error(MENSAGEM_REUNIAO_LONGA_DEMAIS);
  return Math.max(1, Math.round(medida));
}

/**
 * Código (não frase) gravado em `processing_error` quando a varredura dá uma
 * reunião como interrompida. Vive em shared/const.ts porque a tela de
 * Reuniões compara com o MESMO valor para traduzi-lo; reexportado daqui para
 * quem trata reuniões não precisar saber onde ele mora.
 */
export { CODIGO_ERRO_INTERROMPIDO };

/**
 * Quanto tempo uma reunião pode ficar em "processing" antes de ser dada como
 * interrompida. O processamento inteiro (upload, Gemini com retentativas,
 * extração com retentativas) cabe em ~2 min; 15 min deixa folga para um pico
 * sem marcar como falha uma reunião que ainda vai terminar. O valor mora em
 * shared/const.ts porque a tela também o usa, para não oferecer "Reprocessar"
 * com o áudio a menos disso de vencer.
 */
export { LIMITE_PROCESSAMENTO_MS };

/**
 * Tamanho das colunas de meeting_contact_suggestions (drizzle/schema.ts). O
 * MySQL do Aiven e o MariaDB do CI rodam em modo estrito: valor maior que a
 * coluna é ERRO ("Data too long"), não corte — e como o insert das sugestões
 * é o último passo, a reunião inteira era marcada como falha depois de já ter
 * pago transcrição e extração. Mesmo padrão de LIMITE_VALOR_POR_CAMPO em
 * enrichment-flow.ts.
 */
export const LIMITE_SUGESTAO = { fullName: 200, jobTitle: 200, company: 200, phone: 50, email: 320 } as const;

/** meeting_entities.normalized_value é varchar(500); `value` é TEXT e não precisa de teto. */
export const LIMITE_VALOR_NORMALIZADO = 500;

/** Motivo gravado quando a dona exclui a reunião enquanto ela ainda processava. */
export const MENSAGEM_EXCLUIDA_DURANTE_PROCESSAMENTO = "Reunião excluída durante o processamento.";

export const ALLOWED_MEETING_AUDIO_TYPES = [
  "audio/webm",
  "audio/ogg",
  "audio/wav",
  "audio/mp4",
  "audio/m4a",
  "audio/mpeg",
] as const;

export type MeetingExtraction = {
  entities: Array<{
    type: "person" | "company" | "phone" | "email" | "role" | "asset" | "need" | "opportunity";
    value: string;
    normalizedValue: string | null;
    confidence: number;
  }>;
  contacts: Array<{
    fullName: string;
    jobTitle: string | null;
    company: string | null;
    phone: string | null;
    email: string | null;
    confidence: number;
    // Meu Network Inteligente (spec da Glenda de 14/09, itens 5 a 9). Opcionais
    // na leitura: uma resposta antiga, ou de um modelo que os omita, continua
    // valendo para a sugestão de contato, só sem pendências de Tenho/Preciso.
    tipoPessoa?: "fisica" | "juridica" | "nao_informado";
    oQueTenho?: ItemProposto[];
    oQuePreciso?: ItemProposto[];
    // Participou da reunião ou só foi citada nela (achado 7 da bancada de
    // 16/11): a citada não vira cartão igual ao das participantes. Ausente
    // numa resposta antiga, ou "unknown", a sugestão fica sem a marca, como antes.
    presence?: PresencaNaReuniao;
  }>;
};

/**
 * "present": participou da reunião; "mentioned": a reunião disse que ela não
 * estava (não veio, vai ser procurada depois); "unknown": só se falou dela,
 * sem dizer se estava — a dúvida, que se grava sem marca (null) e a tela
 * mostra com as participantes. Afirmar a ausência na dúvida punha quem
 * participou em "Pessoas citadas", com o selo "Não participou" (revisão do
 * pacote P2B).
 */
export const PRESENCAS_NA_REUNIAO = ["present", "mentioned", "unknown"] as const;
export type PresencaNaReuniao = (typeof PRESENCAS_NA_REUNIAO)[number];

// Os idiomas da reunião e os nomes que vão no prompt moram em
// shared/idioma-da-reuniao.ts (uma função só, nomeDoIdioma). Os nomes antigos
// seguem exportados para quem já os importa.
export const MEETING_TRANSCRIPT_LANGUAGES = IDIOMAS_DA_REUNIAO;

function now() {
  return Date.now();
}

function extensionForMime(mimeType: string) {
  if (mimeType === "audio/mp4" || mimeType === "audio/m4a") return "m4a";
  if (mimeType === "audio/mpeg") return "mp3";
  if (mimeType === "audio/ogg") return "ogg";
  if (mimeType === "audio/wav") return "wav";
  return "webm";
}

export function decodeMeetingAudio(base64: string, mimeType: string) {
  if (!(ALLOWED_MEETING_AUDIO_TYPES as readonly string[]).includes(mimeType)) {
    throw new Error("Formato de áudio não suportado.");
  }
  // MediaRecorder pode gerar cabeçalhos como
  // data:audio/webm;codecs=opus;base64,... — o cabeçalho inclui parâmetros extras.
  // E o FileReader usa o tipo que o NAVEGADOR dá ao arquivo, não o mimeType
  // que a tela envia: um .mp4/.webm chega como data:video/mp4;base64,... e um
  // arquivo sem tipo como data:application/octet-stream;base64,... — só
  // aceitar "data:audio/" recusava esses como "áudio inválido" (auditoria 04/09).
  // O corte é em ";base64," (não na primeira vírgula): o Chrome grava
  // "video/webm;codecs=vp8,opus", com vírgula dentro do parâmetro.
  const normalized = base64.trim().replace(/^data:.*?;base64,/i, "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) throw new Error("Arquivo de áudio inválido.");
  const audio = Buffer.from(normalized, "base64");
  if (!audio.length || audio.length > MAX_MEETING_AUDIO_BYTES) {
    throw new Error("O áudio deve ter no máximo 10 MB.");
  }
  return audio;
}

// A extração roda dentro do submit síncrono da reunião (proxy do Render,
// ~100 s, já descontada a transcrição): teto por chamada e orçamento total
// mais folgados que os do chat, mas ainda dentro do que a requisição aguenta.
const TIMEOUT_DA_EXTRACAO_MS = 45_000;

/** Um item de O QUE TENHO / O QUE PRECISO, com o trecho literal que o sustenta (network-extracao.ts confere). */
const ITEM_DO_PERFIL = {
  type: "object",
  properties: {
    texto: { type: "string", maxLength: 200 },
    trecho: { type: "string", maxLength: 1000 },
    confianca: { type: "number" },
  },
  required: ["texto", "trecho", "confianca"],
  additionalProperties: false,
} as const;
const ORCAMENTO_DA_EXTRACAO_MS = 60_000;

// O que uma chamada de extração lê. Uma reunião longa (em partes) passa disso e
// é lida inteira, em janelas (G8), em vez de cortada aos 24 mil caracteres.
export const JANELA_DA_EXTRACAO = 24_000;
// Tetos da reunião inteira, depois de juntar as janelas: os de uma janela só
// (80 e 20) multiplicados por elas encheriam a tela de pendências repetidas.
const TETO_DE_ENTIDADES = 200;
const TETO_DE_PESSOAS = 40;

/**
 * Extrai da transcrição INTEIRA: uma chamada por janela (dividirEmJanelas), uma
 * depois da outra, e a junção tira as repetidas. Entidade repetida (mesmo tipo e
 * mesmo valor normalizado) fica com a maior confiança; pessoa repetida (mesmo
 * e-mail, telefone ou nome) junta o que tem e o que precisa das duas janelas.
 * Uma janela que falha derruba a extração inteira: meia reunião extraída
 * passaria por inteira.
 *
 * `rotulada`: cada linha começa pelo rótulo da voz ("{F1}: fala"), como a
 * fila da reunião em partes monta (entradaDoResumo); sem rótulos (envio
 * único), o texto corrido. Com eles, a IA vê quem fala, e a presença de quem
 * só fala sem dizer o nome deixa de ser chute (revisão do pacote P2B).
 */
export async function extractMeetingData(transcript: string, opcoes: { rotulada?: boolean } = {}): Promise<MeetingExtraction> {
  const rotulada = opcoes.rotulada === true;
  const janelas = dividirEmJanelas(transcript, JANELA_DA_EXTRACAO);
  if (janelas.length <= 1) {
    const extracao = await extrairDeUmaJanela(transcript, rotulada);
    return { ...extracao, contacts: semAusenciaDuvidosa(extracao.contacts) };
  }
  const partes: MeetingExtraction[] = [];
  for (const janela of janelas) partes.push(await extrairDeUmaJanela(janela, rotulada));
  return juntarExtracoes(partes);
}

/** A ordem da presença na junção: quem falou em alguma janela participou; a ausência dita vale mais que a dúvida. */
const PESO_DA_PRESENCA: Record<PresencaNaReuniao, number> = { present: 3, mentioned: 2, unknown: 1 };
const pesoDaPresenca = (presenca: unknown) => PESO_DA_PRESENCA[presenca as PresencaNaReuniao] ?? 0;

/**
 * A ausência só fica se nada a desmente. A citada ("mentioned") cujo nome é
 * parte do nome de quem participou, ou o contém ("Ana" e "Ana Ribeiro"), é
 * provavelmente a mesma pessoa vista numa janela sem a apresentação dela: na
 * reunião longa, a janela 2 não vê o "Eu sou a Ana Ribeiro" da janela 1. Ela
 * fica com "unknown" (sem marca, com as participantes), e a tela não afirma
 * que faltou quem estava lá (revisão do pacote P2B). As duas não se juntam:
 * juntar pelo primeiro nome fundiria duas Anas diferentes.
 */
export function semAusenciaDuvidosa<T extends { fullName: string; presence?: PresencaNaReuniao }>(pessoas: T[]): T[] {
  const nomesPresentes = pessoas.filter(p => p.presence === "present").map(p => tokensDoTermo(p.fullName ?? ""));
  const contido = (parte: string[], todo: string[]) => parte.length > 0 && parte.every(palavra => todo.includes(palavra));
  return pessoas.map(pessoa => {
    if (pessoa.presence !== "mentioned") return pessoa;
    const nome = tokensDoTermo(pessoa.fullName ?? "");
    return nomesPresentes.some(presente => contido(nome, presente) || contido(presente, nome)) ? { ...pessoa, presence: "unknown" } : pessoa;
  });
}

export function juntarExtracoes(partes: MeetingExtraction[]): MeetingExtraction {
  const entidades = new Map<string, MeetingExtraction["entities"][number]>();
  for (const entidade of partes.flatMap(p => p.entities)) {
    const chave = `${entidade.type}|${(entidade.normalizedValue || entidade.value).trim().toLocaleLowerCase()}`;
    const atual = entidades.get(chave);
    if (!atual || entidade.confidence > atual.confidence) entidades.set(chave, entidade);
  }
  const pessoas: MeetingExtraction["contacts"] = [];
  for (const pessoa of partes.flatMap(p => p.contacts)) {
    const mesma = pessoas.find(outra => mesmaPessoa(outra, pessoa));
    if (!mesma) {
      pessoas.push({ ...pessoa });
      continue;
    }
    // Cargo e empresa já vêm conferidos pela janela (conferirAJanela): fica o
    // primeiro dito, ou o mais completo ("Ponte Sul Consultoria" no lugar de
    // "Ponte Sul", que é o começo dele).
    mesma.jobTitle = maisCompleto(mesma.jobTitle, pessoa.jobTitle);
    mesma.company = maisCompleto(mesma.company, pessoa.company);
    mesma.phone ??= pessoa.phone;
    mesma.email ??= pessoa.email;
    mesma.confidence = Math.max(mesma.confidence, pessoa.confidence);
    if (!mesma.tipoPessoa || mesma.tipoPessoa === "nao_informado") mesma.tipoPessoa = pessoa.tipoPessoa;
    // Quem participou em alguma janela participou da reunião (citada no
    // começo, chegou depois); a ausência dita numa janela vale mais que a
    // dúvida de outra.
    if (pesoDaPresenca(pessoa.presence) > pesoDaPresenca(mesma.presence)) mesma.presence = pessoa.presence;
    mesma.oQueTenho = semItensRepetidos([...(mesma.oQueTenho ?? []), ...(pessoa.oQueTenho ?? [])]);
    mesma.oQuePreciso = semItensRepetidos([...(mesma.oQuePreciso ?? []), ...(pessoa.oQuePreciso ?? [])]);
  }
  // Acima do teto, ficam as de maior confiança (e não as do começo da reunião).
  const porConfianca = <T extends { confidence: number }>(lista: T[]) => [...lista].sort((a, b) => b.confidence - a.confidence);
  return {
    entities: porConfianca(Array.from(entidades.values())).slice(0, TETO_DE_ENTIDADES),
    contacts: porConfianca(semAusenciaDuvidosa(pessoas)).slice(0, TETO_DE_PESSOAS),
  };
}

/** O primeiro valor, salvo quando o outro é ele mesmo com mais palavras no fim ("Ponte Sul" → "Ponte Sul Consultoria"). */
function maisCompleto(atual: string | null | undefined, outro: string | null | undefined): string | null {
  if (!atual) return outro ?? null;
  if (!outro) return atual;
  const palavras = tokensDoTermo(atual);
  const outras = tokensDoTermo(outro);
  return outras.length > palavras.length && palavras.every((palavra, i) => outras[i] === palavra) ? outro : atual;
}

function semItensRepetidos<T extends { texto: string }>(itens: T[]): T[] {
  const vistos = new Set<string>();
  return itens.filter(item => {
    const chave = item.texto.trim().toLocaleLowerCase();
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
}

function mesmaPessoa(a: MeetingExtraction["contacts"][number], b: MeetingExtraction["contacts"][number]) {
  const igual = (x: string | null | undefined, y: string | null | undefined) => !!x && !!y && x.trim().toLocaleLowerCase() === y.trim().toLocaleLowerCase();
  const soDigitos = (x: string | null | undefined) => (x ?? "").replace(/\D/g, "");
  if (igual(a.email, b.email)) return true;
  if (soDigitos(a.phone).length >= 8 && soDigitos(a.phone) === soDigitos(b.phone)) return true;
  // Pelo nome, só quando nada as distingue: o mesmo nome com e-mail ou telefone
  // diferente são duas pessoas (homônimas), e juntar perderia o contato de uma.
  const conflita = (x: string | null | undefined, y: string | null | undefined, norm: (v: string | null | undefined) => string) => !!norm(x) && !!norm(y) && norm(x) !== norm(y);
  const email = (v: string | null | undefined) => (v ?? "").trim().toLocaleLowerCase();
  return igual(a.fullName, b.fullName) && !conflita(a.email, b.email, email) && !conflita(a.phone, b.phone, soDigitos);
}

/**
 * O que o prompt da extração pede sobre cada pessoa, além das três dimensões.
 * Cargo e empresa passam pela conferência da janela (conferirAJanela) e de
 * gravarResultadoDaReuniao (expressaoEstaNaFonte), e a presença separa, na
 * tela, quem participou de quem a reunião disse que não estava (achados 6 e 7
 * da bancada de 16/11). "mentioned" só com a ausência dita; na dúvida,
 * "unknown", que a tela mostra com as participantes (revisão do pacote P2B).
 * Os exemplos não são os da reunião sintética da bancada nem os do roteiro do
 * teste manual, para não ensinar a prova ao modelo.
 */
export const REGRAS_DA_PESSOA_NA_REUNIAO = `Em "contacts", fullName, phone e email são o QUEM SOU; jobTitle e company ficam só como apoio e nunca substituem O QUE TENHO.
- jobTitle e company só com as palavras ditas na reunião sobre aquela pessoa, copiadas como foram ditas ("diretora comercial", "Vinícola Serra Alta"). Não deduza cargo pelo que a pessoa faz ("fundadora", "consultor") nem complete o nome da empresa. Se não foi dito, null.
- presence diz se a pessoa participou da reunião. "present": ela fala, se apresenta ou é dada como presente ("a Ana e o Bruno estão aqui com a gente"). "mentioned": SÓ quando a reunião diz que ela não está ali: não veio, está fora, ou vai ser procurada ou apresentada depois ("a Carla está viajando", "vou te apresentar a Denise"). "unknown": falam dela, mas ninguém diz se ela está na reunião ("a Luíza cuida do caixa"). Empresa é "present" só se alguém dela participou. Na dúvida, "unknown": nunca diga que alguém não participou sem que isso tenha sido dito.`;

/** Com a transcrição rotulada (a fila da reunião em partes), o que o prompt diz dos rótulos das vozes. */
export const REGRA_DOS_ROTULOS_NA_EXTRACAO = `Cada linha da transcrição começa pelo rótulo de quem fala ({F1}, {F2}...). O rótulo não é nome: nunca o escreva em fullName, em entities, nos itens nem no trecho, que é só a fala. A voz que diz o próprio nome ("{F2}: Meu nome é Paula") é essa pessoa em todas as linhas dela, e quem tem voz na reunião é "present".`;

/** Entidade que é só o rótulo de uma voz ("{F2}", "F2:", "Falante 2"): não é nome de ninguém. */
const SO_ROTULO_DE_VOZ = /^\s*(?:\{?\s*F[1-9]\d?\s*\}?\s*:?|falante\s+\d+)\s*$/i;

/** O texto da janela sem os rótulos das vozes, linha a linha: é contra ele que cargo e empresa se conferem. */
function semRotulosDeVoz(texto: string): string {
  return texto.split("\n").map(limparRotulos).join("\n");
}

/**
 * O que a janela diz, antes da junção das janelas (revisão do pacote P2B):
 * - cargo e empresa só se a própria janela os diz como estão escritos. Na
 *   reunião longa, a junção fica com o primeiro valor que acha (`??=`): um
 *   cargo deduzido na janela 1 ("Consultor") tomava o lugar do dito na
 *   janela 2 ("mentor convidado") e depois caía na conferência de
 *   gravarResultadoDaReuniao, sem deixar nenhum;
 * - com a transcrição rotulada, o rótulo da voz sai do trecho dos itens (a
 *   conferência é contra a transcrição sem rótulos), e a entidade que é só um
 *   rótulo não entra.
 */
export function conferirAJanela(extracao: MeetingExtraction, janela: string, rotulada: boolean): MeetingExtraction {
  const fonte = rotulada ? semRotulosDeVoz(janela) : janela;
  const semRotulo = (itens: ItemProposto[] | undefined) => (rotulada && Array.isArray(itens)
    ? itens.map(item => (item && typeof item.trecho === "string" ? { ...item, trecho: limparRotulos(item.trecho) } : item))
    : itens);
  return {
    entities: rotulada ? extracao.entities.filter(entidade => !SO_ROTULO_DE_VOZ.test(String(entidade?.value ?? ""))) : extracao.entities,
    contacts: extracao.contacts.map(pessoa => ({
      ...pessoa,
      jobTitle: typeof pessoa?.jobTitle === "string" && expressaoEstaNaFonte(pessoa.jobTitle, fonte) ? pessoa.jobTitle : null,
      company: typeof pessoa?.company === "string" && expressaoEstaNaFonte(pessoa.company, fonte) ? pessoa.company : null,
      oQueTenho: semRotulo(pessoa?.oQueTenho),
      oQuePreciso: semRotulo(pessoa?.oQuePreciso),
    })),
  };
}

async function extrairDeUmaJanela(transcript: string, rotulada = false): Promise<MeetingExtraction> {
  // O raciocínio só vai com LLM_RACIOCINIO_EXTRACAO (server/_core/raciocinio-de-ia.ts);
  // sem ela, o pedido sai sem o campo, como sempre saiu.
  const raciocinio = raciocinioDaFuncao("extracao");
  const response = await invokeLLM({
    // Segue o LLM_MODEL; LLM_MODEL_EXTRACAO troca sem deploy (FUNCOES_DE_TEXTO,
    // em _core/modelos-de-ia.ts, diz por que o Lite ainda não é o padrão).
    funcao: "extracao",
    timeoutMs: TIMEOUT_DA_EXTRACAO_MS,
    orcamentoMs: ORCAMENTO_DA_EXTRACAO_MS,
    ...(raciocinio ? { raciocinio } : {}),
    messages: [
      {
        role: "system",
        content: `Você extrai dados de transcrições de reuniões em português. Não invente dados. Retorne somente JSON estruturado.\nPara cada pessoa ou empresa em "contacts": ${REGRAS_DAS_TRES_DIMENSOES}\n${REGRAS_DA_PESSOA_NA_REUNIAO}${rotulada ? `\n${REGRA_DOS_ROTULOS_NA_EXTRACAO}` : ""}`,
      },
      {
        role: "user",
        content: `Extraia pessoas, empresas, telefones, e-mails, cargos, ativos, necessidades e oportunidades desta transcrição:\n\n${transcript.slice(0, JANELA_DA_EXTRACAO)}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "meeting_extraction",
        strict: true,
        schema: {
          type: "object",
          properties: {
            entities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["person", "company", "phone", "email", "role", "asset", "need", "opportunity"] },
                  value: { type: "string" },
                  normalizedValue: { type: ["string", "null"], maxLength: LIMITE_VALOR_NORMALIZADO },
                  confidence: { type: "number" },
                },
                required: ["type", "value", "normalizedValue", "confidence"],
                additionalProperties: false,
              },
            },
            contacts: {
              type: "array",
              items: {
                type: "object",
                // maxLength é um pedido ao modelo; a garantia mesmo é o corte
                // de ajustarSugestaoAosLimites antes do insert.
                properties: {
                  fullName: { type: "string", maxLength: LIMITE_SUGESTAO.fullName },
                  jobTitle: { type: ["string", "null"], maxLength: LIMITE_SUGESTAO.jobTitle },
                  company: { type: ["string", "null"], maxLength: LIMITE_SUGESTAO.company },
                  phone: { type: ["string", "null"], maxLength: LIMITE_SUGESTAO.phone },
                  email: { type: ["string", "null"], maxLength: LIMITE_SUGESTAO.email },
                  confidence: { type: "number" },
                  tipoPessoa: { type: "string", enum: ["fisica", "juridica", "nao_informado"] },
                  oQueTenho: { type: "array", items: ITEM_DO_PERFIL },
                  oQuePreciso: { type: "array", items: ITEM_DO_PERFIL },
                  presence: { type: "string", enum: [...PRESENCAS_NA_REUNIAO] },
                },
                required: ["fullName", "jobTitle", "company", "phone", "email", "confidence", "tipoPessoa", "oQueTenho", "oQuePreciso", "presence"],
                additionalProperties: false,
              },
            },
          },
          required: ["entities", "contacts"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("A IA não retornou uma extração válida.");
  const parsed = JSON.parse(content) as MeetingExtraction;
  return conferirAJanela({
    entities: Array.isArray(parsed.entities) ? parsed.entities.slice(0, 80) : [],
    contacts: Array.isArray(parsed.contacts) ? parsed.contacts.slice(0, 20) : [],
  }, transcript, rotulada);
}

/** Texto cortado no tamanho da coluna; vazio ou ausente vira null. */
function cortar(texto: string | null | undefined, limite: number): string | null {
  if (typeof texto !== "string") return null;
  const aparado = texto.trim();
  return aparado ? aparado.slice(0, limite) : null;
}

/**
 * Telefone e e-mail não se cortam: um número truncado ou um endereço pela
 * metade é lixo com cara de dado, e a dona criaria um contato com ele. Acima
 * do teto o campo fica vazio e a sugestão sobrevive com o resto.
 */
function ouNulo(texto: string | null | undefined, limite: number): string | null {
  const aparado = cortar(texto, Number.MAX_SAFE_INTEGER);
  return aparado && aparado.length <= limite ? aparado : null;
}

/**
 * A sugestão de contato no tamanho que as colunas aceitam. Fica na fronteira
 * com o banco, não na extração: é a coluna que dita o limite, e o modelo não
 * obedece sempre ao maxLength do schema.
 */
export function ajustarSugestaoAosLimites(contato: MeetingExtraction["contacts"][number]) {
  return {
    fullName: cortar(contato.fullName, LIMITE_SUGESTAO.fullName) ?? "",
    jobTitle: cortar(contato.jobTitle, LIMITE_SUGESTAO.jobTitle),
    company: cortar(contato.company, LIMITE_SUGESTAO.company),
    phone: ouNulo(contato.phone, LIMITE_SUGESTAO.phone),
    email: ouNulo(contato.email, LIMITE_SUGESTAO.email),
  };
}

/** Escritas sem espaço entre as palavras: nelas o nome aparece colado ao resto da fala. */
export const ESCRITA_SEM_ESPACO = new RegExp("[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}]", "u");

/**
 * O nome da pessoa sugerida reduzido às palavras que a transcrição sustenta.
 * QUEM SOU não se inventa (spec da Glenda de 14/09, item 6), e o nome é o
 * campo que a tela marca com ✓: a fala diz "falei com o Carlos sobre o
 * galpão", o modelo devolve "Carlos Mendes", e o sobrenome inventado ia para
 * o contato criado e para a pendência de nome do "Vincular".
 *
 * Cada palavra fica só se todos os pedaços dela aparecem, como palavra, na
 * transcrição (em chinês, japonês e tailandês, que não separam palavras,
 * basta aparecer no texto). Quando alguma palavra sai, as palavras curtas
 * das pontas saem junto ("Carlos de [Mendes]" vira "Carlos"). O resultado
 * precisa ter ao menos uma palavra de 3+ letras, a mesma exigência de
 * nomeEstaNaFonte (network-extracao.ts); se não tiver, devolve "" e a
 * sugestão não entra.
 */
export function nomeSustentadoPelaTranscricao(nome: string, transcricao: string): string {
  const tokensDaFonte = tokensDoTermo(transcricao);
  const daFonte = new Set(tokensDaFonte);
  const fonteCorrida = tokensDaFonte.join(" ");
  const sustentada = (palavra: string) => {
    const tokens = tokensDoTermo(palavra);
    return tokens.length > 0 && tokens.every(t => daFonte.has(t) || (ESCRITA_SEM_ESPACO.test(t) && fonteCorrida.includes(t)));
  };
  const significativa = (palavra: string) => tokensDoTermo(palavra).some(t => t.length >= 3 || ESCRITA_SEM_ESPACO.test(t));

  const palavras = nome.trim().split(/\s+/).filter(Boolean);
  const mantidas = palavras.filter(sustentada);
  if (!mantidas.some(significativa)) return "";
  if (mantidas.length === palavras.length) return nome.trim();
  let inicio = 0;
  let fim = mantidas.length;
  while (!significativa(mantidas[inicio])) inicio++;
  while (!significativa(mantidas[fim - 1])) fim--;
  return mantidas.slice(inicio, fim).join(" ");
}

// A tradução pede a transcrição INTEIRA de volta: até 48 000 caracteres de
// entrada viram ~12 000 tokens de saída (≈ 4 caracteres por token), e a
// 150–250 tokens/s são 48–80 s só de geração, antes da leitura da entrada. O
// padrão de 60 s por tentativa estourava no meio e o orçamento de 120 s não
// cabia uma 2ª tentativa inteira — a tradução longa nunca terminava. 180 s
// cobre o pior caso com folga; os 200 s de orçamento só dão retentativa a
// uma falha rápida (5xx, conexão recusada), não a outra geração inteira.
const TIMEOUT_DA_TRADUCAO_MS = 180_000;
const ORCAMENTO_DA_TRADUCAO_MS = 200_000;

/**
 * `antesDeChamarAIA` roda só quando a tradução não está guardada, logo antes
 * do pedido à IA, e pode recusar lançando: é o teto do link aberto, que assim
 * não gasta vaga com a tradução que já está no banco.
 */
export async function translatePrivateMeetingTranscript(ownerId: string, meetingId: string, language: string, antesDeChamarAIA?: () => void) {
  const normalizedLanguage = idiomaDaReuniao(language);
  if (!normalizedLanguage) throw new Error("Idioma de tradução não suportado.");
  const targetLanguage = nomeDoIdioma(normalizedLanguage);
  const db = await exigirDb();
  const [transcript] = await db.select().from(meetingTranscripts)
    .where(and(eq(meetingTranscripts.ownerId, ownerId), eq(meetingTranscripts.meetingId, meetingId))).limit(1);
  if (!transcript) throw new Error("Transcrição não encontrada.");
  // O original é o idioma em que a reunião foi transcrita, e não o pt-BR: uma
  // reunião em inglês "traduzida" para pt-BR voltava em inglês. Reunião antiga
  // guarda 'pt', e idioma gravado fora da lista conta como pt-BR, o padrão de
  // quando ela foi gravada.
  const idiomaOriginal = idiomaDaReuniao(transcript.language) ?? IDIOMA_DA_REUNIAO_PADRAO;
  if (normalizedLanguage === idiomaOriginal) {
    return { language: normalizedLanguage, text: transcript.transcript, cached: true };
  }
  const [cached] = await db.select().from(meetingTranscriptTranslations)
    .where(and(
      eq(meetingTranscriptTranslations.ownerId, ownerId),
      eq(meetingTranscriptTranslations.meetingId, meetingId),
      eq(meetingTranscriptTranslations.language, normalizedLanguage),
    )).limit(1);
  if (cached) return { language: normalizedLanguage, text: cached.translatedText, cached: true };

  // Quem pede a mesma tradução enquanto a primeira ainda está na IA (duas
  // pessoas abrindo o link aberto em inglês, a mesma página recarregada) espera
  // por ela, sem pagar outra chamada nem gastar vaga do teto.
  const chave = [ownerId, meetingId, normalizedLanguage, transcript.id].join("\u0000");
  const janelas = dividirEmJanelas(transcript.transcript, JANELA_DA_TRADUCAO);
  const longa = janelas.length > 1;
  const emAndamento: TraducaoEmAndamento = { language: normalizedLanguage, text: null, cached: false, emAndamento: true };
  const emCurso = traducoesEmCurso.get(chave);
  if (emCurso) return longa ? emAndamento : emCurso;
  // A tradução longa que falhou em segundo plano: o próximo pedido recebe o
  // erro (uma vez), em vez de recomeçar a tradução em silêncio a cada 5 s.
  const falha = falhasDaTraducaoLonga.get(chave);
  if (falha) {
    falhasDaTraducaoLonga.delete(chave);
    if (Date.now() - falha.quando < VALIDADE_DA_FALHA_MS) throw falha.erro;
  }
  antesDeChamarAIA?.();
  const trabalho = traduzirEGuardar(db, { ownerId, meetingId, normalizedLanguage, targetLanguage, transcript, janelas });
  traducoesEmCurso.set(chave, trabalho);
  if (longa) {
    // Reunião longa: uma chamada por janela leva minutos, mais que o proxy do
    // Render aguenta. A tradução segue em segundo plano, e a tela pergunta de
    // novo até ela estar guardada. O trabalho nunca rejeita solto (derrubaria o
    // processo): a falha fica guardada para o próximo pedido.
    trabalho.then(
      () => traducoesEmCurso.delete(chave),
      erro => {
        traducoesEmCurso.delete(chave);
        // descreverErroDeBanco: a mensagem crua do driver traz o SQL com os
        // valores, e o valor aqui é a tradução da reunião.
        console.error("[Reuniões] a tradução longa falhou:", descreverErroDeBanco(erro));
        if (falhasDaTraducaoLonga.size >= TETO_DE_FALHAS_GUARDADAS) falhasDaTraducaoLonga.clear();
        falhasDaTraducaoLonga.set(chave, { erro: erro instanceof Error ? erro : new Error("Não foi possível traduzir a transcrição."), quando: Date.now() });
      },
    );
    return emAndamento;
  }
  try {
    return await trabalho;
  } finally {
    traducoesEmCurso.delete(chave);
  }
}

// O que uma chamada de tradução lê e devolve. Mais que isso não cabe com folga
// na saída do modelo: a reunião longa é traduzida em janelas, uma por chamada.
export const JANELA_DA_TRADUCAO = 20_000;

type TraducaoPronta = { language: string; text: string; cached: boolean; emAndamento?: false };
type TraducaoEmAndamento = { language: string; text: null; cached: false; emAndamento: true };
export type TraducaoDaTranscricao = TraducaoPronta | TraducaoEmAndamento;

// As traduções que estão na IA agora, por dona, reunião, idioma e transcrição.
// Em memória, como os tetos: basta à instância única do Render. Um deploy no
// meio perde a tradução longa em curso, e o próximo pedido a recomeça.
const traducoesEmCurso = new Map<string, Promise<TraducaoPronta>>();
// A falha da tradução longa vale para o próximo pedido por pouco tempo: quem
// volta horas depois recomeça, sem receber um erro velho. O teto protege a
// memória do processo de falhas que ninguém veio buscar.
const falhasDaTraducaoLonga = new Map<string, { erro: Error; quando: number }>();
const VALIDADE_DA_FALHA_MS = 2 * 60_000;
const TETO_DE_FALHAS_GUARDADAS = 200;

async function traduzirEGuardar(db: Banco, alvo: {
  ownerId: string;
  meetingId: string;
  normalizedLanguage: string;
  targetLanguage: string;
  transcript: { id: string; transcript: string };
  janelas: string[];
}): Promise<TraducaoPronta> {
  const { ownerId, meetingId, normalizedLanguage, targetLanguage, transcript, janelas } = alvo;
  // Uma janela por vez, na ordem: o texto traduzido é a junção delas. Janela
  // que volta vazia derruba a tradução inteira, em vez de guardar um buraco.
  const traduzidas: string[] = [];
  for (const janela of janelas) {
    const response = await invokeLLM({
      timeoutMs: TIMEOUT_DA_TRADUCAO_MS,
      orcamentoMs: ORCAMENTO_DA_TRADUCAO_MS,
      messages: [
        { role: "system", content: `Traduza a transcrição a seguir para ${targetLanguage}. Preserve nomes próprios, empresas, números, telefones, e-mails e a estrutura dos parágrafos. Não resuma, não explique e não adicione informações.${janelas.length > 1 ? " O texto é um trecho de uma reunião maior: traduza só ele, sem introdução nem fecho." : ""}` },
        { role: "user", content: janela },
      ],
    });
    const traduzida = String(response.choices?.[0]?.message?.content ?? "").trim();
    if (!traduzida) throw new Error("Não foi possível traduzir a transcrição.");
    traduzidas.push(traduzida);
  }
  const translatedText = traduzidas.join("\n");
  // A tradução leva até 3 min, e nesse meio-tempo um reprocessamento pode ter
  // trocado a transcrição (apaga a antiga e as traduções dela, grava a nova).
  // Gravar agora poria no cache a tradução do texto VELHO, e o UNIQUE
  // (owner, meeting, language) barraria para sempre a tradução certa. Se a
  // transcrição já não é a mesma, a resposta vai para quem pediu, sem cache.
  const [aindaAMesma] = await db.select({ id: meetingTranscripts.id }).from(meetingTranscripts)
    .where(and(eq(meetingTranscripts.ownerId, ownerId), eq(meetingTranscripts.meetingId, meetingId))).limit(1);
  if (aindaAMesma?.id !== transcript.id) return { language: normalizedLanguage, text: translatedText, cached: false };
  const timestamp = now();
  try {
    await db.insert(meetingTranscriptTranslations).values({
      id: crypto.randomUUID(),
      meetingId,
      ownerId,
      language: normalizedLanguage,
      translatedText,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  } catch (erro) {
    // Outro pedido guardou a mesma tradução primeiro (um que não passou pela
    // espera acima, como o de antes de um deploy): o UNIQUE recusa a segunda
    // cópia, e quem pediu recebe a que já foi paga, em vez de um erro.
    if (!ehColisaoDeChave(erro)) throw erro;
  }
  return { language: normalizedLanguage, text: translatedText, cached: false };
}

/**
 * Linhas afetadas por um UPDATE/DELETE do driver mysql2 (`[ResultSetHeader,
 * FieldPacket[]]`). Zero quando o resultado não tem essa forma — o que, para
 * quem decide "a linha ainda existia?", é a resposta segura.
 */
function linhasAfetadas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const linhas = (cabecalho as { affectedRows?: unknown } | null | undefined)?.affectedRows;
  return typeof linhas === "number" ? linhas : 0;
}

/**
 * O que vai para `processing_error` — texto que a tela mostra à dona.
 *
 * Erro do driver fica FORA: a mensagem de um DrizzleQueryError é o INSERT
 * inteiro com os parâmetros, ou seja, nome, cargo, telefone e e-mail das
 * pessoas da reunião (ou a transcrição). O errorFormatter do tRPC mascara
 * isso quando viaja como erro; aqui viajava como DADO, por `meetings.get`, e
 * a caixa vermelha renderizava o SQL. O detalhe vai ao log, sem parâmetros.
 * Erros nossos e do Gemini são frases pensadas para a dona ("Arquivo de
 * áudio inválido.", "O áudio deve ter no máximo 10 MB.") e continuam inteiras.
 */
export function mensagemDaFalha(error: unknown): string {
  if (ehErroDoDriverDeBanco(error)) {
    console.error("[Reuniões] falha de banco no processamento:", descreverErroDeBanco(error));
    return MENSAGEM_ERRO_DE_CONSULTA;
  }
  return error instanceof Error ? error.message.slice(0, 1000) : "Falha no processamento";
}

/**
 * O `processing_error` que pode ir para a tela.
 *
 * mensagemDaFalha protege as gravações NOVAS; esta função protege a LEITURA
 * das antigas: antes dela, a mensagem do driver ia inteira para a coluna, e
 * há linhas em produção guardando "Failed query: insert into ... params: ..."
 * com nome, telefone e e-mail das pessoas da reunião. Limpar a coluna no
 * banco depende do Roberto; até lá, quem lê mascara. Só o prefixo do
 * DrizzleQueryError é reconhecido de propósito: as demais mensagens são
 * frases (ou o código ERRO_INTERROMPIDO) escritas para a dona.
 */
export function processingErrorSeguro(processingError: string | null): string | null {
  if (processingError?.startsWith("Failed query")) return MENSAGEM_ERRO_DE_CONSULTA;
  return processingError;
}

/** A dona excluiu a reunião no meio: não é falha a registrar, é trabalho a descartar. */
export class ReuniaoExcluidaDuranteProcessamento extends Error {
  constructor() {
    super(MENSAGEM_EXCLUIDA_DURANTE_PROCESSAMENTO);
    this.name = "ReuniaoExcluidaDuranteProcessamento";
  }
}

/**
 * O envio chegou a uma reunião que já não espera áudio: duplo clique, segunda
 * aba, ou reenvio depois de a primeira execução já ter tomado a reunião. O
 * router traduz em CONFLICT — antes de qualquer upload ou chamada de IA.
 */
export class ReuniaoForaDoEstado extends Error {
  constructor() {
    super("Esta reunião já recebeu um áudio.");
    this.name = "ReuniaoForaDoEstado";
  }
}

/**
 * Outra execução tomou a reunião enquanto esta esperava a IA: um
 * reprocessamento novo, ou a varredura de interrompidas, que a deu como falha.
 * A reunião agora é de quem tem a ficha nova, e esta execução sai sem escrever
 * nada — nem transcrição, nem 'ready', nem 'failed'.
 */
export class ReuniaoTomadaPorOutraExecucao extends Error {
  constructor() {
    super("O processamento desta reunião foi substituído por outra tentativa.");
    this.name = "ReuniaoTomadaPorOutraExecucao";
  }
}

/** Por que um pedido de reprocessamento foi recusado. O router traduz o código em TRPCError. */
export class ReprocessamentoRecusado extends Error {
  readonly codigo: "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED";
  constructor(codigo: "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED", mensagem: string) {
    super(mensagem);
    this.name = "ReprocessamentoRecusado";
    this.codigo = codigo;
  }
}

export const MENSAGEM_REUNIAO_NAO_ENCONTRADA = "Reunião não encontrada.";
export const MENSAGEM_REPROCESSO_EM_CONFLITO = "Esta reunião não está com falha ou já está sendo processada.";
export const MENSAGEM_SEM_AUDIO_PARA_REPROCESSAR = "Não há áudio guardado desta reunião para reprocessar.";
// A tela do site reconhece esta frase (shared/const.ts) para traduzi-la e para
// não oferecer de novo um reprocessamento que não tem áudio para ler.
export { MENSAGEM_AUDIO_GUARDADO_AUSENTE };
export const MENSAGEM_AUDIO_GUARDADO_ILEGIVEL = "Não foi possível ler o áudio guardado.";
const MENSAGEM_SEM_CONSENTIMENTO = "O consentimento para gravação é obrigatório.";

type Banco = Awaited<ReturnType<typeof exigirDb>>;
type Reuniao = typeof meetings.$inferSelect;
type Gravacao = typeof meetingRecordings.$inferSelect;

/**
 * A FICHA de uma execução: o `updated_at` que ela grava ao tomar a reunião
 * para 'processing'. Toda escrita de status dessa execução — releitura,
 * 'ready' e 'failed' — exige `status = 'processing' AND updated_at = ficha`.
 * Quem tomou a reunião depois (um reprocessamento novo, ou a varredura de
 * interrompidas, que grava updated_at novo) invalida a ficha antiga: a
 * execução velha acorda e não sobrescreve nada. Sem coluna nova, sem migração.
 *
 * Estritamente maior que o updated_at lido, para duas tomadas no mesmo
 * milissegundo nunca ganharem a mesma ficha.
 */
function fichaDeProcessamento(updatedAtLido: unknown): number {
  const anterior = Number(updatedAtLido);
  return Math.max(now(), Number.isFinite(anterior) ? anterior + 1 : 0);
}

/**
 * confidence é decimal(4,3): um valor que não é número ('alta', NaN) viraria o
 * texto 'NaN', que o banco em modo estrito recusa — e a reunião falharia de
 * novo a cada reprocessamento, sempre depois de pagar a IA. Sem número, grava 0.
 */
function confiancaParaGravar(valor: unknown): string {
  const numero = Number(valor);
  return (Number.isFinite(numero) ? Math.max(0, Math.min(1, numero)) : 0).toFixed(3);
}

/**
 * Marca a falha só se a reunião ainda é desta execução. Com 0 linhas vale o
 * que outra execução, a varredura ou a exclusão já gravou. A mensagem passa
 * por mensagemDaFalha: erro do driver nunca vira texto na tela.
 */
async function marcarFalhaComFicha(db: Banco, ownerId: string, meetingId: string, ficha: number, erro: unknown) {
  await db.update(meetings).set({
    status: "failed",
    processingError: mensagemDaFalha(erro),
    updatedAt: now(),
  }).where(and(
    eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId),
    eq(meetings.status, "processing"), eq(meetings.updatedAt, ficha),
  ));
}

export async function processMeetingRecording(input: {
  meetingId: string;
  ownerId: string;
  audioBase64: string;
  mimeType: string;
  durationSeconds: number;
  language: string;
}) {
  if (input.durationSeconds < 1 || input.durationSeconds > MAX_MEETING_DURATION_SECONDS) {
    throw new Error(MENSAGEM_REUNIAO_LONGA_DEMAIS);
  }
  const db = await exigirDb();
  const [meeting] = await db.select().from(meetings).where(and(eq(meetings.id, input.meetingId), eq(meetings.ownerId, input.ownerId))).limit(1);
  if (!meeting) throw new Error(MENSAGEM_REUNIAO_NAO_ENCONTRADA);
  if (!meeting.consentGranted) throw new Error(MENSAGEM_SEM_CONSENTIMENTO);

  // A decodificação também marca a reunião como falha: fora do try, um áudio
  // recusado deixava a reunião recém-criada em "Gravação pendente" para
  // sempre, sem erro registrado e sem como a usuária tentar de novo. Só vale
  // para a reunião que ainda espera áudio ('recording'): um reenvio com áudio
  // ruim não rebaixa reunião pronta, nem a que outra execução processa — e,
  // como 'deleted' não é 'recording', a falha não ressuscita reunião excluída.
  // A duração declarada pela tela só serve de filtro barato acima; a que vale
  // (limite, gravação, transcrição e contador) é a medida nos bytes.
  let audio: Buffer;
  let duracaoMedida: number;
  try {
    audio = decodeMeetingAudio(input.audioBase64, input.mimeType);
    duracaoMedida = duracaoConferidaDoAudio(audio);
  } catch (error) {
    await db.update(meetings).set({
      status: "failed",
      processingError: mensagemDaFalha(error),
      updatedAt: now(),
    }).where(and(eq(meetings.id, input.meetingId), eq(meetings.ownerId, input.ownerId), eq(meetings.status, "recording")));
    throw error;
  }

  // A tomada: só UMA execução leva a reunião de 'recording' a 'processing', e
  // a ficha gravada nela é o que as escritas seguintes conferem. Com 0 linhas
  // a reunião já recebeu áudio (duplo clique, outra aba, reenvio): sai antes
  // do upload e da IA, sem segundo objeto no bucket nem segunda gravação.
  const ficha = fichaDeProcessamento(meeting.updatedAt);
  const tomada = await db.update(meetings).set({ status: "processing", processingError: null, updatedAt: ficha })
    .where(and(eq(meetings.id, input.meetingId), eq(meetings.ownerId, input.ownerId), eq(meetings.status, "recording")));
  if (!linhasAfetadas(tomada)) throw new ReuniaoForaDoEstado();

  try {
    // Frases neutras para a tela: a mensagem do S3/B2 ou do provedor de IA
    // traz endpoint, bucket, JSON do provedor — nada que ajude a dona. O
    // original fica no log e em `cause`.
    let uploaded: Awaited<ReturnType<typeof storagePut>>;
    try {
      uploaded = await storagePut(
        `meetings/${input.ownerId}/${input.meetingId}/recording.${extensionForMime(input.mimeType)}`,
        audio,
        input.mimeType,
      );
    } catch (erro) {
      console.error("[Reuniões] o bucket recusou o áudio:", erro instanceof Error ? erro.message : erro);
      throw new Error("Não foi possível guardar o áudio.", { cause: erro });
    }
    try {
      await db.insert(meetingRecordings).values({
        id: crypto.randomUUID(),
        meetingId: input.meetingId,
        ownerId: input.ownerId,
        storageKey: uploaded.key,
        storageUrl: uploaded.url,
        mimeType: input.mimeType,
        sizeBytes: audio.length,
        durationSeconds: duracaoMedida,
        expiresAt: ficha + MEETING_AUDIO_TTL_MS,
        createdAt: ficha,
      });
    } catch (erro) {
      // Objeto no bucket sem linha no banco não é achado por varredura
      // nenhuma: a voz ficaria lá para sempre. Sai antes de a falha ser marcada
      // (trazido da PR #134). Se o bucket também recusar, não há linha para
      // servir de ponteiro (foi o banco que recusou), e o log de erro é o único
      // lugar que ainda diz qual objeto precisa sair à mão.
      if (!(await apagarArquivoDaGravacao(uploaded.key))) {
        console.error(`[Reuniões] o áudio ficou no bucket SEM ponteiro no banco (reunião ${input.meetingId}); remoção manual: ${uploaded.key}`);
      }
      throw erro;
    }

    return await processarAudioGuardado(db, {
      meetingId: input.meetingId,
      ownerId: input.ownerId,
      audio,
      mimeType: input.mimeType,
      durationSeconds: duracaoMedida,
      language: input.language,
      ficha,
      limparAntes: false,
    });
  } catch (error) {
    // Excluída no meio, ou tomada por outra execução: não há falha DESTA
    // execução a registrar. Nos outros casos a falha só é gravada se a reunião
    // ainda for desta execução.
    if (!(error instanceof ReuniaoExcluidaDuranteProcessamento) && !(error instanceof ReuniaoTomadaPorOutraExecucao)) {
      await marcarFalhaComFicha(db, input.ownerId, input.meetingId, ficha, error);
    }
    throw error;
  }
}

/**
 * O miolo do processamento, a partir de um áudio que JÁ está guardado no
 * bucket e em meeting_recordings: transcrição, extração, releitura, escritas e
 * promoção. Serve ao envio original (logo depois do upload) e ao
 * reprocessamento (com os bytes lidos de volta do bucket). Nunca grava áudio,
 * nunca mexe na gravação nem no prazo de 30 dias dela.
 *
 * `limparAntes`: no reprocessamento a reunião pode ter derivados de uma
 * tentativa que falhou no meio (transcrição gravada e sugestões não, por
 * exemplo). Eles saem DEPOIS de a IA dar certo — se a IA falhar de novo, a dona
 * não perde o que tinha — e ANTES dos inserts, que senão violariam o UNIQUE de
 * meeting_transcripts.meeting_id e duplicariam entidades e sugestões.
 */
async function processarAudioGuardado(db: Banco, execucao: {
  meetingId: string;
  ownerId: string;
  audio: Buffer;
  mimeType: string;
  durationSeconds: number;
  language: string;
  ficha: number;
  limparAntes: boolean;
}) {
  const { meetingId, ownerId, ficha } = execucao;

  // Defesa em profundidade sobre gemini.ts: GeminiIndisponivelError (e as
  // subclasses de cota e de recusa) já carregam frases para a dona e passam
  // inteiras. Qualquer outro erro — chave não configurada (a mensagem cita
  // LLM_API_KEY e GOOGLE_API_KEY), resposta sem transcrição, um erro novo
  // que alguém venha a lançar lá — vira frase neutra, com o original no
  // log e em `cause`.
  let transcription: Awaited<ReturnType<typeof transcribeWithGemini>>;
  try {
    transcription = await transcribeWithGemini({
      audio: execucao.audio,
      mimeType: execucao.mimeType,
      language: execucao.language,
    });
  } catch (erro) {
    if (erro instanceof GeminiIndisponivelError) throw erro;
    console.error("[Reuniões] a transcrição falhou:", erro instanceof Error ? erro.message : erro);
    throw new Error("Não foi possível transcrever o áudio.", { cause: erro });
  }

  const extraction = await extrairDadosDaReuniao(transcription.text);
  return gravarResultadoDaReuniao(db, {
    meetingId, ownerId, ficha,
    limparAntes: execucao.limparAntes,
    durationSeconds: execucao.durationSeconds,
    transcription,
    extraction,
  });
}

/** A extração da transcrição, com frase neutra na falha (o original vai ao log e a `cause`). */
export async function extrairDadosDaReuniao(texto: string, opcoes: { rotulada?: boolean } = {}): Promise<MeetingExtraction> {
  try {
    return await extractMeetingData(texto, opcoes);
  } catch (erro) {
    console.error("[Reuniões] a extração falhou:", erro instanceof Error ? erro.message : erro);
    throw new Error("O serviço de IA não conseguiu extrair os dados da transcrição.", { cause: erro });
  }
}

/**
 * O fim do processamento, com a transcrição e a extração prontas: releitura,
 * escritas e promoção a 'ready', tudo arbitrado pela FICHA (o updated_at que a
 * execução gravou ao tomar a reunião para 'processing'). Serve ao envio único
 * (processarAudioGuardado, logo depois da IA) e à fila da reunião em partes
 * (server/fila-de-transcricao.ts, depois de montar a transcrição das partes).
 */
export async function gravarResultadoDaReuniao(db: Banco, execucao: {
  meetingId: string;
  ownerId: string;
  ficha: number;
  limparAntes: boolean;
  durationSeconds: number;
  transcription: { text: string; segments: unknown; language: string };
  extraction: MeetingExtraction;
}) {
  const { meetingId, ownerId, ficha, transcription, extraction } = execucao;

  // Entre a tomada e aqui passaram 1–2 minutos de Gemini e LLM: tempo de sobra
  // para a dona ter clicado em Excluir, para um reprocessamento novo ou para a
  // varredura de interrompidas. A reunião é relida ANTES do bloco de escritas.
  // Ausente ou 'deleted': a exclusão venceu, e o que a execução gravou sai.
  // Outro status ou outra ficha: a reunião não é mais desta execução — o
  // trabalho é descartado sem escrever, e a reunião continua reprocessável a
  // partir do áudio guardado.
  const [viva] = await db.select({ status: meetings.status, updatedAt: meetings.updatedAt }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1);
  if (!viva || viva.status === "deleted") {
    await apagarDerivadosDaReuniao(db, ownerId, meetingId);
    throw new ReuniaoExcluidaDuranteProcessamento();
  }
  if (viva.status !== "processing" || Number(viva.updatedAt) !== ficha) throw new ReuniaoTomadaPorOutraExecucao();

  if (execucao.limparAntes) await apagarDerivadosSemGravacao(db, ownerId, meetingId);

  const completedAt = now();
  // O resumo guardado (mais abaixo) nasce apontando para esta transcrição.
  const transcriptId = crypto.randomUUID();
  await db.insert(meetingTranscripts).values({
    id: transcriptId,
    meetingId,
    ownerId,
    transcript: transcription.text,
    segments: transcription.segments,
    language: transcription.language,
    durationSeconds: Math.round(execucao.durationSeconds),
    createdAt: completedAt,
    updatedAt: completedAt,
  });
  if (extraction.entities.length) {
    await db.insert(meetingEntities).values(extraction.entities.map(entity => ({
      id: crypto.randomUUID(), meetingId, ownerId,
      entityType: entity.type, value: entity.value, normalizedValue: cortar(entity.normalizedValue, LIMITE_VALOR_NORMALIZADO),
      confidence: confiancaParaGravar(entity.confidence), status: "pending" as const,
      createdAt: completedAt, updatedAt: completedAt,
    })));
  }
  // Sugestão sem nome (o modelo devolve "" ou só espaços apesar do schema)
  // não entra: full_name é NOT NULL e o "" passaria, virando um cartão
  // "Criar contato" sem ninguém para criar. O filtro é DEPOIS do ajuste,
  // que é quem apara os espaços.
  //
  // QUEM SOU não se inventa (spec da Glenda de 14/09, item 6): o nome fica só
  // com as palavras que a transcrição sustenta (sem nenhuma, a sugestão não
  // entra), e telefone e e-mail que ela não sustenta ficam vazios, para a dona
  // completar — o modelo às vezes "completa" um sobrenome ou um número, ou
  // monta um e-mail com o nome da empresa. O que a pessoa TEM e PRECISA vira
  // pendência à parte (network_sugestoes), só com trecho literal conferido.
  //
  // Cargo e empresa também (achado 6 da bancada de 16/11): ficam só se a
  // transcrição os diz como estão escritos ("fundadora" e "Consultor", que
  // ninguém disse, caem), e nem assim entram sozinhos no contato — criar ou
  // vincular a pessoa os transforma em pendências (meetings.decideContactSuggestion).
  // A presença (achado 7) separa, na tela, quem participou de quem só foi citado.
  const sugestoes = extraction.contacts
    .map(contact => {
      const ajustada = ajustarSugestaoAosLimites(contact);
      return {
        ...ajustada,
        fullName: nomeSustentadoPelaTranscricao(ajustada.fullName, transcription.text),
        // A conferência é do valor inteiro que a IA deu; o corte para a coluna vem
        // depois. Conferido já cortado, o cargo ou a empresa acima do teto nunca
        // estaria na transcrição e sumia.
        jobTitle: ajustada.jobTitle && expressaoEstaNaFonte(contact.jobTitle, transcription.text) ? ajustada.jobTitle : null,
        company: ajustada.company && expressaoEstaNaFonte(contact.company, transcription.text) ? ajustada.company : null,
        phone: telefoneEstaNaFonte(ajustada.phone, transcription.text) ? ajustada.phone : null,
        email: emailEstaNaFonte(ajustada.email, transcription.text) ? ajustada.email : null,
        // Valor fora dos dois (o modelo nem sempre obedece ao enum) fica sem marca, como a sugestão antiga.
        presence: contact.presence === "present" || contact.presence === "mentioned" ? contact.presence : null,
        id: crypto.randomUUID(),
        confidence: contact.confidence,
        pendencias: pendenciasDaPessoaNaReuniao(contact, transcription.text),
      };
    })
    .filter(contact => contact.fullName);
  if (sugestoes.length) {
    await db.insert(meetingContactSuggestions).values(sugestoes.map(contact => ({
      id: contact.id, meetingId, ownerId,
      fullName: contact.fullName, jobTitle: contact.jobTitle, company: contact.company,
      phone: contact.phone, email: contact.email, presence: contact.presence, sourceEntityIds: [],
      confidence: confiancaParaGravar(contact.confidence), status: "pending" as const,
      createdAt: completedAt, updatedAt: completedAt,
    })));
    for (const contact of sugestoes) {
      await gravarPendencias(db, {
        ownerId, origem: "reuniao", contactId: null, meetingId, meetingSuggestionId: contact.id, linhas: contact.pendencias,
      });
    }
  }
  // Contador de minutos do Meu Network Inteligente (itens 4 e 19). ANTES da
  // promoção, no bloco de escritas da ficha: gravado depois do 'ready', uma
  // queda do banco entre os dois perdia a linha para sempre — reunião pronta
  // não se reprocessa, e resumoDeMinutos subcontava o mês. Aqui, banco fora do
  // ar derruba a execução, a reunião vira falha e o reprocessamento conta;
  // o índice único (dona, origem, referência) impede contar duas vezes, e
  // exclusão no meio não apaga a linha, porque a IA já transcreveu. Outro erro
  // (o banco respondeu) não tira da dona a reunião pronta: fica no log.
  try {
    await registrarConsumoDeMinutos(db, { ownerId, origem: "reuniao", referencia: meetingId, segundos: execucao.durationSeconds });
  } catch (erro) {
    if (ehErroDeBancoIndisponivel(erro)) throw erro;
    console.warn("[Reuniões] o contador de minutos não registrou esta reunião:", erro instanceof Error ? erro.message : erro);
  }
  // O resumo guardado (H4): toda reunião que fica pronta ganha o pedido, e a
  // fila do resumo (server/fila-do-resumo.ts) o gera em segundo plano. Serve ao
  // envio único, às partes e ao reprocesso, que passam todos por aqui. Fica no
  // bloco de escritas da ficha, antes do 'ready': a fila só pega resumo de
  // reunião pronta, e a exclusão no meio leva a linha com os outros derivados
  // (apagarDerivadosDaReuniao). No reprocesso, a linha antiga já saiu em
  // apagarDerivadosSemGravacao. Idempotente pelo índice único da reunião: a
  // linha que já existir fica como está, e a reunião não falha por causa dela
  // (nenhum caminho de hoje a cria antes: pedir o resumo exige a reunião
  // 'ready', e esta execução ainda está em 'processing').
  await db.insert(meetingSummaries).values({
    id: crypto.randomUUID(), meetingId, ownerId, transcriptId, status: "pending", createdAt: completedAt, updatedAt: completedAt,
  }).onDuplicateKeyUpdate({ set: { meetingId: sql`${meetingSummaries.meetingId}` } });
  // A releitura acima e este UPDATE não são atômicos: exclusão, reprocessamento
  // novo ou varredura podem ter entrado entre os dois. O WHERE com a ficha faz
  // o banco arbitrar. Zero linhas: relê para saber quem venceu. Excluída, o
  // que acabou de ser gravado sai. Viva com outra ficha, nada é apagado aqui —
  // a execução dona da reunião limpa antes de gravar o resultado dela.
  // Reprocessar zera os nomes das vozes (H3): a transcrição nova renumera as
  // vozes (a Ana de F1 pode virar F2), e o nome velho cairia na voz errada.
  const promovida = await db.update(meetings).set({ status: "ready", processingError: null, updatedAt: completedAt, ...(execucao.limparAntes ? { speakerNames: null } : {}) })
    .where(and(
      eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId),
      eq(meetings.status, "processing"), eq(meetings.updatedAt, ficha),
    ));
  if (!linhasAfetadas(promovida)) {
    const [depois] = await db.select({ status: meetings.status }).from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1);
    if (!depois || depois.status === "deleted") {
      await apagarDerivadosDaReuniao(db, ownerId, meetingId);
      throw new ReuniaoExcluidaDuranteProcessamento();
    }
    console.warn("[Reuniões] outra execução tomou a reunião no fim do processamento; o resultado desta fica para a próxima tentativa limpar.");
    throw new ReuniaoTomadaPorOutraExecucao();
  }
  return { transcript: transcription.text, extraction };
}

/**
 * Recusa pelo STATUS de uma reunião que existe, na ordem que a tela precisa
 * para dizer a verdade: nunca recebeu áudio, não está com falha (ou já está
 * sendo processada), ou está sem consentimento. `null` quando pode seguir.
 */
function recusaPeloStatus(meeting: Reuniao): ReprocessamentoRecusado | null {
  if (meeting.status === "recording" || meeting.status === "draft") {
    return new ReprocessamentoRecusado("PRECONDITION_FAILED", MENSAGEM_SEM_AUDIO_PARA_REPROCESSAR);
  }
  if (meeting.status !== "failed") return new ReprocessamentoRecusado("CONFLICT", MENSAGEM_REPROCESSO_EM_CONFLITO);
  if (!meeting.consentGranted) return new ReprocessamentoRecusado("PRECONDITION_FAILED", MENSAGEM_SEM_CONSENTIMENTO);
  return null;
}

/**
 * A chave do áudio que dá para reprocessar, ou null. A gravação tem de:
 * existir; durar ao menos mais LIMITE_PROCESSAMENTO_MS (a leitura vencida e a
 * varredura não apagam o áudio de reunião em 'processing', mas reprocessar áudio
 * a minutos de vencer o guardaria além dos 30 dias, e a tela também não oferece
 * o botão); ter o tipo e o tamanho que o envio original aceita; e
 * estar no espaço DESTA reunião DESTA dona no bucket, para uma linha legada ou
 * corrompida (a tabela veio do backup do Manus) não virar leitura de chave
 * arbitrária.
 */
function chaveReprocessavel(gravacao: Gravacao | undefined, ownerId: string, meetingId: string): string | null {
  if (!gravacao) return null;
  if (gravacao.expiresAt <= now() + LIMITE_PROCESSAMENTO_MS) return null;
  if (!(ALLOWED_MEETING_AUDIO_TYPES as readonly string[]).includes(gravacao.mimeType)) return null;
  if (!(gravacao.sizeBytes > 0 && gravacao.sizeBytes <= MAX_MEETING_AUDIO_BYTES)) return null;
  const chave = chaveDoStorageDaDona("meetings", ownerId, gravacao.storageKey);
  return chave && chave.startsWith(`meetings/${ownerId}/${meetingId}/`) ? chave : null;
}

/**
 * O reprocessar da reunião gravada em partes: quem refaz é a fila
 * (server/fila-de-transcricao.ts). A reunião volta a 'uploading' com as
 * tentativas zeradas, e as partes que falharam por causa passageira (IA, banco,
 * tentativas esgotadas) voltam a 'received'. As que não têm áudio (sumiu do
 * bucket ou nunca subiu) seguem como lacuna. Sem parte nenhuma, não há o que
 * reprocessar. Responde na hora: a tela acompanha pelo status.
 *
 * O prazo, como no envio único (chaveReprocessavel), mas com a margem que
 * cresce com a gravação (margemDoReprocesso, em shared/const.ts): a fila
 * transcreve uma parte por vez, e enquanto a reunião está em 'uploading' ou
 * 'processing' o áudio vencido não sai. Com 15 min para qualquer tamanho, o
 * reprocesso de 72 partes aceito a 20 min do prazo passava dele, e a fila
 * seguia lendo áudio que já deveria ter saído. A tela esconde o botão com a
 * mesma conta, sobre a mesma coluna (`esperadas`, a expected_slices que ela
 * recebe); sem ela, contam as partes até a maior que chegou. Vale a parte que
 * vence primeiro: as partes gravadas desde esta regra vencem juntas, e as de
 * antes podem diferir por alguns minutos.
 */
async function reprocessarEmPartes(db: Banco, ownerId: string, meetingId: string, esperadas: number | null): Promise<{ trabalho: Promise<void> }> {
  const [partes] = await db.select({
    quantas: sql<number>`count(*)`,
    maiorSeq: sql<number | null>`max(${meetingAudioSlices.seq})`,
    prazo: sql<number | null>`min(${meetingAudioSlices.expiresAt})`,
  }).from(meetingAudioSlices).where(and(eq(meetingAudioSlices.meetingId, meetingId), eq(meetingAudioSlices.ownerId, ownerId)));
  if (!Number(partes?.quantas ?? 0)) throw new ReprocessamentoRecusado("PRECONDITION_FAILED", MENSAGEM_SEM_AUDIO_PARA_REPROCESSAR);
  if (Number(partes!.prazo ?? 0) <= now() + margemDoReprocesso(esperadas ?? Number(partes!.maiorSeq) + 1)) {
    throw new ReprocessamentoRecusado("PRECONDITION_FAILED", MENSAGEM_SEM_AUDIO_PARA_REPROCESSAR);
  }
  const tomada = await db.update(meetings).set({
    status: "uploading", processingError: null, attempts: 0, lockToken: null, lockedUntil: null, updatedAt: now(),
    expectedSlices: sql`coalesce(${meetings.expectedSlices}, ${Number(partes!.maiorSeq) + 1})`,
  }).where(and(
    eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), eq(meetings.audioPipeline, "slices"),
    eq(meetings.status, "failed"), eq(meetings.consentGranted, true),
  ));
  if (!linhasAfetadas(tomada)) throw new ReprocessamentoRecusado("CONFLICT", MENSAGEM_REPROCESSO_EM_CONFLITO);
  await db.update(meetingAudioSlices).set({ status: "received", attempts: 0, lastError: null, lockToken: null, lockedUntil: null, updatedAt: now() })
    .where(and(
      eq(meetingAudioSlices.meetingId, meetingId), eq(meetingAudioSlices.ownerId, ownerId), eq(meetingAudioSlices.status, "failed"),
      or(isNull(meetingAudioSlices.lastError), notInArray(meetingAudioSlices.lastError, ["AUDIO_AUSENTE", "NAO_RECEBIDA"])),
    ));
  return { trabalho: Promise.resolve() };
}

/**
 * Pede o reprocessamento de uma reunião com falha, a partir do áudio que ficou
 * guardado. Só LÊ até tomar a reunião ('failed' → 'processing', com a ficha) e
 * devolve logo: o trabalho — ler os bytes do bucket, IA, escritas — segue em
 * segundo plano, e a tela acompanha por meetings.get. Reprocessar não grava
 * áudio, não cria gravação e não renova o prazo de 30 dias.
 *
 * `trabalho` NUNCA rejeita. Fora da requisição não há quem capture o erro, e
 * uma rejeição sem tratamento derruba o processo inteiro no Node 20 — junto
 * com os envios de outras donas em curso. Por isso todo erro termina em log
 * aqui dentro: é a exceção deliberada à regra de relançar erro de banco,
 * porque não existe chamador para quem relançar.
 */
export async function iniciarReprocessamento(ownerId: string, meetingId: string): Promise<{ trabalho: Promise<void> }> {
  const db = await exigirDb();
  const [meeting] = await db.select().from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1);
  if (!meeting || meeting.status === "deleted") throw new ReprocessamentoRecusado("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
  const recusa = recusaPeloStatus(meeting);
  if (recusa) throw recusa;
  if (meeting.audioPipeline === "slices") return reprocessarEmPartes(db, ownerId, meetingId, meeting.expectedSlices);

  // A mesma gravação que o player toca: a mais recente, porque não há
  // unicidade por reunião no banco.
  const [gravacao] = await db.select().from(meetingRecordings)
    .where(and(eq(meetingRecordings.meetingId, meetingId), eq(meetingRecordings.ownerId, ownerId)))
    .orderBy(desc(meetingRecordings.createdAt))
    .limit(1);
  const chave = chaveReprocessavel(gravacao, ownerId, meetingId);
  if (!chave || !gravacao) throw new ReprocessamentoRecusado("PRECONDITION_FAILED", MENSAGEM_SEM_AUDIO_PARA_REPROCESSAR);

  // A tomada é o que impede dois reprocessamentos da mesma reunião (duplo
  // clique, duas abas, site e app ao mesmo tempo): o UPDATE só vale para
  // 'failed' com consentimento, e 0 linhas quer dizer que alguém chegou antes.
  const ficha = fichaDeProcessamento(meeting.updatedAt);
  const tomada = await db.update(meetings).set({ status: "processing", processingError: null, updatedAt: ficha })
    .where(and(
      eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId),
      eq(meetings.status, "failed"), eq(meetings.consentGranted, true),
    ));
  if (!linhasAfetadas(tomada)) {
    const [agora] = await db.select().from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1);
    if (!agora || agora.status === "deleted") throw new ReprocessamentoRecusado("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
    throw recusaPeloStatus(agora) ?? new ReprocessamentoRecusado("CONFLICT", MENSAGEM_REPROCESSO_EM_CONFLITO);
  }

  const trabalho = executarReprocessamento(db, {
    ownerId,
    meetingId,
    chave,
    ficha,
    mimeType: gravacao.mimeType,
    durationSeconds: gravacao.durationSeconds,
    language: meeting.language,
  }).catch(erro => {
    console.error("[Reuniões] o reprocessamento em segundo plano terminou com erro não tratado:", erro instanceof Error ? erro.message : erro);
  });
  return { trabalho };
}

async function executarReprocessamento(db: Banco, execucao: {
  ownerId: string;
  meetingId: string;
  chave: string;
  ficha: number;
  mimeType: string;
  durationSeconds: number;
  language: string;
}) {
  try {
    let audio: Buffer;
    try {
      audio = await storageGetBytes(execucao.chave, MAX_MEETING_AUDIO_BYTES);
    } catch (erro) {
      // Frases neutras, como no upload: NoSuchKey, bucket e endpoint ficam no log.
      console.error("[Reuniões] não foi possível ler o áudio guardado:", erro instanceof Error ? erro.message : erro);
      if (erro instanceof ObjetoAusenteNoStorageError) throw new Error(MENSAGEM_AUDIO_GUARDADO_AUSENTE, { cause: erro });
      throw new Error(MENSAGEM_AUDIO_GUARDADO_ILEGIVEL, { cause: erro });
    }
    // Medida de novo nos bytes lidos: a gravação guardada antes da medição no
    // servidor carrega a duração que o navegador declarou, e é ela que o
    // contador de minutos receberia.
    const duracaoMedida = duracaoConferidaDoAudio(audio);
    await processarAudioGuardado(db, {
      meetingId: execucao.meetingId,
      ownerId: execucao.ownerId,
      audio,
      mimeType: execucao.mimeType,
      durationSeconds: duracaoMedida,
      language: execucao.language,
      ficha: execucao.ficha,
      limparAntes: true,
    });
  } catch (erro) {
    if (erro instanceof ReuniaoExcluidaDuranteProcessamento || erro instanceof ReuniaoTomadaPorOutraExecucao) return;
    try {
      await marcarFalhaComFicha(db, execucao.ownerId, execucao.meetingId, execucao.ficha, erro);
    } catch (erroAoMarcar) {
      // Banco fora justo na hora de marcar: a reunião fica 'processing', e a
      // varredura de interrompidas a dá como falha em até 20 minutos.
      console.error("[Reuniões] não foi possível marcar a falha do reprocessamento:", erroAoMarcar instanceof Error ? erroAoMarcar.message : erroAoMarcar);
    }
  }
}

/**
 * As colunas de `meetings` que a lista e o detalhe mandam ao navegador,
 * escolhidas uma a uma em vez da linha inteira. Privacidade é regra de
 * consulta, não de tela: coluna nova da tabela só chega à tela entrando aqui.
 *
 * Ficam no servidor as colunas de controle da fila de transcrição (attempts,
 * lockedUntil e lockToken): a reserva de quem está processando a reunião não é
 * dado da dona e não tem uso na tela. As outras colunas da migração 0014
 * (audioPipeline, origem, consentNoticeVersion e expectedSlices) entram aqui
 * quando uma tela precisar delas; até lá, a resposta é a mesma de antes dela.
 */
const COLUNAS_DA_REUNIAO_NA_TELA = {
  id: meetings.id,
  ownerId: meetings.ownerId,
  title: meetings.title,
  contactId: meetings.contactId,
  contextId: meetings.contextId,
  status: meetings.status,
  consentGranted: meetings.consentGranted,
  consentAt: meetings.consentAt,
  language: meetings.language,
  processingError: meetings.processingError,
  createdAt: meetings.createdAt,
  updatedAt: meetings.updatedAt,
  // Como o áudio chegou (envio único ou partes) e quantas partes a gravação
  // teve: a tela mostra o andamento da reunião em partes e o rótulo certo.
  audioPipeline: meetings.audioPipeline,
  expectedSlices: meetings.expectedSlices,
  // Os nomes das vozes (H3). Esta lista e este detalhe são só da dona; o link
  // aberto lê os nomes por outra consulta, e só quando foi ligado com a
  // confirmação que fala deles (H3b, server/link-aberto-da-reuniao.ts).
  speakerNames: meetings.speakerNames,
};

/**
 * Dá nome a uma voz da transcrição por falante (H3), ou o tira (nome vazio).
 * Só a dona: a reunião de outra conta é "não encontrada". Devolve os nomes
 * como ficaram, ou null sem a reunião. A leitura e a gravação vão na mesma
 * transação com a linha travada: dois nomes salvos juntos não se apagam.
 */
export async function nomearFalante(ownerId: string, meetingId: string, falante: string, nome: string): Promise<Record<string, string> | null> {
  if (!FORMATO_DO_FALANTE.test(falante)) throw new Error("Falante inválido.");
  const limpo = nome.trim().slice(0, NOME_DO_FALANTE_MAX);
  const db = await exigirDb();
  return db.transaction(async tx => {
    const daDona = and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), ne(meetings.status, "deleted"));
    const [reuniao] = await tx.select({ speakerNames: meetings.speakerNames }).from(meetings).where(daDona).limit(1).for("update");
    if (!reuniao) return null;
    const nomes = nomesDosFalantes(reuniao.speakerNames);
    if (limpo) nomes[falante] = limpo;
    else delete nomes[falante];
    await tx.update(meetings).set({ speakerNames: Object.keys(nomes).length ? nomes : null, updatedAt: Date.now() }).where(daDona);
    return nomes;
  });
}

export async function listPrivateMeetings(ownerId: string) {
  const db = await exigirDb();
  const lista = await db.select(COLUNAS_DA_REUNIAO_NA_TELA).from(meetings).where(eq(meetings.ownerId, ownerId)).orderBy(desc(meetings.createdAt));
  return lista.map(meeting => ({ ...meeting, processingError: processingErrorSeguro(meeting.processingError) }));
}

/**
 * Apaga o arquivo de áudio do bucket com TODAS as versões
 * (storageApagarTodasAsVersoes): o B2 guarda versões, e o DELETE simples só
 * esconderia a voz das participantes, que continuaria guardada e cobrada.
 * Devolve se conseguiu.
 *
 * A regra é a mesma em todo lugar: a LINHA do áudio (meeting_recordings ou
 * meeting_audio_slices) só sai se o objeto saiu. Ela é o único registro de onde
 * o áudio está, e apagá-la com o objeto intacto deixaria a voz no bucket para
 * sempre, invisível. Quando o bucket recusa, a linha fica e a varredura
 * (limparGravacoesVencidas) tenta de novo.
 *
 * O log leva a CHAVE (montada pelo servidor: o openId aleatório, o id da reunião
 * e um sufixo, sem nome nem dado de ninguém): é o que diz qual objeto ficou. A
 * permissão negada (a chave do B2 sem listFiles ou deleteFiles) é erro do
 * sistema, não aviso de um arquivo: nenhum áudio sai até alguém mexer no painel.
 */
async function apagarArquivoDaGravacao(storageKey: string): Promise<boolean> {
  try {
    await storageApagarTodasAsVersoes(storageKey);
    return true;
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message : erro;
    if (ehAcessoNegadoNoBucket(erro)) {
      console.error(`[Reuniões] o bucket NEGOU a permissão de apagar o áudio (a chave precisa de listFiles e deleteFiles); ficou: ${storageKey}`, motivo);
    } else {
      console.warn(`[Reuniões] o áudio ficou no bucket: ${storageKey}`, motivo);
    }
    return false;
  }
}

/** Uma linha de áudio, da gravação inteira ou de uma parte, a tirar do bucket. */
type LinhaDeAudio = { id: string; storageKey: string };

/**
 * Tira do bucket os áudios da lista, até CONCORRENCIA_DO_EXPURGO_DO_AUDIO por
 * vez (uma requisição da tela espera por eles), e para de começar outros na
 * primeira recusa: com o bucket fora ou travado (até 30 s por chamada),
 * insistir em cada áudio prenderia por minutos a tela da reunião ou a exclusão.
 * Os que já estavam em curso terminam. O que não saiu, ou nem foi tentado, fica
 * para a varredura. Devolve os ids que saíram e os que ficaram, na ordem da
 * lista.
 */
async function tirarDoBucket(linhas: LinhaDeAudio[]): Promise<{ sairam: string[]; ficaram: string[] }> {
  let houveRecusa = false;
  const resultados = await comConcorrenciaLimitada(linhas, CONCORRENCIA_DO_EXPURGO_DO_AUDIO, async linha => {
    const saiu = await apagarArquivoDaGravacao(linha.storageKey);
    if (!saiu) houveRecusa = true;
    return saiu;
  }, () => houveRecusa);
  const sairam: string[] = [];
  const ficaram: string[] = [];
  resultados.forEach((resultado, posicao) => (resultado?.valor ? sairam : ficaram).push(linhas[posicao].id));
  return { sairam, ficaram };
}

/** Uma parte do áudio para o player: o contrato `recording.partes` do desenho. */
export type ParteParaOuvir = { seq: number; url: string; mimeType: string; inicioSegundos: number; duracaoSegundos: number; expiresAt: number };

/** O que a tela da dona e o link aberto recebem sobre o áudio da reunião. */
export type AudioDaReuniao = {
  recording: { url: string; mimeType: string; durationSeconds: number; sizeBytes: number; expiresAt: number; partes: ParteParaOuvir[] } | null;
  /**
   * O áudio passou do prazo e SAIU do bucket. Sem linha nenhuma, vale para a
   * reunião mais velha que o prazo: desde a retenção do áudio (novembro de 2026)
   * a linha só sai depois do objeto com todas as versões, então ou o áudio saiu,
   * ou nunca houve (a tela só diz "foi apagada" quando há transcrição, que só
   * existe se houve áudio).
   *
   * Exceção que o código não alcança: o áudio cuja linha saiu ANTES dessa regra.
   * O DELETE antigo (storageDelete, sem VersionId) só escondia o arquivo no B2,
   * e a versão com a voz ficou guardada sem ponteiro. Para esse passivo, a
   * regra de ciclo de vida do bucket no prefixo meetings/ ou o expurgo único de
   * scripts/expurgar-audio-escondido.ts (os dois só com o Roberto).
   */
  recordingExpired: boolean;
  /** O áudio passou do prazo e ainda NÃO saiu do bucket: não é servido, e a varredura o tira. */
  recordingDeletionPending: boolean;
};

/** O estado da reunião que decide o que a leitura faz com o áudio vencido. */
type ReuniaoDoAudio = { createdAt: number; status: Reuniao["status"]; emPartes: boolean };

/**
 * Status em que o áudio vencido da reunião em partes NÃO sai, nem na leitura nem
 * na varredura: em 'processing' a fila ou o reprocesso pode estar lendo o
 * áudio; em 'recording' e 'uploading' a reunião ainda recebe partes, e cada
 * parte que chega renova o prazo de todas (renovação pendente). Nesses estados
 * o áudio vencido só deixa de ser servido, e sai quando a reunião os deixar. No
 * envio único, só 'processing' segura.
 */
const STATUS_QUE_SEGURAM_AS_PARTES: Reuniao["status"][] = ["recording", "uploading", "processing"];

/**
 * A gravação que se pode ouvir agora e, quando não há, o porquê: o áudio passou
 * do prazo e saiu (`recordingExpired`), passou do prazo e ainda está saindo
 * (`recordingDeletionPending`), ou não há áudio guardado.
 *
 * Vencido, o áudio deixa de ser servido e sai aqui mesmo, com todas as versões
 * e só então a linha: a promessa dos 30 dias vale também para quem abre a
 * reunião antes da próxima varredura. Se o bucket recusar, a linha fica, a tela
 * diz que o áudio está saindo (e não que "foi apagado"), e a varredura tenta de
 * novo. Antes, a tela dizia "passou dos 30 dias e foi apagada" na reunião em
 * partes sem nada ter saído do bucket.
 *
 * Sai só o que a tela precisa: `storageKey` fica no servidor. A `url` é o
 * caminho do proxy autenticado (/manus-storage/...), que confere sessão e posse
 * a cada requisição; não é endereço público do bucket.
 */
export async function gravacaoParaOuvir(db: Banco, ownerId: string, meetingId: string, reuniao: ReuniaoDoAudio): Promise<AudioDaReuniao> {
  const agora = now();
  const semAudio = (expirada: boolean, saindo = false): AudioDaReuniao => ({ recording: null, recordingExpired: expirada, recordingDeletionPending: saindo });
  // Sem linha: ou nunca houve áudio, ou ele já saiu pelo prazo. A data da
  // reunião distingue os dois casos sem guardar nada a mais (o prazo conta de um
  // instante posterior à criação); sem isto a tela passaria a dizer "nunca houve
  // áudio" logo depois de explicar que ele tinha sido apagado.
  const semLinha = () => semAudio(reuniao.createdAt + MEETING_AUDIO_TTL_MS <= agora);

  if (reuniao.emPartes) {
    const linhas = await db.select({
      id: meetingAudioSlices.id, seq: meetingAudioSlices.seq, status: meetingAudioSlices.status,
      storageKey: meetingAudioSlices.storageKey, storageUrl: meetingAudioSlices.storageUrl, mimeType: meetingAudioSlices.mimeType,
      durationMs: meetingAudioSlices.durationMs, offsetMs: meetingAudioSlices.offsetMs, expiresAt: meetingAudioSlices.expiresAt,
    }).from(meetingAudioSlices)
      .where(and(eq(meetingAudioSlices.meetingId, meetingId), eq(meetingAudioSlices.ownerId, ownerId)))
      .orderBy(meetingAudioSlices.seq);
    if (!linhas.length) return semLinha();

    const vencidas = linhas.filter(linha => linha.expiresAt <= agora);
    let ficaram = 0;
    if (vencidas.length && STATUS_QUE_SEGURAM_AS_PARTES.includes(reuniao.status)) {
      ficaram = vencidas.length;
    } else if (vencidas.length) {
      const tirada = await tirarDoBucket(vencidas);
      if (tirada.sairam.length) {
        await db.delete(meetingAudioSlices).where(and(eq(meetingAudioSlices.ownerId, ownerId), inArray(meetingAudioSlices.id, tirada.sairam)));
      }
      ficaram = tirada.ficaram.length;
    }

    // As partes que tocam: recebidas ou transcritas, no prazo. O início é o
    // gravado pela fila (offset) ou, antes de ela transcrever, a soma das
    // anteriores, contada sobre TODAS as linhas.
    const partes: ParteParaOuvir[] = [];
    let acumulado = 0;
    for (const linha of linhas) {
      const inicio = linha.offsetMs !== null ? Number(linha.offsetMs) : acumulado;
      acumulado = inicio + linha.durationMs;
      if ((linha.status !== "received" && linha.status !== "transcribed") || linha.expiresAt <= agora) continue;
      partes.push({
        seq: linha.seq, url: linha.storageUrl, mimeType: linha.mimeType,
        inicioSegundos: inicio / 1000, duracaoSegundos: linha.durationMs / 1000, expiresAt: linha.expiresAt,
      });
    }
    if (partes.length) {
      // A reunião em partes toca as partes em sequência; o resumo em
      // `recording` (url da primeira, duração total, o prazo mais curto) mantém
      // a tela de antes funcionando.
      const ultima = partes[partes.length - 1];
      return {
        recording: {
          url: partes[0].url, mimeType: partes[0].mimeType,
          durationSeconds: Math.round(ultima.inicioSegundos + ultima.duracaoSegundos),
          sizeBytes: 0, expiresAt: Math.min(...partes.map(p => p.expiresAt)), partes,
        },
        recordingExpired: false,
        recordingDeletionPending: false,
      };
    }
    if (ficaram) return semAudio(false, true);
    // Nada para ouvir e nada saindo: se todas as partes tinham vencido (e
    // acabaram de sair), é a gravação que passou do prazo; senão, as que sobram
    // nunca chegaram ao bucket ou falharam.
    return semAudio(vencidas.length === linhas.length);
  }

  // Sem unicidade por reunião no banco: `orderBy` torna a escolha determinista
  // (a mais recente), em vez de depender da ordem que o MySQL devolver.
  const [gravacao] = await db.select().from(meetingRecordings)
    .where(and(eq(meetingRecordings.meetingId, meetingId), eq(meetingRecordings.ownerId, ownerId)))
    .orderBy(desc(meetingRecordings.createdAt))
    .limit(1);
  if (!gravacao) return semLinha();

  if (gravacao.expiresAt <= agora) {
    // Em 'processing' o reprocesso pode estar lendo este áudio: aqui ele só
    // deixa de ser servido, e a varredura o tira quando a reunião sair desse
    // estado. Nos outros, sai já: o objeto com todas as versões e, só se ele
    // saiu, a linha.
    if (reuniao.status !== "processing" && await apagarArquivoDaGravacao(gravacao.storageKey)) {
      await db.delete(meetingRecordings).where(and(eq(meetingRecordings.id, gravacao.id), eq(meetingRecordings.ownerId, ownerId)));
      return semAudio(true);
    }
    return semAudio(false, true);
  }

  // O envio único é uma parte só, no mesmo contrato.
  const partes: ParteParaOuvir[] = [{
    seq: 0, url: gravacao.storageUrl, mimeType: gravacao.mimeType, inicioSegundos: 0,
    duracaoSegundos: gravacao.durationSeconds, expiresAt: gravacao.expiresAt,
  }];
  return {
    recording: {
      url: gravacao.storageUrl,
      mimeType: gravacao.mimeType,
      durationSeconds: gravacao.durationSeconds,
      sizeBytes: gravacao.sizeBytes,
      expiresAt: gravacao.expiresAt,
      partes,
    },
    recordingExpired: false,
    recordingDeletionPending: false,
  };
}

/**
 * O andamento da reunião gravada em partes, para a tela dizer o que está
 * acontecendo: quantas partes chegaram, quantas a IA já transcreveu e quantas a
 * gravação teve (nulo enquanto grava). Nulo no envio único.
 */
async function andamentoDaReuniao(db: Awaited<ReturnType<typeof exigirDb>>, ownerId: string, meetingId: string, esperadas: number | null) {
  const linhas = await db.select({ status: meetingAudioSlices.status }).from(meetingAudioSlices)
    .where(and(eq(meetingAudioSlices.meetingId, meetingId), eq(meetingAudioSlices.ownerId, ownerId)));
  return {
    recebidas: linhas.filter(l => l.status !== "uploading").length,
    transcritas: linhas.filter(l => l.status === "transcribed").length,
    esperadas,
  };
}

/** Linhas por consulta da varredura, em cada tabela. */
const LOTE_DA_VARREDURA = 200;
/** Teto de lotes por tabela numa passada: o que sobrar sai na passada seguinte. */
const MAXIMO_DE_LOTES_DA_VARREDURA = 20;
/**
 * Recusas SEGUIDAS do bucket que encerram a volta de UMA tabela: um bucket fora
 * do ar ou travado (até 30 s por chamada) não pode prender a passada por horas.
 * A conta é por tabela (as partes são visitadas mesmo quando as gravações batem
 * no teto) e zera a cada áudio que sai.
 */
const RECUSAS_SEGUIDAS_QUE_ENCERRAM_A_TABELA = 5;

export type ResultadoDaVarredura = { encontradas: number; apagadas: number };

/**
 * A passada da varredura parou no meio por um erro (o banco caiu, por exemplo).
 * O erro continua sendo erro (banco fora do ar nunca vira "nada a apagar"), mas
 * leva o que JÁ saiu do bucket e do banco nessa passada, para o laço
 * (server/varredura-de-gravacoes.ts) registrar na auditoria antes de relançar.
 */
export class VarreduraInterrompida extends Error {
  constructor(readonly resultado: ResultadoDaVarredura, causa: unknown) {
    super("A varredura das gravações vencidas parou no meio.", { cause: causa });
    this.name = "VarreduraInterrompida";
  }
}

/**
 * Onde cada tabela retoma na passada seguinte quando a anterior parou no meio
 * (recusas seguidas, teto de lotes ou desligamento): o id da última linha
 * tentada. Sem isto, toda passada recomeçava do primeiro id, e cinco áudios que
 * o bucket recusa sempre ficavam na frente e travavam todos os outros. Na
 * memória do processo: perder a marca num deploy só faz a passada seguinte
 * começar do começo. Por tabela e, nos testes de integração, por dona.
 */
const retomadaDaVarredura = new Map<string, string>();

/** A reunião DO áudio: mesmo id E mesma dona. Sem esse par, o áudio é de reunião que já não existe. */
const reuniaoDaGravacao = and(eq(meetings.id, meetingRecordings.meetingId), eq(meetings.ownerId, meetingRecordings.ownerId));
const reuniaoDaParte = and(eq(meetings.id, meetingAudioSlices.meetingId), eq(meetings.ownerId, meetingAudioSlices.ownerId));

/** Um trecho da volta da varredura por uma tabela: os ids depois de `depoisDe` e, se houver, até `ate` (inclusive). */
type TrechoDaVarredura = { depoisDe: string; ate?: string };

/** As gravações do envio único que saem nesta passada (ver limparGravacoesVencidas). */
function gravacoesQueSaem(db: Banco, agora: number, trecho: TrechoDaVarredura, lote: number, ownerId?: string) {
  return db.select({ id: meetingRecordings.id, storageKey: meetingRecordings.storageKey })
    .from(meetingRecordings)
    .leftJoin(meetings, reuniaoDaGravacao)
    .where(and(
      gt(meetingRecordings.id, trecho.depoisDe),
      trecho.ate !== undefined ? lte(meetingRecordings.id, trecho.ate) : undefined,
      ownerId ? eq(meetingRecordings.ownerId, ownerId) : undefined,
      or(
        isNull(meetings.id),
        eq(meetings.status, "deleted"),
        and(lte(meetingRecordings.expiresAt, agora), ne(meetings.status, "processing")),
      ),
    ))
    .orderBy(asc(meetingRecordings.id))
    .limit(lote);
}

/** As partes da gravação em partes que saem nesta passada (ver limparGravacoesVencidas). */
function partesQueSaem(db: Banco, agora: number, trecho: TrechoDaVarredura, lote: number, ownerId?: string) {
  return db.select({ id: meetingAudioSlices.id, storageKey: meetingAudioSlices.storageKey })
    .from(meetingAudioSlices)
    .leftJoin(meetings, reuniaoDaParte)
    .where(and(
      gt(meetingAudioSlices.id, trecho.depoisDe),
      trecho.ate !== undefined ? lte(meetingAudioSlices.id, trecho.ate) : undefined,
      ownerId ? eq(meetingAudioSlices.ownerId, ownerId) : undefined,
      or(
        isNull(meetings.id),
        eq(meetings.status, "deleted"),
        and(lte(meetingAudioSlices.expiresAt, agora), notInArray(meetings.status, STATUS_QUE_SEGURAM_AS_PARTES)),
      ),
    ))
    .orderBy(asc(meetingAudioSlices.id))
    .limit(lote);
}

/**
 * A varredura que faz os 30 dias valerem para TODO áudio de reunião, não só para
 * o que alguém reabre: sem ela, o áudio de uma reunião que ninguém visita mais
 * (o caso comum) ficaria no bucket para sempre. A voz das outras participantes
 * não pode depender de a dona voltar na página.
 *
 * Sai, com todas as versões e só então a linha:
 * - a gravação do envio único e a parte da gravação em partes cujo prazo
 *   venceu, menos as da reunião que ainda pode precisar delas: 'processing'
 *   (a execução ou a fila pode estar lendo o áudio) e, nas partes, também
 *   'recording' e 'uploading' (renovação pendente: cada parte que chega renova
 *   o prazo de todas, e a fila ainda as transcreve). As partes de uma reunião
 *   vencem no mesmo instante (ver MEETING_AUDIO_TTL_MS) e saem na mesma passada;
 * - na hora, o áudio cuja reunião já não existe ou está sendo excluída
 *   ('deleted'): é o ponteiro que a exclusão da reunião ou da conta deixou
 *   quando o bucket recusou, ou a gravação de uma execução que terminou depois
 *   da exclusão.
 *
 * Pagina cada tabela pelo id, em lotes de LOTE_DA_VARREDURA, até
 * MAXIMO_DE_LOTES_DA_VARREDURA por tabela; a linha que fica (o bucket recusou)
 * não volta na mesma passada. Em cada tabela, a volta para depois de
 * RECUSAS_SEGUIDAS_QUE_ENCERRAM_A_TABELA, e a tabela seguinte é visitada assim
 * mesmo. A passada inteira para entre um áudio e outro quando `deveParar` diz
 * (o desligamento do servidor). A tabela que parou no meio retoma na passada
 * seguinte DEPOIS da última linha tentada e dá a volta: o que ficou recusado
 * passa para o fim da fila, em vez de travar os outros áudios a cada passada.
 * Rodar de novo sem nada vencido não faz nada.
 *
 * Erro no meio (o banco caiu, por exemplo) sobe como VarreduraInterrompida,
 * com o que já tinha saído.
 *
 * Varredura de SISTEMA, sem owner_id de propósito, como
 * marcarReunioesInterrompidas: não lê nem devolve dado de reunião. `ownerId` só
 * existe para os testes de integração, que dividem o banco com outros arquivos
 * rodando em paralelo.
 *
 * Roda no boot e a cada 5 min (server/varredura-de-gravacoes.ts) e pelo
 * endpoint de tarefa agendada.
 */
export async function limparGravacoesVencidas(opcoes: {
  lote?: number;
  maximoDeLotes?: number;
  deveParar?: () => boolean;
  ownerId?: string;
} = {}): Promise<ResultadoDaVarredura> {
  const db = await exigirDb();
  const agora = now();
  const lote = opcoes.lote ?? LOTE_DA_VARREDURA;
  const maximoDeLotes = opcoes.maximoDeLotes ?? MAXIMO_DE_LOTES_DA_VARREDURA;
  const deveParar = opcoes.deveParar ?? (() => false);
  const resultado: ResultadoDaVarredura = { encontradas: 0, apagadas: 0 };

  const tabelas = [
    {
      nome: "gravacoes",
      ler: (trecho: TrechoDaVarredura) => gravacoesQueSaem(db, agora, trecho, lote, opcoes.ownerId),
      apagarLinha: (id: string) => db.delete(meetingRecordings).where(eq(meetingRecordings.id, id)),
    },
    {
      nome: "partes",
      ler: (trecho: TrechoDaVarredura) => partesQueSaem(db, agora, trecho, lote, opcoes.ownerId),
      apagarLinha: (id: string) => db.delete(meetingAudioSlices).where(eq(meetingAudioSlices.id, id)),
    },
  ];

  /** Uma volta por uma tabela. Devolve se parou antes do fim e a última linha que tentou. */
  const varrerTabela = async (tabela: (typeof tabelas)[number], retomada: string) => {
    // Com marca, a volta começa depois da linha em que a passada anterior parou
    // e, no fim da tabela, continua do começo até essa linha (inclusive), que
    // fica por último. Sem marca, do começo ao fim.
    const trechos: TrechoDaVarredura[] = retomada ? [{ depoisDe: retomada }, { depoisDe: "", ate: retomada }] : [{ depoisDe: "" }];
    let recusasSeguidas = 0;
    let lotes = 0;
    let ultimaTentada: string | null = null;
    const parar = () => deveParar() || recusasSeguidas >= RECUSAS_SEGUIDAS_QUE_ENCERRAM_A_TABELA;
    for (const trecho of trechos) {
      let depoisDe = trecho.depoisDe;
      for (;;) {
        if (parar() || lotes >= maximoDeLotes) return { parou: true, ultimaTentada };
        const linhas = await tabela.ler({ depoisDe, ate: trecho.ate });
        lotes += 1;
        for (const linha of linhas) {
          if (parar()) return { parou: true, ultimaTentada };
          resultado.encontradas += 1;
          ultimaTentada = linha.id;
          if (await apagarArquivoDaGravacao(linha.storageKey)) {
            await tabela.apagarLinha(linha.id);
            resultado.apagadas += 1;
            recusasSeguidas = 0;
          } else {
            recusasSeguidas += 1;
          }
        }
        if (linhas.length < lote) break;
        depoisDe = linhas[linhas.length - 1].id;
      }
    }
    return { parou: false, ultimaTentada };
  };

  try {
    for (const tabela of tabelas) {
      if (deveParar()) break;
      const chave = `${tabela.nome}|${opcoes.ownerId ?? ""}`;
      const volta = await varrerTabela(tabela, retomadaDaVarredura.get(chave) ?? "");
      if (!volta.parou) retomadaDaVarredura.delete(chave);
      else if (volta.ultimaTentada !== null) retomadaDaVarredura.set(chave, volta.ultimaTentada);
    }
  } catch (erro) {
    throw new VarreduraInterrompida({ ...resultado }, erro);
  }
  return resultado;
}

export async function getPrivateMeeting(ownerId: string, meetingId: string) {
  const db = await exigirDb();
  // O token do link aberto vai só para a dona, aqui no detalhe: é com ele que a
  // tela monta o endereço para copiar e mandar (server/link-aberto-da-reuniao.ts).
  const [meeting] = await db.select({ ...COLUNAS_DA_REUNIAO_NA_TELA, shareToken: meetings.shareToken }).from(meetings).where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1);
  if (!meeting) return null;
  const [transcript] = await db.select().from(meetingTranscripts).where(and(eq(meetingTranscripts.meetingId, meetingId), eq(meetingTranscripts.ownerId, ownerId))).limit(1);
  const entities = await db.select().from(meetingEntities).where(and(eq(meetingEntities.meetingId, meetingId), eq(meetingEntities.ownerId, ownerId))).orderBy(desc(meetingEntities.createdAt));
  const suggestions = await db.select().from(meetingContactSuggestions).where(and(eq(meetingContactSuggestions.meetingId, meetingId), eq(meetingContactSuggestions.ownerId, ownerId))).orderBy(desc(meetingContactSuggestions.createdAt));
  const emPartes = meeting.audioPipeline === "slices";
  const { recording, recordingExpired, recordingDeletionPending } = await gravacaoParaOuvir(db, ownerId, meetingId, {
    createdAt: meeting.createdAt, status: meeting.status, emPartes,
  });
  const andamento = emPartes ? await andamentoDaReuniao(db, ownerId, meetingId, meeting.expectedSlices) : null;
  // Se quem tem o link vê os nomes das vozes (H3b): só com o link ligado com a
  // confirmação que fala deles. O painel de compartilhar avisa a dona quando há
  // nomes e o link é da confirmação antiga, e o campo do nome, quando o nome
  // sai também pelo link. Sem link, falso, sem consultar a auditoria.
  const linkMostraNomes = meeting.shareToken ? await linkMostraOsNomes(db, meetingId) : false;
  return {
    meeting: { ...meeting, processingError: processingErrorSeguro(meeting.processingError), linkMostraNomes },
    transcript: transcript ?? null, entities, suggestions, recording, recordingExpired, recordingDeletionPending, andamento,
  };
}

/** O que fica escrito na parte de áudio que sobra como ponteiro depois da exclusão da reunião (frase nossa, sem dado de ninguém). */
export const MOTIVO_DA_PARTE_DA_REUNIAO_EXCLUIDA = "reunião excluída; o áudio desta parte não saiu do bucket";

/**
 * Tudo que uma reunião gera fora da própria linha: sugestões, entidades,
 * transcrição, traduções e gravações (linha E objeto no bucket). Serve à
 * exclusão pela dona e à COMPENSAÇÃO de processMeetingRecording, que usa a
 * mesma lista quando descobre que a reunião foi excluída no meio — duas
 * listas divergiriam na primeira tabela nova.
 *
 * O ÁUDIO sai do bucket com todas as versões, não só a linha do banco: é a voz
 * das pessoas que participaram da reunião, o dado mais sensível daqui. A
 * leitura vem primeiro porque é a linha que diz onde o arquivo está: apagá-la
 * antes tornaria o objeto inalcançável para sempre.
 *
 * O que a IA gerou (transcrição, sugestões, traduções, resumo) sai ANTES do
 * bucket: não aponta para objeto nenhum, e o expurgo do áudio, com 4 a 5
 * chamadas por arquivo, é a parte longa. Um deploy (SIGTERM) no meio do expurgo
 * deixava a reunião 'deleted' ainda com a transcrição, e nada retomava isso; o
 * áudio que ficar a varredura retoma.
 *
 * Só sai a linha do áudio cujo objeto saiu, pelo id (e pela dona). Se o bucket
 * recusar (B2 fora, chave sem permissão de listar), a exclusão não trava: a
 * reunião sai do mesmo jeito, mas a linha fica como ponteiro, já vencida e, na
 * parte, sem a transcrição (`result`) e fora da fila; sem a reunião, a
 * varredura a acha na passada seguinte e tenta o bucket de novo. Apagar pelo id
 * também poupa o áudio que uma execução ainda em curso gravou depois desta
 * leitura: ela relê a reunião, a acha excluída e o leva junto (ou, se falhar
 * antes, a varredura o acha sem reunião).
 */
async function apagarDerivadosDaReuniao(db: Banco, ownerId: string, meetingId: string) {
  const gravacoes = await db.select({ id: meetingRecordings.id, storageKey: meetingRecordings.storageKey })
    .from(meetingRecordings)
    .where(and(eq(meetingRecordings.meetingId, meetingId), eq(meetingRecordings.ownerId, ownerId)));
  // As partes da reunião gravada em partes (G5) são áudio também.
  const partes = await db.select({ id: meetingAudioSlices.id, storageKey: meetingAudioSlices.storageKey, status: meetingAudioSlices.status })
    .from(meetingAudioSlices)
    .where(and(eq(meetingAudioSlices.meetingId, meetingId), eq(meetingAudioSlices.ownerId, ownerId)));

  await apagarDerivadosSemGravacao(db, ownerId, meetingId);

  // Para de começar outros na primeira recusa (tirarDoBucket): com o bucket
  // fora, a dona não espera um prazo inteiro por parte, e o resto fica como
  // ponteiro para a varredura.
  const { sairam } = await tirarDoBucket([...gravacoes, ...partes]);
  const saiu = new Set(sairam);

  const gravacoesQueSairam = gravacoes.filter(gravacao => saiu.has(gravacao.id)).map(gravacao => gravacao.id);
  const gravacoesQueFicam = gravacoes.filter(gravacao => !saiu.has(gravacao.id)).map(gravacao => gravacao.id);
  // A parte lida 'uploading' ainda está subindo: o expurgo dela aqui pode ter
  // rodado ANTES de o objeto existir (e "dado certo" sem apagar nada). Ela é de
  // receberParte, que relê a reunião depois do upload, a acha 'deleted' (gravado
  // antes desta leitura) e tira o próprio objeto. Por isso a linha dela só sai
  // aqui se continuar 'uploading' (o upload não terminou; se terminar, o
  // receberParte não acha a linha e tira o objeto do mesmo jeito): se o upload
  // terminou nesse meio-tempo, a linha é o ponteiro de que receberParte precisa
  // se o bucket recusar o expurgo dele.
  const partesQueSairam = partes.filter(parte => saiu.has(parte.id) && parte.status !== "uploading").map(parte => parte.id);
  const partesSubindoQueSairam = partes.filter(parte => saiu.has(parte.id) && parte.status === "uploading").map(parte => parte.id);
  const partesQueFicam = partes.filter(parte => !saiu.has(parte.id)).map(parte => parte.id);
  if (gravacoesQueSairam.length) {
    await db.delete(meetingRecordings).where(and(eq(meetingRecordings.ownerId, ownerId), inArray(meetingRecordings.id, gravacoesQueSairam)));
  }
  if (partesQueSairam.length) {
    await db.delete(meetingAudioSlices).where(and(eq(meetingAudioSlices.ownerId, ownerId), inArray(meetingAudioSlices.id, partesQueSairam)));
  }
  if (partesSubindoQueSairam.length) {
    await db.delete(meetingAudioSlices).where(and(
      eq(meetingAudioSlices.ownerId, ownerId), inArray(meetingAudioSlices.id, partesSubindoQueSairam), eq(meetingAudioSlices.status, "uploading"),
    ));
  }
  const agora = now();
  if (gravacoesQueFicam.length) {
    await db.update(meetingRecordings).set({ expiresAt: agora })
      .where(and(eq(meetingRecordings.ownerId, ownerId), inArray(meetingRecordings.id, gravacoesQueFicam)));
  }
  if (partesQueFicam.length) {
    await db.update(meetingAudioSlices).set({
      status: "failed", lastError: MOTIVO_DA_PARTE_DA_REUNIAO_EXCLUIDA, result: null,
      lockedUntil: null, lockToken: null, expiresAt: agora, updatedAt: agora,
    }).where(and(eq(meetingAudioSlices.ownerId, ownerId), inArray(meetingAudioSlices.id, partesQueFicam)));
  }
}

/**
 * O que a IA gerou a partir do áudio — sugestões, entidades, transcrição,
 * traduções e resumo guardado —, sem tocar na gravação. É a limpeza do reprocessamento: o áudio
 * fica, porque é dele que sai o resultado novo. Mora dentro da lista única de
 * apagarDerivadosDaReuniao para as duas nunca divergirem.
 */
async function apagarDerivadosSemGravacao(db: Banco, ownerId: string, meetingId: string) {
  await db.delete(meetingContactSuggestions).where(and(eq(meetingContactSuggestions.meetingId, meetingId), eq(meetingContactSuggestions.ownerId, ownerId)));
  // As pendências de Quem Sou / Tenho / Preciso tiradas desta reunião carregam
  // trechos literais da transcrição: saem com ela.
  await apagarPendenciasDaReuniao(db, ownerId, meetingId);
  await db.delete(meetingEntities).where(and(eq(meetingEntities.meetingId, meetingId), eq(meetingEntities.ownerId, ownerId)));
  await db.delete(meetingTranscripts).where(and(eq(meetingTranscripts.meetingId, meetingId), eq(meetingTranscripts.ownerId, ownerId)));
  // As TRADUÇÕES são cópias da transcrição em outros idiomas: apagar só o
  // original deixaria o mesmo conteúdo vivo em até nove línguas.
  await db.delete(meetingTranscriptTranslations).where(and(eq(meetingTranscriptTranslations.meetingId, meetingId), eq(meetingTranscriptTranslations.ownerId, ownerId)));
  // O resumo guardado (H4) foi escrito a partir da transcrição e cita trechos
  // dela: sai com ela. As traduções dele (H11) e os itens antes do resumo, que
  // é a linha de que eles saem.
  await db.delete(meetingSummaryTranslations).where(and(eq(meetingSummaryTranslations.meetingId, meetingId), eq(meetingSummaryTranslations.ownerId, ownerId)));
  await db.delete(meetingSummaryItems).where(and(eq(meetingSummaryItems.meetingId, meetingId), eq(meetingSummaryItems.ownerId, ownerId)));
  await db.delete(meetingSummaries).where(and(eq(meetingSummaries.meetingId, meetingId), eq(meetingSummaries.ownerId, ownerId)));
}

export async function deletePrivateMeeting(ownerId: string, meetingId: string) {
  const db = await exigirDb();
  // 'deleted' ANTES de apagar, e não um SELECT de existência: é o sinal que
  // um processMeetingRecording em curso (1–2 min de Gemini e LLM) lê antes de
  // gravar, e que barra o UPDATE final dele para 'ready' — sem isto, a
  // transcrição e os contatos entravam depois da exclusão e ficavam órfãos,
  // com a voz e os dados das pessoas que a dona mandou apagar. Zero linhas:
  // não existe ou não é dela.
  const marcada = await db.update(meetings).set({ status: "deleted", updatedAt: now() })
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId)));
  if (!linhasAfetadas(marcada)) return false;
  await apagarDerivadosDaReuniao(db, ownerId, meetingId);
  await db.delete(meetings).where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId)));
  return true;
}

/**
 * Reuniões presas em "processing": o status só era revertido pela própria
 * requisição, e todo merge na main é deploy no Render — SIGTERM no meio do
 * Gemini deixava a reunião "Processando" para sempre, sem erro e sem saída
 * além de excluir e gravar de novo. Roda no boot (o momento em que se sabe
 * que nenhuma requisição anterior sobreviveu) e pelo endpoint de cron.
 *
 * Varredura de SISTEMA, sem owner_id de propósito, como limparGravacoesVencidas:
 * ela não lê nem devolve dado de reunião, só troca o status de linhas que
 * nenhuma requisição viva pode estar tratando. Grava o CÓDIGO
 * ERRO_INTERROMPIDO, que a tela traduz.
 */
export async function marcarReunioesInterrompidas(limiteMs = LIMITE_PROCESSAMENTO_MS, limite = 200) {
  const db = await exigirDb();
  const agora = now();
  const corte = agora - limiteMs;
  // Só o envio único: a reunião em partes em 'processing' é da fila
  // (server/fila-de-transcricao.ts), que tem a própria reserva com prazo e a
  // retoma quando ela vence — marcá-la como falha aqui perderia uma montagem
  // longa que ainda está em curso.
  const presas = await db.select({ id: meetings.id }).from(meetings)
    .where(and(eq(meetings.status, "processing"), eq(meetings.audioPipeline, "single"), lt(meetings.updatedAt, corte)))
    .limit(limite);
  if (!presas.length) return { encontradas: 0, marcadas: 0 };

  // O predicado se repete no UPDATE: uma reunião que terminou entre o SELECT
  // e aqui (updatedAt novo, status 'ready') não pode ser marcada como falha.
  const resultado = await db.update(meetings).set({
    status: "failed",
    processingError: CODIGO_ERRO_INTERROMPIDO,
    updatedAt: agora,
  }).where(and(
    inArray(meetings.id, presas.map(reuniao => reuniao.id)),
    eq(meetings.status, "processing"),
    eq(meetings.audioPipeline, "single"),
    lt(meetings.updatedAt, corte),
  ));
  return { encontradas: presas.length, marcadas: linhasAfetadas(resultado) };
}
