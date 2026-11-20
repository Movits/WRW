import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { Mic } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { LinhaDoItemDaReuniao } from "@/components/ItemDaReuniao";
import { rotaDaReuniao } from "@shared/rotas";

/**
 * "Sugestões das suas reuniões" no Meu Perfil (N5): o que a dona disse numa
 * reunião que TEM ou PRECISA, depois de responder "Sou eu" na pessoa da
 * reunião, esperando a confirmação dela item a item, com o trecho e a reunião
 * de onde veio. Confirmado, o "tenho" entra em "O que tenho" e o "preciso"
 * vira demanda de "O que preciso". Sem nada esperando, o bloco não aparece.
 */
export function SugestoesDasReunioes() {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  const consulta = trpc.networkInteligente.pendenciasDoPerfil.useQuery(undefined, { refetchOnWindowFocus: false });
  const aoDecidir = () => {
    void consulta.refetch();
    void utils.profile.get.invalidate();
  };
  // Erro de consulta é erro, nunca "nada esperando" (regra do banco fora do ar).
  if (consulta.isError) return <ErroDeConsulta erro={consulta.error} aoTentarDeNovo={() => void consulta.refetch()} />;
  const itens = consulta.data ?? [];
  if (!itens.length) return null;
  return (
    <section aria-labelledby="sugestoes-das-reunioes" className="rounded-2xl border border-amber-300/25 bg-amber-300/[0.05] p-5">
      <h2 id="sugestoes-das-reunioes" className="flex items-center gap-2 text-base font-bold text-white"><Mic size={16} aria-hidden="true" className="text-amber-300" />{t("reuniaoNoMatch.perfilTitulo")}</h2>
      <p className="mt-1 text-xs leading-relaxed text-white/55">{t("reuniaoNoMatch.perfilSubtitulo")}</p>
      <p className="mt-1 text-xs leading-relaxed text-amber-100/80">{t("reuniaoNoMatch.avisoPerfil")}</p>
      <ul className="mt-3 space-y-2">
        {itens.map(item => (
          <LinhaDoItemDaReuniao key={item.id} item={item} alvo="perfil" aoDecidir={aoDecidir} cabecalho={item.reuniao && (
            <Link href={rotaDaReuniao(item.reuniao.id)} className="mb-1.5 inline-block text-xs text-white/50 underline-offset-4 hover:text-white hover:underline">
              {t("reuniaoNoMatch.perfilDaReuniao", { titulo: item.reuniao.titulo, data: new Date(item.reuniao.em).toLocaleDateString(i18n.language) })}
            </Link>
          )} />
        ))}
      </ul>
    </section>
  );
}
