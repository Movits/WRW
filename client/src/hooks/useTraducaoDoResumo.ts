import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { useTranslation } from "react-i18next";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "@/lib/trpc";
import { useNovaTentativa } from "@/hooks/useNovaTentativa";
import { IDIOMA_DA_REUNIAO_PADRAO, idiomaDaReuniao, type IdiomaDaReuniao } from "@shared/idioma-da-reuniao";

/**
 * A tradução do resumo guardado (H11) para quem lê: começa no idioma da tela,
 * e quem lê pode escolher outro, ou o original. O resumo é escrito no idioma da
 * reunião; quando quem lê está em outro, a tela pede a tradução ao servidor,
 * que a faz em segundo plano e responde "traduzindo" até ela ficar pronta, e a
 * tela pergunta de novo a cada 5 s (como a tradução da transcrição, G8).
 *
 * Mora na página, e não no resumo, porque o mapa mental (H10) usa a mesma
 * tradução: `traduzirRotulo` dá cada rótulo dele no idioma escolhido.
 *
 * - Para a dona, os textos traduzidos vêm pelo id do item e entram sobre o
 *   resumo que ela já lê: o estado de cada item continua vindo do resumo, e
 *   decidir não pede outra tradução.
 * - Pelo link, o servidor devolve o resumo inteiro, já traduzido, sem ids.
 * - O texto do resumo que muda (item editado, resumo refeito) pede de novo: o
 *   servidor traduz só o que mudou. Até a resposta, a tela mostra o original.
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

export function useTraducaoDoResumo(alvo: Alvo, resumo: Resumo | undefined): TraducaoDoResumoNaTela {
  const { i18n } = useTranslation();
  const peloLink = alvo.token !== undefined;
  const chaveDoAlvo = peloLink ? `t:${alvo.token}` : `m:${alvo.meetingId}`;
  // O idioma RESOLVIDO da tela: o pedido pode ser regional ("en-US").
  const idiomaDaTela = idiomaDaReuniao(i18n.resolvedLanguage ?? i18n.language) ?? IDIOMA_DA_REUNIAO_PADRAO;
  // null: acompanha o idioma da tela.
  const [escolhido, setEscolhido] = useState<IdiomaDaReuniao | null>(null);
  const idioma = escolhido ?? idiomaDaTela;

  const pronto = resumo?.estado === "pronto" ? resumo : null;
  // Como o servidor: o resumo sem idioma gravado conta como o padrão.
  const idiomaOriginal = pronto ? idiomaDaReuniao(pronto.idioma) ?? IDIOMA_DA_REUNIAO_PADRAO : null;
  const ativa = !!pronto && pronto.itens.length > 0;
  const precisa = ativa && idioma !== idiomaOriginal;
  // Os textos do resumo: mudou um, a tradução guardada não serve mais. Pelo
  // link, que recebe o resumo inteiro traduzido, o estado também conta.
  const itens = pronto?.itens;
  const assinatura = useMemo(() => (itens ?? []).map(item => [
    "id" in item ? item.id : "", item.subject ?? "", item.text, item.due ?? "", peloLink ? item.status : "",
  ].join("\u0001")).join("\u0002"), [itens, peloLink]);

  const novaTentativa = useNovaTentativa(`${chaveDoAlvo}|${idioma}|${assinatura}`);
  const [traducao, setTraducao] = useState<Pronta | null>(null);
  const [erro, setErro] = useState<unknown>(null);
  const daDona = trpc.meetings.traduzirResumo.useMutation();
  const doLink = trpc.reuniaoAberta.traduzirResumo.useMutation();
  // Só a resposta do último pedido vale: a de um idioma trocado no meio do
  // caminho, ou de um texto que já mudou, chega e é descartada.
  const ultimoPedido = useRef(0);

  const pedir = () => {
    const numero = ++ultimoPedido.current;
    setErro(null);
    const aoResponder = (resposta: Resposta) => {
      if (numero !== ultimoPedido.current) return;
      if (resposta.estado === "traduzindo") return novaTentativa.agendar();
      novaTentativa.parar();
      setTraducao(resposta.estado === "pronta" ? resposta : null);
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
    setTraducao(null);
    if (!precisa) {
      ultimoPedido.current += 1;
      setErro(null);
      novaTentativa.parar();
      return;
    }
    pedir();
  }, [chaveDoAlvo, idioma, assinatura, precisa, novaTentativa.tentativa]);

  const valida = precisa && traducao?.idioma === idioma ? traducao : null;
  const estado: EstadoDaTraducaoDoResumo = !ativa ? "inativa" : !precisa ? "original" : valida ? "pronta" : erro ? "erro" : "traduzindo";

  const aplicar = useCallback(<T extends Resumo>(dados: T | undefined): T | undefined => {
    if (!dados || dados.estado !== "pronto" || !valida) return dados;
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
