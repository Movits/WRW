import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { CircleAlert } from "lucide-react";

/**
 * A pessoa que a IA encontrou numa reunião, nas três dimensões do Meu Network
 * Inteligente (spec da Glenda de 14/09, itens 5 a 10), para a dona revisar
 * ANTES de criar o contato:
 *
 * - QUEM SOU: nome, telefone e e-mail — o que a transcrição não sustentou
 *   aparece como FALTANDO (o servidor já apagou o que não estava na fala);
 * - O QUE TENHO e O QUE PRECISO sugeridos, cada item com o trecho da conversa;
 * - o alerta de informação faltando.
 *
 * Criar o contato confirma só o Quem Sou mostrado aqui; Tenho e Preciso seguem
 * como sugestões no perfil do contato, esperando a confirmação dela.
 *
 * `pendencias` undefined = ainda não lidas (carregando, ou a consulta falhou e
 * a tela mostra o erro): Tenho e Preciso ficam neutros. Dizer FALTANDO sem ter
 * lido seria afirmar que a IA não achou nada.
 */

type Sugestao = {
  id: string; fullName: string; jobTitle: string | null; company: string | null; phone: string | null; email: string | null;
  status: string; existingContactId: number | null;
};
type Pendencia = { id: string; meetingSuggestionId: string | null; campo: string; valor: string; trecho: string | null };

export function PessoaSugeridaNaReuniao({ sugestao, pendencias }: { sugestao: Sugestao; pendencias: Pendencia[] | undefined }) {
  const { t } = useTranslation();
  const lidas = pendencias !== undefined;
  const daPessoa = (pendencias ?? []).filter(p => p.meetingSuggestionId === sugestao.id);
  const tenho = daPessoa.filter(p => p.campo === "tenho");
  const preciso = daPessoa.filter(p => p.campo === "preciso");
  const falta = !sugestao.phone || !sugestao.email || (sugestao.status === "pending" && lidas && (!tenho.length || !preciso.length));
  const faltando = <span className="font-semibold text-amber-300">{t("networkPanel.statusMissing")}</span>;

  return (
    <div className="min-w-0 flex-1">
      <h2 className="text-base font-semibold">{sugestao.fullName}</h2>
      {(sugestao.jobTitle || sugestao.company) && <p className="text-sm text-white/55">{[sugestao.jobTitle, sugestao.company].filter(Boolean).join(" · ")}</p>}

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="sm:col-span-2 text-[11px] font-bold uppercase tracking-wider text-white/45">{t("networkPanel.whoAmI")}</div>
        <div className="flex gap-2"><dt className="text-white/50">{t("networkPanel.fields.nome")}:</dt><dd className="text-emerald-300" aria-label={sugestao.fullName}>✓</dd></div>
        <div className="flex gap-2"><dt className="text-white/50">{t("networkPanel.fields.telefone")}:</dt><dd className="text-white/85">{sugestao.phone ?? faltando}</dd></div>
        <div className="flex gap-2"><dt className="text-white/50">{t("networkPanel.fields.email")}:</dt><dd className="break-all text-white/85">{sugestao.email ?? faltando}</dd></div>
      </dl>

      {sugestao.status === "pending" && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {([[t("networkPanel.fields.tenho"), tenho], [t("networkPanel.fields.preciso"), preciso]] as const).map(([rotulo, itens]) => (
            <div key={rotulo}>
              <p className="text-[11px] font-bold uppercase tracking-wider text-white/45">{rotulo}</p>
              {itens.length ? (
                <ul className="mt-1 space-y-1">
                  {itens.map(item => (
                    <li key={item.id} className="text-sm text-white/85" title={item.trecho ?? undefined}>{item.valor}</li>
                  ))}
                </ul>
              ) : lidas ? <p className="mt-1 text-sm">{faltando}</p> : <p className="mt-1 text-sm text-white/35">—</p>}
            </div>
          ))}
        </div>
      )}

      {falta && sugestao.status === "pending" && (
        <p role="note" className="mt-3 flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-3 text-xs leading-relaxed text-amber-100">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
          {t("networkPanel.alert")}
        </p>
      )}
      {sugestao.status === "pending" && (tenho.length > 0 || preciso.length > 0) && (
        <p className="mt-2 text-xs text-white/45">{t("networkInteligente.meetingProposal.pendingAfterCreate")}</p>
      )}
      {(sugestao.status === "created" || sugestao.status === "linked") && sugestao.existingContactId !== null && (
        <Link href={`/meu-network-inteligente/contatos/${sugestao.existingContactId}`}
          className="mt-2 inline-block text-sm font-semibold text-[#c98f70] underline-offset-2 hover:underline">
          {t("networkInteligente.meetingProposal.review")}
        </Link>
      )}
    </div>
  );
}
