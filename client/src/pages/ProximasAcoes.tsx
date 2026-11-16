import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearch } from "wouter";
import { toast } from "sonner";
import { ListChecks, Loader2, Plus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { pedidoDaTela, useAvisosDaAgenda } from "@/components/AcaoNaAgenda";
import { FormularioDaAcao, mensagemDoErroDaAcao, ProximasAcoes } from "@/components/ProximasAcoes";
import { PARAMETRO_DA_ACAO } from "@shared/lembretes";

/**
 * A página /proximas-acoes (H5a do desenho do gravador): o que a dona confirmou
 * como ação ou tarefa nos resumos das reuniões e o que anotou aqui, as abertas
 * primeiro e por prazo. O menu global vem da rota (App.tsx); a lista é o
 * componente ProximasAcoes, o mesmo do cartão do Dashboard.
 *
 * O lembrete no sino (H15) abre esta página com ?acao=<id>: a lista rola até a
 * ação e a destaca. Se ela não está entre as abertas (foi feita depois do
 * aviso), a lista passa a mostrar todas, uma vez por link.
 *
 * A ação anotada com prazo vai para a Google Agenda conectada (H5c); a falha da
 * Google vem num aviso à parte (useAvisosDaAgenda), e a ação fica salva.
 */

type Filtro = "abertas" | "todas";
const VAZIO = { texto: "", detalhe: "", responsavel: "", prazo: "" };

export default function PaginaDasProximasAcoes() {
  const { t } = useTranslation();
  const [filtro, setFiltro] = useState<Filtro>("abertas");
  const [anotando, setAnotando] = useState(false);
  const consulta = trpc.proximasAcoes.listar.useQuery({ filtro });
  // Lido pelo useSearch: o aviso tocado com a página já aberta troca só a busca.
  const busca = useSearch();
  const acaoPedida = useMemo(() => new URLSearchParams(busca).get(PARAMETRO_DA_ACAO) || null, [busca]);
  const jaProcurouEmTodas = useRef<string | null>(null);
  const utils = trpc.useUtils();
  const avisos = useAvisosDaAgenda();
  const criar = trpc.proximasAcoes.criar.useMutation({
    onSuccess: resultado => avisos.depoisDeMandar(resultado),
    onError: erro => toast.error(mensagemDoErroDaAcao(t, erro)),
    onSettled: () => utils.proximasAcoes.invalidate(),
  });
  const dados = consulta.data;
  useEffect(() => {
    if (!acaoPedida || filtro !== "abertas" || !dados || jaProcurouEmTodas.current === acaoPedida) return;
    if (dados.acoes.some(acao => acao.id === acaoPedida)) return;
    jaProcurouEmTodas.current = acaoPedida;
    setFiltro("todas");
  }, [acaoPedida, filtro, dados]);

  const botaoDoFiltro = (valor: Filtro, rotulo: string) => <button type="button" aria-pressed={filtro === valor} onClick={() => setFiltro(valor)}
    className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${filtro === valor ? "bg-[#c98f70] text-[#1a120c]" : "border border-white/15 text-white/65 hover:bg-white/5"}`}>
    {rotulo}
  </button>;

  let lista;
  if (consulta.isError) {
    // Erro de consulta é erro, nunca "nenhuma ação".
    lista = <ErroDeConsulta erro={consulta.error} aoTentarDeNovo={() => void consulta.refetch()}/>;
  } else if (!dados) {
    lista = <p role="status" className="text-sm text-white/50"><Loader2 size={15} className="mr-2 inline animate-spin"/>{t("proximasAcoes.loading")}</p>;
  } else if (!dados.acoes.length) {
    lista = <p className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm text-white/55">
      {filtro === "abertas" ? t("proximasAcoes.emptyOpen") : t("proximasAcoes.emptyAll")}
    </p>;
  } else {
    lista = <>
      <ProximasAcoes acoes={dados.acoes} destacada={acaoPedida}/>
      {dados.acoes.length >= dados.limite && <p className="mt-3 text-xs text-white/45">{t("proximasAcoes.limitNotice", { n: dados.limite })}</p>}
    </>;
  }

  return <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
    <h1 className="inline-flex items-center gap-2 text-2xl font-black text-white">
      <ListChecks size={22} className="text-[#c98f70]" aria-hidden/> {t("proximasAcoes.title")}
    </h1>
    <p className="mt-2 text-sm text-white/55">{t("proximasAcoes.intro")}</p>
    <p className="mt-1 text-xs text-white/40">{t("proximasAcoes.agenda.pageHint")}</p>

    <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {botaoDoFiltro("abertas", t("proximasAcoes.filterOpen"))}
        {botaoDoFiltro("todas", t("proximasAcoes.filterAll"))}
        {dados && <span className="text-xs text-white/45">{t("proximasAcoes.openCount", { n: dados.abertas })}</span>}
      </div>
      {!anotando && <button type="button" onClick={() => setAnotando(true)}
        className="inline-flex items-center gap-2 rounded-xl bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8]">
        <Plus size={16} aria-hidden/> {t("proximasAcoes.add")}
      </button>}
    </div>

    {anotando && <div className="mt-4 rounded-2xl border border-amber-300/25 bg-amber-300/[0.04] p-4">
      <FormularioDaAcao inicial={VAZIO} salvando={criar.isPending} aoCancelar={() => setAnotando(false)}
        aoSalvar={valores => criar.mutate({
          texto: valores.texto, detalhe: valores.detalhe, responsavel: valores.responsavel, prazo: valores.prazo,
          // O lembrete do prazo sai às 9h no relógio deste aparelho (H15), e o
          // evento da ação na Google Agenda fica nessa hora, com o texto no idioma da tela (H5c).
          ...pedidoDaTela(t),
        }, { onSuccess: () => setAnotando(false) })}/>
    </div>}

    <div className="mt-6">{lista}</div>
  </main>;
}
