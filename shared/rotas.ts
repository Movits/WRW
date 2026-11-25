/**
 * Caminhos das telas de Reuniões. O client (destino do login, item Reuniões do
 * menu, botão do Dashboard, indicador e atalho do Meu Network Inteligente e a
 * navegação da própria página) e o servidor (o link da Memória) montam os
 * caminhos a partir daqui. Só as três rotas do App.tsx os escrevem à mão (o
 * teste do cabeçalho lê `path="..."` literal; outro teste confere que as rotas
 * batem com estas constantes): mudou um caminho aqui, mude lá também. Os testes
 * de tela conferem os endereços literais de propósito, para o endereço público
 * não mudar sem querer.
 *
 * `/gravar` é o link do gravador e a primeira tela depois do login (pedido da
 * cliente de 20/10/2026). A lista continua em `/meetings`, o endereço que já
 * existia, para os favoritos e links salvos seguirem valendo. O href gravado nos
 * documentos da Memória não prende o nome: a tela abre a reunião pelo
 * `metadata.meetingId` (client/src/lib/destino-da-fonte.ts).
 */
export const ROTA_GRAVAR = "/gravar";
export const ROTA_DAS_REUNIOES = "/meetings";

/**
 * O detalhe de uma reunião. As opções abrem a tela já num ponto: `t` é o
 * segundo de uma fala (o player vai até ele), `q` o termo buscado na
 * transcrição e `item` o id de um item do resumo guardado (a aba Resumo abre
 * nele, destacado). Servem aos links da busca entre reuniões (H7) e das próximas
 * ações (H5); a tela os lê pelo useSearch (client/src/pages/Meetings.tsx). Sem
 * opções, é o endereço de sempre, que o aviso de reunião pronta no sino (H15)
 * usa e pelo qual ele sai quando a reunião é excluída (server/lembretes.ts).
 */
export function rotaDaReuniao(id: string, opcoes: { t?: number; q?: string; item?: string } = {}) {
  const caminho = `${ROTA_DAS_REUNIOES}/${encodeURIComponent(id)}`;
  const busca = new URLSearchParams();
  // A tela só pula com t > 0: o começo da reunião não é um ponto.
  if (typeof opcoes.t === "number" && Number.isFinite(opcoes.t) && opcoes.t > 0) busca.set("t", String(opcoes.t));
  const termo = opcoes.q?.trim();
  if (termo) busca.set("q", termo);
  if (opcoes.item) busca.set("item", opcoes.item);
  const consulta = busca.toString();
  return consulta ? `${caminho}?${consulta}` : caminho;
}

/**
 * A lixeira das reuniões (H7d): a mesma página da lista, com `?lixeira=1`.
 * Pela URL, e não por estado da tela: o voltar do celular sai da lixeira para
 * a lista, e a lixeira abre mesmo quando a lista está vazia (todas as reuniões
 * foram para lá).
 */
export const PARAMETRO_DA_LIXEIRA = "lixeira";

export function rotaDaLixeira() {
  return `${ROTA_DAS_REUNIOES}?${PARAMETRO_DA_LIXEIRA}=1`;
}

/**
 * A agenda de reuniões (H16a): as reuniões marcadas, com convite e .ics. O
 * "Gravar agora" de uma delas abre o gravador com `?agendada=<id>`: o título
 * vem preenchido, e a gravação fica ligada à reunião marcada (Meetings.tsx).
 */
export const ROTA_DA_AGENDA = "/agenda";
export const PARAMETRO_DA_AGENDADA = "agendada";

export function rotaGravarDaAgenda(agendaId: string) {
  return `${ROTA_GRAVAR}?${PARAMETRO_DA_AGENDADA}=${encodeURIComponent(agendaId)}`;
}

/**
 * O link aberto de uma reunião (pedido do Roberto em 12/11/2026, "por
 * enquanto"): quem recebe o endereço ouve, lê e pergunta à IA sem conta na WRW.
 * Curto porque viaja em mensagem de WhatsApp e de e-mail, e não muda: os links
 * já enviados dependem dele. O servidor marca a página como fora dos buscadores
 * (server/link-aberto-da-reuniao.ts).
 */
export const ROTA_DA_REUNIAO_ABERTA = "/r";

export function rotaDaReuniaoAberta(token: string) {
  return `${ROTA_DA_REUNIAO_ABERTA}/${encodeURIComponent(token)}`;
}

/**
 * O convite para participar de uma reunião (R1b): /convite/{token}, só logada.
 * A página mostra o título, o nome da dona e o aviso, e "Entrar na reunião".
 */
export const ROTA_DO_CONVITE = "/convite";

export function rotaDoConvite(token: string) {
  return `${ROTA_DO_CONVITE}/${encodeURIComponent(token)}`;
}

/**
 * A reunião compartilhada com a participante (R1b): a leitura dela, sem os
 * controles da dona. Fica fora de /meetings/:id, que é o detalhe da dona.
 */
export const ROTA_DA_REUNIAO_COMPARTILHADA = "/reunioes-compartilhadas";

export function rotaDaReuniaoCompartilhada(id: string) {
  return `${ROTA_DA_REUNIAO_COMPARTILHADA}/${encodeURIComponent(id)}`;
}

/**
 * O espaço de equipe (R2): /equipes/{id da pasta}, com as reuniões, as
 * tarefas, a agenda e as membras, para a dona e para as membras.
 */
export const ROTA_DAS_EQUIPES = "/equipes";

export function rotaDaEquipe(pastaId: string) {
  return `${ROTA_DAS_EQUIPES}/${encodeURIComponent(pastaId)}`;
}

/** A reunião da equipe, lida pela membra (a mesma leitura da participante, R1b). */
export function rotaDaReuniaoDaEquipe(pastaId: string, meetingId: string) {
  return `${rotaDaEquipe(pastaId)}/reunioes/${encodeURIComponent(meetingId)}`;
}

/** O convite para uma equipe (R2): /convite-da-equipe/{token}, só logada. */
export const ROTA_DO_CONVITE_DA_EQUIPE = "/convite-da-equipe";

export function rotaDoConviteDaEquipe(token: string) {
  return `${ROTA_DO_CONVITE_DA_EQUIPE}/${encodeURIComponent(token)}`;
}
