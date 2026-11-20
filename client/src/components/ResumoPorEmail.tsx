import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Mail, RefreshCw, Send, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { LANGUAGES } from "@/i18n";
import { mensagemDeErroParaTela, traduzirMensagemDoServidor } from "@/lib/mensagem-de-erro";
import { idiomaDaTela } from "@/components/CompartilharReuniao";
import { emailDoParticipanteValido } from "@shared/agenda";
import { VERSAO_DA_AUTORIZACAO_COM_NOMES } from "@shared/const";
import {
  DESTINATARIAS_POR_ENVIO_MAX,
  EMAILS_DIGITADOS_POR_ENVIO_MAX,
  EMAILS_POR_DONA_EM_24H,
  EMAILS_POR_REUNIAO_EM_24H,
  emailComparavel,
  MENSAGEM_RESUMO_POR_EMAIL_DEMAIS,
  MENSAGEM_RESUMO_POR_EMAIL_EMAIL_INVALIDO,
  MENSAGEM_RESUMO_POR_EMAIL_FORA_DA_AGENDA,
  MENSAGEM_RESUMO_POR_EMAIL_LINK_DESLIGADO,
  MENSAGEM_RESUMO_POR_EMAIL_NADA_A_REENVIAR,
  MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU,
  MENSAGEM_RESUMO_POR_EMAIL_SEM_DESTINATARIA,
  MENSAGEM_RESUMO_POR_EMAIL_SEM_EMAIL_DA_DONA,
  MENSAGEM_RESUMO_POR_EMAIL_SEM_RESUMO,
  MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_DONA,
  MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_REUNIAO,
  valoresDoEmailDoResumo,
  type EstadoDoResumoPorEmail,
  type OrigemDoResumoPorEmail,
} from "@shared/resumo-por-email";

/**
 * Mandar o resumo por e-mail (H22; HN-54 do HiNoter e R-33 da reunião de
 * 11/11/2026), no detalhe da reunião, logo abaixo do "Compartilhar por link".
 * A WRW manda o link aberto da reunião para a própria dona, para as
 * participantes da agenda que ela escolher (todas, com um toque) e para os
 * e-mails que ela digitar. Quem recebe não precisa de conta.
 *
 * O texto do e-mail é fixo, no idioma da reunião, e a prévia mostra o que vai
 * (chaves emailDoResumo.*, as mesmas do servidor). Com o link desligado, a
 * dona confirma, com a caixa do "Compartilhar", que as pessoas autorizaram, e
 * o link liga junto com o envio. O que não saiu (a Resend fora do ar) fica
 * guardado, com o "Tentar de novo". A opção do envio automático vale para a
 * conta: no fim de cada reunião, o resumo vai só para ela.
 *
 * O texto segue a senha e o áudio do link (H23), como o servidor
 * (server/email-do-resumo.ts): sem o áudio, não promete a gravação; com a
 * senha, diz que ela não vai no e-mail, e o painel avisa a dona de que a senha
 * vai por ela, à parte. Os textos novos (emailDoResumo.oQueAbreSemAudio,
 * senha, senhaSemNome e senhaDona, e resumoPorEmail.linkComSenha) esperam a
 * revisão da Cris, nos 10 idiomas.
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/** As recusas do servidor que a tela traduz pela frase (client/src/lib/mensagem-de-erro.ts). */
const RECUSAS = new Set<string>([
  MENSAGEM_RESUMO_POR_EMAIL_SEM_RESUMO, MENSAGEM_RESUMO_POR_EMAIL_SEM_DESTINATARIA, MENSAGEM_RESUMO_POR_EMAIL_DEMAIS,
  MENSAGEM_RESUMO_POR_EMAIL_FORA_DA_AGENDA, MENSAGEM_RESUMO_POR_EMAIL_EMAIL_INVALIDO, MENSAGEM_RESUMO_POR_EMAIL_SEM_EMAIL_DA_DONA,
  MENSAGEM_RESUMO_POR_EMAIL_LINK_DESLIGADO, MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_REUNIAO, MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_DONA,
  MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU, MENSAGEM_RESUMO_POR_EMAIL_NADA_A_REENVIAR,
]);

export function mensagemDoErroDoEnvio(t: TranslateFn, erro: unknown): string {
  const { data, message } = (erro ?? {}) as { data?: { code?: string }; message?: unknown };
  if (data?.code === "NOT_FOUND") return t("meetings.meetingNotFound");
  if (typeof message === "string" && RECUSAS.has(message)) return traduzirMensagemDoServidor(message, t);
  // O banco fora do ar e o limite da API têm frase própria, no idioma da tela.
  if (data?.code === "INTERNAL_SERVER_ERROR" || data?.code === "TOO_MANY_REQUESTS") return mensagemDeErroParaTela(erro, t);
  return t("resumoPorEmail.erro");
}

const ROTULO_DO_ESTADO: Record<EstadoDoResumoPorEmail, (t: TranslateFn) => string> = {
  pendente: t => t("resumoPorEmail.estados.pendente"),
  enviado: t => t("resumoPorEmail.estados.enviado"),
  falhou: t => t("resumoPorEmail.estados.falhou"),
};
const ROTULO_DA_ORIGEM: Record<OrigemDoResumoPorEmail | "automatico", (t: TranslateFn) => string> = {
  dona: t => t("resumoPorEmail.origens.dona"),
  participante: t => t("resumoPorEmail.origens.participante"),
  digitado: t => t("resumoPorEmail.origens.digitado"),
  automatico: t => t("resumoPorEmail.origens.automatico"),
};
const COR_DO_ESTADO: Record<EstadoDoResumoPorEmail, string> = {
  pendente: "border-amber-300/30 text-amber-100",
  enviado: "border-emerald-300/30 text-emerald-100",
  falhou: "border-red-300/40 text-red-100",
};

type PropsDoResumoPorEmail = {
  meetingId: string;
  titulo: string;
  /** O link aberto está ligado agora (meeting.shareToken): desligado, mandar pede a confirmação. */
  linkLigado: boolean;
  /** O link ligado pede a senha de 6 dígitos (meeting.linkComSenha, H23). */
  linkComSenha?: boolean;
  /** O link ligado leva o áudio (meeting.linkComAudio, H23). */
  linkComAudio?: boolean;
};

/**
 * O cabeçalho, sempre à vista, e o painel, só depois do toque: o detalhe de
 * toda reunião pronta não pede o painel ao servidor à toa, e nenhuma consulta
 * nem mutação do envio existe com ele fechado.
 */
export function ResumoPorEmail(props: PropsDoResumoPorEmail) {
  const { t } = useTranslation();
  const id = useId();
  const [aberto, setAberto] = useState(false);
  return <section aria-labelledby={`${id}-titulo`} className="mb-6 rounded-2xl border border-white/10 bg-white/[0.035] p-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 id={`${id}-titulo`} className="inline-flex items-center gap-2 text-base font-semibold"><Mail size={16} className="shrink-0 text-amber-300"/>{t("resumoPorEmail.titulo")}</h2>
        <p className="mt-1 text-sm text-white/55">{t("resumoPorEmail.intro")}</p>
      </div>
      <button type="button" aria-expanded={aberto} aria-controls={`${id}-painel`} onClick={() => setAberto(valor => !valor)}
        className="inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-amber-300/40 px-4 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-300/10 sm:w-auto">
        {aberto ? <X size={15}/> : <Mail size={15}/>} {aberto ? t("resumoPorEmail.fechar") : t("resumoPorEmail.abrir")}
      </button>
    </div>
    {aberto && <PainelDoResumoPorEmail {...props} idDoPainel={`${id}-painel`}/>}
  </section>;
}

function PainelDoResumoPorEmail({ meetingId, titulo, linkLigado, linkComSenha = false, linkComAudio = true, idDoPainel }: PropsDoResumoPorEmail & { idDoPainel: string }) {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  const id = useId();
  const [paraMim, setParaMim] = useState(false);
  const [escolhidas, setEscolhidas] = useState<string[]>([]);
  const [outros, setOutros] = useState<string[]>([]);
  const [digitando, setDigitando] = useState("");
  const [avisoDoCampo, setAvisoDoCampo] = useState<string | null>(null);
  const [autorizou, setAutorizou] = useState(false);

  const painel = trpc.meetings.resumoPorEmail.useQuery({ meetingId });
  const reler = () => {
    void utils.meetings.resumoPorEmail.invalidate({ meetingId });
    // O link pode ter ligado no envio, mesmo quando a Resend falhou depois.
    void utils.meetings.get.invalidate({ meetingId });
  };
  const mandar = trpc.meetings.mandarResumoPorEmail.useMutation({
    onSuccess: resultado => {
      if (resultado.falharam) toast.warning(t("resumoPorEmail.parcial", { enviados: resultado.enviados, falharam: resultado.falharam }));
      else toast.success(t("resumoPorEmail.mandado", { n: resultado.enviados }));
      setParaMim(false);
      setEscolhidas([]);
      setOutros([]);
      setAutorizou(false);
      setAvisoDoCampo(null);
      reler();
    },
    onError: erro => {
      toast.error(mensagemDoErroDoEnvio(t, erro));
      reler();
    },
  });
  const deNovo = trpc.meetings.mandarResumoPorEmailDeNovo.useMutation({
    onSuccess: resultado => {
      if (resultado.falharam) toast.warning(t("resumoPorEmail.parcial", { enviados: resultado.enviados, falharam: resultado.falharam }));
      else toast.success(t("resumoPorEmail.reenviado", { n: resultado.enviados }));
      reler();
    },
    onError: erro => {
      toast.error(mensagemDoErroDoEnvio(t, erro));
      reler();
    },
  });
  const automatico = trpc.meetings.envioAutomaticoDoResumo.useMutation({
    onSuccess: ({ automatico: ligado }) => {
      utils.meetings.resumoPorEmail.setData({ meetingId }, anterior => anterior && { ...anterior, automatico: ligado });
      toast.success(ligado ? t("resumoPorEmail.automaticoLigado") : t("resumoPorEmail.automaticoDesligado"));
    },
    onError: erro => toast.error(mensagemDoErroDoEnvio(t, erro)),
  });

  if (painel.isPending) {
    return <p id={idDoPainel} role="status" className="mt-4 inline-flex items-center gap-2 text-sm text-white/55"><Loader2 size={15} className="animate-spin"/>{t("resumoPorEmail.carregando")}</p>;
  }
  if (painel.isError || !painel.data) {
    return <p id={idDoPainel} role="alert" className="mt-4 text-sm text-red-200">{mensagemDoErroDoEnvio(t, painel.error)}</p>;
  }

  const dados = painel.data;
  const escolhidasNaLista = new Set(escolhidas.map(emailComparavel));
  const todas = dados.participantes.length > 0 && dados.participantes.every(p => escolhidasNaLista.has(emailComparavel(p.email)));
  const chaves = new Set<string>(Array.from(escolhidasNaLista).concat(outros.map(emailComparavel)));
  if (paraMim && dados.emailDaDona) chaves.add(emailComparavel(dados.emailDaDona));
  const total = chaves.size;
  const precisaAutorizar = !linkLigado;
  // Como o link vai estar quando o e-mail sair (H23): o desligado liga agora
  // como o de antes, sem senha e com o áudio; o ligado fica como está.
  const comSenha = linkLigado && linkComSenha;
  const comAudio = !linkLigado || linkComAudio;
  const ocupado = mandar.isPending || deNovo.isPending;
  const podeMandar = total > 0 && total <= DESTINATARIAS_POR_ENVIO_MAX && (!precisaAutorizar || autorizou) && !ocupado;
  const nomeDoIdioma = LANGUAGES.find(idioma => idioma.code === dados.idioma)?.label ?? dados.idioma;

  function alternar(email: string, marcar: boolean) {
    const chave = emailComparavel(email);
    setEscolhidas(atuais => (marcar ? [...atuais.filter(e => emailComparavel(e) !== chave), email] : atuais.filter(e => emailComparavel(e) !== chave)));
  }

  function adicionar(evento: FormEvent) {
    evento.preventDefault();
    const pedacos = digitando.split(/[\s,;]+/).map(pedaco => pedaco.trim()).filter(Boolean);
    if (!pedacos.length) return;
    const lista = [...outros];
    let aviso: string | null = null;
    let sobra: string[] = [];
    for (let posicao = 0; posicao < pedacos.length; posicao++) {
      const email = pedacos[posicao];
      if (!emailDoParticipanteValido(email)) {
        aviso = t("resumoPorEmail.emailInvalido", { email });
        sobra = pedacos.slice(posicao);
        break;
      }
      const chave = emailComparavel(email);
      const jaEsta = lista.some(e => emailComparavel(e) === chave) || escolhidasNaLista.has(chave)
        || (paraMim && !!dados.emailDaDona && emailComparavel(dados.emailDaDona) === chave);
      if (jaEsta) {
        aviso = t("resumoPorEmail.jaNaLista", { email });
        continue;
      }
      if (lista.length >= EMAILS_DIGITADOS_POR_ENVIO_MAX) {
        aviso = t("resumoPorEmail.outrosDemais", { max: EMAILS_DIGITADOS_POR_ENVIO_MAX });
        sobra = pedacos.slice(posicao);
        break;
      }
      lista.push(email);
    }
    setOutros(lista);
    setDigitando(sobra.join(", "));
    setAvisoDoCampo(aviso);
  }

  function enviar() {
    mandar.mutate({
      meetingId,
      paraMim: paraMim && !!dados.emailDaDona,
      participantes: escolhidas,
      outros,
      ...(precisaAutorizar ? {
        autorizacao: {
          autorizacaoDasPessoas: true as const,
          // A prova guarda a frase que a dona viu, no idioma dela, e a versão da caixa (H3b).
          idioma: idiomaDaTela(i18n),
          textoExibido: t("meetings.share.authorization"),
          versaoDaAutorizacao: VERSAO_DA_AUTORIZACAO_COM_NOMES,
        },
      } : {}),
    });
  }

  // A prévia é o e-mail que as participantes recebem, no idioma da reunião, com
  // o título e o nome limpos como o servidor os põe (shared/resumo-por-email.ts).
  const tDoEmail = i18n.getFixedT(dados.idioma);
  const valoresDaPrevia = valoresDoEmailDoResumo(titulo, dados.nomeDaDona);
  const comNome = Boolean(valoresDaPrevia.dona);
  const previa = {
    assunto: comNome ? tDoEmail("emailDoResumo.assunto", valoresDaPrevia) : tDoEmail("emailDoResumo.assuntoSemNome", valoresDaPrevia),
    abertura: comNome ? tDoEmail("emailDoResumo.abertura", valoresDaPrevia) : tDoEmail("emailDoResumo.aberturaSemNome", valoresDaPrevia),
    oQueAbre: comAudio ? tDoEmail("emailDoResumo.oQueAbre") : tDoEmail("emailDoResumo.oQueAbreSemAudio"),
    senha: !comSenha ? null : comNome ? tDoEmail("emailDoResumo.senha", valoresDaPrevia) : tDoEmail("emailDoResumo.senhaSemNome", valoresDaPrevia),
    botao: tDoEmail("emailDoResumo.botao"),
    aviso: tDoEmail("emailDoResumo.aviso"),
    porQue: comNome ? tDoEmail("emailDoResumo.porQue", valoresDaPrevia) : tDoEmail("emailDoResumo.porQueSemNome", valoresDaPrevia),
  };

  return <div id={idDoPainel} className="mt-4 space-y-4">
      <fieldset className="min-w-0 space-y-3">
        <legend className="sr-only">{t("resumoPorEmail.titulo")}</legend>
        {dados.emailDaDona && <label className="flex min-w-0 items-start gap-3 text-sm text-white/80">
          <input type="checkbox" checked={paraMim} onChange={evento => setParaMim(evento.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-amber-400"/>
          <span className="min-w-0">{t("resumoPorEmail.paraMim")} <span dir="ltr" className="break-all text-white/50">({dados.emailDaDona})</span></span>
        </label>}

        <div className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-white/80">{t("resumoPorEmail.participantes")}</p>
            {dados.participantes.length > 1 && <label className="inline-flex items-center gap-2 text-sm text-white/70">
              <input type="checkbox" checked={todas} onChange={evento => setEscolhidas(evento.target.checked ? dados.participantes.map(p => p.email) : [])} className="h-4 w-4 accent-amber-400"/>
              {t("resumoPorEmail.todas")}
            </label>}
          </div>
          {dados.participantes.length ? <ul className="mt-2 space-y-2">
            {dados.participantes.map(participante => <li key={participante.email}>
              <label className="flex min-w-0 items-start gap-3 text-sm text-white/80">
                <input type="checkbox" checked={escolhidasNaLista.has(emailComparavel(participante.email))}
                  onChange={evento => alternar(participante.email, evento.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-amber-400"/>
                <span className="min-w-0">
                  {/* Um espaço de verdade entre o nome e o e-mail, e não margem: em árabe o
                      nome em letras latinas vira a ponta do outro lado, e a margem ficava
                      no lado errado ("ana@…Ana"). */}
                  {participante.nome && <><span dir="auto">{participante.nome}</span>{" "}</>}
                  <span dir="ltr" className="break-all text-white/50">{participante.email}</span>
                </span>
              </label>
            </li>)}
          </ul> : <p className="mt-1 text-sm text-white/50">{t("resumoPorEmail.semParticipantes")}</p>}
        </div>

        <div className="min-w-0">
          <p className="text-sm font-semibold text-white/80">{t("resumoPorEmail.outros")}</p>
          {/* noValidate e type="text": a conferência é a nossa, com o aviso traduzido; a do
              navegador barraria em silêncio a lista colada ("a@x.com, b@y.com"). */}
          <form onSubmit={adicionar} noValidate className="mt-2 flex flex-col gap-2 sm:flex-row">
            <label htmlFor={`${id}-email`} className="sr-only">{t("resumoPorEmail.outrosRotulo")}</label>
            {/* E-mail é sempre da esquerda para a direita, também numa tela em árabe. */}
            <input id={`${id}-email`} type="text" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} dir="ltr" value={digitando}
              placeholder={t("resumoPorEmail.outrosRotulo")} aria-describedby={`${id}-ajuda`}
              onChange={evento => { setDigitando(evento.target.value); setAvisoDoCampo(null); }}
              className="min-w-0 flex-1 rounded-xl border border-white/15 bg-black/20 px-4 py-2.5 text-base text-white/85 outline-none focus:border-amber-300 sm:text-sm"/>
            <button type="submit" className="inline-flex w-full items-center justify-center rounded-lg border border-white/15 px-4 py-2 text-sm text-white/85 hover:bg-white/5 sm:w-auto">
              {t("resumoPorEmail.adicionar")}
            </button>
          </form>
          <p id={`${id}-ajuda`} className="mt-1 text-xs text-white/45">{t("resumoPorEmail.outrosAjuda", { max: EMAILS_DIGITADOS_POR_ENVIO_MAX })}</p>
          {avisoDoCampo && <p role="alert" className="mt-1 break-words text-sm text-amber-200">{avisoDoCampo}</p>}
          {outros.length > 0 && <ul className="mt-2 flex flex-wrap gap-2">
            {outros.map(email => <li key={emailComparavel(email)} className="inline-flex max-w-full items-center gap-1 rounded-full border border-white/15 bg-black/20 py-1 ps-3 pe-1 text-sm text-white/80">
              <span dir="ltr" className="min-w-0 break-all">{email}</span>
              <button type="button" onClick={() => setOutros(atuais => atuais.filter(e => e !== email))} aria-label={t("resumoPorEmail.remover", { email })}
                className="shrink-0 rounded-full p-1 text-white/55 hover:bg-white/10 hover:text-white"><X size={14}/></button>
            </li>)}
          </ul>}
        </div>
      </fieldset>

      <p className="text-sm text-white/55">{t("resumoPorEmail.idioma", { idioma: nomeDoIdioma })}</p>
      <details className="rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm">
        <summary className="cursor-pointer text-white/75">{t("resumoPorEmail.verEmail")}</summary>
        <div lang={dados.idioma} dir={dados.idioma === "ar" ? "rtl" : "ltr"} className="mt-3 space-y-2 break-words text-white/70">
          <dl>
            <dt className="text-xs font-semibold text-white/45">{t("resumoPorEmail.assuntoDaPrevia")}</dt>
            <dd className="font-semibold text-white/85">{previa.assunto}</dd>
          </dl>
          <p>{previa.abertura}</p>
          <p>{previa.oQueAbre}</p>
          {previa.senha && <p>{previa.senha}</p>}
          <p><span className="inline-block rounded-lg bg-[#c98f70] px-3 py-1.5 text-sm font-bold text-[#1a120c]">{previa.botao}</span></p>
          <p className="text-xs text-amber-100/70">{previa.aviso}</p>
          <p className="text-xs text-white/45">{previa.porQue}</p>
        </div>
      </details>

      {precisaAutorizar && <div className="space-y-3 rounded-xl border border-amber-300/30 bg-amber-300/[0.06] p-4">
        <p className="text-sm text-amber-100/90">{t("resumoPorEmail.linkDesligado")}</p>
        <label className="flex items-start gap-3 text-sm text-white/80">
          <input type="checkbox" checked={autorizou} onChange={evento => setAutorizou(evento.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-amber-400"/>
          <span>{t("meetings.share.authorization")}</span>
        </label>
      </div>}

      {/* O link com senha (H23): a senha não vai no e-mail, e quem manda é a dona. */}
      {comSenha && <p className="rounded-xl border border-amber-300/30 bg-amber-300/[0.06] p-4 text-sm text-amber-100/90">{t("resumoPorEmail.linkComSenha")}</p>}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-white/55" aria-live="polite">{t("resumoPorEmail.contagem", { n: total, max: DESTINATARIAS_POR_ENVIO_MAX })}</p>
        <button type="button" onClick={enviar} disabled={!podeMandar}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50 sm:w-auto">
          {mandar.isPending ? <Loader2 size={15} className="animate-spin"/> : <Send size={15}/>} {mandar.isPending ? t("resumoPorEmail.mandando") : t("resumoPorEmail.mandar")}
        </button>
      </div>
      <p className="text-xs text-white/40">{t("resumoPorEmail.limites", { porEnvio: DESTINATARIAS_POR_ENVIO_MAX, porReuniao: EMAILS_POR_REUNIAO_EM_24H, porDona: EMAILS_POR_DONA_EM_24H })}</p>

      {dados.envios.length > 0 && <div className="border-t border-white/10 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-white/80">{t("resumoPorEmail.historico")}</h3>
          {dados.podeMandarDeNovo && <button type="button" onClick={() => deNovo.mutate({ meetingId })} disabled={ocupado}
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/85 hover:bg-white/5 disabled:opacity-50">
            <RefreshCw size={14} className={deNovo.isPending ? "animate-spin" : ""}/> {t("resumoPorEmail.tentarDeNovo")}
          </button>}
        </div>
        <ul className="mt-2 divide-y divide-white/5">
          {dados.envios.map(envio => <li key={envio.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
            <span dir="ltr" className="min-w-0 break-all text-white/75">{envio.destinatario ?? "—"}</span>
            <span className="text-xs text-white/45">{ROTULO_DA_ORIGEM[envio.automatico ? "automatico" : envio.origem](t)}</span>
            <span className={`rounded-full border px-2 py-0.5 text-xs ${COR_DO_ESTADO[envio.status]}`}>{ROTULO_DO_ESTADO[envio.status](t)}</span>
            <time dateTime={new Date(envio.enviadoEm ?? envio.createdAt).toISOString()} className="text-xs text-white/40">
              {new Date(envio.enviadoEm ?? envio.createdAt).toLocaleString(i18n.language)}
            </time>
          </li>)}
        </ul>
      </div>}

      <label className="flex items-start gap-3 border-t border-white/10 pt-4 text-sm text-white/80">
        <input type="checkbox" checked={dados.automatico} disabled={automatico.isPending}
          onChange={evento => automatico.mutate({ ligado: evento.target.checked })} className="mt-1 h-4 w-4 shrink-0 accent-amber-400"/>
        <span className="min-w-0">
          {t("resumoPorEmail.automatico")}
          <span className="mt-0.5 block text-xs text-white/45">{t("resumoPorEmail.automaticoAjuda")}</span>
        </span>
      </label>
    </div>;
}
