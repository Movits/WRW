// Cria todas as tabelas da WRW num banco MySQL vazio.
//
// Hoje é um atalho para `node scripts/migrar.mjs`: o schema vive nas migrações
// de drizzle/, geradas a partir de drizzle/schema.ts, e este script só mantém o
// nome que os documentos e o CI já conhecem.
//
// A história importa para quem chegar depois. Este script já aplicou um
// `scripts/schema-completo.sql` mantido à mão, porque o histórico do drizzle
// tinha morrido (parou na migração 0002 com 15 tabelas contra 50 do schema, e
// `db:push` gerava DROP). Manter aquele SQL à mão custou caro: um bloco novo
// foi colado sem o separador de comandos e todo banco criado do zero passou a
// nascer sem as tabelas do consentimento. O histórico foi refundado — baseline
// 0000_fundacao — e o arquivo à mão deixou de existir. Mudança de banco agora
// é `pnpm db:generate` seguido de `pnpm db:migrate`, nunca SQL editado direto.
//
// Uso:
//   DATABASE_URL='mysql://...' node scripts/criar-banco.mjs
//
// É seguro rodar de novo: o que já foi aplicado não roda outra vez.

import { migrar } from "./migrar.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL não definida.\n\n" +
      "Exemplo:\n" +
      `  DATABASE_URL='mysql://usuario:senha@host:3306/defaultdb?ssl={"rejectUnauthorized":false}' \\\n` +
      "    node scripts/criar-banco.mjs\n"
  );
  process.exit(1);
}

let resultado;
try {
  resultado = await migrar(url);
} catch (erro) {
  console.error(`\nNão consegui aplicar as migrações: ${erro.message}\n`);
  if (erro.code === "ENOTFOUND" || erro.code === "ETIMEDOUT") {
    console.error("O endereço não respondeu. Confira o host e a porta da URL.");
  } else if (erro.code === "ER_ACCESS_DENIED_ERROR") {
    console.error("Usuário ou senha recusados. Copie a URI de novo do painel do provedor.");
  } else if (/SSL|certificate|secure/i.test(erro.message)) {
    console.error('O banco exige TLS. Acrescente ?ssl={"rejectUnauthorized":false} ao final da DATABASE_URL.');
  }
  process.exit(1);
}

if (!resultado.ok) process.exit(1);
console.log("Banco pronto. Agora aponte a DATABASE_URL do servidor para ele.");
