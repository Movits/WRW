import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useRoute, useSearch } from "wouter";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Check, CircleAlert, Clock3, FileText, Loader2, Mic, Pause, Play, Plus, RefreshCw, Square, Trash2, Users, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { LANGUAGES } from "@/i18n";
import { AppHeader } from "@/components/AppHeader";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { mensagemDaRecusaDaParte, traduzirMensagemDoServidor } from "@/lib/mensagem-de-erro";
import { PessoaSugeridaNaReuniao } from "@/components/PessoaSugeridaNaReuniao";
import { PergunteAReuniao } from "@/components/ReuniaoComIA";
import { ResumoGuardado } from "@/components/ResumoGuardado";
import { CompartilharReuniao } from "@/components/CompartilharReuniao";
import { DicaDeInstalacao } from "@/components/DicaDeInstalacao";
import type { ControleDoPlayer } from "@/components/PlayerDasPartes";
import { BarraDoPlayer, ESPACO_DA_BARRA_DO_PLAYER } from "@/components/BarraDoPlayer";
import { mmss, segmentosValidos, TranscricaoPorFalante } from "@/components/TranscricaoPorFalante";
import { AvisoDeHoraDeGravacao, ID_DO_AVISO_PAROU_SOZINHA } from "@/components/AvisoDeHoraDeGravacao";
import { ID_DO_AVISO_DO_DESCARTE_PENDENTE } from "@/components/RetomadaDosDescartes";
import { ID_DO_AVISO_DA_PARTE_RECUSADA } from "@/components/RetomadaDasPartes";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { segmentarTranscricao, TIPOS_DE_ENTIDADE, type TipoEntidade } from "@/lib/transcricao-destacada";
import { lerDuracaoNoNavegador } from "@/lib/duracao-no-navegador";
import type { TipoDeAudioGravado } from "@/lib/formato-de-audio";
import { gravacaoDeAudioSuportada, pausaSuportada, useGravadorDeAudio } from "@/hooks/useGravadorDeAudio";
import { useNovaTentativa } from "@/hooks/useNovaTentativa";
import { useTelaAcesa } from "@/hooks/useTelaAcesa";
import { PARTE_SEGUNDOS, useGravacaoEmPartes } from "@/hooks/useGravacaoEmPartes";
import { ocupar, useOcupacao } from "@/lib/sessao-ocupada";
import { CODIGO_ERRO_INTERROMPIDO, ENVIO_UNICO_BYTES_MAX, ENVIO_UNICO_SEGUNDOS_MAX, GRAVACAO_EM_PARTES_SEGUNDOS_MAX, margemDoReprocesso, MENSAGEM_AUDIO_GUARDADO_AUSENTE, nomesDosFalantes, TITULO_DA_REUNIAO_MAX, TITULO_DA_REUNIAO_MIN } from "@shared/const";
import { ROTA_DAS_REUNIOES, ROTA_GRAVAR, rotaDaReuniao } from "@shared/rotas";
import { IDIOMA_DA_REUNIAO_PADRAO, idiomaDaReuniao, type IdiomaDaReuniao } from "@shared/idioma-da-reuniao";
import { VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";

// O relógio do gravador e a duração da reunião no formato da transcrição: a
// gravação em partes passa de uma hora, e 1 h é 1:00:00, não 60:00.
const formatDuration = mmss;
/** As horas do teto técnico da gravação em partes (12), para os textos. */
const HORAS_DA_GRAVACAO_EM_PARTES = GRAVACAO_EM_PARTES_SEGUNDOS_MAX / 3600;
/** O id fixo do aviso das 12 h: a gravação seguinte o fecha por ele (toast.dismiss). */
const ID_DO_AVISO_DO_LIMITE = "gravacao-chegou-ao-limite";
/**
 * Os ids fixos dos avisos da gravação em partes que ficam até ser fechados
 * (G13b): a cópia no aparelho que faltou e a gravação encerrada ao sair da
 * tela. Os outros dois vivem com as retomadas de toda a sessão, que também os
 * abrem ou fecham: o da parte recusada (ID_DO_AVISO_DA_PARTE_RECUSADA, em que
 * a recusa seguinte troca o texto, sem empilhar) e o do descarte que não
 * terminou (ID_DO_AVISO_DO_DESCARTE_PENDENTE). A gravação seguinte fecha
 * todos, que falam da anterior.
 */
const ID_DO_AVISO_SEM_COPIA = "gravacao-sem-copia-no-aparelho";
const ID_DO_AVISO_ENCERRADA_AO_SAIR = "gravacao-encerrada-ao-sair";

/**
 * O modo do gravador, pela busca da URL do /gravar (G13b). A gravação em partes
 * é o padrão para todas; `?envioUnico=1` é a saída de suporte até a G14: o
 * envio único de antes, inteiro num pedido só, com 10 minutos e 10 MB.
 * `?emPartes=1`, o interruptor da G9, continua aceito e não muda nada.
 */
function gravaEmPartes(busca: string) {
  return new URLSearchParams(busca).get("envioUnico") !== "1";
}

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

function statusLabel(t: TranslateFn, status: string) {
  return ({ draft: t("meetings.statusDraft"), recording: t("meetings.statusRecording"), processing: t("meetings.statusProcessing"), ready: t("meetings.statusReady"), failed: t("meetings.statusFailed"), deleted: t("meetings.statusDeleted"), uploading: t("meetings.statusUploading") } as Record<string, string>)[status] ?? status;
}

function statusClass(status: string) {
  return ({ ready: "bg-emerald-400/15 text-emerald-300 border-emerald-400/20", processing: "bg-amber-400/15 text-amber-300 border-amber-400/20", failed: "bg-red-400/15 text-red-300 border-red-400/20" } as Record<string, string>)[status] ?? "bg-white/5 text-white/55 border-white/10";
}

function microphoneErrorMessage(t: TranslateFn, error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return t("meetings.micBlocked");
  if (name === "NotFoundError") return t("meetings.micNotFound");
  if (name === "NotReadableError") return t("meetings.micBusy");
  return t("meetings.micGenericError");
}

// O código tRPC do erro (data.code). Só o erro que o servidor devolveu tem um;
// o da rede, por exemplo, não.
function codigoDoErro(erro: unknown) {
  return (erro as { data?: { code?: string } } | null)?.data?.code;
}

// O código tRPC decide a frase: as mensagens do servidor vêm em português, e a
// tela fala o idioma da dona. Cada ramo chama t() com a chave literal, para o
// teste de chaves usadas conferir que todas existem.
function mensagemDoReprocesso(t: TranslateFn, erro: unknown) {
  switch (codigoDoErro(erro)) {
    case "CONFLICT": return t("meetings.reprocessConflict");
    case "PRECONDITION_FAILED": return t("meetings.reprocessUnavailable");
    case "TOO_MANY_REQUESTS": return t("meetings.reprocessTooMany");
    default: return t("meetings.reprocessError");
  }
}

// NOT_FOUND é definitivo: a reunião foi excluída (em outra aba, pelo app) ou
// não é da dona. Tentar de novo ou continuar consultando não a traz de volta.
function reuniaoNaoExiste(erro: unknown) {
  return codigoDoErro(erro) === "NOT_FOUND";
}

// BAD_REQUEST também é definitivo: o único dado da consulta é o id que veio na
// URL, então ele quer dizer um link cortado ou editado à mão
// (/meetings/8b1f6a2e-3c4d). A mensagem crua do zod é JSON em inglês.
function linkDeReuniaoInvalido(erro: unknown) {
  return codigoDoErro(erro) === "BAD_REQUEST";
}

// Os dois desfechos definitivos da consulta da reunião: reler não muda nenhum.
function erroDefinitivoDaReuniao(erro: unknown) {
  return reuniaoNaoExiste(erro) || linkDeReuniaoInvalido(erro);
}

// O mesmo desfecho do envio chega por dois caminhos: o fim do envio e o detalhe
// aberto, que vê o status mudar (a lista mostra a reunião durante o envio). Com o
// mesmo id, o sonner troca o aviso que já está na tela em vez de empilhar outro.
function avisoDaReuniao(desfecho: "processada" | "falhou", meetingId: string) {
  return { id: `reuniao-${desfecho}-${meetingId}` };
}

// A causa gravada pelo servidor, como a dona a lê. ERRO_INTERROMPIDO é um
// CÓDIGO gravado pela varredura de reuniões presas, não uma frase: o servidor
// não sabe o idioma da dona, então a tradução é aqui. A frase do áudio que
// sumiu do bucket vem em português do servidor e também é traduzida aqui, como
// as frases conhecidas do servidor (o erro de consulta ao banco, por exemplo),
// que também chegam pelo aviso do envio. As demais mensagens vêm em português,
// pensadas para a tela.
function causaDaFalha(t: TranslateFn, processingError: string | null | undefined) {
  if (processingError === CODIGO_ERRO_INTERROMPIDO) return t("meetings.processingInterrupted");
  if (processingError === MENSAGEM_AUDIO_GUARDADO_AUSENTE) return t("meetings.storedAudioMissing");
  return processingError ? traduzirMensagemDoServidor(processingError, t) : null;
}

function supportedAudioMime(file: File) {
  if (file.type === "audio/mpeg" || /\.mp3$/i.test(file.name)) return "audio/mpeg";
  if (file.type === "audio/ogg" || /\.ogg$/i.test(file.name)) return "audio/ogg";
  if (file.type === "audio/wav" || /\.wav$/i.test(file.name)) return "audio/wav";
  if (file.type === "audio/mp4" || /\.mp4$/i.test(file.name)) return "audio/mp4";
  if (file.type === "audio/m4a" || file.type === "audio/x-m4a" || /\.m4a$/i.test(file.name)) return "audio/m4a";
  if (file.type === "audio/webm" || /\.webm$/i.test(file.name)) return "audio/webm";
  return null;
}

function readAsDataUrl(t: TranslateFn, file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("meetings.audioReadError")));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

export default function Meetings() {
  const { t, i18n } = useTranslation();
  const [, navigate] = useLocation();
  // A URL escolhe o ramo (App.tsx monta esta página nas três rotas): /gravar é
  // o gravador, /meetings/:id o detalhe e /meetings a lista. Era estado interno
  // e tudo caía na lista: o voltar do celular saía da tela, recarregar perdia o
  // detalhe e não havia link para gravar nem para abrir uma reunião.
  const [naGravacao] = useRoute(ROTA_GRAVAR);
  const [, reuniaoAberta] = useRoute<{ id: string }>(`${ROTA_DAS_REUNIOES}/:id`);
  const utils = trpc.useUtils();
  // Enquanto alguma reunião processa (o reprocessamento roda em segundo plano),
  // a lista se atualiza sozinha a cada 10 s; sem nada processando, não consulta.
  const { data: meetings, isLoading, isError, error, refetch } = trpc.meetings.list.useQuery(undefined, {
    refetchInterval: consulta => consulta.state.data?.some(reuniao => reuniao.status === "processing") ? 10_000 : false,
  });
  const [title, setTitle] = useState("");
  const [consent, setConsent] = useState(false);
  // O idioma falado na reunião: a IA transcreve nele, e ele é o original da
  // tradução. Começa no idioma da tela de quem grava.
  const [idiomaFalado, setIdiomaFalado] = useState<IdiomaDaReuniao>(() => idiomaDaReuniao(i18n.resolvedLanguage ?? i18n.language) ?? IDIOMA_DA_REUNIAO_PADRAO);
  const [microphoneIssue, setMicrophoneIssue] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  // O Iniciar em curso (G13b, ver startRecording): o ref vale já no clique, e o
  // estado trava o botão e o formulário na tela.
  const iniciandoAgora = useRef(false);
  const [iniciando, setIniciando] = useState(false);
  const [capturedAudio, setCapturedAudio] = useState<{ blob: Blob; url: string; mimeType: TipoDeAudioGravado; durationSeconds: number } | null>(null);
  const audioInput = useRef<HTMLInputElement | null>(null);
  // true só enquanto ESTA instância está montada, visível e no gravador. O
  // naGravacao vem do useRoute, que casa como a rota (sem caixa e com barra
  // final opcional). É efeito de layout porque, na primeira ida a uma tela lazy
  // cujo código ainda não chegou (o Dashboard logo depois do login, que cai em
  // /gravar), o Suspense do App esconde esta página sem desmontá-la e limpa só
  // os efeitos de layout: com o efeito comum, o ref seguia true e o fim do
  // envio trocava a tela pedida pelo detalhe.
  const noGravadorAgora = useRef(false);
  useLayoutEffect(() => {
    noGravadorAgora.current = naGravacao;
    return () => { noGravadorAgora.current = false; };
  }, [naGravacao]);

  // O microfone, o formato (mp4 antes de webm) e o teto de duração ficam no hook.
  // Sair da página gravando fecha o microfone: o hook cuida disso ao desmontar
  // (em partes, entregando o que foi gravado; ver entregarAoSair, abaixo).
  // A gravação em partes (G9): enviada ao servidor por baixo, parte a parte, com
  // cópia no aparelho. Desde a G13b é o padrão para todas (gravaEmPartes, acima).
  // O modo é lido uma vez, na montagem: as três rotas são a mesma instância, e
  // trocar de modo no meio deixaria o gravador e o envio em modos diferentes.
  const emPartes = useRef(typeof window === "undefined" || gravaEmPartes(window.location.search)).current;
  const gravacaoEmPartes = useGravacaoEmPartes({
    ativo: emPartes,
    aoEncerrar: meetingId => {
      void utils.meetings.list.invalidate();
      setTitle("");
      setConsent(false);
      if (noGravadorAgora.current) navigate(rotaDaReuniao(meetingId), { replace: true });
    },
    aoFalhar: () => toast.error(t("meetings.sendRecordingError")),
    // O trecho que o servidor recusou de vez fica de fora da transcrição (G13b).
    // O servidor manda só o código; a frase sai no idioma da tela. O aviso fica
    // até ser fechado, porque quem grava pode não estar olhando.
    aoRecusarParte: codigo => toast.error(mensagemDaRecusaDaParte(codigo, t), { id: ID_DO_AVISO_DA_PARTE_RECUSADA, duration: Infinity, closeButton: true }),
    // Sem a cópia no aparelho, uma queda de rede perde o trecho que estava
    // subindo (G13b). O hook chama uma vez por gravação.
    aoFicarSemCopia: () => toast.warning(t("meetings.deviceCopyUnavailable"), { id: ID_DO_AVISO_SEM_COPIA, duration: Infinity, closeButton: true }),
    // O descarte guardado que a retomada terminou de excluir (G13b): o aviso de
    // que ele não tinha terminado deixa de valer.
    aoConcluirDescarte: () => toast.dismiss(ID_DO_AVISO_DO_DESCARTE_PENDENTE),
  });
  const gravador = useGravadorDeAudio({
    // Em partes (G13a), sem o teto de 10 min: o aviso de hora pede o OK a cada
    // hora cheia, e as 12 h são só o teto técnico. O envio único segue nos 10 min.
    limiteSegundos: emPartes ? GRAVACAO_EM_PARTES_SEGUNDOS_MAX : ENVIO_UNICO_SEGUNDOS_MAX,
    // A gravação em partes que bate nas 12 h para e entrega como no Encerrar; o
    // aviso fica até ser fechado, porque quem gravou pode não estar olhando. Sem
    // prazo, leva o botão de fechar (sem ele, só saía arrastando).
    aoChegarAoLimite: emPartes ? () => toast.info(t("meetings.recordingMaxReached", { horas: HORAS_DA_GRAVACAO_EM_PARTES }), { id: ID_DO_AVISO_DO_LIMITE, duration: Infinity, closeButton: true }) : undefined,
    fatiaSegundos: emPartes ? PARTE_SEGUNDOS : undefined,
    aoFecharParte: emPartes ? gravacaoEmPartes.receberParte : undefined,
    // Sair da tela gravando (G13b): em partes, o desmonte para e entrega pelo
    // caminho do Encerrar — a última parte sobe, o fim é declarado (ou guardado
    // para a retomada) e o microfone é solto —, porque as partes anteriores já
    // estão no servidor. O aviso fica até ser fechado: a dona já está em outra
    // tela. No envio único, o desmonte descarta, como antes. E também no fim da
    // sessão (o Sair, excluir a conta), que zera a conta no cache antes de a
    // página sair: no diálogo do Sair a dona aceitou perder o áudio, e o envio
    // reabriria a sessão ocupada (o navegador perguntaria na ida ao login).
    entregarAoSair: emPartes ? () => Boolean(utils.auth.me.getData()) : false,
    aoEntregarAoSair: () => toast.info(t("meetings.recordingEndedOnLeave"), { id: ID_DO_AVISO_ENCERRADA_AO_SAIR, duration: Infinity, closeButton: true }),
    bitsPorSegundo: 64_000,
    // Saiu do gravador enquanto o navegador pedia o microfone (o pedido de
    // permissão ainda aberto, por exemplo): solta e não grava. Vale para a
    // ida à lista ou a um detalhe na mesma instância e para o desmonte, porque
    // a limpeza do efeito do noGravadorAgora o zera nos dois casos.
    podeGravar: () => noGravadorAgora.current,
    aoTerminar: ({ blob, mimeType, duracaoMs }) => {
      // Em partes, a última já foi ao servidor por aoFecharParte: não há revisão.
      if (emPartes) return;
      if (!blob.size) {
        toast.error(t("meetings.noAudioGenerated"));
        return;
      }
      setCapturedAudio({
        blob,
        url: URL.createObjectURL(blob),
        mimeType,
        // O fim automático chega com atraso (aba em segundo plano, celular
        // lento), e o relógio passa do teto, que o servidor confere sem folga
        // na duração declarada: 601 s eram recusados. A duração medida nos
        // bytes, que é a que vale, tem a folga de 5 s.
        durationSeconds: Math.min(ENVIO_UNICO_SEGUNDOS_MAX, Math.max(1, Math.floor(duracaoMs / 1000))),
      });
    },
    // O pedido do microfone falhou (permissão negada, por exemplo). Se a dona
    // já saiu do gravador, o hook nem chama: nada de aviso fora dele, nem de
    // problema guardado para a próxima vez que ela voltar.
    aoFalhar: error => {
      const issue = microphoneErrorMessage(t, error);
      setMicrophoneIssue(issue);
      toast.error(issue);
    },
  });
  // Em gravação: gravando ou pausada (G10). A tela fica travada nos dois.
  const pausado = gravador.estado === "pausado";
  const recording = gravador.estado === "gravando" || pausado;
  // G10: a tela acesa enquanto grava (no celular, a tela que apaga bloqueia o
  // aparelho, e no iPhone o bloqueio corta o microfone).
  const telaAcesa = useTelaAcesa(recording);
  // Pedindo o microfone ou fechando o arquivo, o gravador fica travado como no envio.
  const gravadorOcupado = gravador.estado === "pedindoMicrofone" || gravador.estado === "finalizando";
  // O áudio gravado e ainda não enviado só existe nesta aba: a sessão fica ocupada
  // (lib/sessao-ocupada.ts) até ele ir ao servidor ou ser descartado, e o Sair e o
  // fechar da aba pedem confirmação. A gravação, o hook do gravador já ocupa; o
  // envio ocupa à parte (ver processCapturedAudio).
  useOcupacao("audio-nao-enviado", capturedAudio !== null);
  // Com a gravação em curso a tela fica no gravador, mesmo que a URL tenha saído
  // de /gravar (ver o efeito que devolve a URL, mais abaixo).
  const screen = naGravacao || recording ? "new" : reuniaoAberta ? "detail" : "list";

  const createMeeting = trpc.meetings.create.useMutation();
  const submitRecording = trpc.meetings.submitRecording.useMutation({
    onSuccess: async (_dados, variaveis) => {
      // A lista pode estar aberta: a dona vai a ela pelo menu durante o envio, e
      // ela foi lida com a reunião ainda em 'recording', estado em que não se
      // consulta sozinha. Sem esta releitura, a lista aberta não mostra o desfecho.
      await utils.meetings.list.invalidate();
      toast.success(t("meetings.processedSuccess"), avisoDaReuniao("processada", variaveis.meetingId));
      // O gravador recomeça vazio: sem isto, "Nova reunião" reabria o áudio já
      // enviado, e um segundo toque duplicava a reunião.
      discardCapturedAudio();
      setTitle("");
      setConsent(false);
      // Só leva ao detalhe quem continua no gravador desta mesma tela. O
      // onSuccess roda mesmo com a página desmontada, e o processamento leva
      // minutos: quem saiu, ou já abriu outro gravador para a reunião seguinte,
      // não é arrastada de volta. O replace troca a entrada do gravador pela do
      // detalhe; as que a volta ao gravador empilha durante a gravação (cada
      // toque no menu Reuniões) continuam embaixo.
      if (noGravadorAgora.current) navigate(rotaDaReuniao(variaveis.meetingId), { replace: true });
    },
    // Em falha também, pelo mesmo motivo do onSuccess: a lista aberta durante o
    // envio não mostra o desfecho sem esta releitura (quem chega à lista depois
    // já relê, pelo efeito da tela anterior ou pelo remonte). Se o servidor
    // chegou a processar o áudio, a reunião ficou 'failed', com
    // o Reprocessar no detalhe (no CONFLICT, outra execução segue com ela). Se o
    // envio parou antes disso (rede, deploy, sessão vencida, entrada recusada),
    // ela continua em "Gravação pendente": a varredura do servidor só encerra
    // as que ficaram em 'processing'.
    onError: (error, variaveis) => {
      // As frases conhecidas do servidor (banco fora do ar, sessão vencida...)
      // saem no idioma da tela; as demais, como vieram.
      toast.error(traduzirMensagemDoServidor(error.message, t) || t("meetings.processError"), avisoDaReuniao("falhou", variaveis.meetingId));
      void utils.meetings.list.invalidate();
    },
    // O detalhe dessa reunião pode já estar aberto (a lista mostra a reunião
    // durante o envio): nos dois desfechos ele se relê e mostra o status que o
    // servidor gravou (fica em "gravação pendente" se o envio parou antes de o
    // servidor processar o áudio, como diz o onError).
    // As pendências de Tenho/Preciso lidas no meio do envio vieram vazias: o
    // reset as tira da tela ("carregando", e não FALTANDO) e relê.
    onSettled: (_dados, _erro, variaveis) => {
      void utils.meetings.get.invalidate({ meetingId: variaveis.meetingId });
      void utils.networkInteligente.pendencias.reset({ meetingId: variaveis.meetingId });
    },
  });

  // As três rotas de Reuniões montam a MESMA instância desta página (App.tsx):
  // ir de /gravar para /meetings ou /meetings/:id (o item Reuniões do menu, ou o
  // voltar do navegador que cai numa delas) não desmonta o gravador. Com a
  // gravação em curso, a URL volta para /gravar e a tela continua nele: sem
  // isto, a lista aparecia e o microfone seguia gravando escondido. Qualquer
  // outro destino (os outros itens do menu, o logo, a seta, o avatar, o sino, o
  // voltar que sai de Reuniões) desmonta a página sem perguntar: em partes, a
  // gravação para e é entregue como no Encerrar, com um aviso (G13b,
  // entregarAoSair); no envio único, é descartada, como antes. A sessão ocupada
  // (lib/sessao-ocupada.ts) confirma só o Sair da conta e o fechar ou recarregar
  // da aba.
  useEffect(() => {
    if (!recording || naGravacao) return;
    navigate(ROTA_GRAVAR, { replace: true });
    // Um aviso só, com o mesmo id, mesmo com vários toques no menu ou no voltar.
    toast.info(t("meetings.stopRecordingToLeave"), { id: "gravacao-em-curso" });
  }, [recording, naGravacao]);

  // A página não remonta entre as três rotas, e criar a reunião não relê a lista:
  // quem chega à lista vinda do gravador ou de um detalhe vê o estado atual,
  // inclusive a reunião que acabou de enviar e ainda processa.
  const telaAnterior = useRef(screen);
  useEffect(() => {
    if (screen === "list" && telaAnterior.current !== "list") void utils.meetings.list.invalidate();
    telaAnterior.current = screen;
  }, [screen]);

  // A regra do servidor (meetings.create): de 2 a 200 caracteres depois do trim.
  // Fora dela, o create voltava BAD_REQUEST do zod, em inglês; no envio de
  // arquivo, depois de ler o áudio inteiro.
  function avisoDoTitulo(): string | null {
    const limpo = title.trim();
    if (!limpo) return t("meetings.titleRequired");
    if (limpo.length < TITULO_DA_REUNIAO_MIN || limpo.length > TITULO_DA_REUNIAO_MAX) {
      return t("meetings.titleLength", { min: TITULO_DA_REUNIAO_MIN, max: TITULO_DA_REUNIAO_MAX });
    }
    return null;
  }

  async function startRecording() {
    // Um início por vez (G13b): em partes, o Iniciar espera o servidor criar a
    // reunião, e o duplo clique criava duas; o segundo começo falhava e apagava
    // a reunião da gravação em curso, que perdia as partes. O ref barra o
    // segundo clique no mesmo instante; o estado trava o botão na tela.
    if (iniciandoAgora.current) return;
    const avisoTitulo = avisoDoTitulo();
    if (avisoTitulo) return toast.error(avisoTitulo);
    if (!consent) return toast.error(t("meetings.consentRequiredRecording"));
    if (!gravacaoDeAudioSuportada()) return toast.error(t("meetings.recordingUnsupported"));
    setMicrophoneIssue(null);
    iniciandoAgora.current = true;
    setIniciando(true);
    try {
      let reuniao: string | null = null;
      if (emPartes) {
        // Os avisos que ficam até ser fechados falam da gravação anterior: na
        // nova, pareceriam ser dela. Só a gravação em partes os cria: os das 12 h
        // e da hora sem OK (G13a), e os da parte recusada, da cópia que faltou,
        // do descarte que não terminou e da gravação encerrada ao sair (G13b). O
        // descarte que não terminou segue ocupando a sessão até a retomada
        // terminá-lo: o Sair e o fechar da aba ainda perguntam.
        toast.dismiss(ID_DO_AVISO_DO_LIMITE);
        toast.dismiss(ID_DO_AVISO_PAROU_SOZINHA);
        toast.dismiss(ID_DO_AVISO_DA_PARTE_RECUSADA);
        toast.dismiss(ID_DO_AVISO_SEM_COPIA);
        toast.dismiss(ID_DO_AVISO_DO_DESCARTE_PENDENTE);
        toast.dismiss(ID_DO_AVISO_ENCERRADA_AO_SAIR);
        try {
          reuniao = await gravacaoEmPartes.iniciar({ title: title.trim(), language: idiomaFalado, consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO });
        } catch (error) {
          toast.error((error instanceof Error && traduzirMensagemDoServidor(error.message, t)) || t("meetings.sendRecordingError"));
          return;
        }
        // A dona saiu do gravador (ou da página) enquanto o servidor criava a
        // reunião: o microfone nem é pedido — o pedido de permissão apareceria
        // em outra tela —, e a reunião vazia desta tentativa sai.
        if (!noGravadorAgora.current) {
          await gravacaoEmPartes.cancelar(reuniao);
          return;
        }
      }
      const comecou = await gravador.comecar();
      // O microfone não abriu (negado, ocupado): a reunião em partes vazia DESTA
      // tentativa sai, e só ela. Se a exclusão falhar agora, ela fica guardada e
      // a retomada a repete; a dona já viu o aviso do microfone.
      if (reuniao && !comecou) await gravacaoEmPartes.cancelar(reuniao);
    } finally {
      iniciandoAgora.current = false;
      setIniciando(false);
    }
  }

  // Descartar a gravação em partes, depois da confirmação na tela (G13b): no
  // envio único a revisão antes de enviar deixa descartar, mas aqui as partes
  // sobem enquanto grava. O gravador para sem entregar a última parte, e a
  // reunião, o que já subiu e a cópia no aparelho saem pelo caminho de exclusão
  // de sempre: nada vai para a transcrição. O título fica, para gravar de novo;
  // a autorização volta desmarcada, como no Encerrar: ela vale para uma gravação.
  async function discardRecording() {
    gravador.descartar();
    // Os avisos da parte recusada e da cópia que faltou falavam desta gravação,
    // que deixou de existir.
    toast.dismiss(ID_DO_AVISO_DA_PARTE_RECUSADA);
    toast.dismiss(ID_DO_AVISO_SEM_COPIA);
    setConsent(false);
    const resultado = await gravacaoEmPartes.descartar();
    // Não havia o que descartar: a última parte já tinha ido para a fila (o
    // Encerrar do mesmo instante venceu), e a gravação segue para a transcrição.
    if (resultado === "nada") return;
    void utils.meetings.list.invalidate();
    if (resultado === "descartada") {
      // O aviso de um descarte que não terminou, ainda na tela, contradiria este.
      toast.dismiss(ID_DO_AVISO_DO_DESCARTE_PENDENTE);
      toast.success(t("meetings.recordingDiscarded"));
      return;
    }
    // A exclusão no servidor não terminou: fica guardada e a retomada a repete,
    // em toda tela logada (components/RetomadaDosDescartes.tsx). O aviso fica até
    // ser fechado e diz como excluir pela lista, se for preciso.
    toast.error(t("meetings.discardRecordingError"), { id: ID_DO_AVISO_DO_DESCARTE_PENDENTE, duration: Infinity, closeButton: true });
  }

  async function uploadAudio(file: File) {
    const avisoTitulo = avisoDoTitulo();
    if (avisoTitulo) return toast.error(avisoTitulo);
    if (!consent) return toast.error(t("meetings.consentRequiredUpload"));
    const mimeType = supportedAudioMime(file);
    if (!mimeType) return toast.error(t("meetings.unsupportedFormat"));
    if (file.size > ENVIO_UNICO_BYTES_MAX) return toast.error(t("meetings.fileTooLarge"));
    let reuniaoCriada: string | undefined;
    // Como no envio da gravação: a sessão fica ocupada até o envio terminar.
    const liberarEnvio = ocupar("enviando");
    try {
      // O formulário trava já aqui, como no envio da gravação: ler o arquivo leva
      // segundos, e desmarcar a autorização nesse meio não impedia o create, que
      // grava consentGranted: true.
      setFinalizing(true);
      const [audioBase64, durationSeconds] = await Promise.all([readAsDataUrl(t, file), lerDuracaoNoNavegador(file)]);
      // Sem duração legível, recusa: assumir um valor (eram 60 s) deixava um
      // áudio de 25 minutos passar por esta conferência. O servidor mede de novo.
      if (durationSeconds === null) return toast.error(t("meetings.audioDurationUnreadable"));
      if (durationSeconds > ENVIO_UNICO_SEGUNDOS_MAX) return toast.error(t("meetings.audioTooLong"));
      const created = await createMeeting.mutateAsync({ title: title.trim(), consentGranted: true, language: idiomaFalado, consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO });
      reuniaoCriada = created.id;
      await submitRecording.mutateAsync({ meetingId: created.id, audioBase64, mimeType, durationSeconds, language: idiomaFalado });
    } catch (error) {
      // Com a reunião criada, a falha do envio já saiu pelo onError: o mesmo id
      // troca aquele aviso em vez de pôr outro igual ao lado.
      // Erro sem mensagem recua como o onError: o aviso nunca fica em branco.
      const mensagem = (error instanceof Error && traduzirMensagemDoServidor(error.message, t)) || (reuniaoCriada ? t("meetings.processError") : t("meetings.uploadError"));
      if (reuniaoCriada) toast.error(mensagem, avisoDaReuniao("falhou", reuniaoCriada));
      else toast.error(mensagem);
    } finally {
      setFinalizing(false);
      liberarEnvio();
    }
  }

  async function processCapturedAudio() {
    if (!capturedAudio) return;
    // O título segue editável depois de encerrar a gravação: confere de novo.
    const avisoTitulo = avisoDoTitulo();
    if (avisoTitulo) return toast.error(avisoTitulo);
    // O consentimento vale no envio, não só no início da gravação: desmarcado
    // depois de gravar, nada vai ao servidor (o create grava consentGranted).
    if (!consent) return toast.error(t("meetings.consentRequiredUpload"));
    let reuniaoCriada: string | undefined;
    // Até o fim do envio a sessão fica ocupada (lib/sessao-ocupada.ts), mesmo que a
    // dona saia desta tela: o pedido segue no ar, e sair da conta ou fechar a aba
    // no meio podem perder o áudio. Por isso é ocupação avulsa, e não presa à
    // página montada; antes do fim, só o fim da sessão a solta (liberarTodas):
    // o logout, depois que a dona confirma o Sair, e a exclusão da conta.
    const liberarEnvio = ocupar("enviando");
    try {
      setFinalizing(true);
      const [created, audioBase64] = await Promise.all([
        createMeeting.mutateAsync({ title: title.trim(), consentGranted: true, language: idiomaFalado, consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO }),
        readAsDataUrl(t, capturedAudio.blob),
      ]);
      reuniaoCriada = created.id;
      await submitRecording.mutateAsync({
        meetingId: created.id,
        audioBase64,
        mimeType: capturedAudio.mimeType,
        durationSeconds: capturedAudio.durationSeconds,
        language: idiomaFalado,
      });
    } catch (error) {
      // Como no envio de arquivo: depois de criada, o aviso é o mesmo do onError.
      // Erro sem mensagem recua como o onError: o aviso nunca fica em branco.
      const mensagem = (error instanceof Error && traduzirMensagemDoServidor(error.message, t)) || (reuniaoCriada ? t("meetings.processError") : t("meetings.sendRecordingError"));
      if (reuniaoCriada) toast.error(mensagem, avisoDaReuniao("falhou", reuniaoCriada));
      else toast.error(mensagem);
    } finally {
      setFinalizing(false);
      liberarEnvio();
    }
  }

  function discardCapturedAudio() {
    if (capturedAudio) URL.revokeObjectURL(capturedAudio.url);
    setCapturedAudio(null);
  }

  function stopRecording() {
    gravador.parar();
  }

  // O cabeçalho (menu global, sino, idioma) sai de UM lugar só, acima dos três
  // ramos da tela. Ele estava montado DENTRO do ramo da lista, e "nova reunião"
  // e o detalhe ficavam sem menu nenhum: a rota /meetings é isenta do cabeçalho
  // global justamente porque a página monta o seu (App.tsx, `cabecalhoProprio`),
  // então ali não sobrava nada — de dentro da gravação só se navegava voltando.
  // É o pedido do Rosber de 14/09 ("o menu sempre visível"), que na entrega de
  // 15/09 tinha ficado valendo só para a lista.
  // Guarda: client/src/App.cabecalho-de-todas-as-telas.test.ts, que agora lê os
  // ramos de cada página isenta, e client/src/pages/Meetings.cabecalho.test.tsx.
  const conteudo = screen === "new" ? (
    <MeetingRecorder
      title={title} setTitle={setTitle} consent={consent} setConsent={setConsent}
      idioma={idiomaFalado} setIdioma={setIdiomaFalado} emPartes={emPartes}
      recording={recording} paused={pausado} telaPodeApagar={telaAcesa.recusada} onPause={pausaSuportada() ? gravador.pausar : undefined} onResume={gravador.continuar} elapsed={gravador.segundos} processing={gravadorOcupado || finalizing || submitRecording.isPending}
      starting={iniciando}
      microphoneIssue={microphoneIssue} audioInput={audioInput} capturedAudio={capturedAudio}
      onProcessCaptured={processCapturedAudio} onDiscardCaptured={discardCapturedAudio}
      onDiscardRecording={emPartes ? discardRecording : undefined}
      onStart={startRecording} onStop={stopRecording} onUpload={uploadAudio} onBack={() => { if (!recording) navigate(ROTA_DAS_REUNIOES); }}
    />
  ) : screen === "detail" && reuniaoAberta ? (
    // key: ir de uma reunião direto a outra não herda a aba nem a tradução.
    // Excluir sai com replace: o voltar não reabre a reunião que deixou de existir.
    <MeetingDetail key={reuniaoAberta.id} meetingId={reuniaoAberta.id} onBack={() => navigate(ROTA_DAS_REUNIOES)} aoExcluir={() => navigate(ROTA_DAS_REUNIOES, { replace: true })} />
  ) : (
    <main className="min-h-screen text-white px-4 py-8 md:px-8 bg-transparent">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8">
          <div><p className="text-amber-300 text-sm font-semibold tracking-wide">{t("meetings.privateSecureBadge")}</p><h1 className="text-3xl md:text-4xl font-bold mt-1">{t("meetings.heroTitle")}</h1><p className="text-white/55 mt-2 max-w-2xl">{t("meetings.heroSubtitle")}</p></div>
          <button onClick={() => navigate(ROTA_GRAVAR)} className="inline-flex justify-center items-center gap-2 rounded-xl bg-[#c98f70] text-[#1a120c] font-bold px-5 py-3 hover:bg-[#efcba8]"><Plus size={18}/> {t("meetings.newMeetingButton")}</button>
        </div>
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm text-amber-100/80 mb-7"><CircleAlert size={17} className="inline mr-2"/>{t("meetings.consentNotice")}</div>
        {isLoading ? <div className="py-20 text-center text-white/45"><Loader2 className="animate-spin inline mr-2"/>{t("meetings.loadingList")}</div> : isError && !meetings ? <ErroDeConsulta erro={error} aoTentarDeNovo={() => refetch()} /> : !meetings?.length ? <div className="rounded-3xl border border-dashed border-white/15 px-6 py-20 text-center"><Mic className="mx-auto text-amber-300 mb-4" size={34}/><h2 className="font-semibold text-xl">{t("meetings.emptyTitle")}</h2><p className="text-white/45 mt-2">{t("meetings.emptySubtitle")}</p></div> : <div className="grid gap-3">{meetings.map(meeting => <button key={meeting.id} onClick={() => navigate(rotaDaReuniao(meeting.id))} className="text-left rounded-2xl border border-white/10 bg-white/[0.035] hover:bg-white/[0.07] p-5 transition-colors"><div className="flex items-center justify-between gap-4"><div><h2 className="text-base font-semibold">{meeting.title}</h2><p className="text-xs text-white/45 mt-1">{new Date(meeting.createdAt).toLocaleString(i18n.language)}</p></div><span className={`border rounded-full px-3 py-1 text-xs font-semibold ${statusClass(meeting.status)}`}>{statusLabel(t, meeting.status)}</span></div></button>)}</div>}
      </div>
    </main>
  );

  // O aviso de cada hora cheia de gravação (G13a) pede o OK e, sem ele em 10
  // min, encerra pelo mesmo caminho do botão Encerrar. Só na gravação em
  // partes: o envio único para nos 10 min e nunca chega a uma hora.
  return <><AppHeader title={t("meetings.pageTitle")} backTo="/dashboard"/>{conteudo}{emPartes && <AvisoDeHoraDeGravacao estado={gravador.estado} segundos={gravador.segundos} retomar={gravador.continuar} encerrar={stopRecording}/>}</>;
}

/** iPhone, iPod e iPad (o iPad se diz Mac, mas tem toque). */
function ehAparelhoDaApple() {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

function MeetingRecorder(props: { title: string; setTitle: (value: string) => void; idioma: IdiomaDaReuniao; setIdioma: (value: IdiomaDaReuniao) => void; emPartes: boolean; consent: boolean; setConsent: (value: boolean) => void; recording: boolean; paused: boolean; telaPodeApagar: boolean; onPause?: () => void; onResume: () => void; elapsed: number; processing: boolean; starting: boolean; microphoneIssue: string | null; audioInput: React.RefObject<HTMLInputElement | null>; capturedAudio: { url: string; durationSeconds: number } | null; onProcessCaptured: () => void; onDiscardCaptured: () => void; onDiscardRecording?: () => void; onStart: () => void; onStop: () => void; onUpload: (file: File) => void; onBack: () => void }) {
  const { t } = useTranslation();
  // Iniciando (G13b), o formulário trava como gravando: a autorização desmarcada
  // ou o título trocado no meio não mudariam a reunião que o servidor já cria.
  const locked = props.recording || props.processing || props.starting;
  // A confirmação do Descartar da gravação em partes (G13b), dentro da página:
  // o window.confirm pararia a página inteira, e no celular some com a troca de
  // app. A gravação segue enquanto ela está aberta (ver DescartarGravacao).
  const [confirmarDescarte, setConfirmarDescarte] = useState(false);
  // A gravação que termina com a confirmação aberta (o Encerrar, as 12 h, o aviso
  // de hora sem OK) já foi entregue: não há mais o que descartar, e a gravação
  // seguinte não reabre a confirmação.
  useEffect(() => { if (!props.recording) setConfirmarDescarte(false); }, [props.recording]);
  // G10: sem a tela acesa garantida (iPhone, ou navegador sem Wake Lock), a
  // dona precisa saber que bloquear o aparelho pode cortar a gravação.
  const avisarTelaAberta = props.recording && (ehAparelhoDaApple() || props.telaPodeApagar);
  return <main className="min-h-screen flex items-center justify-center p-4 bg-transparent text-white">
    <div className="w-full max-w-xl rounded-3xl border border-white/10 bg-[#211e1b]/90 p-6 md:p-8 shadow-2xl">
      <button disabled={locked} onClick={props.onBack} className="inline-flex items-center gap-2 text-sm text-white/55 hover:text-white disabled:opacity-40"><ArrowLeft size={16}/> {t("meetings.back")}</button>
      <p className="text-amber-300 text-xs font-semibold tracking-wide mt-6">{t("meetings.newMeetingEyebrow")}</p>
      <h1 className="text-2xl font-bold mt-1">{t("meetings.recorderTitle")}</h1>
      <div className="mt-7 space-y-5">
        <div><label className="text-sm text-white/70">{t("meetings.titleLabel")}</label><input disabled={locked} value={props.title} onChange={e => props.setTitle(e.target.value)} maxLength={TITULO_DA_REUNIAO_MAX} placeholder={t("meetings.titlePlaceholder")} className="mt-2 w-full rounded-xl bg-white/5 border border-white/15 px-4 py-3 outline-none focus:border-amber-300"/></div>
        <div><label htmlFor="idioma-da-reuniao" className="text-sm text-white/70">{t("meetings.meetingLanguageLabel")}</label>
          <select id="idioma-da-reuniao" disabled={locked} value={props.idioma} onChange={e => props.setIdioma(idiomaDaReuniao(e.target.value) ?? IDIOMA_DA_REUNIAO_PADRAO)} className="mt-2 w-full rounded-xl bg-white/5 border border-white/15 px-4 py-3 text-white outline-none focus:border-amber-300">
            {LANGUAGES.map(language => <option className="bg-white text-[#322C26]" key={language.code} value={language.code}>{language.flag} {language.label}</option>)}
          </select>
          <p className="text-xs text-white/40 mt-2">{t("meetings.meetingLanguageHint")}</p></div>
        {/* O aviso de privacidade também aqui: o login, o Dashboard e o link
            /gravar chegam ao gravador direto, sem passar pela lista, que era o
            único lugar com ele antes de gravar. */}
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm text-amber-100/80"><CircleAlert size={17} className="inline mr-2"/>{t("meetings.consentNotice")}</div>
        <label className="flex items-start gap-3 rounded-xl border border-white/10 p-4 cursor-pointer"><input type="checkbox" checked={props.consent} disabled={locked} onChange={e => props.setConsent(e.target.checked)} className="mt-1 accent-amber-400"/><span className="text-sm text-white/70">{t("meetings.consentCheckboxLabel")}</span></label>
      </div>
      <div className="my-9 text-center"><div className={`mx-auto mb-4 h-28 w-28 rounded-full flex items-center justify-center border ${props.recording ? `border-red-400 bg-red-500/15 ${props.paused ? "" : "animate-pulse"}` : "border-amber-400/40 bg-amber-400/10"}`}>{props.processing ? <Loader2 className="animate-spin text-amber-300" size={36}/> : <Mic className={props.recording ? "text-red-300" : "text-amber-300"} size={36}/>}</div><p className="font-mono text-3xl tracking-widest">{formatDuration(props.elapsed)}</p>{props.paused ? <p role="status" className="text-sm text-amber-200 mt-2">{t("meetings.pausedStatus")}</p> : <p className="text-xs text-white/40 mt-2">{props.emPartes ? t("meetings.recordingLimitInParts", { horas: HORAS_DA_GRAVACAO_EM_PARTES }) : t("meetings.recordingLimit")}</p>}</div>
      {avisarTelaAberta && <div role="note" className="mb-4 rounded-xl border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-100"><CircleAlert size={16} className="inline mr-2"/>{t("meetings.keepScreenOpenNotice")}</div>}
      {props.microphoneIssue && <div className="mb-4 rounded-xl border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-100"><strong>{t("meetings.micPermissionLabel")}</strong> {props.microphoneIssue}</div>}
      <input ref={props.audioInput} type="file" accept="audio/webm,audio/mpeg,audio/mp4,audio/m4a,audio/x-m4a,audio/ogg,audio/wav,.mp3,.m4a,.mp4,.ogg,.wav,.webm" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) props.onUpload(file); event.currentTarget.value = ""; }}/>
      {props.processing ? <div className="w-full rounded-xl bg-white/8 py-4 text-center text-white/70"><Loader2 className="inline animate-spin mr-2" size={17}/>{t("meetings.transcribingStatus")}</div> : props.recording ? <div className="space-y-3">{props.paused ? <button onClick={props.onResume} className="w-full rounded-xl bg-[#c98f70] text-[#1a120c] font-bold py-4 inline-flex justify-center gap-2"><Play size={19}/> {t("meetings.resumeRecording")}</button> : props.onPause && <button onClick={props.onPause} className="w-full rounded-xl border border-white/20 text-white/80 hover:bg-white/5 py-3 inline-flex justify-center gap-2"><Pause size={18}/> {t("meetings.pauseRecording")}</button>}<button onClick={props.onStop} className="w-full rounded-xl bg-red-500 text-white font-bold py-4 inline-flex justify-center gap-2"><Square size={18}/> {t("meetings.stopRecording")}</button>{props.onDiscardRecording && <DescartarGravacao aberta={confirmarDescarte} aoAbrirOuFechar={setConfirmarDescarte} aoDescartar={props.onDiscardRecording}/>}</div> : props.capturedAudio ? <div className="space-y-3 rounded-2xl border border-amber-300/25 bg-amber-300/5 p-4"><p className="text-sm font-semibold text-amber-100">{t("meetings.reviewBeforeTranscribe")}</p><audio controls src={props.capturedAudio.url} className="w-full"/><p className="text-xs text-white/45">{t("meetings.durationLabel")} {formatDuration(props.capturedAudio.durationSeconds)}</p><button onClick={props.onProcessCaptured} className="w-full rounded-xl bg-[#c98f70] text-[#1a120c] font-bold py-3 inline-flex justify-center gap-2"><FileText size={18}/> {t("meetings.transcribeButton")}</button><button onClick={props.onDiscardCaptured} className="w-full rounded-xl border border-white/20 py-3 text-sm text-white/75">{t("meetings.discardAndRetry")}</button></div> : <div className="space-y-3"><button onClick={props.onStart} disabled={props.starting} aria-busy={props.starting} className="w-full rounded-xl bg-[#c98f70] text-[#1a120c] font-bold py-4 inline-flex justify-center gap-2 disabled:opacity-60">{props.starting ? <Loader2 className="animate-spin" size={19}/> : <Play size={19}/>} {t("meetings.startRecording")}</button><button disabled={props.starting} onClick={() => props.audioInput.current?.click()} className="w-full rounded-xl border border-white/20 text-white/75 hover:bg-white/5 py-3 inline-flex justify-center gap-2 text-sm disabled:opacity-40"><FileText size={17}/> {t("meetings.uploadAudioButton")}</button>{/* Em partes, a frase sob o relógio fala só da gravação (G13b): o arquivo
          enviado segue no envio único, com os 10 minutos e 10 MB dele, até a H9a. */}{props.emPartes && <p className="text-xs text-white/40 text-center">{t("meetings.uploadLimit", { minutos: ENVIO_UNICO_SEGUNDOS_MAX / 60, mb: ENVIO_UNICO_BYTES_MAX / (1024 * 1024) })}</p>}</div>}
      {/* Abaixo dos botões. Ao gravar e ao enviar ela fica invisível sem
          perder o lugar: no computador o cartão é centralizado na altura, e
          tirá-la deslocaria o "Encerrar gravação", que nasce no lugar do
          "Iniciar gravação". Na revisão do áudio ela sai. */}
      {!props.capturedAudio && <DicaDeInstalacao oculta={locked}/>}
    </div>
  </main>;
}

/**
 * O Descartar da gravação em partes e a confirmação dele (G13b). O texto diz
 * que tudo some, inclusive o que já subiu, e que nada vai para a transcrição.
 * É o AlertDialog do projeto (Radix), como o do Sair: o foco começa no botão
 * que NÃO perde o áudio ("Voltar à gravação") e fica preso na confirmação, o
 * fundo fica inerte (fora da árvore de acessibilidade e sem clique), o Esc
 * fecha de qualquer lugar e, ao fechar, o foco volta ao Descartar.
 */
function DescartarGravacao({ aberta, aoAbrirOuFechar, aoDescartar }: { aberta: boolean; aoAbrirOuFechar: (aberta: boolean) => void; aoDescartar: () => void }) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={aberta} onOpenChange={aoAbrirOuFechar}>
      <AlertDialogTrigger asChild>
        <button type="button" className="w-full rounded-xl py-2 text-sm text-white/55 hover:text-red-300 inline-flex justify-center gap-2"><Trash2 size={16}/> {t("meetings.discardRecording")}</button>
      </AlertDialogTrigger>
      <AlertDialogContent className="border-white/15 bg-[#211e1b] text-white rounded-2xl sm:max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base font-bold text-white">{t("meetings.discardRecordingConfirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription className="text-white/50">{t("meetings.discardRecordingConfirmText")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-row gap-3">
          <AlertDialogCancel className="flex-1 rounded-xl border-white/15 bg-transparent text-white/60 hover:bg-white/8 hover:text-white">
            {t("meetings.discardRecordingCancel")}
          </AlertDialogCancel>
          <AlertDialogAction onClick={aoDescartar} className="flex-1 rounded-xl bg-red-500 font-bold text-white hover:bg-red-400">
            {t("meetings.discardRecording")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MeetingDetail({ meetingId, onBack, aoExcluir }: { meetingId: string; onBack: () => void; aoExcluir: () => void }) {
  const utils = trpc.useUtils();
  const { t, i18n } = useTranslation();
  // Em processamento (inclusive um reprocessamento em segundo plano), o detalhe
  // se atualiza a cada 5 s até a reunião ficar pronta ou falhar. O erro
  // definitivo não se relê: nem a cada 5 s, nem em nova tentativa, nem na
  // volta à aba ou na reconexão. Nessas duas, o padrão do React Query (o
  // QueryClient de main.tsx não o muda) relê a consulta vencida, e a consulta
  // sem dado está sempre vencida.
  const { data, isLoading, isError, error, refetch } = trpc.meetings.get.useQuery({ meetingId }, {
    // A reunião em partes também anda sozinha (a fila do servidor): enquanto
    // grava, recebe ou transcreve, o andamento se atualiza.
    refetchInterval: consulta => {
      const dado = consulta.state.data?.meeting;
      const andando = dado?.status === "processing" || (dado?.audioPipeline === "slices" && (dado.status === "recording" || dado.status === "uploading"));
      return andando && !erroDefinitivoDaReuniao(consulta.state.error) ? 5_000 : false;
    },
    retry: (tentativas, erro) => !erroDefinitivoDaReuniao(erro) && tentativas < 3,
    refetchOnWindowFocus: consulta => !erroDefinitivoDaReuniao(consulta.state.error),
    refetchOnReconnect: consulta => !erroDefinitivoDaReuniao(consulta.state.error),
  });
  // O resumo guardado (H4), de reunião pronta: a fila do servidor o gera em
  // segundo plano, e a tela pergunta de novo a cada 5 s enquanto ele está na
  // fila ou sendo gerado. Lido aqui, e não dentro do resumo, porque o emoji
  // dele vai antes do título da reunião. As decisões (ResumoGuardado) relêem.
  const resumoGuardado = trpc.meetings.resumoGuardado.useQuery({ meetingId }, {
    enabled: data?.meeting.status === "ready",
    // Para em qualquer erro, não só no definitivo: o estado da consulta só
    // guarda o erro que sobreviveu às novas tentativas do retry (um 500, o
    // banco fora do ar), e perguntar a cada 5 s não o cura. A releitura que dá
    // certo (o tentar de novo, a volta à aba, a reconexão) limpa o erro e
    // religa a repetição.
    refetchInterval: consulta => {
      const estado = consulta.state.data?.estado;
      return (estado === "pendente" || estado === "gerando") && !consulta.state.error ? 5_000 : false;
    },
    retry: (tentativas, erro) => !erroDefinitivoDaReuniao(erro) && tentativas < 3,
  });
  // true só com este detalhe montado e visível: a exclusão que termina depois
  // de a pessoa sair dele não a puxa de volta para a lista. Efeito de layout
  // pelo mesmo motivo do noGravadorAgora: escondido pelo Suspense (a ida a uma
  // tela que ainda carrega), o detalhe só tem os efeitos de layout limpos.
  const montado = useRef(false);
  useLayoutEffect(() => {
    montado.current = true;
    return () => { montado.current = false; };
  }, []);
  // ?t (o segundo de uma fala) e ?q (o termo buscado) vêm dos links para dentro
  // da reunião (Memória, busca, combinados): abrem a transcrição já no ponto.
  // Lidos pelo useSearch, e não uma vez só: o detalhe tem key=id, então um link
  // para esta mesma reunião com outro ?t não remonta a tela (nem corta o áudio),
  // e é aqui que ele chega.
  const busca = useSearch();
  const parametros = useMemo(() => new URLSearchParams(busca), [busca]);
  const segundoPedido = Number(parametros.get("t"));
  const termoPedido = parametros.get("q") ?? "";
  // ?item (um item do resumo guardado, dos links das próximas ações e dos
  // lembretes) abre a aba Resumo, que rola até ele e o destaca; ele vale mais
  // que ?t e ?q para a aba (o ?t ainda leva o player, que serve a todas).
  const itemPedido = parametros.get("item") ?? "";
  // O item até o qual a aba Resumo já rolou: trocar de aba e voltar não rola de
  // novo até ele (como o ?t, que pula uma vez por link).
  const itemJaDestacado = useRef<string | null>(null);
  const pedeTranscricao = (Number.isFinite(segundoPedido) && segundoPedido > 0) || !!termoPedido;
  const [tab, setTab] = useState<"summary" | "transcript" | "contacts">(!itemPedido && pedeTranscricao ? "transcript" : "summary");
  // O player é um só, fixo no rodapé (BarraDoPlayer), para todas as abas.
  const player = useRef<ControleDoPlayer | null>(null);
  const definirPlayer = useCallback((controle: ControleDoPlayer | null) => { player.current = controle; }, []);
  useEffect(() => {
    if (itemPedido) setTab("summary");
    else if (pedeTranscricao) setTab("transcript");
  }, [busca]);
  // O ?t do link leva o player ao ponto quando a parte que cobre o segundo
  // existe. Na reunião que ainda está chegando (gravando, enviando ou
  // transcrevendo), o pulo espera a parte; pronta, vai à mais próxima. Cada
  // link diferente pula uma vez: o mesmo ?t de novo (o mesmo endereço) não muda
  // a busca e não pula outra vez — o "▶" dentro da reunião fala direto com o
  // player, sem passar por aqui.
  const buscaJaAtendida = useRef<string | null>(null);
  const partesDoDado = data?.recording?.partes ?? (data?.recording ? [{ inicioSegundos: 0, duracaoSegundos: data.recording.durationSeconds }] : []);
  const cobreOPedido = partesDoDado.some(parte => segundoPedido >= parte.inicioSegundos && segundoPedido < parte.inicioSegundos + parte.duracaoSegundos);
  const statusDaReuniao = data?.meeting.status;
  const aindaChegando = statusDaReuniao === "recording" || statusDaReuniao === "uploading" || statusDaReuniao === "processing";
  useEffect(() => {
    if (!player.current || buscaJaAtendida.current === busca || !(Number.isFinite(segundoPedido) && segundoPedido > 0)) return;
    if (!cobreOPedido && aindaChegando) return;
    buscaJaAtendida.current = busca;
    player.current.irPara(segundoPedido);
  }, [busca, partesDoDado.length, cobreOPedido, aindaChegando]);
  const [falhaNoAudio, setFalhaNoAudio] = useState(false);
  // O idioma RESOLVIDO: o pedido pode ser regional ("en-US") e cair fora da
  // lista, mandando a tradução para pt-BR com a tela em inglês.
  const idiomaAtual = i18n.resolvedLanguage ?? i18n.language;
  const initialLanguage = LANGUAGES.some(language => language.code === idiomaAtual) ? idiomaAtual : "pt-BR";
  const [translationLanguage, setTranslationLanguage] = useState(initialLanguage);
  const [translatedText, setTranslatedText] = useState<string | null>(null);
  // Reunião longa: o servidor traduz em segundo plano e responde "em andamento";
  // a tela pergunta de novo a cada 5 s até a tradução chegar.
  const traducaoLonga = useNovaTentativa(`${meetingId}|${translationLanguage}`);
  // Excluir apaga áudio, transcrição, traduções e sugestões de uma vez, sem
  // volta — e o botão fica ao lado do selo de status, onde um clique por
  // engano é fácil. O mutate só sai do botão do modal.
  const [confirmarExclusao, setConfirmarExclusao] = useState(false);
  const decideEntity = trpc.meetings.decideEntity.useMutation({ onSuccess: () => utils.meetings.get.invalidate({ meetingId }) });
  // Meu Network Inteligente: o que a IA propôs de O Que Tenho / O Que Preciso
  // para cada pessoa da reunião, ainda pendente de confirmação.
  // Com o id da URL, o link cortado também chega aqui: BAD_REQUEST é definitivo,
  // sem nova tentativa nem releitura na reconexão.
  const pendenciasDaReuniao = trpc.networkInteligente.pendencias.useQuery({ meetingId }, {
    refetchOnWindowFocus: false,
    refetchOnReconnect: consulta => !linkDeReuniaoInvalido(consulta.state.error),
    retry: (tentativas, erro) => !linkDeReuniaoInvalido(erro) && tentativas < 3,
  });
  // Recusada (CONFLICT: já decidida em outra aba), a tela relê o estado real da sugestão.
  const decideContact = trpc.meetings.decideContactSuggestion.useMutation({
    onError: erro => toast.error(erro.message),
    onSettled: () => { void utils.meetings.get.invalidate({ meetingId }); void pendenciasDaReuniao.refetch(); },
  });
  // A resposta da tradução é aplicada no callback do próprio mutate (lá embaixo),
  // que só dispara para o ÚLTIMO pedido: a tradução de uma transcrição trocada
  // por um reprocessamento, chegando atrasada, não sobrescreve a da nova.
  const translateTranscript = trpc.meetings.translateTranscript.useMutation({
    onError: error => toast.error(error.message || t("meetings.translateError")),
  });
  const deleteMeeting = trpc.meetings.delete.useMutation({
    onSuccess: async () => { await utils.meetings.list.invalidate(); toast.success(t("meetings.deleteSuccess")); if (montado.current) aoExcluir(); },
    onError: error => { setConfirmarExclusao(false); toast.error(error.message || t("meetings.deleteError")); },
  });
  const reprocessar = trpc.meetings.reprocess.useMutation({
    onSuccess: () => {
      toast.success(t("meetings.reprocessStarted"));
      // O servidor já tomou a reunião: a tela vira 'processing' na hora, sem
      // esperar a releitura. O botão some, a consulta de 5 s liga e uma falha
      // rápida (áudio ausente no bucket) ainda chega como aviso de término.
      utils.meetings.get.setData({ meetingId }, anterior => anterior && {
        ...anterior,
        meeting: { ...anterior.meeting, status: "processing" as const, processingError: null },
      });
    },
    onError: erro => toast.error(mensagemDoReprocesso(t, erro)),
    // Aceito ou recusado, o estado real (processando, ou já pronta) vem do servidor.
    onSettled: () => { void utils.meetings.get.invalidate({ meetingId }); void utils.meetings.list.invalidate(); },
  });

  // O reprocessamento termina sem ninguém esperando a mutation: quem avisa é a
  // troca de status que a consulta periódica traz.
  const statusAnterior = useRef<string | undefined>(undefined);
  useEffect(() => {
    const status = data?.meeting.status;
    if (statusAnterior.current === "processing" && status === "ready") {
      toast.success(t("meetings.processedSuccess"), avisoDaReuniao("processada", meetingId));
      setTab("summary");
      // As pendências de Tenho/Preciso foram lidas antes do fim, com as pessoas
      // da tentativa anterior (ou nenhuma), e a consulta não se relê sozinha. O
      // reset tira o dado velho da tela (vira "carregando", não FALTANDO) e relê.
      void utils.networkInteligente.pendencias.reset({ meetingId });
    } else if (statusAnterior.current === "processing" && status === "failed") {
      // A causa gravada, e não a frase genérica: com o mesmo id, este aviso troca
      // o do fim do envio, que trazia a causa enviada pelo servidor.
      toast.error(causaDaFalha(t, data?.meeting.processingError) ?? t("meetings.processError"), avisoDaReuniao("falhou", meetingId));
    }
    statusAnterior.current = status;
  }, [data?.meeting.status]);

  // Em processamento, a transcrição na tela é da tentativa anterior e está para
  // ser trocada: traduzir agora gastaria IA com um texto que vai sumir.
  const processandoAgora = data?.meeting.status === "processing";
  // O idioma em que a reunião foi transcrita é o original: escolhê-lo mostra a
  // transcrição como está, e os outros pedem tradução. Reunião antiga guarda 'pt'.
  const idiomaOriginal = idiomaDaReuniao(data?.transcript?.language) ?? IDIOMA_DA_REUNIAO_PADRAO;
  useEffect(() => {
    if (!data?.transcript || translationLanguage === idiomaOriginal || processandoAgora) { traducaoLonga.parar(); setTranslatedText(null); return; }
    // A tradução anterior sai antes do pedido novo: se ele falhar (cota, prazo),
    // a tela mostra a transcrição original, não a tradução de outro texto.
    setTranslatedText(null);
    translateTranscript.mutate(
      { meetingId, language: translationLanguage as IdiomaDaReuniao },
      {
        onSuccess: result => {
          if (result.emAndamento) return traducaoLonga.agendar();
          traducaoLonga.parar();
          setTranslatedText(result.text);
        },
        onError: () => traducaoLonga.parar(),
      },
    );
  }, [data?.transcript?.id, meetingId, translationLanguage, processandoAgora, idiomaOriginal, traducaoLonga.tentativa]);

  // Erro antes do spinner: com isLoading false e data undefined a consulta
  // falhada caía no ramo abaixo e a usuária via um círculo girando para
  // sempre, sem saber que a reunião existe e o servidor é que não respondeu.
  // Com dado na tela, só NOT_FOUND troca a tela pelo erro: uma consulta periódica
  // que falha por deploy ou limite de requisições mantém o dado anterior, e
  // esconder a reunião justo enquanto ela processa seria pior. Já a reunião
  // excluída em outro lugar não pode ficar "processando" para sempre.
  // Reunião que não existe (excluída, de outra dona) e link cortado são
  // definitivos: um aviso no idioma da tela, sem "tentar de novo". A frase do
  // servidor vem em português, e a do zod em JSON.
  if (isError && (linkDeReuniaoInvalido(error) || reuniaoNaoExiste(error))) return <main className="min-h-screen p-4 md:p-8 text-white bg-transparent"><div className="max-w-5xl mx-auto">
    <button onClick={onBack} className="inline-flex items-center gap-2 text-sm text-white/55 hover:text-white mb-6"><ArrowLeft size={16}/> {t("meetings.allMeetings")}</button>
    <div role="alert" className="rounded-2xl border border-white/10 bg-white/[0.035] p-6 text-sm text-white/70">{reuniaoNaoExiste(error) ? t("meetings.meetingNotFound") : t("meetings.invalidMeetingLink")}</div>
  </div></main>;
  if (isError && !data) return <main className="min-h-screen p-4 md:p-8 text-white bg-transparent"><div className="max-w-5xl mx-auto">
    <button onClick={onBack} className="inline-flex items-center gap-2 text-sm text-white/55 hover:text-white mb-6"><ArrowLeft size={16}/> {t("meetings.allMeetings")}</button>
    <ErroDeConsulta erro={error} aoTentarDeNovo={() => refetch()} />
  </div></main>;
  if (isLoading || !data) return <main className="min-h-screen grid place-items-center text-white"><Loader2 className="animate-spin"/></main>;
  const { meeting, transcript, entities, suggestions, recording, recordingExpired, recordingDeletionPending, andamento } = data;
  const partesParaOuvir = recording?.partes ?? (recording ? [{ seq: 0, url: recording.url, mimeType: recording.mimeType, inicioSegundos: 0, duracaoSegundos: recording.durationSeconds }] : []);
  // As falas com falante e tempo (a transcrição em partes); a de antes é texto corrido.
  const falas = segmentosValidos(transcript?.segments);
  const mostraFalas = falas.length > 0 && translationLanguage === idiomaOriginal;
  const displayTranscript = translationLanguage === idiomaOriginal ? transcript?.transcript : translatedText;
  // Destaques valem só para o texto original: os valores extraídos pela IA não
  // batem com o texto traduzido.
  const segmentos = transcript && translationLanguage === idiomaOriginal
    ? segmentarTranscricao(transcript.transcript, entities)
    : null;
  const tiposPresentes = segmentos
    ? Array.from(new Set(segmentos.flatMap(s => (s.tipo ? [s.tipo] : []))))
    : [];
  // Excluir continua possível em processamento: o servidor relê o status
  // antes de gravar e compensa o que já gravou, então nada fica órfão — e
  // desabilitar o botão deixava uma reunião morta pelo deploy presa E
  // inexcluível até a varredura passar. O modal só avisa que o trabalho em
  // curso será descartado.
  const emProcessamento = meeting.status === "processing";
  // O áudio sumiu do bucket: reprocessar de novo não adianta.
  const audioGuardadoAusente = meeting.processingError === MENSAGEM_AUDIO_GUARDADO_AUSENTE;
  const motivoDaFalha = causaDaFalha(t, meeting.processingError) ?? t("meetings.processingFailedFallback");
  // Resumo e perguntas leem a transcrição: só com a reunião pronta e com texto.
  const prontaComTranscricao = meeting.status === "ready" && !!transcript?.transcript?.trim();
  // O emoji do resumo vai antes do título, como no app de referência da cliente.
  const emojiDoResumo = meeting.status === "ready" ? resumoGuardado.data?.emoji ?? null : null;
  return <main className={`min-h-screen p-4 md:p-8 text-white bg-transparent ${partesParaOuvir.length ? ESPACO_DA_BARRA_DO_PLAYER : ""}`}><div className="max-w-5xl mx-auto">
    <button onClick={onBack} className="inline-flex items-center gap-2 text-sm text-white/55 hover:text-white mb-6"><ArrowLeft size={16}/> {t("meetings.allMeetings")}</button>
    <div className="flex flex-col md:flex-row justify-between gap-4 mb-6"><div><p className="text-amber-300 text-xs font-semibold">{meeting.shareToken ? t("meetings.share.sharedEyebrow") : t("meetings.privateMeetingEyebrow")}</p><h1 dir="auto" className="text-3xl font-bold mt-1">{emojiDoResumo && <span aria-hidden="true" className="mr-2">{emojiDoResumo}</span>}{meeting.title}</h1><p className="text-sm text-white/45 mt-2">{new Date(meeting.createdAt).toLocaleString(i18n.language)}</p></div><div className="flex items-start gap-2"><span className={`h-fit border rounded-full px-3 py-1 text-xs font-semibold ${statusClass(meeting.status)}`}>{statusLabel(t, meeting.status)}</span><button onClick={() => setConfirmarExclusao(true)} disabled={deleteMeeting.isPending} className="rounded-full border border-red-400/25 px-3 py-1 text-xs text-red-200 hover:bg-red-400/10 disabled:opacity-50">{t("meetings.deleteButton")}</button></div></div>
    {/* Só reunião pronta tem link aberto: o servidor recusa as outras. */}
    {meeting.status === "ready" && <CompartilharReuniao meetingId={meetingId} titulo={meeting.title} token={meeting.shareToken ?? null}/>}
    {meeting.status === "failed" && <div className="mb-6 rounded-xl border border-red-400/20 bg-red-400/10 p-4 text-red-200">
      <p>{motivoDaFalha}</p>
      {/* Reprocessar só com áudio guardado que ainda dura mais que o
          reprocesso inteiro, que cresce com as partes da gravação: perto de
          vencer, o reprocesso seguraria o áudio além dos 30 dias, e o servidor
          recusa o pedido com a mesma conta (margemDoReprocesso). */}
      {recording && !audioGuardadoAusente && recording.expiresAt - Date.now() > margemDoReprocesso(meeting.expectedSlices) ? (
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-red-100/75">{t("meetings.reprocessHint", { date: new Date(recording.expiresAt).toLocaleDateString(i18n.language) })}</p>
          <button type="button" onClick={() => reprocessar.mutate({ meetingId })} disabled={reprocessar.isPending}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-[#c98f70] px-4 py-2 text-sm font-bold text-[#1a120c] hover:bg-[#efcba8] disabled:opacity-60">
            <RefreshCw size={15} className={reprocessar.isPending ? "animate-spin" : ""}/> {t("meetings.reprocessButton")}
          </button>
        </div>
      ) : (
        <p className="mt-2 text-sm text-red-100/75">{recording ? t("meetings.reprocessUnavailable") : t("meetings.reprocessNoAudio")}</p>
      )}
    </div>}
    {andamento && (meeting.status === "recording" || meeting.status === "uploading") && <div role="status" className="mb-6 rounded-xl border border-amber-300/25 bg-amber-300/10 p-4 text-amber-100"><Loader2 className="inline animate-spin mr-2" size={16}/>
      {andamento.esperadas ? t("meetings.progressUploading", { recebidas: andamento.recebidas, esperadas: andamento.esperadas }) : t("meetings.progressRecording")}
      {andamento.recebidas > 0 && <span className="block mt-1 text-sm text-amber-100/75">{t("meetings.progressTranscribing", { transcritas: andamento.transcritas, total: andamento.esperadas ?? andamento.recebidas })}</span>}
    </div>}
    {emProcessamento && <div role="status" className="mb-6 rounded-xl border border-amber-300/25 bg-amber-300/10 p-4 text-amber-100"><Loader2 className="inline animate-spin mr-2" size={16}/>{t("meetings.transcribingStatus")}</div>}
    <div className="flex gap-2 overflow-x-auto border-b border-white/10 mb-6">{([ ["summary", t("meetings.summaryTab"), FileText], ["transcript", t("meetings.transcriptTab"), Clock3], ["contacts", t("meetings.contactsTab", { count: suggestions.length }), Users] ] as const).map(([id,label,Icon]) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)} className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-3 text-sm border-b-2 ${tab === id ? "border-amber-300 text-amber-300" : "border-transparent text-white/50"}`}><Icon size={16}/>{label}</button>)}</div>
    {tab === "summary" && prontaComTranscricao && <div className="mb-4 space-y-4">
      <ResumoGuardado meetingId={meetingId} consulta={resumoGuardado} nomes={nomesDosFalantes(meeting.speakerNames)} itemDestacado={itemPedido || null} registroDoDestaque={itemJaDestacado}
        aoIrPara={partesParaOuvir.length ? segundo => player.current?.irPara(segundo) : undefined}/>
      <PergunteAReuniao meetingId={meetingId} nomes={nomesDosFalantes(meeting.speakerNames)}
        aoIrPara={partesParaOuvir.length ? segundo => player.current?.irPara(segundo) : undefined}/>
    </div>}
    {tab === "summary" && <div className="grid md:grid-cols-2 gap-4"><section className="rounded-2xl border border-white/10 bg-white/[0.035] p-5"><h2 className="text-base font-semibold">{t("meetings.entitiesHeading")}</h2><div className="flex flex-wrap gap-2 mt-4">{entities.length ? entities.map(entity => { const tipo = TIPOS_DE_ENTIDADE[entity.entityType as TipoEntidade]; return <span key={entity.id} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm ${tipo ? tipo.classes : "border border-white/10 bg-white/5 text-white/75"}`}>{tipo && <span className="text-[10px] font-semibold uppercase tracking-wider opacity-75">{t(tipo.chave)}</span>}<span>{entity.value}</span></span>; }) : <p className="text-sm text-white/45">{t("meetings.noEntities")}</p>}</div></section><section className="rounded-2xl border border-white/10 bg-white/[0.035] p-5"><h2 className="text-base font-semibold">{t("meetings.recordingHeading")}</h2>
      {recording ? <>
        {/* O player fica no rodapé (BarraDoPlayer), um só para todas as abas. */}
        <p className="text-xs text-white/45 mt-2">{t("meetings.durationLabel")} {formatDuration(recording.durationSeconds)} {t("meetings.availableUntil")} {new Date(recording.expiresAt).toLocaleDateString(i18n.language)}</p>
      </> : recordingExpired ? (
        // "A transcrição continua aqui" só é verdade com transcrição, e numa
        // reunião que falhou antes de guardar o áudio não houve gravação apagada.
        <p className="text-sm text-white/50 mt-3">{transcript ? t("meetings.recordingExpiredNotice") : t("meetings.recordingExpiredNoTranscript")}</p>
      ) : recordingDeletionPending ? (
        // Venceu e ainda não saiu do bucket: "foi apagada" só depois que saiu.
        <p className="text-sm text-white/50 mt-3">{t("meetings.recordingDeletionPending")}</p>
      ) : (
        <p className="text-sm text-white/50 mt-3">{t("meetings.noRecordingStored")}</p>
      )}
      <p className="text-sm text-white/50 mt-3">{t("meetings.privacyNotice")}</p></section></div>}
    {tab === "transcript" && <section className="rounded-2xl border border-white/10 bg-white/[0.035] p-5">
      <h2 className="text-base font-semibold mb-4">{t("meetings.transcriptTab")}</h2>
      {transcript ? <>
        <div className="mb-5 rounded-xl border border-amber-300/25 bg-amber-300/10 p-4">
          <p className="font-semibold text-amber-100">{t("meetings.translateHeading")}</p>
          <p className="mt-1 text-sm text-amber-100/70">{t("meetings.translateSubtext")}</p>
          <label className="mt-3 flex flex-col gap-2 text-sm text-white/75 sm:flex-row sm:items-center">{t("meetings.targetLanguageLabel")}
            <select value={translationLanguage} onChange={event => setTranslationLanguage(event.target.value)} className="rounded-lg bg-[#211e1b] border border-white/15 px-3 py-2 text-white">
              {LANGUAGES.map(language => <option className="bg-white text-[#322C26]" key={language.code} value={language.code}>{language.flag} {language.label}{language.code === idiomaOriginal ? ` ${t("meetings.originalLanguageSuffix")}` : ""}</option>)}
            </select>
          </label>
        </div>
        {traducaoLonga.aguardando ? <div role="status" className="text-white/55"><Loader2 className="inline animate-spin mr-2" size={16}/>{t("meetings.translatingLongStatus")}</div> : translateTranscript.isPending ? <div className="text-white/55"><Loader2 className="inline animate-spin mr-2" size={16}/>{t("meetings.translatingStatus")}</div> : <>
          {tiposPresentes.length > 0 && <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-white/40">{t("meetings.highlightsLabel")}</span>
            {tiposPresentes.map(tipo => <span key={tipo} className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${TIPOS_DE_ENTIDADE[tipo].classes}`}>{t(TIPOS_DE_ENTIDADE[tipo].chave)}</span>)}
          </div>}
          {mostraFalas
            ? <>
              {/* Outro ?q para a mesma reunião remonta a busca com o termo novo. */}
              <TranscricaoPorFalante key={termoPedido} segmentos={falas} termoInicial={termoPedido} aoIrPara={partesParaOuvir.length ? segundo => player.current?.irPara(segundo) : undefined}
                nomes={nomesDosFalantes(meeting.speakerNames)} aoNomear={async (falante, nome) => {
                  try {
                    await utils.client.meetings.nomearFalante.mutate({ meetingId, falante, nome });
                    await utils.meetings.get.invalidate({ meetingId });
                  } catch (erro) {
                    toast.error(traduzirMensagemDoServidor(erro instanceof Error ? erro.message : "", t) || t("meetings.speakerNameError"));
                    throw erro;
                  }
                }}/>
            </>
            : segmentos
            ? <p dir="auto" className="whitespace-pre-wrap leading-7 text-white/75">{segmentos.map((s, i) => s.tipo
                ? <mark key={i} title={t(TIPOS_DE_ENTIDADE[s.tipo].chave)} className={`rounded-md px-1 py-0.5 font-medium ${TIPOS_DE_ENTIDADE[s.tipo].classes}`}>{s.texto}</mark>
                : <span key={i}>{s.texto}</span>)}</p>
            : <p dir="auto" className="whitespace-pre-wrap leading-7 text-white/75">{displayTranscript || transcript.transcript}</p>}
        </>}
      </> : <p className="text-white/45">{t("meetings.transcriptUnavailable")}</p>}
    </section>}
    {tab === "contacts" && <div className="space-y-3">
      {/* Pendências ainda não lidas: carregando, ou erro com tentar de novo —
          nunca "FALTANDO" nos cartões, que afirmaria que a IA não achou nada. */}
      {suggestions.length > 0 && !pendenciasDaReuniao.data && (pendenciasDaReuniao.isError
        ? <ErroDeConsulta erro={pendenciasDaReuniao.error} aoTentarDeNovo={() => void pendenciasDaReuniao.refetch()} />
        : <p className="text-sm text-white/45"><Loader2 className="inline animate-spin mr-2" size={14}/>{t("networkPanel.loading")}</p>)}
      {suggestions.length ? suggestions.map(suggestion => <section key={suggestion.id} className="rounded-2xl border border-white/10 bg-white/[0.035] p-5"><div className="flex flex-col md:flex-row gap-4 justify-between"><PessoaSugeridaNaReuniao sugestao={suggestion} pendencias={pendenciasDaReuniao.data} />{suggestion.status === "pending" && emProcessamento ? <span className="text-sm text-amber-200/70">{t("meetings.decisionsPaused")}</span> : suggestion.status === "pending" ? <div className="flex flex-wrap gap-2"><button disabled={decideContact.isPending} onClick={() => decideContact.mutate({ suggestionId: suggestion.id, action: "create" })} className="rounded-lg bg-amber-400 text-[#1a120c] px-3 py-2 text-sm font-bold disabled:opacity-50"><Check size={15} className="inline mr-1"/>{t("meetings.createContactButton")}</button><button disabled={decideContact.isPending} onClick={() => decideContact.mutate({ suggestionId: suggestion.id, action: "ignore" })} className="rounded-lg border border-white/15 px-3 py-2 text-sm text-white/65 disabled:opacity-50"><X size={15} className="inline mr-1"/>{t("meetings.ignoreButton")}</button></div> : <span className="text-sm text-white/45">{suggestion.status === "created" ? t("meetings.contactCreatedStatus") : t("meetings.ignoredStatus")}</span>}</div></section>) : <div className="rounded-2xl border border-dashed border-white/15 py-14 text-center text-white/45">{t("meetings.noContactSuggestions")}</div>}</div>}

    {/* Confirmação de exclusão — molde de Network.tsx; o texto nomeia tudo que some. */}
    {confirmarExclusao && (
      <div role="dialog" aria-modal="true" aria-labelledby="confirmar-exclusao-reuniao" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
        <div className="bg-[#211e1b] border border-white/15 rounded-2xl p-6 max-w-sm w-full shadow-2xl">
          <h3 id="confirmar-exclusao-reuniao" className="font-bold text-white mb-2">{t("meetings.deleteConfirmTitle")}</h3>
          <p className={`text-sm text-white/50 ${emProcessamento ? "mb-3" : "mb-6"}`}>{t("meetings.deleteConfirmText")}</p>
          {emProcessamento && <p className="text-sm text-amber-200/80 mb-6">{t("meetings.deleteConfirmProcessing")}</p>}
          <div className="flex gap-3">
            <button type="button" onClick={() => setConfirmarExclusao(false)} disabled={deleteMeeting.isPending} className="flex-1 rounded-xl border border-white/15 py-2.5 text-sm text-white/60 hover:bg-white/8 disabled:opacity-50">
              {t("meetings.deleteConfirmCancel")}
            </button>
            <button type="button" onClick={() => deleteMeeting.mutate({ meetingId })} disabled={deleteMeeting.isPending} className="flex-1 rounded-xl bg-red-500 hover:bg-red-400 py-2.5 text-sm font-bold text-white disabled:opacity-50">
              {t("meetings.deleteConfirmButton")}
            </button>
          </div>
        </div>
      </div>
    )}
  </div>
    {/* Sem onError o player falha MUDO: sessão vencida, limite de requisições ou
        storage fora do ar desenham os controles e simplesmente não tocam, e a
        usuária não tem o que reportar. */}
    <BarraDoPlayer ref={definirPlayer} partes={partesParaOuvir}
      aviso={falhaNoAudio ? t("meetings.audioLoadError") : null}
      aoFalhar={() => setFalhaNoAudio(true)} aoCarregar={() => setFalhaNoAudio(false)}/>
  </main>;
}
