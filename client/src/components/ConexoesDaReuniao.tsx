import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";

/**
 * As conexões que nasceram de uma reunião (N5), só para a dona:
 *
 * - a linha do resumo, "Conexões geradas por esta reunião: N", quando o que
 *   ela confirmou de alguma pessoa sustenta conexões privadas;
 * - o ramo "Conexões desta reunião" do mapa mental: cada folha é uma pessoa,
 *   com o que tem e precisa (o pendente marcado "a confirmar") e as conexões
 *   que nasceram dela. O ramo é montado aqui, com os itens da extração: não vai
 *   à IA, não é traduzido e não aparece no link aberto (a página do link não
 *   chama meetings.conexoes).
 */

type ConexoesDaReuniao = inferRouterOutputs<AppRouter>["meetings"]["conexoes"];
type Traduzir = (chave: string, opcoes?: Record<string, unknown>) => string;

export type RamoDasConexoes = { rotulo: string; folhas: Array<{ rotulo: string; filhos: string[] }> };

/** Tetos de leitura do ramo, como os do mapa (shared/mapa-mental.ts): uma reunião cheia não vira uma parede. */
const PESSOAS_NO_RAMO = 12;
const FILHOS_POR_PESSOA = 8;

export function ramoDasConexoes(dados: ConexoesDaReuniao | undefined, t: Traduzir): RamoDasConexoes | null {
  if (!dados) return null;
  const folhas = dados.pessoas
    .filter(pessoa => pessoa.status !== "ignored")
    .map(pessoa => ({
      rotulo: pessoa.nome,
      filhos: [
        ...pessoa.tenho.map(item => item.confirmado ? t("reuniaoNoMatch.mapaTem", { valor: item.valor }) : t("reuniaoNoMatch.mapaTemPendente", { valor: item.valor })),
        ...pessoa.preciso.map(item => item.confirmado ? t("reuniaoNoMatch.mapaPrecisa", { valor: item.valor }) : t("reuniaoNoMatch.mapaPrecisaPendente", { valor: item.valor })),
        ...pessoa.conexoes.map(conexao => conexao.com ? t("reuniaoNoMatch.mapaConexaoCom", { nome: conexao.com }) : t("reuniaoNoMatch.mapaConexaoSemNome")),
      ].slice(0, FILHOS_POR_PESSOA),
    }))
    .filter(folha => folha.filhos.length > 0)
    .slice(0, PESSOAS_NO_RAMO);
  return folhas.length ? { rotulo: t("reuniaoNoMatch.ramoDoMapa"), folhas } : null;
}

/** A consulta das conexões da reunião, para o mapa da dona. */
export function useConexoesDaReuniao(meetingId: string) {
  return trpc.meetings.conexoes.useQuery({ meetingId }, { refetchOnWindowFocus: false });
}

export function ConexoesGeradasPelaReuniao({ meetingId }: { meetingId: string }) {
  const { t } = useTranslation();
  const consulta = useConexoesDaReuniao(meetingId);
  // Erro de consulta é erro, nunca "nenhuma conexão" (regra do banco fora do ar).
  if (consulta.isError) return <ErroDeConsulta erro={consulta.error} aoTentarDeNovo={() => void consulta.refetch()} />;
  const total = consulta.data?.totalDeConexoes ?? 0;
  if (!total) return null;
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.07] px-4 py-3 text-sm text-emerald-100">
      <Sparkles size={15} aria-hidden="true" className="shrink-0 text-emerald-300" />
      <span>{t("reuniaoNoMatch.conexoesGeradas", { quantidade: total })}</span>
      <Link href="/intelligent-matches" className="font-semibold text-emerald-200 underline-offset-4 hover:underline">{t("reuniaoNoMatch.verConexoes")}</Link>
    </p>
  );
}
