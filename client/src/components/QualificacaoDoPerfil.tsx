import { useTranslation } from "react-i18next";
import { CheckCircle, Circle } from "lucide-react";
import {
  avaliarQualificacaoDoPerfil,
  type PendenciaDoPerfil,
  type PerfilParaQualificar,
} from "@shared/qualificacao-do-perfil";

/**
 * Governança (14/09/2026): o cadastro nasce Bronze, "perfil em qualificação",
 * e passa a Prata sozinho quando o perfil atende à régua de
 * shared/qualificacao-do-perfil.ts — a mesma que o servidor aplica ao salvar.
 * Este cartão diz à membra Bronze o que falta, item a item, em vez de deixar o
 * nível como um rótulo sem caminho. Para Prata, Ouro e staff não aparece: nada
 * a completar, e Ouro não é degrau desta régua.
 */
export function QualificacaoDoPerfil({ role, perfil, onCompletar }: {
  role?: string | null;
  perfil: PerfilParaQualificar | null | undefined;
  /** Abre a edição do perfil. Ausente (já editando) = sem botão. */
  onCompletar?: () => void;
}) {
  const { t } = useTranslation();
  if (role !== "bronze") return null;

  const { qualificado, pendencias, detalhes } = avaliarQualificacaoDoPerfil(perfil);
  const { apresentacao } = detalhes;

  // Quatro textos, e a ordem importa: a recusa pode ter DOIS motivos ao mesmo
  // tempo (faltam palavras diferentes E o texto se repete), e quem só ouve o
  // primeiro completa as palavras e leva uma segunda recusa sem aviso. O texto
  // geral fica só para o campo vazio — com texto escrito ele esconde a
  // contagem, que é justamente o que explica a recusa (validação de 16/09 na
  // #135, item 8).
  const textoDaPendencia = (pendencia: PendenciaDoPerfil) => {
    if (pendencia !== "apresentacao") return t(`governanca.pendencias.${pendencia}`, { minimo: apresentacao.minimo });
    if (apresentacao.vazia) return t("governanca.pendencias.apresentacao", { minimo: apresentacao.minimo });
    const faltamPalavras = apresentacao.contadas < apresentacao.minimo;
    if (faltamPalavras && apresentacao.repetida) return t("governanca.pendencias.apresentacaoContagemERepeticao", apresentacao);
    if (faltamPalavras) return t("governanca.pendencias.apresentacaoContagem", apresentacao);
    if (apresentacao.repetida) return t("governanca.pendencias.apresentacaoRepeticao", apresentacao);
    return t("governanca.pendencias.apresentacao", { minimo: apresentacao.minimo });
  };

  return (
    <section
      aria-labelledby="qualificacao-do-perfil-titulo"
      className="rounded-2xl border border-[#c98f70]/30 bg-[#c98f70]/[0.06] p-5"
    >
      <div className="flex items-start gap-3">
        <span className="text-2xl leading-none" aria-hidden="true">🥉</span>
        <div className="min-w-0 flex-1">
          {/* Tamanho explícito, como os títulos de seção do Perfil: o h2 sem
              classe de tamanho herda o tamanho global de h2 (index.css) e
              engolia o cartão, no Perfil e no Painel da Bronze (U3). */}
          <h2 id="qualificacao-do-perfil-titulo" className="text-base font-bold leading-tight text-white">
            {t("governanca.perfil.titulo")}
          </h2>
          {qualificado ? (
            <p className="mt-1 flex items-start gap-2 text-sm text-white/70">
              <CheckCircle size={15} className="mt-0.5 shrink-0 text-emerald-400" aria-hidden="true" />
              {t("governanca.perfil.prontoParaPrata")}
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-white/60">{t("governanca.perfil.texto")}</p>
              <ul className="mt-3 space-y-1.5">
                {pendencias.map(pendencia => (
                  <li key={pendencia} className="flex items-start gap-2 text-sm text-white/75">
                    <Circle size={13} className="mt-1 shrink-0 text-[#c98f70]" aria-hidden="true" />
                    {textoDaPendencia(pendencia)}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="mt-3 text-xs text-white/40">{t("governanca.perfil.semMensalidade")}</p>
          {onCompletar && (
            <button
              type="button"
              onClick={onCompletar}
              className="mt-3 rounded-lg border border-[#c98f70]/40 px-3.5 py-1.5 text-sm font-semibold text-[#c98f70] transition-colors hover:bg-[#c98f70]/10"
            >
              {t("governanca.perfil.completar")}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
