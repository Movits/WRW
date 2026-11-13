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

export function rotaDaReuniao(id: string) {
  return `${ROTA_DAS_REUNIOES}/${encodeURIComponent(id)}`;
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
