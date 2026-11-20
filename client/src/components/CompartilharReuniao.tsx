import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Link2, Loader2, LockKeyhole, LockKeyholeOpen, Mail, MessageCircle, Share2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { LANGUAGES } from "@/i18n";
import { VERSAO_DA_AUTORIZACAO_COM_NOMES } from "@shared/const";
import { rotaDaReuniaoAberta } from "@shared/rotas";

/**
 * Compartilhar a reunião por link (pedido do Roberto em 12/11/2026, "por
 * enquanto"): a dona liga o link aberto de uma reunião pronta e o manda por
 * WhatsApp, por e-mail ou copiando. Quem recebe ouve a gravação, lê a
 * transcrição e pergunta à IA sem conta na WRW (pages/ReuniaoAberta.tsx).
 *
 * Desde a H3b (decisão do Roberto de 16/11/2026), quem recebe vê também os
 * nomes que a dona der às vozes. A caixa de confirmação fala deles e vai com a
 * versão 2. O link ligado antes, com a caixa que não falava dos nomes, segue
 * com "Falante n", e o painel avisa a dona que tem nomes: para mostrá-los, ela
 * desliga e liga de novo.
 *
 * Desde a H23 (HN-57 do HiNoter), a dona escolhe ao ligar se o link pede uma
 * senha de 6 dígitos (marcado de início) e se leva o áudio, e muda as duas
 * coisas com o link ligado. A senha vem do servidor e aparece uma vez só, na
 * hora de criar ou trocar, com um texto pronto (o link e a senha) para colar
 * no WhatsApp ou no e-mail. Depois disso nem o servidor a tem em texto: para
 * ver uma senha, a dona troca. Os textos da H23 (meetings.share:
 * protectWithPassword, includeAudio, activeIntroWithPassword, passwordOn,
 * passwordOff, passwordOnce, passwordHint, messageWithPassword, audioOffHint e
 * as perguntas de trocar e tirar a senha) esperam a revisão da Cris, nos 10
 * idiomas.
 *
 * WhatsApp e e-mail abrem o app da própria dona com a mensagem pronta, e ela
 * escolhe para quem mandar: a WRW não envia nada em nome dela.
 */

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;
type IdiomaDaTela = "pt-BR" | "en" | "es" | "fr" | "de" | "ar" | "zh" | "hi" | "ja" | "ru";

// O idioma RESOLVIDO, como em ReuniaoComIA.tsx: "en-US" cai fora da lista.
function idiomaDaTela(i18n: { resolvedLanguage?: string; language: string }): IdiomaDaTela {
  const atual = i18n.resolvedLanguage ?? i18n.language;
  return (LANGUAGES.some(idioma => idioma.code === atual) ? atual : "pt-BR") as IdiomaDaTela;
}

/** O endereço completo do link, no domínio em que a dona está. */
export function enderecoDoLinkAberto(token: string, origem: string = window.location.origin) {
  return `${origem}${rotaDaReuniaoAberta(token)}`;
}

/** A mensagem pronta para o WhatsApp: o app escolhe o contato, a mensagem já vai escrita. */
export function linkDoWhatsApp(mensagem: string) {
  return `https://wa.me/?text=${encodeURIComponent(mensagem)}`;
}

/** O e-mail pronto no app de e-mail da dona, sem destinatário: ela escolhe. */
export function linkDoEmail(assunto: string, corpo: string) {
  return `mailto:?subject=${encodeURIComponent(assunto)}&body=${encodeURIComponent(corpo)}`;
}

// O código tRPC decide a frase: as mensagens do servidor vêm em português.
function mensagemDoErro(t: TranslateFn, erro: unknown) {
  switch ((erro as { data?: { code?: string } } | null)?.data?.code) {
    case "PRECONDITION_FAILED": return t("meetings.share.onlyReady");
    case "NOT_FOUND": return t("meetings.meetingNotFound");
    case "INTERNAL_SERVER_ERROR": return mensagemDeErroParaTela(erro, t);
    default: return t("meetings.share.error");
  }
}

// As mudanças no link ligado (H23): aqui o PRECONDITION_FAILED é o link que
// outra aba desligou, e o teto das senhas novas tem frase própria.
function mensagemDoErroNoLinkLigado(t: TranslateFn, erro: unknown) {
  switch ((erro as { data?: { code?: string } } | null)?.data?.code) {
    case "PRECONDITION_FAILED": return t("meetings.share.linkOff");
    case "TOO_MANY_REQUESTS": return t("meetings.share.tooManyPasswords");
    default: return mensagemDoErro(t, erro);
  }
}

/** Copia o texto; sem permissão (ou fora de HTTPS), seleciona o campo para a dona copiar à mão. */
async function copiarOuSelecionar(texto: string, campo: HTMLInputElement | HTMLTextAreaElement | null, avisos: { copiado: string; selecionado: string }) {
  try {
    await navigator.clipboard.writeText(texto);
    toast.success(avisos.copiado);
  } catch {
    campo?.select();
    toast.message(avisos.selecionado);
  }
}

type Confirmacao = "desligar" | "trocarSenha" | "tirarSenha";

export function CompartilharReuniao({ meetingId, titulo, token, linkMostraNomes = false, temNomes = false, comSenha = false, comAudio = true }: {
  meetingId: string;
  titulo: string;
  token: string | null;
  /** O link ligado mostra os nomes das vozes: foi ligado com a confirmação que fala deles (meeting.linkMostraNomes). */
  linkMostraNomes?: boolean;
  /** A dona já deu nome a alguma voz desta reunião. */
  temNomes?: boolean;
  /** O link ligado pede a senha de 6 dígitos (meeting.linkComSenha, H23). */
  comSenha?: boolean;
  /** O link ligado leva o áudio e o player (meeting.linkComAudio, H23). */
  comAudio?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  const idDoTextoPronto = useId();
  const campo = useRef<HTMLInputElement>(null);
  const textoPronto = useRef<HTMLTextAreaElement>(null);
  const botaoCompartilhar = useRef<HTMLButtonElement>(null);
  // O foco vai ao que aparece no lugar do botão clicado, que some da página:
  // ao campo do link quando a dona liga, ao "Compartilhar" quando desliga.
  // Só na troca que ela disparou, nunca ao abrir uma página que já tem link.
  const focarDepois = useRef<"campo" | "compartilhar" | null>(null);
  // A senha nova aparece com o texto pronto, que recebe o foco: o leitor de
  // tela lê o texto inteiro, com o link e a senha. No link recém-criado, o
  // texto só existe quando o token chega do detalhe relido, depois da senha:
  // o pedido de foco fica guardado até lá.
  const focarTextoPronto = useRef(false);
  // Ligar pede um passo a mais: a confirmação de que as pessoas autorizaram,
  // e as escolhas do link (H23): a senha vem marcada, e o áudio também.
  const [pedindo, setPedindo] = useState(false);
  const [autorizou, setAutorizou] = useState(false);
  const [protegerComSenha, setProtegerComSenha] = useState(true);
  const [incluirAudio, setIncluirAudio] = useState(true);
  const [confirmar, setConfirmar] = useState<Confirmacao | null>(null);
  // A senha que o servidor acabou de gerar: só aqui, na memória da tela, até a
  // dona fechar o quadro ou sair da página.
  const [senhaNova, setSenhaNova] = useState<string | null>(null);

  // O que mudou entra na tela na hora, e a releitura confirma com o servidor.
  // Este painel sempre liga com a confirmação que fala dos nomes: ligado por
  // aqui, o link mostra os nomes; desligado, não mostra nada.
  const atualizarLink = (mudanca: { shareToken?: string | null; linkMostraNomes?: boolean; linkComSenha?: boolean; linkComAudio?: boolean }) => {
    utils.meetings.get.setData({ meetingId }, anterior => anterior && { ...anterior, meeting: { ...anterior.meeting, ...mudanca } });
    void utils.meetings.get.invalidate({ meetingId });
  };
  // Ligado, o link fica como a dona escolheu; desligado, sem senha, e o áudio
  // fica como a releitura disser (sem link, ele não aparece).
  const trocarToken = (novo: string | null, opcoes?: { comSenha: boolean; comAudio: boolean }) =>
    atualizarLink({
      shareToken: novo, linkMostraNomes: novo !== null, linkComSenha: novo !== null && !!opcoes?.comSenha,
      ...(opcoes ? { linkComAudio: opcoes.comAudio } : {}),
    });

  const ligar = trpc.meetings.ligarLinkAberto.useMutation({
    onSuccess: ({ token: novo, senha }, pedido) => {
      setPedindo(false);
      setAutorizou(false);
      focarDepois.current = senha ? null : "campo";
      focarTextoPronto.current = !!senha;
      setSenhaNova(senha ?? null);
      // Sem senha na resposta, ou o link saiu sem ela, ou já estava ligado (outra
      // aba): a releitura diz como ele está.
      trocarToken(novo, { comSenha: !!senha, comAudio: pedido?.incluirAudio !== false });
      toast.success(t("meetings.share.created"));
    },
    onError: erro => toast.error(mensagemDoErro(t, erro)),
  });
  const desligar = trpc.meetings.desligarLinkAberto.useMutation({
    onSuccess: () => {
      setConfirmar(null);
      setSenhaNova(null);
      focarDepois.current = "compartilhar";
      trocarToken(null);
      toast.success(t("meetings.share.turnedOff"));
    },
    onError: erro => toast.error(mensagemDoErro(t, erro)),
  });
  const novaSenha = trpc.meetings.novaSenhaDoLink.useMutation({
    onSuccess: ({ senha }) => {
      setConfirmar(null);
      focarTextoPronto.current = true;
      setSenhaNova(senha);
      atualizarLink({ linkComSenha: true });
      toast.success(t("meetings.share.passwordCreated"));
    },
    onError: erro => toast.error(mensagemDoErroNoLinkLigado(t, erro)),
  });
  const tirarSenha = trpc.meetings.tirarSenhaDoLink.useMutation({
    onSuccess: () => {
      setConfirmar(null);
      setSenhaNova(null);
      atualizarLink({ linkComSenha: false });
      toast.success(t("meetings.share.passwordRemoved"));
    },
    onError: erro => toast.error(mensagemDoErroNoLinkLigado(t, erro)),
  });
  const mudarAudio = trpc.meetings.mudarAudioDoLink.useMutation({
    onSuccess: (_resposta, pedido) => {
      atualizarLink({ linkComAudio: pedido.incluirAudio });
      toast.success(pedido.incluirAudio ? t("meetings.share.audioOn") : t("meetings.share.audioOff"));
    },
    onError: erro => toast.error(mensagemDoErroNoLinkLigado(t, erro)),
  });

  useEffect(() => {
    const alvo = focarDepois.current;
    if (!alvo) return;
    focarDepois.current = null;
    (alvo === "campo" ? campo.current : botaoCompartilhar.current)?.focus();
  }, [token]);
  useEffect(() => {
    if (!focarTextoPronto.current || !textoPronto.current) return;
    focarTextoPronto.current = false;
    textoPronto.current.focus();
  }, [senhaNova, token]);

  if (!token) {
    return <section aria-labelledby="compartilhar-reuniao" className="mb-6 rounded-2xl border border-white/10 bg-white/[0.035] p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="compartilhar-reuniao" className="inline-flex items-center gap-2 text-base font-semibold"><Share2 size={16} className="text-amber-300"/>{t("meetings.share.title")}</h2>
          <p className="mt-1 text-sm text-white/55">{t("meetings.share.intro")}</p>
          {/* O link mostra também o resumo (H4) como a dona o deixar, com o que ela escrever (H4f), e o mapa mental (H10). */}
          <p className="mt-1 text-sm text-white/55">{t("meetings.share.summaryNotice")}</p>
        </div>
        {!pedindo && <button ref={botaoCompartilhar} type="button" onClick={() => setPedindo(true)}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-amber-300/40 px-4 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-300/10">
          <Link2 size={15}/> {t("meetings.share.button")}
        </button>}
      </div>
      {pedindo && <div className="mt-4 space-y-3">
        <label className="flex items-start gap-3 text-sm text-white/75">
          {/* Só monta depois de "Compartilhar": o foco vem para cá, e não para o <body>. */}
          <input type="checkbox" autoFocus checked={autorizou} onChange={evento => setAutorizou(evento.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-amber-400"/>
          <span>{t("meetings.share.authorization")}</span>
        </label>
        {/* As escolhas do link (H23): a senha de 6 dígitos e o áudio. */}
        <label className="flex items-start gap-3 text-sm text-white/75">
          <input type="checkbox" checked={protegerComSenha} onChange={evento => setProtegerComSenha(evento.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-amber-400"/>
          <span>{t("meetings.share.protectWithPassword")}</span>
        </label>
        <label className="flex items-start gap-3 text-sm text-white/75">
          <input type="checkbox" checked={incluirAudio} onChange={evento => setIncluirAudio(evento.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-amber-400"/>
          <span>{t("meetings.share.includeAudio")}</span>
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!autorizou || ligar.isPending} onClick={() => ligar.mutate({
            meetingId,
            autorizacaoDasPessoas: true,
            // A prova guarda a frase que a dona viu, o idioma dela e a versão
            // da caixa: a 2 fala dos nomes das vozes, e só com ela o link os mostra.
            idioma: idiomaDaTela(i18n),
            textoExibido: t("meetings.share.authorization"),
            versaoDaAutorizacao: VERSAO_DA_AUTORIZACAO_COM_NOMES,
            comSenha: protegerComSenha,
            incluirAudio,
          })}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-50">
            {ligar.isPending ? <Loader2 size={15} className="animate-spin"/> : <Link2 size={15}/>} {t("meetings.share.createButton")}
          </button>
          <button type="button" onClick={() => { setPedindo(false); setAutorizou(false); setProtegerComSenha(true); setIncluirAudio(true); }} disabled={ligar.isPending}
            className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/65 hover:bg-white/5 disabled:opacity-50">
            {t("meetings.share.cancel")}
          </button>
        </div>
      </div>}
    </section>;
  }

  const endereco = enderecoDoLinkAberto(token);
  const mensagem = t("meetings.share.message", { title: titulo, url: endereco });
  const assunto = t("meetings.share.emailSubject", { title: titulo });
  // O texto pronto (H23): o link e a senha, para colar no WhatsApp ou no e-mail.
  const mensagemComSenha = senhaNova ? t("meetings.share.messageWithPassword", { title: titulo, url: endereco, password: senhaNova }) : null;
  const mudando = novaSenha.isPending || tirarSenha.isPending || desligar.isPending;

  // A pergunta de confirmação, para desligar o link e para trocar ou tirar a
  // senha: o "Manter", a saída segura, recebe o foco, e a pergunta vai junto no anúncio.
  const perguntas: Record<Confirmacao, { pergunta: string; sim: string; fazer: () => void; perigosa: boolean }> = {
    desligar: { pergunta: t("meetings.share.turnOffConfirm"), sim: t("meetings.share.turnOffYes"), fazer: () => desligar.mutate({ meetingId }), perigosa: true },
    trocarSenha: { pergunta: t("meetings.share.changePasswordConfirm"), sim: t("meetings.share.changePasswordYes"), fazer: () => novaSenha.mutate({ meetingId }), perigosa: false },
    tirarSenha: { pergunta: t("meetings.share.removePasswordConfirm"), sim: t("meetings.share.removePasswordYes"), fazer: () => tirarSenha.mutate({ meetingId }), perigosa: true },
  };
  const confirmacao = confirmar && perguntas[confirmar];
  const caixaDeConfirmacao = confirmacao && <div className="space-y-2">
    <p id="confirmar-mudanca-no-link" className="text-sm text-amber-100/85">{confirmacao.pergunta}</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={confirmacao.fazer} disabled={mudando}
        className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50 ${confirmacao.perigosa ? "bg-red-500 text-white hover:bg-red-400" : "bg-[#c98f70] text-[#1a120c] hover:bg-[#efcba8]"}`}>
        {mudando && <Loader2 size={15} className="animate-spin"/>} {confirmacao.sim}
      </button>
      <button type="button" autoFocus aria-describedby="confirmar-mudanca-no-link" onClick={() => setConfirmar(null)} disabled={mudando}
        className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/65 hover:bg-white/5 disabled:opacity-50">
        {t("meetings.share.turnOffCancel")}
      </button>
    </div>
  </div>;

  return <section aria-labelledby="compartilhar-reuniao" className="mb-6 rounded-2xl border border-amber-300/25 bg-amber-300/[0.06] p-5">
    <h2 id="compartilhar-reuniao" className="inline-flex items-center gap-2 text-base font-semibold text-amber-100"><Share2 size={16}/>{t("meetings.share.activeTitle")}</h2>
    <p className="mt-1 text-sm text-white/60">{comSenha ? t("meetings.share.activeIntroWithPassword") : t("meetings.share.activeIntro")}</p>
    {/* O link da caixa antiga não mostra os nomes: só o aviso diz à dona como mostrá-los. */}
    {temNomes && !linkMostraNomes && <p className="mt-3 rounded-xl border border-amber-300/30 bg-black/20 px-3 py-2 text-sm text-amber-100/85">{t("meetings.share.namesNeedRelink")}</p>}
    {/* Endereço é sempre da esquerda para a direita, também numa tela em árabe. */}
    <input ref={campo} readOnly dir="ltr" value={endereco} aria-label={t("meetings.share.linkLabel")} onFocus={evento => evento.currentTarget.select()}
      className="mt-4 w-full rounded-xl border border-white/15 bg-black/20 px-4 py-2.5 text-sm text-white/85 outline-none focus:border-amber-300"/>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" onClick={() => void copiarOuSelecionar(endereco, campo.current, { copiado: t("meetings.share.copied"), selecionado: t("meetings.share.copyFallback") })}
        className="inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8]">
        <Copy size={15}/> {t("meetings.share.copy")}
      </button>
      <a href={linkDoWhatsApp(mensagem)} target="_blank" rel="noopener noreferrer"
        className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm text-white/85 hover:bg-white/5">
        <MessageCircle size={15}/> {t("meetings.share.whatsapp")}
      </a>
      <a href={linkDoEmail(assunto, mensagem)}
        className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm text-white/85 hover:bg-white/5">
        <Mail size={15}/> {t("meetings.share.email")}
      </a>
    </div>

    {/* A senha que acabou de sair, uma vez só, com o texto pronto (H23). */}
    {senhaNova && mensagemComSenha && <div className="mt-4 rounded-xl border border-amber-300/40 bg-black/25 p-4">
      <p className="text-sm font-semibold text-amber-100">{t("meetings.share.passwordTitle")}</p>
      <p dir="ltr" className="mt-1 font-mono text-2xl tracking-[0.3em] text-white">{senhaNova}</p>
      <p className="mt-1 text-xs text-white/60">{t("meetings.share.passwordOnce")}</p>
      <label htmlFor={idDoTextoPronto} className="mt-3 block text-sm text-white/75">{t("meetings.share.readyText")}</label>
      <textarea id={idDoTextoPronto} ref={textoPronto} readOnly dir="auto" rows={4} value={mensagemComSenha} onFocus={evento => evento.currentTarget.select()}
        className="mt-1 w-full resize-none rounded-xl border border-white/15 bg-black/20 px-3 py-2 text-sm text-white/85 outline-none focus:border-amber-300"/>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => void copiarOuSelecionar(mensagemComSenha, textoPronto.current, { copiado: t("meetings.share.textCopied"), selecionado: t("meetings.share.textCopyFallback") })}
          className="inline-flex items-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8]">
          <Copy size={15}/> {t("meetings.share.copyText")}
        </button>
        <a href={linkDoWhatsApp(mensagemComSenha)} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm text-white/85 hover:bg-white/5">
          <MessageCircle size={15}/> {t("meetings.share.whatsapp")}
        </a>
        <a href={linkDoEmail(assunto, mensagemComSenha)}
          className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm text-white/85 hover:bg-white/5">
          <Mail size={15}/> {t("meetings.share.email")}
        </a>
        <button type="button" onClick={() => setSenhaNova(null)}
          className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/65 hover:bg-white/5">
          {t("meetings.share.passwordDone")}
        </button>
      </div>
    </div>}

    {/* A senha e o áudio do link ligado (H23). */}
    <div className="mt-4 space-y-3 border-t border-white/10 pt-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-start gap-2 text-sm text-white/75">
          {comSenha ? <LockKeyhole size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-amber-300"/> : <LockKeyholeOpen size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-white/50"/>}
          <span>{comSenha ? t("meetings.share.passwordOn") : t("meetings.share.passwordOff")}</span>
        </p>
        {confirmar !== "trocarSenha" && confirmar !== "tirarSenha" && <div className="flex flex-wrap gap-2">
          {comSenha ? <>
            <button type="button" onClick={() => setConfirmar("trocarSenha")} disabled={mudando}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/85 hover:bg-white/5 disabled:opacity-50">{t("meetings.share.changePassword")}</button>
            <button type="button" onClick={() => setConfirmar("tirarSenha")} disabled={mudando}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/65 hover:bg-white/5 disabled:opacity-50">{t("meetings.share.removePassword")}</button>
          </> : <button type="button" onClick={() => novaSenha.mutate({ meetingId })} disabled={mudando}
            className="inline-flex items-center gap-2 rounded-lg border border-amber-300/40 px-3 py-1.5 text-sm font-semibold text-amber-200 hover:bg-amber-300/10 disabled:opacity-50">
            {novaSenha.isPending && <Loader2 size={14} className="animate-spin"/>}{t("meetings.share.addPassword")}
          </button>}
        </div>}
      </div>
      {comSenha && !senhaNova && <p className="text-xs text-white/50">{t("meetings.share.passwordHint")}</p>}
      {(confirmar === "trocarSenha" || confirmar === "tirarSenha") && caixaDeConfirmacao}
      <label className="flex items-start gap-3 text-sm text-white/75">
        <input type="checkbox" checked={comAudio} disabled={mudarAudio.isPending} onChange={evento => mudarAudio.mutate({ meetingId, incluirAudio: evento.target.checked })}
          className="mt-1 h-4 w-4 shrink-0 accent-amber-400"/>
        <span>{t("meetings.share.includeAudio")}</span>
      </label>
      {!comAudio && <p className="text-xs text-white/50">{t("meetings.share.audioOffHint")}</p>}
    </div>

    <div className="mt-4 border-t border-white/10 pt-3">
      {confirmar === "desligar" ? caixaDeConfirmacao : <button type="button" onClick={() => setConfirmar("desligar")} className="text-sm text-red-200/80 underline-offset-2 hover:underline">
        {t("meetings.share.turnOff")}
      </button>}
    </div>
  </section>;
}
