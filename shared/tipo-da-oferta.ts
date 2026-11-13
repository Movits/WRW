/**
 * O TIPO do que alguém tem a oferecer — a classificação que a regra da demanda
 * expressa exige antes de qualquer cruzamento (pedido do Nicolas, 12/09/2026).
 *
 * O problema que ela resolve: quem registrava um SERVIÇO em "o que tenho"
 * ("Advocacia tributária") casava com meia rede, porque quase toda empresa
 * "poderia precisar" de um tributarista — e o motor tratava essa necessidade
 * presumida como se fosse declarada. A regra: serviço só casa com quem
 * DECLAROU precisar dele (ou de solução equivalente) em "o que preciso".
 * Setor, atividade econômica, porte, localização, cargo, problemas típicos do
 * segmento, obrigações legais e utilidade provável não são necessidade: podem
 * subir a nota de um match que já passou pelo portão, nunca criá-lo.
 *
 * Os nove tipos são os do pedido. Só "servico" muda comportamento (é o
 * portão); os outros existem para o motor e a IA falarem o mesmo vocabulário e
 * para a regra não vazar para produtos, ativos, investimento, conexões etc.,
 * que continuam casando como antes.
 *
 * DISCIPLINA — a mesma de direcao-do-termo.ts: listas curadas em pt/en/es, a
 * decisão pela CABEÇA do termo (a primeira palavra depois dos marcadores
 * fracos "oferece", "tem", "possui", dos artigos e do genitivo), e na dúvida
 * "outros", que devolve o comportamento anterior. Classificar errado como
 * serviço apaga um match legítimo por categoria; classificar errado como outra
 * coisa deixa passar um presumido. Entre os dois, a lista de serviço só tem
 * palavra que nomeia inequivocamente uma prestação profissional. Logística,
 * transporte, frete e armazenagem SÃO serviço, por decisão do Nicolas em
 * 14/09/2026 ("Logística conta como serviço sim"): até ali ficavam de fora
 * como capacidade operacional, e quem oferecia frete casava por categoria com
 * qualquer um que tivesse "Logística" na ficha. O que continua fora é o bem
 * físico — "Armazém", "Galpão" e "Frota" são imóvel e ativo, e
 * "Armazenamento" e "storage" também, porque são dados e energia antes de
 * serem logística. Papéis de comércio (fornecedor, distribuidor,
 * representante) também não: são quem TEM a mercadoria, e o núcleo do termo
 * já os atravessa até ela.
 *
 * Ordem da decisão, e por quê (ver `classificarOferta`):
 *   1. composto em inglês cuja última palavra é de outro tipo ("Marketing
 *      platform", "Accounting software", "Training materials"): a cabeça é a
 *      última palavra, o serviço é só o assunto;
 *   2. substantivo de serviço COLADO à cabeça, sem preposição nem conjunção
 *      no meio ("Tax consulting", "Customs brokerage", "Real estate
 *      consulting"): em inglês o substantivo do serviço vem depois;
 *   3. composto fixo de duas palavras ("real estate", "venture capital");
 *   3b. "Direito" seguido de área curada ("Direito tributário", "Direito do
 *      trabalho") é a especialidade do advogado, serviço pelo texto; fora das
 *      áreas curadas ("Direito minerário", "Direito creditório") segue a ordem;
 *   4. cabeça genérica "serviços"/"prestação": o complemento decide
 *      ("Serviços de logística" é logística, "Serviços de tradução" é serviço);
 *   5. a cabeça do termo, quando é palavra de um tipo ("Software de
 *      consultoria" é tecnologia: a cabeça manda);
 *   6. cabeça neutra (empresa, escritório, despacho...): o complemento pelo
 *      genitivo decide ("Escritório de advocacia", "Escritório jurídico";
 *      "Escritório para advogados" não — "para" não é genitivo);
 *   6b. escrita sem fronteira de palavra (chinês, japonês): vocabulário pelo
 *      FIM do termo, onde as duas línguas põem a cabeça (`SERVICOS_SEM_ESPACO`);
 *   7. a categoria que a usuária digitou ("Jurídico", "Marketing", "Produto";
 *      palavra específica de serviço decide, o genérico "serviços" cede a
 *      outro tipo: "Serviços financeiros" é capital) — assim por decisão do
 *      time em 14/09, ver o passo 7 de `classificarOferta`;
 *   8. "outros".
 * Por fim, revenda de marca colada à cabeça ("Consultora Natura") não é serviço.
 * Cabeça desconhecida seguida de preposição ou conjunção fica com o que ela
 * é: "Peças DE manutenção" é produto, "Centro DE treinamento" é
 * infraestrutura, "Mina E consultoria mineral" é a mina — o serviço ali é
 * modificador ou outro item, e tratá-lo como tipo apagava o match por
 * categoria que esses itens tinham (revisões adversariais de 12/09).
 */
import { ARTIGOS, ehLugar, GENITIVOS as GENITIVOS_DO_TERMO, MARCADORES_FRACOS, tokensDoTermo as tokensDoTermoBase } from "./direcao-do-termo";

/**
 * O "d'" do francês ("Cabinet D'avocats", "Avocat D'affaires", "Conseil D'administration") vira uma palavra
 * própria, com o apóstrofo modificador (U+02BC, que é letra e não se separa): sem isso ele virava o "d" solto, o
 * mesmo de "R&D", "P&D", "D&I" e "I+D" — e com o "d" no genitivo "R&D consulting" deixava de ser serviço e
 * "Consultoría en I+D" perdia a especialidade (revisão de 15/09 do porte da 9e027bf). Todas as leituras deste
 * arquivo passam por aqui; a direção do termo não lê francês e segue com a sua.
 */
const D_APOSTROFO = "dʼ";
const APOSTROFO_DO_D = new RegExp("(^|[^\\p{L}\\p{M}\\p{N}])[dD]['\\u2019](?=\\p{L})", "gu");
const tokensDoTermo = (texto: string) => tokensDoTermoBase(texto.replace(APOSTROFO_DO_D, `$1${D_APOSTROFO} `));

/**
 * O genitivo do analisador de termo e o do francês ("Cabinet D'avocats", "Conseil en fiscalité DES entreprises"):
 * sem "d'", "du" e "des", o complemento da cabeça neutra parava no apóstrofo (9e027bf da #127, revisão de 14/09).
 * Fica só aqui, porque a direção do termo não lê francês. O "d" solto não entra: é o de "R&D" (ver `D_APOSTROFO`).
 */
const GENITIVOS: ReadonlySet<string> = new Set([...Array.from(GENITIVOS_DO_TERMO), D_APOSTROFO, "du", "des"]);

export type TipoDaOferta =
  | "servico"
  | "produto"
  | "ativo"
  | "oportunidade"
  | "investimento"
  | "conexao"
  | "tecnologia"
  | "imovel"
  | "outros";

/** Os nove tipos, na ordem do pedido, com o rótulo que a IA e a documentação usam. */
export const TIPOS_DA_OFERTA: ReadonlyArray<{ tipo: TipoDaOferta; rotulo: string }> = [
  { tipo: "servico", rotulo: "Serviço" },
  { tipo: "produto", rotulo: "Produto" },
  { tipo: "ativo", rotulo: "Ativo" },
  { tipo: "oportunidade", rotulo: "Oportunidade" },
  { tipo: "investimento", rotulo: "Investimento/Capital" },
  { tipo: "conexao", rotulo: "Conexão/Network" },
  { tipo: "tecnologia", rotulo: "Tecnologia" },
  { tipo: "imovel", rotulo: "Imóvel/Infraestrutura" },
  { tipo: "outros", rotulo: "Outros" },
];

// Tudo abaixo está normalizado (minúsculas, sem acento), como as listas de
// direcao-do-termo.ts. Cada palavra pertence a UM tipo só — o teste do módulo
// confere, porque uma repetição sobrescreveria a anterior em silêncio.

/**
 * As palavras de serviço do alemão e do francês, à parte porque são latinas: é
 * por elas (e pelas palavras de ligação) que `palavrasPorIdioma` reconhece esses
 * dois idiomas (o russo, o hindi, o árabe, o chinês e o japonês se reconhecem
 * pela escrita; e6ddfa4 e 116bb56 da #127). A normalização já tirou o trema
 * ("Übersetzung" vira "ubersetzung"), então as formas aqui são as normalizadas.
 */
const ASSESSORIA_EM_FRANCES_E_ALEMAO = [
  // de — com os femininos em -in ("Steuerberaterin gesucht") e "Kanzlei", que eram a forma usual que faltava
  // (revisão de 15/09 na #127, 116bb56). Os adjetivos com as terminações de caso ("Juristische Person", "juristischer
  // Beistand") estão também em ADJETIVOS_ANTEPOSTOS (9e027bf).
  "beratung", "beratungen", "berater", "beraterin", "unternehmensberatung",
  "rechtsberatung", "rechtsanwalt", "rechtsanwalte", "rechtsanwaltin", "anwalt", "anwalte", "anwaltin",
  "kanzlei", "anwaltskanzlei", "rechtsanwaltskanzlei", "steuerkanzlei",
  "juristisch", "juristische", "juristischer", "juristischen", "juristisches", "buchhaltung", "buchfuhrung", "buchhalter", "buchhalterin",
  "steuerberatung", "steuerberater", "steuerberaterin", "wirtschaftsprufung", "wirtschaftsprufer", "wirtschaftspruferin",
  // fr — "conseiller" de órgão ("Conseiller municipal") sai da classificação, ver `semConselhoDeOrgao`
  "conseil", "conseils", "consultante", "conseiller", "conseillers", "conseillere", "conseilleres", "avocat", "avocats", "avocate",
  "juriste", "juristes", "juridique", "juridiques", "comptabilite", "comptable", "comptables", "auditeur", "auditeurs",
];
const OUTROS_SERVICOS_EM_FRANCES_E_ALEMAO = [
  // de — "Dienstleistungen" é o "serviços" genérico (ver GENERICAS_DEMAIS)
  "dienstleistung", "dienstleistungen",
  "werbung", "ubersetzung", "ubersetzungen", "ubersetzer", "ubersetzerin", "dolmetschen", "dolmetscher", "dolmetscherin",
  "schulung", "schulungen", "weiterbildung", "architektur", "architekt", "architektin",
  "ingenieurwesen", "ingenieur", "ingenieurin", "wartung", "instandhaltung",
  "personalvermittlung", "makler", "maklerin", "vermittlung",
  "logistik", "spedition", "arzt", "arztin", "arzte", "zahnarzt", "zahnarztin", "tierarzt",
  "physiotherapie", "physiotherapeut", "psychologe", "psychologin", "psychotherapie", "psychotherapeut",
  "ernahrungsberater",
  // fr
  "publicite", "traduction", "traductions", "traducteur", "traducteurs", "traductrice", "traductrices",
  "architecte", "architectes", "courtage", "courtier", "courtiers", "recrutement", "mentorat",
  "logistique", "fret", "transporteur", "transporteurs", "medecin", "medecins", "dentiste", "dentistes",
  "kinesitherapie", "kinesitherapeute", "psychologue", "psychologues", "psychotherapeute",
  "infirmier", "infirmiere", "infirmiers", "infirmieres", "nutritionniste", "orthophoniste", "veterinaire",
];

/**
 * Serviços de ASSESSORIA: consultoria, jurídico, contábil, auditoria, mentoria.
 * É o subconjunto que atende a opção "Consultoria" da lista fixa de "O que
 * preciso" do onboarding — a única opção da lista em que alguém DECLARA
 * precisar de um serviço profissional (ver `ehServicoDeAssessoria`).
 */
const ASSESSORIA = [
  // pt
  "consultoria", "consultorias", "consultor", "consultora", "consultores", "consultoras",
  "assessoria", "assessorias", "assessor", "assessora", "assessores", "assessoras",
  "advocacia", "advogado", "advogada", "advogados", "advogadas",
  "juridico", "juridica", "juridicos", "juridicas",
  "contabilidade", "contabil", "contabeis", "contador", "contadora", "contadores", "contadoras", "contabilista", "contabilistas",
  "auditoria", "auditorias", "auditor", "auditora", "auditores", "auditoras",
  "mentoria", "mentorias", "mentor", "mentora", "mentores", "mentoras",
  "coaching", "coach",
  // en
  "consulting", "consultancy", "consultant", "consultants",
  "advisory", "advisor", "advisors", "adviser", "advisers",
  "lawyer", "lawyers", "attorney", "attorneys",
  "accounting", "accountant", "accountants", "bookkeeping", "bookkeeper", "bookkeepers",
  "audit", "auditing", "audits",
  "mentoring", "mentorship",
  // es
  "asesoria", "asesorias", "asesor", "asesora", "asesores", "asesoras",
  "abogacia", "abogado", "abogada", "abogados", "abogadas",
  "contabilidad", "contable", "contables",
  // de e fr
  ...ASSESSORIA_EM_FRANCES_E_ALEMAO,
  // ru — os substantivos também no acusativo, no genitivo e no plural, que é como se pede ("Ищем бухгалтера",
  // "услуги юриста"); sem eles o profissional pedido não era lido (revisão de 15/09 na #127, 116bb56, portada).
  // Os adjetivos com as formas de gênero e caso mais comuns ("Юридическая консультация", "Бухгалтерские услуги",
  // "Маркетинговая консультация") estão também em ADJETIVOS_ANTEPOSTOS (9e027bf e 116bb56).
  "консалтинг", "консалтинга", "консалтингу", "консультация", "консультации", "консультацию", "консультаций", "консультирование",
  "консультант", "консультанта", "консультанты", "консультантов",
  "консалтинговый", "консалтинговая", "консалтинговое", "консалтинговые", "консалтинговых", "консалтинговой", "консалтингового",
  "юридический", "юридическая", "юридическое", "юридические", "юридических", "юридической", "юридического",
  "юрист", "юриста", "юристы", "юристов", "адвокат", "адвоката", "адвокаты", "адвокатов",
  "бухгалтерия", "бухгалтерии", "бухгалтерский", "бухгалтерская", "бухгалтерское", "бухгалтерские", "бухгалтерских", "бухгалтерской", "бухгалтерского",
  "бухгалтер", "бухгалтера", "бухгалтеры", "бухгалтеров", "аудит", "аудита", "аудиту", "аудитор", "аудитора", "аудиторы", "аудиторов",
  "аудиторский", "аудиторская", "аудиторское", "аудиторские", "аудиторских", "аудиторской", "аудиторского",
  "наставничество", "менторство",
  // hi — "लेखा" é a contabilidade ("लेखा सेवाएं"), "सलाह" o aconselhamento ("कानूनी सलाह")
  "परामर्श", "सलाह", "सलाहकार", "कानूनी", "वकील", "अधिवक्ता", "लेखा", "लेखांकन", "लेखाकार", "अंकेक्षण",
  // ar — também com o artigo colado ("المحاسب", o contador), que é a forma usual; "مستشار" é o consultor
  "استشارات", "استشارة", "استشاري", "مستشار", "الاستشارات", "الاستشارة", "المستشار", "محاماة", "محامي", "المحاماة", "المحامي",
  "قانوني", "قانونية", "محاسبة", "محاسب", "المحاسبة", "المحاسب", "تدقيق", "مدقق", "المدقق",
];

/**
 * "Legal" e "law" só valem na CABEÇA ("Legal advisory", "Law firm"): no meio
 * do termo, "legal" é adjetivo de qualquer coisa ("Cannabis legal").
 *
 * "direito" não entra aqui: a palavra é ambígua em português ("lado direito",
 * "acesso direito"). O buraco que isso deixava — "Direito tributário" sem
 * categoria caía em "outros" e escapava do portão — fecha com o critério
 * estreito: "Direito" só é serviço de advocacia seguido de ÁREA curada (ver
 * `areaDoDireito` e o passo 3b de `classificarOferta`).
 */
const ASSESSORIA_SO_NA_CABECA = ["legal", "law"];

/** Os demais serviços profissionais — inequívocos como prestação. */
const OUTROS_SERVICOS = [
  // pt
  "servico", "servicos", "prestacao",
  "marketing", "publicidade", "propaganda",
  "design", "designer", "designers",
  "arquitetura", "arquiteto", "arquiteta", "arquitetos", "arquitetas",
  "engenharia", "engenheiro", "engenheira", "engenheiros", "engenheiras",
  "publicitario", "publicitaria", "publicitarios", "publicitarias", "palestrante", "palestrantes",
  "recrutador", "recrutadora", "recrutadores", "recrutadoras",
  "treinamento", "treinamentos", "capacitacao", "capacitacoes", "curso", "cursos",
  "palestra", "palestras",
  "traducao", "traducoes", "tradutor", "tradutora", "tradutores", "tradutoras",
  "interpretacao", "interprete", "interpretes",
  "despachante", "despachantes", "desembaraco",
  "corretagem", "corretor", "corretora", "corretores", "corretoras",
  "recrutamento", "headhunting", "headhunter", "headhunters",
  "terceirizacao", "outsourcing",
  // "instalacao" fica de fora: "Instalação portuária" é a instalação física.
  "manutencao", "suporte", "assistencia", "atendimento",
  "agenciamento", "intermediacao",
  // Logística (decisão de 14/09, ver o topo). "logística" e "logístico" são
  // também adjetivo de imóvel ("Galpão logístico", "Centro logístico",
  // "Condomínio logístico"): ficam em ADJETIVOS_DE_SERVICO, como "jurídico".
  "logistica", "logisticas", "logistico", "logisticos",
  "transporte", "transportes", "transportadora", "transportadoras", "transportador", "transportadores",
  "frete", "fretes", "armazenagem",
  // Saúde. "médico", "veterinário" e "odontológico" são também adjetivo de
  // produto ("Equipamento médico", "Material odontológico"): ficam em
  // ADJETIVOS_DE_SERVICO, que só decide na cabeça ou atrás de cabeça neutra.
  // "terapia" e "nutrição" ficam de fora: "Terapia gênica" é biotecnologia e
  // "Nutrição animal" é ração; quem presta, "terapeuta" e "nutricionista", entra.
  "medicina", "medico", "medica", "medicos", "medicas", "clinica", "clinicas",
  "odontologia", "odontologico", "odontologica", "odontologicos", "odontologicas", "odontologo", "odontologa", "dentista", "dentistas",
  "fisioterapia", "fisioterapeuta", "fisioterapeutas",
  "psicologia", "psicologo", "psicologa", "psicologos", "psicologas", "psicoterapia", "psicoterapeuta", "psicoterapeutas",
  "psiquiatria", "psiquiatra", "psiquiatras",
  "enfermagem", "enfermeiro", "enfermeira", "enfermeiros", "enfermeiras",
  "nutricionista", "nutricionistas", "terapeuta", "terapeutas",
  "fonoaudiologia", "fonoaudiologo", "fonoaudiologa", "fonoaudiologos", "fonoaudiologas",
  "veterinaria", "veterinario", "veterinarias", "veterinarios",
  // Perícia, BPO, marca e texto; e quem programa ("desenvolvedor" fica de fora:
  // é também a incorporadora, "Desenvolvedora imobiliária").
  "pericia", "pericias", "perito", "perita", "peritos", "peritas", "bpo",
  "branding", "copywriting", "copywriter", "copywriters",
  "programador", "programadora", "programadores", "programadoras", "comex",
  // en
  "service", "services",
  "advertising",
  "architecture", "architect", "architects",
  "engineering", "engineer", "engineers",
  "training", "trainings",
  "translation", "translations", "translator", "translators",
  "interpreting", "interpreter", "interpreters",
  "brokerage", "broker", "brokers",
  "recruitment", "recruiting",
  "maintenance", "support", "assistance",
  // "storage" fica de fora: é também dado ("Cloud storage") e energia.
  "logistics", "transport", "transportation", "freight",
  // "medicine" fica de fora (é o remédio), e "medical" e "veterinary" também: na
  // cabeça de um composto inglês nomeiam o produto ("Medical supplies").
  "doctor", "doctors", "physician", "physicians", "clinic", "clinics",
  "dentist", "dentists", "dentistry", "physiotherapy", "physiotherapist", "physiotherapists",
  "psychology", "psychologist", "psychologists", "psychotherapy", "psychotherapist", "psychotherapists",
  "psychiatry", "psychiatrist", "psychiatrists", "nursing", "nurse", "nurses",
  "nutritionist", "nutritionists", "dietitian", "dietitians", "therapist", "therapists",
  "veterinarian", "veterinarians", "programmer", "programmers",
  // es
  "servicio", "servicios",
  "publicidad",
  "diseno", "disenador", "disenadora", "disenadores",
  "arquitectura", "arquitecto", "arquitecta", "arquitectos",
  "ingenieria", "ingeniero", "ingeniera", "ingenieros", "ingenieras",
  "capacitacion", "formacion", "entrenamiento",
  "traduccion", "traducciones", "traductor", "traductora", "traductores",
  // "corredor" fica de fora: é também o corredor logístico, e juntava
  // "Corretora de valores" com "Corredor" (revisão de 13/09).
  "corretaje",
  "reclutamiento", "tercerizacion",
  "mantenimiento", "soporte",
  "flete", "fletes", "almacenaje",
  "enfermeria", "enfermero", "enfermera", "enfermeros", "enfermeras",
  // de e fr
  ...OUTROS_SERVICOS_EM_FRANCES_E_ALEMAO,
  // ru — "услуги" é o "serviços" genérico (ver GENERICAS_DEMAIS; 9e027bf). "перевод" sozinho fica de fora: é também a
  // transferência de dinheiro ("денежный перевод"). As formas de caso e os adjetivos de marketing e tradução vieram
  // com a 116bb56 ("Маркетинговая консультация", "Переводческие услуги").
  "услуга", "услуги", "услуг",
  "маркетинг", "маркетинга", "маркетингу", "маркетингом", "реклама", "переводчик", "переводчика", "переводчики", "переводчиков",
  "маркетинговый", "маркетинговая", "маркетинговое", "маркетинговые", "маркетинговых", "маркетинговой", "маркетингового",
  "переводческий", "переводческая", "переводческое", "переводческие", "переводческих", "переводческой", "переводческого",
  "обучение", "тренинг", "тренинги",
  "дизайн", "дизайна", "дизайну", "дизайнер", "дизайнера", "архитектура", "архитектор", "инжиниринг", "инженер",
  "обслуживание", "техобслуживание", "рекрутинг", "брокер", "брокерские", "посредничество",
  "логистика", "перевозка", "перевозки", "грузоперевозки", "экспедирование",
  "врач", "врачи", "стоматолог", "стоматология", "физиотерапия", "физиотерапевт",
  "психолог", "психологи", "психотерапия", "психотерапевт", "психиатр", "медсестра", "диетолог",
  // hi — "सेवा" é o "serviços" genérico (9e027bf)
  "सेवा", "सेवाएं", "सेवाएँ", "सेवाओं",
  "विपणन", "मार्केटिंग", "अनुवाद", "अनुवादक", "प्रशिक्षण", "डिजाइन",
  "वास्तुकला", "वास्तुकार", "इंजीनियरिंग", "अभियांत्रिकी", "रखरखाव", "भर्ती", "दलाली", "दलाल",
  "लॉजिस्टिक्स", "परिवहन", "चिकित्सक", "डॉक्टर", "फिजियोथेरेपी", "मनोवैज्ञानिक", "नर्स",
  // ar — "خدمات" é o "serviços" genérico ("خدمات محاسبة", serviços de contabilidade; ver GENERICAS_DEMAIS).
  // "عمارة" saiu: é arquitetura e também o prédio ("عمارة سكنية", prédio residencial virava serviço; 9e027bf da #127).
  "خدمة", "خدمات",
  "تسويق", "التسويق", "ترجمة", "مترجم", "المترجم", "تدريب", "تصميم", "مصمم", "هندسة", "مهندس",
  "صيانة", "توظيف", "وساطة", "وسيط",
  "لوجستية", "لوجستيات", "طبيب", "طبيبة", "ممرض", "ممرضة",
];

/**
 * Adjetivos de profissão que o alemão, o russo e o hindi põem ANTES do
 * substantivo. Seguidos de substantivo que não é serviço, qualificam outra
 * coisa e não decidem pela cabeça: "Juristische Person" (pessoa jurídica),
 * "Юридический адрес" (endereço jurídico), "Бухгалтерский баланс" (balanço
 * contábil), "कानूनी दस्तावेज़" (documento jurídico). Estavam na lista como
 * substantivo e viravam serviço (9e027bf da #127, revisão de 14/09; os de
 * consultoria, auditoria, marketing e tradução em russo, 116bb56).
 */
const ADJETIVOS_ANTEPOSTOS = new Set([
  "juristisch", "juristische", "juristischer", "juristischen", "juristisches",
  "юридический", "юридическая", "юридическое", "юридические", "юридических", "юридической", "юридического",
  "бухгалтерский", "бухгалтерская", "бухгалтерское", "бухгалтерские", "бухгалтерских", "бухгалтерской", "бухгалтерского",
  "консалтинговый", "консалтинговая", "консалтинговое", "консалтинговые", "консалтинговых", "консалтинговой", "консалтингового",
  "аудиторский", "аудиторская", "аудиторское", "аудиторские", "аудиторских", "аудиторской", "аудиторского",
  "маркетинговый", "маркетинговая", "маркетинговое", "маркетинговые", "маркетинговых", "маркетинговой", "маркетингового",
  "переводческий", "переводческая", "переводческое", "переводческие", "переводческих", "переводческой", "переводческого",
  "कानूनी",
]);

/**
 * Adjetivos de serviço: só decidem atrás de cabeça NEUTRA ("Escritório
 * jurídico"). Soltos no termo são adjetivo de qualquer coisa — "Pessoa
 * jurídica", "Estrutura jurídica em Portugal", "Dados contábeis".
 */
const ADJETIVOS_DE_SERVICO = new Set([
  "juridico", "juridica", "juridicos", "juridicas", "contabil", "contabeis", "contable", "contables", "legal", "legales",
  // "publicitário" é adjetivo em "Material publicitário", "Espaço publicitário" (revisão de 13/09)
  "publicitario", "publicitaria", "publicitarios", "publicitarias",
  // Os mesmos adjetivos em francês e árabe, pospostos como em português: "Données comptables" e "مستند قانوني"
  // (documento jurídico) não são serviço; "Comptable" sozinho segue sendo, pela cabeça (9e027bf da #127).
  "juridique", "juridiques", "comptable", "comptables", "قانوني", "قانونية",
  ...Array.from(ADJETIVOS_ANTEPOSTOS),
  // "Galpão logístico", "Equipamento médico", "Material odontológico", "Produtos veterinários" (14/09)
  "logistica", "logisticas", "logistico", "logisticos",
  "medico", "medica", "medicos", "medicas", "odontologico", "odontologica", "odontologicos", "odontologicas",
  "veterinaria", "veterinario", "veterinarias", "veterinarios", "veterinaire",
]);

/**
 * "Serviços" (e "prestação") sozinho não nomeia serviço nenhum: como família
 * (ver `familiaDoServico`) diria que "Serviços" procurado casa com qualquer
 * prestação, e como necessidade genérica seria "preciso de serviços". Como
 * CABEÇA, deixa o complemento decidir: "Serviços de logística" é logística.
 */
const GENERICAS_DEMAIS = new Set([
  "servico", "servicos", "service", "services", "servicio", "servicios", "prestacao",
  // "Юридические услуги", "कानूनी सेवाएं": sem o genérico, o adjetivo anteposto ficava sem substantivo de serviço (9e027bf).
  "услуга", "услуги", "услуг", "सेवा", "सेवाएं", "सेवाएँ", "सेवाओं",
  // "Juristische Dienstleistungen", "خدمات محاسبة" (revisão de 15/09 na #127, 116bb56, portada)
  "dienstleistung", "dienstleistungen", "خدمة", "خدمات",
]);

/**
 * Substantivos que nomeiam a prestação em si: toda palavra de serviço das
 * listas que não é adjetivo. Decidem (a) colados à cabeça, sem preposição nem
 * conjunção no meio — "Tax consulting", "Customs brokerage", "Technical
 * support", "International law firm" — porque em inglês o substantivo do
 * serviço vem depois, e é ele a cabeça de fato; e (b) atrás de cabeça neutra,
 * atravessando o genitivo ("Empresa de contabilidade", "Despacho de
 * abogados"). Atrás de OUTRA preposição ou de conjunção, com cabeça de outra
 * natureza, são só modificador ou outro item: "Peças DE manutenção" é
 * produto, "Escritório PARA advogados" é o imóvel, "Mina E consultoria
 * mineral" fica com a mina (revisões de 12/09).
 */
const SUBSTANTIVOS_DE_SERVICO = new Set(
  [...ASSESSORIA, ...ASSESSORIA_SO_NA_CABECA, ...OUTROS_SERVICOS].filter(palavra => !ADJETIVOS_DE_SERVICO.has(palavra)),
);

/**
 * A FAMÍLIA de cada palavra de serviço — o LEMA que junta as flexões e os três
 * idiomas: "advogado", "advocacia", "jurídico", "lawyer" e "abogada" são a
 * mesma família; "consultor", "consulting" e "consultancy" também. Família é
 * lema, não área: consultoria e assessoria, mentoria e coaching, marketing e
 * publicidade, tradução e interpretação, treinamento, curso e palestra,
 * suporte, assistência e atendimento são famílias distintas. Até 13/09 elas
 * eram fundidas, e a fusão dava 100 entre serviços diferentes ("Assessoria de
 * imprensa" × "Consultoria", "Interpretação de exames" × "Tradutor").
 * Consultoria e assessoria só se aproximam com a mesma especialidade
 * (`SINONIMOS_PROXIMOS`). Palavra fora do mapa é a própria família.
 */
const FAMILIAS: Record<string, readonly string[]> = {
  advocacia: ["advocacia", "advogado", "advogada", "advogados", "advogadas", "juridico", "juridica", "juridicos", "juridicas", "lawyer", "lawyers", "attorney", "attorneys", "law", "legal", "legales", "abogacia", "abogado", "abogada", "abogados", "abogadas", "rechtsberatung", "rechtsanwalt", "rechtsanwalte", "rechtsanwaltin", "anwalt", "anwalte", "anwaltin", "kanzlei", "anwaltskanzlei", "rechtsanwaltskanzlei", "juristisch", "juristische", "juristischer", "juristischen", "juristisches", "avocat", "avocats", "avocate", "juriste", "juristes", "juridique", "juridiques", "юридический", "юридическая", "юридическое", "юридические", "юридических", "юридической", "юридического", "юрист", "юриста", "юристы", "юристов", "адвокат", "адвоката", "адвокаты", "адвокатов", "कानूनी", "वकील", "अधिवक्ता", "محاماة", "محامي", "المحاماة", "المحامي", "قانوني", "قانونية"],
  consultoria: ["consultoria", "consultorias", "consultor", "consultora", "consultores", "consultoras", "consulting", "consultancy", "consultant", "consultants", "beratung", "beratungen", "berater", "beraterin", "unternehmensberatung", "conseil", "conseils", "consultante", "conseiller", "conseillers", "conseillere", "conseilleres", "консалтинг", "консалтинга", "консалтингу", "консультация", "консультации", "консультацию", "консультаций", "консультирование", "консультант", "консультанта", "консультанты", "консультантов", "консалтинговый", "консалтинговая", "консалтинговое", "консалтинговые", "консалтинговых", "консалтинговой", "консалтингового", "परामर्श", "सलाह", "सलाहकार", "استشارات", "استشارة", "استشاري", "مستشار", "الاستشارات", "الاستشارة", "المستشار"],
  assessoria: ["assessoria", "assessorias", "assessor", "assessora", "assessores", "assessoras", "advisory", "advisor", "advisors", "adviser", "advisers", "asesoria", "asesorias", "asesor", "asesora", "asesores", "asesoras"],
  contabilidade: ["contabilidade", "contabil", "contabeis", "contador", "contadora", "contadores", "contadoras", "contabilista", "contabilistas", "accounting", "accountant", "accountants", "bookkeeping", "bookkeeper", "bookkeepers", "contabilidad", "contable", "contables", "buchhaltung", "buchfuhrung", "buchhalter", "buchhalterin", "steuerberatung", "steuerberater", "steuerberaterin", "steuerkanzlei", "comptabilite", "comptable", "comptables", "бухгалтерия", "бухгалтерии", "бухгалтерский", "бухгалтерская", "бухгалтерское", "бухгалтерские", "бухгалтерских", "бухгалтерской", "бухгалтерского", "бухгалтер", "бухгалтера", "бухгалтеры", "бухгалтеров", "लेखा", "लेखांकन", "लेखाकार", "محاسبة", "محاسب", "المحاسبة", "المحاسب"],
  auditoria: ["auditoria", "auditorias", "auditor", "auditora", "auditores", "auditoras", "audit", "auditing", "audits", "wirtschaftsprufung", "wirtschaftsprufer", "wirtschaftspruferin", "auditeur", "auditeurs", "аудит", "аудита", "аудиту", "аудитор", "аудитора", "аудиторы", "аудиторов", "аудиторский", "аудиторская", "аудиторское", "аудиторские", "аудиторских", "аудиторской", "аудиторского", "अंकेक्षण", "تدقيق", "مدقق", "المدقق"],
  mentoria: ["mentoria", "mentorias", "mentor", "mentora", "mentores", "mentoras", "mentoring", "mentorship", "наставничество", "менторство", "mentorat"],
  coaching: ["coaching", "coach"],
  marketing: ["marketing", "маркетинг", "маркетинга", "маркетингу", "маркетингом", "маркетинговый", "маркетинговая", "маркетинговое", "маркетинговые", "маркетинговых", "маркетинговой", "маркетингового", "विपणन", "मार्केटिंग", "تسويق", "التسويق"],
  publicidade: ["publicidade", "propaganda", "advertising", "publicidad", "publicitario", "publicitaria", "publicitarios", "publicitarias", "werbung", "publicite", "реклама"],
  design: ["design", "designer", "designers", "diseno", "disenador", "disenadora", "disenadores", "дизайн", "дизайна", "дизайну", "дизайнер", "дизайнера", "डिजाइन", "تصميم", "مصمم"],
  arquitetura: ["arquitetura", "arquiteto", "arquiteta", "arquitetos", "arquitetas", "architecture", "architect", "architects", "arquitectura", "arquitecto", "arquitecta", "arquitectos", "architektur", "architekt", "architektin", "architecte", "architectes", "архитектура", "архитектор", "वास्तुकला", "वास्तुकार"],
  engenharia: ["engenharia", "engenheiro", "engenheira", "engenheiros", "engenheiras", "engineering", "engineer", "engineers", "ingenieria", "ingeniero", "ingeniera", "ingenieros", "ingenieras", "ingenieurwesen", "ingenieur", "ingenieurin", "инжиниринг", "инженер", "इंजीनियरिंग", "अभियांत्रिकी", "هندسة", "مهندس"],
  treinamento: ["treinamento", "treinamentos", "capacitacao", "capacitacoes", "training", "trainings", "capacitacion", "formacion", "entrenamiento", "schulung", "schulungen", "weiterbildung", "обучение", "тренинг", "тренинги", "प्रशिक्षण", "تدريب"],
  curso: ["curso", "cursos"],
  palestra: ["palestra", "palestras", "palestrante", "palestrantes"],
  traducao: ["traducao", "traducoes", "tradutor", "tradutora", "tradutores", "tradutoras", "translation", "translations", "translator", "translators", "traduccion", "traducciones", "traductor", "traductora", "traductores", "ubersetzung", "ubersetzungen", "ubersetzer", "ubersetzerin", "traduction", "traductions", "traducteur", "traducteurs", "traductrice", "traductrices", "переводчик", "переводчика", "переводчики", "переводчиков", "переводческий", "переводческая", "переводческое", "переводческие", "переводческих", "переводческой", "переводческого", "अनुवाद", "अनुवादक", "ترجمة", "مترجم", "المترجم"],
  interpretacao: ["interpretacao", "interprete", "interpretes", "interpreting", "interpreter", "interpreters", "dolmetschen", "dolmetscher", "dolmetscherin"],
  despachante: ["despachante", "despachantes", "desembaraco"],
  corretagem: ["corretagem", "corretor", "corretora", "corretores", "corretoras", "brokerage", "broker", "brokers", "corretaje", "makler", "maklerin", "courtage", "courtier", "courtiers", "брокер", "брокерские", "दलाली", "दलाल", "وساطة", "وسيط"],
  recrutamento: ["recrutamento", "recrutador", "recrutadora", "recrutadores", "recrutadoras", "headhunting", "headhunter", "headhunters", "recruitment", "recruiting", "reclutamiento", "personalvermittlung", "recrutement", "рекрутинг", "भर्ती", "توظيف"],
  terceirizacao: ["terceirizacao", "outsourcing", "tercerizacion"],
  manutencao: ["manutencao", "maintenance", "mantenimiento", "wartung", "instandhaltung", "обслуживание", "техобслуживание", "रखरखाव", "صيانة"],
  suporte: ["suporte", "support", "soporte"],
  assistencia: ["assistencia", "assistance"],
  atendimento: ["atendimento"],
  agenciamento: ["agenciamento"],
  intermediacao: ["intermediacao", "vermittlung", "посредничество"],
  // 14/09: logística e saúde. Lema, não área, como as de cima: frete não é
  // transporte, psicologia não é psiquiatria, clínica não é medicina.
  logistica: ["logistica", "logisticas", "logistico", "logisticos", "logistics", "logistik", "logistique", "логистика", "लॉजिस्टिक्स", "لوجستية", "لوجستيات"],
  transporte: ["transporte", "transportes", "transportadora", "transportadoras", "transportador", "transportadores", "transport", "transportation", "transporteur", "transporteurs", "перевозка", "перевозки", "грузоперевозки", "परिवहन"],
  frete: ["frete", "fretes", "freight", "flete", "fletes", "fret", "spedition", "экспедирование"],
  armazenagem: ["armazenagem", "almacenaje"],
  medicina: ["medicina", "medico", "medica", "medicos", "medicas", "doctor", "doctors", "physician", "physicians", "arzt", "arztin", "arzte", "medecin", "medecins", "врач", "врачи", "चिकित्सक", "डॉक्टर", "طبيب", "طبيبة"],
  clinica: ["clinica", "clinicas", "clinic", "clinics"],
  odontologia: ["odontologia", "odontologico", "odontologica", "odontologicos", "odontologicas", "odontologo", "odontologa", "dentista", "dentistas", "dentist", "dentists", "dentistry", "zahnarzt", "zahnarztin", "dentiste", "dentistes", "стоматолог", "стоматология"],
  fisioterapia: ["fisioterapia", "fisioterapeuta", "fisioterapeutas", "physiotherapy", "physiotherapist", "physiotherapists", "physiotherapie", "physiotherapeut", "kinesitherapie", "kinesitherapeute", "физиотерапия", "физиотерапевт", "फिजियोथेरेपी"],
  psicologia: ["psicologia", "psicologo", "psicologa", "psicologos", "psicologas", "psychology", "psychologist", "psychologists", "psychologe", "psychologin", "psychologue", "psychologues", "психолог", "психологи", "मनोवैज्ञानिक"],
  psicoterapia: ["psicoterapia", "psicoterapeuta", "psicoterapeutas", "psychotherapy", "psychotherapist", "psychotherapists", "psychotherapie", "psychotherapeut", "psychotherapeute", "психотерапия", "психотерапевт"],
  psiquiatria: ["psiquiatria", "psiquiatra", "psiquiatras", "psychiatry", "psychiatrist", "psychiatrists", "психиатр"],
  enfermagem: ["enfermagem", "enfermeiro", "enfermeira", "enfermeiros", "enfermeiras", "nursing", "nurse", "nurses", "enfermeria", "enfermero", "enfermera", "enfermeros", "enfermeras", "infirmier", "infirmiere", "infirmiers", "infirmieres", "медсестра", "नर्स", "ممرض", "ممرضة"],
  nutricionista: ["nutricionista", "nutricionistas", "nutritionist", "nutritionists", "dietitian", "dietitians", "nutritionniste", "диетолог", "ernahrungsberater"],
  terapeuta: ["terapeuta", "terapeutas", "therapist", "therapists"],
  fonoaudiologia: ["fonoaudiologia", "fonoaudiologo", "fonoaudiologa", "fonoaudiologos", "fonoaudiologas", "orthophoniste"],
  veterinaria: ["veterinaria", "veterinario", "veterinarias", "veterinarios", "veterinarian", "veterinarians", "tierarzt", "veterinaire"],
  pericia: ["pericia", "pericias", "perito", "perita", "peritos", "peritas"],
  copywriting: ["copywriting", "copywriter", "copywriters"],
  programador: ["programador", "programadora", "programadores", "programadoras", "programmer", "programmers"],
};
/**
 * Chinês e japonês não separam palavras por espaço, então a classificação por
 * TOKEN não enxerga nada: "税务咨询" (consultoria tributária) chega como uma
 * palavra só e caía em "outros" — o portão da demanda expressa nunca disparava
 * nesses dois idiomas, e a regra da cliente simplesmente não existia para
 * quem escreve neles (defeito relatado depois da #101).
 *
 * O serviço é reconhecido pelo FIM do termo, que é onde as duas línguas põem
 * a cabeça: "税务咨询" é consultoria (tributária), "会计软件" é o software (de
 * contabilidade), "培训中心" é o centro (de treinamento). Até 14/09 bastava o
 * termo CONTER a palavra, e "会计软件", "广告牌", "设计软件", "培训中心",
 * "法律数据库", "デザイン家具", "保守的な投資ファンド" e "採用実績のある技術"
 * viravam serviço e caíam no portão (9e027bf da #127, revisão de 14/09). Depois
 * do serviço só pode vir estrutura (`ESTRUTURA_DEPOIS_DO_SERVICO`): "律师事务所"
 * é advocacia, "広告代理店" é publicidade, "會計師事務所" é contabilidade.
 *
 * A lista é curta e conservadora de propósito: termo que também é palavra
 * comum fora de serviço (支持/サポート "suporte", 工程 "obra") ficou de fora,
 * porque classificar como serviço por engano SUJEITA o item ao portão — erra
 * para o lado de barrar match legítimo. Faltar termo aqui só mantém o que já
 * havia. As famílias seguem as de FAMILIAS: publicidade (广告) e interpretação
 * (通訳) são famílias próprias.
 *
 * Ordenado do mais longo para o mais curto: "建築設計" tem de ganhar de "設計".
 */
const SERVICOS_SEM_ESPACO: Array<[string, string]> = ([
  // zh (simplificado e, onde a grafia muda, tradicional: 律師, 會計)
  ["市场营销", "marketing"], ["建筑设计", "arquitetura"],
  ["咨询", "consultoria"], ["諮詢", "consultoria"], ["顾问", "consultoria"],
  ["律师", "advocacia"], ["律師", "advocacia"], ["法律", "advocacia"],
  ["会计", "contabilidade"], ["會計", "contabilidade"], ["审计", "auditoria"],
  ["营销", "marketing"], ["广告", "publicidade"],
  ["翻译", "traducao"], ["培训", "treinamento"], ["设计", "design"],
  ["维护", "manutencao"], ["招聘", "recrutamento"], ["经纪", "corretagem"],
  // "培训课程" (curso de treinamento) e "研修プログラム" (programa de formação) são o treinamento como termo inteiro:
  // "课程" e "プログラム" deixaram de ser estrutura para o curso de uma área não virar o profissional dela (#135, item 5).
  ["培训课程", "treinamento"], ["研修プログラム", "treinamento"],
  // "税务师"/"稅務師" é o agente tributário certificado, como o "税理士" japonês (116bb56 da #127)
  ["税务师", "contabilidade"], ["稅務師", "contabilidade"],
  // 14/09: logística e saúde. "运输" (transporte) e "仓储" (armazenagem) ficam de
  // fora: "运输设备" é o equipamento e "仓储中心" é o galpão.
  ["物流", "logistica"], ["货运代理", "frete"], ["诊所", "clinica"], ["医生", "medicina"],
  ["物理治疗", "fisioterapia"], ["心理咨询", "psicologia"], ["心理治疗", "psicoterapia"],
  // ja — "コンサルタント" (consultor) e "顧問" (assessor contratado) são a forma usual de pedir o profissional (116bb56)
  ["コンサルティング", "consultoria"], ["コンサルタント", "consultoria"], ["マーケティング", "marketing"],
  ["メンテナンス", "manutencao"], ["人材紹介", "recrutamento"], ["建築設計", "arquitetura"],
  ["コンサル", "consultoria"], ["顧問", "consultoria"], ["弁護士", "advocacia"], ["法務", "advocacia"],
  ["会計", "contabilidade"], ["税理士", "contabilidade"], ["広告", "publicidade"],
  ["監査", "auditoria"], ["翻訳", "traducao"], ["通訳", "interpretacao"],
  ["研修", "treinamento"], ["デザイン", "design"], ["設計", "design"],
  ["保守", "manutencao"], ["採用", "recrutamento"], ["仲介", "corretagem"],
  // 14/09: "看護" sozinho é também o artigo de enfermagem ("看護用品"); quem presta é "看護師".
  ["クリニック", "clinica"], ["医師", "medicina"], ["理学療法", "fisioterapia"], ["看護師", "enfermagem"], ["歯科医", "odontologia"],
] as Array<[string, string]>).sort((a, b) => b[0].length - a[0].length);

/** Chinês e japonês: han, hiragana e katakana. */
const ESCRITA_SEM_ESPACO = new RegExp("[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]", "u");

/**
 * O que pode vir DEPOIS do serviço sem mudar o que se presta: "服务"/"サービス"
 * (serviço), "事务所"/"事務所" (escritório), "代理店" (agência), "公司"/"会社"
 * (empresa), o sufixo de quem presta (师/師 em "会计师", 士 em "会計士") e o
 * pedido que o japonês põe no fim ("税務コンサルティングが必要です", "会計士募集";
 * 9e027bf e e6ddfa4 da #127).
 */
const ESTRUTURA_DEPOIS_DO_SERVICO = [
  "服务", "服務", "サービス", "事务所", "事務所", "代理店", "有限公司", "公司", "会社", "师", "師", "士",
  // "監査法人", "コンサルティングファーム", "设计工作室", "营销策划", "採用支援": eram "outros" (116bb56). "有限公司"
  // antes de "公司", porque a busca pega o primeiro que termina o termo. "课程"/"課程" (curso) e "プログラム"
  // (programa) NÃO são estrutura: o curso de uma área não é o profissional da área — "会计课程" (curso de
  // contabilidade) descascado até "会计" valia 100 com "Contador" e disparava e-mail (item 5 da revisão do Nicolas
  // na #135), enquanto "Curso de contabilidade" × "Contador" dá 0 em português. "培训课程" e "研修プログラム" são
  // termos inteiros em SERVICOS_SEM_ESPACO.
  "法人", "ファーム", "工作室", "策划", "支援",
  "が必要です", "が必要", "を探しています", "を探す", "を募集", "募集",
];
/**
 * O sufixo de quem presta ("会计师", "会計士") e os serviços que já nomeiam o profissional ("律师", "弁護士"). Os
 * profissionais de saúde que a #135 leu em 14/09 ("医生", "医師", "看護師", "歯科医") entram também: "招聘医生" é
 * contratar médico, como "招聘律师" é contratar advogado.
 */
const SUFIXOS_DE_QUEM_PRESTA = new Set(["师", "師", "士"]);
const PROFISSIONAIS_SEM_ESPACO = new Set(["律师", "律師", "弁護士", "会计", "會計", "翻译", "翻訳", "税理士", "税务师", "稅務師", "医生", "医師", "看護師", "歯科医"]);

/**
 * O serviço que TERMINA o último pedaço em escrita sem espaço, tirada a
 * estrutura do fim: a família, o que vem antes dele ("税务" em "税务咨询服务") e
 * se o termo nomeia quem presta ("会计师", "律师") ou a prestação ("咨询").
 * null quando o termo não termina em serviço — ver SERVICOS_SEM_ESPACO.
 *
 * O termo é o primeiro trecho em escrita sem espaço, antes do complemento entre
 * parênteses ou depois de " - ", e sem o lugar que vem depois dele separado por
 * espaço: "律师事务所（北京）", "会计服务 - 深圳" e "律师事务所 北京" são advocacia e
 * contabilidade, como eram na leitura por substring (revisão de 15/09 do porte da
 * 9e027bf). Palavra que não é lugar continua decidindo: "会计软件（北京）" segue
 * software.
 */
const ABRE_COMPLEMENTO_SEM_ESPACO = new RegExp("[(\\[{\\uFF08\\u3010\\u300C\\u300E\\uFF3B]|\\s[-\\u2013\\u2014]\\s|[\\u2013\\u2014]", "u");
/** Lugares que vêm depois do serviço em chinês e japonês: as cidades e os países mais citados. */
const LUGARES_SEM_ESPACO = new Set([
  "中国", "中國", "北京", "上海", "深圳", "广州", "廣州", "香港", "澳门", "澳門", "台湾", "台灣", "台北", "臺北", "天津", "重庆", "重慶",
  "成都", "杭州", "南京", "苏州", "蘇州", "武汉", "武漢", "西安", "厦门", "廈門", "青岛", "青島",
  "日本", "东京", "東京", "大阪", "京都", "横浜", "名古屋", "福岡", "札幌", "神戸",
  "巴西", "圣保罗", "聖保羅", "ブラジル", "サンパウロ",
]);

function servicoNoFimSemEspaco(rotulo: string): { familia: string; antes: string; profissional: boolean } | null {
  const trecho = rotulo.split(ABRE_COMPLEMENTO_SEM_ESPACO).find(parte => tokensDoTermo(parte).some(palavra => ESCRITA_SEM_ESPACO.test(palavra)));
  const palavras = tokensDoTermo(trecho ?? "");
  let fim = palavras.length - 1;
  while (fim > 0 && LUGARES_SEM_ESPACO.has(palavras[fim])) fim -= 1;
  let resto = palavras[fim] ?? "";
  if (!ESCRITA_SEM_ESPACO.test(resto)) return null;
  let profissional = false;
  for (;;) {
    const servico = SERVICOS_SEM_ESPACO.find(([termo]) => resto.endsWith(termo));
    if (servico) {
      return { familia: servico[1], antes: resto.slice(0, resto.length - servico[0].length), profissional: profissional || PROFISSIONAIS_SEM_ESPACO.has(servico[0]) };
    }
    const estrutura = ESTRUTURA_DEPOIS_DO_SERVICO.find(sufixo => resto.length > sufixo.length && resto.endsWith(sufixo));
    if (!estrutura) return null;
    if (SUFIXOS_DE_QUEM_PRESTA.has(estrutura)) profissional = true;
    resto = resto.slice(0, resto.length - estrutura.length);
  }
}

const familiaSemEspaco = (rotulo: string) => servicoNoFimSemEspaco(rotulo)?.familia ?? null;

/** A especialidade lida em chinês e japonês, no que vem antes do serviço: "税务" em "税务咨询" (e6ddfa4 da #127). */
const ESPECIALIDADES_SEM_ESPACO: Array<[string, string]> = [["税务", "tributario"], ["税務", "tributario"], ["稅務", "tributario"]];

/** Quem pede e as partículas, que não são especialidade: "我们需要税务咨询", "当社は税務コンサルティング", "招聘律师". */
const PEDIDO_SEM_ESPACO = ["我们", "我們", "我司", "需要", "急需", "寻找", "尋找", "寻求", "想要", "招聘", "当社", "弊社", "私たち", "我", "的", "の", "は", "が", "を"]
  .sort((a, b) => b.length - a.length);

/**
 * As especialidades do que vem ANTES do serviço em chinês e japonês, lido do
 * começo para o fim: pedido e partícula saem, especialidade curada e outro
 * serviço do vocabulário são reconhecidos ("法律" em "法律咨询" é a advocacia,
 * como "jurídica" em "Consultoria jurídica"), e o resto é palavra que as listas
 * não conhecem ("国际" em "国际税务咨询") — que, como em português, só casa
 * escrita igual (e6ddfa4 da #127).
 */
function especialidadesSemEspaco(antes: string, familia: string, profissional: boolean): EspecialidadeDoServico[] {
  const lemas = new Set<string>();
  const conhecidos = new Set<string>();
  const servicos = new Set<string>();
  const assunto = new Set<string>();
  let desconhecido = "";
  const fecharDesconhecido = () => {
    if (desconhecido) {
      lemas.add(desconhecido);
      assunto.add(desconhecido);
    }
    desconhecido = "";
  };
  let resto = antes;
  while (resto) {
    // "招聘" é quem contrata diante do profissional ("招聘律师", contratar advogado) e o serviço de recrutamento diante da
    // prestação ("招聘咨询" é consultoria de recrutamento): lido sempre como pedido, a necessidade virava a consultoria
    // genérica e casava com "税务咨询" (116bb56 da #127).
    const pedido = PEDIDO_SEM_ESPACO.find(termo => resto.startsWith(termo) && (termo !== "招聘" || profissional));
    const especialidade = pedido ? undefined : ESPECIALIDADES_SEM_ESPACO.find(([termo]) => resto.startsWith(termo));
    const servico = pedido || especialidade ? undefined : SERVICOS_SEM_ESPACO.find(([termo]) => resto.startsWith(termo));
    const reconhecido = pedido ?? especialidade?.[0] ?? servico?.[0];
    if (!reconhecido) {
      const letra = Array.from(resto)[0];
      desconhecido += letra;
      resto = resto.slice(letra.length);
      continue;
    }
    fecharDesconhecido();
    const lema = especialidade?.[1] ?? servico?.[1];
    if (lema && lema !== familia) {
      lemas.add(lema);
      conhecidos.add(lema);
      if (servico && !PROFISSOES_PELO_ADJETIVO.has(lema)) servicos.add(lema);
    }
    resto = resto.slice(reconhecido.length);
  }
  fecharDesconhecido();
  return lemas.size > 0
    ? [{ lemas, conhecidos, servicos, publico: new Set<string>(), publicoEspecifico: new Set<string>(), assunto }]
    : [];
}
const FAMILIA_DA_PALAVRA = new Map<string, string>(
  Object.entries(FAMILIAS).flatMap(([familia, palavras]) => palavras.map(palavra => [palavra, familia] as const)),
);
const familiaDaPalavra = (palavra: string) => FAMILIA_DA_PALAVRA.get(palavra) ?? palavra;

/** Depois de uma destas, o que vem é complemento da cabeça, não a coisa oferecida. */
const PREPOSICOES = new Set([
  // "pra" é o "para" falado, e sem ele "Contador pra MEI" lia o destinatário como especialidade.
  ...Array.from(GENITIVOS), "para", "pra", "em", "no", "na", "nos", "nas", "com", "por", "sobre", "ao", "aos", "a", "as",
  "for", "to", "in", "on", "with", "from", "at", "en", "con", "al", "del", "desde", "hacia",
  // O "para" e o "com" do francês, do alemão e do russo, e o "sobre" do russo: sem eles "Bureaux POUR avocats" e
  // "Software FÜR Buchhaltung" liam o serviço no fim, como se fossem o pedido (116bb56 da #127, trava de `regraNaoLeOPar`).
  "pour", "avec", "fur", "zum", "zur", "mit", "для", "по",
]);
/** Conjunção coordena OUTRO item: "Mina e consultoria mineral" fica com a mina. */
const CONJUNCOES = new Set(["e", "and", "y", "ou", "or"]);
const FRONTEIRAS = new Set([...Array.from(PREPOSICOES), ...Array.from(CONJUNCOES)]);

const PRODUTO = [
  "produto", "produtos", "product", "products", "producto", "productos",
  "mercadoria", "mercadorias", "goods", "merchandise", "mercancia", "mercancias",
  "estoque", "estoques", "stock", "inventario", "inventory",
  "commodity", "commodities", "materia", "materias",
  "material", "materiais", "materials", "materiales",
];

const ATIVO = [
  "ativo", "ativos", "asset", "assets", "activo", "activos",
  "mina", "minas", "mine", "mines", "jazida", "jazidas",
  "fazenda", "fazendas", "farm", "farms", "granja", "granjas",
  "plantacao", "plantacoes", "plantation", "plantations",
  "criacao", "criacoes",
  "industria", "industrias", "industry", "industries",
  "fabrica", "fabricas", "factory", "factories", "usina", "usinas",
  "laboratorio", "laboratorios", "laboratory", "laboratories", "lab", "labs",
  "licenca", "licencas", "license", "licenses", "licence", "licences", "licencia", "licencias",
  "certificacao", "certificacoes", "certification", "certifications", "certificacion",
  "alvara", "alvaras", "outorga", "outorgas", "concessao", "concessoes", "concession", "concessions",
  "frota", "frotas", "fleet", "fleets",
  "maquina", "maquinas", "maquinario", "machine", "machines", "machinery", "maquinaria",
  "equipamento", "equipamentos", "equipment", "equipo", "equipos",
  // Logística, transporte, frete e armazenagem passaram a serviço em 14/09 (ver o topo).
  "armazenamento", "storage",
];

const OPORTUNIDADE = [
  "oportunidade", "oportunidades", "opportunity", "opportunities",
  "projeto", "projetos", "project", "projects", "proyecto", "proyectos",
  "edital", "editais", "licitacao", "licitacoes", "tender", "tenders", "licitacion", "licitaciones",
  "parceria", "parcerias", "partnership", "partnerships",
];

const INVESTIMENTO = [
  "investimento", "investimentos", "investment", "investments", "inversion", "inversiones",
  "capital", "capitais",
  "fundo", "fundos", "fund", "funds", "fondo", "fondos",
  "financiamento", "financiamentos", "financing", "financiacion",
  "credito", "creditos", "credit", "aporte", "aportes",
  "investidor", "investidora", "investidores", "investidoras", "investor", "investors", "inversor", "inversores",
  "financeira", "financeiras", "financeiro", "financeiros", "financial", "financiera", "financiero",
];

const CONEXAO = [
  "conexao", "conexoes", "connection", "connections", "conexion", "conexiones",
  "rede", "redes", "network", "networks", "networking", "red",
  "contato", "contatos", "contact", "contacts", "contacto", "contactos",
  "acesso", "acessos", "access", "acceso", "accesos",
  "relacionamento", "relacionamentos", "relationship", "relationships",
  "canal", "canais", "channel", "channels", "canales",
  "parceiro", "parceiros", "parceira", "parceiras", "partner", "partners",
  "carteira", "cliente", "clientes", "customer", "customers",
  "comprador", "compradores", "compradora", "compradoras", "buyer", "buyers",
];

const TECNOLOGIA = [
  "tecnologia", "tecnologias", "technology", "technologies", "tech",
  "dados", "datos", "data", "database", "databases",
  "ferramenta", "ferramentas", "tool", "tools", "herramienta", "herramientas",
  "software", "softwares", "plataforma", "plataformas", "platform", "platforms",
  "app", "apps", "aplicativo", "aplicativos", "aplicacion", "aplicaciones", "application", "applications",
  "sistema", "sistemas", "system", "systems", "saas", "api", "apis",
  "algoritmo", "algoritmos", "algorithm", "algorithms",
  "patente", "patentes", "patent", "patents",
  "automacao", "automation", "automatizacion",
  "robotica", "robotics", "hardware", "dispositivo", "dispositivos", "device", "devices",
  "sensor", "sensores", "sensors", "iot", "blockchain",
];

const IMOVEL = [
  "imovel", "imoveis", "inmueble", "inmuebles", "property", "properties",
  "terreno", "terrenos", "land", "lote", "lotes",
  "galpao", "galpoes", "armazem", "armazens", "warehouse", "warehouses", "deposito", "depositos",
  "predio", "predios", "building", "buildings", "edificio", "edificios",
  "infraestrutura", "infrastructure", "infraestructura",
  "porto", "portos", "port", "ports", "puerto", "puertos", "aeroporto", "aeroportos",
  "ferrovia", "ferrovias", "rodovia", "rodovias",
  "hotel", "hoteis", "hotels", "pousada", "pousadas",
  "espaco", "espacos", "space", "spaces", "espacio", "espacios",
  "condominio", "condominios", "shopping",
  // O que uma pessoa de fato anuncia como imóvel e faltava aqui: sem estas, a
  // cabeça não decidia e a CATEGORIA passava a decidir — "Apartamento na praia"
  // com a categoria "Serviços jurídicos" virava serviço e caía no portão da
  // demanda expressa, que é restrição (defeito relatado depois da #101).
  //
  // A lista é CURTA de propósito, e ficou assim depois da revisão de 14/09
  // (9615971 e d7fac93 da #124, portados para cá). O erro custa caro para este
  // lado: classificar como imóvel TIRA o item do portão, e o par volta a casar
  // por categoria — o vazamento que a #101 existe para fechar. Faltar palavra
  // só mantém o que já havia; sobrar palavra abre buraco. Então só entra o que
  // não significa outra coisa fora do mercado imobiliário.
  //
  // Medido e removido por isso: "casa" (casa de câmbio, casa de software),
  // "house" (consulting house, publishing house), "loja"/"store" (loja virtual,
  // store management), "sala" (sala de reunião), "flat" (flat fee), "cobertura"
  // (reportagem, seguro, telhado) e, o pior deles, "vaga" — em rede de negócios
  // "Vaga de emprego" é vaga de trabalho, e virava imóvel.
  //
  // Isto vale para a OFERTA. No PEDIDO a conta é a oposta (faltar palavra solta o
  // portão da IA), e a cabeça do pedido tem leitura própria de casa, loja, flat,
  // sala comercial e vaga de garagem: ver `necessidadePedeImovel`.
  "apartamento", "apartamentos", "apartment", "apartments",
  "sobrado", "sobrados", "garagem", "garagens",
];

/**
 * Cabeças que nomeiam a casa de quem presta, mas que fora do serviço costumam
 * ser outra coisa: "boutique" é a loja ("Boutique de joias de design"), "casa" é a
 * casa de câmbio e a de software, "hub" e "instituto" são o lugar. São cabeça
 * neutra, para a leitura do serviço não as ler como especialidade: "Boutique de
 * advocacia tributária" [Jurídico] × "Advogado tributarista" e "Casa de
 * consultoria" [Consultoria] × "Consultoria" eram barrados, porque a cabeça que as
 * listas não conheciam impedia a leitura do serviço (116bb56 da #127 e a medição
 * do cético na #135, 15/09). Na classificação e na leitura só decidem com o
 * genitivo e o SUBSTANTIVO de serviço logo depois ("Casa DE CONSULTORIA"), nunca
 * com o serviço adiante ("Boutique de joias de DESIGN") nem com o adjetivo ("Hub
 * LOGÍSTICO" é o lugar, como "Centro logístico"). "Hub" nem assim decide a
 * classificação: "Hub de logística" em [Imóveis] é o galpão, e virar serviço o
 * tiraria do match por categoria. "Centro" fica de fora de propósito: "Centro de
 * treinamento" é infraestrutura (ver o topo do arquivo).
 */
const CABECAS_DE_ESTRUTURA_AMBIGUAS = [
  "boutique", "boutiques", "casa", "casas", "atelie", "atelies", "atelier", "ateliers",
  "studio", "studios", "estudio", "estudios", "instituto", "institutos", "institute", "institutes", "hub", "hubs",
];
const CABECAS_NEUTRAS_SO_COM_O_SERVICO_LOGO_DEPOIS = new Set(CABECAS_DE_ESTRUTURA_AMBIGUAS);
const CABECAS_NEUTRAS_SO_NA_LEITURA = new Set(["hub", "hubs"]);

/**
 * Cabeças que não dizem O QUE se oferece, só quem: "Empresa de contabilidade",
 * "Escritório de advocacia", "Equipe de engenharia". Não decidem; o resto do
 * termo decide. "Escritório" NÃO está em imóvel por isso: "Escritório
 * comercial" cai em "outros" (conservador), "Escritório de advocacia" em
 * serviço.
 */
const CABECAS_NEUTRAS = new Set([
  "empresa", "empresas", "firma", "firmas", "escritorio", "escritorios", "negocio", "negocios",
  "equipe", "equipes", "grupo", "grupos", "profissional", "profissionais", "especialista", "especialistas",
  "company", "companies", "firm", "firms", "office", "offices", "business", "businesses",
  "team", "teams", "group", "groups", "professional", "professionals", "specialist", "specialists",
  "oficina", "oficinas", "profesional", "profesionales", "despacho", "despachos",
  "agencia", "agencias", "agency", "agencies",
  // "Operador logístico", "Consultório odontológico"; "Operador de máquinas" e "Consultório para alugar" não (14/09).
  "operador", "operadora", "operadores", "operadoras", "consultorio", "consultorios", "provider", "providers",
  ...CABECAS_DE_ESTRUTURA_AMBIGUAS,
  // "Cabinet comptable", "Expert-comptable": com "comptable" lido como adjetivo, a cabeça francesa precisa ser neutra
  // (9e027bf da #127). Só decidem com o serviço no começo do complemento, ver CABECAS_NEUTRAS_SO_COM_O_SERVICO_NO_COMECO.
  "cabinet", "cabinets", "expert", "experts",
]);

/**
 * "Cabinet" é também o armário ("Cabinets de cuisine design") e "expert" o perito de qualquer coisa: na classificação só
 * decidem serviço com o serviço LOGO no começo do complemento, substantivo ou adjetivo ("Cabinet comptable", "Cabinet
 * d'avocats", "Expert-comptable"); com o serviço adiante, o armário virava serviço e caía no portão (116bb56 da #127). É
 * a regra que a #127 dá também a "boutique"; aqui "boutique" segue a leitura mais estreita da #135
 * (CABECAS_DE_ESTRUTURA_AMBIGUAS: genitivo e substantivo), porque "Boutique jurídica" não apareceu em caso real e "Hub
 * logístico" mostrou o custo do adjetivo.
 */
const CABECAS_NEUTRAS_SO_COM_O_SERVICO_NO_COMECO = new Set(["cabinet", "cabinets", "expert", "experts"]);

/** Com cabeça ambígua, o índice do serviço logo depois do genitivo, se for substantivo de serviço: "Casa DE consultoria". */
function servicoLogoDepoisDaCabeca(palavras: readonly string[], indice: number): number | null {
  let k = indice + 1;
  if (!GENITIVOS.has(palavras[k] ?? "")) return null;
  while (GENITIVOS.has(palavras[k] ?? "") || ARTIGOS.has(palavras[k] ?? "")) k += 1;
  const palavra = palavras[k] ?? "";
  const substantivo = SUBSTANTIVOS_DE_SERVICO.has(palavra) && !GENERICAS_DEMAIS.has(palavra) && !ADJETIVOS_DE_SERVICO.has(palavra);
  return substantivo || areaDoDireito(palavras as string[], k) ? k : null;
}

const COMPOSTOS = new Map<string, TipoDaOferta>([
  ["real estate", "imovel"],
  ["venture capital", "investimento"],
  ["private equity", "investimento"],
  ["seed capital", "investimento"],
  ["joint venture", "oportunidade"],
  ["supply chain", "ativo"],
  ["law firm", "servico"],
  ["legal advisory", "servico"],
  ["legal services", "servico"],
  // "бухгалтерский учёт" é a contabilidade em russo; "учёт" sozinho é registro de qualquer coisa (9e027bf da #127).
  ["бухгалтерский учет", "servico"],
  ["бухгалтерский учёт", "servico"],
  // 14/09: prestações que não têm substantivo de serviço nas listas.
  ["comercio exterior", "servico"],
  ["social media", "servico"],
  ["saude ocupacional", "servico"],
]);

/** O que a CATEGORIA digitada pela usuária diz do tipo, quando o termo não disse. */
const TIPO_POR_PALAVRA_DA_CATEGORIA = new Map<string, TipoDaOferta>([
  ...["servico", "servicos", "service", "services", "servicio", "servicios", "consultoria", "assessoria",
    "asesoria", "consulting", "advisory", "juridico", "juridica", "legal", "advocacia", "abogacia",
    "contabil", "contabilidade", "contabilidad", "accounting"].map(p => [p, "servico"] as const),
  ...["produto", "produtos", "product", "products", "producto", "productos", "mercadoria", "mercadorias"].map(p => [p, "produto"] as const),
  ...["ativo", "ativos", "asset", "assets", "activo", "activos"].map(p => [p, "ativo"] as const),
  ...["oportunidade", "oportunidades", "opportunity", "opportunities"].map(p => [p, "oportunidade"] as const),
  ...["investimento", "investimentos", "investment", "investments", "inversion", "inversiones", "capital",
    "financiamento", "financing", "financeiro", "financeiros", "financeira", "financeiras", "financial",
    "credito", "creditos", "credit"].map(p => [p, "investimento"] as const),
  ...["conexao", "conexoes", "connection", "connections", "network", "networking", "rede", "contatos",
    "relacionamento"].map(p => [p, "conexao"] as const),
  ...["tecnologia", "technology", "tech", "software", "tecnologico", "tecnologica"].map(p => [p, "tecnologia"] as const),
  ...["imovel", "imoveis", "imobiliario", "imobiliaria", "inmueble", "inmuebles", "infraestrutura",
    "infrastructure", "infraestructura", "property", "properties"].map(p => [p, "imovel"] as const),
]);

/** As listas por tipo — exposto para o teste conferir que nenhuma palavra está em dois tipos. */
export const LISTAS_POR_TIPO: ReadonlyArray<readonly [TipoDaOferta, readonly string[]]> = [
  ["servico", [...ASSESSORIA, ...ASSESSORIA_SO_NA_CABECA, ...OUTROS_SERVICOS]],
  ["produto", PRODUTO],
  ["ativo", ATIVO],
  ["oportunidade", OPORTUNIDADE],
  ["investimento", INVESTIMENTO],
  ["conexao", CONEXAO],
  ["tecnologia", TECNOLOGIA],
  ["imovel", IMOVEL],
];

const TIPO_POR_CABECA = new Map<string, TipoDaOferta>(
  LISTAS_POR_TIPO.flatMap(([tipo, palavras]) => palavras.map(palavra => [palavra, tipo] as const)),
);

/** Toda palavra de serviço (substantivos, adjetivos e genéricas) — a conferência de citação usa para não tolerar serviço inventado. */
export const PALAVRAS_DE_SERVICO: ReadonlySet<string> = new Set(LISTAS_POR_TIPO[0][1]);

const ehPalavraDeServico = (palavra: string) => TIPO_POR_CABECA.get(palavra) === "servico";
const tipoNaoServico = (palavra: string): TipoDaOferta | null => {
  const tipo = TIPO_POR_CABECA.get(palavra);
  return tipo && tipo !== "servico" ? tipo : null;
};

/** Verbos de quem pede, que saem da frente do termo como os marcadores fracos. */
const VERBOS_DE_NECESSIDADE = new Set([
  "precisamos", "buscamos", "procuramos", "queremos", "necessitamos", "desejamos", "gostariamos",
  "preciso", "busco", "procuro", "quero", "necessito", "desejo", "necesito", "busca", "procura",
  "contratar", "contratamos", "contrata", "contratando", "estamos", "estou", "gostaria", "se",
  "necesitamos", "necesitan", "we", "are", "am",
  // Nos idiomas novos (e6ddfa4 da #127): sem estes, "Suche Steuerberater" lia "suche" como especialidade.
  "suche", "suchen", "sucht", "gesucht", "benotige", "benotigen", "benotigt", "brauche", "brauchen", "braucht", "wir", "ich",
  "cherche", "cherchons", "recherche", "recherchons", "besoin", "nous", "je",
  "нужен", "нужна", "нужно", "нужны", "ищем", "ищу", "требуется", "требуются", "нам", "мне",
  "चाहिए", "हमें", "मुझे", "जरूरत", "نحتاج", "نبحث", "مطلوب", "أحتاج",
]);

/** A cabeça do termo (a primeira palavra que não é marcador fraco, verbo de quem pede, artigo nem genitivo) e onde ela está. */
function cabecaDoTermo(palavras: string[]) {
  let i = 0;
  const saiDaFrente = (palavra: string) =>
    MARCADORES_FRACOS.has(palavra) || VERBOS_DE_NECESSIDADE.has(palavra) || ARTIGOS.has(palavra) || GENITIVOS.has(palavra);
  // "looking for a lawyer": o "for" de quem procura sai junto com o marcador.
  const forDeQuemProcura = (k: number) => palavras[k] === "for" && k > 0 && MARCADORES_FRACOS.has(palavras[k - 1]);
  while (i < palavras.length - 1 && (saiDaFrente(palavras[i]) || forDeQuemProcura(i))) i += 1;
  return { indice: i, cabeca: palavras[i] as string | undefined, seguinte: palavras[i + 1] as string | undefined };
}

/** As palavras coladas à cabeça, até a primeira preposição ou conjunção. */
function juntoDaCabeca(palavras: string[], indice: number) {
  const fim = palavras.findIndex((palavra, i) => i > indice && FRONTEIRAS.has(palavra));
  return palavras.slice(indice + 1, fim < 0 ? undefined : fim);
}

/**
 * O complemento de uma cabeça neutra ou genérica: atravessa o genitivo
 * ("Empresa DE contabilidade"), para em outra preposição ou conjunção
 * ("Escritório PARA advogados" é o imóvel, não os advogados).
 */
function complementoDaCabeca(palavras: string[], indice: number) {
  const fim = palavras.findIndex((palavra, i) => i > indice && !GENITIVOS.has(palavra) && !atravessaEspecialista(palavras, i) && FRONTEIRAS.has(palavra));
  return palavras
    .slice(indice + 1, fim < 0 ? undefined : fim)
    .filter((palavra, k) => !GENITIVOS.has(palavra) && !ARTIGOS.has(palavra) && !ESPECIALISTA.has(palavra) && !atravessaEspecialista(palavras, indice + 1 + k));
}

/**
 * "Especialista EM direito tributário", "Empresa especializada EM consultoria":
 * depois de especialista/especializado, o "em" apresenta o que se presta, e o
 * complemento atravessa (revisão de 13/09).
 */
const ESPECIALISTA = new Set([
  "especialista", "especialistas", "specialist", "specialists", "especializado", "especializada",
  "especializados", "especializadas", "specialized",
]);
const EM_DO_ESPECIALISTA = new Set(["em", "no", "na", "nos", "nas", "in", "en"]);
function atravessaEspecialista(palavras: string[], i: number): boolean {
  return EM_DO_ESPECIALISTA.has(palavras[i]) && i > 0 && ESPECIALISTA.has(palavras[i - 1]);
}

/**
 * O que a categoria digitada diz. Palavra de serviço ESPECÍFICA (consultoria,
 * advocacia, marketing, auditoria, jurídico...) decide serviço em qualquer
 * posição — "Consultoria financeira" e "Advocacia imobiliária" são serviço.
 * Só o genérico "serviços" cede a uma palavra de outro tipo: "Serviços
 * financeiros" é capital, "Serviços de tecnologia" é tecnologia — a regra do
 * serviço não pode vazar para investimento e tecnologia por causa da palavra
 * "serviços" na categoria.
 */
function tipoPelaCategoria(categoria: string | null | undefined): TipoDaOferta | null {
  let generico = false;
  let outro: TipoDaOferta | null = null;
  for (const palavra of tokensDoTermo(categoria ?? "")) {
    const tipo = TIPO_POR_PALAVRA_DA_CATEGORIA.get(palavra) ?? TIPO_POR_CABECA.get(palavra);
    if (!tipo) continue;
    if (tipo === "servico") {
      if (GENERICAS_DEMAIS.has(palavra)) generico = true;
      else return "servico";
    } else if (!outro) {
      outro = tipo;
    }
  }
  return outro ?? (generico ? "servico" : null);
}
/**
 * Adjetivos em português e espanhol que, pospostos a um serviço, qualificam o
 * serviço e não viram a cabeça do termo, embora estejam em lista de outro
 * tipo: "Consultoria financeira", "Assessoria logística". Sem isto, a regra do
 * composto em inglês os lia como cabeça e o serviço escapava do portão como
 * capital ou ativo (revisão de 13/09).
 */
const ADJETIVOS_POSPOSTOS = new Set([
  "financeiro", "financeira", "financeiros", "financeiras", "financiero", "financiera", "financieros", "financieras",
  "logistico", "logistica", "logisticos", "logisticas",
]);
// "BPO financeiro" e "Terceirização financeira" são o serviço, não capital (14/09).
const CABECAS_COM_ADJETIVO_POSPOSTO = new Set(["consultoria", "assessoria", "auditoria", "contabilidade", "advocacia", "mentoria", "coaching", "bpo", "terceirizacao"]);

/**
 * "Direito" é serviço de advocacia só com uma ÁREA curada: colada ("Direito
 * tributário", "Derecho laboral") ou pelo genitivo ("Direito do trabalho",
 * "Direito de família"). Fora da lista, "direito" é o próprio ativo: "Direito
 * minerário", "Direito creditório", "Direito real de uso" e "Direito exclusivo
 * de distribuição" não são serviço (revisão de 13/09).
 */
const CABECAS_DO_DIREITO = new Set(["direito", "derecho"]);
const AREAS_DO_DIREITO = new Set([
  "tributario", "tributaria", "fiscal", "trabalhista", "laboral", "civil", "penal", "criminal",
  "empresarial", "societario", "societaria", "previdenciario", "previdenciaria", "ambiental",
  "imobiliario", "imobiliaria", "digital", "internacional", "administrativo", "administrativa",
  "regulatorio", "regulatoria", "aduaneiro", "aduaneira", "concorrencial", "contratual",
  "sucessorio", "sucessoria", "bancario", "bancaria", "eleitoral", "constitucional", "medico",
]);
const AREAS_DO_DIREITO_PELO_GENITIVO = new Set(["trabalho", "familia", "consumidor", "saude"]);
/** Áreas que também qualificam o próprio direito como ativo: "Direito digital DE transmissão do filme". */
const AREAS_QUE_QUALIFICAM_O_ATIVO = new Set(["digital", "internacional"]);

/** A área do direito que faz de "Direito X" um serviço, ou null. */
function areaDoDireito(palavras: string[], indice: number): string | null {
  if (!CABECAS_DO_DIREITO.has(palavras[indice] ?? "")) return null;
  const seguinte = palavras[indice + 1];
  if (seguinte && AREAS_DO_DIREITO.has(seguinte)) {
    // "Direito digital DE transmissão", "Direito internacional SOBRE a marca": o direito é o ativo (revisão de 14/09).
    const objeto = palavras[indice + 2] ?? "";
    return AREAS_QUE_QUALIFICAM_O_ATIVO.has(seguinte) && (GENITIVOS.has(objeto) || objeto === "sobre") ? null : seguinte;
  }
  const depois = palavras[indice + 2];
  if (seguinte && GENITIVOS.has(seguinte) && depois && AREAS_DO_DIREITO_PELO_GENITIVO.has(depois)) return depois;
  return null;
}

/**
 * Prestações que as listas não nomeavam por palavra solta (lacunas medidas em
 * 14/09, depois da #127). Cada regra é estreita de propósito — classificar
 * como serviço sujeita o item ao portão — e nenhuma dá família: o serviço é
 * reconhecido para ser BARRADO sem demanda expressa, e continua casando só
 * pelo slug, pelo objeto ou pelo núcleo, como qualquer termo fora das listas.
 *   - especialista pela área, sem a profissão: "Tributarista", "Criminalista";
 *   - atividade sobre área tributária, trabalhista ou previdenciária:
 *     "Planejamento tributário", "Recuperação de créditos de ICMS" — "Créditos
 *     tributários" à venda é capital e segue sendo;
 *   - desenvolvimento de tecnologia: "Desenvolvimento de software", "Web
 *     development" — "Plataforma em desenvolvimento" é a plataforma;
 *   - projeto técnico: "Projeto arquitetônico", "Projetos estruturais" —
 *     "Projeto de engenharia" fica como oportunidade, porque é também a obra
 *     que alguém tem e precisa contratar.
 */
const ESPECIALISTAS_PELA_AREA = new Set([
  "tributarista", "tributaristas", "fiscalista", "fiscalistas", "previdenciarista", "previdenciaristas",
  "criminalista", "criminalistas", "penalista", "penalistas", "civilista", "civilistas",
  "societarista", "societaristas", "laboralista", "laboralistas",
]);
const ATIVIDADES_SOBRE_AREA = new Set(["planejamento", "recuperacao", "compensacao", "revisao", "regularizacao", "planning"]);
const AREAS_DA_ATIVIDADE = new Set(["tributario", "trabalhista", "previdenciario"]);
const DESENVOLVIMENTO = new Set(["desenvolvimento", "development", "desarrollo"]);
const OBJETOS_DE_DESENVOLVIMENTO = new Set(["web", "site", "sites", "website", "websites", "mobile", "ecommerce"]);
const CABECAS_DE_PROJETO = new Set(["projeto", "projetos", "proyecto", "proyectos"]);
const PROJETOS_TECNICOS = new Set([
  "arquitetonico", "arquitetonica", "arquitetonicos", "arquitetonicas", "estrutural", "estruturais",
  "eletrico", "eletricos", "hidraulico", "hidraulicos", "hidrossanitario", "hidrossanitarios",
  "luminotecnico", "luminotecnicos", "paisagistico", "paisagisticos",
]);

function servicoSemPalavraDeServico(palavras: string[], indice: number, cabeca: string, junto: string[]): boolean {
  if (ESPECIALISTAS_PELA_AREA.has(cabeca)) return true;
  if (ATIVIDADES_SOBRE_AREA.has(cabeca)) {
    return palavras.slice(indice + 1).some(palavra => AREAS_DA_ATIVIDADE.has(lemaCurado(palavra) ?? ""));
  }
  const ehObjeto = (palavra: string | undefined) =>
    !!palavra && (OBJETOS_DE_DESENVOLVIMENTO.has(palavra) || TIPO_POR_CABECA.get(palavra) === "tecnologia");
  if (DESENVOLVIMENTO.has(cabeca)) return ehObjeto(complementoDaCabeca(palavras, indice)[0]);
  if (ehObjeto(cabeca) && junto.some(palavra => DESENVOLVIMENTO.has(palavra))) return true;
  return CABECAS_DE_PROJETO.has(cabeca) && PROJETOS_TECNICOS.has(junto[0] ?? "");
}

/**
 * "Avocat" é o advogado e também o abacate ("Avocats Hass export international"
 * [Fruits]). Na classificação, só é serviço com qualificador jurídico: palavra
 * jurídica em qualquer posição ("Avocat en DROIT du travail", "Avocat
 * d'AFFAIRES", "CABINET d'avocats"), ou área do direito e outro serviço COLADOS a
 * "avocat", atravessando só o genitivo e o "en" ("Avocat FISCALISTE", "Avocat
 * FISCAL"). Área solta no rótulo não basta: "Avocats Hass, export
 * INTERNATIONAL" e "Avocats frais, qualité FISCAL" são o abacate, e em [Fruits]
 * perdiam o match por categoria (revisão de 15/09 na #127, 116bb56, portada).
 * Sem qualificador a palavra sai da classificação e a categoria decide, como
 * antes de "avocat" entrar nas listas. "Avocate" é só a advogada. A leitura da
 * necessidade não muda: quem PROCURA "Avocat" nomeia a advocacia.
 */
const AVOCAT = new Set(["avocat", "avocats"]);
const QUALIFICA_O_AVOCAT = new Set(["droit", "affaires", "barreau", "cabinet", "cabinets"]);
const LIGA_O_AVOCAT = new Set([D_APOSTROFO, "de", "du", "des", "l", "la", "le", "les", "en", "au", "aux"]);
const AREAS_DO_AVOCAT = new Set(["tributario", "trabalhista", "societario", "previdenciario", "criminal", "civil", "familia", "imigracao", "contratual", "imobiliario", "ambiental"]);
/** Não é palavra de nenhuma lista: os tokens só têm letras e dígitos. */
const PALAVRA_SEM_TIPO = "~";

function semAbacate(palavras: string[]): string[] {
  if (!palavras.some(palavra => AVOCAT.has(palavra))) return palavras;
  const vizinho = (i: number, passo: number) => {
    let k = i + passo;
    while (LIGA_O_AVOCAT.has(palavras[k] ?? "")) k += passo;
    return palavras[k] ?? "";
  };
  const qualificaColado = (palavra: string) =>
    palavra !== "" && !AVOCAT.has(palavra) && (AREAS_DO_AVOCAT.has(lemaCurado(palavra) ?? "") || ehPalavraDeServico(palavra));
  const qualificado = palavras.some(palavra => QUALIFICA_O_AVOCAT.has(palavra))
    || palavras.some((palavra, i) => AVOCAT.has(palavra) && (qualificaColado(vizinho(i, 1)) || qualificaColado(vizinho(i, -1))));
  return qualificado ? palavras : palavras.map(palavra => (AVOCAT.has(palavra) ? PALAVRA_SEM_TIPO : palavra));
}

/**
 * "Conseil" e "conseiller" são a consultoria e o consultor, e também o conselho e
 * o conselheiro de um órgão: "Conseil d'administration", "Conseil municipal",
 * "Conseiller municipal", "Conseil d'État" não são serviço; "Conseil fiscal",
 * "Conseil en stratégie" e "Conseillère fiscale" seguem sendo. A palavra seguida
 * do órgão sai do termo, na classificação e na leitura do serviço (guarda da
 * 9e027bf e da 116bb56 da #127, portada com "conseiller" nas listas).
 */
const CONSEIL = new Set(["conseil", "conseils", "conseiller", "conseillers", "conseillere", "conseilleres"]);
const LIGA_O_CONSEIL = new Set([D_APOSTROFO, "de", "du", "des", "l", "la", "le", "les"]);
const ORGAOS_DO_CONSEIL = new Set([
  "administration", "surveillance", "municipal", "municipaux", "regional", "regionaux", "general", "generaux",
  "departemental", "national", "constitutionnel", "ministres", "etat", "securite", "prud", "ordre",
  // os femininos, que "conseillère" trouxe ("Conseillère municipale")
  "municipale", "municipales", "regionale", "regionales", "generale", "generales", "departementale", "departementales",
  "nationale", "nationales",
]);

function semConselhoDeOrgao(palavras: string[]): string[] {
  if (!palavras.some(palavra => CONSEIL.has(palavra))) return palavras;
  return palavras.map((palavra, i) => {
    if (!CONSEIL.has(palavra)) return palavra;
    let k = i + 1;
    while (LIGA_O_CONSEIL.has(palavras[k] ?? "")) k += 1;
    return ORGAOS_DO_CONSEIL.has(palavras[k] ?? "") ? PALAVRA_SEM_TIPO : palavra;
  });
}

/**
 * Classifica um item de "o que tenho" / "o que possui". `categoria` é a
 * categoria livre que a usuária digitou junto (opcional) e só decide quando o
 * texto do item não decidiu. Na dúvida, "outros".
 */
function classificarPeloTexto(rotulo: string, categoria?: string | null): TipoDaOferta {
  const palavras = semConselhoDeOrgao(semAbacate(tokensDoTermo(rotulo)));
  const { indice, cabeca, seguinte } = cabecaDoTermo(palavras);
  if (!cabeca) return tipoPelaCategoria(categoria) ?? "outros";
  const junto = juntoDaCabeca(palavras, indice);
  const semFronteira = junto.length === palavras.length - indice - 1;
  // 1. Composto sem preposição cuja ÚLTIMA palavra é de outro tipo, com a
  //    primeira sendo de serviço: "Marketing platform", "Accounting software",
  //    "Training materials", "Legal database" — em inglês a cabeça é a última
  //    palavra, e ali o serviço é só o assunto do produto.
  //    Adjetivo posposto em português ou espanhol não é cabeça inglesa:
  //    "Consultoria financeira" e "Consultoria logística" são serviço.
  if (semFronteira && junto.length > 0 && ehPalavraDeServico(cabeca)) {
    const final = junto[junto.length - 1];
    // Só nas cabeças de aconselhamento: "Suporte financeiro" e "Assistência financeira" são aporte de capital.
    const aconselha = CABECAS_COM_ADJETIVO_POSPOSTO.has(familiaDaPalavra(cabeca));
    const ultimo = ADJETIVOS_POSPOSTOS.has(final) && aconselha ? null : tipoNaoServico(final);
    if (ultimo) return ultimo;
  }
  // 2. Substantivo de serviço colado à cabeça (antes do composto: "Real
  //    estate consulting" é consultoria, não o imóvel).
  if (junto.some(palavra => SUBSTANTIVOS_DE_SERVICO.has(palavra))) return "servico";
  if (seguinte) {
    const composto = COMPOSTOS.get(`${cabeca} ${seguinte}`);
    if (composto) return composto;
  }
  // 3. Cabeça genérica ("Serviços de X", "Prestação de X"): o complemento
  //    decide — "Serviços de logística" é logística, "Serviços financeiros" é
  //    capital, "Serviços de tradução" é serviço.
  if (GENERICAS_DEMAIS.has(cabeca)) {
    const complemento = complementoDaCabeca(palavras, indice);
    return (complemento.length ? tipoNaoServico(complemento[0]) : null) ?? "servico";
  }
  // 3b. "Direito" com área curada é advocacia pelo texto: "Direito tributário",
  //     "Direito do trabalho". Sem isto, "Direito tributário" sem categoria caía
  //     em "outros" e escapava do portão (buraco registrado na #124); "Direito
  //     minerário" e "Direito creditório" seguem sem ser serviço.
  if (areaDoDireito(palavras, indice)) return "servico";
  // 3c. Prestação sem substantivo de serviço: "Tributarista", "Planejamento
  //     tributário", "Desenvolvimento de software", "Projeto arquitetônico".
  //     Antes da cabeça, porque "Software development" e "Projetos estruturais"
  //     têm cabeça de tecnologia e de oportunidade.
  if (servicoSemPalavraDeServico(palavras, indice, cabeca, junto)) return "servico";
  // 4. A cabeça manda — salvo o adjetivo de profissão anteposto com substantivo colado que não é serviço
  //    ("Juristische Person", "Бухгалтерский баланс"): a cabeça de fato é o substantivo. Com substantivo de serviço
  //    colado ("Juristische Beratung", "Юридические услуги") o passo 2 já decidiu (9e027bf da #127).
  if (!CABECAS_NEUTRAS.has(cabeca) && !(ADJETIVOS_ANTEPOSTOS.has(cabeca) && junto.length > 0)) {
    const pelaCabeca = TIPO_POR_CABECA.get(cabeca);
    if (pelaCabeca) return pelaCabeca;
  }
  // 5. Cabeça neutra: o complemento decide, atravessando só o genitivo.
  if (CABECAS_NEUTRAS_SO_COM_O_SERVICO_LOGO_DEPOIS.has(cabeca)) {
    // "Casa DE CONSULTORIA", "Boutique DE ADVOCACIA tributária"; "Boutique de joias de design" e "Hub logístico" não.
    if (!CABECAS_NEUTRAS_SO_NA_LEITURA.has(cabeca) && servicoLogoDepoisDaCabeca(palavras, indice) !== null) return "servico";
  } else if (CABECAS_NEUTRAS.has(cabeca)) {
    const complemento = complementoDaCabeca(palavras, indice);
    // A primeira palavra do complemento de outro tipo manda: "Empresa especializada em SOFTWARES jurídicos" é tecnologia.
    const primeiraDeOutroTipo = tipoNaoServico(complemento[0] ?? "") !== null;
    // "Cabinet" e "expert" só com o serviço logo no começo: "Cabinets de cuisine DESIGN" é o armário.
    const ondeOServicoDecide = CABECAS_NEUTRAS_SO_COM_O_SERVICO_NO_COMECO.has(cabeca) ? complemento.slice(0, 1) : complemento;
    if (!primeiraDeOutroTipo && ondeOServicoDecide.some((palavra, k) => SUBSTANTIVOS_DE_SERVICO.has(palavra) || ADJETIVOS_DE_SERVICO.has(palavra) || areaDoDireito(complemento, k) !== null)) {
      return "servico";
    }
  }
  // 6. Escrita sem fronteira de palavra (chinês, japonês): a esta altura o
  //    caminho por token não achou nada, porque o rótulo inteiro é um token só.
  //    Vem por último de propósito — não passa por cima de decisão nenhuma. O
  //    serviço precisa TERMINAR o termo (9e027bf da #127): "会计软件" é o software.
  if (familiaSemEspaco(rotulo)) return "servico";
  // 7. A CATEGORIA decide o que o texto não decidiu. Isto já foi relatado como
  //    defeito duas vezes, por revisores diferentes — "Cafeteira industrial" na
  //    categoria "Consultoria" vira serviço e cai no portão, que é restrição —
  //    e FICA ASSIM por decisão do time em 14/09. O motivo: a categoria é o
  //    último recurso que faz "Direito tributário", "Planejamento patrimonial",
  //    "Contratos" e "Campanhas" serem reconhecidos como serviço, que é o caso
  //    central da regra da cliente. Tirar daqui quebra cinco testes, entre eles
  //    o farol "'Direito tributário' [Serviços] × 'Compradores' [Serviços] não
  //    casa" — o par que a #101 existe para barrar.
  //
  //    O que se faz no lugar: fechar LACUNA DE LÉXICO quando aparecer caso real
  //    (foi assim que apartamento, sobrado e garagem entraram em IMOVEL), para
  //    a cabeça decidir antes de chegar aqui. E a causa raiz — a categoria ser
  //    texto livre — é dívida registrada no quadro, não conserto deste arquivo.
  return tipoPelaCategoria(categoria) ?? "outros";
}

/** "Consultora Natura" é revendedora de produto, não consultoria (revisão de 13/09). */
const MARCAS_DE_VENDA_DIRETA = new Set([
  "natura", "avon", "boticario", "jequiti", "hinode", "eudora", "tupperware", "herbalife", "oriflame", "jeunesse", "racco", "demillus", "polishop", "mary kay",
]);
const CONSULTORA_DE_REVENDA = new Set(["consultor", "consultora", "consultores", "consultoras", "revendedor", "revendedora", "revendedores", "revendedoras"]);

/** Revenda de marca COLADA à cabeça: "Consultora Natura", "Consultora Mary Kay". "Mentoria para revendedoras Natura" continua serviço. */
function ehRevenda(palavras: string[]): boolean {
  const { indice, cabeca } = cabecaDoTermo(palavras);
  if (!cabeca || !CONSULTORA_DE_REVENDA.has(cabeca)) return false;
  const juntos = ` ${[cabeca, ...juntoDaCabeca(palavras, indice)].join(" ")} `;
  return Array.from(MARCAS_DE_VENDA_DIRETA).some(marca => juntos.includes(` ${marca} `));
}
export function classificarOferta(rotulo: string, categoria?: string | null): TipoDaOferta {
  const tipo = classificarPeloTexto(rotulo, categoria);
  if (tipo === "servico" && ehRevenda(tokensDoTermo(rotulo))) {
    const pelaCategoria = tipoPelaCategoria(categoria);
    return pelaCategoria && pelaCategoria !== "servico" ? pelaCategoria : "outros";
  }
  return tipo;
}

/** O item é um SERVIÇO — o único tipo em que o portão da demanda expressa atua. */
export function ehServico(rotulo: string, categoria?: string | null): boolean {
  return classificarOferta(rotulo, categoria) === "servico";
}

// ─── O serviço que o termo NOMEIA: família e especialidade ───────────────────
//
// Defeitos relatados em 13/09 na regra de 12/09, que só reconhecia a
// necessidade GENÉRICA de uma palavra:
//   (a) a mesma especialidade escrita de outro jeito dava zero — "Advocacia
//       tributária" diante de "Advogado tributarista" caía de 60 para 0, e no
//       motor privado a sugestão pendente era apagada na regeneração;
//   (c) a família juntava serviços diferentes — "Assessoria de imprensa"
//       diante de "Consultoria" e "Interpretação de exames" diante de
//       "Tradutor" davam 100.
//
// REGRA ESTRITA (três revisões adversariais em 13/09): o motor só afirma que
// dois serviços são o mesmo quando ENTENDE o que os distingue. A família é o
// lema da palavra que nomeia o serviço; a especialidade são as palavras que o
// qualificam. Palavra fora das listas curadas precisa aparecer IGUAL dos dois
// lados, e a oferta não pode ter palavra desconhecida a mais ("Consultoria em
// SEGURANÇA do trabalho" não é consultoria trabalhista, "Consultoria em
// SEGUROS empresariais" não é consultoria empresarial). Na dúvida, não casa —
// que é o comportamento de antes da correção. Nos idiomas em que as listas são
// curtas, o que elas não leem não é bloqueado: ver `regraNaoLeOPar`.

/**
 * Consultoria e assessoria são lemas diferentes, mas próximos: "Consultoria
 * tributária" atende "Assessoria tributária". Só com especialidade escrita dos
 * dois lados, e nunca com assessoria que não aconselha.
 */
const SINONIMOS_PROXIMOS = new Set(["consultoria|assessoria", "assessoria|consultoria"]);

/** As famílias que atendem a opção fixa "Consultoria" de "O que preciso". */
const FAMILIAS_DE_ASSESSORIA = new Set(["consultoria", "assessoria", "advocacia", "contabilidade", "auditoria", "mentoria", "coaching"]);

/** Pedido de apoio que pode nomear a profissão pelo adjetivo: "assessoria JURÍDICA", "suporte CONTÁBIL". */
const FAMILIAS_DE_APOIO = new Set(["consultoria", "assessoria", "suporte", "assistencia", "atendimento"]);
const PROFISSOES_PELO_ADJETIVO = new Set(["advocacia", "contabilidade"]);

/**
 * Áreas em que a ASSESSORIA ou a CONSULTORIA pedida é trabalho da profissão — o exemplo 1 da spec da Glenda
 * (14/09): "Assessoria tributária para revisão da carga fiscal da empresa" é atendida por "Serviços jurídicos
 * especializados em Direito Tributário", e também por "Contabilidade tributária". Quem pede assessoria numa
 * destas áreas não nomeou a profissão, e as duas a prestam; quem nomeou ("Contador tributário") segue sem casar
 * com a advocacia. Só entram áreas que nomeiam inequivocamente trabalho de advogado ou de contador:
 * "empresarial" (gestão), "imobiliária" (corretagem), "ambiental" e "civil" (engenharia) e "financeira"
 * (investimento) ficam de fora — "Consultoria empresarial" continua sem atender "Advocacia empresarial".
 */
const AREAS_DAS_PROFISSOES: Readonly<Record<string, ReadonlySet<string>>> = {
  advocacia: new Set(["tributario", "trabalhista", "previdenciario", "societario", "contratual", "criminal", "imigracao", "familia"]),
  contabilidade: new Set(["tributario", "trabalhista", "previdenciario", "societario"]),
};
const APOIO_QUE_ACONSELHA = new Set(["consultoria", "assessoria"]);

/**
 * Preposições que apresentam o ASSUNTO do serviço: "Consultoria EM marketing",
 * "Advogado DE imigração". As demais ("para", "com", "for", "to"...) abrem
 * público-alvo ou finalidade.
 */
const PREPOSICOES_DE_ASSUNTO = new Set([...Array.from(GENITIVOS), "em", "no", "na", "nos", "nas", "sobre", "in", "on", "en", "del", "по"]);

/** Palavras que qualificam quem presta ou como se pede, não o que se presta. */
const PALAVRAS_SEM_ESPECIALIDADE = new Set([
  ...Array.from(VERBOS_DE_NECESSIDADE),
  "especializado", "especializada", "especializados", "especializadas", "especialidade", "especialidades", "specialized",
  "area", "areas", "urgente", "urgentes", "urgentemente", "experiente", "experientes", "qualificado", "qualificada", "qualificados",
  "qualificadas", "bom", "boa", "bons", "boas", "confiavel", "confiaveis", "nosso", "nossa", "nossos", "nossas",
  "meu", "minha", "seu", "sua", "um", "uma", "algum", "alguma", "queria",
  // "público" e "seleção" não: nomeiam área ("gestão pública") e serviço ("consultoria de seleção").
  "confianca", "online",
  "senior", "junior", "pleno", "bilingue", "trilingue", "altamente", "freelancer", "autonomo", "autonoma",
  "inscrito", "inscrita", "registrado", "registrada", "habilitado", "habilitada", "oab", "crc", "crea",
  "indicacao", "indicacoes", "contratacao", "contratacoes",
  // en/es/fr: artigo e possessivos que o ARTIGOS compartilhado não tem ("We need an accountant", "our marketing")
  "an", "i", "our", "my", "your", "their", "nuestro", "nuestra", "nuestros", "nuestras", "su", "sus", "notre", "votre",
  "experienced", "reliable", "good", "qualified", "trusted",
]);

/** Depois destas, "em"/"para"/"a" apresentam o assunto: "com foco em", "voltada para", "com especialização em". */
const QUALIFICA_O_ASSUNTO = new Set([
  "foco", "experiencia", "atuacao", "enfase", "focus", "experience", "expertise", "focado", "focada",
  "voltado", "voltada", "dedicado", "dedicada", "direcionado", "direcionada", "orientado", "orientada",
  "especializacao", "mba", "formacao", "pos", "graduacao",
  "especializado", "especializada", "especializados", "especializadas", "specialized",
]);

/**
 * O lema das especialidades mais comuns, CURADO: flexões, as formas em -ista e
 * a tradução. Corte de sufixo foi medido e descartado — juntava "carreira" com
 * "carros", "social" com "sócios" e "ambiental" com "ambientes". Palavra fora
 * daqui perde só o número e o gênero, e só casa escrita igual.
 */
const LEMAS_DE_ESPECIALIDADE: Record<string, readonly string[]> = {
  tributario: ["tributario", "tributaria", "tributarios", "tributarias", "tributarista", "tributaristas", "tributo", "tributos", "tributacao", "fiscal", "fiscais", "fiscalista", "fiscalistas", "fiscaliste", "fiscalistes",
    // o feminino francês ("Conseillère fiscale") e o imposto em hindi ("कर सलाहकार", consultor tributário): sem eles o
    // pedido ficava com especialidade que as listas não leem (revisão de 15/09 na #127, 116bb56, portada)
    "fiscale", "fiscales", "कर", "करों", "imposto", "impostos", "tax", "taxes", "taxation", "icms", "iss", "pis", "cofins", "irpj", "csll", "impuesto", "impuestos", "tributacion",
    // fr, ru e ar (e6ddfa4 da #127: "Налоговый консалтинг" × "Налоговая консультация" [Финансы] caía de 60 para 0). Em
    // chinês e japonês a especialidade tributária é lida em ESPECIALIDADES_SEM_ESPACO ("税务", "税務", "稅務").
    "fiscalite", "налог", "налоги", "налогов", "налогам", "налогами", "налогах", "налоговый", "налоговая", "налоговое", "налоговые",
    "налоговых", "налоговой", "налогового", "налогообложение", "налогообложения",
    "ضريبي", "ضريبية", "ضرائب", "الضرائب", "الضريبية"],
  trabalhista: ["trabalhista", "trabalhistas", "trabalho", "laboral", "laborais", "laboralista", "laboralistas", "labor", "labour", "employment", "laborales", "travail"],
  societario: ["societario", "societaria", "societarios", "societarias", "societarista", "societaristas"],
  previdenciario: ["previdenciario", "previdenciaria", "previdenciarios", "previdenciarias", "previdenciarista", "previdenciaristas", "previdencia"],
  criminal: ["criminal", "criminais", "criminalista", "criminalistas", "penal", "penais", "penalista", "penalistas", "penales"],
  civil: ["civil", "civel", "civeis", "civis", "civiles", "civilista", "civilistas"],
  imobiliario: ["imobiliario", "imobiliaria", "imobiliarios", "imobiliarias", "inmobiliario", "inmobiliaria", "inmobiliarios", "imovel", "imoveis", "property", "properties"],
  ambiental: ["ambiental", "ambientais", "ambientales", "ambientalista", "ambientalistas", "environmental", "environment"],
  empresarial: ["empresarial", "empresariais", "empresa", "empresas", "mercantil", "mercantis"],
  familia: ["familia", "familias", "familiar", "familiares", "family", "divorcio", "divorcios", "partilha", "partilhas"],
  imigracao: ["imigracao", "imigratorio", "imigratoria", "migratorio", "migratoria", "immigration", "inmigracion"],
  financeiro: ["financeiro", "financeira", "financeiros", "financeiras", "financas", "financial", "finance", "financiero", "financiera", "finanzas"],
  juramentado: ["juramentado", "juramentada", "juramentados", "juramentadas", "sworn"],
  contratual: ["contratual", "contratuais", "contrato", "contratos", "contract", "contracts", "contractual"],
  digital: ["digital", "digitais", "digitales"],
  internacional: ["internacional", "internacionais", "international", "internacionales"],
  tecnico: ["tecnico", "tecnica", "tecnicos", "tecnicas", "technical"],
};

const LEMA_DA_ESPECIALIDADE = new Map<string, string>(
  Object.entries(LEMAS_DE_ESPECIALIDADE).flatMap(([lema, palavras]) => palavras.map(palavra => [palavra, lema] as const)),
);
/** Áreas que, junto de "corporativo", dizem que ele é só o público (empresas): "Advocacia tributária corporativa". */
const AREAS_CONTENCIOSAS = new Set(["tributario", "trabalhista", "criminal", "previdenciario", "civil", "familia", "imobiliario", "ambiental", "imigracao"]);

/**
 * Palavras que só são de família na advocacia: "Advogado para inventário", "para
 * pensão alimentícia". Fora dela são outra coisa — "Auditoria de inventário" é
 * estoque, "Consultoria em inventário de emissões" é carbono — e por isso não
 * estão em LEMAS_DE_ESPECIALIDADE (revisão de 14/09).
 */
const FAMILIA_SO_NA_ADVOCACIA = new Set(["inventario", "inventarios", "pensao", "pensoes"]);
const COMPLEMENTO_DA_PENSAO = new Set(["alimenticia", "alimenticias", "alimentar", "alimentares"]);
/** "Holding FAMILIAR", "empresa FAMILIAR", "FAMILY business": o tipo da empresa, não a área de família. */
const FAMILIAR = new Set(["familiar", "familiares", "family"]);
const EMPRESAS_FAMILIARES = new Set(["holding", "holdings", "empresa", "empresas", "negocio", "negocios", "business", "businesses", "company", "companies"]);

/**
 * Palavras de atividade que não mudam o serviço QUANDO há uma especialidade
 * reconhecida no mesmo item: "Consultoria em PLANEJAMENTO financeiro",
 * "Auditoria de DEMONSTRAÇÕES financeiras". Sozinhas, são assunto como
 * qualquer outro ("Consultoria em gestão" não é a consultoria genérica).
 */
const PALAVRAS_DE_ATIVIDADE = new Set([
  "planejamento", "gestao", "questao", "questoes", "obrigacao", "obrigacoes", "demonstracao", "demonstracoes",
  "processo", "processos", "acao", "acoes", "contencioso", "rotina", "rotinas", "departamento", "setor", "setores",
  "regularizacao", "consultivo", "consultiva", "controle", "analise", "revisao", "assunto", "assuntos", "demanda",
  "demandas", "caso", "casos", "problema", "problemas", "causa", "causas", "defesa", "planning", "management",
]);

/**
 * Adjetivos de estilo, que dizem COMO se presta e não o quê: "Advocacia
 * tributária ESTRATÉGICA" é advocacia tributária. Seguem a regra das palavras de
 * atividade: só saem da especialidade quando o mesmo item tem uma especialidade
 * reconhecida. Sozinhos continuam sendo o assunto — "Consultoria estratégica" é
 * um tipo de consultoria, e não a genérica. Sem isto, "estratégica" na oferta
 * era palavra desconhecida que o pedido também tinha, e "Consultoria tributária
 * estratégica" × "Consultoria estratégica" valia 100, acima do corte de e-mail,
 * por um serviço que ninguém pediu (ff9564f da #127, portada na revisão de 15/09).
 */
const ADJETIVOS_DE_ESTILO = new Set(["estrategico", "estrategica", "estrategicos", "estrategicas", "strategic"]);

/** Plurais que não terminam só em -s: exportações, gerais, papéis, embalagens, exportadores. */
const PLURAIS_IRREGULARES: ReadonlyArray<readonly [string, string]> = [
  ["coes", "cao"], ["oes", "ao"], ["ais", "al"], ["eis", "el"], ["ns", "m"], ["wares", "ware"], ["ores", "or"], ["eres", "er"], ["ares", "ar"],
];

/** O singular (só palavras de mais de cinco letras perdem os plurais irregulares: "reais", "mais" e "bares" ficam). */
const singularDe = (palavra: string) => {
  if (palavra.length > 5) {
    for (const [plural, singular] of PLURAIS_IRREGULARES) {
      if (palavra.endsWith(plural)) return palavra.slice(0, -plural.length) + singular;
    }
  }
  return palavra.length > 4 && palavra.endsWith("s") ? palavra.slice(0, -1) : palavra;
};

const semGeneroNemNumero = (palavra: string) => {
  const lema = singularDe(palavra);
  return lema.length > 4 && (lema.endsWith("a") || lema.endsWith("o")) ? lema.slice(0, -1) : lema;
};

const CORPORATIVO = new Set(["corporativo", "corporativa", "corporativos", "corporativas", "corporate"]);

const lemaCurado = (palavra: string) => LEMA_DA_ESPECIALIDADE.get(palavra) ?? LEMA_DA_ESPECIALIDADE.get(singularDe(palavra));

/** O lema de uma palavra de especialidade; palavra de serviço vira a sua família ("jurídica" → advocacia). */
function lemaDaEspecialidade(palavra: string): string {
  const curado = lemaCurado(palavra);
  if (curado) return curado;
  if (SUBSTANTIVOS_DE_SERVICO.has(palavra) || ADJETIVOS_DE_SERVICO.has(palavra)) return familiaDaPalavra(palavra);
  return semGeneroNemNumero(palavra);
}

const ehSubstantivoDeServico = (palavra: string) => SUBSTANTIVOS_DE_SERVICO.has(palavra) && !GENERICAS_DEMAIS.has(palavra);

/** "e-commerce", "e-mail": o "e" com hífen não é conjunção. Vírgula e barra coordenam como "e". */
const E_COM_HIFEN = new RegExp("(^|[^\\p{L}])([eE])[-\\u2010\\u2011](\\p{L})", "gu");
const COORDENA_COMO_E = new RegExp("[,;/]+", "g");
const palavrasDe = (texto: string) => semConselhoDeOrgao(tokensDoTermo(texto.replace(E_COM_HIFEN, "$1$2$3").replace(COORDENA_COMO_E, " e ")));

/** Onde o termo começa de fato: depois de marcadores, artigos, genitivo e verbos de quem pede. */
function inicioDoServico(palavras: string[]): number {
  let i = 0;
  const forDeQuemProcura = (k: number) => palavras[k] === "for" && k > 0 && MARCADORES_FRACOS.has(palavras[k - 1]);
  while (i < palavras.length - 1 && (MARCADORES_FRACOS.has(palavras[i]) || ARTIGOS.has(palavras[i]) || GENITIVOS.has(palavras[i]) || PALAVRAS_SEM_ESPECIALIDADE.has(palavras[i]) || forDeQuemProcura(i))) i += 1;
  return i;
}

/** Quantas palavras a partir de `indice` formam um lugar ("são paulo", "brasil"); 0 se não é lugar. */
function comprimentoDoLugar(palavras: string[], indice: number): number {
  for (let n = Math.min(4, palavras.length - indice); n >= 1; n -= 1) {
    if (ehLugar(palavras.slice(indice, indice + n))) return n;
  }
  return 0;
}

/**
 * Em serviço de língua o idioma É a especialidade: "Tradução de alemão" não
 * atende "Tradutor de japonês". Lido antes do corte por lugar, porque os
 * gentílicos também são lugar.
 */
const IDIOMAS: Record<string, readonly string[]> = {
  portugues: ["portugues", "portuguesa", "portuguese"],
  espanhol: ["espanhol", "espanhola", "spanish", "espanol", "castelhano"],
  ingles: ["ingles", "inglesa", "english"],
  alemao: ["alemao", "alema", "german", "aleman", "alemana"],
  frances: ["frances", "francesa", "french"],
  italiano: ["italiano", "italiana", "italian"],
  chines: ["chines", "chinesa", "chinese", "mandarim", "mandarin", "chino"],
  japones: ["japones", "japonesa", "japanese"],
  arabe: ["arabe", "arabic"],
  russo: ["russo", "russa", "russian", "ruso"],
  coreano: ["coreano", "coreana", "korean"],
  hebraico: ["hebraico", "hebrew"],
  libras: ["libras"],
};
const IDIOMA_DA_PALAVRA = new Map<string, string>(
  Object.entries(IDIOMAS).flatMap(([idioma, formas]) => formas.map(forma => [forma, `idioma:${idioma}`] as const)),
);

/**
 * Cidades e siglas lidas como lugar SÓ depois de "em/no/na/in/en" ("Contador em
 * Campinas/SP", "Advogado em BH e região"). Ficam aqui, e não nos lugares de
 * direcao-do-termo.ts, porque "Natal" e "Salvador" soltos são outra coisa.
 */
const UFS = new Set(["sp", "rj", "mg", "rs", "sc", "pr", "ba", "pe", "ce", "df", "go", "pa", "es", "mt", "ms", "am", "ma", "pb", "rn", "al", "se", "pi", "to", "ro", "ac", "ap", "rr"]);
const CIDADES = new Set([
  ...Array.from(UFS), "bh", "poa", "rio",
  "curitiba", "recife", "salvador", "fortaleza", "brasilia", "goiania", "manaus", "belem", "natal", "maceio",
  "teresina", "aracaju", "vitoria", "florianopolis", "floripa", "cuiaba", "campinas", "santos", "guarulhos",
  "osasco", "sorocaba", "londrina", "joinville", "uberlandia", "niteroi", "jundiai", "maringa", "uberaba",
  "lisboa", "madrid", "miami", "londres", "london", "paris", "roma", "milao", "berlim", "toquio", "xangai", "pequim",
]);
const CIDADES_COMPOSTAS = new Set([
  "sao paulo", "rio de janeiro", "belo horizonte", "porto alegre", "ribeirao preto", "sao jose dos campos", "joao pessoa",
  "campo grande", "sao luis", "porto velho", "buenos aires", "nova york", "new york", "cidade do mexico", "santo andre",
  "sao bernardo do campo",
]);
const EM_DO_LUGAR = new Set(["em", "no", "na", "in", "en"]);
const COMPLEMENTO_DO_LUGAR = new Set(["regiao", "metropolitana", "grande", "capital", "interior"]);

function comprimentoDaCidade(palavras: string[], indice: number): number {
  if (!EM_DO_LUGAR.has(palavras[indice - 1] ?? "")) return 0;
  let n = 0;
  for (let k = Math.min(5, palavras.length - indice); k >= 2 && n === 0; k -= 1) {
    if (CIDADES_COMPOSTAS.has(palavras.slice(indice, indice + k).join(" "))) n = k;
  }
  if (n === 0 && (CIDADES.has(palavras[indice]) || COMPLEMENTO_DO_LUGAR.has(palavras[indice]))) n = 1;
  if (n === 0) return 0;
  // "Campinas/SP", "Campinas - SP", "Curitiba e região", "Grande SP"
  while (indice + n < palavras.length) {
    const seguinte = palavras[indice + n];
    const depois = palavras[indice + n + 1] ?? "";
    if (UFS.has(seguinte) || COMPLEMENTO_DO_LUGAR.has(seguinte)) n += 1;
    else if (seguinte === "e" && (UFS.has(depois) || depois === "regiao")) n += 2;
    else break;
  }
  return n;
}

/**
 * A palavra que NOMEIA o serviço, e a família dela. É a da cabeça — não a
 * primeira palavra de serviço em qualquer posição, que fazia "Marketing para
 * advogados" parecer serviço jurídico:
 *   - "Direito" com área: advocacia;
 *   - cabeça genérica ou neutra ("Serviços de tradução", "Escritório de
 *     advocacia", "Especialista em contabilidade"): a palavra de serviço do complemento;
 *   - composto em inglês ("Tax consulting", "Legal advisory", "Tax lawyer"):
 *     o substantivo de serviço colado DEPOIS, que é a cabeça de fato — mas
 *     empréstimos colados a um serviço em português ("Consultoria SEO",
 *     "Consultoria marketing digital") não trocam a família;
 *   - dois profissionais colados ("Advogado consultor", "Tradutora-intérprete")
 *     e adjetivo de profissão posposto em outro idioma ("Traduction juridique"):
 *     a cabeça;
 *   - senão, a própria cabeça, substantivo ou adjetivo ("Jurídico").
 */
const EMPRESTIMOS_POSPOSTOS = new Set(["compliance", "seo", "branding", "valuation", "diligence", "marketing", "design"]);

/**
 * Adjetivo de profissão que o francês, o alemão, o russo, o hindi e o árabe põem
 * DEPOIS do serviço ("Traduction juridique", "Audit comptable", "محاسب قانوني").
 * Nas listas é palavra de serviço comum; aqui qualifica e não troca a família
 * (revisão de 14/09).
 */
const ADJETIVOS_DE_PROFISSAO_POSPOSTOS = new Set([
  "juridique", "juridiques", "comptable", "comptables", "قانوني", "قانونية",
  ...Array.from(ADJETIVOS_ANTEPOSTOS),
]);

/**
 * Quem presta, não a prestação: "advogado", "tradutora", "intérprete",
 * "consultant". Dois colados são dois serviços sem conjunção ("Tradutora-intérprete
 * de Libras", "Advogado consultor"), e não o composto inglês, cuja primeira
 * palavra é a atividade ("Marketing consultant").
 */
const SUFIXO_DE_PROFISSIONAL = new RegExp("(?:or|ora|ores|oras|ado|ada|ados|adas|ista|istas|ete|etes|eiro|eira|eiros|eiras|eto|eta|etos|etas|er|ers|ant|ants)$");
const ehProfissional = (palavra: string) => ehSubstantivoDeServico(palavra) && SUFIXO_DE_PROFISSIONAL.test(palavra);

/**
 * Cabeças que o adjetivo de serviço qualifica como CONCEITO, e não como prestação:
 * "Pessoa jurídica", "Entidade jurídica", "Estrutura jurídica", "Personalidade
 * jurídica", "Documento contábil", "Données comptables". Não viram o serviço do
 * adjetivo na leitura (ver o fim de `nucleoDoServico`).
 */
const CONCEITOS_QUE_O_ADJETIVO_QUALIFICA = new Set([
  "pessoa", "pessoas", "entidade", "entidades", "estrutura", "estruturas", "personalidade", "personalidades",
  "documento", "documentos", "documentacao", "natureza", "figura", "figuras", "regime", "regimes",
  "person", "persons", "entity", "entities", "structure", "structures", "document", "documents", "documentation",
  "persona", "personas", "entidad", "estructura", "estructuras", "documentacion",
  "personne", "personnes", "entite", "entites", "donnees",
]);

function nucleoDoServico(palavras: string[]): { indice: number; familia: string } | null {
  const inicio = inicioDoServico(palavras);
  const cabeca = palavras[inicio];
  if (!cabeca) return null;
  if (areaDoDireito(palavras, inicio)) return { indice: inicio, familia: "advocacia" };
  // Cabeça ambígua ("Casa", "Boutique", "Studio"): só é a casa de quem presta com o serviço logo depois do genitivo, como
  // na classificação. Sem isso ela segue o caminho da cabeça que as listas não conhecem, como antes.
  const estruturaAmbigua = CABECAS_NEUTRAS_SO_COM_O_SERVICO_LOGO_DEPOIS.has(cabeca);
  if (estruturaAmbigua) {
    const servico = servicoLogoDepoisDaCabeca(palavras, inicio);
    if (servico !== null) return { indice: servico, familia: areaDoDireito(palavras, servico) ? "advocacia" : familiaDaPalavra(palavras[servico]) };
  }
  if (GENERICAS_DEMAIS.has(cabeca) || (CABECAS_NEUTRAS.has(cabeca) && !estruturaAmbigua)) {
    // O complemento como a classificação o lê: o serviço pode vir depois de palavra que não é serviço, atravessando o
    // genitivo ("Empresa de GESTÃO contábil", "Escritório de SOLUÇÕES jurídicas"). A leitura desistia na primeira, e o
    // item que a classificação dizia serviço não nomeava serviço nenhum — era barrado diante de qualquer necessidade,
    // até de "Contador" (revisão de 15/09 na #127, 116bb56, portada). Para em preposição que não é genitivo, em
    // conjunção e na palavra de outro tipo logo no começo ("Empresa de SOFTWARE jurídico"), como a classificação.
    let primeira = true;
    for (let i = inicio + 1; i < palavras.length; i += 1) {
      const palavra = palavras[i];
      if (GENITIVOS.has(palavra) || ARTIGOS.has(palavra) || GENERICAS_DEMAIS.has(palavra) || ESPECIALISTA.has(palavra) || atravessaEspecialista(palavras, i)) continue;
      if (FRONTEIRAS.has(palavra)) return null;
      if (ehSubstantivoDeServico(palavra) || ADJETIVOS_DE_SERVICO.has(palavra)) return { indice: i, familia: familiaDaPalavra(palavra) };
      if (areaDoDireito(palavras, i)) return { indice: i, familia: "advocacia" };
      if (primeira && tipoNaoServico(palavra)) return null;
      primeira = false;
    }
    return null;
  }
  let fim = palavras.findIndex((palavra, i) => i > inicio && (FRONTEIRAS.has(palavra) || CONJUNCOES.has(palavra)));
  if (fim < 0) fim = palavras.length;
  const cabecaEhServico = ehSubstantivoDeServico(cabeca);
  // Dois profissionais colados são dois serviços: a família é a da cabeça, e `partesDoServico` separa o segundo.
  if (ehProfissional(cabeca) && ehProfissional(palavras[inicio + 1] ?? "")) return { indice: inicio, familia: familiaDaPalavra(cabeca) };
  for (let i = fim - 1; i > inicio; i -= 1) {
    if (cabecaEhServico && (EMPRESTIMOS_POSPOSTOS.has(palavras[i]) || ADJETIVOS_DE_PROFISSAO_POSPOSTOS.has(palavras[i]))) continue;
    if (ehSubstantivoDeServico(palavras[i])) return { indice: i, familia: familiaDaPalavra(palavras[i]) };
  }
  if (cabecaEhServico) return { indice: inicio, familia: familiaDaPalavra(cabeca) };
  if (ADJETIVOS_DE_SERVICO.has(cabeca)) return { indice: inicio, familia: familiaDaPalavra(cabeca) };
  // Cabeça que as listas não conhecem, com o adjetivo de serviço depois: "Gestão CONTÁBIL", "Gestion COMPTABLE".
  // A classificação não diz serviço por isso, mas a categoria diz ("Gestão contábil" [Contabilidade]), e sem núcleo o
  // item era barrado diante de qualquer necessidade, até de "Contador" (revisão de 15/09 na #127, 116bb56, portada).
  // A cabeça fica como especialidade: a necessidade que a pede precisa tê-la ("Pessoa jurídica" procurada não é a
  // advocacia genérica). Cabeça de outro tipo ("SOFTWARE contábil", "DADOS contábeis") não nomeia serviço, nem o
  // conceito que o adjetivo qualifica ("PESSOA jurídica", "ESTRUTURA jurídica", "DOCUMENTO contábil"): lida como
  // especialidade, "Pessoa jurídica" [Serviços] oferecida casava com "Advogado" em 60 (medição do cético na #135, 15/09).
  if (!tipoNaoServico(cabeca) && !CONCEITOS_QUE_O_ADJETIVO_QUALIFICA.has(cabeca)) {
    for (let i = inicio + 1; i < fim; i += 1) {
      if (ADJETIVOS_DE_SERVICO.has(palavras[i])) return { indice: i, familia: familiaDaPalavra(palavras[i]) };
    }
  }
  return null;
}

/**
 * Uma alternativa de especialidade do serviço. Termo com conjunção tem uma por
 * item coordenado: "Advocacia tributária e trabalhista" oferece as duas.
 *   - lemas: o que qualifica o serviço, reconhecido ou não;
 *   - conhecidos: os lemas que as listas reconhecem (curados, idioma, outro serviço);
 *   - servicos: OUTRO serviço nomeado por substantivo ("marketing" em "Consultoria de marketing jurídico");
 *   - publico: público-alvo ou finalidade ("para MEI", "para divórcio");
 *   - publicoEspecifico: o público sem o destinatário genérico ("para a nossa
 *     EMPRESA", "holding FAMILIAR"), que é o que o portão da IA lê;
 *   - assunto: lemas desconhecidos que vieram como assunto ("consultoria EM e-commerce").
 */
export type EspecialidadeDoServico = {
  lemas: ReadonlySet<string>;
  conhecidos: ReadonlySet<string>;
  servicos: ReadonlySet<string>;
  publico: ReadonlySet<string>;
  publicoEspecifico: ReadonlySet<string>;
  assunto: ReadonlySet<string>;
};
export type ServicoNomeado = { familia: string; especialidades: readonly EspecialidadeDoServico[] };

type Alternativa = {
  lemas: Set<string>; conhecidos: Set<string>; servicos: Set<string>; publico: Set<string>; publicoEspecifico: Set<string>;
  assunto: Set<string>; atividade: Set<string>; corporativo: boolean;
};
const novaAlternativa = (): Alternativa => ({
  lemas: new Set(), conhecidos: new Set(), servicos: new Set(), publico: new Set(), publicoEspecifico: new Set(),
  assunto: new Set(), atividade: new Set(), corporativo: false,
});

/** Destinatário genérico: no público, não diz qual especialidade se pede ("advogado para a nossa EMPRESA"). */
const DESTINATARIOS_GENERICOS = new Set(["empresa", "empresas", "familiar", "familiares", "family", "trabalho", "contrato", "contratos", "contract", "contracts"]);

const pulaNoServico = (palavra: string) =>
  MARCADORES_FRACOS.has(palavra) || ARTIGOS.has(palavra) || GENERICAS_DEMAIS.has(palavra) || PALAVRAS_SEM_ESPECIALIDADE.has(palavra) || QUALIFICA_O_ASSUNTO.has(palavra) || ESPECIALISTA.has(palavra);

function especialidadesDoServico(palavras: string[], nucleo: { indice: number; familia: string }): EspecialidadeDoServico[] {
  const alternativas = [novaAlternativa()];
  let noPublico = false;
  let noAssunto = false;
  for (let i = inicioDoServico(palavras); i < palavras.length; i += 1) {
    const palavra = palavras[i];
    const atual = alternativas[alternativas.length - 1];
    if (i === nucleo.indice) continue;
    if (CONJUNCOES.has(palavra)) {
      // Conjunção dentro do público continua o público: "para startups E empresas de tecnologia".
      if (!noPublico) alternativas.push(novaAlternativa());
      continue;
    }
    if (PREPOSICOES.has(palavra)) {
      const anterior = palavras[i - 1] ?? "";
      const seguinte = palavras[i + 1] ?? "";
      if (QUALIFICA_O_ASSUNTO.has(anterior)) { // "com foco EM", "voltada PARA", "dedicada AO"
        noPublico = false;
        noAssunto = true;
      } else if ((palavra === "com" || palavra === "with") && QUALIFICA_O_ASSUNTO.has(seguinte)) continue;
      else if (!PREPOSICOES_DE_ASSUNTO.has(palavra)) noPublico = true;
      else if (i > nucleo.indice && !noPublico) noAssunto = true;
      continue;
    }
    const cidade = comprimentoDaCidade(palavras, i);
    if (cidade > 0) {
      i += cidade - 1;
      continue;
    }
    const idioma = IDIOMA_DA_PALAVRA.get(palavra);
    if (!idioma) {
      const lugar = comprimentoDoLugar(palavras, i);
      if (lugar > 0) {
        i += lugar - 1;
        continue;
      }
    }
    // Cabeça neutra antes do serviço ("ESCRITÓRIO de advocacia") ou colada depois dele, sem preposição no meio ("Tax law
    // FIRM", "Consulting GROUP"): é quem presta, não o que se presta. Sem isto "firm" era especialidade desconhecida e
    // "Tax law firm" × "Tax lawyer" dava 0 (ff9564f da #127, portada na revisão de 15/09).
    const neutraColada = i > nucleo.indice && !noPublico && !noAssunto && CABECAS_NEUTRAS.has(palavra);
    if (pulaNoServico(palavra) || (i < nucleo.indice && CABECAS_NEUTRAS.has(palavra)) || neutraColada) continue;
    let lema: string;
    let conhecido: boolean;
    if (CABECAS_DO_DIREITO.has(palavra)) {
      // "Consultoria em DIREITO digital" é serviço jurídico; na advocacia, "direito" não acrescenta nada.
      lema = "advocacia";
      conhecido = true;
    } else if (idioma) {
      lema = idioma;
      conhecido = true;
    } else if (CORPORATIVO.has(palavra)) {
      // "corporativo" é societário na advocacia, e só sem outra área ("Advocacia tributária corporativa" é tributária);
      // fora dela é empresarial ("Corporate training" = "Treinamento empresarial", revisão de 14/09).
      conhecido = true;
      lema = nucleo.familia === "advocacia" ? "societario" : "empresarial";
      if (lema === "societario" && !noPublico) atual.corporativo = true;
    } else if (FAMILIA_SO_NA_ADVOCACIA.has(palavra) && nucleo.familia === "advocacia") {
      lema = "familia";
      conhecido = true;
      if (COMPLEMENTO_DA_PENSAO.has(palavras[i + 1] ?? "")) i += 1; // "pensão ALIMENTÍCIA"
    } else if (FAMILIAR.has(palavra) && (EMPRESAS_FAMILIARES.has(palavras[i - 1] ?? "") || EMPRESAS_FAMILIARES.has(palavras[i + 1] ?? ""))) {
      lema = semGeneroNemNumero(palavra);
      conhecido = false;
    } else {
      conhecido = lemaCurado(palavra) !== undefined || SUBSTANTIVOS_DE_SERVICO.has(palavra) || ADJETIVOS_DE_SERVICO.has(palavra);
      lema = lemaDaEspecialidade(palavra);
    }
    if (lema === nucleo.familia) continue;
    if (noPublico) {
      atual.publico.add(lema);
      if (!DESTINATARIOS_GENERICOS.has(palavra)) atual.publicoEspecifico.add(lema);
      continue;
    }
    const comoAssunto = noAssunto || i < nucleo.indice;
    if (!conhecido && (PALAVRAS_DE_ATIVIDADE.has(palavra) || ADJETIVOS_DE_ESTILO.has(palavra))) {
      atual.atividade.add(lema);
      if (comoAssunto) atual.assunto.add(lema);
      continue;
    }
    atual.lemas.add(lema);
    if (conhecido) atual.conhecidos.add(lema);
    else if (comoAssunto) atual.assunto.add(lema);
    // Outro serviço na oferta: o substantivo ("Consultoria de MARKETING jurídico") e o adjetivo de outra família
    // ("Consultoria PUBLICITÁRIA imobiliária"). Não contam "jurídico" e "contábil", que nomeiam a profissão
    // ("Consultoria jurídica tributária"), nem o adjetivo de profissão posposto ("Traduction JURIDIQUE").
    const substantivo = ehSubstantivoDeServico(palavra) && !(i > nucleo.indice && ADJETIVOS_DE_PROFISSAO_POSPOSTOS.has(palavra));
    const adjetivoDeOutraFamilia = ADJETIVOS_DE_SERVICO.has(palavra) && !PROFISSOES_PELO_ADJETIVO.has(lema);
    if (substantivo || adjetivoDeOutraFamilia) atual.servicos.add(lema);
  }
  const prontas: EspecialidadeDoServico[] = [];
  for (const alternativa of alternativas) {
    // Atividade sem especialidade reconhecida é assunto como outro qualquer.
    if (alternativa.conhecidos.size === 0) for (const lema of Array.from(alternativa.atividade)) alternativa.lemas.add(lema);
    if (alternativa.corporativo && Array.from(alternativa.conhecidos).some(lema => AREAS_CONTENCIOSAS.has(lema))) {
      alternativa.lemas.delete("societario");
      alternativa.conhecidos.delete("societario");
    }
    if (alternativa.lemas.size > 0 || alternativa.publico.size > 0) {
      prontas.push({
        lemas: alternativa.lemas, conhecidos: alternativa.conhecidos, servicos: alternativa.servicos,
        publico: alternativa.publico, publicoEspecifico: alternativa.publicoEspecifico, assunto: alternativa.assunto,
      });
    }
  }
  return prontas;
}

/** O recálculo do motor privado cruza milhares de pares com os mesmos rótulos: as leituras são puras e ficam guardadas. */
const MAXIMO_NO_CACHE = 5000;
const cacheDoServico = new Map<string, ServicoNomeado | null>();
const cacheDasPartes = new Map<string, string[]>();
function guardar<T>(cache: Map<string, T>, chave: string, valor: T): T {
  if (cache.size >= MAXIMO_NO_CACHE) cache.clear();
  cache.set(chave, valor);
  return valor;
}

/** O serviço que o texto nomeia, sem olhar a classificação (vale para a necessidade). */
function entenderServico(rotulo: string): ServicoNomeado | null {
  const guardado = cacheDoServico.get(rotulo);
  if (guardado !== undefined) return guardado;
  const palavras = palavrasDe(rotulo);
  const nucleo = nucleoDoServico(palavras);
  if (nucleo) return guardar(cacheDoServico, rotulo, { familia: nucleo.familia, especialidades: especialidadesDoServico(palavras, nucleo) });
  // Chinês e japonês: o serviço que termina o termo, e a especialidade no que vem antes dele (e6ddfa4 da #127).
  const semEspaco = servicoNoFimSemEspaco(rotulo);
  return guardar(cacheDoServico, rotulo, semEspaco ? { familia: semEspaco.familia, especialidades: especialidadesSemEspaco(semEspaco.antes, semEspaco.familia, semEspaco.profissional) } : null);
}

/**
 * O serviço que o item OFERECIDO nomeia: família e especialidades. null quando
 * o item não é serviço pela classificação ou só diz "serviços".
 */
export function servicoDoTermo(rotulo: string): ServicoNomeado | null {
  return classificarOferta(rotulo) === "servico" ? entenderServico(rotulo) : null;
}

/**
 * A FAMÍLIA do serviço oferecido (o lema, ver FAMILIAS): "advocacia" em
 * "Advocacia tributária", "Advogada tributarista" e "Serviços jurídicos";
 * "consultoria" em "Consultoria jurídica" e "Tax consulting". null quando o
 * item não é serviço ou só diz "serviços". Em chinês e japonês a família vem
 * do vocabulário pelo fim do termo.
 */
export function familiaDoServico(rotulo: string, categoria?: string | null): string | null {
  if (!ehServico(rotulo, categoria)) return null;
  return entenderServico(rotulo)?.familia ?? familiaSemEspaco(rotulo);
}

/**
 * A especialidade declarada num termo de serviço, em lemas: o que qualifica a
 * prestação, sem as palavras que nomeiam a própria prestação. "Advocacia
 * tributária" e "Advogado tributarista" dão os dois ["tributario"];
 * "Consultoria jurídica" dá [] (só nomeia a prestação); "Sell-side advisory"
 * dá ["sell", "side"].
 */
export function especialidadeDoServico(rotulo: string, categoria?: string | null): string[] {
  if (!ehServico(rotulo, categoria)) return [];
  const lemas = new Set<string>();
  for (const especialidade of entenderServico(rotulo)?.especialidades ?? []) {
    for (const lema of Array.from(especialidade.lemas)) if (!FAMILIAS_CONHECIDAS.has(lema)) lemas.add(lema);
  }
  return Array.from(lemas);
}

/**
 * As partes de um rótulo que coordena SERVIÇOS diferentes: "Advogado e
 * contador", "Tradução e interpretação". A conjunção (ou vírgula) só abre outro
 * serviço quando o item seguinte começa por substantivo de serviço e ela não
 * está dentro do público ("Marketing para advogados e contadores") nem do
 * assunto de um serviço ("Consultoria em gestão e marketing", "Curso de
 * marketing e design"). A especialidade e o público do último serviço valem
 * para os anteriores que não têm os seus: "Advogados e consultores
 * tributários", "Mentoria e consultoria para mulheres empreendedoras".
 */
function partesDoServico(rotulo: string): string[] {
  const guardadas = cacheDasPartes.get(rotulo);
  if (guardadas) return guardadas;
  const palavras = palavrasDe(rotulo);
  const abreServico = (k: number) => {
    let j = k;
    while (j < palavras.length && (ARTIGOS.has(palavras[j]) || MARCADORES_FRACOS.has(palavras[j]) || PALAVRAS_SEM_ESPECIALIDADE.has(palavras[j]))) j += 1;
    const primeira = palavras[j];
    if (!primeira || PREPOSICOES.has(primeira)) return false;
    if (ehSubstantivoDeServico(primeira) || areaDoDireito(palavras, j)) return true;
    return CABECAS_NEUTRAS.has(primeira) && GENITIVOS.has(palavras[j + 1] ?? "") && ehSubstantivoDeServico(palavras[j + 2] ?? "");
  };
  // "Consultoria jurídica para startups E CONSULTORIA em marketing": outro serviço da mesma família sai do público.
  const mesmaFamiliaAdiante = (atual: string[], k: number) => {
    const nucleo = nucleoDoServico(atual);
    let j = k;
    while (j < palavras.length && (ARTIGOS.has(palavras[j]) || MARCADORES_FRACOS.has(palavras[j]))) j += 1;
    return nucleo !== null && familiaDaPalavra(palavras[j] ?? "") === nucleo.familia;
  };
  const partes: string[][] = [[]];
  let noPublico = false;
  let noAssunto = false;
  for (let i = 0; i < palavras.length; i += 1) {
    const palavra = palavras[i];
    const atual = partes[partes.length - 1];
    if (CONJUNCOES.has(palavra) && !noAssunto && abreServico(i + 1) && (!noPublico || mesmaFamiliaAdiante(atual, i + 1))) {
      partes.push([]);
      noPublico = false;
      continue;
    }
    // Dois profissionais colados, sem conjunção: "Tradutora-intérprete de Libras", "Advogado consultor tributário".
    if (!noPublico && !noAssunto && atual.length > 0 && ehProfissional(palavra) && ehProfissional(atual[atual.length - 1])) {
      partes.push([palavra]);
      continue;
    }
    if (PREPOSICOES.has(palavra)) {
      if (!PREPOSICOES_DE_ASSUNTO.has(palavra)) noPublico = true;
      else if (atual.some(ehSubstantivoDeServico)) noAssunto = true;
    }
    atual.push(palavra);
  }
  const cheias = partes.filter(parte => parte.length > 0);
  if (cheias.length > 1) {
    const ultima = cheias[cheias.length - 1];
    const nucleoDaUltima = nucleoDoServico(ultima);
    if (nucleoDaUltima) {
      const cauda = ultima.slice(nucleoDaUltima.indice + 1);
      const ehPublico = (p: string) => PREPOSICOES.has(p) && !PREPOSICOES_DE_ASSUNTO.has(p);
      const inicioDoPublico = cauda.findIndex(ehPublico);
      for (const parte of cheias.slice(0, -1)) {
        const nucleo = nucleoDoServico(parte);
        if (!nucleo) continue;
        const depois = parte.slice(nucleo.indice + 1);
        if (depois.length === 0) parte.push(...cauda);
        else if (inicioDoPublico >= 0 && !depois.some(ehPublico)) parte.push(...cauda.slice(inicioDoPublico));
      }
    }
  }
  return guardar(cacheDasPartes, rotulo, cheias.map(parte => parte.join(" ")));
}

/** Os serviços que um rótulo nomeia: cada parte coordenada e, com mais de uma, o rótulo inteiro. */
function servicosDoRotulo(rotulo: string): ServicoNomeado[] {
  const partes = partesDoServico(rotulo);
  const textos = partes.length > 1 ? [...partes, rotulo] : partes;
  return textos.map(entenderServico).filter((servico): servico is ServicoNomeado => servico !== null);
}

const LEMAS_DE_ATIVIDADE = new Set(Array.from(PALAVRAS_DE_ATIVIDADE).map(semGeneroNemNumero));
const desconhecidosDe = (especialidade: EspecialidadeDoServico) => Array.from(especialidade.lemas).filter(lema => !especialidade.conhecidos.has(lema));
const ehGenerico = (servico: ServicoNomeado) => servico.especialidades.length === 0;

/**
 * A especialidade oferecida cobre a pedida? Todo lema pedido está na oferta; o
 * que a oferta tem a mais não é outro serviço nomeado e é reconhecido pelas
 * listas. "Advocacia tributária empresarial" cobre "Advogado tributarista";
 * "Consultoria em segurança do trabalho" não cobre "Consultoria trabalhista".
 */
function cobre(oferecida: EspecialidadeDoServico, pedida: EspecialidadeDoServico): boolean {
  if (!Array.from(pedida.lemas).every(lema => oferecida.lemas.has(lema))) return false;
  if (!Array.from(oferecida.servicos).every(lema => pedida.lemas.has(lema))) return false;
  return desconhecidosDe(oferecida).every(lema => pedida.lemas.has(lema));
}

/**
 * Pedido só com público ou finalidade ("Contador para MEI", "Advogado para
 * divórcio"): não é a genérica da família. Todo lema dele, tirando as palavras
 * de atividade ("para REVISÃO tributária", "para DEFESA criminal"), precisa
 * estar na oferta — na especialidade ou no público —, também ao lado de uma
 * especialidade curada: "para SEGURANÇA do trabalho" não é trabalhista, "para
 * AVIAÇÃO civil" não é engenharia civil (revisão de 14/09). Serviço nomeado no
 * público ("para ADVOGADOS") só casa com o público da oferta: "Consultoria
 * jurídica" não é consultoria para advogados.
 */
const LEMAS_CURADOS = new Set(Object.keys(LEMAS_DE_ESPECIALIDADE));
const lemaCuradoOuIdioma = (lema: string) => LEMAS_CURADOS.has(lema) || lema.startsWith("idioma:");

function cobrePublico(oferecida: EspecialidadeDoServico, pedida: EspecialidadeDoServico): boolean {
  const exigidos = Array.from(pedida.publico).filter(lema => !LEMAS_DE_ATIVIDADE.has(lema));
  return exigidos.length > 0
    && exigidos.every(lema => oferecida.publico.has(lema) || (!FAMILIAS_CONHECIDAS.has(lema) && oferecida.lemas.has(lema)));
}

/**
 * A oferta é a família crua ("Contabilidade", "Logística") e a necessidade
 * pede a MESMA família só com público ou finalidade ("Contador para pequenas
 * empresas", "logística para exportar meu café"): quem oferece a família
 * inteira atende o caso particular dela.
 *
 * Sem isto o par dava ZERO — não a nota da família, zero com bloqueio —, porque
 * `cobrePublico` percorre as especialidades da oferta e a oferta genérica não
 * tem nenhuma: `.some()` sobre lista vazia é falso. O mesmo fato com os lados
 * trocados ("Contabilidade para pequenas empresas" × "Contador") valia 100, o
 * que deixava a regra assimétrica, e "Logística" × "preciso de logística para
 * exportar meu café" tinha caído de 60 para 0 (item 4 da revisão do Nicolas na
 * #135, 15/09).
 *
 * A nota sai em `comoAtende`: 100 quando o público é só destinatário comum
 * (`DESTINATARIOS_COMUNS`), 60 quando é finalidade ou outro público — decisão
 * do Roberto de 16/09, ver `soAcrescentaDestinatarioComum`.
 */
function ofertaGenericaCobreOPublico(oferecido: ServicoNomeado, pedida: EspecialidadeDoServico): boolean {
  return oferecido.especialidades.length === 0
    && pedida.lemas.size === 0
    && Array.from(pedida.publico).some(lema => !LEMAS_DE_ATIVIDADE.has(lema));
}

/**
 * O destinatário escrito SEM "para" — "Contador DE MEI", "Contador MEI", "Contador de PEQUENAS EMPRESAS" — é só o
 * INEQUÍVOCO: sem o "para", o "de" e a justaposição também apresentam o ASSUNTO e a MODALIDADE, e a lista inteira de
 * `DESTINATARIOS_COMUNS` levava a 100, com e-mail, "Consultoria de NEGÓCIOS" (a consultoria empresarial),
 * "Advogado de CLIENTES", "Tradutor PARTICULAR" e "Mentoria INDIVIDUAL" (revisão cética de 16/09 da
 * `fix/delta-do-nicolas`). Negócio, business, company, cliente, particular, individual e profissional valem só no
 * público, depois de "para".
 *
 * Sozinhos: MEI, ME, EPP, PME, microempresa, microempreendedor, startup, pyme, SME e "small" (o "business" de "Small
 * business accountant" sai da leitura como cabeça neutra). Em par: o PORTE com a empresa ou o negócio ("pequenas
 * empresas", "médias empresas", "pequenos negócios") e "pessoa física". "Empresas" sem porte é a especialidade
 * curada "empresarial" ("Advogado de empresas" é o direito empresarial), e "grandes empresas" também não entra: o
 * adjetivo desconhecido contornava a guarda que havia aqui ("Advogado de grandes empresas" valia 100).
 */
const DESTINATARIOS_SEM_PARA = new Set([
  "mei", "meis", "me", "epp", "epps", "pme", "pmes", "microempresa", "microempresas",
  "microempreendedor", "microempreendedores", "microempreendedora", "microempreendedoras",
  "startup", "startups", "pyme", "pymes", "sme", "smes", "small",
].map(palavra => lemaDaEspecialidade(palavra)));
const PORTES_DO_DESTINATARIO = new Set(["pequena", "pequeno", "media", "medio", "micro", "mediana", "mediano"].map(palavra => lemaDaEspecialidade(palavra)));
const QUEM_TEM_PORTE = new Set(["empresa", "negocio"].map(palavra => lemaDaEspecialidade(palavra)));
const PESSOA_FISICA = ["pessoa", "fisica"].map(palavra => lemaDaEspecialidade(palavra));

function destinatarioNosLemas(lemas: readonly string[]): boolean {
  const tem = (lista: ReadonlySet<string>) => lemas.some(lema => lista.has(lema));
  return lemas.length > 0 && lemas.every(lema => DESTINATARIOS_SEM_PARA.has(lema)
    || (PORTES_DO_DESTINATARIO.has(lema) && tem(QUEM_TEM_PORTE))
    || (QUEM_TEM_PORTE.has(lema) && tem(PORTES_DO_DESTINATARIO))
    || (PESSOA_FISICA.includes(lema) && PESSOA_FISICA.every(parte => lemas.includes(parte))));
}

/**
 * A oferta com público ("Contabilidade para MEI") cobre o mesmo destinatário escrito sem "para" na necessidade
 * ("Contador de MEI", "Contador MEI"), como já cobria "Contador para MEI" (`cobrePublico`). Sem isto o par dava 0 e
 * a documentação dizia "com qualquer preposição, dos dois lados" (revisão cética de 16/09).
 */
function cobreDestinatarioNosLemas(oferecida: EspecialidadeDoServico, pedida: EspecialidadeDoServico): boolean {
  const lemas = Array.from(pedida.lemas);
  return pedida.servicos.size === 0 && pedida.publico.size === 0 && destinatarioNosLemas(lemas)
    && lemas.every(lema => oferecida.publico.has(lema) || oferecida.lemas.has(lema));
}

/**
 * O complemento nomeia uma CONTRAPARTE — quem tem a mercadoria, o canal ou o capital, e que serviço nenhum entrega.
 * A lista é a do portão (`PAPEIS_DE_COMERCIO` e `SOCIOS`, em lema), mais o que a decisão do Roberto de 16/09 (D1)
 * nomeia e ela não tem: o representante, o agente e o parceiro COMERCIAIS (só em par com "comercial": "representante
 * legal" e "parceiro de tecnologia" são outra coisa), o atacadista, o varejista, o franqueado, o patrocinador e o
 * CLIENTE, que é quem compra ("Preciso de consultoria de clientes" valia 100 pelo destinatário; o cliente só é
 * destinatário depois de "para"). Ficam só aqui, nos motores determinísticos: pôr essas palavras em
 * `PAPEIS_DE_COMERCIO` mudaria também o portão da IA, onde elas são ambíguas.
 */
const CONTRAPARTE_EM_PAR_COM_COMERCIAL = new Set(["representante", "agente", "parceiro", "parceira"].map(palavra => lemaDaEspecialidade(palavra)));
const COMERCIAL_EM_LEMA = lemaDaEspecialidade("comercial");
const CONTRAPARTE_QUE_O_PORTAO_NAO_LISTA = new Set([
  "atacadista", "atacadistas", "varejista", "varejistas", "franqueado", "franqueada", "franqueados", "franqueadas",
  "patrocinador", "patrocinadora", "patrocinadores", "patrocinadoras",
  "cliente", "clientes", "client", "clients", "customer", "customers",
].map(palavra => lemaDaEspecialidade(palavra)));
function nomeiaContraparte(lemas: ReadonlySet<string>): boolean {
  return Array.from(lemas).some(lema => CONTRAPARTE_EM_LEMA.has(lema) || CONTRAPARTE_QUE_O_PORTAO_NAO_LISTA.has(lema)
    || (CONTRAPARTE_EM_PAR_COM_COMERCIAL.has(lema) && lemas.has(COMERCIAL_EM_LEMA)));
}

/**
 * A abertura do D1 (decisão do Roberto de 16/09) vale para a necessidade INTEIRA: o texto pede o serviço
 * (`pedidoPedeOServico`) e NENHUMA alternativa de nenhum serviço pedido nomeia especialidade curada, outro serviço
 * ou contraparte. `comoAtende` julga cada alternativa sozinha, e sem isto "Preciso de advogado marítimo E
 * TRIBUTARISTA", "... marítimo E INVESTIDOR" e "Preciso de consultoria de moda E DISTRIBUIDORES" valiam 60 pela
 * alternativa desconhecida (revisão cética de 16/09).
 */
function abreComplementoDesconhecido(palavras: string[], pedidos: readonly ServicoNomeado[]): boolean {
  return pedidoPedeOServico(palavras) && pedidos.every(pedido => pedido.especialidades.every(pedida =>
    pedida.servicos.size === 0
    && Array.from(pedida.lemas).every(lema => !pedida.conhecidos.has(lema))
    && !nomeiaContraparte(pedida.lemas)));
}

function atendeEspecialidades(oferecido: ServicoNomeado, pedido: ServicoNomeado, complementoDesconhecido = false): boolean {
  if (ehGenerico(pedido)) return true;
  // Oferta GENÉRICA ("Contabilidade", "Advocacia", "Logística") diante de pedido da mesma família que acrescenta
  // alguma coisa. A nota (100 ou 60) sai em `comoAtende`; aqui só se decide se atende. Pedido com ESPECIALIDADE
  // curada continua sem casar, e é regra da casa congelada em teste: "Advocacia" não atende "Advogado
  // tributarista" (defeito c da #101).
  if (ehGenerico(oferecido)) {
    // 1. O público ou a finalidade depois de "para" ("Contador para MEI", "logística para exportar meu café"), e o
    //    destinatário inequívoco escrito sem "para" ("Contador de MEI", "Contador MEI": `destinatarioNosLemas`).
    if (pedido.especialidades.some(pedida => ofertaGenericaCobreOPublico(oferecido, pedida)
      || (pedida.servicos.size === 0 && destinatarioNosLemas(Array.from(pedida.lemas))))) return true;
    // 2. O texto PEDE a família, com complemento que as listas não conhecem ("Preciso de advogado marítimo",
    //    "Procuro contador rural", "Preciso de logística de exportação para meu café"): quem oferece a família
    //    atende quem declarou precisar dela, com a nota da família — decisão do Roberto de 16/09 (D1). Quem decide
    //    é `comoAtende`, sobre o texto inteiro (`abreComplementoDesconhecido`): a marca de pedido vem ANTES do
    //    serviço e o pedido cai nele ("Quero vender minha consultoria", "We are maritime lawyers" e "Consultoria de
    //    moda que se destaca" não pedem nada), e nenhuma alternativa nomeia especialidade curada, outro serviço ou
    //    contraparte ("Preciso de consultoria de distribuidor", "Procuro advogado de investidor"). As duas linhas
    //    abaixo repetem a trava da alternativa para quem chama sem o texto.
    return complementoDesconhecido && pedido.especialidades.length > 0 && pedido.especialidades.every(pedida =>
      pedida.servicos.size === 0
      && pedida.lemas.size > 0
      && Array.from(pedida.lemas).every(lema => !pedida.conhecidos.has(lema)) && !nomeiaContraparte(pedida.lemas));
  }
  return pedido.especialidades.some(pedida => (pedida.lemas.size > 0
    ? oferecido.especialidades.some(oferecida => cobre(oferecida, pedida) || cobreDestinatarioNosLemas(oferecida, pedida))
    : oferecido.especialidades.some(oferecida => cobrePublico(oferecida, pedida))));
}

const semOLema = (especialidade: EspecialidadeDoServico, lema: string): EspecialidadeDoServico => ({
  ...especialidade,
  lemas: new Set(Array.from(especialidade.lemas).filter(outro => outro !== lema)),
  conhecidos: new Set(Array.from(especialidade.conhecidos).filter(outro => outro !== lema)),
});

/** Assuntos de assessoria/coaching que não são aconselhamento profissional (já como lema). */
const ASSESSORIAS_QUE_NAO_ACONSELHAM = new Set(
  ["imprensa", "comunicacao", "evento", "eventos", "casamento", "casamentos", "cerimonial", "cerimoniais", "festa", "festas",
    "esportiva", "esportivo", "esportivas", "esportivos", "press", "midia", "midias", "cobranca", "viagem", "viagens",
    "redes", "corrida", "corridas", "fitness", "musculacao", "maratona"].map(lemaDaEspecialidade),
);
/** Lemas que provam aconselhamento: "Assessoria jurídica em cobrança" continua assessoria. */
const LEMAS_DE_ACONSELHAMENTO = new Set([...Array.from(FAMILIAS_DE_ASSESSORIA), ...Array.from(AREAS_CONTENCIOSAS), "societario", "empresarial"]);

function naoAconselha(especialidade: EspecialidadeDoServico, lista: ReadonlySet<string>): boolean {
  return Array.from(especialidade.lemas).some(lema => lista.has(lema))
    && !Array.from(especialidade.conhecidos).some(lema => LEMAS_DE_ACONSELHAMENTO.has(lema));
}

/** "busca", "procura" e "need" também são substantivos: "Advogado DE BUSCA e apreensão", "para PROCURA de bens". */
const MARCAS_QUE_TAMBEM_SAO_SUBSTANTIVO = new Set(["busca", "procura", "need", "needs"]);
/** Antes destas a marca continua pedido: "EM busca de", "À procura de", "IN need of". */
const LOCUCOES_DE_PEDIDO = new Set(["em", "a", "in"]);

/** A palavra em `k` é marca de pedido usada como pedido, e não o substantivo depois de preposição ou artigo. */
function marcaDePedidoEm(palavras: readonly string[], k: number): boolean {
  const palavra = palavras[k];
  if (!MARCAS_DE_PEDIDO.has(palavra)) return false;
  const anterior = palavras[k - 1];
  if (!MARCAS_QUE_TAMBEM_SAO_SUBSTANTIVO.has(palavra) || anterior === undefined || LOCUCOES_DE_PEDIDO.has(anterior)) return true;
  return !PREPOSICOES.has(anterior) && !ARTIGOS.has(anterior);
}

/** As marcas de pedido do inglês, que põe o qualificador ANTES do serviço: "We need a MARITIME lawyer". */
const MARCAS_DE_PEDIDO_EM_INGLES = new Set(["need", "needs", "want", "wants", "looking", "seeking", "seeks", "seek", "require", "requires", "hiring"]);
/** Entre o pedido e o serviço, abrem outra coisa que não é o serviço: "Procuro QUEM compre consultoria", "We need SOMEONE to...". */
const QUEM_NAO_E_O_SERVICO = new Set(["quem", "alguem", "quien", "alguien", "someone", "somebody", "anyone", "anybody", "people", "pessoas"]);

/** Palavra que cabe entre o começo do pedido e o núcleo do serviço, em qualquer língua: "um BOM escritório DE advocacia". */
const cabeAntesDoServico = (palavra: string) =>
  ARTIGOS.has(palavra) || GENITIVOS.has(palavra) || PALAVRAS_SEM_ESPECIALIDADE.has(palavra) || MARCADORES_FRACOS.has(palavra)
  || CABECAS_NEUTRAS.has(palavra) || GENERICAS_DEMAIS.has(palavra) || ESPECIALISTA.has(palavra) || qualificaAntes(palavra);

/**
 * O texto PEDE o serviço que nomeia? A abertura do D1 (decisão do Roberto de 16/09) exige isso, e a leitura
 * anterior — qualquer palavra de `VERBOS_DE_NECESSIDADE` em qualquer lugar — aceitava a autodescrição e a oferta:
 * "WE ARE maritime lawyers", "ESTAMOS oferecendo consultoria de moda", "QUERO vender minha consultoria", "Contador
 * rural SE oferece", "Consultoria de moda que SE destaca" (revisão cética de 16/09). Agora:
 *   - há marca de pedido (`MARCAS_DE_PEDIDO`, pt/en/es) usada como pedido, ANTES do núcleo do serviço — "Consultoria
 *     de moda se PRECISAR" e "Contador PROCURA clientes" não pedem o serviço;
 *   - o pedido (`cabecaDoPedido`) cai no serviço: entre ele e o núcleo só cabe o que qualifica o serviço
 *     ("Preciso de um bom ESCRITÓRIO de advocacia"), e não "Procuro QUEM COMPRE consultoria" nem "Quero VENDER";
 *   - em inglês o qualificador desconhecido vem antes do serviço e também cabe ("We need a MARITIME lawyer"), salvo
 *     depois de "to" ("We need TO SELL consulting") e o que abre outra coisa (preposição, conjunção, pronome,
 *     contraparte).
 * Nos idiomas novos não há marca aqui, e a abertura não vale: a trava da contraparte é só pt/en/es.
 */
function pedidoPedeOServico(palavras: string[]): boolean {
  const nucleo = nucleoDoServico(palavras);
  if (!nucleo) return false;
  const marca = palavras.findIndex((_, k) => marcaDePedidoEm(palavras, k));
  if (marca < 0 || marca >= nucleo.indice) return false;
  const { indice: cabeca } = cabecaDoPedido(palavras);
  if (cabeca > nucleo.indice) return false;
  const emIngles = MARCAS_DE_PEDIDO_EM_INGLES.has(palavras[marca]) && !palavras.slice(marca + 1, cabeca).includes("to");
  return palavras.slice(cabeca, nucleo.indice).every(palavra => cabeAntesDoServico(palavra)
    || (emIngles && !PREPOSICOES.has(palavra) && !CONJUNCOES.has(palavra) && !ABRE_ORACAO.has(palavra)
      && !QUEM_NAO_E_O_SERVICO.has(palavra) && !PAPEIS_DE_COMERCIO.has(palavra) && !MARCAS_DE_PEDIDO.has(palavra)));
}

/** O texto pede o serviço que nomeia (`pedidoPedeOServico`)? Para a guarda de concorrência do portão. */
export function textoPedeOServico(texto: string): boolean {
  return pedidoPedeOServico(palavrasDe(texto));
}

/**
 * O serviço é QUEM PEDE, e não o que se pede: a marca de pedido vem DEPOIS do núcleo e pede outra coisa —
 * "Contador PROCURA clientes", "Consultoria BUSCA startups", "Escritório de advocacia BUSCA clientes", "Lawyer
 * SEEKING business clients", "Somos uma consultoria de moda e BUSCAMOS clientes". É a prestadora falando de si, e
 * a necessidade é o cliente, não o serviço. A leitura do serviço tira a marca de qualquer posição (é marcador
 * fraco), e sem isto "Contador procura MEI" era lido como "Contador MEI" e valia 100, com e-mail, diante da
 * concorrente (revisão cética de 16/09).
 *
 * Fica como era quando não se sabe o que se pede: sem objeto ("Advogado procura-se"), com o serviço anteposto ao
 * pedido ("Consultoria tributária: procuro PARA minha empresa") e pedindo outro serviço ("Contador procura
 * ADVOGADO").
 */
function servicoEhQuemPede(palavras: string[]): boolean {
  const nucleo = nucleoDoServico(palavras);
  if (!nucleo) return false;
  const marca = palavras.findIndex((_, k) => k > nucleo.indice && marcaDePedidoEm(palavras, k));
  if (marca < 0) return false;
  let objeto = marca + 1;
  while (objeto < palavras.length && (SAI_DA_FRENTE_DO_PEDIDO.has(palavras[objeto]) || ARTIGOS.has(palavras[objeto])
    || GENITIVOS.has(palavras[objeto]) || PALAVRAS_SEM_ESPECIALIDADE.has(palavras[objeto]) || MARCADORES_FRACOS.has(palavras[objeto]))) objeto += 1;
  const pedido = palavras[objeto];
  if (pedido === undefined || PREPOSICOES.has(pedido) || CONJUNCOES.has(pedido)) return false;
  return !ehSubstantivoDeServico(pedido) && !ADJETIVOS_DE_SERVICO.has(pedido) && areaDoDireito(palavras, objeto) === null;
}

/**
 * O serviço oferecido atende a necessidade? A regra dos motores
 * determinísticos (privado e perfis), sobre cada serviço coordenado:
 *   1. a oferta é serviço pela classificação; a necessidade nomeia serviço pelo texto;
 *   2. mesma família: necessidade genérica ("Advogado") é atendida; com
 *      especialidade, a oferta precisa cobri-la (`cobre`); só com público,
 *      precisa tratar daquele público (`cobrePublico`); a oferta genérica
 *      atende o público, o destinatário comum e, quando o texto pede o
 *      serviço, o complemento que as listas não conhecem (`atendeEspecialidades`);
 *   3. "Assessoria jurídica" e "Suporte contábil" pedidos nomeiam a profissão
 *      (Lei 8.906/94, art. 1º, II): atendidos pela advocacia e pela contabilidade;
 *   4. consultoria e assessoria se atendem só com especialidade, e nunca a
 *      assessoria que não aconselha ("Assessoria esportiva");
 *   5. assessoria ou consultoria pedida numa área da profissão ("Assessoria
 *      tributária") é atendida pela advocacia e pela contabilidade que cobrem a
 *      área (`AREAS_DAS_PROFISSOES`, exemplo 1 da spec da Glenda, 14/09).
 */
function umServicoAtende(oferecido: ServicoNomeado, pedido: ServicoNomeado, complementoDesconhecido = false): boolean {
  if (oferecido.familia === pedido.familia) return atendeEspecialidades(oferecido, pedido, complementoDesconhecido);
  if (FAMILIAS_DE_APOIO.has(pedido.familia) && PROFISSOES_PELO_ADJETIVO.has(oferecido.familia)) {
    const comoProfissao = pedido.especialidades.filter(pedida => pedida.lemas.has(oferecido.familia)).map(pedida => semOLema(pedida, oferecido.familia));
    const restantes = comoProfissao.filter(pedida => pedida.lemas.size > 0 || pedida.publico.size > 0);
    if (comoProfissao.length > 0 && (restantes.length < comoProfissao.length || atendeEspecialidades(oferecido, { familia: oferecido.familia, especialidades: restantes }))) return true;
  }
  if (SINONIMOS_PROXIMOS.has(`${oferecido.familia}|${pedido.familia}`)) {
    const pedidas = pedido.especialidades.filter(pedida => pedida.lemas.size > 0 && !naoAconselha(pedida, ASSESSORIAS_QUE_NAO_ACONSELHAM));
    // Consultoria e assessoria só se atendem pela especialidade, e a oferta genérica não tem nenhuma: o que
    // `atendeEspecialidades` abre para a oferta genérica da MESMA família não vale aqui. Sem esta linha
    // "Consultoria" × "Assessoria de MEI" valia 60 no delta da validação de 16/09 (e valeria 100 com o
    // destinatário comum); na main é 0.
    if (pedidas.length === 0 || ehGenerico(oferecido)) return false;
    if (oferecido.especialidades.some(oferecida => naoAconselha(oferecida, ASSESSORIAS_QUE_NAO_ACONSELHAM))) return false;
    return atendeEspecialidades(oferecido, { familia: pedido.familia, especialidades: pedidas });
  }
  const areas = AREAS_DAS_PROFISSOES[oferecido.familia];
  if (areas && APOIO_QUE_ACONSELHA.has(pedido.familia)) {
    // A área pedida tem de ser da profissão, e a oferta tem de cobrir TODA a especialidade pedida (`cobre`):
    // "Assessoria tributária empresarial" não é atendida por "Advocacia tributária", "Assessoria contábil
    // tributária" (pediu contador) não é atendida pela advocacia.
    const pedidas = pedido.especialidades.filter(pedida => Array.from(pedida.lemas).some(lema => areas.has(lema))
      && !naoAconselha(pedida, ASSESSORIAS_QUE_NAO_ACONSELHAM));
    if (pedidas.length > 0) return atendeEspecialidades(oferecido, { familia: oferecido.familia, especialidades: pedidas });
  }
  return false;
}

/**
 * Os destinatários que não dizem O QUE se presta, só a quem: "para PEQUENAS
 * EMPRESAS", "para MEI", "for SMALL BUSINESSES". Em lema, como o público da
 * leitura do serviço. Fundadoras, abertura de empresas, exportação e setores
 * não estão aqui de propósito: dizem O QUE se presta, e ficam na nota da
 * família (revisão de 15/09 na #127).
 *
 * Decisão do Roberto de 16/09 (D2 e D4 da validação da #135): o destinatário
 * desta lista vale 100 dos DOIS lados diante da oferta ou da necessidade que só
 * nomeia a família, com "para", com "de" ou justaposto — "Contabilidade para
 * MEI" × "Contador", "Contabilidade" × "Contador para MEI", "Contador de MEI" e
 * "Contador MEI", "Advocacia" × "Assessoria jurídica para pequenas empresas".
 * 100 passa do corte de e-mail (70): a lista é o que decide quem recebe aviso.
 */
const DESTINATARIOS_COMUNS = new Set([
  "empresa", "empresas", "pequena", "pequenas", "pequeno", "pequenos", "media", "medias", "medio", "medios", "grande", "grandes",
  "micro", "microempresa", "microempresas", "microempreendedor", "microempreendedores", "microempreendedora", "microempreendedoras",
  "mei", "meis", "me", "epp", "pme", "pmes", "startup", "startups", "negocio", "negocios", "pessoa", "pessoas", "fisica", "fisicas",
  "empreendedor", "empreendedores", "empreendedora", "empreendedoras", "cliente", "clientes", "particular", "particulares",
  "profissional", "profissionais", "liberal", "liberais",
  "small", "medium", "large", "business", "businesses", "company", "companies", "sme", "smes", "individual", "individuals",
  "entrepreneur", "entrepreneurs", "client", "clients", "customer", "customers",
  "pyme", "pymes", "mediana", "medianas", "emprendedor", "emprendedores", "emprendedora", "emprendedoras",
].map(palavra => lemaDaEspecialidade(palavra)));

/**
 * As palavras de PALAVRAS_SEM_ESPECIALIDADE que qualificam QUEM presta ou como presta — senioridade, urgência,
 * confiança, registro profissional, modalidade. Não viram especialidade, mas a necessidade que as usa diz algo além
 * da família: ver `comoAtende`. Artigo, possessivo, verbo de quem pede, "indicação" e "contratação" são estrutura.
 */
const QUALIFICA_QUEM_PRESTA = new Set([
  "especializado", "especializada", "especializados", "especializadas", "specialized",
  "urgente", "urgentes", "urgentemente", "experiente", "experientes", "qualificado", "qualificada", "qualificados", "qualificadas",
  "bom", "boa", "bons", "boas", "confiavel", "confiaveis", "confianca", "online",
  "senior", "junior", "pleno", "bilingue", "trilingue", "altamente", "freelancer", "autonomo", "autonoma",
  "inscrito", "inscrita", "registrado", "registrada", "habilitado", "habilitada", "oab", "crc", "crea",
  // A modalidade, como "online" e "autônomo": "Contador PARTICULAR", "Mentoria INDIVIDUAL" (revisão cética de 16/09).
  "particular", "individual",
  "experienced", "reliable", "good", "qualified", "trusted",
]);
const qualificaQuemPresta = (necessidade: string) => palavrasDe(necessidade).some(palavra => QUALIFICA_QUEM_PRESTA.has(palavra));

/**
 * O pedido só acrescenta à família o DESTINATÁRIO comum — com "para" ("Contador para MEI", no público) ou sem ("Contador
 * de MEI", "Contador MEI", nos lemas) —, fora a profissão que o apoio nomeia ("Assessoria JURÍDICA para MEI" diante de
 * "Advocacia"). Diante da oferta genérica, vale 100: decisão do Roberto de 16/09 (D2 e D4). Finalidade e outro
 * público ("para exportar meu café", "para restaurantes", "para pequenas empresas do agronegócio") não passam aqui.
 */
function soAcrescentaDestinatarioComum(pedida: EspecialidadeDoServico, familia: string): boolean {
  if (pedida.servicos.size > 0) return false;
  const lemas = Array.from(pedida.lemas).filter(lema => lema !== familia);
  const publico = Array.from(pedida.publico);
  if (lemas.length === 0 && publico.length === 0) return false;
  return (lemas.length === 0 || destinatarioNosLemas(lemas)) && publico.every(lema => DESTINATARIOS_COMUNS.has(lema));
}

/**
 * O serviço oferecido não tem especialidade, e o que ele acrescenta (se acrescenta) é só destinatário comum — com
 * "para" ou sem ("Contabilidade para MEI", "Contabilidade de MEI"): o lado da oferta da decisão de 16/09.
 */
const soDestinatarioComum = (servico: ServicoNomeado) => servico.especialidades.every(especialidade =>
  especialidade.servicos.size === 0
  && (especialidade.lemas.size === 0 || destinatarioNosLemas(Array.from(especialidade.lemas)))
  && Array.from(especialidade.publico).every(lema => DESTINATARIOS_COMUNS.has(lema)));

/**
 * Como a necessidade é atendida pelo serviço oferecido:
 *   - "especifico": pede ESTE serviço — mesma família e mesma especialidade
 *     ("Advogado tributarista" × "Advocacia tributária"), o público que a oferta
 *     atende ("Contador para MEI"), ou a profissão com a especialidade
 *     ("Assessoria jurídica tributária" × "Advocacia tributária");
 *   - "familia": nomeia só a família ("Advogado", "Consultoria", "Assessoria
 *     jurídica" × "Advocacia tributária") — um bom palpite, que no motor
 *     privado vale 60 (decisão da #124).
 * A oferta precisa ser serviço por inteiro ("Mina e consultoria mineral" é a
 * mina); basta um serviço coordenado de cada lado.
 */
type ComoAtende = "especifico" | "familia";
function comoAtende(oferta: string, categoriaDaOferta: string | null | undefined, necessidade: string): ComoAtende | null {
  if (classificarOferta(oferta, categoriaDaOferta) !== "servico") return null;
  const pedidos = servicosDoRotulo(necessidade);
  if (pedidos.length === 0) return null;
  // Chinês e japonês entram pela leitura do serviço (`entenderServico`), com a especialidade de antes do serviço
  // (e6ddfa4 da #127): "律师事务所" oferecido é a advocacia sem especialidade, "税务咨询" a consultoria tributária.
  const oferecidos = servicosDoRotulo(oferta);
  const palavrasDaNecessidade = palavrasDe(necessidade);
  // A prestadora que procura clientes não pede o serviço que ela mesma presta: ver `servicoEhQuemPede`.
  if (servicoEhQuemPede(palavrasDaNecessidade)) return null;
  const complementoDesconhecido = abreComplementoDesconhecido(palavrasDaNecessidade, pedidos);
  // Os DOIS lados nomeiam a família e nada além dela: "Contabilidade" oferecida diante de "Contador" procurado,
  // "Advocacia" diante de "Advogado", "Empresa de consultoria" diante de "Procura consultoria". Não há o que
  // distinguir — a necessidade nomeia exatamente o que está sendo oferecido, e não uma família da qual a oferta
  // seria um caso particular. Sem isto o par valia 60, abaixo do EMAIL_THRESHOLD de 70: o match existia e a
  // pessoa não era avisada (revisão do Nicolas na #124, 14/09, commit 9615971 — portado para esta leitura).
  //
  // "Nada além dela" é um serviço só de cada lado, lido por palavra, sem especialidade nem público. É o que
  // separa "Contabilidade" de "Consultoria jurídica" e "Consultoria de marketing" (a segunda palavra é o objeto do
  // serviço, e quem procurou só "Consultoria" não pediu aquele objeto) e de "Tradução e interpretação" e
  // "Advogada consultora" (dois serviços). Em chinês e japonês vale o mesmo, desde que a leitura pelo fim do termo
  // lê a especialidade (e6ddfa4 da #127): "律师事务所" × "律师" e "律师" × "Advogado" são o mesmo serviço (100), e
  // "税务咨询" × "咨询" fica na nota da família (60).
  //
  // Do lado da oferta, o DESTINATÁRIO comum também não é especialidade: "Contabilidade para pequenas empresas",
  // "Contabilidad para pymes" e "Accounting for small businesses" diante de "Contador" são o mesmo serviço, e na
  // main valiam 100. O que vem depois de "para" e não é destinatário diz o que se presta — a finalidade ou o setor
  // ("Consultoria para exportação", "Marketing para restaurantes", "Advogado para causas do trabalho") — e fica na
  // nota da família, como a mesma especialidade escrita com "em" (revisão de 15/09 na #127, 116bb56, portada).
  //
  // Do lado da NECESSIDADE, o qualificador de quem presta também é algo além da família: "Contador sênior",
  // "Advogado especializado", "Consultoria especializada", "Contador de confiança", "Contador com CRC", "Bom
  // contador" e "Contador online" ficam na nota da família (60), como na #127, que lê a necessidade ao pé da letra
  // (`familiaSemMaisNada` da 76cd7da, mantida na ff9564f) e rejeitou de propósito o critério "pedido genérico":
  // a leitura do serviço descarta essas palavras sem virar especialidade, e com ele o par valia 100 e mandava
  // e-mail. Ficam em 100 aqui, por decisão já fixada nos testes da #135, o adjetivo sozinho ("Contabilidade" ×
  // "Contábil") e o lugar ("Contador em Campinas/SP"), que na #127 valem 60 (revisão de 15/09 do porte).
  const semQualificador = !qualificaQuemPresta(necessidade);
  const nadaAlemDaFamilia = oferecidos.length === 1 && soDestinatarioComum(oferecidos[0]) && semQualificador;
  let melhor: ComoAtende | null = null;
  for (const pedido of pedidos) {
    // Cada alternativa por si: em "Assessoria jurídica e tributária" diante de "Advocacia trabalhista", só a parte
    // "jurídica" é atendida, e ela nomeia a profissão — vale a família, não a especialidade que ninguém atendeu.
    const alternativas = ehGenerico(pedido)
      ? [pedido]
      : pedido.especialidades.map(especialidade => ({ familia: pedido.familia, especialidades: [especialidade] }));
    for (const oferecido of oferecidos) {
      for (const alternativa of alternativas) {
        if (!umServicoAtende(oferecido, alternativa, complementoDesconhecido)) continue;
        const soAFamilia = alternativa.especialidades.every(especialidade =>
          especialidade.publico.size === 0 && Array.from(especialidade.lemas).every(lema => lema === oferecido.familia));
        // Quem oferece a família inteira diante do pedido que acrescenta alguma coisa (decisão do Roberto de 16/09):
        //   - só o DESTINATÁRIO comum, com "para", "de" ou justaposto, é o mesmo serviço e vale 100 — "Contabilidade"
        //     × "Contador para MEI", "Contador de MEI", "Contador MEI"; "Advocacia" × "Assessoria jurídica para
        //     pequenas empresas" (D2 e D4). É o espelho do lado da oferta ("Contabilidade para MEI" × "Contador"),
        //     e passa do corte de e-mail;
        //   - com qualificador de quem presta ("Preciso de um bom contador para MEI") fica na nota da família, como
        //     "Contador sênior" diante de "Contabilidade";
        //   - finalidade, outro público ou complemento que as listas não conhecem ("logística para exportar meu
        //     café", "Marketing para restaurantes", "Preciso de advogado marítimo") vale a família (60): a oferta
        //     genérica não provou o que o pedido acrescenta (D1).
        if (!soAFamilia && ehGenerico(oferecido)) {
          if (semQualificador && alternativa.especialidades.every(especialidade => soAcrescentaDestinatarioComum(especialidade, oferecido.familia))) {
            return "especifico";
          }
          melhor = "familia";
          continue;
        }
        if (!soAFamilia) return "especifico";
        if (nadaAlemDaFamilia && pedidos.length === 1 && ehGenerico(pedido) && pedido.familia === oferecido.familia) return "especifico";
        melhor = "familia";
      }
    }
  }
  return melhor;
}

/**
 * A necessidade pede ESTE serviço, não só a família dele: mesma família E
 * mesma especialidade ("Advogado tributarista" × "Advocacia tributária"). No
 * motor privado vale 100, a nota de quem tem a mesma coisa.
 */
export function mesmaFamiliaEEspecialidade(oferta: string, categoriaDaOferta: string | null | undefined, necessidade: string): boolean {
  return comoAtende(oferta, categoriaDaOferta, necessidade) === "especifico";
}

/**
 * A necessidade nomeia só a FAMÍLIA do serviço oferecido: "Consultoria"
 * procurado diante de "Consultoria jurídica", "Advogado" diante de "Advocacia
 * tributária". Quem escreveu isso declarou precisar daquela família; no motor
 * privado vale 60 (decisão da #124). "Consultoria em marketing" procurado é
 * outra necessidade e não casa com "Consultoria jurídica".
 */
export function necessidadeGenericaNomeiaOServico(oferta: string, categoriaDaOferta: string | null | undefined, necessidade: string): boolean {
  return comoAtende(oferta, categoriaDaOferta, necessidade) === "familia";
}

/** A necessidade nomeia o serviço oferecido, pela família ou pela especialidade — o que o motor de perfis aceita. */
export function necessidadeNomeiaOServico(oferta: string, categoriaDaOferta: string | null | undefined, necessidade: string): boolean {
  return comoAtende(oferta, categoriaDaOferta, necessidade) !== null;
}

/** O serviço oferecido atende a necessidade, de qualquer dos dois jeitos (sem categoria). */
export function servicoAtendeNecessidade(oferta: string, necessidade: string): boolean {
  return comoAtende(oferta, null, necessidade) !== null;
}

// ─── O que a regra não lê num idioma novo (e6ddfa4 e 116bb56 da #127) ────────
//
// Em francês, alemão, russo, hindi, árabe, chinês e japonês as listas são
// curtas, e a regra estrita levava a ZERO o que só não sabia ler: "Налоговый
// консалтинг" × "Налоговая консультация" [Финансы] valia 60 na main (a
// categoria em comum) e caiu para 0. A regra, decidida na revisão de 14/09 da
// #127:
//   - onde há regra no idioma (lema curado, marcador de pedido, a leitura do
//     chinês e do japonês pelo fim do termo), o motor decide como em
//     português: 100, 60 ou 0;
//   - onde o par só não casa por palavra que as listas não conhecem, escrita
//     num desses idiomas, o portão NÃO bloqueia: o par vale o que valia na
//     main, a categoria em comum, e nunca 0 por falta de regra;
//   - o que o motor entende continua barrado: necessidade que não nomeia
//     serviço ("Maschinen"), outra família ("Юрист" para consultoria) e
//     especialidade entendida e diferente ("Юридическая консультация" para
//     "Налоговый консалтинг");
//   - duas travas da revisão de 15/09: o pedido precisa pedir o serviço
//     (`pedeServico`: "Bureaux pour avocats" cita a família sem pedir), e o
//     pedido que só fica genérico porque saiu o que as listas não leem não casa
//     com oferta de especialidade entendida.
// Em português, inglês e espanhol a regra segue estrita, também na parte de um
// rótulo bilíngue escrita nesses idiomas (`palavrasPorIdioma`) — e com ela os
// exemplos da spec da Glenda, o vocabulário curado de assunto e as opções
// genéricas de "O que você busca?" e "O que preciso", que só se escrevem assim.

/** Letra de escrita não latina: russo, hindi, árabe, chinês, japonês. */
const LETRA_NAO_LATINA = new RegExp("[^\\p{Script=Latin}\\p{N}\\p{M}]", "u");
const SERVICO_EM_FRANCES_OU_ALEMAO = new Set([...ASSESSORIA_EM_FRANCES_E_ALEMAO, ...OUTROS_SERVICOS_EM_FRANCES_E_ALEMAO]);

/**
 * Palavras de ligação que só o francês e o alemão usam. Reconhecem esses idiomas
 * também quando o serviço vem no empréstimo do inglês ("Consultant en fiscalité
 * DES entreprises", "IT-Consulting FÜR DEN Mittelstand"), que era lido como
 * inglês e seguia estrito (116bb56 da #127). Não entra o que também é palavra do
 * português, do inglês ou do espanhol ("de", "la", "en", "die", "das"): "les"
 * (pronome) e "une" (de unir) são espanhol comum, e uma delas bastava para jogar
 * o trecho inteiro nos idiomas novos — "Necesitamos una consultoría de recursos
 * humanos que LES ayude" deixava de ser barrada diante de "Consultoria em
 * comércio exterior" (revisão de 15/09 do porte). "des" fica: em espanhol é só o
 * subjuntivo informal de "dar" ("que me des"), que não aparece em rótulo nem em
 * pedido de serviço, e sem ele "Consultant en fiscalité DES entreprises" volta a
 * ser lido como inglês.
 */
const LIGACOES_DO_FRANCES_E_DO_ALEMAO = new Set([
  "des", "du", "pour", "avec", "aux", "au", "dans", "chez",
  "fur", "fuer", "zum", "zur", "und", "mit", "der", "dem", "den", "vom", "beim",
]);
/** Onde um rótulo bilíngue troca de idioma: barra, parênteses, colchetes, travessão, "|" e " - ". */
const TROCA_DE_IDIOMA = new RegExp("[/|()\\[\\]{}\\u2013\\u2014]|\\s-\\s", "u");

/**
 * As palavras de um rótulo separadas pelo idioma: `novas` são as de escrita não
 * latina e as latinas do trecho em francês ou alemão (palavra de serviço ou de
 * ligação desses idiomas); `estritas`, as demais, em português, inglês ou
 * espanhol. A decisão é por trecho e por palavra, não pelo rótulo inteiro: em
 * "Consultoria em segurança do trabalho / 安全咨询" só o chinês é idioma novo, e
 * o "segurança" do português continua valendo contra o par (116bb56 da #127).
 */
function palavrasPorIdioma(rotulo: string): { novas: string[]; estritas: string[] } {
  const novas: string[] = [];
  const estritas: string[] = [];
  for (const trecho of rotulo.split(TROCA_DE_IDIOMA)) {
    const palavras = tokensDoTermo(trecho);
    const francesOuAlemao = palavras.some(palavra => SERVICO_EM_FRANCES_OU_ALEMAO.has(palavra) || LIGACOES_DO_FRANCES_E_DO_ALEMAO.has(palavra));
    // O "d'" (`D_APOSTROFO`) tem o apóstrofo de escrita comum, mas é latino: decide como o "d" decidia.
    for (const palavra of palavras) (francesOuAlemao || (palavra !== D_APOSTROFO && LETRA_NAO_LATINA.test(palavra)) ? novas : estritas).push(palavra);
  }
  return { novas, estritas };
}

/**
 * O serviço só com o que as listas leem: sem os lemas desconhecidos nem o público
 * que elas não reconhecem. O que foi escrito em português, inglês ou espanhol
 * (`estritos`, em lema) nunca sai.
 */
function soOQueAsListasLeem(servico: ServicoNomeado, estritos: ReadonlySet<string>): ServicoNomeado {
  const lido = (lema: string) => lemaCuradoOuIdioma(lema) || FAMILIAS_CONHECIDAS.has(lema) || estritos.has(lema);
  return {
    familia: servico.familia,
    especialidades: servico.especialidades
      .map(especialidade => ({
        ...especialidade,
        lemas: new Set(Array.from(especialidade.lemas).filter(lema => especialidade.conhecidos.has(lema) || estritos.has(lema))),
        publico: new Set(Array.from(especialidade.publico).filter(lido)),
        publicoEspecifico: new Set(Array.from(especialidade.publicoEspecifico).filter(lido)),
        assunto: new Set<string>(),
      }))
      .filter(especialidade => especialidade.lemas.size > 0 || especialidade.publico.size > 0),
  };
}

/**
 * A necessidade num idioma novo PEDE um serviço? O serviço precisa ser o que se
 * pede, não a palavra da família num pedido de outra coisa, que a main barrava e
 * a exceção dos idiomas novos soltava (116bb56 da #127):
 *   - "Bureaux POUR avocats", "Räume FÜR Schulungen": o serviço atrás de "para"
 *     é para quem (ver PREPOSICOES), e `nucleoDoServico` não o lê;
 *   - "वकील के लिए कार्यालय" (escritório para advogado): em hindi o "para" vem
 *     depois de quem se atende, e o que se pede é o que vem depois de "के लिए";
 *   - "Juristische Person", "Юридический адрес": o adjetivo de profissão
 *     anteposto qualifica o substantivo seguinte, que não é serviço;
 *   - "Conseil d'administration": o conselho, não a consultoria (já sai em `palavrasDe`).
 */
function pedeServico(rotulo: string): boolean {
  const palavras = palavrasDe(rotulo);
  const posposicao = palavras.findIndex((palavra, i) => palavra === "लिए" && palavras[i - 1] === "के");
  const termo = posposicao > 0 ? palavras.slice(posposicao + 1) : palavras;
  const inicio = inicioDoServico(termo);
  const cabeca = termo[inicio] ?? "";
  const seguinte = termo[inicio + 1];
  if (ADJETIVOS_ANTEPOSTOS.has(cabeca) && seguinte !== undefined && !FRONTEIRAS.has(seguinte) && !ehPalavraDeServico(seguinte)
    && COMPOSTOS.get(`${cabeca} ${seguinte}`) !== "servico") return false;
  // Chinês e japonês: o serviço que termina o termo ("招聘律师", "我们需要税务咨询").
  return nucleoDoServico(termo) !== null || (posposicao < 0 && servicoNoFimSemEspaco(rotulo) !== null);
}

/**
 * A regra NÃO LÊ este par? Verdadeiro quando a oferta é serviço, o par não
 * casa, ao menos um lado está num idioma novo e, tirado DESSE lado o que as
 * listas não conhecem, o serviço oferecido atenderia o pedido — a única razão
 * do zero é palavra que o motor não sabe ler ("Steuerberatung für Erbschaften"
 * × "Steuerberater für Erbschaftsteuer"). Palavra desconhecida do lado escrito
 * em português, inglês ou espanhol continua valendo contra o par. Os motores
 * determinísticos tratam o par como a main: sem bloqueio, com a categoria.
 */
export function regraNaoLeOPar(oferta: string, categoriaDaOferta: string | null | undefined, necessidade: string): boolean {
  if (classificarOferta(oferta, categoriaDaOferta) !== "servico") return false;
  const daOferta = palavrasPorIdioma(oferta);
  const daNecessidade = palavrasPorIdioma(necessidade);
  const ofertaEmIdiomaNovo = daOferta.novas.length > 0;
  const necessidadeEmIdiomaNovo = daNecessidade.novas.length > 0;
  if (!ofertaEmIdiomaNovo && !necessidadeEmIdiomaNovo) return false;
  if (comoAtende(oferta, categoriaDaOferta, necessidade) !== null) return false;
  if (necessidadeEmIdiomaNovo && !pedeServico(necessidade)) return false;
  const emLema = (palavras: string[]) => new Set(palavras.map(lemaDaEspecialidade));
  const estritosDaOferta = emLema(daOferta.estritas);
  const estritosDaNecessidade = emLema(daNecessidade.estritas);
  const oferecidos = servicosDoRotulo(oferta).map(servico => (ofertaEmIdiomaNovo ? soOQueAsListasLeem(servico, estritosDaOferta) : servico));
  return servicosDoRotulo(necessidade).some(pedido => {
    const lido = necessidadeEmIdiomaNovo ? soOQueAsListasLeem(pedido, estritosDaNecessidade) : pedido;
    // O pedido que só ficou genérico porque saiu o que as listas não leem ("Консультация по логистике" vira
    // "Консультация") não é a genérica que alguém escreveu: diante de oferta com especialidade entendida
    // ("Consultoria tributária"), o que saiu pode ser outra especialidade, e o par casava serviços diferentes que a
    // main barrava (116bb56 da #127).
    const virouGenerico = !ehGenerico(pedido) && ehGenerico(lido);
    return oferecidos.some(oferecido => umServicoAtende(oferecido, lido)
      && !(virouGenerico && oferecido.especialidades.some(especialidade => especialidade.conhecidos.size > 0)));
  });
}

/**
 * Serviço de assessoria? É o que atende a opção fixa "Consultoria" de "O que
 * preciso": quem marcou essa opção DECLAROU precisar de aconselhamento
 * profissional. Decide a família da cabeça de cada serviço coordenado
 * ("Marketing e contabilidade para MEI" tem contabilidade); suporte,
 * assistência e atendimento contam quando nomeiam a profissão ("Suporte
 * jurídico"); assessoria de imprensa, de viagens, esportiva e coach de corrida
 * não aconselham.
 */
export function ehServicoDeAssessoria(rotulo: string, categoria?: string | null): boolean {
  if (classificarOferta(rotulo, categoria) !== "servico") return false;
  const servicos = servicosDoRotulo(rotulo);
  if (servicos.length === 0) {
    // Serviço reconhecido só pela categoria ou pelo vocabulário sem espaço (zh/ja): decide o que se sabe dele.
    const familia = familiaSemEspaco(rotulo);
    if (familia) return FAMILIAS_DE_ASSESSORIA.has(familia);
    return tokensDoTermo(categoria ?? "").some(palavra => FAMILIAS_DE_ASSESSORIA.has(familiaDaPalavra(palavra)));
  }
  return servicos.some(servico => {
    if (servico.familia === "suporte" || servico.familia === "assistencia" || servico.familia === "atendimento") {
      return servico.especialidades.some(especialidade => Array.from(especialidade.conhecidos).some(lema => PROFISSOES_PELO_ADJETIVO.has(lema)));
    }
    if (!FAMILIAS_DE_ASSESSORIA.has(servico.familia)) return false;
    // Consultoria de qualquer assunto conta ("Consultoria de viagens"): a opção fixa nomeia a família, e a
    // necessidade que nomeia só a família vale (decisão da #124).
    if (servico.familia !== "assessoria" && servico.familia !== "coaching") return true;
    const comEspecialidade = servico.especialidades.filter(especialidade => especialidade.lemas.size > 0);
    return comEspecialidade.length === 0 || comEspecialidade.some(especialidade => !naoAconselha(especialidade, ASSESSORIAS_QUE_NAO_ACONSELHAM));
  });
}

// ─── Para o portão da IA (server/portao-da-demanda-expressa.ts) ──────────────
//
// Na IA a regra é mais frouxa que nos motores determinísticos, de propósito:
// o modelo leu o texto todo e citou a necessidade. O portão só BARRA quando a
// citação nomeia um serviço que o texto ENTENDE e que claramente não é o do
// perfil ("consultoria em marketing" para "Consultoria jurídica", "contador
// tributário" para "Advocacia tributária"). O que o texto não entende fica com
// a IA, como antes da amarração.

/** Palavras que não provam nada numa citação: ligação, artigo, preposição. Uma lista só, para a conferência e a localização. */
export const PALAVRAS_VAZIAS_DA_CITACAO: ReadonlySet<string> = new Set([
  "de", "da", "do", "das", "dos", "e", "a", "o", "as", "os", "um", "uma", "em", "no", "na", "nos", "nas",
  "para", "por", "com", "que", "of", "the", "and", "for", "to", "in", "on", "with", "an", "y", "el",
  "la", "los", "las", "en", "con", "del", "al",
]);

type VereditoDoPortao = "atende" | "neutro" | "nao";

/** A especialidade pedida diante da oferecida, só pelo que as listas reconhecem. */
function compararConhecidos(oferecido: ServicoNomeado, pedido: ServicoNomeado, ignorar: string | null): VereditoDoPortao {
  if (ehGenerico(pedido)) return "atende";
  // O que o pedido exige e as listas reconhecem: a especialidade e, sem ela, a especialidade curada do
  // público ("advogado para DIVÓRCIO", "para recuperar créditos de ICMS"). Do público só conta o específico:
  // "para a nossa EMPRESA" e "holding FAMILIAR" não pedem advocacia empresarial nem de família (revisão de 14/09).
  const pedidas = pedido.especialidades.map(especialidade => [
    ...Array.from(especialidade.conhecidos),
    ...(especialidade.lemas.size === 0 ? Array.from(especialidade.publicoEspecifico).filter(lemaCuradoOuIdioma) : []),
  ].filter(lema => lema !== ignorar));
  if (pedidas.every(pedida => pedida.length === 0)) {
    // Especialidade que as listas não leem fica com a IA: "advogado também", "lawyer urgently", "avocat pour
    // notre filiale". Só barra o ASSUNTO desconhecido de consultoria ou assessoria, diante de oferta com
    // especialidade reconhecida e sem nada em comum — ali o assunto é o serviço: "consultoria em e-commerce"
    // para "Consultoria jurídica".
    const ofertaReconhecida = oferecido.especialidades.some(especialidade => especialidade.conhecidos.size > 0);
    const assuntoDesconhecido = FAMILIAS_DE_APOIO.has(pedido.familia) && pedido.especialidades.some(especialidade => especialidade.assunto.size > 0);
    const emComum = pedido.especialidades.some(pedida => Array.from(pedida.lemas).some(lema =>
      oferecido.especialidades.some(oferecida => oferecida.lemas.has(lema) || oferecida.publico.has(lema))));
    return ignorar === null && ofertaReconhecida && assuntoDesconhecido && !emComum ? "nao" : "neutro";
  }
  if (oferecido.especialidades.every(especialidade => especialidade.conhecidos.size === 0)) return ehGenerico(oferecido) ? "atende" : "neutro";
  let idiomaQueAOfertaNaoDiz = false;
  for (const pedida of pedidas) {
    // Alternativa sem nada reconhecido não salva a que foi lida: "consultoria em marketing E redes sociais".
    if (pedida.length === 0) continue;
    // Idioma pedido diante de oferta que não diz idioma ("tradutor de INGLÊS" para "Tradução juramentada"):
    // são dimensões diferentes, e fica com a IA.
    const soIdioma = pedida.every(lema => lema.startsWith("idioma:"));
    if (soIdioma && oferecido.especialidades.every(oferecida => !Array.from(oferecida.conhecidos).some(lema => lema.startsWith("idioma:")))) {
      idiomaQueAOfertaNaoDiz = true;
      continue;
    }
    // A oferta cobre o pedido sem nomear outro serviço que ele não pede ("Consultoria de MARKETING jurídico").
    const cobre = oferecido.especialidades.some(oferecida =>
      pedida.every(lema => oferecida.conhecidos.has(lema) || oferecida.publico.has(lema))
      && Array.from(oferecida.servicos).every(lema => pedida.includes(lema)));
    // Pedido mais específico que a oferta no mesmo serviço ("consultoria em marketing digital" para "Consultoria em
    // marketing"), desde que a oferta não tenha palavra que as listas não leem ("Consultoria em TRANSFORMAÇÃO
    // digital") e o que o pedido tem a mais não seja OUTRO serviço nomeado antes do da oferta: "consultoria em
    // MARKETING jurídico" é marketing; "consultoria jurídica de DESIGN de marca" é jurídica, sobre design.
    const maisEspecifico = oferecido.especialidades.some(oferecida => {
      if (oferecida.conhecidos.size === 0 || desconhecidosDe(oferecida).length > 0) return false;
      if (!Array.from(oferecida.conhecidos).every(lema => pedida.includes(lema))) return false;
      const ultimoDaOferta = Math.max(...pedida.map((lema, k) => (oferecida.conhecidos.has(lema) ? k : -1)));
      return pedida.every((lema, k) => oferecida.conhecidos.has(lema) || !FAMILIAS_CONHECIDAS.has(lema) || k > ultimoDaOferta);
    });
    if (cobre || maisEspecifico) return "atende";
  }
  return idiomaQueAOfertaNaoDiz ? "neutro" : "nao";
}

const FAMILIAS_CONHECIDAS = new Set(Object.keys(FAMILIAS));

function vereditoDoPedido(pedido: ServicoNomeado, oferecidos: readonly ServicoNomeado[]): VereditoDoPortao {
  let melhor: VereditoDoPortao = "nao";
  // "assessoria de imprensa", "coach de corrida": o nome é de apoio, o serviço não aconselha.
  const pedidoNaoAconselha = (pedido.familia === "assessoria" || pedido.familia === "coaching")
    && pedido.especialidades.some(especialidade => naoAconselha(especialidade, ASSESSORIAS_QUE_NAO_ACONSELHAM));
  for (const oferecido of oferecidos) {
    if (umServicoAtende(oferecido, pedido)) return "atende";
    if (pedidoNaoAconselha && oferecido.familia !== pedido.familia) continue;
    let veredito: VereditoDoPortao = "nao";
    if (oferecido.familia === pedido.familia || SINONIMOS_PROXIMOS.has(`${oferecido.familia}|${pedido.familia}`)) {
      veredito = compararConhecidos(oferecido, pedido, null);
    } else if (FAMILIAS_DE_APOIO.has(pedido.familia) && pedido.especialidades.some(especialidade => especialidade.lemas.has(oferecido.familia))) {
      // "suporte em MARKETING", "consultoria em COMPLIANCE": o pedido nomeia o serviço da oferta.
      const comparado = compararConhecidos(oferecido, pedido, oferecido.familia);
      veredito = comparado === "neutro" ? "atende" : comparado;
    } else if (PROFISSOES_PELO_ADJETIVO.has(pedido.familia) && FAMILIAS_DE_APOIO.has(oferecido.familia)
      && oferecido.especialidades.some(especialidade => especialidade.lemas.has(pedido.familia))) {
      // "Precisamos de um advogado" para quem oferece "Consultoria jurídica": consultoria jurídica é trabalho de
      // advogado (Lei 8.906/94, art. 1º, II). Nos motores determinísticos não casa; na IA fica com o modelo.
      veredito = "neutro";
    } else if (FAMILIAS_DE_APOIO.has(pedido.familia) && FAMILIAS_DE_ASSESSORIA.has(oferecido.familia)) {
      // Apoio genérico ("suporte para obter a autorização") diante de assessoria fica com a IA, salvo se o
      // pedido nomeia OUTRO serviço ("consultoria em MARKETING") ou especialidade que a oferta não tem.
      const nomeiaOutroServico = pedido.especialidades.some(especialidade =>
        Array.from(especialidade.conhecidos).some(lema => FAMILIAS_CONHECIDAS.has(lema) && lema !== oferecido.familia));
      veredito = nomeiaOutroServico || compararConhecidos(oferecido, pedido, null) === "nao" ? "nao" : "neutro";
    }
    if (veredito === "atende") return "atende";
    if (veredito === "neutro") melhor = "neutro";
  }
  return melhor;
}

/** Verbos de pedido que só a IA precisa ler, para tirar a autodescrição da frente: "Marketing agency REQUIRES a lawyer". */
const VERBOS_DE_PEDIDO_NA_IA = new Set([
  "requer", "requerem", "demanda", "demandam", "solicita", "solicitam", "exige", "exigem",
  "requires", "require", "seeks", "seek", "seeking", "hiring", "hires", "requiere", "requieren",
]);
const ehMarcaDePedido = (palavra: string) => MARCADORES_FRACOS.has(palavra) || VERBOS_DE_NECESSIDADE.has(palavra) || VERBOS_DE_PEDIDO_NA_IA.has(palavra);
/** Pronome relativo: abre outra oração, que já não é o pedido ("advogado QUE nos ajude", "lawyer WHO speaks"). */
const ABRE_ORACAO = new Set(["que", "who", "which", "that", "qui", "quien", "quienes"]);
/** "Nous cherchons UN comptable": em francês "comptable" é também o contador, e depois de artigo ou possessivo é o substantivo (9e027bf). */
const COMPTABLE = new Set(["comptable", "comptables"]);
const DETERMINANTES_DO_FRANCES = new Set(["un", "une", "le", "la", "les", "des", "du", D_APOSTROFO, "l", "au", "aux", "notre", "votre", "nos", "vos", "leur", "leurs"]);
const nomeiaServicoEm = (item: readonly string[], k: number) =>
  ehSubstantivoDeServico(item[k]) || areaDoDireito(item as string[], k) !== null
  || (ADJETIVOS_DE_SERVICO.has(item[k]) && k > 0 && (CABECAS_NEUTRAS.has(item[k - 1]) || (COMPTABLE.has(item[k]) && DETERMINANTES_DO_FRANCES.has(item[k - 1]))));
/** Antes do substantivo, só entra no pedido o que qualifica serviço de fato: "TAX lawyer", "LEGAL support", "escritório contábil". */
const qualificaAntes = (palavra: string) =>
  lemaCurado(palavra) !== undefined || ADJETIVOS_DE_SERVICO.has(palavra) || SUBSTANTIVOS_DE_SERVICO.has(palavra) || IDIOMA_DA_PALAVRA.has(palavra) || CORPORATIVO.has(palavra) || CABECAS_NEUTRAS.has(palavra);

/** O pedido de serviço de um item: começa no serviço, ou no serviço depois do último verbo de pedido ("Agência de marketing BUSCA advogada"). */
function pedidoDoItem(item: readonly string[]): string | null {
  let primeiro = item.findIndex((_, k) => nomeiaServicoEm(item, k));
  if (primeiro < 0) return null;
  for (let k = item.length - 1; k > primeiro; k -= 1) {
    if (!ehMarcaDePedido(item[k])) continue;
    const depois = item.findIndex((_, j) => j > k && nomeiaServicoEm(item, j));
    if (depois >= 0) primeiro = depois;
    break;
  }
  let comeco = primeiro;
  while (comeco > 0 && qualificaAntes(item[comeco - 1])) comeco -= 1;
  return item.slice(comeco).join(" ");
}

/** O pedaço que começa em `j` abre outro serviço? ("e contador", ", designer"). Senão é especialidade do anterior ("e previdenciária"). */
function abreOutroServico(tokens: readonly string[], j: number): boolean {
  let k = j;
  while (k < tokens.length && (ARTIGOS.has(tokens[k]) || MARCADORES_FRACOS.has(tokens[k]) || PALAVRAS_SEM_ESPECIALIDADE.has(tokens[k]) || GENITIVOS.has(tokens[k]))) k += 1;
  return k < tokens.length && nomeiaServicoEm(tokens, k);
}

/** Separa os pedidos de um trecho: vírgula, quebra de campo e conjunção só separam quando o pedaço seguinte nomeia outro serviço. */
function itensDoTrecho(tokens: readonly string[], quebraAntes: readonly boolean[]): string[][] {
  const itens: string[][] = [[]];
  for (let k = 0; k < tokens.length; k += 1) {
    const palavra = tokens[k];
    const conjuncao = CONJUNCOES.has(palavra);
    if (conjuncao || (k > 0 && quebraAntes[k])) {
      if (abreOutroServico(tokens, conjuncao ? k + 1 : k)) {
        itens.push([]);
        if (conjuncao) continue;
      } else if (!conjuncao) {
        itens[itens.length - 1].push("e");
      }
    }
    itens[itens.length - 1].push(palavra);
  }
  return itens.filter(item => item.length > 0);
}

function julgarTrecho(tokens: readonly string[], quebraAntes: readonly boolean[], oferecidos: readonly ServicoNomeado[], vigiadas: ReadonlySet<string> | null): VereditoDoPortao | null {
  const pedidos = itensDoTrecho(tokens, quebraAntes)
    .map(pedidoDoItem)
    .filter((pedido): pedido is string => pedido !== null)
    .map(entenderServico)
    .filter((servico): servico is ServicoNomeado => servico !== null);
  if (!pedidos.length) return null;
  const vereditos = pedidos.map(pedido => {
    const veredito = vereditoDoPedido(pedido, oferecidos);
    return veredito === "nao" && vigiadas && !vigiadas.has(pedido.familia) ? "neutro" : veredito;
  });
  if (vereditos.includes("atende")) return "atende";
  return vereditos.includes("neutro") ? "neutro" : "nao";
}

const oferecidosDe = (servicosOferecidos: readonly string[]) =>
  servicosOferecidos.filter(oferta => classificarOferta(oferta) === "servico").flatMap(servicosDoRotulo);

/** Para os testes do módulo: o veredito de um trecho solto (vírgula separa itens). */
export function trechoNomeiaServicoAtendido(trecho: string, servicosOferecidos: readonly string[]): "nao-nomeia-servico" | "atende" | "nao-atende" {
  const { tokens, quebraAntes } = tokensDoTexto(trecho);
  const veredito = julgarTrecho(tokens, quebraAntes, oferecidosDe(servicosOferecidos), null);
  return veredito === "atende" ? "atende" : veredito === "nao" ? "nao-atende" : "nao-nomeia-servico";
}

/** Fim de frase e separador de campo (" | ") encerram o trecho; vírgula e barra só separam itens. */
const FIM_DE_FRASE = new RegExp("[.!?;:|\\n]+");
const SEPARA_ITENS = new RegExp("[,/]+");
const semEHifen = (texto: string) => texto.replace(E_COM_HIFEN, "$1$2$3");

function tokensDoTexto(texto: string): { tokens: string[]; quebraAntes: boolean[]; fimAntes: boolean[] } {
  const tokens: string[] = [];
  const quebraAntes: boolean[] = [];
  const fimAntes: boolean[] = [];
  semEHifen(texto).split(FIM_DE_FRASE).forEach((frase, f) => {
    frase.split(SEPARA_ITENS).forEach((pedaco, p) => {
      tokensDoTermo(pedaco).forEach((palavra, k) => {
        tokens.push(palavra);
        quebraAntes.push(k === 0 && (p > 0 || f > 0));
        fimAntes.push(k === 0 && p === 0 && f > 0);
      });
    });
  });
  return { tokens, quebraAntes, fimAntes };
}

const ehConteudo = (palavra: string) => palavra.length >= 3 && !PALAVRAS_VAZIAS_DA_CITACAO.has(palavra);

/** As janelas [início, fim] em que as palavras citadas aparecem EM ORDEM, com até duas palavras de conteúdo quaisquer entre elas. */
function janelasDaCitacao(citadas: readonly string[], tokens: readonly string[]): Array<[number, number]> {
  const conteudo = tokens.map((palavra, k) => [palavra, k] as const).filter(([palavra]) => ehConteudo(palavra));
  const naFonte = new Set(tokens);
  const tolerancia = citadas.length > 3 ? 1 : 0;
  const janelas: Array<[number, number]> = [];
  for (let c0 = 0; c0 < conteudo.length; c0 += 1) {
    for (let primeira = 0; primeira <= tolerancia; primeira += 1) {
      if (conteudo[c0][0] !== citadas[primeira]) continue;
      if (primeira === 1 && naFonte.has(citadas[0])) continue;
      let faltas = primeira;
      let posicao = c0;
      for (let c = primeira + 1; c < citadas.length && faltas <= tolerancia; c += 1) {
        let achou = -1;
        for (let k = posicao + 1; k <= Math.min(conteudo.length - 1, posicao + 3); k += 1) {
          if (conteudo[k][0] === citadas[c]) {
            achou = k;
            break;
          }
        }
        if (achou >= 0) posicao = achou;
        else faltas += naFonte.has(citadas[c]) ? tolerancia + 1 : 1;
      }
      if (faltas <= tolerancia) janelas.push([conteudo[c0][1], conteudo[posicao][1]]);
    }
  }
  return janelas;
}

/**
 * A citação conferida pede um serviço que o perfil oferece? (defeito relatado
 * em 13/09: "consultoria em marketing" passava para quem oferece "Consultoria
 * jurídica"). A citação é localizada na fonte EM ORDEM e cada ocorrência é
 * julgada; basta uma que não barre:
 *   - trecho sem serviço que o texto entenda fica com a IA, como antes;
 *   - quando a citação TERMINA num serviço, o trecho segue até o fim da frase
 *     ou do item, para a citação cortada ("Precisamos de consultoria") ser
 *     julgada como a inteira ("... com foco em marketing digital");
 *   - vírgula, quebra de campo e conjunção só separam pedidos quando o pedaço
 *     seguinte nomeia outro serviço ("advogado, contador e designer"); senão
 *     são especialidade ("advogada trabalhista e previdenciária").
 * `soFamiliasDoPerfil`: o perfil tem outra base em "O que tenho" (ids fixos,
 * produto), e o modelo pode ter se apoiado nela — só barra pedido de
 * assessoria ou da família que o perfil oferece.
 */
export function citacaoPedeServicoOferecido(citacao: string, fonte: string, servicosOferecidos: readonly string[], soFamiliasDoPerfil = false): boolean {
  const oferecidos = oferecidosDe(servicosOferecidos);
  if (!oferecidos.length) return true;
  const vigiadas = soFamiliasDoPerfil ? new Set([...Array.from(FAMILIAS_DE_ASSESSORIA), ...oferecidos.map(oferecido => oferecido.familia)]) : null;
  // O trecho que não nomeia serviço nenhum ficava sempre com a IA. Continua, salvo nos dois casos que o texto
  // entende (exemplos 2 e 3 da spec da Glenda, 14/09): o assunto do serviço declarado passa
  // (`necessidadeDeclaraOAssuntoDoServico`), e o pedido de CONTRAPARTE ou a AUTODESCRIÇÃO de quem escreveu barram
  // ("busca distribuidor para expansão na África", "Empresa brasileira com operações internacionais" citados
  // para um serviço tributário ou de internacionalização). Com outra base no perfil (`soFamiliasDoPerfil`) o
  // modelo pode ter se apoiado nela, e a barreira não se aplica.
  // E o trecho que o texto lê como pedido sobre um ASSUNTO do vocabulário curado barra quando nenhum serviço do
  // perfil tem relação com ele ("suporte para obter autorização regulatória do medicamento" citado para
  // "Consultoria em marketing" ou para "Advocacia tributária").
  const julgar = (tokensDoTrecho: readonly string[], quebras: readonly boolean[]): VereditoDoPortao => {
    const veredito = julgarTrecho(tokensDoTrecho, quebras, oferecidos, vigiadas);
    if (veredito === "atende" || veredito === "nao") return veredito;
    // A contraparte e o capital barram ANTES do atalho do assunto: "entrada de investidor internacional" começa
    // por uma ação sobre internacionalização e pede o investidor.
    if (veredito === null && !soFamiliasDoPerfil && pedidoDeContraparteOuAutodescricao(tokensDoTrecho, oferecidos)) return "nao";
    const trecho = tokensDoTrecho.join(" ");
    if (servicosOferecidos.some(oferta => necessidadeDeclaraOAssuntoDoServico(oferta, null, trecho))) return "atende";
    if (soFamiliasDoPerfil) return "neutro";
    return assuntoQueNenhumServicoPresta(tokensDoTrecho, servicosOferecidos) ? "nao" : "neutro";
  };
  const citadas = tokensDoTermo(semEHifen(citacao)).filter(ehConteudo);
  const { tokens, quebraAntes, fimAntes } = tokensDoTexto(fonte);
  const janelas = janelasDaCitacao(citadas, tokens);
  let candidatas = janelas;
  if (!candidatas.length) {
    // Citação que não aparece em ordem na fonte: julga o serviço citado ONDE ele aparece
    // ("Startup jurídica | Precisamos de consultoria em marketing" citada como "consultoria jurídica").
    const daCitacao = tokensDoTermo(semEHifen(citacao));
    const servicosCitados = new Set(daCitacao.filter((_, k) => nomeiaServicoEm(daCitacao, k)));
    candidatas = tokens.flatMap((palavra, k): Array<[number, number]> => {
      if (!servicosCitados.has(palavra)) return [];
      let comeco = k;
      while (comeco > 0 && !fimAntes[comeco] && qualificaAntes(tokens[comeco - 1])) comeco -= 1;
      return [[comeco, k]];
    });
    // Nem o serviço citado está na fonte: a citação não é da pessoa. Até 15/09 o portão julgava aqui a frase do
    // MODELO, e "revisar tributos" montada de duas frases declarava o assunto tributário (item 2 da lista do
    // Nicolas na #135). Reprova sem julgar.
    if (!candidatas.length) return false;
  }
  return candidatas.some(([inicio, fim]) => {
    let ate = fim;
    const terminaEmServico = [fim, fim - 1, fim - 2].some(k => k >= inicio && (nomeiaServicoEm(tokens, k) || ADJETIVOS_DE_SERVICO.has(tokens[k])));
    if (terminaEmServico) {
      let conteudo = 0;
      for (let k = fim + 1; k < tokens.length && !fimAntes[k]; k += 1) {
        if (quebraAntes[k] && abreOutroServico(tokens, k)) break;
        // Conjunção que abre outro serviço ou outra oração ("e BUSCAMOS parceiros") e pronome relativo encerram o pedido.
        if (CONJUNCOES.has(tokens[k]) && (abreOutroServico(tokens, k + 1) || ehMarcaDePedido(tokens[k + 1] ?? ""))) break;
        if (ABRE_ORACAO.has(tokens[k])) break;
        if (ehConteudo(tokens[k]) && ++conteudo > 6) break;
        ate = k;
      }
    }
    return julgar(tokens.slice(inicio, ate + 1), quebraAntes.slice(inicio, ate + 1)) !== "nao";
  });
}

// ─── O ASSUNTO do serviço: a necessidade que o declara sem nomear o serviço ──
//
// Exemplo 4 e os dois de correspondência semântica da spec da Glenda (14/09):
// "Apoio para estruturar a entrada da minha empresa no Paraguai" é demanda
// expressa de "Consultoria em internacionalização de empresas"; "Precisamos
// revisar nossos tributos e identificar créditos fiscais", de "Advocacia
// tributária"; "suporte para obter autorização regulatória para comercializar
// nosso medicamento", de "Consultoria para registro de medicamentos". Nenhuma
// nomeia a família do serviço, e a regra ESTRITA acima só afirma o que entende
// — os motores determinísticos davam zero e só a IA casava.
//
// A ponte é um vocabulário CURADO de assunto, com três travas, todas sobre o
// que a necessidade DECLARA (nunca sobre quem a escreveu):
//   1. ela pede AJUDA ou uma AÇÃO: a cabeça do pedido (depois de "precisamos",
//      "busca"...) é apoio, suporte, assessoria, consultoria, uma atividade
//      curada (revisar, recuperar, obter, estruturar, entrar...) ou o próprio
//      serviço oferecido. "Distribuidor para expansão na África", "Investidor
//      para ampliação da fábrica" e "Créditos tributários" pedem a contraparte
//      ou o capital, não o serviço — e o resto do pedido também não pode pedi-los
//      ("ENTRADA de investidor internacional", "OBTER capital", `pedidoForaDaCabeca`),
//      nem registrar marca ou patente (`registraPropriedadeIntelectual`);
//   2. ela não nomeia OUTRO serviço: "Contador para revisar tributos" pediu
//      contador, "Suporte técnico", técnico, "Consultoria financeira para
//      exportação", finanças — a regra estrita decide esses;
//   3. ela nomeia um assunto que o SERVIÇO OFERECIDO também nomeia, numa
//      família que presta esse assunto ("Marketing para exportação" não é
//      consultoria de internacionalização).
// Setor, porte, localização, cargo e atividade da empresa não passam por
// nenhuma das três: "Indústria com alta carga tributária" e "Empresa
// brasileira com operações internacionais" descrevem quem escreveu.
//
// Palavra fora das listas não vira assunto, e na dúvida não casa, como no resto
// deste arquivo. Ampliar é acrescentar entrada COM o teste negativo dela
// (server/demanda-expressa-exemplos-da-spec.test.ts).

type AssuntoDoServico = "tributario" | "internacionalizacao" | "regulatorio-sanitario";

/** As famílias que prestam cada assunto. */
const FAMILIAS_DO_ASSUNTO: Readonly<Record<AssuntoDoServico, ReadonlySet<string>>> = {
  tributario: new Set(["advocacia", "contabilidade", "consultoria", "assessoria"]),
  internacionalizacao: new Set(["consultoria", "assessoria", "mentoria", "advocacia"]),
  "regulatorio-sanitario": new Set(["consultoria", "assessoria", "advocacia"]),
};

/** O que a especialidade de um apoio pedido pode ter sem nomear outro serviço: "assessoria TRIBUTÁRIA", "consultoria INTERNACIONAL". */
const ESPECIALIDADES_DO_ASSUNTO: Readonly<Record<AssuntoDoServico, ReadonlySet<string>>> = {
  tributario: new Set(["tributario"]),
  internacionalizacao: new Set(["internacional"]),
  "regulatorio-sanitario": new Set(),
};

/**
 * Áreas curadas que, nomeadas na necessidade, dizem que ela é OUTRO trabalho: "Revisão de CONTRATOS de exportação"
 * é contratual, não internacionalização; "Planejamento tributário e TRABALHISTA" pede também o que a advocacia
 * tributária não disse prestar. Só valem as que o serviço oferecido também nomeia.
 */
const AREAS_QUE_SEPARAM = new Set([
  "tributario", "trabalhista", "societario", "previdenciario", "criminal", "civil", "imobiliario", "ambiental", "familia",
  "imigracao", "financeiro", "contratual", "juramentado",
]);

/** Cabeça de quem pede AJUDA. "suporte", "assessoria" e "consultoria" também são família de apoio (FAMILIAS_DE_APOIO). */
const PEDE_AJUDA = new Set([
  "apoio", "ajuda", "auxilio", "orientacao", "acompanhamento", "suporte", "assistencia", "assessoria", "consultoria",
  "help", "support", "guidance", "assistance", "advice", "consulting", "advisory",
  "ayuda", "apoyo", "asesoria", "asesoramiento", "orientacion",
]);

/**
 * Cabeça de quem pede uma AÇÃO que o serviço presta. Só verbo e substantivo de
 * ação: "exportar" e "exportação" ficam de fora de propósito — "Exportar café"
 * em "o que preciso" é o negócio de quem escreveu (quer compradores), não um
 * pedido de consultoria; "Apoio para exportar café" é.
 */
const ATIVIDADES_DO_PEDIDO = new Set([
  "revisar", "revisao", "identificar", "identificacao", "recuperar", "recuperacao", "compensar", "compensacao",
  "planejar", "planejamento", "reduzir", "reducao", "regularizar", "regularizacao", "adequar", "adequacao",
  "defender", "defesa", "contestar", "contestacao", "analisar", "analise", "diagnostico", "otimizar", "otimizacao",
  "estruturar", "estruturacao", "entrar", "entrada", "expandir", "expansao", "internacionalizar", "internacionalizacao",
  "abrir", "abertura", "instalar", "obter", "obtencao", "conseguir", "registrar", "registro", "aprovar", "aprovacao",
  "review", "recover", "recovery", "reduce", "planning", "structure", "enter", "entering", "entry", "expand", "expansion",
  "obtain", "register", "registration", "approval",
  "reducir", "planificar", "estructurar", "expansion", "obtener", "registrar",
]);

/** Quem pede de verdade: o pedido começa depois da PRIMEIRA destas ("Indústria farmacêutica BUSCA distribuidor"). */
const MARCAS_DE_PEDIDO = new Set([
  "procura", "procuro", "procurar", "procurando", "busca", "busco", "buscar", "buscando", "precisa", "preciso",
  "precisar", "precisando", "necessita", "necessito", "necessitar", "quer", "quero",
  "precisamos", "buscamos", "procuramos", "queremos", "necessitamos", "desejamos", "gostariamos", "contratar", "contratamos",
  "requer", "requerem", "solicita", "solicitam", "exige", "exigem",
  "needs", "need", "wants", "want", "looking", "seeking", "seeks", "seek", "requires", "require", "hiring",
  "necesita", "necesito", "necesitamos", "necesitan", "quiere", "quiero", "buscan", "requiere", "requieren",
]);
/** Saem da frente do pedido, depois da marca: "precisamos DE UM", "looking FOR", "we need TO". */
const SAI_DA_FRENTE_DO_PEDIDO = new Set(["for", "to", "with", "por"]);

/** A cabeça do pedido e se houve marca de pedido antes dela. */
function cabecaDoPedido(palavras: readonly string[]): { indice: number; comMarca: boolean } {
  const marca = palavras.findIndex(palavra => MARCAS_DE_PEDIDO.has(palavra));
  let indice = marca + 1;
  while (indice < palavras.length && (MARCADORES_FRACOS.has(palavras[indice]) || VERBOS_DE_NECESSIDADE.has(palavras[indice])
    || ARTIGOS.has(palavras[indice]) || GENITIVOS.has(palavras[indice]) || PALAVRAS_SEM_ESPECIALIDADE.has(palavras[indice])
    || SAI_DA_FRENTE_DO_PEDIDO.has(palavras[indice]) || MARCAS_DE_PEDIDO.has(palavras[indice]))) indice += 1;
  return { indice, comMarca: marca >= 0 };
}

// ─── O que o pedido pede FORA da cabeça ──────────────────────────────────────
// A trava 1 lê só a cabeça: "ENTRADA de investidor internacional", "OBTER capital para registro de medicamentos"
// e "EXPANDIR para a África via distribuidores" começam por uma ação e pedem a contraparte ou o capital
// (achado da revisão de 14/09: bastava trocar a ordem das palavras do exemplo 3 da spec para casar). O que conta
// é a palavra que REGE a contraparte, o capital ou a coisa — nunca a palavra solta: "planejamento tributário PARA
// investidores" pede o serviço para eles, "recuperação de créditos" é do fisco, "levar a marca a Portugal" é
// internacionalização.

/** O sócio também é contraparte, e não é papel de comércio (a logística nunca o atende). */
const SOCIOS = new Set(["socio", "socios", "socia", "socias"]);
/** Ações de quem quer TER a coisa: "OBTER capital", "CAPTAR investidores", "CONSEGUIR galpão". */
const ACOES_DE_OBTER = new Set([
  "obter", "obtencao", "conseguir", "captar", "captacao", "atrair", "atracao", "levantar", "levantamento", "encontrar",
  "achar", "receber", "trazer", "obtain", "obtaining", "raise", "raising", "attract", "attracting", "find", "finding",
  "get", "obtener", "atraer", "recibir",
]);
/** A entrada DE alguém ou de dinheiro na empresa: "ENTRADA de investidor", "INGRESSO de sócio", "entrada de capital". */
const ENTRADA_NA_EMPRESA = new Set(["entrada", "entrar", "ingresso", "ingressar", "entry", "enter", "entering", "ingreso"]);
/** O canal por onde se chega ao mercado: "VIA distribuidores", "COM compradores", "POR MEIO de importadores". */
const PELO_CANAL = new Set(["com", "via", "atraves", "mediante", "meio", "medio", "with", "through", "con"]);
/** Saem entre a palavra e quem a rege: "obter NOVOS investidores", "entrada DE UM sócio", "captar NOSSO capital". */
const ENTRE_REGENTE_E_OBJETO = new Set([
  ...Array.from(ARTIGOS), ...Array.from(GENITIVOS), "del",
  "nosso", "nossa", "nossos", "nossas", "meu", "minha", "meus", "minhas", "seu", "sua", "seus", "suas",
  "algum", "alguma", "alguns", "algumas", "novo", "nova", "novos", "novas", "mais", "bom", "boa", "bons", "boas",
  "potencial", "potenciais", "possiveis", "our", "my", "new", "more", "potential", "some",
  "nuestro", "nuestra", "nuestros", "nuestras", "nuevo", "nueva", "nuevos", "nuevas",
]);

/** A palavra que rege a de `k`, pulando artigo, genitivo, possessivo e quantificador; e onde ela está. */
function regenteDe(palavras: readonly string[], k: number): { palavra: string; indice: number } {
  let indice = k - 1;
  while (indice >= 0 && ENTRE_REGENTE_E_OBJETO.has(palavras[indice])) indice -= 1;
  return { palavra: palavras[indice] ?? "", indice };
}

/**
 * As palavras que o pedido PEDE e serviço nenhum entrega, fora da cabeça:
 *   - a contraparte (papel de comércio ou sócio) regida por ação de obter, pela entrada na empresa, pelo canal ou
 *     por outra marca de pedido ("e BUSCA distribuidores");
 *   - o capital (investimento, crédito, financiamento) regido por ação de obter ou pela entrada na empresa, salvo
 *     o crédito do fisco ("obter créditos DE ICMS", "levantamento de créditos FISCAIS");
 *   - o produto e o imóvel regidos por ação de obter ("CONSEGUIR galpão"; "entrada de produtos no mercado europeu"
 *     é internacionalização).
 * Coordenada ("para investidores estrangeiros E sócios") herda a leitura do item anterior; sem item anterior perto,
 * a contraparte coordenada é outro item pedido ("expansão internacional E distribuidores").
 */
function pedidoForaDaCabeca(palavras: readonly string[]): string[] {
  const pedidas: string[] = [];
  let anterior: { indice: number; conta: boolean } | null = null;
  palavras.forEach((palavra, k) => {
    const contraparte = PAPEIS_DE_COMERCIO.has(palavra) || SOCIOS.has(palavra);
    const tipo = TIPO_POR_CABECA.get(palavra);
    const capital = !contraparte && tipo === "investimento";
    const coisa = tipo === "produto" || tipo === "imovel" || imovelNaCabecaDoPedido(palavras, k);
    if (!contraparte && !capital && !coisa) return;
    const regente = regenteDe(palavras, k);
    let conta: boolean;
    if (CONJUNCOES.has(regente.palavra)) {
      conta = anterior !== null && k - anterior.indice <= 4 ? anterior.conta : contraparte;
    } else {
      conta = ACOES_DE_OBTER.has(regente.palavra)
        || (!coisa && ENTRADA_NA_EMPRESA.has(regente.palavra))
        || (contraparte && (PELO_CANAL.has(regente.palavra) || MARCAS_DE_PEDIDO.has(regente.palavra)));
    }
    if (conta && capital) {
      // O crédito do fisco é o assunto tributário, não dinheiro que se pede.
      let seguinte = k + 1;
      while (seguinte < palavras.length && GENITIVOS.has(palavras[seguinte])) seguinte += 1;
      const doFisco = (palavra: string | undefined) => !!palavra && (lemaCurado(palavra) === "tributario" || palavra === "fisco");
      if (doFisco(palavras[seguinte])) conta = false;
    }
    anterior = { indice: k, conta };
    if (conta) pedidas.push(palavra);
  });
  return pedidas;
}

/** Marca e patente são propriedade intelectual: registrá-las não é vigilância sanitária, nem o INPI é agência sanitária. */
const MARCA_OU_PATENTE = new Set(["marca", "marcas", "trademark", "trademarks", "patente", "patentes", "patent", "patents"]);
const ESCRITORIOS_DE_PROPRIEDADE_INTELECTUAL = new Set(["inpi", "uspto", "euipo", "wipo", "ompi"]);
/** "REGISTRAR marca de cosméticos no INPI", "Registro da nossa marca": o ato regulatório rege a marca, não o cosmético. */
function registraPropriedadeIntelectual(palavras: readonly string[]): boolean {
  return palavras.some((palavra, k) => ESCRITORIOS_DE_PROPRIEDADE_INTELECTUAL.has(palavra)
    || (MARCA_OU_PATENTE.has(palavra) && ATOS_REGULATORIOS.has(regenteDe(palavras, k).palavra)));
}

// Assunto TRIBUTÁRIO: os lemas curados de especialidade (tributo, fiscal, imposto, ICMS, tax...) e "fisco".
/** "fiscal" que não é tributo: "nota fiscal", "cupom fiscal", "conselho fiscal", "ano fiscal", "paraíso fiscal". */
const FISCAL_DE_OUTRA_COISA = new Set([
  "nota", "notas", "cupom", "cupons", "conselho", "conselhos", "ano", "exercicio", "documento", "documentos",
  "recibo", "recibos", "paraiso", "paraisos", "periodo", "impressora", "impressoras", "emissor", "emissores",
]);
const FISCAL = new Set(["fiscal", "fiscais"]);

// Assunto INTERNACIONALIZAÇÃO.
/** Nomeiam o assunto sozinhos. "exportar" aqui é ASSUNTO (depois da cabeça), nunca cabeça — ver ATIVIDADES_DO_PEDIDO. */
const INTERNACIONALIZACAO = new Set([
  "internacionalizacao", "internacionalizar", "internacionalizando", "internacionalizacion", "internationalization",
  "internationalisation", "internationalize", "internationalise", "exportacao", "exportacoes", "exportar", "exportando",
  "exportacion", "exportaciones", "export", "exporting", "comex",
]);
/** Movimento que só é internacionalização com destino fora: "expansão INTERNACIONAL", "entrada NO PARAGUAI", "mercado EXTERNO". */
const MOVIMENTO_PARA_FORA = new Set([
  "entrada", "entrar", "ingresso", "ingressar", "expansao", "expandir", "abrir", "abertura", "instalar", "estabelecer",
  "levar", "mercado", "mercados", "comercio", "entry", "enter", "entering", "expansion", "expand", "market", "markets",
]);
const PARA_FORA = new Set(["internacional", "internacionais", "exterior", "externo", "externos", "externa", "externas", "international", "abroad", "overseas", "extranjero"]);
const LOCATIVOS = new Set(["em", "no", "na", "nos", "nas", "para", "pro", "pra", "ao", "aos", "in", "into", "en", "al"]);
/**
 * Lugares que não são outro país: o Brasil (a plataforma é brasileira — "expansão para vender no Brasil" é
 * crescer em casa), os estados e as regiões. Os demais lugares de direcao-do-termo.ts contam.
 */
const LUGARES_DE_DENTRO = new Set([
  "brasil", "brazil", "brasileiro", "brasileira", "brasileiros", "brasileiras",
  "sul", "norte", "leste", "oeste", "ocidente", "oriente", "south", "north", "east", "west", "sur", "nordeste", "amazonia",
  "bahia", "ceara", "pernambuco", "amazonas", "parana", "goias", "tocantins", "rondonia", "roraima", "acre", "amapa",
  "maranhao", "piaui", "alagoas", "sergipe", "paraiba", "sao paulo", "rio de janeiro", "minas gerais", "rio grande do sul",
  "rio grande do norte", "mato grosso", "mato grosso do sul", "santa catarina", "espirito santo", "distrito federal",
]);

/** O movimento em `k` vai para FORA? Destino a até sete palavras, sem atravessar outra ação nem conjunção. */
function vaiParaFora(palavras: readonly string[], k: number): boolean {
  let locativo = false;
  for (let j = k + 1; j < Math.min(palavras.length, k + 8); j += 1) {
    const palavra = palavras[j];
    if (PARA_FORA.has(palavra)) return true;
    if (CONJUNCOES.has(palavra) || (ATIVIDADES_DO_PEDIDO.has(palavra) && !MOVIMENTO_PARA_FORA.has(palavra))) return false;
    if (LOCATIVOS.has(palavra)) {
      locativo = true;
      continue;
    }
    // "levar a marca A Portugal": o "a" é artigo em quase todo lugar, e só é locativo colado ao destino.
    if (!locativo && palavras[j - 1] !== "a") continue;
    for (let n = 3; n >= 1; n -= 1) {
      const lugar = palavras.slice(j, j + n);
      if (lugar.length === n && ehLugar(lugar) && !LUGARES_DE_DENTRO.has(lugar.join(" "))) return true;
    }
  }
  return false;
}

// Assunto REGULATÓRIO SANITÁRIO: registro ou autorização de produto sob vigilância sanitária.
/** Agências sanitárias nomeiam o assunto sozinhas ("ema" e "isp" ficam de fora: são palavra comum). */
const AGENCIAS_SANITARIAS = new Set(["anvisa", "fda", "anmat", "cofepris", "invima", "digemid"]);
/** O ato regulatório — só é o assunto junto de um objeto sanitário: "Registro de marca" não é, "Autorização da Anatel" não é. */
const ATOS_REGULATORIOS = new Set([
  "regulatorio", "regulatoria", "regulatorios", "regulatorias", "regulatory", "regulacao", "sanitario", "sanitaria",
  "sanitarios", "sanitarias", "registro", "registros", "registrar", "registration", "autorizacao", "autorizacoes",
  "authorization", "aprovacao", "approval", "licenca", "licencas", "notificacao", "habilitacao",
]);
const OBJETOS_SANITARIOS = new Set([
  "medicamento", "medicamentos", "farmaco", "farmacos", "farmaceutico", "farmaceutica", "farmaceuticos", "farmaceuticas",
  "cosmetico", "cosmeticos", "saneante", "saneantes", "suplemento", "suplementos", "fitoterapico", "fitoterapicos",
  "vacina", "vacinas", "drug", "drugs", "pharmaceutical", "pharmaceuticals", "cosmetics", "medicine", "medicines",
]);

/** Os assuntos que um texto nomeia, pelas listas acima. */
function assuntosDoTexto(palavras: readonly string[]): Set<AssuntoDoServico> {
  const assuntos = new Set<AssuntoDoServico>();
  palavras.forEach((palavra, k) => {
    const tributo = lemaCurado(palavra) === "tributario" || palavra === "fisco";
    if (tributo && !(FISCAL.has(palavra) && FISCAL_DE_OUTRA_COISA.has(palavras[k - 1] ?? ""))) assuntos.add("tributario");
    if (INTERNACIONALIZACAO.has(palavra) || (MOVIMENTO_PARA_FORA.has(palavra) && vaiParaFora(palavras, k))) assuntos.add("internacionalizacao");
    if (AGENCIAS_SANITARIAS.has(palavra)) assuntos.add("regulatorio-sanitario");
  });
  if (palavras.some(palavra => ATOS_REGULATORIOS.has(palavra)) && palavras.some(palavra => OBJETOS_SANITARIOS.has(palavra))) {
    assuntos.add("regulatorio-sanitario");
  }
  return assuntos;
}

/** A família de serviço que a palavra em `k` nomeia no pedido ("CONTADOR", "direito TRIBUTÁRIO", "apoio JURÍDICO"), ou null. */
function familiaNomeadaEm(palavras: readonly string[], k: number): string | null {
  const palavra = palavras[k];
  if (ehSubstantivoDeServico(palavra)) return familiaDaPalavra(palavra);
  if (areaDoDireito(palavras as string[], k)) return "advocacia";
  const anterior = palavras[k - 1] ?? "";
  if (ADJETIVOS_DE_SERVICO.has(palavra) && (PEDE_AJUDA.has(anterior) || CABECAS_NEUTRAS.has(anterior))) return familiaDaPalavra(palavra);
  return null;
}

/**
 * A necessidade DECLARA o assunto do serviço oferecido, sem nomear o serviço? A
 * equivalência semântica que a spec da Glenda permite, pelo vocabulário curado
 * acima e com as três travas descritas no topo da seção. No motor privado vale
 * 60 com o selo de significados parecidos; no de perfis é base expressa; no
 * portão da IA, a citação que declara o assunto passa.
 */
export function necessidadeDeclaraOAssuntoDoServico(oferta: string, categoriaDaOferta: string | null | undefined, necessidade: string): boolean {
  if (classificarOferta(oferta, categoriaDaOferta) !== "servico") return false;
  // O que a oferta presta: cada serviço coordenado com a sua família e os assuntos que ele mesmo nomeia.
  const oferecidos = partesDoServico(oferta).flatMap(parte => {
    const familia = entenderServico(parte)?.familia;
    if (!familia) return [];
    const palavrasDaParte = palavrasDe(parte);
    const assuntos = Array.from(assuntosDoTexto(palavrasDaParte)).filter(assunto => FAMILIAS_DO_ASSUNTO[assunto].has(familia));
    const areas = new Set(palavrasDaParte.map(palavra => lemaCurado(palavra) ?? "").filter(lema => AREAS_QUE_SEPARAM.has(lema)));
    return assuntos.length ? [{ familia, assuntos, areas }] : [];
  });
  if (!oferecidos.length) return false;

  const palavras = palavrasDe(necessidade);
  const { indice } = cabecaDoPedido(palavras);
  const cabeca = palavras[indice];
  if (!cabeca) return false;
  const pedido = palavras.slice(indice);
  const assuntosPedidos = assuntosDoTexto(pedido);
  if (!assuntosPedidos.size) return false;
  // A cabeça pede uma ação, e o resto do pedido pede a contraparte, o capital ou o registro de marca
  // ("Entrada de investidor internacional na empresa", "Obter capital para registro de medicamentos").
  if (pedidoForaDaCabeca(pedido).length || registraPropriedadeIntelectual(pedido)) return false;

  const areasPedidas = pedido.map(palavra => lemaCurado(palavra) ?? "").filter(lema => AREAS_QUE_SEPARAM.has(lema));

  return oferecidos.some(({ familia, assuntos, areas }) => {
    // 1. Pede ajuda, uma ação, ou o próprio serviço oferecido ("Advogado para revisar nossos tributos").
    const cabecaPede = PEDE_AJUDA.has(cabeca) || ATIVIDADES_DO_PEDIDO.has(cabeca) || familiaNomeadaEm(pedido, 0) === familia;
    if (!cabecaPede) return false;
    // 2. Não nomeia outro serviço — nem pelo substantivo, nem pela especialidade de um apoio pedido.
    if (pedido.some((_, k) => {
      const nomeada = familiaNomeadaEm(pedido, k);
      return nomeada !== null && nomeada !== familia && !FAMILIAS_DE_APOIO.has(nomeada);
    })) return false;
    const apoios = servicosDoRotulo(pedido.join(" ")).filter(servico => FAMILIAS_DE_APOIO.has(servico.familia));
    // 3. Um assunto em comum, sem área curada que a oferta não nomeia, e o apoio pedido só especifica esse assunto.
    return assuntos.some(assunto => assuntosPedidos.has(assunto)
      && areasPedidas.every(area => areas.has(area) || ESPECIALIDADES_DO_ASSUNTO[assunto].has(area))
      && apoios.every(apoio => apoio.especialidades.every(especialidade =>
      !naoAconselha(especialidade, ASSESSORIAS_QUE_NAO_ACONSELHAM)
      && Array.from(especialidade.conhecidos).every(lema => lema === familia || ESPECIALIDADES_DO_ASSUNTO[assunto].has(lema)))));
  });
}

/**
 * Contraparte comercial: quem tem a mercadoria, o canal ou o capital. Serviço nenhum a entrega — nem a
 * consultoria "em distribuição" entrega o distribuidor. Também lida pelo portão da IA no sentido oposto
 * (server/portao-da-demanda-expressa.ts, `perfilDeclarouPrecisarDoServico`).
 */
export const PAPEIS_DE_COMERCIO: ReadonlySet<string> = new Set([
  "distribuidor", "distribuidora", "distribuidores", "distribuidoras", "fornecedor", "fornecedora", "fornecedores", "fornecedoras",
  "comprador", "compradora", "compradores", "compradoras", "importador", "importadora", "importadores", "importadoras",
  "exportador", "exportadora", "exportadores", "exportadoras", "revendedor", "revendedora", "revendedores", "revendedoras",
  "investidor", "investidora", "investidores", "investidoras",
  "distributor", "distributors", "supplier", "suppliers", "buyer", "buyers", "importer", "importers", "exporter", "exporters",
  "reseller", "resellers", "investor", "investors", "proveedor", "proveedores", "inversor", "inversores",
]);
/**
 * A contraparte (`PAPEIS_DE_COMERCIO` e `SOCIOS`) em lema, a forma em que ela chega às especialidades da leitura do
 * serviço: "Preciso de consultoria de DISTRIBUIDOR" e "Procuro advogado de INVESTIDOR" não abrem a nota da família
 * pelo complemento desconhecido (`nomeiaContraparte`, decisão do Roberto de 16/09), pela mesma lista do portão.
 */
const CONTRAPARTE_EM_LEMA: ReadonlySet<string> = new Set([...Array.from(PAPEIS_DE_COMERCIO), ...Array.from(SOCIOS)].map(lemaDaEspecialidade));
/** Distribuidor e fornecedor são o que a logística atende (decisão de 14/09; HAVE_SATISFIES_NEED em server/matching.ts). */
const PAPEIS_QUE_A_LOGISTICA_ATENDE = new Set([
  "distribuidor", "distribuidora", "distribuidores", "distribuidoras", "fornecedor", "fornecedora", "fornecedores", "fornecedoras",
  "distributor", "distributors", "supplier", "suppliers", "proveedor", "proveedores",
]);
const FAMILIAS_DA_LOGISTICA = new Set(["logistica", "transporte", "frete", "armazenagem"]);
/** Quem se descreve, sem pedir nada: "INDÚSTRIA farmacêutica", "EMPRESA brasileira com operações internacionais". */
const QUEM_SE_DESCREVE = new Set([
  "empresa", "empresas", "companhia", "companhias", "industria", "industrias", "fabrica", "fabricas", "startup", "startups",
  "cooperativa", "cooperativas", "organizacao", "organizacoes", "grupo", "grupos", "negocio", "negocios",
  "company", "companies", "industry", "industries", "business", "businesses", "compania", "companias",
]);
/** Os tipos que serviço nenhum entrega, lidos na cabeça do pedido: "CAPITAL de giro", "GALPÃO em Santos", "MERCADORIA". */
const TIPOS_QUE_O_SERVICO_NAO_ENTREGA = new Set<TipoDaOferta>(["produto", "investimento", "imovel"]);

// ─── Imóvel no que se PEDE ───────────────────────────────────────────────────
// A lista IMOVEL é curta porque classifica a OFERTA: ali sobrar palavra tira o item do portão e o par volta a casar
// por categoria (d7fac93 da #124). Do lado do PEDIDO a conta é a oposta — faltar palavra solta o portão. Com casa,
// sala, loja, vaga e flat fora de IMOVEL, "loja de rua no centro" citada pela IA e a demanda "Sala comercial de 40 m²
// no centro" passavam como pedido de "Consultoria jurídica", e a oportunidade que OFERECE serviço voltava a ir para
// quem só pediu imóvel; na #135 antes do porte eram barradas (medição do cético, 15/09). Então o pedido tem a sua
// leitura, só na cabeça e só no sentido de imóvel: "Casa de câmbio", "Casa de software", "Casa de consultoria",
// "Loja virtual", "Flat fee", "Sala de reunião" e "Vaga de emprego" não são.

/** Cabeças que, pedidas, são o imóvel — salvo o que vem logo depois dizer outra coisa (NAO_E_O_IMOVEL, serviço, outro tipo). */
const IMOVEL_NA_CABECA_DO_PEDIDO = new Set(["casa", "casas", "loja", "lojas", "flat", "flats"]);
/** "Sala" só é o imóvel como sala comercial; "vaga", só a de garagem. */
const SALAS = new Set(["sala", "salas"]);
const COMERCIAL = new Set(["comercial", "comerciais"]);
const VAGAS = new Set(["vaga", "vagas"]);
const DE_GARAGEM = new Set(["garagem", "garagens", "estacionamento", "estacionamentos"]);
const NAO_E_O_IMOVEL = new Set(["cambio", "virtual", "virtuais", "online", "digital", "digitais", "fee", "fees", "rate", "rates", "tax", "apostas"]);

/** A palavra em `indice` é a cabeça de um pedido de imóvel? A de IMOVEL, e as da leitura do pedido acima. */
function imovelNaCabecaDoPedido(palavras: readonly string[], indice: number): boolean {
  const cabeca = palavras[indice] ?? "";
  if (TIPO_POR_CABECA.get(cabeca) === "imovel") return true;
  let depois = indice + 1;
  while (GENITIVOS.has(palavras[depois] ?? "") || ARTIGOS.has(palavras[depois] ?? "")) depois += 1;
  const seguinte = palavras[depois];
  if (SALAS.has(cabeca)) return COMERCIAL.has(palavras[indice + 1] ?? "");
  if (VAGAS.has(cabeca)) return depois > indice + 1 && DE_GARAGEM.has(seguinte ?? "");
  if (!IMOVEL_NA_CABECA_DO_PEDIDO.has(cabeca)) return false;
  if (seguinte === undefined) return true;
  const outroTipo = tipoNaoServico(seguinte);
  return !NAO_E_O_IMOVEL.has(seguinte) && !ehPalavraDeServico(seguinte) && areaDoDireito(palavras as string[], depois) === null
    && (outroTipo === null || outroTipo === "imovel");
}

/**
 * A necessidade PEDE um imóvel ("Loja de rua no centro de Campinas", "Preciso de uma sala comercial", "Vaga de garagem
 * perto do escritório")? É o que o portão da IA lê para dizer que um serviço não a atende
 * (server/portao-da-demanda-expressa.ts, `perfilDeclarouPrecisarDoServico`).
 */
export function necessidadePedeImovel(necessidade: string): boolean {
  const palavras = palavrasDe(necessidade);
  return imovelNaCabecaDoPedido(palavras, cabecaDoPedido(palavras).indice);
}

/**
 * O trecho PEDE ajuda ou ação sobre um assunto do vocabulário curado, e nenhum serviço oferecido tem relação
 * com esse assunto? "Relação" é nomear o assunto, ou ter especialidade reconhecida que o presta (a família ou
 * a especialidade de `FAMILIAS_DO_ASSUNTO` e `ESPECIALIDADES_DO_ASSUNTO`). Serviço sem nada reconhecido
 * ("Consultoria", "Consultoria em gestão") não se sabe: fica com o modelo, e o trecho passa.
 */
function assuntoQueNenhumServicoPresta(palavras: readonly string[], servicosOferecidos: readonly string[]): boolean {
  const { indice } = cabecaDoPedido(palavras);
  const cabeca = palavras[indice] ?? "";
  if (!PEDE_AJUDA.has(cabeca) && !ATIVIDADES_DO_PEDIDO.has(cabeca)) return false;
  const pedidos = Array.from(assuntosDoTexto(palavras.slice(indice)));
  if (!pedidos.length) return false;
  return servicosOferecidos.every(oferta => {
    const assuntos = assuntosDoTexto(palavrasDe(oferta));
    const conhecidos = servicosDoRotulo(oferta).flatMap(servico => servico.especialidades.flatMap(especialidade => Array.from(especialidade.conhecidos)));
    if (assuntos.size === 0 && conhecidos.length === 0) return false;
    return !pedidos.some(assunto => assuntos.has(assunto)
      || conhecidos.some(lema => ESPECIALIDADES_DO_ASSUNTO[assunto].has(lema) || FAMILIAS_DO_ASSUNTO[assunto].has(lema)));
  });
}

/**
 * O trecho (sem serviço nomeado) pede uma CONTRAPARTE, capital, produto ou imóvel, ou só DESCREVE quem
 * escreveu? É o que o portão da IA barra quando o modelo cita esse trecho como a necessidade de um serviço.
 */
function pedidoDeContraparteOuAutodescricao(palavras: readonly string[], oferecidos: readonly ServicoNomeado[]): boolean {
  const { indice, comMarca } = cabecaDoPedido(palavras);
  const cabeca = palavras[indice];
  if (!cabeca) return false;
  if (PAPEIS_DE_COMERCIO.has(cabeca)) {
    return !(PAPEIS_QUE_A_LOGISTICA_ATENDE.has(cabeca) && oferecidos.some(oferecido => FAMILIAS_DA_LOGISTICA.has(oferecido.familia)));
  }
  if (!comMarca && QUEM_SE_DESCREVE.has(cabeca)) return true;
  const tipo = TIPO_POR_CABECA.get(cabeca);
  if (tipo !== undefined && TIPOS_QUE_O_SERVICO_NAO_ENTREGA.has(tipo)) return true;
  if (imovelNaCabecaDoPedido(palavras, indice)) return true;
  // A cabeça é uma ação sobre um assunto entendido, e o resto pede a contraparte ou o capital: "entrada de
  // investidor internacional", "expandir para a África via distribuidores". Sem assunto entendido, a ação sobre
  // outro objeto fica com o modelo ("revisar contratos com nossos distribuidores").
  const pedido = palavras.slice(indice);
  if (!assuntosDoTexto(pedido).size) return false;
  const logistica = oferecidos.some(oferecido => FAMILIAS_DA_LOGISTICA.has(oferecido.familia));
  return pedidoForaDaCabeca(pedido).some(palavra => !(logistica && PAPEIS_QUE_A_LOGISTICA_ATENDE.has(palavra)));
}
