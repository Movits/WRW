import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { useTranslation } from "react-i18next";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "@/lib/trpc";
import { useNovaTentativa } from "@/hooks/useNovaTentativa";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { IDIOMA_DA_REUNIAO_PADRAO, idiomaDaReuniao, type IdiomaDaReuniao } from "@shared/idioma-da-reuniao";

/**
 * A tradução do resumo guardado (H11) para quem lê: começa no idioma da tela,
 * e quem lê pode escolher outro, ou o original. O resumo é escrito no idioma da
 * reunião; quando quem lê está em outro, a tela pede a tradução ao servidor,
 * que a faz em segundo plano e responde "traduzindo" até ela ficar pronta, e a
 * tela pergunta de novo a cada 5 s (como a tradução da transcrição, G8).
 *
 * Mora na página, e não no resumo, porque o mapa mental (H10) usa a mesma
 * tradução: `traduzirRotulo` dá cada rótulo dele no idioma escolhido. O mapa
 * fica pronto depois do resumo (numa chamada própria da IA, ou pelo "Gerar
 * mapa" de uma reunião antiga): a página passa os rótulos dele, e o mapa que
 * chega pede de novo. O servidor traduz só os rótulos que faltam, e o resumo
 * segue traduzido na tela até a resposta.
 *
 * - Para a dona, os textos traduzidos vêm pelo id do item e entram sobre o
 *   resumo que ela já lê: o estado de cada item continua vindo do resumo, e
 *   decidir não pede outra tradução.
 * - Pelo link, o servidor devolve o resumo inteiro, já traduzido, sem ids.
 * - O texto do resumo que muda (item editado, resumo refeito) pede de novo: o
 *   servidor traduz só o que mudou. Até a resposta, a tela mostra o original.
 * - O servidor que responde "sem resumo" ou "original" sabe de um resumo que a
 *   tela ainda não leu (refeito, reprocessado, em outro idioma): não há o que
 *   traduzir, a tela para de perguntar e relê o resumo.
 * - A versão anterior do resumo refeito (H4d, `versaoAnterior`) vale como o
 *   resumo pronto: ela fica na tela, e a tradução dela também. Enquanto o
 *   refazer escreve a nova, o servidor responde com a tradução guardada.
 * - O mapa pronto com o resumo vazio (a conferência tirou todos os itens, ou
 *   pelo link a dona ignorou todos) também se traduz: os rótulos dele bastam.
 */

type Saidas = inferRouterOutputs<AppRouter>;
type ResumoDaDona = Saidas["meetings"]["resumoGuardado"];
type ResumoDoLink = Saidas["reuniaoAberta"]["resumoGuardado"];
type Resumo = ResumoDaDona | ResumoDoLink;
type Resposta = Saidas["meetings"]["traduzirResumo"] | Saidas["reuniaoAberta"]["traduzirResumo"];
type Pronta = Extract<Resposta, { estado: "pronta" }>;

/** inativa: não há resumo pronto com itens; original: quem lê escolheu o idioma em que ele foi escrito. */
export type EstadoDaTraducaoDoResumo = "inativa" | "original" | "traduzindo" | "pronta" | "erro";

export type TraducaoDoResumoNaTela = {
  idioma: IdiomaDaReuniao;
  /** O idioma em que o resumo foi escrito; null sem resumo pronto. */
  idiomaOriginal: IdiomaDaReuniao | null;
  estado: EstadoDaTraducaoDoResumo;
  erro: unknown;
  escolher: (idioma: IdiomaDaReuniao) => void;
  tentarDeNovo: () => void;
  /** O resumo com os textos no idioma escolhido, com a tradução pronta; senão, o mesmo resumo. */
  aplicar: <T extends Resumo>(resumo: T | undefined) => T | undefined;
  /** Um rótulo do mapa mental no idioma escolhido; sem tradução, o próprio rótulo. */
  traduzirRotulo: (rotulo: string) => string;
};

type Alvo = { meetingId: string; token?: undefined } | { token: string; meetingId?: undefined };
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/**
 * A falha da tradução do resumo, dita no idioma da tela, para o resumo e para o
 * mapa mental: o teto e a reunião que sumiu pelo código, o banco fora do ar
 * pela frase do servidor; o resto, a frase `padrao` de quem mostra (o resumo
 * ou o mapa aparecem no idioma original).
 */
export function mensagemDaFalhaDaTraducao(t: TranslateFn, erro: unknown, peloLink: boolean, padrao: string) {
  switch ((erro as { data?: { code?: string } } | null)?.data?.code) {
    case "TOO_MANY_REQUESTS": return t("assistenteTexto.muitosPedidos");
    case "NOT_FOUND": return peloLink ? t("meetings.openLink.notFound") : t("meetings.meetingNotFound");
    // Pelo link com senha (H23), a entrada que venceu: a página relê a reunião e traz a tela da senha.
    case "UNAUTHORIZED": return peloLink ? t("meetings.openLink.password.required") : padrao;
    case "INTERNAL_SERVER_ERROR": return mensagemDeErroParaTela(erro, t);
    default: return padrao;
  }
}

/** O resumo que está na tela: o pronto, ou a versão anterior do resumo refeito (H4d). */
function resumoNaTela<T extends Resumo>(resumo: T | undefined): T | null {
  return resumo && (resumo.estado === "pronto" || resumo.versaoAnterior) ? resumo : null;
}

/** `rotulosDoMapa`: os rótulos do mapa mental pronto (H10), que entram na tradução; sem mapa, nada. */
export function useTraducaoDoResumo(alvo: Alvo, resumo: Resumo | undefined, rotulosDoMapa?: readonly string[]): TraducaoDoResumoNaTela {
  const { i18n } = useTranslation();
  const peloLink = alvo.token !== undefined;
  const chaveDoAlvo = peloLink ? `t:${alvo.token}` : `m:${alvo.meetingId}`;
  // O idioma RESOLVIDO da tela: o pedido pode ser regional ("en-US").
  const idiomaDaTela = idiomaDaReuniao(i18n.resolvedLanguage ?? i18n.language) ?? IDIOMA_DA_REUNIAO_PADRAO;
  // null: acompanha o idioma da tela.
  const [escolhido, setEscolhido] = useState<IdiomaDaReuniao | null>(null);
  const idioma = escolhido ?? idiomaDaTela;

  const pronto = resumoNaTela(resumo);
  // Como o servidor: o resumo sem idioma gravado conta como o padrão.
  const idiomaOriginal = pronto ? idiomaDaReuniao(pronto.idioma) ?? IDIOMA_DA_REUNIAO_PADRAO : null;
  // Há o que traduzir: um item à vista ou um rótulo do mapa pronto.
  const ativa = !!pronto && (pronto.itens.length > 0 || (rotulosDoMapa?.length ?? 0) > 0);
  const precisa = ativa && idioma !== idiomaOriginal;
  // Os textos do resumo: mudou um, a tradução guardada não serve mais. Pelo
  // link, que recebe o resumo inteiro traduzido e o põe no lugar do que leu,
  // conta também o que a tela mostra de cada item e a tradução não muda: o
  // estado, o responsável e a marca do que a dona escreveu (H4f).
  const itens = pronto?.itens;
  const assinatura = useMemo(() => (itens ?? []).map(item => [
    "id" in item ? item.id : "", item.subject ?? "", item.text, item.due ?? "",
    ...(peloLink ? [item.status, item.assignee ?? "", "escritoPelaDona" in item && item.escritoPelaDona ? "1" : ""] : []),
  ].join("\u0001")).join("\u0002"), [itens, peloLink]);

  // A tradução vale para estes textos, neste idioma, nesta reunião.
  const chaveDosTextos = `${chaveDoAlvo}|${idioma}|${assinatura}`;
  // Sem ordem nem repetição: o mesmo mapa, num array novo, não pede de novo.
  const chaveDoMapa = useMemo(() => Array.from(new Set(rotulosDoMapa ?? [])).sort().join("\u0001"), [rotulosDoMapa]);

  const novaTentativa = useNovaTentativa(`${chaveDosTextos}|${chaveDoMapa}`);
  const [traducao, setTraducao] = useState<Pronta | null>(null);
  const [erro, setErro] = useState<unknown>(null);
  // A resposta do servidor de que não há o que traduzir nestes textos.
  const [semTraducao, setSemTraducao] = useState<{ chave: string; estado: "sem_resumo" | "original" } | null>(null);
  const utils = trpc.useUtils();
  const daDona = trpc.meetings.traduzirResumo.useMutation();
  const doLink = trpc.reuniaoAberta.traduzirResumo.useMutation();
  // Só a resposta do último pedido vale: a de um idioma trocado no meio do
  // caminho, ou de um texto que já mudou, chega e é descartada.
  const ultimoPedido = useRef(0);
  // Os textos do último efeito: só a troca deles apaga a tradução. O mapa que
  // chega pede de novo, e a tradução dos itens segue valendo até a resposta.
  const textosDoUltimoEfeito = useRef<string | null>(null);

  const pedir = () => {
    const numero = ++ultimoPedido.current;
    const chave = chaveDosTextos;
    setErro(null);
    setSemTraducao(null);
    const aoResponder = (resposta: Resposta) => {
      if (numero !== ultimoPedido.current) return;
      if (resposta.estado === "traduzindo") return novaTentativa.agendar();
      novaTentativa.parar();
      if (resposta.estado === "pronta") return setTraducao(resposta);
      // "sem_resumo" ou "original": o resumo na tela é velho. Esperar não o
      // muda (a consulta do link nem relê sozinha): relê agora.
      setTraducao(null);
      setSemTraducao({ chave, estado: resposta.estado });
      if (alvo.token !== undefined) void utils.reuniaoAberta.resumoGuardado.invalidate({ token: alvo.token });
      else void utils.meetings.resumoGuardado.invalidate({ meetingId: alvo.meetingId });
    };
    const aoFalhar = (falha: unknown) => {
      if (numero !== ultimoPedido.current) return;
      novaTentativa.parar();
      setErro(falha);
    };
    if (alvo.token !== undefined) doLink.mutate({ token: alvo.token, idioma }, { onSuccess: aoResponder, onError: aoFalhar });
    else daDona.mutate({ meetingId: alvo.meetingId, idioma }, { onSuccess: aoResponder, onError: aoFalhar });
  };

  useEffect(() => {
    // Outros textos, outro idioma ou outra reunião: a tradução de antes não serve.
    if (textosDoUltimoEfeito.current !== chaveDosTextos) setTraducao(null);
    textosDoUltimoEfeito.current = chaveDosTextos;
    if (!precisa) {
      ultimoPedido.current += 1;
      setErro(null);
      novaTentativa.parar();
      return;
    }
    pedir();
  }, [chaveDosTextos, chaveDoMapa, precisa, novaTentativa.tentativa]);

  const fim = semTraducao?.chave === chaveDosTextos ? semTraducao.estado : null;
  // O erro vem antes da tradução que ficou na tela (o mapa chegou, e o pedido
  // dos rótulos falhou): o aviso do erro diz que o resumo aparece no original,
  // e é o que a tela mostra.
  const valida = precisa && !fim && !erro && traducao?.idioma === idioma ? traducao : null;
  const estado: EstadoDaTraducaoDoResumo = !ativa || fim === "sem_resumo" ? "inativa"
    : !precisa || fim === "original" ? "original"
      : erro ? "erro" : valida ? "pronta" : "traduzindo";

  const aplicar = useCallback(<T extends Resumo>(dados: T | undefined): T | undefined => {
    if (!dados || !resumoNaTela(dados) || !valida) return dados;
    if (!peloLink) {
      const porId = new Map((valida.itens as Array<{ id?: string; subject: string | null; text: string; due: string | null }>).map(item => [item.id, item]));
      return {
        ...dados,
        itens: dados.itens.map(item => {
          const traduzido = "id" in item ? porId.get(item.id) : undefined;
          return traduzido ? { ...item, subject: traduzido.subject, text: traduzido.text, due: traduzido.due } : item;
        }),
      } as T;
    }
    return { ...dados, itens: valida.itens } as T;
  }, [valida, peloLink]);

  const traduzirRotulo = useCallback((rotulo: string) => (
    valida && Object.prototype.hasOwnProperty.call(valida.mapa, rotulo) ? valida.mapa[rotulo] : rotulo
  ), [valida]);

  return {
    idioma,
    idiomaOriginal,
    estado,
    erro,
    escolher: setEscolhido,
    tentarDeNovo: pedir,
    aplicar,
    traduzirRotulo,
  };
}
