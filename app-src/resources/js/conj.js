;
/* 离线西语词性识别 + 动词变位引擎
 * 数据源：
 *  - IRREG: 高频不规则动词变位表（覆盖 top ~60 不规则动词的关键形式）
 *  - 规则动词：三变位 (-ar/-er/-ir) 算法生成
 *  - 词性后缀启发式：-ción/-dad/-mente/-ismo 等名词、-oso/-ivo 形容词、-ar/-er/-ir 动词等
 */
const CONJ = (() => {

  /* ---------- 人称标签 ---------- */
  const P = ['yo', 'tú', 'él/ella', 'nosotros', 'vosotros', 'ellos/ellas'];

  /* ---------- 规则变位模板 ----------
   * 每个模板: { 结尾: 词干替换 }
   * 时态: pres(现在), pret(简单过去), imp(未完成过去), fut(将来), cond(条件), presSub(虚拟现在)
   */
  function stem(inf, drop) { return inf.slice(0, -drop.length); }

  const REGULAR = {
    ar: {
      pres:      ['o','as','a','amos','áis','an'],
      pret:      ['é','aste','ó','amos','asteis','aron'],
      imp:       ['aba','abas','aba','ábamos','abais','aban'],
      fut:       ['é','ás','á','emos','éis','án'],   // 接无限动词词尾
      cond:      ['ía','ías','ía','íamos','íais','ían'],
      presSub:   ['e','es','e','emos','éis','en'],
      impSub:    ['ara','aras','ara','áramos','arais','aran'],
    },
    er: {
      pres:      ['o','es','e','emos','éis','en'],
      pret:      ['í','iste','ió','imos','isteis','ieron'],
      imp:       ['ía','ías','ía','íamos','íais','ían'],
      fut:       ['é','ás','á','emos','éis','án'],
      cond:      ['ía','ías','ía','íamos','íais','ían'],
      presSub:   ['a','as','a','amos','áis','an'],
      impSub:    ['iera','ieras','iera','iéramos','ierais','ieran'],
    },
    ir: {
      pres:      ['o','es','e','imos','ís','en'],
      pret:      ['í','iste','ió','imos','isteis','ieron'],
      imp:       ['ía','ías','ía','íamos','íais','ían'],
      fut:       ['é','ás','á','emos','éis','án'],
      cond:      ['ía','ías','ía','íamos','íais','ían'],
      presSub:   ['a','as','a','amos','áis','an'],
      impSub:    ['iera','ieras','iera','iéramos','ierais','ieran'],
    },
  };

  const TENSE_NAMES = {
    pres: '陈述式现在', pret: '陈述式简单过去', imp: '陈述式未完成过去',
    fut: '陈述式将来', cond: '条件式', presSub: '虚拟式现在', impSub: '虚拟式未完成过去',
  };

  /* ---------- 高频不规则动词 ----------
   * value = 完整六人称形式数组，或 { _stem: 将来/条件词干, ...覆盖 } 形式
   * 只列与规则不同的形式；缺失的时态走规则引擎
   */
  const IRREG = {
    ser: {
      pres: ['soy','eres','es','somos','sois','son'],
      pret: ['fui','fuiste','fue','fuimos','fuisteis','fueron'],
      imp: ['era','eras','era','éramos','erais','eran'],
      presSub: ['sea','seas','sea','seamos','seáis','sean'],
      _stem: 'ser',
    },
    estar: {
      pres: ['estoy','estás','está','estamos','estáis','están'],
      pret: ['estuve','estuviste','estuvo','estuvimos','estuvisteis','estuvieron'],
      presSub: ['esté','estés','esté','estemos','estéis','estén'],
      _stem: 'estuv',
    },
    ir: {
      pres: ['voy','vas','va','vamos','vais','van'],
      pret: ['fui','fuiste','fue','fuimos','fuisteis','fueron'],
      imp: ['iba','ibas','iba','íbamos','ibais','iban'],
      presSub: ['vaya','vayas','vaya','vayamos','vayáis','vayan'],
      _stem: 'ir',
    },
    tener: {
      pres: ['tengo','tienes','tiene','tenemos','tenéis','tienen'],
      pret: ['tuve','tuviste','tuvo','tuvimos','tuvisteis','tuvieron'],
      presSub: ['tenga','tengas','tenga','tengamos','tengáis','tengan'],
      _stem: 'tendr',
    },
    hacer: {
      pres: ['hago','haces','hace','hacemos','hacéis','hacen'],
      pret: ['hice','hiciste','hizo','hicimos','hicisteis','hicieron'],
      presSub: ['haga','hagas','haga','hagamos','hagáis','hagan'],
      _stem: 'har',
    },
    poder: {
      pres: ['puedo','puedes','puede','podemos','podéis','pueden'],
      pret: ['pude','pudiste','pudo','pudimos','pudisteis','pudieron'],
      presSub: ['pueda','puedas','pueda','podamos','podáis','puedan'],
      _stem: 'podr',
    },
    decir: {
      pres: ['digo','dices','dice','decimos','decís','dicen'],
      pret: ['dije','dijiste','dijo','dijimos','dijisteis','dijeron'],
      presSub: ['diga','digas','diga','digamos','digáis','digan'],
      _stem: 'dir',
    },
    venir: {
      pres: ['vengo','vienes','viene','venimos','venís','vienen'],
      pret: ['vine','viniste','vino','vinimos','vinisteis','vinieron'],
      presSub: ['venga','vengas','venga','vengamos','vengáis','vengan'],
      _stem: 'vendr',
    },
    saber: {
      pres: ['sé','sabes','sabe','sabemos','sabéis','saben'],
      pret: ['supe','supiste','supo','supimos','supisteis','supieron'],
      presSub: ['sepa','sepas','sepa','sepamos','sepáis','sepan'],
      _stem: 'sabr',
    },
    querer: {
      pres: ['quiero','quieres','quiere','queremos','queréis','quieren'],
      pret: ['quise','quisiste','quiso','quisimos','quisisteis','quisieron'],
      presSub: ['quiera','quieras','quiera','queramos','queráis','quieran'],
      _stem: 'querr',
    },
    poner: {
      pres: ['pongo','pones','pone','ponemos','ponéis','ponen'],
      pret: ['puse','pusiste','puso','pusimos','pusisteis','pusieron'],
      presSub: ['ponga','pongas','ponga','pongamos','pongáis','pongan'],
      _stem: 'pondr',
    },
    dar: {
      pres: ['doy','das','da','damos','dais','dan'],
      pret: ['di','diste','dio','dimos','disteis','dieron'],
      presSub: ['dé','des','dé','demos','deis','den'],
    },
    ver: {
      pres: ['veo','ves','ve','vemos','veis','ven'],
      pret: ['vi','viste','vio','vimos','visteis','vieron'],
      imp: ['veía','veías','veía','veíamos','veíais','veían'],
      presSub: ['vea','veas','vea','veamos','veáis','vean'],
    },
    haber: {
      pres: ['he','has','ha','hemos','habéis','han'],
      pret: ['hube','hubiste','hubo','hubimos','hubisteis','hubieron'],
      presSub: ['haya','hayas','haya','hayamos','hayáis','hayan'],
      _stem: 'habr',
    },
    seguir: {
      pres: ['sigo','sigues','sigue','seguimos','seguís','siguen'],
      pret: ['seguí','seguiste','siguió','seguimos','seguisteis','siguieron'],
      presSub: ['siga','sigas','siga','sigamos','sigáis','sigan'],
    },
    encontrar: {
      pres: ['encuentro','encuentras','encuentra','encontramos','encontráis','encuentran'],
      presSub: ['encuentre','encuentres','encuentre','encontremos','encontréis','encuentren'],
    },
    recordar: {
      pres: ['recuerdo','recuerdas','recuerda','recordamos','recordáis','recuerdan'],
      presSub: ['recuerde','recuerdes','recuerde','recordemos','recordéis','recuerden'],
    },
    volver: {
      pres: ['vuelvo','vuelves','vuelve','volvemos','volvéis','vuelven'],
      presSub: ['vuelva','vuelvas','vuelva','volvamos','volváis','vuelvan'],
    },
    dormir: {
      pres: ['duermo','duermes','duerme','dormimos','dormís','duermen'],
      presSub: ['duerma','duermas','duerma','durmamos','durmáis','duerman'],
      pret: ['dormí','dormiste','durmió','dormimos','dormisteis','durmieron'],
    },
    morir: {
      pres: ['muero','mueres','muere','morimos','morís','mueren'],
      presSub: ['muera','mueras','muera','muramos','muráis','mueran'],
      pret: ['morí','moriste','murió','morimos','moristeis','murieron'],
    },
    pedir: {
      pres: ['pido','pides','pide','pedimos','pedís','piden'],
      pret: ['pedí','pediste','pidió','pedimos','pedisteis','pidieron'],
      presSub: ['pida','pidas','pida','pidamos','pidáis','pidan'],
    },
    sentir: {
      pres: ['siento','sientes','siente','sentimos','sentís','sienten'],
      pret: ['sentí','sentiste','sintió','sentimos','sentisteis','sintieron'],
      presSub: ['sienta','sientas','sienta','sintamos','sintáis','sientan'],
    },
    pensar: {
      pres: ['pienso','piensas','piensa','pensamos','pensáis','piensan'],
      presSub: ['piense','pienses','piense','pensemos','penséis','piensen'],
    },
    entender: {
      pres: ['entiendo','entiendes','entiende','entendemos','entendéis','entienden'],
      presSub: ['entienda','entiendas','entienda','entendamos','entendáis','entiendan'],
    },
    empezar: {
      pres: ['empiezo','empiezas','empieza','empezamos','empezáis','empiezan'],
      presSub: ['empiece','empieces','empiece','empecemos','empecéis','empiecen'],
      pret: ['empecé','empezaste','empezó','empezamos','empezasteis','empezaron'],
    },
    comenzar: {
      pres: ['comienzo','comienzas','comienza','comenzamos','comenzáis','comienzan'],
      presSub: ['comience','comiences','comience','comencemos','comencéis','comiencen'],
      pret: ['comencé','comenzaste','comenzó','comenzamos','comenzasteis','comenzaron'],
    },
    jugar: {
      pres: ['juego','juegas','juega','jugamos','jugáis','juegan'],
      presSub: ['juegue','juegues','juegue','juguemos','juguéis','jueguen'],
      pret: ['jugué','jugaste','jugó','jugamos','jugasteis','jugaron'],
    },
    contar: {
      pres: ['cuento','cuentas','cuenta','contamos','contáis','cuentan'],
      presSub: ['cuente','cuentes','cuente','contemos','contéis','cuenten'],
    },
    mostrar: {
      pres: ['muestro','muestras','muestra','mostramos','mostráis','muestran'],
      presSub: ['muestre','muestres','muestre','mostremos','mostréis','muestren'],
    },
    probar: {
      pres: ['pruebo','pruebas','prueba','probamos','probáis','prueban'],
      presSub: ['pruebe','pruebes','pruebe','probemos','probéis','prueben'],
    },
    mover: {
      pres: ['muevo','mueves','mueve','movemos','movéis','mueven'],
      presSub: ['mueva','muevas','mueva','movamos','mováis','muevan'],
    },
    costar: {
      pres: ['cuesto','cuestas','cuesta','costamos','costáis','cuestan'],
    },
    almorzar: {
      pres: ['almuerzo','almuerzas','almuerza','almorzamos','almorzáis','almuerzan'],
      pret: ['almorcé','almorzaste','almorzó','almorzamos','almorzasteis','almorzaron'],
    },
    llegar: {
      pret: ['llegué','llegaste','llegó','llegamos','llegasteis','llegaron'],
    },
    buscar: {
      pret: ['busqué','buscaste','buscó','buscamos','buscasteis','buscaron'],
    },
    tocar: {
      pret: ['toqué','tocaste','tocó','tocamos','tocasteis','tocaron'],
    },
    sacar: {
      pret: ['saqué','sacaste','sacó','sacamos','sacasteis','sacaron'],
    },
    explicar: {
      pret: ['expliqué','explicaste','explicó','explicamos','explicasteis','explicaron'],
    },
    practicar: {
      pret: ['practiqué','practicaste','practicó','practicamos','practicasteis','practicaron'],
    },
    organizarse: { _skip: true },
    leer: {
      pret: ['leí','leíste','leyó','leímos','leísteis','leyeron'],
      presSub: ['lea','leas','lea','leamos','leáis','lean'],
    },
    oir: {
      pres: ['oigo','oyes','oye','oímos','oís','oyen'],
      pret: ['oí','oíste','oyó','oímos','oísteis','oyeron'],
      presSub: ['oiga','oigas','oiga','oigamos','oigáis','oigan'],
    },
    caer: {
      pres: ['caigo','caes','cae','caemos','caéis','caen'],
      presSub: ['caiga','caigas','caiga','caigamos','caigáis','caigan'],
    },
    traer: {
      pres: ['traigo','traes','trae','traemos','traéis','traen'],
      pret: ['traje','trajiste','trajo','trajimos','trajisteis','trajeron'],
      presSub: ['traiga','traigas','traiga','traigamos','traigáis','traigan'],
      _stem: 'trar',
    },
    conocer: {
      pres: ['conozco','conoces','conoce','conocemos','conocéis','conocen'],
      pret: ['conocí','conociste','conoció','conocimos','conocisteis','conocieron'],
      presSub: ['conozca','conozcas','conozca','conozcamos','conozcáis','conozcan'],
    },
    conducir: {
      pres: ['conduzco','conduces','conduce','conducimos','conducís','conducen'],
      pret: ['conduje','condujiste','condujo','condujimos','condujisteis','condujeron'],
      presSub: ['conduzca','conduzcas','conduzca','conduzcamos','conduzcáis','conduzcan'],
    },
    producir: {
      pres: ['produzco','produces','produce','producimos','producís','producen'],
      pret: ['produje','produjiste','produjo','produjimos','produjisteis','produjeron'],
      presSub: ['produzca','produzcas','produzca','produzcamos','produzcáis','produzcan'],
    },
    traducir: {
      pres: ['traduzco','traduces','traduce','traducimos','traducís','traducen'],
      pret: ['traduje','tradujiste','tradujo','tradujimos','tradujisteis','tradujeron'],
      presSub: ['traduzca','traduzcas','traduzca','traduzcamos','traduzcáis','traduzcan'],
    },
    conducirse: { _skip: true },
    ofrecer: {
      pres: ['ofrezco','ofreces','ofrece','ofrecemos','ofrecéis','ofrecen'],
      presSub: ['ofrezca','ofrezcas','ofrezca','ofrezcamos','ofrezcáis','ofrezcan'],
    },
    parecer: {
      pres: ['parezco','pareces','parece','parecemos','parecéis','parecen'],
      presSub: ['parezca','parezcas','parezca','parezcamos','parezcáis','parezcan'],
    },
    merecer: {
      pres: ['merezco','mereces','merece','merecemos','merecéis','merecen'],
      presSub: ['merezca','merezcas','merezca','merezcamos','merezcáis','merezcan'],
    },
    aparecer: {
      pres: ['aparezco','apareces','aparece','aparecemos','aparecéis','aparecen'],
      presSub: ['aparezca','aparezcas','aparezca','aparezcamos','aparezcáis','aparezcan'],
    },
    creer: {
      pret: ['creí','creíste','creyó','creímos','creísteis','creyeron'],
      presSub: ['crea','creas','crea','creamos','creáis','crean'],
    },
    construir: {
      pres: ['construyo','construyes','construye','construimos','construís','construyen'],
      pret: ['construí','construiste','construyó','construimos','construisteis','construyeron'],
      presSub: ['construya','construyas','construya','construyamos','construyáis','construyan'],
    },
    huir: {
      pres: ['huyo','huyes','huye','huimos','huís','huyen'],
      pret: ['huí','huiste','huyó','huimos','huisteis','huyeron'],
      presSub: ['huya','huyas','huya','hayamos','hayáis','huyan'],
    },
    incluir: {
      pres: ['incluyo','incluyes','incluye','incluimos','incluís','incluyen'],
      pret: ['incluí','incluiste','incluyó','incluimos','incluisteis','incluyeron'],
    },
    andar: {
      pret: ['anduve','anduviste','anduvo','anduvimos','anduvisteis','anduvieron'],
      _stem: 'anduv',
    },
    caber: {
      pres: ['quepo','cabes','cabe','cabemos','cabéis','caben'],
      pret: ['cupe','cupiste','cupo','cupimos','cupisteis','cupieron'],
      presSub: ['quepa','quepas','quepa','quepamos','quepáis','quepan'],
      _stem: 'cabr',
    },
    caerse: { _skip: true },
    valer: {
      pres: ['valgo','vales','vale','valemos','valéis','valen'],
      presSub: ['valga','valgas','valga','valgamos','valgáis','valgan'],
    },
    salir: {
      pres: ['salgo','sales','sale','salimos','salís','salen'],
      presSub: ['salga','salgas','salga','salgamos','salgáis','salgan'],
    },
    oír: null, // alias handled below
    abrir: {
      pret: ['abrí','abriste','abrió','abrimos','abristeis','abrieron'],
    },
    escribir: {
      pret: ['escribí','escribiste','escribió','escribimos','escribisteis','escribieron'],
    },
    recibir: { _skip: false },
    vivir: { _skip: false },
    subir: { _skip: false },
    permitir: { _skip: false },
    decidir: {
      pret: ['decidí','decidiste','decidió','decidimos','decidisteis','decidieron'],
    },
    describir: {
      pret: ['describí','describiste','describió','describimos','describisteis','describieron'],
    },
    descubrir: {
      pres: ['descubro','descubres','descubre','descubrimos','descubrís','descubren'],
      pret: ['descubrí','descubriste','descubrió','descubrimos','descubristeis','descubrieron'],
    },
    cubrir: {
      pret: ['cubrí','cubriste','cubrió','cubrimos','cubristeis','cubrieron'],
    },
    morirse: { _skip: true },
    reír: {
      pres: ['río','ríes','ríe','reímos','reís','ríen'],
      pret: ['reí','reíste','rió','reímos','reísteis','rieron'],
    },
    sonreír: {
      pres: ['sonrío','sonríes','sonríe','sonreímos','sonreís','sonríen'],
      pret: ['sonreí','sonreíste','sonrió','sonreímos','sonreísteis','sonrieron'],
    },
    freír: {
      pres: ['frío','fríes','fríe','freímos','freís','fríen'],
      pret: ['freí','freíste','frió','freímos','freísteis','frieron'],
    },
    elegir: {
      pres: ['elijo','eliges','elige','elegimos','elegís','eligen'],
      pret: ['elegí','elegiste','eligió','elegimos','elegisteis','eligieron'],
      presSub: ['elija','elijas','elija','elijamos','elijáis','elijan'],
    },
    corregir: {
      pres: ['corrijo','corriges','corrige','corregimos','corregís','corrigen'],
      pret: ['corregí','corregiste','corrigió','corregimos','corregisteis','corrigieron'],
      presSub: ['corrija','corrijas','corrija','corrijamos','corrijáis','corrijan'],
    },
    conseguir: {
      pres: ['consigo','consigues','consigue','conseguimos','conseguís','consiguen'],
      pret: ['conseguí','conseguiste','consiguió','conseguimos','conseguisteis','consiguieron'],
      presSub: ['consiga','consigas','consiga','consigamos','consigáis','consigan'],
    },
    perseguir: {
      pres: ['persigo','persigues','persigue','perseguimos','perseguís','persiguen'],
      pret: ['perseguií','perseguiste','persiguió','perseguimos','perseguisteis','persiguieron'],
      presSub: ['persiga','persigas','persiga','persigamos','persigáis','persigan'],
    },
    repetir: {
      pres: ['repito','repites','repite','repetimos','repetís','repiten'],
      pret: ['repetí','repetiste','repitió','repetimos','repetisteis','repitieron'],
      presSub: ['repita','repitas','repita','repitamos','repitáis','repitan'],
    },
    vestir: {
      pres: ['visto','vistes','viste','vestimos','vestís','visten'],
      pret: ['vestí','vestiste','vistió','vestimos','vestisteis','vistieron'],
      presSub: ['vista','vistas','vista','vistamos','vistáis','vistan'],
    },
    servir: {
      pres: ['sirvo','sirves','sirve','servimos','servís','sirven'],
      pret: ['serví','serviste','sirvió','servimos','servisteis','sirvieron'],
      presSub: ['sirva','sirvas','sirva','sirvamos','sirváis','sirvan'],
    },
    reírse: { _skip: true },
    divertirse: { _skip: true },
    despertarse: { _skip: true },
    acostarse: { _skip: true },
    levantarse: { _skip: true },
    sentarse: { _skip: true },
    sentirse: { _skip: true },
    llamarse: { _skip: true },
    ducharse: { _skip: true },
    casarse: { _skip: true },
    ponerse: { _skip: true },
    quitarse: { _skip: true },
    probarse: { _skip: true },
    quedarse: { _skip: true },
    reunirse: { _skip: true },
    preocuparse: { _skip: true },
    olvidarse: { _skip: true },
    atreverse: { _skip: true },
    irse: { _skip: true },
    caerle: { _skip: true },
    audar: { _skip: true },
  };
  delete IRREG['oír']; // handled as 'oir'

  // 助动词/情态动词高频表补充
  const IRREG_EXTRA = {
    deber: { _skip: false },
    votar: { _skip: false },
  };

  /* ---------- 词性后缀启发式 ---------- */
  const POS_RULES = [
    [/ción$|sión$|dad$|tad$|umbre$|ez$|za$|ancia$|encia$|ismo$|ista$/i, '名词 (f.)'],
    [/mente$/i, '副词'],
    [/oso$|osa$|ivo$|iva$|able$|ible$|al$|ar$.*adj/i, '形容词'],
    [/ísimo$|ísima$|azo$|aza$/i, '形容词（加强）'],
  ];

  function conjugateRegular(inf) {
    if (inf.endsWith('ar')) return { cls: 'ar', forms: REGULAR.ar };
    if (inf.endsWith('er')) return { cls: 'er', forms: REGULAR.er };
    if (inf.endsWith('ir')) return { cls: 'ir', forms: REGULAR.ir };
    return null;
  }

  function tenseForms(inf, cls, tense, irregular) {
    // irregular[tense] 如果存在则是完整六人称数组
    if (irregular && irregular[tense] && Array.isArray(irregular[tense])) {
      return irregular[tense];
    }
    const tpl = REGULAR[cls][tense];
    const irregularStem = irregular && irregular._stem;
    if (tense === 'fut' || tense === 'cond') {
      // 将来/条件 = 原形整词(不规则则用 _stem 词干) + 词尾: hablar+é, tendr+é
      if (irregularStem) return tpl.map(s => irregularStem + s);
      return tpl.map(s => inf + s);
    }
    const drop = cls === 'ar' ? 'ar' : cls; // ar/er/ir
    const st = stem(inf, inf.slice(-2));
    if (tense === 'impSub' && cls === 'ar') {
      // 规则 -ar 虚拟未完成：hablara (词干 + ara...)
      return tpl.map(s => st + s);
    }
    return tpl.map(s => st + s);
  }

  /* ---------- 代词附着（enclitic pronouns）剥离 ----------
   * 处理 dármelo / mandate / levántate / explícamelo / háblenme 这类
   * 动词+代词连写形式：从右剥 1~2 个代词，动词部分交给核心分析器验证。
   * 关键：剥离后动词部分必须命中（不规则表/反查/规则生成-验证），否则不剥离。
   */
  const PRON_GLOSS = {
    me: 'me 我（宾格/与格）', te: 'te 你（宾格/与格）', se: 'se 自己/相互/替代 le·les',
    lo: 'lo 他/它（宾格）· usted（与格，m.）', la: 'la 她/它（宾格）· usted（与格，f.）',
    le: 'le 他/她/您（与格）', nos: 'nos 我们（宾格/与格）', os: 'os 你们（宾格/与格）',
    los: 'los 他们/它们（宾格）· ustedes（与格，m.）', las: 'las 她们/它们（宾格）· ustedes（与格，f.）',
    les: 'les 他们/她们/您们（与格）',
  };
  // 合法附着序列：单代词，或 [与格 IO, 宾格 DO]
  const CLITIC_SEQS = (() => {
    const IO = ['me','te','se','nos','os','le','les'];
    const DO = ['lo','la','los','las'];
    const seqs = [...IO, ...DO].map(p => [p]);          // 单代词
    for (const io of ['me','te','se','nos','os'])
      for (const dof of DO) seqs.push([io, dof]);        // IO+DO 双代词
    return seqs;
  })();

  function stripAccents(s) {
    // 只去重音/分音符,保留 ñ(组合波浪符 \u0303 不在删除列表)
    return s.normalize('NFD').replace(/[\u0301\u0308]/g, '').normalize('NFC');
  }

  // 词频校验器(由 data.js 注入,用于候选原形消歧),可空
  let freqCheck = null;
  function setFreqChecker(fn) { freqCheck = fn; }

  // 核心分析（不含代词剥离），供剥离验证复用
  function analyzeCore(w, out) {
    // 命中不规则表（按原形查询）
    const ir = IRREG[w];
    if (ir && !ir._skip) {
      out.pos = '动词（不规则）';
      out.verb = buildVerb(w, ir);
      out.matched = w;
      return true;
    }

    // 尝试反查：该词是否是某个动词的变位形式
    const rev = reverseLookup(w);
    if (rev) {
      out.pos = `动词变位 (${rev.tense}${rev.person !== undefined ? ' · ' + P[rev.person] : ''})`;
      out.verb = buildVerb(rev.inf, IRREG[rev.inf]);
      out.matched = rev.form;
      return true;
    }

    // 规则动词原形
    const cls = conjugateRegular(w);
    if (cls && w.length > 3) {
      out.pos = `动词原形 (-${cls.cls})`;
      out.verb = buildVerb(w, null);
      out.matched = w;
      return true;
    }
    return false;
  }

  // 尝试剥离附着代词。命中返回结果，否则 null（调用方回退到整词分析）
  function tryStripPronouns(w) {
    // 整词本身是已知词(词频表在册)时不剥离,避免 árboles→arbol+les 误判
    if (freqCheck && freqCheck(w) > 0) return null;
    for (const seq of CLITIC_SEQS) {
      const joined = seq.join('');
      if (!w.endsWith(joined) || w.length - joined.length < 2) continue;
      const verbPart = w.slice(0, w.length - joined.length);
      const out = { pos: null, verb: null };
      // 1) 原样（可能带重音符号）；2) 去重音后再试
      const hit = analyzeCore(verbPart, out) || analyzeCore(stripAccents(verbPart), out);
      if (hit) {
        // 验证动词部分真实性:反查出的原形须词频在册(或无词频校验器时直接通过)
        const inf = out.verb && out.verb.inf;
        const known = !freqCheck || (inf && freqCheck(inf) > 0);
        if (known) {
          out.pos = (out.pos || '') + ` + 代词 [${seq.join('+')}]`;
          out.clitics = seq.map(p => PRON_GLOSS[p]);
          out.baseForm = verbPart;
          return out;
        }
      }
    }
    return null;
  }

  /* ---------- 主入口：分析一个词 ---------- */
  // 返回 { pos, verb: {inf, cls, tenses: {pres: [...], ...}} | null }
  function analyze(word) {
    const w = (word || '').trim().toLowerCase();
    const out = { pos: null, verb: null };

    if (!w || !/^[a-záéíóúüñ]+$/i.test(w)) return out;

    // 尝试剥离附着代词（如 dármelo → dar + me + lo）
    const decomp = tryStripPronouns(w);
    if (decomp) return decomp;

    // 整词分析
    analyzeCore(w, out);

    // 未命中 → 后缀启发式词性
    if (!out.pos) {
      for (const [re, label] of POS_RULES) {
        if (re.test(w)) { out.pos = label; return out; }
      }
      if (/s$/.test(w) && w.length > 3) out.pos = '名词/形容词（复数）';
      else if (/o$/.test(w)) out.pos = '名词/形容词（阳性）';
      else if (/a$/.test(w)) out.pos = '名词/形容词（阴性）';
      else out.pos = '名词/形容词/其他';
    }
    return out;
  }

  /* ---------- 不规则变位形式反查 ----------
   * 把所有不规则动词的所有形式展开成 map: form -> [{inf, tense, person}]
   */
  let reverseMap = null;
  function buildReverse() {
    if (reverseMap) return reverseMap;
    reverseMap = new Map();
    for (const [inf, tenses] of Object.entries(IRREG)) {
      if (!tenses || tenses._skip) continue;
      for (const [tense, forms] of Object.entries(tenses)) {
        if (tense === '_stem' || !Array.isArray(forms)) continue;
        forms.forEach((f, i) => {
          const key = f.toLowerCase();
          if (!reverseMap.has(key)) reverseMap.set(key, []);
          reverseMap.get(key).push({ inf, tense, person: i, form: f });
        });
      }
      // _stem 生成的将来/条件形式也入索引（sería / tendrás / sabríamos…）
      if (tenses._stem) {
        const tpl = REGULAR[inf.slice(-2)];
        for (const t of ['fut', 'cond']) {
          tpl[t].forEach((suf, i) => {
            const key = stripAccents((tenses._stem + suf).toLowerCase());
            if (!reverseMap.has(key)) reverseMap.set(key, []);
            reverseMap.get(key).push({ inf, tense: t, person: i, form: tenses._stem + suf });
          });
        }
      }
    }
    return reverseMap;
  }

  function reverseLookup(word) {
    const w = word.toLowerCase();
    const m = buildReverse().get(w);
    if (m && m.length) return m[0];
    // 规则动词全时态反查：尝试把 w 视作某原形的规则变位（生成-验证）
    return reverseRegular(w);
  }

  /* ---------- 规则动词变位反查 ----------
   * 思路:从变位词形态学反推原形候选,再用规则引擎生成全变位精确验证。
   * 全程在去重音域内匹配(重音符号由正字法产生,不参与形态判定)。
   */
  const TENSE_ORDER = Object.keys(TENSE_NAMES); // pres pret imp fut cond presSub impSub
  function reverseRegular(word) {
    const w = stripAccents(word.toLowerCase());
    if (w.length < 4) return null;
    // 1) 形态学反推:变位词尾(去重音) → 原形词尾。只处理纯规则情形,不规则动词已由 buildReverse 覆盖
    const tailMap = [
      // -- 多字符词尾优先(避免 'a' 抢先吃掉 'ía' 等) --
      ['abamos','ar'], ['aramos','ar'], ['asteis','ar'], ['areis','ar'], ['arias','ar'], ['aremos','ar'],
      ['ariais','ar'], ['aran','ar'], ['aste','ar'], ['aron','ar'], ['abais','ar'], ['aban','ar'],
      ['abas','ar'], ['aba','ar'], ['are','ar'], ['aras','ar'], ['ara','ar'], ['are','ar'],
      ['eremos','er'], ['eriais','er'], ['eriamos','er'], ['ereis','er'], ['eran','er'], ['erias','er'],
      ['ieramos','er'], ['ieran','er'], ['ieras','er'], ['iera','er'],
      ['iremos','ir'], ['iriais','ir'], ['iriamos','ir'], ['ireis','ir'], ['iran','ir'], ['irias','ir'],
      ['imos','ir'], ['is','ir'],
      ['amos','ar'], ['ais','ar'], ['amos','er'], ['emos','er'],
      ['iamos','er'], ['iais','er'], ['ian','er'], ['ias','er'], ['ia','er'],
      ['amos','ir'], ['ais','ir'], ['io','er'], ['io','ir'],
      // -- 通用单/双字符词尾(最后) --
      ['e','ar'], ['as','ar'], ['an','ar'], ['a','ar'], ['es','ar'], ['en','ar'],
      ['e','er'], ['as','er'], ['an','er'], ['a','er'], ['es','er'], ['en','er'],
      ['e','ir'], ['as','ir'], ['an','ir'], ['a','ir'], ['es','ir'], ['en','ir'],
      ['o','ar'], ['o','er'], ['o','ir'],
    ];
    const cands = [];
    for (const [suf, repl] of tailMap) {
      if (w.endsWith(suf)) {
        const stem = w.slice(0, w.length - suf.length);
        if (stem.length >= 2) { const c = stem + repl; if (!cands.includes(c)) cands.push(c); }
      }
    }
    // 复元音反推:变位词干的 ie/ue 来自 e/o 的强读 → 还原候选 (sientar→sentar)
    for (const c of cands.slice()) {
      const stem = c.slice(0, -2), end = c.slice(-2);
      let m;
      if ((m = stem.match(/^(.*)ie(.*)$/))) { const u = m[1] + 'e' + m[2] + end; if (!cands.includes(u)) cands.push(u); }
      if ((m = stem.match(/^(.*)ue(.*)$/))) { const u = m[1] + 'o' + m[2] + end; if (!cands.includes(u)) cands.push(u); }
    }
    // fut/cond 反推:hablaria=hablar+ia(词干已含词尾则直接用), viviriamos=vivir+iamos
    // 注意按词尾长度降序尝试,避免 'a' 抢在 'ia' 之前匹配
    for (const e of ['iamos','iais','ian','ias','ia','emos','eis','an','as','a','e']) {
      if (w.endsWith(e) && w.length - e.length >= 2) {
        const st = w.slice(0, w.length - e.length);
        if (/(ar|er|ir)$/.test(st)) { if (!cands.includes(st)) cands.push(st); }
        else for (const r of ['ar','er','ir']) { const c = st + r; if (!cands.includes(c)) cands.push(c); }
        break;
      }
    }
    // 2) 生成-验证:只验证词频在册的原形(20万词表已覆盖全部真实动词),
    //    未在册的候选视为假原形丢弃,避免 muerto→muertar 之类误配。
    //    每个候选还生成词干复元音变体(e→ie / o→ue):sienta←sentar, cuenta←contar
    const score = inf => { const s = freqCheck ? freqCheck(inf) : 1; return (s && s > 0) ? s : Infinity; };
    const ranked = cands.slice().sort((a, b) => score(a) - score(b));
    function stemVariants(inf) {
      const stem = inf.slice(0, -2);
      const vs = [];
      const iE = stem.lastIndexOf('e');
      if (iE >= 0) vs.push(stem.slice(0, iE) + 'ie' + stem.slice(iE + 1) + inf.slice(-2));
      const iO = stem.lastIndexOf('o');
      if (iO >= 0) vs.push(stem.slice(0, iO) + 'ue' + stem.slice(iO + 1) + inf.slice(-2));
      return vs;
    }
    for (const inf of ranked) {
      if (freqCheck && score(inf) === Infinity) break; // 词频不在册 → 假原形
      const cls = inf.endsWith('ar') ? 'ar' : inf.endsWith('er') ? 'er' : inf.endsWith('ir') ? 'ir' : null;
      if (!cls) continue;
      // IRREG 在册动词也参与验证(其规则形式如 explica 属规则变位)
      for (const vinf of [inf, ...stemVariants(inf)]) {
        for (const t of TENSE_ORDER) {
          const idx = tenseForms(vinf, cls, t, IRREG[inf] && !IRREG[inf]._skip ? IRREG[inf] : null).map(stripAccents).indexOf(w);
          if (idx >= 0) return { inf, tense: TENSE_NAMES[t], person: idx, form: w };
        }
      }
    }
    return null;
  }

  /* ---------- 自测（控制台运行 CONJ.runTests()）---------- */
  function runTests() {
    const cases = [
      // [输入, 期望 pos 含, 期望 verb.inf]
      ['hablo',     '动词变位', 'hablar'],
      ['hablaron',  '动词变位', 'hablar'],
      ['hablaba',   '动词变位', 'hablar'],
      ['hablaría',  '动词变位', 'hablar'],
      ['comió',     '动词变位', 'comer'],
      ['comamos',   '动词变位', 'comer'],
      ['viviría',   '动词变位', 'vivir'],
      ['viviríamos','动词变位', 'vivir'],
      ['cantáramos','动词变位', 'cantar'],
      ['estuvieron','动词变位', 'estar'],
      ['quiso',     '动词变位', 'querer'],
      ['sería',     '动词变位', 'ser'],      // 不规则应优先于规则误配
      ['dámelo',    '+ 代词 [me+lo]', 'dar'],
      ['mandémelo', '+ 代词 [me+lo]', 'mandar'],
      ['explícamelo','+ 代词', 'explicar'],
      ['levántate', '+ 代词 [te]', 'levantar'],
      ['háblenme',  '+ 代词 [me]', 'hablar'],
      ['siéntate',  '+ 代词 [te]', 'sentar'],
      ['vamos',     '动词变位', 'ir'],
      ['come',      '动词变位', 'comer'],
      ['árboles',   null, null],              // 非动词不被误判
    ];
    const results = cases.map(([input, posExp, infExp]) => {
      const r = analyze(input);
      const posOk = posExp === null ? true : (r.pos || '').includes(posExp);
      const infOk = infExp === null ? true : (r.verb && r.verb.inf === infExp);
      return { input, pos: r.pos, inf: r.verb && r.verb.inf, pass: posOk && infOk };
    });
    const fail = results.filter(r => !r.pass);
    return { total: results.length, failed: fail.length, results };
  }

  function buildVerb(inf, irregular) {
    const cls = inf.endsWith('ar') ? 'ar' : (inf.endsWith('er') ? 'er' : 'ir');
    const ir = irregular && !irregular._skip ? irregular : null;
    const tenses = {};
    for (const t of Object.keys(TENSE_NAMES)) {
      tenses[t] = tenseForms(inf, cls, t, ir);
    }
    return { inf, cls, tenses };
  }

  /* ---------- 渲染 HTML 变位表 ---------- */
  function renderHTML(verb) {
    if (!verb) return '';
    const rows = Object.entries(verb.tenses).map(([t, forms]) => `
      <div class="conj-row">
        <div class="conj-tense">${TENSE_NAMES[t]}</div>
        <div class="conj-forms">${forms.map((f, i) =>
          `<span class="conj-cell"><b>${f}</b><i>${P[i]}</i></span>`
        ).join('')}</div>
      </div>`).join('');
    return `<div class="conj-table">${rows}</div>`;
  }

  return { analyze, renderHTML, TENSE_NAMES, P, isVerb: w => !!analyze(w).verb, runTests, setFreqChecker };
})()