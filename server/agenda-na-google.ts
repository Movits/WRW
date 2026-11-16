import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { reuniaoJaAcabou } from "@shared/agenda";
import type { EstadoNaGoogle, MotivoSemGoogle, ResultadoNaGoogle } from "@shared/google-agenda-eventos";
import { estadoNaGoogle } from "@shared/google-agenda-eventos";
import { agendaReunioes } from "../drizzle/schema";
import { convitesPelaGoogle, excluirDaAgenda, MENSAGEM_AGENDADA_NAO_ENCONTRADA, participantesDe } from "./agenda-de-reunioes";
import { ehErroDeBancoIndisponivel, ehErroDoDriverDeBanco } from "./banco-indisponivel";
import { exigirDb } from "./db";
import {
  GoogleAgendaIndisponivel,
  GoogleAgendaNaoConectada,
  renovarTokenDeAcessoDaGoogleAgenda,
  tokenDeAcessoDaGoogleAgenda,
} from "./google-agenda";
import {
  corpoDoEvento,
  excluirEventoNaGoogle,
  gravarEventoNaGoogle,
  sessaoDaGoogle,
  type ReuniaoParaGoogle,
  type SessaoDaGoogle,
} from "./google-agenda-eventos";
import { ConexaoGoogleRevogada, fetchGlobal, RecusaDaGoogle, type Fetch } from "./google-oauth";

/**
 * A reunião da agenda na Google Agenda conectada da dona (H16c do plano do
 * gravador): o banco e a ordem das coisas. A conversa com a Google está em
 * server/google-agenda-eventos.ts.
 *
 * Primeiro o banco, depois a Google. Marcar e mudar gravam a reunião já com o
 * estado "pendente" (server/agenda-de-reunioes.ts), e só então a Google é
 * chamada; a resposta vira "ok" ou "falhou", e no "falhou" a tela mostra
 * "Tentar de novo". Excluir apaga a linha e depois tira o evento. A falha da
 * Google nunca desfaz o que a dona salvou na WRW.
 *
 * O token de acesso vem ANTES de gravar ou apagar a linha (acessoDaGoogle): é
 * a leitura do banco do passo da Google, e o banco fora do ar ali derruba a
 * mutação sem nada feito. Depois da escrita ficam só a chamada à Google e a
 * gravação do resultado. Com o token lido depois, a queda do banco deixava a
 * reunião salva e a tela com erro, e salvar de novo a duplicava; na exclusão,
 * a reunião saía e o evento ficava na Google sem "Tentar de novo".
 *
 * A reunião que já acabou (reuniaoJaAcabou, em shared/agenda.ts) nunca é
 * criada na Google, e nada do que se faz com ela avisa os convidados: mudá-la
 * só muda o evento que já está lá, sem aviso, e o que não está fica de fora
 * (estado nulo); excluí-la não chama a Google, e o evento fica lá como
 * histórico, sem "evento cancelado" para quem foi a uma reunião que já houve.
 *
 * O resultado grava com FICHA: o `updatedAt` da versão que foi à Google. Se a
 * linha mudou durante a chamada, o resultado só vale quando o evento continua o
 * mesmo (a gravação ligada pelo "Gravar agora" muda a linha e não o evento);
 * senão fica para quem mudou, que manda a versão dele. Se a linha sumiu durante
 * a chamada (a dona excluiu em outra aba), o evento recém-gravado é tirado,
 * para não ficar órfão na agenda dela. O resultado também não traz de volta o
 * estado que a desconexão ou a troca da conta Google zerou
 * (server/google-agenda.ts).
 *
 * Banco fora do ar sobe como erro (server/CLAUDE.md). Os erros da Google viram
 * o motivo que a tela traduz, e o log leva só o código, nunca token, título ou
 * e-mail.
 */

type Banco = Awaited<ReturnType<typeof exigirDb>>;

/** A conta da sessão: a agenda é da dona pelo openId, e a conexão Google pelo id. */
export type ContaDaAgenda = { id: number; openId: string };

/** A reunião como o envio precisa: o evento, o estado na Google, a escolha do convite e a ficha. */
export type LinhaParaGoogle = ReuniaoParaGoogle & {
  google: EstadoNaGoogle | null;
  googleConvites: boolean;
  updatedAt: number;
};

/** O token e a renovação (server/google-agenda.ts), o fetch e o relógio, por parâmetro só para o teste trocá-los. */
export type DependenciasDaGoogle = {
  token: (userId: number) => Promise<string>;
  renovar: (userId: number) => Promise<string>;
  buscar: Fetch;
  agora: () => number;
};

/** As dependências de verdade; a próxima ação na Google (H5c, server/acoes-na-google.ts) usa as mesmas. */
export const DEPENDENCIAS_DA_GOOGLE: DependenciasDaGoogle = {
  token: userId => tokenDeAcessoDaGoogleAgenda(userId),
  renovar: userId => renovarTokenDeAcessoDaGoogleAgenda(userId),
  buscar: fetchGlobal,
  agora: () => Date.now(),
};

export const MENSAGEM_AINDA_NA_AGENDA = "Esta reunião ainda está na agenda; para tirá-la da Google, exclua-a da agenda.";

/**
 * O erro da Google vira o motivo que a tela traduz. Erro do banco (fora do ar
 * ou não) sobe como veio. O resto, um erro que ninguém previu, também vira
 * falha da Google, com o log: o que a dona salvou já está no banco, e a
 * mutação inteira falhar a faria salvar de novo, em dobro.
 */
export function motivoSemGoogle(erro: unknown): MotivoSemGoogle {
  if (erro instanceof GoogleAgendaIndisponivel || erro instanceof GoogleAgendaNaoConectada) return "nao-conectada";
  if (erro instanceof ConexaoGoogleRevogada) return "revogada";
  if (erro instanceof RecusaDaGoogle) return "google";
  if (ehErroDeBancoIndisponivel(erro) || ehErroDoDriverDeBanco(erro)) throw erro;
  console.error(`[Google Agenda] erro inesperado com o evento: ${codigoParaLog(erro)}`);
  return "google";
}

/** O código que vai ao log: o motivo da Google ou o nome do erro, nunca a mensagem inteira. */
export function codigoParaLog(erro: unknown): string {
  if (erro instanceof RecusaDaGoogle) return `${erro.codigo}${erro.status ? ` (HTTP ${erro.status})` : ""}`;
  return erro instanceof Error ? erro.name : "desconhecido";
}

/** O token de acesso da Google Agenda da dona, ou o motivo de não haver um. */
export type AcessoDaGoogle = { token: string } | { motivo: MotivoSemGoogle };

/**
 * O token de acesso da dona para o passo da Google, lido ANTES de gravar ou
 * apagar a linha da agenda: é a leitura do banco desse passo (a conexão, em
 * server/google-agenda.ts), e o banco fora do ar aqui sobe como erro
 * (motivoSemGoogle), com nada feito. Sem a Google Agenda, o motivo.
 */
export async function acessoDaGoogle(conta: ContaDaAgenda, deps: DependenciasDaGoogle = DEPENDENCIAS_DA_GOOGLE): Promise<AcessoDaGoogle> {
  try {
    return { token: await deps.token(conta.id) };
  } catch (erro) {
    return { motivo: motivoSemGoogle(erro) };
  }
}

function linhasAfetadas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const linhas = (cabecalho as { affectedRows?: unknown } | null | undefined)?.affectedRows;
  return typeof linhas === "number" ? linhas : 0;
}

const COLUNAS_PARA_GOOGLE = {
  id: agendaReunioes.id,
  titulo: agendaReunioes.titulo,
  inicioEm: agendaReunioes.inicioEm,
  duracaoMinutos: agendaReunioes.duracaoMinutos,
  fuso: agendaReunioes.fuso,
  local: agendaReunioes.local,
  participantes: agendaReunioes.participantes,
  lembreteMinutos: agendaReunioes.lembreteMinutos,
  google: agendaReunioes.google,
  googleConvites: agendaReunioes.googleConvites,
  updatedAt: agendaReunioes.updatedAt,
};

function paraGoogle(linha: Record<string, unknown>): LinhaParaGoogle {
  return {
    id: String(linha.id),
    titulo: String(linha.titulo),
    inicioEm: Number(linha.inicioEm),
    duracaoMinutos: Number(linha.duracaoMinutos),
    fuso: String(linha.fuso),
    local: typeof linha.local === "string" ? linha.local : null,
    participantes: participantesDe(linha.participantes),
    lembreteMinutos: linha.lembreteMinutos === null || linha.lembreteMinutos === undefined ? null : Number(linha.lembreteMinutos),
    google: estadoNaGoogle(linha.google),
    googleConvites: convitesPelaGoogle(linha.googleConvites),
    updatedAt: Number(linha.updatedAt),
  };
}

const daDona = (ownerId: string, id: string) => and(eq(agendaReunioes.id, id), eq(agendaReunioes.ownerId, ownerId));
/**
 * A linha da dona, só se ela ainda for a versão da ficha (o updatedAt que foi à
 * Google) e ainda tiver estado na Google: o nulo veio da desconexão ou da troca
 * da conta Google (server/google-agenda.ts), e o envio que estava no meio,
 * pela conta anterior, não o desfaz.
 */
const naFicha = (ownerId: string, id: string, ficha: number) =>
  and(eq(agendaReunioes.id, id), eq(agendaReunioes.ownerId, ownerId), eq(agendaReunioes.updatedAt, ficha), isNotNull(agendaReunioes.google));

async function lerLinha(db: Banco, ownerId: string, id: string): Promise<LinhaParaGoogle | null> {
  const [linha] = await db.select(COLUNAS_PARA_GOOGLE).from(agendaReunioes).where(daDona(ownerId, id)).limit(1);
  return linha ? paraGoogle(linha as Record<string, unknown>) : null;
}

/** A reunião da dona como o envio precisa, para o "Tentar de novo"; NOT_FOUND quando não é dela ou saiu. */
export async function lerParaGoogle(ownerId: string, id: string): Promise<LinhaParaGoogle> {
  const linha = await lerLinha(await exigirDb(), ownerId, id);
  if (!linha) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_AGENDADA_NAO_ENCONTRADA });
  return linha;
}

/** A reunião ainda está na agenda da dona? */
export async function existeNaAgenda(ownerId: string, id: string): Promise<boolean> {
  return Boolean(await lerLinha(await exigirDb(), ownerId, id));
}

/** O evento que a Google recebe é o mesmo nas duas versões da linha? */
function mesmoEvento(a: LinhaParaGoogle, b: LinhaParaGoogle): boolean {
  return a.googleConvites === b.googleConvites && JSON.stringify(corpoDoEvento(a)) === JSON.stringify(corpoDoEvento(b));
}

type Registro = "gravado" | "mudou" | "sumiu";

/**
 * Grava o resultado da Google na linha, se ela ainda é a versão que foi para
 * lá (a ficha). Mudou no meio: o "ok" ainda vale quando o evento é o mesmo; o
 * "falhou" nunca passa por cima, porque quem mudou a linha manda a versão dele.
 * O nulo (a reunião que já acabou e não está na Google) segue o "falhou".
 */
async function registrar(db: Banco, ownerId: string, linha: LinhaParaGoogle, estado: "ok" | "falhou" | null): Promise<Registro> {
  const gravado = await db.update(agendaReunioes).set({ google: estado }).where(naFicha(ownerId, linha.id, linha.updatedAt));
  if (linhasAfetadas(gravado)) return "gravado";
  if (estado !== "ok") return "mudou";
  const atual = await lerLinha(db, ownerId, linha.id);
  if (!atual) return "sumiu";
  if (!mesmoEvento(atual, linha)) return "mudou";
  const naNovaFicha = await db.update(agendaReunioes).set({ google: estado }).where(naFicha(ownerId, linha.id, atual.updatedAt));
  return linhasAfetadas(naNovaFicha) ? "gravado" : "mudou";
}

/** O que o envio recebe de quem chama: o token já lido (marcar e mudar o leem antes de gravar) e os dublês do teste. */
export type OpcoesDoEnvio = { acesso?: AcessoDaGoogle; deps?: DependenciasDaGoogle };

/**
 * Manda a reunião para a Google Agenda da dona: cria o evento, ou o muda (ver
 * gravarEventoNaGoogle). Serve à marcação e à mudança, logo depois de o banco
 * gravar a linha como "pendente", e ao "Tentar de novo".
 *
 * Primeiro o token: o de `opcoes.acesso`, que marcar e mudar leram antes de
 * gravar, ou lido aqui, no "Tentar de novo", antes de escrever no banco. Sem a
 * Google Agenda conectada, nada sai do banco para a Google, e a reunião que
 * nunca foi para lá continua nula. Com o token, a linha fica "pendente" ANTES
 * da chamada (no "Tentar de novo"; a marcação já a gravou assim): se o
 * processo cair no meio, a exclusão ainda sabe que pode haver um evento para
 * tirar.
 *
 * A reunião que já acabou nunca é criada: a que nunca foi para lá fica de fora
 * sem chamar a Google (a tela nem oferece "Pôr na Google Agenda" a ela), e a
 * outra só muda o evento que está lá, sem avisar os convidados; o que não está
 * lá volta a nulo, como a que nunca foi.
 */
export async function enviarParaGoogle(conta: ContaDaAgenda, linha: LinhaParaGoogle, opcoes: OpcoesDoEnvio = {}): Promise<ResultadoNaGoogle> {
  const deps = opcoes.deps ?? DEPENDENCIAS_DA_GOOGLE;
  const acabou = reuniaoJaAcabou(linha, deps.agora());
  if (acabou && linha.google === null) return { naGoogle: null };
  const db = await exigirDb();
  const acesso = opcoes.acesso ?? await acessoDaGoogle(conta, deps);
  if ("motivo" in acesso) {
    // A que já foi para a Google ficou sem a versão desta linha; a que nunca foi continua nula.
    if (linha.google !== null) await registrar(db, conta.openId, linha, "falhou");
    return { naGoogle: "falhou", motivo: acesso.motivo };
  }
  if (linha.google !== "pendente") {
    const marcada = await db.update(agendaReunioes).set({ google: "pendente" }).where(daDona(conta.openId, linha.id));
    // A reunião saiu da agenda entre a leitura e aqui: nada vai à Google.
    if (!linhasAfetadas(marcada)) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_AGENDADA_NAO_ENCONTRADA });
  }
  const sessao = sessaoDaGoogle(acesso.token, () => deps.renovar(conta.id), deps.buscar);
  // O convite e os avisos de mudança só vão para a reunião que ainda vai acontecer.
  const avisarConvidados = linha.googleConvites && !acabou;
  let gravacao: "gravado" | "ausente";
  try {
    gravacao = await gravarEventoNaGoogle(sessao, linha, avisarConvidados, !acabou);
  } catch (erro) {
    const motivo = motivoSemGoogle(erro);
    console.warn(`[Google Agenda] o evento da reunião não foi gravado: ${codigoParaLog(erro)}`);
    await registrar(db, conta.openId, linha, "falhou");
    return { naGoogle: "falhou", motivo };
  }
  if (gravacao === "ausente") {
    await registrar(db, conta.openId, linha, null);
    return { naGoogle: null };
  }
  // A que já acabou não ganhou evento aqui (só mudou o que estava lá): se ela
  // sumiu no meio, o evento fica, como na exclusão dela.
  if ((await registrar(db, conta.openId, linha, "ok")) === "sumiu" && !acabou) await tirarOrfao(sessao, linha.id, avisarConvidados);
  return { naGoogle: "ok" };
}

/** A reunião saiu da agenda enquanto a Google gravava: o evento sai também. Melhor esforço, com log. */
async function tirarOrfao(sessao: SessaoDaGoogle, agendaId: string, avisarConvidados: boolean) {
  try {
    await excluirEventoNaGoogle(sessao, agendaId, avisarConvidados);
  } catch (erro) {
    console.warn(`[Google Agenda] a reunião saiu da agenda durante o envio, e o evento não foi tirado da Google: ${codigoParaLog(erro)}`);
  }
}

/**
 * Exclui a reunião da agenda da dona (excluirDaAgenda) e tira o evento da
 * Google Agenda dela. A escolha do convite volta a quem chama, para o "Tentar
 * de novo" da tela (tirarDaGoogle), já que a linha não existe mais.
 *
 * - A que já acabou sai só da WRW: o evento fica na Google como histórico, e
 *   nenhum convidado recebe o cancelamento de uma reunião que já houve.
 * - O token vem antes de apagar: o banco fora do ar ali é erro, e a reunião
 *   continua na agenda.
 * - Com o token, o evento sai mesmo com o estado nulo: a desconexão zera o
 *   estado (server/google-agenda.ts), e quem reconecta a mesma conta Google
 *   ainda tem o evento lá. O evento que não existe (404 ou 410) conta como
 *   tirado. Com o estado nulo, a falha só vai ao log: a reunião provavelmente
 *   nunca foi para lá, e a tela não tem o que dizer.
 * - A que foi para a Google, sem a Google Agenda agora (desconectada, fora de
 *   GOOGLE_AGENDA_LIBERADA_PARA ou sem as variáveis), volta "falhou" com o
 *   motivo: a tela avisa que o evento continua lá.
 */
export async function excluirComAGoogle(conta: ContaDaAgenda, id: string, deps: DependenciasDaGoogle = DEPENDENCIAS_DA_GOOGLE): Promise<{ avisarConvidados: boolean } & ResultadoNaGoogle> {
  const lida = await lerParaGoogle(conta.openId, id);
  if (reuniaoJaAcabou(lida, deps.agora())) {
    await excluirDaAgenda(conta.openId, id);
    return { avisarConvidados: false, naGoogle: null };
  }
  const acesso = await acessoDaGoogle(conta, deps);
  const { google, googleConvites: avisarConvidados } = await excluirDaAgenda(conta.openId, id);
  const foiParaGoogle = google !== null;
  if ("motivo" in acesso) {
    return foiParaGoogle ? { avisarConvidados, naGoogle: "falhou", motivo: acesso.motivo } : { avisarConvidados, naGoogle: null };
  }
  try {
    await excluirEventoNaGoogle(sessaoDaGoogle(acesso.token, () => deps.renovar(conta.id), deps.buscar), id, avisarConvidados);
  } catch (erro) {
    const motivo = motivoSemGoogle(erro);
    console.warn(`[Google Agenda] o evento da reunião excluída não saiu da Google: ${codigoParaLog(erro)}`);
    return foiParaGoogle ? { avisarConvidados, naGoogle: "falhou", motivo } : { avisarConvidados, naGoogle: null };
  }
  return { avisarConvidados, naGoogle: foiParaGoogle ? "ok" : null };
}

/**
 * Tira da Google Agenda da dona o evento de uma reunião que já saiu da agenda
 * (o "Tentar de novo" da exclusão). Sem a Google Agenda conectada, nada é
 * tentado: o motivo `nao-conectada` diz isso a quem chama.
 */
export async function tirarEventoDaGoogle(conta: ContaDaAgenda, agendaId: string, avisarConvidados: boolean, deps: DependenciasDaGoogle = DEPENDENCIAS_DA_GOOGLE): Promise<ResultadoNaGoogle> {
  try {
    const sessao = sessaoDaGoogle(await deps.token(conta.id), () => deps.renovar(conta.id), deps.buscar);
    await excluirEventoNaGoogle(sessao, agendaId, avisarConvidados);
  } catch (erro) {
    const motivo = motivoSemGoogle(erro);
    if (motivo !== "nao-conectada") console.warn(`[Google Agenda] o evento da reunião excluída não saiu da Google: ${codigoParaLog(erro)}`);
    return { naGoogle: "falhou", motivo };
  }
  return { naGoogle: "ok" };
}
