import { useEffect, useId, useState, type ChangeEvent, type ReactNode } from "react";
import { Link } from "wouter";
import type { inferRouterOutputs } from "@trpc/server";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ListChecks, Loader2, Pencil, Trash2, UserRound, X } from "lucide-react";
import type { AppRouter } from "../../../server/routers";
import { trpc } from "@/lib/trpc";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { mensagemDeErroParaTela, traduzirMensagemDoServidor } from "@/lib/mensagem-de-erro";
import { rotaDaReuniao } from "@shared/rotas";
import { vozesNoTexto } from "@shared/vozes-no-texto";
import {
  DETALHE_DA_ACAO_MAX,
  hojeNoRelogio,
  MENSAGEM_ACAO_NAO_ENCONTRADA,
  MENSAGEM_CONTATO_FORA_DA_REDE,
  RESPONSAVEL_DA_ACAO_MAX,
  ROTA_DAS_PROXIMAS_ACOES,
  situacaoDoPrazo,
  TEXTO_DA_ACAO_MAX,
} from "@shared/proximas-acoes";

/**
 * As próximas ações da dona (H5a do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md): a lista que a página
 * /proximas-acoes (pages/ProximasAcoes.tsx) e o cartão do Dashboard usam.
 *
 * Cada ação tem a caixa de feita, que marca também o item do resumo de onde ela
 * veio. Os rótulos de voz ({F2}) viram o nome que a dona deu, enquanto a ação
 * está presa ao item; a voz sem nome é "Falante n". Na página, a ação ainda se
 * edita, se apaga (a da reunião volta a "para conferir" no resumo) e se liga a
 * um contato da rede, com a sugestão pelo nome do responsável. O que vale está
 * no servidor (server/proximas-acoes.ts).
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;
type Saidas = inferRouterOutputs<AppRouter>;
type AcaoDoPainel = Saidas["proximasAcoes"]["doPainel"]["acoes"][number];
type AcaoDaLista = Saidas["proximasAcoes"]["listar"]["acoes"][number];
export type ProximaAcao = AcaoDoPainel & { contatoSugerido?: AcaoDaLista["contatoSugerido"] };

/** A recusa do servidor, no idioma da tela. */
export function mensagemDoErroDaAcao(t: TranslateFn, erro: unknown): string {
  const mensagem = (erro as { message?: unknown } | null)?.message;
  if (mensagem === MENSAGEM_ACAO_NAO_ENCONTRADA || mensagem === MENSAGEM_CONTATO_FORA_DA_REDE) return traduzirMensagemDoServidor(mensagem, t);
  const codigo = (erro as { data?: { code?: string } } | null)?.data?.code;
  if (codigo === "INTERNAL_SERVER_ERROR" || codigo === "TOO_MANY_REQUESTS") return mensagemDeErroParaTela(erro, t);
  return t("proximasAcoes.saveError");
}

/** "2026-11-20" no idioma de quem lê; o ano só quando não é o corrente. */
export function prazoNaTela(prazo: string, idioma: string, agora: Date = new Date()): string {
  const [ano, mes, dia] = prazo.split("-").map(Number);
  const data = new Date(ano, mes - 1, dia);
  return data.toLocaleDateString(idioma, { day: "numeric", month: "short", ...(ano === agora.getFullYear() ? {} : { year: "numeric" }) });
}

export type ValoresDaAcao = { texto: string; detalhe: string; responsavel: string; prazo: string };
const CAMPO = "w-full rounded-lg border border-white/15 bg-black/20 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-amber-300/60 focus:outline-none";
const ROTULO = "mb-1 block text-xs font-semibold text-white/60";

/** O formulário da ação: anotar uma nova (na página) ou editar uma da lista. */
export function FormularioDaAcao({ inicial, salvando, aoSalvar, aoCancelar }: {
  inicial: ValoresDaAcao;
  salvando: boolean;
  aoSalvar: (valores: ValoresDaAcao) => void;
  aoCancelar: () => void;
}) {
  const { t } = useTranslation();
  const [valores, setValores] = useState(inicial);
  const id = useId();
  const mudar = (campo: keyof ValoresDaAcao) => (evento: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setValores(atuais => ({ ...atuais, [campo]: evento.target.value }));
  const podeSalvar = !salvando && valores.texto.trim().length > 0;
  return <form className="space-y-3" onSubmit={evento => { evento.preventDefault(); if (podeSalvar) aoSalvar(valores); }}>
    <div>
      <label htmlFor={`${id}-texto`} className={ROTULO}>{t("proximasAcoes.fieldText")}</label>
      <input id={`${id}-texto`} dir="auto" className={CAMPO} value={valores.texto} onChange={mudar("texto")} maxLength={TEXTO_DA_ACAO_MAX} required autoFocus/>
    </div>
    <div>
      <label htmlFor={`${id}-detalhe`} className={ROTULO}>{t("proximasAcoes.fieldDetail")}</label>
      <textarea id={`${id}-detalhe`} dir="auto" rows={2} className={CAMPO} value={valores.detalhe} onChange={mudar("detalhe")} maxLength={DETALHE_DA_ACAO_MAX}/>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label htmlFor={`${id}-responsavel`} className={ROTULO}>{t("proximasAcoes.fieldOwner")}</label>
        <input id={`${id}-responsavel`} dir="auto" className={CAMPO} value={valores.responsavel} onChange={mudar("responsavel")} maxLength={RESPONSAVEL_DA_ACAO_MAX}/>
      </div>
      <div>
        <label htmlFor={`${id}-prazo`} className={ROTULO}>{t("proximasAcoes.fieldDueDate")}</label>
        <input id={`${id}-prazo`} type="date" min="2000-01-01" max="2100-12-31" className={CAMPO} value={valores.prazo} onChange={mudar("prazo")}/>
      </div>
    </div>
    <div className="flex flex-wrap gap-2">
      <button type="submit" disabled={!podeSalvar}
        className="inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50">
        {salvando && <Loader2 size={14} className="animate-spin"/>} {t("proximasAcoes.save")}
      </button>
      <button type="button" onClick={aoCancelar} className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/70 hover:bg-white/5">
        {t("proximasAcoes.cancel")}
      </button>
    </div>
  </form>;
}

/** A lista de ações. `compacto` é o cartão do Dashboard: só a caixa, o texto, o prazo e o contato. */
export function ProximasAcoes({ acoes, compacto = false }: { acoes: readonly ProximaAcao[]; compacto?: boolean }) {
  const hoje = hojeNoRelogio();
  return <ul className="space-y-3">
    {acoes.map(acao => <ItemDaProximaAcao key={acao.id} acao={acao} compacto={compacto} hoje={hoje}/>)}
  </ul>;
}

function Selo({ cor, children }: { cor: "vermelho" | "ambar"; children: ReactNode }) {
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${cor === "vermelho" ? "border-red-400/30 bg-red-400/10 text-red-200" : "border-amber-300/30 bg-amber-300/10 text-amber-200"}`}>
    {children}
  </span>;
}

const BOTAO_DE_TEXTO = "inline-flex items-center gap-1 text-xs font-semibold text-amber-200 hover:text-amber-100 disabled:opacity-50";

function ItemDaProximaAcao({ acao, compacto, hoje }: { acao: ProximaAcao; compacto: boolean; hoje: string }) {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  // A ação e o item do resumo mudam juntos: relê as duas telas.
  const reler = () => Promise.all([utils.proximasAcoes.invalidate(), utils.meetings.resumoGuardado.invalidate()]);
  const aoFalhar = (erro: unknown) => toast.error(mensagemDoErroDaAcao(t, erro));
  const marcar = trpc.proximasAcoes.marcarFeita.useMutation({ onError: aoFalhar, onSettled: reler });
  const ligar = trpc.proximasAcoes.ligarContato.useMutation({ onError: aoFalhar, onSettled: reler });
  const editar = trpc.proximasAcoes.editar.useMutation({ onError: aoFalhar, onSettled: reler });
  const apagar = trpc.proximasAcoes.apagar.useMutation({ onError: aoFalhar, onSettled: reler });
  const ocupado = marcar.isPending || ligar.isPending || editar.isPending || apagar.isPending;
  const [modo, setModo] = useState<"ver" | "editar" | "apagar" | "contato">("ver");
  const idDoTexto = useId();

  const comVozes = (texto: string) => vozesNoTexto(texto, acao.vozes, numero => t("meetings.speakerLabel", { n: numero }));
  const situacao = situacaoDoPrazo(acao.prazo, acao.feita, hoje);
  const daReuniao = acao.origem === "reuniao";

  if (modo === "editar") {
    const inicial: ValoresDaAcao = {
      texto: comVozes(acao.texto), detalhe: acao.detalhe ? comVozes(acao.detalhe) : "",
      responsavel: acao.responsavel ? comVozes(acao.responsavel) : "", prazo: acao.prazo ?? "",
    };
    return <li className="rounded-xl border border-amber-300/30 bg-black/10 p-3">
      <FormularioDaAcao inicial={inicial} salvando={editar.isPending} aoCancelar={() => setModo("ver")}
        aoSalvar={valores => {
          // Só o que mudou: o texto que a dona não tocou guarda os rótulos de voz.
          const mudou = (campo: keyof ValoresDaAcao) => valores[campo] !== inicial[campo];
          editar.mutate({
            id: acao.id,
            ...(mudou("texto") ? { texto: valores.texto } : {}),
            ...(mudou("detalhe") ? { detalhe: valores.detalhe } : {}),
            ...(mudou("responsavel") ? { responsavel: valores.responsavel } : {}),
            ...(mudou("prazo") ? { prazo: valores.prazo } : {}),
          }, { onSuccess: () => setModo("ver") });
        }}/>
    </li>;
  }

  return <li className={`rounded-xl border p-3 ${situacao === "atrasada" ? "border-red-400/25 bg-red-400/[0.04]" : "border-white/10 bg-black/10"}`}>
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" checked={acao.feita} disabled={ocupado} onChange={evento => marcar.mutate({ id: acao.id, feita: evento.target.checked })}
        className="mt-1 h-4 w-4 shrink-0 accent-amber-400"/>
      <span id={idDoTexto} dir="auto" className={`text-sm ${acao.feita ? "text-white/45 line-through" : "text-white/90"}`}>{comVozes(acao.texto)}</span>
    </label>

    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 ps-7 text-xs text-white/55">
      {situacao === "atrasada" && <Selo cor="vermelho">{t("proximasAcoes.overdue")}</Selo>}
      {situacao === "hoje" && <Selo cor="ambar">{t("proximasAcoes.dueToday")}</Selo>}
      {acao.prazo && <span>{t("proximasAcoes.dueDate", { data: prazoNaTela(acao.prazo, i18n.language) })}</span>}
      {acao.responsavel && <span dir="auto">{t("proximasAcoes.owner", { nome: comVozes(acao.responsavel) })}</span>}
      {acao.contato && <Link href={`/meu-network-inteligente/contatos/${acao.contato.id}`} className="inline-flex items-center gap-1 text-amber-200 hover:text-amber-100">
        <UserRound size={12} aria-hidden/> {t("proximasAcoes.contact", { nome: acao.contato.nome })}
      </Link>}
      {!compacto && acao.prazoDito && <span dir="auto">{t("proximasAcoes.spokenDue", { prazo: acao.prazoDito })}</span>}
    </div>

    {!compacto && <div className="mt-2 space-y-2 ps-7">
      {acao.detalhe && <p dir="auto" className="text-sm leading-6 text-white/70">{comVozes(acao.detalhe)}</p>}
      <p className="text-xs text-white/45">
        {acao.reuniao
          ? <Link href={rotaDaReuniao(acao.reuniao.id, acao.reuniao.itemId ? { item: acao.reuniao.itemId } : {})} className="text-amber-200 hover:text-amber-100">
              {t("proximasAcoes.fromMeeting", { titulo: acao.reuniao.titulo })}
            </Link>
          : daReuniao ? t("proximasAcoes.meetingDeleted") : t("proximasAcoes.manual")}
      </p>
      {acao.trecho && <details>
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-white/35">{t("proximasAcoes.excerpt")}</summary>
        <q dir="auto" className="mt-1 block border-s-2 border-amber-300/40 ps-3 text-xs italic text-white/55">{acao.trecho}</q>
      </details>}

      {!acao.contato && acao.contatoSugerido && modo === "ver" && <p className="flex flex-wrap items-center gap-2 text-xs text-white/70">
        <span dir="auto">{t("proximasAcoes.suggestedContact", { nome: acao.contatoSugerido.nome })}</span>
        <button type="button" disabled={ocupado} aria-describedby={idDoTexto} onClick={() => ligar.mutate({ id: acao.id, contactId: acao.contatoSugerido!.id })} className={BOTAO_DE_TEXTO}>
          {t("proximasAcoes.linkSuggested")}
        </button>
      </p>}

      {modo === "contato" && <BuscaDeContato inicial={acao.responsavel ? vozesNoTexto(acao.responsavel, acao.vozes, () => "").trim() : ""}
        aoFechar={() => setModo("ver")} aoEscolher={contactId => ligar.mutate({ id: acao.id, contactId }, { onSuccess: () => setModo("ver") })}/>}

      {modo === "apagar" && <div className="rounded-lg border border-red-400/25 bg-red-400/[0.06] p-3 text-xs text-red-100">
        <p>{daReuniao && acao.reuniao?.itemId ? t("proximasAcoes.deleteQuestionMeeting") : t("proximasAcoes.deleteQuestion")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" disabled={ocupado} aria-describedby={idDoTexto} onClick={() => apagar.mutate({ id: acao.id })}
            className="rounded-lg bg-red-400/90 px-3 py-1.5 text-xs font-bold text-[#1a120c] hover:bg-red-300 disabled:opacity-50">
            {t("proximasAcoes.deleteConfirm")}
          </button>
          <button type="button" onClick={() => setModo("ver")} className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70 hover:bg-white/5">
            {t("proximasAcoes.cancel")}
          </button>
        </div>
      </div>}

      {modo === "ver" && <div className="flex flex-wrap items-center gap-4 pt-1">
        <button type="button" disabled={ocupado} aria-describedby={idDoTexto} onClick={() => setModo("editar")} className={BOTAO_DE_TEXTO}>
          <Pencil size={12} aria-hidden/> {t("proximasAcoes.edit")}
        </button>
        {acao.contato
          ? <button type="button" disabled={ocupado} aria-describedby={idDoTexto} onClick={() => ligar.mutate({ id: acao.id, contactId: null })} className={BOTAO_DE_TEXTO}>
              <X size={12} aria-hidden/> {t("proximasAcoes.unlinkContact")}
            </button>
          : <button type="button" disabled={ocupado} aria-describedby={idDoTexto} onClick={() => setModo("contato")} className={BOTAO_DE_TEXTO}>
              <UserRound size={12} aria-hidden/> {t("proximasAcoes.linkContact")}
            </button>}
        <button type="button" disabled={ocupado} aria-describedby={idDoTexto} onClick={() => setModo("apagar")}
          className="inline-flex items-center gap-1 text-xs font-semibold text-white/45 hover:text-red-200 disabled:opacity-50">
          <Trash2 size={12} aria-hidden/> {t("proximasAcoes.delete")}
        </button>
      </div>}
    </div>}
  </li>;
}

/** A busca na rede da dona para ligar a ação a um contato (network.list, a mesma da Rede). */
function BuscaDeContato({ inicial, aoEscolher, aoFechar }: { inicial: string; aoEscolher: (contactId: number) => void; aoFechar: () => void }) {
  const { t } = useTranslation();
  const [termo, setTermo] = useState(inicial);
  const [procurado, setProcurado] = useState(inicial.trim());
  useEffect(() => {
    const espera = setTimeout(() => setProcurado(termo.trim()), 300);
    return () => clearTimeout(espera);
  }, [termo]);
  const busca = trpc.network.list.useQuery({ q: procurado, limit: 8 }, { enabled: procurado.length >= 2 });
  const id = useId();
  const contatos = busca.data?.data ?? [];
  return <div className="rounded-lg border border-white/10 bg-black/20 p-3">
    <div className="flex items-center gap-2">
      <label htmlFor={`${id}-busca`} className="sr-only">{t("proximasAcoes.searchContact")}</label>
      <input id={`${id}-busca`} dir="auto" className={CAMPO} placeholder={t("proximasAcoes.searchContact")} value={termo}
        onChange={evento => setTermo(evento.target.value)} autoFocus/>
      <button type="button" onClick={aoFechar} aria-label={t("proximasAcoes.cancel")} className="rounded-lg p-2 text-white/50 hover:bg-white/5 hover:text-white">
        <X size={14}/>
      </button>
    </div>
    {procurado.length >= 2 && <div className="mt-2">
      {busca.isError
        ? <ErroDeConsulta erro={busca.error} aoTentarDeNovo={() => void busca.refetch()}/>
        : !busca.data
          ? <p role="status" className="text-xs text-white/50"><Loader2 size={12} className="mr-1 inline animate-spin"/>{t("proximasAcoes.searching")}</p>
          : !contatos.length
            ? <p className="text-xs text-white/50">{t("proximasAcoes.noContactFound")}</p>
            : <ul className="space-y-1">
                {contatos.map(contato => <li key={contato.id}>
                  <button type="button" onClick={() => aoEscolher(contato.id)}
                    className="w-full rounded-lg px-2 py-1.5 text-start text-sm text-white/85 hover:bg-white/5">
                    <span dir="auto">{contato.fullName}</span>
                    {contato.company && <span dir="auto" className="ms-2 text-xs text-white/40">{contato.company}</span>}
                  </button>
                </li>)}
              </ul>}
    </div>}
  </div>;
}

/** O cartão do Dashboard: as 5 ações abertas por prazo e o caminho para a página. */
export function CartaoDeProximasAcoes() {
  const { t } = useTranslation();
  const consulta = trpc.proximasAcoes.doPainel.useQuery();
  const dados = consulta.data;
  let corpo: ReactNode;
  if (consulta.isError) {
    // Erro de consulta é erro, nunca "nenhuma ação".
    corpo = <div className="mt-4"><ErroDeConsulta erro={consulta.error} aoTentarDeNovo={() => void consulta.refetch()}/></div>;
  } else if (!dados) {
    corpo = <p role="status" className="mt-4 text-sm text-white/50"><Loader2 size={14} className="mr-2 inline animate-spin"/>{t("proximasAcoes.loading")}</p>;
  } else if (!dados.acoes.length) {
    corpo = <p className="mt-4 text-sm text-white/55">{t("proximasAcoes.cardEmpty")}</p>;
  } else {
    corpo = <div className="mt-4 space-y-3">
      <p className="text-xs text-white/45">{t("proximasAcoes.openCount", { n: dados.abertas })}</p>
      <ProximasAcoes acoes={dados.acoes} compacto/>
    </div>;
  }
  return <section aria-labelledby="proximas-acoes-do-painel" className="mb-8 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
    <div className="flex items-center justify-between gap-3">
      <h2 id="proximas-acoes-do-painel" className="inline-flex items-center gap-2 text-base font-semibold text-white">
        <ListChecks size={17} className="text-[#c98f70]" aria-hidden/> {t("proximasAcoes.title")}
      </h2>
      <Link href={ROTA_DAS_PROXIMAS_ACOES} className="text-sm font-semibold text-[#c98f70] hover:text-[#efcba8]">{t("proximasAcoes.seeAll")}</Link>
    </div>
    {corpo}
  </section>;
}
