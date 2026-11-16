import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Loader2, Mail, PenLine } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { LANGUAGES } from "@/i18n";
import { AvisoDeConferir, mensagemDoErroDaIA } from "@/components/ReuniaoComIA";
import { linkDoEmail } from "@/components/CompartilharReuniao";
import { traduzirMensagemDoServidor } from "@/lib/mensagem-de-erro";
import { IDIOMA_DA_REUNIAO_PADRAO, idiomaDaReuniao, type IdiomaDaReuniao } from "@shared/idioma-da-reuniao";
import {
  MENSAGEM_EMAIL_SEM_ITEM_CONFIRMADO,
  MENSAGEM_EMAIL_SEM_RESUMO_PRONTO,
  NOME_DO_DESTINATARIO_MAX,
  preencherRascunho,
  RELACOES_DO_EMAIL,
  TONS_DO_EMAIL,
  vozDoDestinatario,
  vozesSemNome,
  type RelacaoDoEmail,
  type TomDoEmail,
} from "@shared/email-de-retorno";

/**
 * O rascunho de e-mail de retorno (H20), no detalhe da reunião, abaixo do
 * resumo guardado: a dona diz para quem é, a relação, o tom e o idioma, e a IA
 * escreve o assunto e o texto a partir dos itens que ela confirmou no resumo.
 * Ela revisa e ajusta na prévia, abre no app de e-mail dela (mailto, sem
 * destinatário: ela escolhe) ou copia, e pode refazer. A WRW não envia nada, e
 * o rascunho não fica guardado no servidor.
 *
 * O nome de quem recebe não sai do navegador: a IA escreve a marca
 * {DESTINATARIO}, que a tela troca pelo nome digitado. Os rótulos de voz ({F2})
 * viram os nomes que a dona deu, como no resumo (shared/email-de-retorno.ts).
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export type EstadoDoEmailDeRetorno = {
  destinatario: string;
  relacao: RelacaoDoEmail;
  tom: TomDoEmail;
  idioma: IdiomaDaReuniao;
  rascunho: { assunto: string; corpo: string; semNome: number[] } | null;
};

/**
 * Acima disto o link mailto: corre o risco de chegar cortado ao app de e-mail
 * (o Windows repassa cerca de 2 mil caracteres). Letra de escrita não latina
 * ocupa até 9 caracteres no link.
 */
export const LIMITE_DO_LINK_DE_EMAIL = 1_900;

/**
 * O link que abre o rascunho no app de e-mail da dona. As quebras de linha vão
 * como CRLF, como o mailto pede. Texto longo demais vai sem o corpo
 * (completo = false): a tela o copia para ela colar.
 */
export function linkDoRascunho(assunto: string, corpo: string): { href: string; completo: boolean } {
  const completo = linkDoEmail(assunto, corpo.replace(/\r?\n/g, "\r\n"));
  if (completo.length <= LIMITE_DO_LINK_DE_EMAIL) return { href: completo, completo: true };
  return { href: `mailto:?subject=${encodeURIComponent(assunto)}`, completo: false };
}

// Cada ramo chama t() com a chave literal, para o teste das chaves usadas
// (server/i18n-chaves-usadas.test.ts) conferir que todas existem.
function rotuloDaRelacao(t: TranslateFn, relacao: RelacaoDoEmail) {
  switch (relacao) {
    case "team": return t("meetings.followUp.relationshipTeam");
    case "external": return t("meetings.followUp.relationshipExternal");
    case "leadership": return t("meetings.followUp.relationshipLeadership");
    case "network": return t("meetings.followUp.relationshipNetwork");
  }
}

function rotuloDoTom(t: TranslateFn, tom: TomDoEmail) {
  switch (tom) {
    case "professional": return t("meetings.followUp.toneProfessional");
    case "friendly": return t("meetings.followUp.toneFriendly");
    case "direct": return t("meetings.followUp.toneDirect");
    case "urgent": return t("meetings.followUp.toneUrgent");
  }
}

// As duas recusas próprias do rascunho vêm com frase do servidor, que a tabela
// de lib/mensagem-de-erro.ts traduz; as outras, pelo código, como no Pergunte.
const RECUSAS_DO_RASCUNHO = new Set([MENSAGEM_EMAIL_SEM_RESUMO_PRONTO, MENSAGEM_EMAIL_SEM_ITEM_CONFIRMADO]);
function mensagemDoErro(t: TranslateFn, erro: unknown) {
  const mensagem = (erro as { message?: unknown } | null)?.message;
  if (typeof mensagem === "string" && RECUSAS_DO_RASCUNHO.has(mensagem)) return traduzirMensagemDoServidor(mensagem, t);
  return mensagemDoErroDaIA(t, erro, t("meetings.followUp.error"), false);
}

const CAMPO = "rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-amber-300";
const LISTA = "rounded-lg border border-white/15 bg-[#211e1b] px-3 py-2 text-sm text-white outline-none focus:border-amber-300";
const OPCAO = "bg-white text-[#322C26]";
const ROTULO = "flex flex-col gap-1 text-sm text-white/75";

export function EmailDeRetorno({ meetingId, confirmados, idiomaDoResumo, nomes, registro }: {
  meetingId: string;
  /** Quantos itens do resumo a dona confirmou: sem nenhum, não há o que escrever. */
  confirmados: number;
  /** O idioma do resumo (o da reunião), o padrão do e-mail. */
  idiomaDoResumo: string | null;
  /** Os nomes que a dona deu às vozes (nomesDosFalantes(meeting.speakerNames)). */
  nomes: Readonly<Record<string, string>>;
  /** Guardado pela página: trocar de aba e voltar não perde o rascunho. */
  registro?: { current: EstadoDoEmailDeRetorno | null };
}) {
  const { t, i18n } = useTranslation();
  const [estado, setEstado] = useState<EstadoDoEmailDeRetorno>(() => registro?.current ?? {
    destinatario: "",
    relacao: "external",
    tom: "professional",
    idioma: idiomaDaReuniao(idiomaDoResumo) ?? idiomaDaReuniao(i18n.resolvedLanguage ?? i18n.language) ?? IDIOMA_DA_REUNIAO_PADRAO,
    rascunho: null,
  });
  useEffect(() => {
    if (registro) registro.current = estado;
  }, [estado]);
  const mudar = (parcial: Partial<EstadoDoEmailDeRetorno>) => setEstado(anterior => ({ ...anterior, ...parcial }));

  // O nome digitado quando o pedido saiu: a resposta o põe no lugar da marca.
  const nomeDoPedido = useRef("");
  const campoDoTexto = useRef<HTMLTextAreaElement>(null);
  const rascunhar = trpc.meetings.rascunharEmailDeRetorno.useMutation({
    onSuccess: dados => {
      const rotulo = (n: number) => t("meetings.speakerLabel", { n });
      const rascunho = {
        assunto: preencherRascunho(dados.assunto, nomeDoPedido.current, nomes, rotulo),
        corpo: preencherRascunho(dados.corpo, nomeDoPedido.current, nomes, rotulo),
        semNome: vozesSemNome(`${dados.assunto}\n${dados.corpo}`, nomes),
      };
      // Também na página: a resposta que chega com a aba Resumo fechada fica para a volta.
      if (registro?.current) registro.current = { ...registro.current, rascunho };
      setEstado(anterior => ({ ...anterior, rascunho }));
    },
  });

  const nome = estado.destinatario.trim();
  const podeEscrever = confirmados > 0 && !!nome && !rascunhar.isPending;
  function escrever(evento: FormEvent) {
    evento.preventDefault();
    if (!podeEscrever) return;
    nomeDoPedido.current = nome;
    const voz = vozDoDestinatario(nome, nomes);
    rascunhar.mutate({ meetingId, relacao: estado.relacao, tom: estado.tom, idioma: estado.idioma, ...(voz ? { vozDoDestinatario: voz } : {}) });
  }

  const rascunho = estado.rascunho;
  const mudarRascunho = (parcial: { assunto?: string; corpo?: string }) =>
    setEstado(anterior => (anterior.rascunho ? { ...anterior, rascunho: { ...anterior.rascunho, ...parcial } } : anterior));
  const link = rascunho ? linkDoRascunho(rascunho.assunto, rascunho.corpo) : null;

  async function copiar(paraOEmail: boolean) {
    if (!rascunho) return;
    try {
      await navigator.clipboard.writeText(rascunho.corpo);
      toast.success(paraOEmail ? t("meetings.followUp.copiedForEmail") : t("meetings.followUp.copied"));
    } catch {
      // Sem permissão (ou fora de HTTPS) a área de transferência recusa: o
      // texto fica selecionado no campo para a dona copiar à mão.
      campoDoTexto.current?.select();
      toast.message(t("meetings.followUp.copyFallback"));
    }
  }

  const idDaLista = useId();
  const idDaDica = useId();
  // As vozes com nome viram sugestões no "Para quem?".
  const nomesDasVozes = Array.from(new Set(Object.values(nomes).map(dado => dado.trim()).filter(Boolean)));
  const idiomaOriginal = idiomaDaReuniao(idiomaDoResumo);

  return <section aria-labelledby="email-de-retorno" className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
    <h2 id="email-de-retorno" className="inline-flex items-center gap-2 text-base font-semibold"><Mail size={16} className="text-amber-300"/>{t("meetings.followUp.title")}</h2>
    <p className="mt-1 text-sm text-white/55">{t("meetings.followUp.intro")}</p>
    <form onSubmit={escrever} className="mt-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={ROTULO}>{t("meetings.followUp.recipientLabel")}
          <input value={estado.destinatario} onChange={evento => mudar({ destinatario: evento.target.value })} maxLength={NOME_DO_DESTINATARIO_MAX}
            list={nomesDasVozes.length ? idDaLista : undefined} placeholder={t("meetings.followUp.recipientPlaceholder")} dir="auto" autoComplete="off"
            aria-describedby={idDaDica} className={CAMPO}/>
        </label>
        <label className={ROTULO}>{t("meetings.followUp.relationshipLabel")}
          <select value={estado.relacao} onChange={evento => mudar({ relacao: evento.target.value as RelacaoDoEmail })} className={LISTA}>
            {RELACOES_DO_EMAIL.map(relacao => <option key={relacao} value={relacao} className={OPCAO}>{rotuloDaRelacao(t, relacao)}</option>)}
          </select>
        </label>
        <label className={ROTULO}>{t("meetings.followUp.toneLabel")}
          <select value={estado.tom} onChange={evento => mudar({ tom: evento.target.value as TomDoEmail })} className={LISTA}>
            {TONS_DO_EMAIL.map(tom => <option key={tom} value={tom} className={OPCAO}>{rotuloDoTom(t, tom)}</option>)}
          </select>
        </label>
        <label className={ROTULO}>{t("meetings.followUp.languageLabel")}
          <select value={estado.idioma} onChange={evento => mudar({ idioma: evento.target.value as IdiomaDaReuniao })} className={LISTA}>
            {LANGUAGES.map(idioma => <option key={idioma.code} value={idioma.code} className={OPCAO}>
              {idioma.flag} {idioma.label}{idioma.code === idiomaOriginal ? ` ${t("meetings.originalLanguageSuffix")}` : ""}
            </option>)}
          </select>
        </label>
      </div>
      {nomesDasVozes.length > 0 && <datalist id={idDaLista}>{nomesDasVozes.map(dado => <option key={dado} value={dado}/>)}</datalist>}
      <p id={idDaDica} className="text-xs text-white/45">{t("meetings.followUp.recipientHint")}</p>
      {confirmados === 0 && <p className="text-sm text-amber-100/80">{t("meetings.followUp.needsConfirmed")}</p>}
      <button type="submit" disabled={!podeEscrever}
        className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#c98f70] px-4 py-2.5 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50">
        {rascunhar.isPending ? <Loader2 size={15} className="animate-spin"/> : <PenLine size={15}/>} {rascunho ? t("meetings.followUp.regenerate") : t("meetings.followUp.generate")}
      </button>
    </form>
    {rascunhar.isPending && <p role="status" className="mt-4 text-sm text-white/55"><Loader2 size={15} className="mr-2 inline animate-spin"/>{t("meetings.followUp.generating")}</p>}
    {rascunhar.isError && <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">{mensagemDoErro(t, rascunhar.error)}</p>}
    {rascunho && link && <div className="mt-4 space-y-3 rounded-xl border border-white/10 bg-black/10 p-4">
      <AvisoDeConferir>{t("meetings.followUp.reviewNotice")}</AvisoDeConferir>
      <label className={ROTULO}>{t("meetings.followUp.subjectLabel")}
        <input value={rascunho.assunto} onChange={evento => mudarRascunho({ assunto: evento.target.value })} dir="auto" className={CAMPO}/>
      </label>
      <label className={ROTULO}>{t("meetings.followUp.bodyLabel")}
        <textarea ref={campoDoTexto} value={rascunho.corpo} onChange={evento => mudarRascunho({ corpo: evento.target.value })} rows={12} dir="auto"
          className={`${CAMPO} leading-6`}/>
      </label>
      {rascunho.semNome.length > 0 && <p className="text-xs text-amber-100/80">
        {t("meetings.followUp.unnamedVoices", { vozes: rascunho.semNome.map(n => t("meetings.speakerLabel", { n })).join(", ") })}
      </p>}
      {!link.completo && <p className="text-xs text-white/55">{t("meetings.followUp.tooLongForLink")}</p>}
      <div className="flex flex-wrap gap-2">
        {/* Longo demais para o link: o assunto vai no link, e o texto, copiado no mesmo toque. */}
        <a href={link.href} onClick={() => { if (!link.completo) void copiar(true); }}
          className="inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8]">
          <Mail size={15}/> {t("meetings.followUp.openInEmail")}
        </a>
        <button type="button" onClick={() => void copiar(false)}
          className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm text-white/85 hover:bg-white/5">
          <Copy size={15}/> {t("meetings.followUp.copy")}
        </button>
      </div>
    </div>}
  </section>;
}
