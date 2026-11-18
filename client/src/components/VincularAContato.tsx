import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link2, Loader2, Search } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";

/**
 * "Vincular a um contato" (N5): a pessoa da reunião já está na rede da dona —
 * numa segunda reunião com ela, criar de novo duplicava o contato, e ignorar
 * perdia o que ela disse. A tela sugere o contato de mesmo e-mail, telefone ou
 * nome (meetings.candidatosParaVincular) e deixa procurar na rede inteira
 * (network.list). Vincular leva as pendências ao contato escolhido; o que ele
 * já tem é ignorado no servidor.
 */
export function VincularAContato({ suggestionId, ocupado, aoEscolher, aoCancelar }: {
  suggestionId: string;
  ocupado: boolean;
  aoEscolher: (contactId: number) => void;
  aoCancelar: () => void;
}) {
  const { t } = useTranslation();
  const [busca, setBusca] = useState("");
  const termo = busca.trim();
  const candidatos = trpc.meetings.candidatosParaVincular.useQuery({ suggestionId }, { refetchOnWindowFocus: false });
  const procura = trpc.network.list.useQuery({ q: termo, limit: 8, page: 1 }, { enabled: termo.length >= 2, refetchOnWindowFocus: false });
  const motivo = (chave: "email" | "telefone" | "nome") =>
    chave === "email" ? t("reuniaoNoMatch.motivoEmail") : chave === "telefone" ? t("reuniaoNoMatch.motivoTelefone") : t("reuniaoNoMatch.motivoNome");
  const botao = (id: number, nome: string, detalhe: string | null) => (
    <li key={id}>
      <button type="button" disabled={ocupado} onClick={() => aoEscolher(id)}
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-2 text-start text-sm text-white/85 hover:bg-white/5 disabled:opacity-50">
        <span className="min-w-0"><span dir="auto" className="font-semibold">{nome}</span>{detalhe && <span className="text-white/45"> · {detalhe}</span>}</span>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-bold text-[#efcba8]"><Link2 size={13} aria-hidden="true" />{t("reuniaoNoMatch.vincularBotao")}</span>
      </button>
    </li>
  );

  return (
    <div role="group" aria-label={t("reuniaoNoMatch.vincularTitulo")} className="mt-3 rounded-xl border border-[#c98f70]/30 bg-[#c98f70]/[0.06] p-3">
      <p className="text-sm font-semibold text-white">{t("reuniaoNoMatch.vincularTitulo")}</p>
      {candidatos.isError ? (
        <div className="mt-2"><ErroDeConsulta erro={candidatos.error} aoTentarDeNovo={() => void candidatos.refetch()} /></div>
      ) : candidatos.data && candidatos.data.length > 0 ? (
        <>
          <p className="mt-2 text-xs text-white/55">{t("reuniaoNoMatch.vincularSugeridos")}</p>
          <ul className="mt-1.5 space-y-1.5">{candidatos.data.map(candidato => botao(candidato.id, candidato.nome, motivo(candidato.motivo)))}</ul>
        </>
      ) : null}
      <label className="mt-3 block text-xs text-white/55">
        {t("reuniaoNoMatch.vincularProcurar")}
        <span className="mt-1 flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-2">
          <Search size={14} aria-hidden="true" className="shrink-0 text-white/40" />
          <input value={busca} onChange={evento => setBusca(evento.target.value)} placeholder={t("reuniaoNoMatch.vincularProcurarPlaceholder")} maxLength={100}
            className="w-full bg-transparent py-1.5 text-sm text-white outline-none placeholder:text-white/30" />
        </span>
      </label>
      {termo.length >= 2 && (procura.isError ? (
        <div className="mt-2"><ErroDeConsulta erro={procura.error} aoTentarDeNovo={() => void procura.refetch()} /></div>
      ) : !procura.data ? (
        <p role="status" className="mt-2 text-xs text-white/45"><Loader2 size={13} className="me-1.5 inline animate-spin" aria-hidden="true" />{t("networkPanel.loading")}</p>
      ) : procura.data.data.length === 0 ? (
        <p className="mt-2 text-xs text-white/45">{t("reuniaoNoMatch.vincularNenhum")}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">{procura.data.data.map(contato => botao(Number(contato.id), contato.fullName, contato.company ?? null))}</ul>
      ))}
      <button type="button" onClick={aoCancelar} className="mt-3 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/65 hover:bg-white/5">
        {t("reuniaoNoMatch.cancelar")}
      </button>
    </div>
  );
}
