/**
 * A conexão da dona com a Google Agenda (H16b do plano do gravador): os
 * caminhos das duas rotas do servidor (server/rotas-da-google-agenda.ts) e o
 * resultado que a volta da Google traz ao Perfil em `?google=`, que a tela
 * traduz (client/src/components/ConexaoGoogleAgenda.tsx). Nada aqui lê o
 * ambiente: o mesmo código roda no navegador.
 *
 * A ida e a volta são navegação de página inteira (um `<a href>`, nunca o Link
 * do wouter nem um popup): a CSP não muda, e o COOP same-origin do servidor
 * cortaria a conversa com uma janela da Google.
 */

/** A dona toca em "Conectar": o servidor manda à Google, com o state e o PKCE. */
export const ROTA_CONECTAR_GOOGLE_AGENDA = "/api/google-agenda/conectar";
/** A Google volta aqui (o URI de retorno cadastrado no Google Cloud). */
export const ROTA_RETORNO_GOOGLE_AGENDA = "/api/google-agenda/retorno";

/** O Perfil, onde fica a seção da Google Agenda (a rota está em client/src/App.tsx). */
export const ROTA_DO_PERFIL = "/profile";
export const PARAMETRO_DO_RESULTADO_GOOGLE = "google";

/**
 * O que a volta da Google deixa no Perfil:
 * - `conectada`: a conexão foi gravada;
 * - `negada`: a dona não autorizou na tela da Google;
 * - `sem-permissao`: ela desmarcou a permissão da agenda (o token sai revogado);
 * - `expirou`: passou do prazo da ida (10 min) ou o cookie da ida sumiu;
 * - `erro`: qualquer outra falha (cookie adulterado, conta trocada no meio,
 *   Google ou banco fora do ar);
 * - `erro-acesso-ficou`: a conexão não foi feita, e a Google não confirmou a
 *   revogação da autorização que a dona acabou de dar (a WRW não guardou o
 *   token, mas a autorização pode seguir na conta Google dela);
 * - `endereco`: a dona começou por um endereço que não é o do FRONTEND_URL, e
 *   a volta cairia em outro host, sem o cookie da ida.
 */
export const RESULTADOS_DA_GOOGLE_AGENDA = ["conectada", "negada", "sem-permissao", "expirou", "erro", "erro-acesso-ficou", "endereco"] as const;
export type ResultadoDaGoogleAgenda = (typeof RESULTADOS_DA_GOOGLE_AGENDA)[number];

export function rotaDoResultadoNoPerfil(resultado: ResultadoDaGoogleAgenda): string {
  return `${ROTA_DO_PERFIL}?${PARAMETRO_DO_RESULTADO_GOOGLE}=${resultado}`;
}

/** O resultado da busca da URL (com ou sem o "?"), ou null se não há ou é desconhecido. */
export function lerResultadoDaGoogleAgenda(busca: string): ResultadoDaGoogleAgenda | null {
  const valor = new URLSearchParams(busca).get(PARAMETRO_DO_RESULTADO_GOOGLE);
  return valor && (RESULTADOS_DA_GOOGLE_AGENDA as readonly string[]).includes(valor) ? valor as ResultadoDaGoogleAgenda : null;
}

/** Por que a conexão parou de funcionar (google_agenda_conexoes.falha). */
export const FALHAS_DA_CONEXAO_GOOGLE = ["revogada"] as const;
export type FalhaDaConexaoGoogle = (typeof FALHAS_DA_CONEXAO_GOOGLE)[number];
