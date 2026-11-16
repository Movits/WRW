# Vitrine pública

Página estática de apresentação da WRW — Women Rocking the World (a marca desde
15/09/2026), publicada no GitHub Pages.

Não é a aplicação. O Pages entrega apenas arquivos prontos ao navegador — não roda
servidor nem banco — e login, matches por IA, cofre e upload dependem dos dois. Esta
página existe para o projeto ter um endereço público enquanto a hospedagem de verdade
não é definida (ver **D6** em `docs/arquitetura/decisoes-em-aberto.md`).

## Ligar o Pages — precisa de acesso de administrador

Só uma vez, e são dois cliques:

1. **Settings** → **Pages**
2. Em **Build and deployment** → **Source**, escolher **GitHub Actions**

Pronto. O fluxo em `.github/workflows/pages.yml` publica sozinho a cada mudança em
`vitrine/`, e o site fica em **https://movits.github.io/WRW/**.

Esse passo não dá para automatizar: foi tentado com o parâmetro `enablement` da
ação `configure-pages`, e o token do fluxo recebe *Resource not accessible by
integration*. Criar o site exige acesso de administrador de verdade.

Para publicar sem esperar uma alteração: aba **Actions** → *Publicar vitrine no
GitHub Pages* → **Run workflow**.

## Endereço

O endereço segue o nome do repositório. Quando o repositório passou de `Movits/MMM`
a `Movits/WRW`, o antigo **https://movits.github.io/MMM/** deixou de responder: o
GitHub redireciona links do repositório e o remote do git, mas não o endereço do
Pages. Se o repositório mudar de nome de novo ou passar para uma organização, troque
junto os links e o `og:image` de `index.html`.

## Editar

`index.html` é um arquivo só, com o CSS embutido e sem etapa de build — dá para abrir
direto no navegador para conferir. A ilustração `hero-women.svg` é a mesma da home da
aplicação. As artes de `brand/` são cópias, com o mesmo nome, das que a vitrine usa de
`client/public/brand/` (geradas dos originais em `docs/identidade-visual/wrw/`): troque
nas duas pastas juntas.

Quando a hospedagem estiver de pé, trocar a nota do fim da página por um botão
"Entrar na plataforma" apontando para o endereço real.
