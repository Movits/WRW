// Define a senha de uma conta em banco LOCAL de desenvolvimento.
//
// Existe porque a recuperação de senha do app depende do Resend, que não está
// configurado aqui: sem isto, uma conta de teste cujo dono esqueceu a senha
// fica inacessível para sempre, e não há como ver as telas logadas.
//
// A senha vem de quem roda o comando e é gravada com o mesmo bcrypt de custo 12
// que o registro usa (server/routers/auth.ts:142) — não há atalho, nem senha
// padrão embutida, nem senha escrita neste arquivo.
//
// Uso:
//   DATABASE_URL='mysql://root:root@127.0.0.1:3306/wrw_dev' \
//     node scripts/definir-senha-local.mjs nicolas.demo@local.test 'a-senha-que-voce-escolher'
//
// TRAVA: recusa a rodar contra qualquer banco que não seja local. Trocar a senha
// de alguém em produção seria tomar a conta dessa pessoa.

import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";

const [email, senha] = process.argv.slice(2);

if (!email || !senha || !process.env.DATABASE_URL) {
  console.error("Uso: DATABASE_URL='mysql://...' node scripts/definir-senha-local.mjs email 'senha'");
  process.exit(1);
}
if (senha.length < 8) {
  console.error("A senha precisa de pelo menos 8 caracteres — é a regra do registro.");
  process.exit(1);
}

const url = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
  console.error(`Recusado: ${url.hostname} não é um banco local.`);
  console.error("Este script só serve para desbloquear conta de teste na sua máquina.");
  process.exit(1);
}

const conexao = await mysql.createConnection(process.env.DATABASE_URL);
try {
  const [[usuaria]] = await conexao.query("SELECT id, name, role, isActive FROM users WHERE email = ?", [email]);
  if (!usuaria) {
    console.error(`Nenhuma conta com o e-mail ${email}.`);
    process.exit(1);
  }

  await conexao.query("UPDATE users SET passwordHash = ? WHERE id = ?", [await bcrypt.hash(senha, 12), usuaria.id]);

  console.log(`Senha definida para ${usuaria.name} <${email}>.`);
  console.log(`  nível: ${usuaria.role}    conta ativa: ${usuaria.isActive ? "sim" : "NÃO — o login vai recusar"}`);
  console.log("\nAgora entre em http://localhost:3100/login com este e-mail e a senha que você escolheu.");
} catch (erro) {
  console.error("Falhou:", erro.message);
  process.exitCode = 1;
} finally {
  await conexao.end();
}
