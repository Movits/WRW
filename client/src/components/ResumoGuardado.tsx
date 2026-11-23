import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import type { inferRouterOutputs } from "@trpc/server";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Loader2, Pencil, Plus, RefreshCw, RotateCcw, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "@/lib/trpc";
import { pedidoDaTela, useAvisosDaAgenda } from "@/components/AcaoNaAgenda";
import type { ResultadoNaGoogle } from "@shared/google-agenda-eventos";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import {
  EscolhaDoModelo, nomeDaEscolha, nomeDoEstilo, PainelDeRefazer, PEDIDO_PADRAO, pedidoParaEnviar, PerguntaDoTamanho, useModelosDaDona, type PedidoNaTela,
} from "@/components/ModeloDoResumo";
import { MeusModelosDeResumo } from "@/components/MeusModelosDeResumo";
import { FormularioDoItemDoResumo } from "@/components/FormularioDoItemDoResumo";
import { OuvirOResumo } from "@/components/OuvirOResumo";
import { BaixarAudioDoResumo } from "@/components/BaixarAudioDoResumo";
import { ComplementoDoItem } from "@/components/ComplementoDoItem";
import { AvisoDeConferir, mensagemDoErroDaIA, TempoDoTrecho, Trecho } from "@/components/ReuniaoComIA";
import { mensagemDeErroParaTela, traduzirMensagemDoServidor } from "@/lib/mensagem-de-erro";
import { LANGUAGES } from "@/i18n";
import { mensagemDaFalhaDaTraducao, type TraducaoDoResumoNaTela } from "@/hooks/useTraducaoDoResumo";
import { MENSAGEM_ITEM_NAO_ENCONTRADO, MENSAGEM_RESUMO_CHEIO, MENSAGEM_RESUMO_SENDO_GERADO, MENSAGEM_SO_ACAO_TEM_CAIXA } from "@shared/const";
import { ESTILO_DO_RESUMO_PADRAO, MODELO_DE_RESUMO_PADRAO, estiloDoResumo } from "@shared/modelos-de-resumo";
import { IDIOMA_DA_REUNIAO_PADRAO, idiomaDaReuniao, idiomaFalado } from "@shared/idioma-da-reuniao";
import { OpcaoDoIdiomaOriginal } from "@/components/SeletorDoIdiomaDaReuniao";
import { rotuloDoIdioma } from "@/lib/idiomas-na-tela";
import { ROTA_DAS_PROXIMAS_ACOES, viraProximaAcao } from "@shared/proximas-acoes";
import { vozesCitadas } from "@shared/vozes-na-edicao";
import { vozesNoTexto } from "@shared/vozes-no-texto";
import { falasDoResumo as falasCompartilhadas, tituloDaSecaoNaFala } from "@shared/falas-do-resumo";

/**
 * O resumo guardado da reunião (H4 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md), no formato do app de referência
 * da cliente: no topo as ações com caixa de marcar; depois o foco do trabalho,
 * as tarefas por assunto (com responsável e prazo), as decisões, os bloqueios e
 * as questões pendentes. O emoji do resumo vai antes do título da reunião, na
 * página que usa este componente.
 *
 * Nada extraído por IA entra sozinho: cada item nasce "para conferir", com o
 * trecho da transcrição que o sustenta, e a dona confirma ou ignora. Os
 * ignorados ficam recolhidos, com Desfazer. O "▶ mm:ss" leva o player da barra
 * do rodapé ao ponto do trecho. A dona também edita um item e acrescenta item
 * à mão (H4f, components/FormularioDoItemDoResumo.tsx): o que ela escreve vale
 * como confirmado, e a tela marca o que é dela. A ação ou tarefa confirmada
 * vira próxima ação (H5a, server/proximas-acoes.ts): o confirmado da IA tem
 * "Desfazer a confirmação", que nela pede confirmação antes, porque apaga a
 * próxima ação; o item que a dona escreveu não volta a "para conferir" e não
 * o tem. O Ignorar do formulário, na ação ou tarefa confirmada, também pede
 * confirmação antes, pelo mesmo motivo.
 *
 * Serve às duas telas: o detalhe da dona (pages/Meetings.tsx), que decide, e o
 * link aberto (pages/ReuniaoAberta.tsx), só de leitura: sem os botões de
 * decidir e com o aviso de que a dona ainda não conferiu nos pendentes. Nas
 * duas, a voz aparece com o nome que a dona deu, ou como "Falante n"; o link
 * recebe os nomes só quando foi ligado com a confirmação que fala deles (H3b).
 * A consulta mora na página (que também lê o emoji e repete a consulta
 * enquanto o resumo é gerado); as mutações moram aqui e a relêem.
 *
 * Os modelos (H4d, components/ModeloDoResumo.tsx): a dona escolhe o modelo ao
 * pedir o resumo e pode "Refazer como…" outro. Enquanto a versão nova é
 * escrita, a anterior fica na tela só para ler, para a dona e para o link. Se
 * a nova falhou, a anterior segue valendo: a dona decide sobre ela (o próximo
 * refazer guarda o que ela confirmar), e o link a mostra sem pedir de novo,
 * porque refazer é da dona.
 *
 * A tradução (H11) também mora na página (useTraducaoDoResumo), porque o mapa
 * mental usa a mesma: aqui ficam a escolha do idioma e o aviso, e os textos
 * traduzidos entram no lugar dos originais. O trecho fica sempre no original:
 * é por ele que se confere o item.
 *
 * "Ouvir o resumo" (H19, components/OuvirOResumo.tsx) lê nas duas telas o que
 * está à vista, na ordem da tela, com a voz do aparelho no idioma em que a IA
 * escreveu o resumo (ou no da tradução pronta, que é o texto à vista): os
 * títulos, os rótulos e o "Falante n" também saem nesse idioma, e não no da
 * tela, para a voz não ler uma língua com a pronúncia de outra. A voz lê os
 * mesmos nomes que a tela mostra (os da dona; pelo link, os do `vozes`).
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;
type Saidas = inferRouterOutputs<AppRouter>;
type ResumoDaDona = Saidas["meetings"]["resumoGuardado"];
type ResumoDoLink = Saidas["reuniaoAberta"]["resumoGuardado"];
// O link não recebe o id, a caixa de feito, a origem nem a marca da edição
// (server/resumo-guardado.ts): do que a dona escreveu (H4f), só a marca
// `escritoPelaDona`, que a dona não recebe (ela tem a origem e a edição).
type ItemDaDona = ResumoDaDona["itens"][number];
// `trechoForaDaTranscricao` só vem pelo link (H18): o trecho do item não está
// mais na transcrição que a dona editou, e o link o manda vazio.
type ItemNaTela = Omit<ResumoDoLink["itens"][number], "escritoPelaDona" | "trechoForaDaTranscricao"> & { escritoPelaDona?: boolean; trechoForaDaTranscricao?: boolean }
  & Partial<Pick<ItemDaDona, "id" | "done" | "origin" | "editedAt">>;
type Secao = ItemNaTela["section"];
type ConsultaDoResumo<T> = { data?: T; isError: boolean; error: unknown; refetch: () => unknown };

type DaDona = {
  meetingId: string;
  token?: undefined;
  consulta: ConsultaDoResumo<ResumoDaDona>;
  /** Os nomes que a dona deu às vozes (nomesDosFalantes(meeting.speakerNames)). */
  nomes?: Readonly<Record<string, string>>;
  /**
   * Quem falou na reunião (o falante de cada fala da transcrição: F1, F2...):
   * a voz sem nome que o resumo não cita também entra no responsável.
   */
  falantes?: readonly string[];
  aoIrPara?: (segundo: number) => void;
  /** A reunião do YouTube (H13): o "▶" do item abre o vídeo no segundo (TempoDoTrecho). */
  linkDoTempo?: (segundo: number) => string;
  /** O item pedido pelo link (?item=<id>): a tela rola até ele e o destaca. */
  itemDestacado?: string | null;
  /**
   * O último item até o qual a tela já rolou, guardado pela página: voltar à
   * aba Resumo (que remonta este componente) não rola de novo até o mesmo item.
   */
  registroDoDestaque?: { current: string | null };
  traducao?: TraducaoDoResumoNaTela;
  /** O link aberto está ligado: o formulário do item avisa que o que ela escreve aparece para quem tem o link. */
  comLinkAberto?: boolean;
  /** A reunião nasceu de um documento (H12): o título, o aviso e os trechos falam do documento, e não da transcrição. */
  documento?: boolean;
};
type DoLink = {
  token: string;
  meetingId?: undefined;
  consulta: ConsultaDoResumo<ResumoDoLink>;
  /**
   * Os nomes das vozes que o link recebeu (o `vozes` de reuniaoAberta.ver):
   * vazio quando o link foi ligado antes da confirmação que fala deles (H3b).
   */
  nomes?: Readonly<Record<string, string>>;
  aoIrPara?: (segundo: number) => void;
  linkDoTempo?: (segundo: number) => string;
  traducao?: TraducaoDoResumoNaTela;
  documento?: boolean;
};

// A ordem do formato da cliente.
const ORDEM_DAS_SECOES: readonly Secao[] = ["action", "focus", "task", "decision", "blocker", "question"];

// Os títulos moram em shared/falas-do-resumo.ts, que a voz do Gemini (H19b)
// também lê no servidor. O PDF da reunião (H8, ImpressaoDaReuniao.tsx) usa os
// mesmos títulos, no idioma dela.
export function tituloDaSecao(t: TranslateFn, secao: Secao) {
  return tituloDaSecaoNaFala(t, secao);
}

const codigoDoErro = (erro: unknown) => (erro as { data?: { code?: string } } | null)?.data?.code;
const MENSAGENS_DO_RESUMO = new Set([MENSAGEM_RESUMO_SENDO_GERADO, MENSAGEM_ITEM_NAO_ENCONTRADO, MENSAGEM_SO_ACAO_TEM_CAIXA, MENSAGEM_RESUMO_CHEIO]);

// As recusas do resumo vêm com frase própria do servidor, que a tabela
// de lib/mensagem-de-erro.ts traduz; as outras mensagens do servidor vêm em
// português, e a tela decide pelo código.
function mensagemDaDecisao(t: TranslateFn, erro: unknown) {
  const mensagem = (erro as { message?: unknown } | null)?.message;
  if (typeof mensagem === "string" && MENSAGENS_DO_RESUMO.has(mensagem)) return traduzirMensagemDoServidor(mensagem, t);
  switch (codigoDoErro(erro)) {
    case "CONFLICT": return t("meetings.summary.errorRegenerating");
    case "NOT_FOUND": return t("meetings.meetingNotFound");
    case "INTERNAL_SERVER_ERROR":
    case "TOO_MANY_REQUESTS": return mensagemDeErroParaTela(erro, t);
    default: return t("meetings.summary.decisionError");
  }
}

// G16: o idioma fora dos 10 da tela vai pelo nome no idioma de quem lê.
const nomeNaTela = (codigo: string | null, tela: string) => rotuloDoIdioma(codigo, tela);

// O nome de um idioma dito em outro ("português", "Portuguese"): a voz o lê
// no idioma da fala. Só a base, como a voz.
function nomeDoIdiomaEm(lingua: string, codigo: string) {
  const base = codigo.split("-")[0];
  try {
    return new Intl.DisplayNames([lingua], { type: "language" }).of(base) ?? base;
  } catch {
    return base;
  }
}

// O que a voz lê (a do aparelho e a do Gemini, H19 e H19b) mora em
// shared/falas-do-resumo.ts: as duas leem o mesmo texto. O complemento pela
// busca (H4i) entra só confirmado.
function falasDoResumo(t: TranslateFn, itens: ItemNaTela[], nomes: Readonly<Record<string, string>>, traduzidoDe: string | null = null): string[] {
  return falasCompartilhadas(t, itens.map(item => ({
    ...item, complemento: item.complemento?.situacao === "confirmed" ? { texto: item.complemento.texto } : null,
  })), nomes, traduzidoDe);
}

const idDoItem = (id: string) => `item-do-resumo-${id}`;
const movimentoReduzido = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// O falante no formato do rótulo de voz ({F1} a {F99}, shared/vozes-no-texto.ts);
// a lacuna da transcrição vem sem falante.
const FALANTE = /^F[1-9][0-9]?$/;

/**
 * As vozes que a dona pode pôr como responsável num item (H4f): as que ela
 * nomeou, as que falaram na reunião e as que o resumo cita, uma vez cada, na
 * ordem do número.
 */
function vozesDoResumo(itens: readonly ItemNaTela[], nomes: Readonly<Record<string, string>>, falantes: readonly string[]): string[] {
  const vozes = new Set([...Object.keys(nomes), ...falantes.filter(falante => FALANTE.test(falante))]);
  for (const item of itens) {
    for (const campo of [item.text, item.subject, item.assignee]) {
      for (const falante of vozesCitadas(campo)) vozes.add(falante);
    }
  }
  return Array.from(vozes).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

export function ResumoGuardado(props: DaDona | DoLink) {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  const peloLink = props.token !== undefined;
  const meetingId = props.meetingId ?? "";
  const token = props.token ?? "";
  // Para a dona, os nomes que ela deu; pelo link, os que o servidor mandou.
  const nomes = props.nomes ?? {};
  const falantes = props.token === undefined ? props.falantes ?? [] : [];
  const itemDestacado = props.token === undefined ? props.itemDestacado ?? null : null;
  const traducao = props.traducao;
  // O documento (H12) não tem transcrição: o título, o aviso e os trechos falam
  // dele (conferência de tela de 20/11/2026).
  const documento = !!props.documento;
  // Com a tradução pronta, os textos dos itens vêm no idioma escolhido.
  const original = props.consulta.data as ResumoDaDona | ResumoDoLink | undefined;
  const dados = traducao ? traducao.aplicar(original) : original;
  // O idioma de cada texto, para o leitor de tela: o item no da tradução, o trecho sempre no original.
  const idiomaDoTrecho = traducao?.idiomaOriginal ?? undefined;
  const idiomaDoTexto = traducao?.estado === "pronta" ? traducao.idioma : idiomaDoTrecho;
  const comEscolhaDoIdioma = !!traducao && traducao.estado !== "inativa";

  // Toda mutação relê o resumo; devolvida ao onSettled, a releitura segura o
  // botão até o estado novo chegar.
  const reler = () => peloLink
    ? utils.reuniaoAberta.resumoGuardado.invalidate({ token })
    : utils.meetings.resumoGuardado.invalidate({ meetingId });
  const aoFalharDecisao = (erro: unknown) => toast.error(mensagemDaDecisao(t, erro));
  // A próxima ação do item, com prazo, anda com a Google Agenda (H5c):
  // desconfirmar o item ou marcá-la feita tira o evento, e reabri-la o manda de
  // novo. A decisão fica; quando a Google falha, um aviso à parte, o mesmo da
  // lista (useAvisosDaAgenda). O evento que ficou lá porque a Google falhou
  // traz "Tentar de novo", pelo id da ação que a rota devolve: a ação apagada
  // (ou feita) não está mais em lista nenhuma para oferecê-lo.
  const avisos = useAvisosDaAgenda();
  const avisarDaAgenda = (resultado: (ResultadoNaGoogle & { acaoId: string | null }) | undefined, saiu: boolean) => {
    if (!saiu) avisos.depoisDeMandar(resultado);
    else if (resultado?.acaoId) avisos.depoisDeTirar(resultado.acaoId, resultado);
  };
  const pedirDaDona = trpc.meetings.pedirResumo.useMutation({ onSettled: reler });
  const pedirPeloLink = trpc.reuniaoAberta.pedirResumo.useMutation({ onSettled: reler });
  const decidir = trpc.meetings.decidirItemDoResumo.useMutation({
    onSuccess: resultado => avisarDaAgenda(resultado, true), onError: aoFalharDecisao, onSettled: reler,
  });
  const confirmarTodos = trpc.meetings.confirmarItensDoResumo.useMutation({ onError: aoFalharDecisao, onSettled: reler });
  const marcar = trpc.meetings.marcarAcaoFeita.useMutation({
    onSuccess: (resultado, variaveis) => avisarDaAgenda(resultado, variaveis.feito), onError: aoFalharDecisao, onSettled: reler,
  });
  const pedir = peloLink ? pedirPeloLink : pedirDaDona;
  // Sem modelo, o resumo que falhou reabre no modelo em que estava. Com o
  // pedido (H4d e H4e), o modelo, o estilo e as instruções.
  const pedirResumo = (pedido?: PedidoNaTela) => {
    if (peloLink) pedirPeloLink.mutate({ token });
    else pedirDaDona.mutate(pedido ? { meetingId, ...pedidoParaEnviar(pedido) } : { meetingId });
  };
  // Uma decisão por vez: a próxima espera a releitura da anterior.
  const decidindo = decidir.isPending || confirmarTodos.isPending || marcar.isPending;

  // O modelo do resumo (H4d) é só da dona: o link não o recebe. H4e: o modelo
  // pode ser um dela ou o que a IA escolheu, com o estilo e as instruções.
  const daDona = !peloLink ? (dados as ResumoDaDona | undefined) : undefined;
  const modelos = useModelosDaDona(!peloLink);
  const proprios = modelos.data?.proprios ?? (daDona?.modeloProprio ? [{ ...daDona.modeloProprio, instrucoes: "" }] : []);
  const escolhaAtual = daDona?.escolha ?? daDona?.modelo ?? MODELO_DE_RESUMO_PADRAO;
  const pedidoAtual: PedidoNaTela = { modelo: escolhaAtual, estilo: estiloDoResumo(daDona?.estilo) ?? ESTILO_DO_RESUMO_PADRAO, instrucoes: daDona?.instrucoes ?? "" };
  const nomeAtual = nomeDaEscolha(t, escolhaAtual, proprios);
  const [modeloDoPedido, setModeloDoPedido] = useState<PedidoNaTela>(PEDIDO_PADRAO);
  // O pedido começa no padrão da dona (H4e), até ela mexer.
  const mexeuNoPedido = useRef(false);
  const padraoModelo = modelos.data?.padrao;
  const padraoEstilo = estiloDoResumo(modelos.data?.estilo);
  useEffect(() => {
    if (padraoModelo && padraoEstilo && !mexeuNoPedido.current) setModeloDoPedido({ ...PEDIDO_PADRAO, modelo: padraoModelo, estilo: padraoEstilo });
  }, [padraoModelo, padraoEstilo]);
  const [meusModelosAbertos, setMeusModelosAbertos] = useState(false);
  // Os modelos da dona abrem onde ela escolhe um: antes de pedir e no resumo
  // pronto ou que falhou; não enquanto a IA escreve.
  const podeVerMeusModelos = !peloLink && (dados?.estado === "sem_resumo" || dados?.estado === "pronto" || dados?.estado === "falhou");
  const [refazerAberto, setRefazerAberto] = useState(false);
  const idDoPainelDeRefazer = useId();
  // Refazer o resumo pronto, ou o que falhou, em outro modelo; enquanto ele é
  // gerado, não.
  const podeRefazer = !peloLink && (dados?.estado === "pronto" || dados?.estado === "falhou");
  // O resumo que voltou à fila por outro caminho (outra aba, a fila) fecha o painel.
  useEffect(() => { if (!podeRefazer) setRefazerAberto(false); }, [podeRefazer]);

  // A versão anterior do resumo (H4d): ele está sendo refeito em outro modelo,
  // ou o refazer falhou. A dona e o link recebem os itens dela (o link, sem os
  // ignorados), e ela fica na tela até a nova chegar.
  const versaoAnterior = !!dados && dados.estado !== "pronto" && dados.versaoAnterior;
  // Enquanto a nova é escrita, a anterior é só para ler (decidir é recusado
  // até ela chegar). Se a nova falhou, a dona decide sobre a anterior.
  const somenteLeitura = versaoAnterior && dados?.estado !== "falhou";
  const itens: ItemNaTela[] = dados && (dados.estado === "pronto" || versaoAnterior) ? dados.itens : [];
  const visiveis = itens.filter(item => item.status !== "ignored");
  const ignorados = itens.filter(item => item.status === "ignored");
  const pendentes = visiveis.filter(item => item.status === "pending");
  const [verIgnorados, setVerIgnorados] = useState(false);
  // O Desfazer se repete em todo ignorado: o texto do item o descreve.
  const prefixoDosIgnorados = useId();

  // ?item=<id>: rola até o item e o destaca. Cada link diferente rola uma vez;
  // o item ignorado mora na lista recolhida, que abre antes.
  const alvo = itemDestacado ? itens.find(item => item.id === itemDestacado) : undefined;
  const alvoIgnorado = alvo?.status === "ignored";
  const itemNaoAchado = !!itemDestacado && dados?.estado === "pronto" && !alvo;
  const jaRolouAqui = useRef<string | null>(null);
  const jaRolou = (props.token === undefined ? props.registroDoDestaque : undefined) ?? jaRolouAqui;
  useEffect(() => {
    if (!itemDestacado || !alvo || jaRolou.current === itemDestacado) return;
    if (alvoIgnorado && !verIgnorados) {
      setVerIgnorados(true);
      return;
    }
    const elemento = document.getElementById(idDoItem(itemDestacado));
    if (!elemento) return;
    jaRolou.current = itemDestacado;
    elemento.scrollIntoView?.({ block: "center", behavior: movimentoReduzido() ? "auto" : "smooth" });
    elemento.focus({ preventScroll: true });
  }, [itemDestacado, !!alvo, alvoIgnorado, verIgnorados]);

  const comVozes = (texto: string) => vozesNoTexto(texto, nomes, numero => t("meetings.speakerLabel", { n: numero }));

  // Ouvir o resumo: o que está na tela com algo à vista (o pronto, ou a versão
  // anterior do resumo refeito, H4d), no idioma em que a IA o escreveu (o
  // resumo sem idioma gravado é de reunião antiga, em pt-BR).
  const podeOuvir = (dados?.estado === "pronto" || versaoAnterior) && visiveis.length > 0;
  // Com a tradução pronta (H11), o texto à vista é o traduzido: a voz, os
  // títulos e os rótulos vão no idioma dela, e a leitura começa dizendo que é
  // uma tradução da IA.
  const traduzido = traducao?.estado === "pronta";
  // A voz lê no idioma do texto (G16: qualquer um que a IA transcreve); os
  // títulos e os rótulos vêm dos 10 da tela, e o idioma fora deles fica com
  // os do padrão.
  const idiomaDoResumo = idiomaFalado(traduzido ? traducao.idioma : dados?.idioma) ?? IDIOMA_DA_REUNIAO_PADRAO;
  const idiomaDosRotulos = idiomaDaReuniao(idiomaDoResumo) ?? IDIOMA_DA_REUNIAO_PADRAO;
  const traduzidoDe = traduzido && traducao.idiomaOriginal ? nomeDoIdiomaEm(idiomaDosRotulos, traducao.idiomaOriginal) : null;
  const falas = podeOuvir ? falasDoResumo(i18n.getFixedT(idiomaDosRotulos), visiveis, nomes, traduzidoDe) : [];

  // Editar e acrescentar (H4f), só para a dona. O formulário recebe o que a
  // tela mostra no lugar de cada voz, para a dona editar o texto como o lê.
  const exibir = (falante: string) => comVozes(`{${falante}}`);
  const vozes = vozesDoResumo(itens, nomes, falantes);
  // Com a tradução pronta (H11), a tela mostra o texto traduzido, mas o item
  // guardado está no idioma do resumo: o formulário edita o original, para a
  // edição não gravar a tradução no lugar dele.
  const noOriginal = (item: ItemNaTela) => (original?.itens as ItemNaTela[] | undefined)?.find(daConsulta => daConsulta.id === item.id) ?? item;
  // Com o link ligado, o formulário avisa que o que ela escreve sai no link.
  const comLinkAberto = props.token === undefined && !!props.comLinkAberto;
  const formularioDoItem = (item: ItemNaTela, fechar: () => void) => item.id
    ? <FormularioDoItemDoResumo meetingId={meetingId} vozes={vozes} exibir={exibir} tituloDaSecao={secao => tituloDaSecao(t, secao)}
        item={{ id: item.id, section: item.section, subject: noOriginal(item).subject, text: noOriginal(item).text, assignee: noOriginal(item).assignee, due: noOriginal(item).due }}
        reler={reler} aoFalhar={aoFalharDecisao} aoFechar={fechar} decidindo={decidindo} comLinkAberto={comLinkAberto}
        aoSalvarEdicao={resultado => avisarDaAgenda(resultado, false)}
        ignorarApagaAcao={item.status === "confirmed" && viraProximaAcao(item.section)}
        aoIgnorar={() => { if (item.id) decidir.mutate({ itemId: item.id, status: "ignored" }); }}/>
    : null;
  const [acrescentando, setAcrescentando] = useState(false);
  // Fechado o formulário de acrescentar, o foco volta ao botão que o abriu.
  const botaoDeAcrescentar = useRef<HTMLButtonElement>(null);
  const focarAcrescentar = useRef(false);
  useEffect(() => {
    if (acrescentando || !focarAcrescentar.current) return;
    focarAcrescentar.current = false;
    botaoDeAcrescentar.current?.focus();
  }, [acrescentando]);

  // Erro de consulta é erro, nunca "sem resumo" nem "gerando". Pelo link,
  // NOT_FOUND ou BAD_REQUEST é o link desligado (ou cortado) no meio da visita:
  // definitivo, como em pages/ReuniaoAberta.tsx, sem tentar de novo.
  const codigoDaConsulta = codigoDoErro(props.consulta.error);
  const naoAchou = codigoDaConsulta === "NOT_FOUND" || (peloLink && codigoDaConsulta === "BAD_REQUEST");
  const erroDaConsulta = !props.consulta.isError ? null
    : naoAchou
      ? <p role="alert" className="mt-4 text-sm text-white/70">{peloLink ? t("meetings.openLink.notFound") : t("meetings.meetingNotFound")}</p>
      : <div className="mt-4"><ErroDeConsulta erro={props.consulta.error} aoTentarDeNovo={() => void props.consulta.refetch()}/></div>;
  // A releitura que falha deixa o dado velho no cache. Sem dado, ou com o
  // resumo ainda na fila, o erro toma o lugar do aviso, que senão giraria para
  // sempre; com o resumo pronto, falho ou ausente, ele vai acima do conteúdo
  // (e também quando o resumo é refeito, porque a versão anterior está na tela).
  const esperando = !dados || ((dados.estado === "pendente" || dados.estado === "gerando") && !versaoAnterior);
  // O erro do pedido é do botão de pedir: quando o resumo anda por outro
  // caminho (a fila, outro pedido pelo link), ele sai da tela com o botão. O
  // link não tem o botão no refazer que falhou: refazer é da dona.
  const comBotaoDePedir = dados?.estado === "sem_resumo" || (dados?.estado === "falhou" && !(peloLink && versaoAnterior));

  let corpo: ReactNode;
  if (esperando && erroDaConsulta) {
    corpo = erroDaConsulta;
  } else if (!dados) {
    corpo = <p role="status" className="mt-4 text-sm text-white/55"><Loader2 size={15} className="mr-2 inline animate-spin"/>{t("meetings.summary.loading")}</p>;
  } else if (dados.estado === "sem_resumo" && peloLink) {
    corpo = <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-white/60">{t("meetings.summary.noSummary")}</p>
      <BotaoDePedir aoClicar={() => pedirResumo()} pedindo={pedir.isPending}>{t("meetings.summary.requestLink")}</BotaoDePedir>
    </div>;
  } else if (dados.estado === "sem_resumo") {
    // A dona escolhe o modelo (H4d) antes de pedir.
    corpo = <div className="mt-4 space-y-3">
      <p className="text-sm text-white/60">{t("meetings.summary.noSummary")}</p>
      <EscolhaDoModelo valor={modeloDoPedido} aoMudar={pedido => { mexeuNoPedido.current = true; setModeloDoPedido(pedido); }} desligado={pedir.isPending} proprios={proprios}>
        <BotaoDePedir aoClicar={() => pedirResumo(modeloDoPedido)} pedindo={pedir.isPending}>{t("meetings.summary.generate")}</BotaoDePedir>
      </EscolhaDoModelo>
    </div>;
  } else if ((dados.estado === "pendente" || dados.estado === "gerando") && !versaoAnterior) {
    corpo = <p role="status" className="mt-4 text-sm text-white/60"><Loader2 size={15} className="mr-2 inline animate-spin"/>{t("meetings.summary.generating")}
      {/* "A IA escolhe o modelo" (H4e): a escolha vem antes do resumo. */}
      {daDona?.iaVaiEscolher && <span className="ml-2 text-xs text-amber-100/70">{t("meetings.summary.aiWillChoose")}</span>}</p>;
  } else if (dados.estado === "falhou" && !versaoAnterior) {
    corpo = <div role="alert" className="mt-4 flex flex-col gap-3 rounded-xl border border-red-400/20 bg-red-400/10 p-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-red-200">{t("meetings.summary.failed")}</p>
      <BotaoDePedir aoClicar={() => pedirResumo()} pedindo={pedir.isPending}>{t("meetings.summary.retry")}</BotaoDePedir>
    </div>;
  } else {
    corpo = <div className="mt-4 space-y-5">
      {/* O resumo refeito em outro modelo (H4d): a versão anterior fica na
          tela até a nova chegar; se a nova falhou, também. O link não recebe
          o modelo: o aviso dele é outro, e sem o "Tentar de novo". */}
      {versaoAnterior && peloLink && <p role="status" className="rounded-xl border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-sm text-amber-100">
        {somenteLeitura && <Loader2 size={15} className="mr-2 inline animate-spin"/>}{t("meetings.summary.linkPreviousVersion")}
      </p>}
      {versaoAnterior && !peloLink && dados.estado !== "falhou" && <p role="status" className="rounded-xl border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-sm text-amber-100">
        <Loader2 size={15} className="mr-2 inline animate-spin"/>{t("meetings.summary.redoing", { modelo: nomeAtual })}
      </p>}
      {versaoAnterior && !peloLink && dados.estado === "falhou" && <div role="alert" className="flex flex-col gap-3 rounded-xl border border-red-400/20 bg-red-400/10 p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-red-200">{t("meetings.summary.redoFailed", { modelo: nomeAtual })}</p>
        <BotaoDePedir aoClicar={() => pedirResumo()} pedindo={pedir.isPending}>{t("meetings.summary.retry")}</BotaoDePedir>
      </div>}
      {!peloLink && !somenteLeitura && pendentes.length > 0 && <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <AvisoDeConferir>{documento ? t("meetings.document.summaryReviewNotice") : t("meetings.summary.reviewNotice")}</AvisoDeConferir>
        <button type="button" disabled={decidindo} onClick={() => confirmarTodos.mutate({ meetingId })}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-amber-300/40 px-3 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-300/10 disabled:opacity-50">
          <Check size={15}/> {t("meetings.summary.confirmAll", { n: pendentes.length })}
        </button>
      </div>}
      {itemNaoAchado && <p role="status" className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/60">{t("meetings.summary.itemNotFound")}</p>}
      {!visiveis.length && <p className="text-sm text-white/55">{t("meetings.summary.empty")}</p>}
      {ORDEM_DAS_SECOES.map(secao => {
        const daSecao = visiveis.filter(item => item.section === secao);
        if (!daSecao.length) return null;
        return <section key={secao} aria-labelledby={`secao-do-resumo-${secao}`}>
          <h3 id={`secao-do-resumo-${secao}`} className="text-sm font-semibold text-amber-200">{tituloDaSecao(t, secao)}</h3>
          <ul className="mt-2 space-y-3">
            {daSecao.map((item, i) => <ItemDoResumo key={item.id ?? `${secao}-${i}`} item={item} peloLink={peloLink} documento={documento} comVozes={comVozes} idiomaDoTexto={idiomaDoTexto} idiomaDoTrecho={idiomaDoTrecho}
              aoIrPara={props.aoIrPara} linkDoTempo={props.linkDoTempo} destacado={!!item.id && item.id === itemDestacado} decidindo={decidindo} somenteLeitura={somenteLeitura} reler={reler}
              aoDecidir={status => { if (item.id) decidir.mutate({ itemId: item.id, status }); }}
              aoMarcar={feito => { if (item.id) marcar.mutate({ itemId: item.id, feito, ...pedidoDaTela(t) }); }}
              formularioDeEdicao={!peloLink && !somenteLeitura && item.id ? fechar => formularioDoItem(item, fechar) : undefined}/>)}
          </ul>
        </section>;
      })}
      {/* Editar e acrescentar (H4f) somem, como as decisões, enquanto o resumo é refeito (H4d). */}
      {!peloLink && !somenteLeitura && (acrescentando
        ? <FormularioDoItemDoResumo meetingId={meetingId} vozes={vozes} exibir={exibir} tituloDaSecao={secao => tituloDaSecao(t, secao)} comLinkAberto={comLinkAberto}
            reler={reler} aoFalhar={aoFalharDecisao} aoFechar={() => { focarAcrescentar.current = true; setAcrescentando(false); }}/>
        : <button ref={botaoDeAcrescentar} type="button" onClick={() => setAcrescentando(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-dashed border-amber-300/40 px-3 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-300/10">
            <Plus size={15}/> {t("meetings.summary.addItem")}
          </button>)}
      {/* "O resumo teve o tamanho certo?" (H4e), só da dona e no resumo pronto. */}
      {!peloLink && dados.estado === "pronto" && visiveis.length > 0 && <PerguntaDoTamanho meetingId={meetingId} resposta={daDona?.tamanho ?? null}/>}
      {!peloLink && ignorados.length > 0 && <div className="border-t border-white/10 pt-4">
        <button type="button" aria-expanded={verIgnorados} onClick={() => setVerIgnorados(aberta => !aberta)}
          className="inline-flex items-center gap-2 text-sm text-white/55 hover:text-white">
          <ChevronDown size={15} className={verIgnorados ? "rotate-180" : ""}/> {t("meetings.summary.showIgnored", { n: ignorados.length })}
        </button>
        {verIgnorados && <ul className="mt-3 space-y-2">
          {ignorados.map((item, i) => <li key={item.id ?? i} id={item.id ? idDoItem(item.id) : undefined} tabIndex={item.id === itemDestacado ? -1 : undefined}
            data-destacado={item.id === itemDestacado ? "true" : undefined}
            className={`flex items-start justify-between gap-3 rounded-lg px-3 py-2 text-sm text-white/45 ${item.id === itemDestacado ? "ring-2 ring-amber-300/70" : ""}`}>
            <span id={`${prefixoDosIgnorados}-${i}`} dir="auto" lang={idiomaDoTexto} className="line-through">{item.subject ? `${comVozes(item.subject)}: ` : ""}{comVozes(item.text)}</span>
            {!somenteLeitura && <button type="button" aria-describedby={`${prefixoDosIgnorados}-${i}`} disabled={decidindo} onClick={() => { if (item.id) decidir.mutate({ itemId: item.id, status: "pending" }); }}
              className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-amber-200 hover:text-amber-100 disabled:opacity-50">
              <RotateCcw size={13}/> {t("meetings.summary.undo")}
            </button>}
          </li>)}
        </ul>}
      </div>}
    </div>;
  }

  return <section aria-labelledby="resumo-guardado" className="rounded-2xl border border-amber-300/25 bg-amber-300/[0.06] p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <h2 id="resumo-guardado" className="inline-flex items-center gap-2 text-base font-semibold text-amber-100"><Sparkles size={16}/>{documento ? t("meetings.document.summaryTitle") : t("meetings.summary.title")}</h2>
      {(comEscolhaDoIdioma || podeRefazer || podeOuvir || podeVerMeusModelos) && <div className="flex flex-wrap items-center gap-3">
        {/* O idioma do resumo (H11): começa no da tela, e o original fica marcado. */}
        {traducao && comEscolhaDoIdioma && <label className="inline-flex items-center gap-2 text-xs text-amber-100/70">
          {t("meetings.summary.translation.language")}
          <select value={traducao.idioma} onChange={evento => { const idioma = idiomaFalado(evento.target.value); if (idioma) traducao.escolher(idioma); }}
            className="rounded-lg border border-white/15 bg-[#211e1b] px-2 py-1 text-sm text-white">
            <OpcaoDoIdiomaOriginal idioma={traducao.idiomaOriginal}/>
            {LANGUAGES.map(idioma => <option className="bg-white text-[#322C26]" key={idioma.code} value={idioma.code}>{idioma.flag} {idioma.label}{idioma.code === traducao.idiomaOriginal ? ` ${t("meetings.originalLanguageSuffix")}` : ""}</option>)}
          </select>
        </label>}
        {/* O modelo (H4d) e o "Refazer como…", só da dona. */}
        {podeRefazer && dados?.estado === "pronto" && <span className="text-xs text-amber-100/70">
          {t("meetings.summary.currentTemplate", { modelo: nomeAtual })}
          {pedidoAtual.estilo !== ESTILO_DO_RESUMO_PADRAO && ` · ${nomeDoEstilo(t, pedidoAtual.estilo)}`}
          {daDona?.escolhidoPelaIA && <span className="ml-2 rounded-full border border-amber-300/40 px-2 py-0.5">{t("meetings.summary.chosenByAi")}</span>}
        </span>}
        {podeRefazer && <button type="button" aria-expanded={refazerAberto} aria-controls={refazerAberto ? idDoPainelDeRefazer : undefined} onClick={() => setRefazerAberto(aberto => !aberto)}
          className="inline-flex items-center gap-2 rounded-lg border border-amber-300/40 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-300/10">
          <RefreshCw size={13}/> {t("meetings.summary.redoAs")}
        </button>}
        {/* Os modelos da dona e o padrão (H4e), só da dona. */}
        {podeVerMeusModelos && <button type="button" aria-expanded={meusModelosAbertos} onClick={() => setMeusModelosAbertos(aberto => !aberto)}
          className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/70 hover:text-white">
          {t("meetings.summary.myTemplates.open")}
        </button>}
        {/* "Ouvir o resumo" (H19), nas duas telas. */}
        {podeOuvir && <OuvirOResumo falas={falas} idioma={idiomaDoResumo}/>}
        {/* "Baixar o áudio do resumo" (H19b), com a voz do Gemini: só a dona, sob demanda. */}
        {podeOuvir && !peloLink && <BaixarAudioDoResumo meetingId={meetingId} idioma={idiomaDoResumo}/>}
      </div>}
    </div>
    {podeRefazer && refazerAberto && <PainelDeRefazer id={idDoPainelDeRefazer} meetingId={meetingId} atual={pedidoAtual} aoFechar={() => setRefazerAberto(false)}/>}
    {podeVerMeusModelos && meusModelosAbertos && <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4"><MeusModelosDeResumo/></div>}
    {traducao?.estado === "traduzindo" && <p role="status" className="mt-3 text-xs text-amber-100/70"><Loader2 size={13} className="mr-1.5 inline animate-spin"/>{t("meetings.summary.translation.translating")}</p>}
    {traducao?.estado === "pronta" && <p className="mt-3 text-xs text-white/45">{t("meetings.summary.translation.notice", { idioma: nomeNaTela(traducao.idiomaOriginal, i18n.resolvedLanguage ?? i18n.language) })}</p>}
    {traducao?.estado === "erro" && <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 text-xs text-amber-200/80">
      <span>{mensagemDaFalhaDaTraducao(t, traducao.erro, peloLink, t("meetings.summary.translation.error"))}</span>
      <button type="button" onClick={traducao.tentarDeNovo} className="rounded-lg border border-amber-300/30 px-3 py-1 font-semibold text-amber-200 hover:bg-amber-300/10">{t("meetings.summary.retry")}</button>
    </div>}
    {!esperando && erroDaConsulta}
    {corpo}
    {comBotaoDePedir && pedir.isError && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{mensagemDoErroDaIA(t, pedir.error, t("meetings.summary.requestError"), peloLink)}</p>}
  </section>;
}

function BotaoDePedir({ aoClicar, pedindo, children }: { aoClicar: () => void; pedindo: boolean; children: ReactNode }) {
  return <button type="button" onClick={aoClicar} disabled={pedindo}
    className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-60">
    {pedindo ? <Loader2 size={15} className="animate-spin"/> : <Sparkles size={15}/>} {children}
  </button>;
}

function ItemDoResumo({ item, peloLink, documento, comVozes, idiomaDoTexto, idiomaDoTrecho, aoIrPara, linkDoTempo, destacado, decidindo, somenteLeitura, aoDecidir, aoMarcar, formularioDeEdicao, reler }: {
  /** Relê o resumo depois de pedir ou decidir o complemento (H4i). */
  reler: () => unknown;
  item: ItemNaTela;
  peloLink: boolean;
  /** O item de um resumo de documento (H12): o trecho é do texto do documento. */
  documento: boolean;
  comVozes: (texto: string) => string;
  idiomaDoTexto?: string;
  idiomaDoTrecho?: string;
  aoIrPara?: (segundo: number) => void;
  linkDoTempo?: (segundo: number) => string;
  destacado: boolean;
  decidindo: boolean;
  /** A versão anterior do resumo que está sendo refeito (H4d): a caixa fica, travada, e não há botões de decidir. */
  somenteLeitura: boolean;
  aoDecidir: (status: "confirmed" | "ignored" | "pending") => void;
  aoMarcar: (feito: boolean) => void;
  /** Só para a dona (H4f): o formulário que edita o item, no lugar dele. */
  formularioDeEdicao?: (fechar: () => void) => ReactNode;
}) {
  const { t } = useTranslation();
  const pendente = item.status === "pending";
  // A caixa é só da dona: o link não recebe o feito, e não decide nada.
  const comCaixa = item.section === "action" && !peloLink;
  // O item da IA que a dona editou (H4f); pelo link, o escrito por ela que tem
  // trecho (o acrescentado não tem).
  const editadoPelaDona = peloLink ? !!item.escritoPelaDona && !!item.excerpt : item.origin !== "owner" && item.editedAt != null;
  // O item que a dona escreveu, acrescentado ou editado (H4f): não volta a "para conferir".
  const escritoPelaDona = !peloLink && (item.origin === "owner" || item.editedAt != null);
  // Confirmar, Ignorar e Editar se repetem em todo item: o texto do item os descreve.
  const idDoTexto = useId();
  const [editando, setEditando] = useState(false);
  // Fechado o formulário, o foco volta ao Editar do item.
  const botaoDeEditar = useRef<HTMLButtonElement>(null);
  const focarEditar = useRef(false);
  useEffect(() => {
    if (editando || !focarEditar.current) return;
    focarEditar.current = false;
    botaoDeEditar.current?.focus();
  }, [editando]);
  const atributos = {
    id: item.id ? idDoItem(item.id) : undefined,
    tabIndex: destacado ? -1 : undefined,
    "data-destacado": destacado ? "true" : undefined,
  };
  if (editando && formularioDeEdicao) {
    return <li {...atributos} className={`rounded-xl outline-none ${destacado ? "ring-2 ring-amber-300/60" : ""}`}>
      {formularioDeEdicao(() => { focarEditar.current = true; setEditando(false); })}
    </li>;
  }
  const editar = formularioDeEdicao && <button ref={botaoDeEditar} type="button" aria-describedby={idDoTexto} onClick={() => setEditando(true)}
    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-white/55 hover:bg-white/5 hover:text-white">
    <Pencil size={13}/> {t("meetings.summary.edit")}
  </button>;
  const texto = <>{item.subject && <strong className="font-semibold text-white/90">{comVozes(item.subject)}: </strong>}{comVozes(item.text)}</>;
  return <li {...atributos}
    className={`rounded-xl border p-3 outline-none ${destacado ? "border-amber-300/70 ring-2 ring-amber-300/60" : pendente ? "border-amber-300/20 bg-black/10" : "border-white/10 bg-black/5"}`}>
    {comCaixa
      ? <label className="flex cursor-pointer items-start gap-3">
          <input type="checkbox" checked={!!item.done} disabled={decidindo || somenteLeitura} onChange={evento => aoMarcar(evento.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-amber-400"/>
          <span id={idDoTexto} dir="auto" lang={idiomaDoTexto} className={`text-sm text-white/85 ${item.done ? "line-through text-white/50" : ""}`}>{texto}</span>
        </label>
      : <p id={idDoTexto} dir="auto" lang={idiomaDoTexto} className="text-sm leading-6 text-white/85">{texto}</p>}
    {(item.assignee || item.due) && <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-amber-100/70">
      {item.assignee && <span dir="auto">{t("meetings.summary.assignee", { nome: comVozes(item.assignee) })}</span>}
      {item.due && <span dir="auto" lang={idiomaDoTexto}>{t("meetings.summary.due", { prazo: item.due })}</span>}
    </p>}
    {/* O complemento pela busca na web (H4i): marcado "fora da reunião, a
        conferir"; pelo link, só o confirmado. */}
    <ComplementoDoItem itemId={item.id} complemento={item.complemento} peloLink={peloLink} podeMexer={!somenteLeitura && item.status !== "ignored"}
      reler={reler} idiomaDoTexto={idiomaDoTexto}/>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {/* Sem player (a gravação venceu ou não existe), o tempo é só
          informação: nada de botão desligado anunciando "Ouvir". O mesmo
          "▶" das citações do Pergunte à reunião (TempoDoTrecho). */}
      {item.startSeconds !== null && <TempoDoTrecho segundos={item.startSeconds} aoIrPara={aoIrPara} linkDoTempo={linkDoTempo}/>}
      {pendente && !peloLink && <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[11px] font-semibold text-amber-200">{t("meetings.summary.toReview")}</span>}
      {/* O que a dona escreveu (H4f): para ela, se acrescentou ou editou; pelo
          link, uma marca só, de que não é texto da IA, sem dizer quem é. */}
      {!peloLink && item.origin === "owner" && <span className="text-[11px] text-white/45">{t("meetings.summary.addedByOwner")}</span>}
      {!peloLink && item.origin !== "owner" && item.editedAt != null && <span className="text-[11px] text-white/45">{t("meetings.summary.editedByOwner")}</span>}
      {peloLink && item.escritoPelaDona && <span className="text-[11px] text-white/45">{t("meetings.summary.linkWrittenByOwner")}</span>}
      {!pendente && editar && <span className="ms-auto">{editar}</span>}
    </div>
    {/* O trecho fica aberto enquanto o item espera a conferência; depois,
        recolhido. O item que a dona acrescentou não tem trecho. O do item que
        ela editou é o da versão da IA: "trecho original", porque pode não
        sustentar mais o que ela escreveu. */}
    {item.excerpt ? (pendente
      ? <Trecho texto={item.excerpt} documento={documento}/>
      : <details className="mt-2">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-white/35">{editadoPelaDona
            ? (documento ? t("meetings.document.originalExcerptLabel") : t("meetings.summary.originalExcerptLabel"))
            : (documento ? t("meetings.document.excerptLabel") : t("meetings.ai.excerptLabel"))}</summary>
          <q dir="auto" lang={idiomaDoTrecho} className="mt-1 block border-l-2 border-amber-300/40 pl-3 text-xs italic text-white/55">{item.excerpt}</q>
        </details>) : null}
    {/* H18: pelo link, o trecho que não está mais na transcrição que a dona
        editou vem vazio (server/editar-transcricao.ts); a página diz por quê. */}
    {peloLink && item.trechoForaDaTranscricao && <p className="mt-2 text-[11px] text-white/45">{t("meetings.editTranscript.excerptCorrected")}</p>}
    {pendente && peloLink && <p className="mt-2 text-xs text-amber-100/70">{t("meetings.summary.linkNotice")}</p>}
    {/* O confirmado: o caminho até a próxima ação (H5a) e o "Desfazer a
        confirmação", que some enquanto o resumo é refeito (H4d) e no item
        que a dona escreveu (H4f), que não volta a "para conferir". */}
    {item.status === "confirmed" && !peloLink && <DesfazerConfirmacao viraAcao={viraProximaAcao(item.section)} desabilitado={decidindo}
      podeDesfazer={!somenteLeitura && !escritoPelaDona} descritoPor={idDoTexto} aoDesfazer={() => aoDecidir("pending")}/>}
    {pendente && !peloLink && !somenteLeitura && <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" aria-describedby={idDoTexto} disabled={decidindo} onClick={() => aoDecidir("confirmed")}
        className="inline-flex items-center gap-1 rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-bold text-[#1a120c] disabled:opacity-50"><Check size={14}/> {t("meetings.summary.confirm")}</button>
      <button type="button" aria-describedby={idDoTexto} disabled={decidindo} onClick={() => aoDecidir("ignored")}
        className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/65 disabled:opacity-50"><X size={14}/> {t("meetings.summary.ignore")}</button>
      {editar}
    </div>}
  </li>;
}

/**
 * O item confirmado volta a "para conferir" (H5a). A ação ou tarefa confirmada
 * virou próxima ação, e desconfirmar a apaga no servidor: antes, a tela pede a
 * confirmação. Os outros itens voltam direto. Sem `podeDesfazer` (o resumo
 * sendo refeito, H4d, ou o item que a dona escreveu, H4f), fica só o caminho
 * até a próxima ação.
 */
function DesfazerConfirmacao({ viraAcao, desabilitado, podeDesfazer, descritoPor, aoDesfazer }: {
  viraAcao: boolean;
  desabilitado: boolean;
  podeDesfazer: boolean;
  descritoPor: string;
  aoDesfazer: () => void;
}) {
  const { t } = useTranslation();
  const [perguntando, setPerguntando] = useState(false);
  if (!viraAcao && !podeDesfazer) return null;
  if (perguntando && podeDesfazer) {
    return <div className="mt-3 rounded-lg border border-amber-300/30 bg-amber-300/[0.06] p-3 text-xs text-amber-100">
      <p>{t("proximasAcoes.undoConfirmQuestion")}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" aria-describedby={descritoPor} disabled={desabilitado} onClick={() => { setPerguntando(false); aoDesfazer(); }}
          className="rounded-lg bg-amber-400 px-3 py-1.5 font-bold text-[#1a120c] disabled:opacity-50">{t("proximasAcoes.undoConfirmYes")}</button>
        <button type="button" onClick={() => setPerguntando(false)}
          className="rounded-lg border border-white/15 px-3 py-1.5 text-white/70">{t("proximasAcoes.cancel")}</button>
      </div>
    </div>;
  }
  return <div className="mt-2 flex flex-wrap items-center gap-4 text-xs">
    {viraAcao && <Link href={ROTA_DAS_PROXIMAS_ACOES} className="font-semibold text-amber-200 hover:text-amber-100">{t("proximasAcoes.inNextActions")}</Link>}
    {podeDesfazer && <button type="button" aria-describedby={descritoPor} disabled={desabilitado} onClick={() => (viraAcao ? setPerguntando(true) : aoDesfazer())}
      className="inline-flex items-center gap-1 text-white/45 hover:text-white/75 disabled:opacity-50">
      <RotateCcw size={12} aria-hidden/> {t("proximasAcoes.undoConfirm")}
    </button>}
  </div>;
}
