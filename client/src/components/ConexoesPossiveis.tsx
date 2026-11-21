import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import type { PerfilParaQualificar } from "@shared/qualificacao-do-perfil";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { QualificacaoDoPerfil } from "@/components/QualificacaoDoPerfil";

/** O que a tela usa de `trpc.matches.conexoesPossiveis.useQuery`. */
export type ConsultaDasConexoesPossiveis = {
  data?: { total: number; listaLiberada: boolean };
  isError: boolean;
  error?: unknown;
  refetch: () => unknown;
};

/**
 * U3, "matches possíveis" (promessa à Dra. Glenda na reunião de 11/11/2026):
 * no lugar da lista de conexões sugeridas, a Bronze vê QUANTAS são possíveis
 * para ela e o que falta no perfil para a lista se liberar (a régua da Prata,
 * `shared/qualificacao-do-perfil.ts`, a mesma do cartão do Perfil).
 *
 * O número vem pronto do servidor (`matches.conexoesPossiveis`), que nem manda
 * a lista à Bronze: esconder aqui não seria a trava, só a explicação dela.
 */
export function ConexoesPossiveis({ consulta, role, perfil, aoBuscar, buscando }: {
  consulta: ConsultaDasConexoesPossiveis;
  role?: string | null;
  perfil: PerfilParaQualificar | null | undefined;
  /** Roda o motor de novo (`matches.regenerate`), como o botão da lista vazia. */
  aoBuscar: () => void;
  buscando: boolean;
}) {
  const { t } = useTranslation();
  const [, navegar] = useLocation();

  // Consulta que falhou não é "nenhuma conexão possível": o número pode existir.
  if (consulta.isError) {
    return <ErroDeConsulta erro={consulta.error} aoTentarDeNovo={() => consulta.refetch()} />;
  }

  const total = consulta.data?.total;
  if (total === undefined) {
    return <div aria-hidden="true" className="h-56 rounded-2xl border border-white/8 bg-[#1b1714] animate-pulse" />;
  }

  return (
    <div className="space-y-4 animate-fade-in-up">
      <section
        aria-labelledby="conexoes-possiveis-titulo"
        className="rounded-2xl border border-white/8 bg-[#1b1714] px-5 py-8 text-center sm:px-8"
      >
        <div className="mb-4 text-5xl" aria-hidden="true">{total > 0 ? "🔒" : "🔍"}</div>
        {/* Tamanho explícito: o h3 sem classe de tamanho herda o tamanho global de h3 (index.css). */}
        <h3 id="conexoes-possiveis-titulo" className="mb-2 text-2xl font-black">
          {t("dashboard.possiveisTitulo", { count: total })}
        </h3>
        <p className="mx-auto max-w-md text-white/60">
          {t(total > 0 ? "dashboard.possiveisTexto" : "dashboard.possiveisTextoNenhuma")}
        </p>
        <p className="mx-auto mt-2 max-w-md text-xs text-white/40">{t("dashboard.possiveisCalculo")}</p>
        <button
          type="button"
          onClick={aoBuscar}
          disabled={buscando}
          className="mt-6 rounded-xl border border-white/15 px-5 py-2.5 text-sm font-medium text-white/70 transition-colors duration-200 hover:border-white/30 hover:text-white disabled:opacity-40"
        >
          {buscando ? t("dashboard.analyzing") : t("dashboard.regenerate")}
        </button>
      </section>

      <QualificacaoDoPerfil role={role} perfil={perfil} onCompletar={() => navegar("/profile")} />
    </div>
  );
}
