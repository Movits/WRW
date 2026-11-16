/**
 * A próxima ação na agenda da dona (H5c do plano do gravador): a regra que a
 * tela (o .ics e o link de criar evento, client/src/components/AcaoNaAgenda.tsx)
 * e o servidor (o evento na Google Agenda conectada, server/acoes-na-google.ts)
 * dividem. Nada aqui lê banco, rede ou process.env (shared/CLAUDE.md).
 *
 * - O evento é às 9h do dia do prazo, no fuso do aparelho de quem mexe na ação:
 *   a mesma hora do lembrete no sino (H15, shared/lembretes.ts). Dura 30
 *   minutos, não ocupa a agenda (aparece como livre) e avisa na hora. O livre
 *   vai nos três caminhos: transparency na API, TRANSP:TRANSPARENT no .ics e
 *   crm=AVAILABLE no link de criar evento (este, não documentado pela Google:
 *   ver linkDaGoogleAgenda).
 * - Só a ação aberta e com prazo tem evento: feita, sem prazo ou apagada, ela
 *   sai da agenda. Depois do fim do dia do prazo, a ação que não está lá não é
 *   criada (como a reunião que já acabou, na H16c): só o evento que já existe
 *   muda.
 * - O texto do evento é o da tela: os rótulos de voz ({F2}) viram o nome que a
 *   dona deu, e a voz sem nome e o "Responsável:" vêm traduzidos pela tela
 *   (RotulosDaAcaoNaAgenda), porque o servidor não escreve texto de tela.
 */
import type { EstadoNaGoogle } from "./google-agenda-eventos";
import { HORA_DO_LEMBRETE_DA_ACAO, instanteNoFuso } from "./lembretes";
import { prazoValido } from "./proximas-acoes";
import { vozesNoTexto } from "./vozes-no-texto";

/** Quanto dura o evento da ação na agenda. */
export const DURACAO_DO_EVENTO_DA_ACAO_MIN = 30;
/** O título do evento, em caracteres: o texto maior vai inteiro na descrição. */
export const TITULO_DO_EVENTO_DA_ACAO_MAX = 200;

/**
 * O que a agenda deve ter da ação:
 * - `gravar`: o evento, criado ou mudado (aberta, com o dia do prazo por vir);
 * - `atualizar`: só mudar o que já está lá, sem criar (aberta, com o dia do
 *   prazo já encerrado);
 * - `tirar`: nada (feita ou sem prazo).
 */
export type DestinoDaAcaoNaAgenda = "gravar" | "atualizar" | "tirar";

export function destinoDaAcaoNaAgenda(acao: { prazo: string | null; feita: boolean }, fuso: string, agora: number): DestinoDaAcaoNaAgenda {
  if (acao.feita || !acao.prazo || !prazoValido(acao.prazo)) return "tirar";
  // A meia-noite que fecha o dia do prazo, no fuso; fuso que o Intl não conhece
  // cai no UTC, e o evento ainda sai.
  const fimDoDia = instanteNoFuso(acao.prazo, 24, fuso) ?? instanteNoFuso(acao.prazo, 24, "UTC");
  return fimDoDia !== null && agora >= fimDoDia ? "atualizar" : "gravar";
}

/**
 * O estado na Google que a escrita da ação grava (H5c), antes de quem chama
 * falar com a Google, como a agenda faz na H16c:
 * - a que sai da agenda (feita ou sem prazo): nulo;
 * - a que vai para lá (`gravar`): "pendente" com a Google Agenda conectada;
 *   sem ela, a que estava lá fica "falhou" (a Google ficou com a versão
 *   antiga), e a que nunca foi continua nula;
 * - a do dia do prazo encerrado (`atualizar`): a que nunca foi continua nula; a
 *   que estava lá, "pendente" ou "falhou", como acima.
 */
export function estadoDaAcaoAoEscrever(destino: DestinoDaAcaoNaAgenda, antes: EstadoNaGoogle | null, naGoogle: boolean): EstadoNaGoogle | null {
  if (destino === "tirar") return null;
  if (destino === "atualizar" && antes === null) return null;
  if (naGoogle) return "pendente";
  return antes === null ? null : "falhou";
}

/** O início do evento da ação: às 9h do dia do prazo, no fuso dado (UTC, se o Intl não o conhece). Prazo inválido: null. */
export function inicioDoEventoDaAcao(prazo: string, fuso: string): number | null {
  return instanteNoFuso(prazo, HORA_DO_LEMBRETE_DA_ACAO, fuso) ?? instanteNoFuso(prazo, HORA_DO_LEMBRETE_DA_ACAO, "UTC");
}

/**
 * Os rótulos do evento, já traduzidos pela tela, com o lugar do valor marcado:
 * `voz` é "Falante {n}" (a voz sem nome), e `responsavel`, "Responsável: {nome}".
 * Os mesmos da lista (meetings.speakerLabel e proximasAcoes.owner).
 */
export type RotulosDaAcaoNaAgenda = { voz: string; responsavel: string };

export const ROTULO_DA_AGENDA_MAX = 80;

/** O rótulo serve quando tem o lugar do valor e cabe no limite. */
export function rotulosDaAgendaValidos(rotulos: { voz?: unknown; responsavel?: unknown } | null | undefined): rotulos is RotulosDaAcaoNaAgenda {
  return !!rotulos
    && typeof rotulos.voz === "string" && rotulos.voz.length <= ROTULO_DA_AGENDA_MAX && rotulos.voz.includes("{n}")
    && typeof rotulos.responsavel === "string" && rotulos.responsavel.length <= ROTULO_DA_AGENDA_MAX && rotulos.responsavel.includes("{nome}");
}

/**
 * Sem os rótulos da tela (a aba aberta antes do deploy, que não os manda): a voz
 * sem nome sai como o rótulo cru, sem as chaves ("F2"), e o responsável, só com
 * o nome. Nenhuma frase em português escrita pelo servidor.
 */
export const ROTULOS_SEM_TRADUCAO: RotulosDaAcaoNaAgenda = { voz: "F{n}", responsavel: "{nome}" };

/** O que o texto do evento precisa da ação: os textos e os nomes das vozes (vazio quando ela não está presa ao item). */
export type AcaoParaAgenda = {
  texto: string;
  detalhe: string | null;
  responsavel: string | null;
  vozes: Readonly<Record<string, string>>;
};

/** Troca o lugar do valor pelo valor, por função: um nome com "$&" sai como está. */
function preencher(rotulo: string, lugar: string, valor: string): string {
  return rotulo.split(lugar).join(valor);
}

/**
 * O título e a descrição do evento: o texto da ação (cortado no título, se
 * passa do limite, e então inteiro na descrição), o detalhe, o responsável e o
 * endereço da ação na WRW, um por parágrafo. O título vazio (só espaços) não
 * acontece: a ação exige texto.
 */
export function textosDaAcaoNaAgenda(
  acao: AcaoParaAgenda,
  rotulos: RotulosDaAcaoNaAgenda,
  endereco: string | null,
): { titulo: string; descricao: string } {
  const comVozes = (texto: string) => vozesNoTexto(texto, acao.vozes, numero => preencher(rotulos.voz, "{n}", String(numero))).trim();
  const texto = comVozes(acao.texto);
  const caracteres = Array.from(texto);
  const cortado = caracteres.length > TITULO_DO_EVENTO_DA_ACAO_MAX;
  const titulo = cortado ? `${caracteres.slice(0, TITULO_DO_EVENTO_DA_ACAO_MAX - 1).join("")}…` : texto;
  const paragrafos: string[] = [];
  if (cortado) paragrafos.push(texto);
  const detalhe = acao.detalhe ? comVozes(acao.detalhe) : "";
  if (detalhe) paragrafos.push(detalhe);
  const responsavel = acao.responsavel ? comVozes(acao.responsavel) : "";
  if (responsavel) paragrafos.push(preencher(rotulos.responsavel, "{nome}", responsavel));
  if (endereco) paragrafos.push(endereco);
  return { titulo, descricao: paragrafos.join("\n\n") };
}

/** O UID do .ics da ação: o mesmo a cada download, e outro que o das reuniões da agenda. */
export function uidDoIcsDaAcao(acaoId: string): string {
  return `acao-${acaoId}@wrwglobal.org`;
}
