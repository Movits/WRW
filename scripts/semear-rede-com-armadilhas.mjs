// Semeia a REDE COM ARMADILHAS (N8) na rede particular de UMA usuária, num banco LOCAL, para ver na tela o que o
// motor privado faz com paráfrases, sinônimos, erros de digitação, concorrentes, palavra solta e serviço sem
// demanda declarada. Os dados e o gabarito ficam em scripts/rede-de-teste/rede-com-armadilhas.json; a medida sem
// banco é o teste server/rede-com-armadilhas.test.ts. Como ler: docs/medir-o-match.md.
//
// Uso (Git Bash, da raiz do repositório):
//   DATABASE_URL='mysql://root:root@127.0.0.1:3307/wrw_dev' node scripts/semear-rede-com-armadilhas.mjs email@da.usuaria
//   DATABASE_URL='mysql://root:root@127.0.0.1:3307/wrw_dev' node scripts/semear-rede-com-armadilhas.mjs email@da.usuaria --limpar
//
// TRAVA: recusa qualquer banco que não seja local (localhost, 127.0.0.1, ::1), como o definir-senha-local.mjs.
// Todos os contatos são fictícios e levam a marca "[N8]" no cargo; `--limpar` apaga SÓ esses contatos (e os itens
// e sugestões deles), não a rede inteira da usuária. Rodar de novo troca a rede com armadilhas anterior pela atual.

import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { slugDaTag } from "./rede-de-teste/slug.mjs";

const MARCA = "[N8]";
const email = process.argv[2];
const limpar = process.argv.includes("--limpar");

if (!email || email.startsWith("--") || !process.env.DATABASE_URL) {
  console.error("Uso: DATABASE_URL='mysql://...' node scripts/semear-rede-com-armadilhas.mjs email@da.usuaria [--limpar]");
  process.exit(1);
}

const url = new URL(process.env.DATABASE_URL);
const host = url.hostname.replace(/^\[|\]$/g, "");
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`Recusado: ${host} não é um banco local.`);
  console.error("A rede com armadilhas é só para o banco da sua máquina.");
  process.exit(1);
}

const rede = JSON.parse(readFileSync(new URL("./rede-de-teste/rede-com-armadilhas.json", import.meta.url), "utf8"));

// Cada contato recebe o que oferece e o que procura em todos os pares do gabarito em que aparece, sem repetir.
const itensPorContato = new Map();
const acrescentar = (id, lado, item) => {
  const itens = itensPorContato.get(id) ?? { possui: new Map(), procura: new Map() };
  itens[lado].set(slugDaTag(item.rotulo), item);
  itensPorContato.set(id, itens);
};
for (const par of rede.pares) {
  acrescentar(par.oferta.contato, "possui", par.oferta);
  acrescentar(par.procura.contato, "procura", par.procura);
}

const conexao = await mysql.createConnection(process.env.DATABASE_URL);
try {
  const [[usuaria]] = await conexao.query("SELECT id, openId, name FROM users WHERE email = ?", [email]);
  if (!usuaria) {
    console.error(`Nenhuma usuária com o e-mail ${email}.`);
    process.exitCode = 1;
  } else {
    const dono = usuaria.openId;
    const [antigos] = await conexao.query("SELECT id FROM private_contacts WHERE ownerId = ? AND jobTitle LIKE ?", [dono, `%${MARCA}`]);
    const ids = antigos.map(linha => linha.id);
    if (ids.length > 0) {
      await conexao.query("DELETE FROM ai_match_suggestions WHERE owner_id = ? AND (contact_a_id IN (?) OR contact_b_id IN (?))", [dono, ids, ids]);
      await conexao.query("DELETE FROM contact_assets WHERE owner_id = ? AND contact_id IN (?)", [dono, ids]);
      await conexao.query("DELETE FROM contact_needs WHERE owner_id = ? AND contact_id IN (?)", [dono, ids]);
      await conexao.query("DELETE FROM private_contacts WHERE ownerId = ? AND id IN (?)", [dono, ids]);
    }
    if (limpar) {
      console.log(`Limpo: ${ids.length} contatos da rede com armadilhas de ${usuaria.name}.`);
    } else {
      const agora = Date.now();
      let contatos = 0, itens = 0;
      for (const [id, dados] of Object.entries(rede.contatos)) {
        const doContato = itensPorContato.get(id);
        if (!doContato) continue;
        const [inserido] = await conexao.query(
          "INSERT INTO private_contacts (ownerId, fullName, jobTitle, company, country, city, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'BR', ?, ?, ?)",
          [dono, `Contato Fictício ${id.slice(1)}`, `${dados.cargo} ${MARCA}`, dados.empresa, dados.cidade, agora, agora],
        );
        contatos++;
        for (const [slug, item] of doContato.possui) {
          await conexao.query(
            "INSERT INTO contact_assets (owner_id, contact_id, tag_slug, tag_label, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [dono, inserido.insertId, slug, item.rotulo, item.categoria, agora, agora],
          );
          itens++;
        }
        for (const [slug, item] of doContato.procura) {
          await conexao.query(
            "INSERT INTO contact_needs (owner_id, contact_id, tag_slug, tag_label, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [dono, inserido.insertId, slug, item.rotulo, item.categoria, agora, agora],
          );
          itens++;
        }
      }
      console.log(`Rede com armadilhas criada para ${usuaria.name}: ${contatos} contatos e ${itens} itens.`);
      console.log('Abra "Matches Inteligentes" e clique em "Atualizar matches"; compare com o gabarito em docs/medir-o-match.md.');
      console.log(`Para desfazer: node scripts/semear-rede-com-armadilhas.mjs ${email} --limpar`);
    }
  }
} catch (erro) {
  console.error("Falhou:", erro.message);
  process.exitCode = 1;
} finally {
  await conexao.end();
}
