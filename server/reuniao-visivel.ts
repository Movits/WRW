import { and, ne } from "drizzle-orm";
import { meetings } from "../drizzle/schema";

/**
 * A reunião que a dona vê, na consulta: hoje, a que não está no meio da
 * exclusão ('deleted').
 *
 * Um ponto só para a regra, para a lixeira caber sem refazer quem consulta: a
 * parte 1 do Pacote 5b (H7d, pastas e lixeira) traz um server/reuniao-visivel.ts
 * com esta mesma função (o mesmo nome e o mesmo tipo de retorno, o do `and`),
 * que acrescenta a reunião na lixeira (`trashed_at` nulo), e mais funções. Na
 * junção dos dois, fica o arquivo de lá. O código da pergunta a várias reuniões
 * (H6c, server/perguntar-a-varias-reunioes.ts) e o da legenda ao vivo (G15b,
 * server/legenda-ao-vivo.ts) só usam `reuniaoVisivel()`, dentro do `and` do
 * WHERE de cada consulta de reuniões, e nunca decidem em JS pela lixeira: assim
 * a regra nova vale neles sem mexer numa linha.
 */
export function reuniaoVisivel() {
  return and(ne(meetings.status, "deleted"));
}
