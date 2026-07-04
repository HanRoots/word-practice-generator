const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const rootDir = __dirname;
const preferredPort = Number(process.env.PORT || 8797);
const host = process.env.HOST || "127.0.0.1";
const defaultBaseUrl = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const defaultModel = process.env.LLM_MODEL || "gpt-4.1-mini";
const defaultApiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "";

const typeLabels = {
  pronunciationChoice: "错字组词辨音",
  pinyinWriteWord: "看拼音写词语",
  confusingCharFill: "易混字填空辨析",
  contextualPinyinWrite: "语境看拼音写词",
  mixedErrorChoice: "字音字形综合选择",
  meaningSameChoice: "加点字意思辨析",
  wordSentence: "组词造句"
};

function optionLetter(index) {
  return String.fromCharCode(65 + index);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, content, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(content)
  });
  res.end(content);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseWrongChars(value) {
  const raw = Array.isArray(value) ? value.join("") : String(value || "");
  const chars = Array.from(raw).filter(char => /^[\u3400-\u9fff]$/.test(char));
  return Array.from(new Set(chars)).slice(0, 30);
}

function parseTypes(value) {
  const known = Object.keys(typeLabels);
  if (!Array.isArray(value)) return known;
  const selected = value.filter(type => known.includes(type));
  return selected.length ? selected : known;
}

function buildPrompt(input) {
  const grade = input.grade || "三年级";
  const textbookVersion = String(input.textbookVersion || "统编版小学语文").slice(0, 30);
  const wrongChars = parseWrongChars(input.wrongChars);
  const types = parseTypes(input.types);
  const questionCounts = Object.fromEntries(types.map(type => [type, expectedQuestionCount(input, type)]));
  const questionCount = expectedQuestionCount(input);
  const title = String(input.title || "暑假字词闯关练习").slice(0, 40);

  const schema = {
    title,
    grade,
    textbookVersion,
    wrongChars,
    sections: [
      {
        type: "pronunciationChoice",
        title: "错字组词辨音",
        instruction: "读词语，选择加点字的正确读音。",
        questions: [
          {
            id: "q1",
            word: "拔河",
            char: "拔",
            stem: "拔河中“拔”的正确读音是？",
            options: ["bá", "bō", "bèi", "pá"],
            answer: "A",
            answerText: "bá",
            explanation: "“拔”读 bá。"
          }
        ]
      }
    ],
    answerKey: []
  };

  return [
    {
      role: "system",
      content: [
        `你是${grade}${textbookVersion}字词练习命题老师。`,
        "你必须只返回合法 JSON，不要 Markdown，不要代码块，不要额外解释。",
        `题目必须适配${grade}的课内字词水平，参考统编版/部编版小学语文教材常见生字、词语和课文语境。`,
        "题目要围绕用户提供的错字以及这些错字的易混字，不要泛泛出题。",
        `每道题必须适合${grade}学生，语境自然，句子短，答案准确，不超出该年级孩子的理解范围。`,
        "所有题目都必须是语文内容：考查字音、字形、字义、词语搭配或语境表达，不能只是机械拆字、凑字或生成不通顺句子。",
        "每道填空题填入答案后，必须能形成真实常用词语，并且整句话自然通顺。",
        "干扰项要合理，但不能制造错误知识。",
        "所有拼音必须带声调符号，例如 cháo shuǐ、biàn bié、dài mào zi。严禁输出 chao shui、bian bie 这种无声调拼音。",
        "所有 options 只写选项内容，不要写 A.、B.、C.、D. 等编号；同一道题的 options 不得重复。",
        "meaningSameChoice 的 options 推荐使用对象：{\"words\":[\"拔草\",\"拔河\"],\"targetChar\":\"拔\",\"sameMeaning\":true,\"reason\":\"都表示向外拉出\"}；每个 words 中的词语都必须包含 targetChar；同一道题四个选项里的词语不得重复。不要用 ·、• 或单独拆出加点字。",
        "除 meaningSameChoice 外，答案解释一句话即可，每条解释不超过 20 个汉字。",
        "meaningSameChoice 必须给每个选项都写 reason：正确项说明为什么意思相同，错误项说明为什么意思不同。",
        "不要生成详细 answerKey；answerKey 返回空数组即可，服务端会根据题目重建答案。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `年级：${grade}`,
        `教材版本：${textbookVersion}`,
        `练习标题：${title}`,
        `孩子写错的单字：${wrongChars.join("、")}`,
        `基础错字数量：${questionCount}。`,
        `各题型题量：${types.map(type => `${typeLabels[type]} ${questionCounts[type]} 题`).join("；")}。每个错字至少出现一次；倍数为 2 或 3 的题型要循环覆盖错字。`,
        "题干和选项尽量短，禁止长段落。",
        "选择题 options 数组中不要包含 A/B/C/D 编号，前端会自动编号。",
        "同一道选择题中，不要出现重复选项。",
        "需要生成的题型：",
        ...types.map(type => `- ${type}: ${typeLabels[type]}`),
        "",
        "七类题型要求：",
        "1. pronunciationChoice：错字组词后辨析字音，孩子选正确读音。每题必须含 word、char、options、answer、answerText；options 固定 3 个读音候选，不能只是同一拼音组合改声调，至少一个干扰音要改变声母或韵母。",
        "2. pinyinWriteWord：错字自动组词，看拼音写词语。每题必须含 word 和 pinyin，pinyin 必须带声调。",
        "3. confusingCharFill：由错字延伸 3-4 个易混字，放入真实语文语境中选正确字。每题必须含 stem、options、answer、answerWord、completedSentence、explanation。answer 填入 stem 后必须组成常用词语 answerWord，completedSentence 必须是自然通顺的完整句。严禁机械拆字或凑出不自然表达，例如不要生成“他的笑容很（ ）易”“这是（ ）确的消息”“他（ ）外喜欢画画”这类句子。",
        "4. contextualPinyinWrite：把看拼音写词语放入语境中再测一次。每题必须含 word、pinyin、stem，stem 用 ____ 表示书写位置。",
        "5. mixedErrorChoice：字音字形综合选择题，例如“字音字形错误最多的一项是”。每题必须同时出现读音错误和字形错误；字形错误只能使用真实常见错写，如“拨河/拔河”“辩别/辨别”，禁止临时硬造。",
        "6. meaningSameChoice：测试同一个字在不同词语中的意思是否相同，例如“下列各组词语中，加点字意思相同的一项是”。每个 option 用对象格式 {\"words\":[\"打水\",\"打伞\"],\"targetChar\":\"打\",\"sameMeaning\":false,\"reason\":\"打水是汲取，打伞是撑开\"}；words 必须是 2-3 个词语，且每个词语都必须包含 targetChar。同一道题四个选项里的词语不得重复。每个 option 都必须有 reason，正确项解释为什么相同，错误项解释为什么不同。错误选项也必须比较同一个汉字在不同词语里的意思，不要用“辨/辩”“在/再”“做/作”这种不同字形来凑选项，不要写成“打水 · 打 · 伞”。",
        "7. wordSentence：用错字组词，并要求孩子造句。每题含 word。",
        "看拼音写词语和语境看拼音写词的 word 长度以 2-4 字为主，便于田字格排版。",
        "",
        "返回前必须逐题自检；不合格就换题，不要输出有问题的题：",
        "- 拼音题：拼音必须带声调，音节数要和汉字数基本一致。",
        "- 填空题：填入答案后必须是自然通顺的真实语文句子，答案字必须组成常用词语，不能硬凑字。",
        "- 易混字题：干扰项必须是形近、音近或常见误用字，不能随机给字。",
        "- 选择题：每题只能有一个明确正确答案，选项不得重复。",
        "- 字义题：必须比较同一个字在不同词语里的意思，不能比较不同字形；同一道题四个选项里的词语不得重复。",
        "- 造句题：目标词必须是正确词语，适合该年级学生造句。",
        "",
        "输出 JSON 结构：",
        JSON.stringify(schema),
        "answerKey 必须存在但保持空数组，不要重复输出答案页内容。"
      ].join("\n")
    }
  ];
}

function optionText(value) {
  if (value && typeof value === "object") {
    if (Array.isArray(value.words)) return value.words.join(" ");
    return String(value.text || value.label || value.value || "");
  }
  return String(value || "");
}

function stripOptionPrefix(value) {
  return optionText(value).replace(/^(?:\s*[A-Ha-hＡ-Ｈａ-ｈ][\.\、．:：]\s*)+/, "").trim();
}

function normalizeOption(option) {
  if (!option || typeof option !== "object" || Array.isArray(option)) {
    return stripOptionPrefix(option);
  }

  const normalized = { ...option };
  if (Array.isArray(option.words)) {
    normalized.words = option.words.map(stripOptionPrefix).filter(Boolean);
  }
  if (option.text) normalized.text = stripOptionPrefix(option.text);
  if (option.label) normalized.label = stripOptionPrefix(option.label);
  if (option.value) normalized.value = stripOptionPrefix(option.value);
  const targetChar = option.targetChar || option.char || option.keyChar || "";
  if (targetChar) {
    normalized.targetChar = Array.from(String(targetChar).trim())[0] || "";
  }
  if (Array.isArray(option.targetChars)) {
    normalized.targetChars = option.targetChars.map(char => Array.from(String(char || "").trim())[0] || "").filter(Boolean);
  }
  return normalized;
}

function normalizeQuestionOptions(question) {
  if (!question || typeof question !== "object" || !Array.isArray(question.options)) {
    return question;
  }

  const seen = new Set();
  return {
    ...question,
    options: question.options
      .map(normalizeOption)
      .filter(option => {
        const key = optionText(option).replace(/\s+/g, "");
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
  };
}

function visibleChars(value) {
  return Array.from(String(value || "").replace(/\s/g, ""));
}

function isCjkChar(char) {
  return /^[\u3400-\u9fff]$/.test(char);
}

function cjkChars(value) {
  return visibleChars(value).filter(isCjkChar);
}

function isSingleCjkChar(value) {
  return cjkChars(value).length === 1 && cjkChars(value)[0] === String(value || "").trim();
}

function hasToneMark(value) {
  const neutralSyllables = new Set(["de", "le", "zhe", "zhuo", "guo", "zi", "men", "me", "ma", "ba", "ne", "a", "ya"]);
  const syllables = splitPinyin(value);
  if (!syllables.length) return false;
  return syllables.every(syllable => {
    if (/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿ]/i.test(syllable)) return true;
    const plain = syllable.toLowerCase().replace(/[^a-züv]/g, "").replace(/ü/g, "v");
    return neutralSyllables.has(plain);
  });
}

function splitPinyin(value) {
  return String(value || "")
    .replace(/-/g, " ")
    .split(/\s+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function hasPlaceholder(value) {
  return /____+|_{2,}|（\s*）|\(\s*\)|\[　*\]|【　*】/.test(String(value || ""));
}

function replaceFirstPlaceholder(stem, answer) {
  return String(stem || "").replace(/____+|_{2,}|（\s*）|\(\s*\)|\[　*\]|【　*】/, String(answer || ""));
}

function answerIndex(value) {
  const letter = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]$/.test(letter)) return -1;
  return letter.charCodeAt(0) - 65;
}

function validateOptionBasics(section, question, path, issues) {
  if (!Array.isArray(question.options)) return;
  const seen = new Set();
  question.options.forEach((option, index) => {
    const key = optionText(option).replace(/\s+/g, "");
    if (!key) {
      issues.push(`${path} 第 ${index + 1} 个选项为空`);
      return;
    }
    if (seen.has(key)) {
      issues.push(`${path} 选项重复：${key}`);
    }
    seen.add(key);
  });
}

function validateAnswerLetter(question, path, issues) {
  const index = answerIndex(question.answer);
  if (index < 0 || !Array.isArray(question.options) || index >= question.options.length) {
    issues.push(`${path} 缺少有效答案字母`);
    return -1;
  }
  return index;
}

function validatePinyinWord(question, path, issues, requirePlaceholder = false) {
  const word = String(question.word || question.term || question.answerWord || "").trim();
  const pinyin = String(question.pinyin || question.reading || question.promptPinyin || question.answerPinyin || "").trim();
  const chars = cjkChars(word);
  if (!chars.length || chars.length > 4) {
    issues.push(`${path} 看拼音写词的词语应为 1-4 个汉字`);
  }
  if (!pinyin || !hasToneMark(pinyin)) {
    issues.push(`${path} 拼音缺少声调`);
  }
  const syllables = splitPinyin(pinyin);
  if (chars.length && syllables.length && Math.abs(chars.length - syllables.length) > 1) {
    issues.push(`${path} 拼音音节数和汉字数不匹配`);
  }
  if (requirePlaceholder) {
    const stem = question.stem || question.prompt || question.sentence || question.text || "";
    if (!hasPlaceholder(stem)) {
      issues.push(`${path} 语境看拼音题缺少书写位置`);
    }
  }
}

function validatePronunciationChoice(question, path, issues) {
  const word = String(question.word || question.term || question.answerWord || "").trim();
  const target = String(question.char || question.targetChar || "").trim();
  if (!word || !target || !word.includes(target)) {
    issues.push(`${path} 辨音词语必须包含目标字`);
  }
  const index = validateAnswerLetter(question, path, issues);
  const options = Array.isArray(question.options) ? question.options.map(optionText) : [];
  if (options.length !== 3) {
    issues.push(`${path} 辨音题必须提供 3 个读音选项`);
  }
  if (options.some(option => !hasToneMark(option))) {
    issues.push(`${path} 辨音选项必须带声调`);
  }
  const plainOptions = new Set(options.map(plainPinyinSyllable).filter(Boolean));
  if (options.length >= 3 && plainOptions.size < 2) {
    issues.push(`${path} 辨音选项不能只改变声调，至少要有一个声母或韵母不同的干扰音`);
  }
  const answerText = String(question.answerText || (index >= 0 ? options[index] : "") || "").trim();
  if (!answerText || !hasToneMark(answerText)) {
    issues.push(`${path} 辨音答案必须带声调`);
  }
  if (answerText && !options.includes(answerText)) {
    issues.push(`${path} 辨音正确读音不在选项中`);
  }
  if (index >= 0 && answerText && options[index] && answerText !== options[index]) {
    issues.push(`${path} answer 和 answerText 不一致`);
  }
}

function validateConfusingCharFill(question, path, issues) {
  const stem = String(question.stem || question.prompt || question.sentence || question.text || "").trim();
  const answer = String(question.answer || question.answerText || "").trim();
  const options = Array.isArray(question.options) ? question.options.map(optionText) : [];
  if (!hasPlaceholder(stem)) {
    issues.push(`${path} 易混字填空缺少填空位置`);
  }
  if (!isSingleCjkChar(answer)) {
    issues.push(`${path} 易混字填空答案必须是单个汉字`);
  }
  if (options.length < 3 || options.some(option => !isSingleCjkChar(option))) {
    issues.push(`${path} 易混字填空选项必须是 3 个以上单字`);
  }
  if (answer && options.length && !options.includes(answer)) {
    issues.push(`${path} 易混字填空答案不在选项中`);
  }
  const answerWord = String(question.answerWord || question.word || "").trim();
  if (!answerWord || !answerWord.includes(answer) || cjkChars(answerWord).length < 2) {
    issues.push(`${path} 易混字填空必须提供由答案组成的常用词语 answerWord`);
  }
  const completed = String(question.completedSentence || replaceFirstPlaceholder(stem, answer)).trim();
  if (!completed || hasPlaceholder(completed)) {
    issues.push(`${path} 易混字填空必须提供填入后的完整句`);
  }
  if (answerWord && completed && !completed.includes(answerWord)) {
    issues.push(`${path} 完整句中没有形成答案词语 ${answerWord}`);
  }
  const explanation = String(question.explanation || "").trim();
  if (!explanation) {
    issues.push(`${path} 易混字填空缺少解释`);
  }
}

function mixedChoiceWords(option) {
  return String(optionText(option) || "").match(/[\u3400-\u9fff]{2,}/g) || [];
}

function validateMixedChoice(question, path, issues) {
  if (!Array.isArray(question.options) || question.options.length < 4) {
    issues.push(`${path} 综合选择题至少需要四个选项`);
  }
  const seenWords = new Set();
  (question.options || []).forEach((option, optionIndex) => {
    mixedChoiceWords(option).forEach(word => {
      if (seenWords.has(word)) {
        issues.push(`${path} 综合选择题词语重复：${word}`);
      }
      seenWords.add(word);
    });
  });
  validateAnswerLetter(question, path, issues);
  const corrections = Array.isArray(question.corrections) ? question.corrections.map(String) : [];
  const hasShapeCorrection = corrections.some(item => item.includes("应改为") && !/[()（）]/.test(item));
  if (!hasShapeCorrection) {
    issues.push(`${path} 综合选择题必须包含至少一个字形错误改正`);
  }
}

function validateMeaningSameChoice(question, path, issues) {
  if (!Array.isArray(question.options) || question.options.length < 4) {
    issues.push(`${path} 字义题至少需要四个选项`);
    return;
  }
  const answer = validateAnswerLetter(question, path, issues);
  let sameCount = 0;
  const seenWords = new Set();
  question.options.forEach((option, index) => {
    if (!option || typeof option !== "object" || !Array.isArray(option.words)) {
      issues.push(`${path} 字义题选项 ${optionLetter(index)} 必须使用 words/targetChar 对象格式`);
      return;
    }
    const target = String(option.targetChar || option.char || option.keyChar || "").trim();
    if (!isSingleCjkChar(target)) {
      issues.push(`${path} 字义题选项 ${optionLetter(index)} 缺少单个 targetChar`);
    }
    if (option.words.length < 2 || option.words.some(word => !String(word || "").includes(target))) {
      issues.push(`${path} 字义题选项 ${optionLetter(index)} 每个词语都必须包含 targetChar`);
    }
    option.words.forEach(word => {
      const cleanWord = String(word || "").trim();
      if (!cleanWord) return;
      if (seenWords.has(cleanWord)) {
        issues.push(`${path} 字义题同一题内词语重复：${cleanWord}`);
      }
      seenWords.add(cleanWord);
    });
    if (!String(option.reason || option.explanation || "").trim()) {
      issues.push(`${path} 字义题选项 ${optionLetter(index)} 缺少原因说明`);
    }
    if (option.sameMeaning === true || option.same === true || option.isSameMeaning === true) {
      sameCount += 1;
      if (answer >= 0 && index !== answer) {
        issues.push(`${path} 字义题 sameMeaning 与答案不一致`);
      }
    }
  });
  if (sameCount !== 1) {
    issues.push(`${path} 字义题必须且只能有一个 sameMeaning=true 的选项`);
  }
}

function validateQuestion(section, question, questionIndex, issues) {
  const path = `${section.title || typeLabels[section.type] || section.type}第 ${questionIndex + 1} 题`;
  if (!question || typeof question !== "object") {
    issues.push(`${path} 不是有效题目对象`);
    return;
  }
  validateOptionBasics(section, question, path, issues);

  if (section.type === "pronunciationChoice") {
    validatePronunciationChoice(question, path, issues);
    return;
  }
  if (section.type === "pinyinWriteWord") {
    validatePinyinWord(question, path, issues);
    return;
  }
  if (section.type === "confusingCharFill") {
    validateConfusingCharFill(question, path, issues);
    return;
  }
  if (section.type === "contextualPinyinWrite") {
    validatePinyinWord(question, path, issues, true);
    return;
  }
  if (section.type === "mixedErrorChoice") {
    validateMixedChoice(question, path, issues);
    return;
  }
  if (section.type === "meaningSameChoice") {
    validateMeaningSameChoice(question, path, issues);
    return;
  }
  if (section.type === "wordSentence") {
    const word = String(question.word || question.term || question.answerWord || "").trim();
    if (!cjkChars(word).length) {
      issues.push(`${path} 组词造句缺少目标词`);
    }
  }
}

function validateGeneratedContent(payload) {
  const issues = [];
  payload.sections.forEach(section => {
    (section.questions || []).forEach((question, index) => validateQuestion(section, question, index, issues));
  });

  return issues;
}

function repairGeneratedContent(payload) {
  payload.sections.forEach(section => {
    (section.questions || []).forEach(question => {
      if (section.type === "confusingCharFill") {
        const stem = String(question.stem || question.prompt || question.sentence || question.text || "").trim();
        const answer = String(question.answer || question.answerText || "").trim();
        const answerWord = String(question.answerWord || question.word || "").trim();
        const autoCompleted = replaceFirstPlaceholder(stem, answer);
        if (answer && stem && (!question.completedSentence || (answerWord && !String(question.completedSentence).includes(answerWord) && autoCompleted.includes(answerWord)))) {
          question.completedSentence = autoCompleted;
        }
      }

      if (section.type === "contextualPinyinWrite") {
        const word = String(question.word || question.term || question.answerWord || "").trim();
        const stem = String(question.stem || question.prompt || question.sentence || question.text || "").trim();
        if (word && stem && !hasPlaceholder(stem) && stem.includes(word)) {
          question.stem = stem.replace(word, "____");
        }
      }
    });
  });
}

const sectionInstructions = {
  pronunciationChoice: "读词语，选择加点字的正确读音。",
  pinyinWriteWord: "看拼音，写词语。",
  confusingCharFill: "选择正确的字填入句子中。",
  contextualPinyinWrite: "根据语境和拼音写出词语。",
  mixedErrorChoice: "选择字音字形错误最多的一项。",
  meaningSameChoice: "选择加点字意思相同的一项。",
  wordSentence: "用词语造句。"
};

function typeMultiplierFor(input, type) {
  const raw = input?.typeMultipliers && typeof input.typeMultipliers === "object"
    ? input.typeMultipliers[type]
    : 1;
  const multiplier = Number(raw) || 1;
  return Math.min(Math.max(Math.round(multiplier), 1), 3);
}

function expectedQuestionCount(input, type = "") {
  const base = parseWrongChars(input.wrongChars).length || 1;
  return type ? base * typeMultiplierFor(input, type) : base;
}

function createSection(type) {
  return {
    type,
    title: typeLabels[type] || type,
    instruction: sectionInstructions[type] || "",
    questions: []
  };
}

function ensureTargetSections(payload, expectedTypes) {
  if (!expectedTypes.length) return;
  const byType = new Map();
  (payload.sections || []).forEach(section => {
    if (!section || !section.type || !expectedTypes.includes(section.type)) return;
    if (!byType.has(section.type)) {
      byType.set(section.type, section);
      return;
    }
    const existing = byType.get(section.type);
    existing.questions = [
      ...(existing.questions || []),
      ...(Array.isArray(section.questions) ? section.questions : [])
    ];
  });

  payload.sections = expectedTypes.map(type => {
    const section = byType.get(type) || createSection(type);
    return {
      ...createSection(type),
      ...section,
      type,
      title: section.title || typeLabels[type] || type,
      instruction: section.instruction || sectionInstructions[type] || "",
      questions: Array.isArray(section.questions) ? section.questions.filter(Boolean) : []
    };
  });
}

function collectTargetIssues(payload, input) {
  const expectedTypes = parseTypes(input.types);
  const invalidNotes = [];
  const slots = [];

  repairGeneratedContent(payload);
  ensureTargetSections(payload, expectedTypes);

  payload.sections.forEach(section => {
    const questionCount = expectedQuestionCount(input, section.type);
    const validQuestions = [];
    (section.questions || []).forEach((question, originalIndex) => {
      const issues = [];
      validateQuestion(section, question, validQuestions.length, issues);
      if (!issues.length && validQuestions.length < questionCount) {
        validQuestions.push(question);
        return;
      }
      if (issues.length) {
        invalidNotes.push({
          type: section.type,
          title: section.title || typeLabels[section.type] || section.type,
          originalIndex,
          issue: issues[0]
        });
      }
    });
    section.questions = validQuestions;
  });

  payload.sections.forEach(section => {
    const questionCount = expectedQuestionCount(input, section.type);
    const notes = invalidNotes
      .filter(note => note.type === section.type)
      .map(note => `原第 ${note.originalIndex + 1} 题：${note.issue}`);
    for (let index = section.questions.length; index < questionCount; index += 1) {
      slots.push({
        type: section.type,
        title: section.title || typeLabels[section.type] || section.type,
        index,
        issue: notes.shift() || `${section.title || typeLabels[section.type] || section.type}缺少第 ${index + 1} 题`
      });
    }
  });

  return {
    valid: slots.length === 0,
    slots,
    issues: [
      ...invalidNotes.map(note => `${note.title}原第 ${note.originalIndex + 1} 题：${note.issue}`),
      ...slots.map(slot => `${slot.title}第 ${slot.index + 1} 题需要补题：${slot.issue}`)
    ]
  };
}

function answerTextForQuestion(section, question) {
  if (section.type === "pinyinWriteWord" || section.type === "contextualPinyinWrite" || section.type === "wordSentence") {
    return String(question.word || question.term || question.answerWord || "");
  }
  if (section.type === "confusingCharFill") {
    return String(question.answerWord || question.word || question.answerText || question.answer || "");
  }
  if (question.answerText) return String(question.answerText);
  const index = answerIndex(question.answer);
  if (index >= 0 && Array.isArray(question.options) && question.options[index] !== undefined) {
    return optionText(question.options[index]);
  }
  return String(question.answer || "");
}

function rebuildAnswerKey(payload) {
  payload.answerKey = (payload.sections || []).map(section => ({
    sectionType: section.type,
    title: section.title || typeLabels[section.type] || section.type,
    items: (section.questions || []).map((question, index) => ({
      id: question.id || `${section.type}-${index + 1}`,
      answer: question.answer || answerTextForQuestion(section, question),
      answerText: answerTextForQuestion(section, question),
      explanation: question.explanation || question.reason || "",
      corrections: Array.isArray(question.corrections) ? question.corrections : []
    }))
  }));
}

function finalizeGeneratedPayload(payload, input, repairInfo) {
  const result = collectTargetIssues(payload, input);
  if (!result.valid) {
    const error = new Error(`连续补题后仍未得到足量正确题目：${result.issues.slice(0, 8).join("；")}。`);
    error.status = 422;
    error.issues = result.issues;
    throw error;
  }
  rebuildAnswerKey(payload);
  if (repairInfo && repairInfo.replaced > 0) {
    payload.repairInfo = repairInfo;
  }
  return payload;
}

function assertGeneratedContent(payload) {
  repairGeneratedContent(payload);
  const issues = validateGeneratedContent(payload);
  if (issues.length) {
    const error = new Error(`内容校验未通过：${issues.slice(0, 8).join("；")}${issues.length > 8 ? "；请重新生成。" : "。"}`);
    error.status = 422;
    error.issues = issues;
    throw error;
  }
}

function normalizeGenerated(payload, options = {}) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Model returned a non-object JSON payload.");
  }
  if (!Array.isArray(payload.sections)) {
    throw new Error("Model JSON is missing sections.");
  }
  if (!Array.isArray(payload.answerKey)) {
    payload.answerKey = [];
  }

  payload.sections = payload.sections
    .filter(section => section && typeof section === "object")
    .map((section, sectionIndex) => ({
      type: section.type || `section${sectionIndex + 1}`,
      title: section.title || typeLabels[section.type] || `第 ${sectionIndex + 1} 题`,
      instruction: section.instruction || "",
      questions: Array.isArray(section.questions) ? section.questions.map(normalizeQuestionOptions) : []
    }))
    .filter(section => section.questions.length);

  if (Array.isArray(options.expectedTypes) && options.expectedTypes.length) {
    ensureTargetSections(payload, options.expectedTypes);
  }

  if (!payload.sections.length) {
    throw new Error("Model JSON contains no renderable questions.");
  }
  if (!options.skipContentValidation) {
    assertGeneratedContent(payload);
  }
  return payload;
}

function describeFetchError(error, baseUrl) {
  const parts = [`Unable to reach API endpoint: ${baseUrl}`];
  if (error.message) parts.push(error.message);
  if (error.cause) {
    const cause = error.cause;
    const causeParts = [cause.code, cause.errno, cause.syscall, cause.hostname, cause.host, cause.port]
      .filter(Boolean)
      .map(String);
    if (cause.message) causeParts.push(cause.message);
    if (causeParts.length) parts.push(`cause: ${causeParts.join(" | ")}`);
  }
  return parts.join(" - ");
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseApiErrorText(text) {
  const fallback = String(text || "").trim();
  try {
    const json = JSON.parse(fallback);
    const error = json.error || json;
    return {
      message: String(error.message || json.message || fallback || ""),
      type: String(error.type || ""),
      code: String(error.code || "")
    };
  } catch {
    return {
      message: fallback,
      type: "",
      code: ""
    };
  }
}

function isRetryableApiStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function apiRetryDelayMs(attempt) {
  return [1000, 2200][attempt] || 2200;
}

function formatApiError(status, text, retryCount) {
  const details = parseApiErrorText(text);
  const message = details.message || "接口没有返回可读错误信息";
  const busy = status === 503 || /service.*busy|too busy|service_unavailable|temporarily/i.test(`${message} ${details.type} ${details.code}`);
  const retried = retryCount > 0 ? `已自动重试 ${retryCount} 次，` : "";

  if (busy) {
    return `模型服务繁忙（${status}），${retried}仍未成功。请稍后再点“生成练习”，或在 API 配置里切换模型/接口。`;
  }
  if (status === 429) {
    return `模型接口限流（429），${retried}仍未成功。请稍后重试，或减少错字数量/题型后再生成。`;
  }
  if (status === 401 || status === 403) {
    return `API 鉴权失败（${status}）。请检查 API Key、Base URL 和模型名称是否匹配。`;
  }
  if (status >= 500) {
    return `模型接口暂时不可用（${status}），${retried}仍未成功。请稍后重试或切换接口。`;
  }
  return `模型接口请求失败（${status}）：${message}`;
}

function postJson(urlString, headers, payload, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = JSON.stringify(payload);
    const transport = url.protocol === "https:" ? https : http;
    const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 30000, 15000), 180000);
    const req = transport.request({
      method: "POST",
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: {
        ...headers,
        "content-length": Buffer.byteLength(body)
      },
      rejectUnauthorized: options.allowInsecureTLS ? false : true,
      timeout: timeoutMs
    }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        text += chunk;
      });
      res.on("end", () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text
        });
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`API request timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function slotKey(type, index) {
  return `${type}:${index}`;
}

const repairTypeRules = {
  pronunciationChoice: "pronunciationChoice 字段：word、char、stem、options、answer、answerText、explanation；options 固定 3 个读音候选，读音必须带声调，不能只改声调。",
  pinyinWriteWord: "pinyinWriteWord 字段：word、pinyin；pinyin 必须带声调，word 以 2-4 字为主。",
  confusingCharFill: "confusingCharFill 字段：stem、options、answer、answerWord、completedSentence、explanation；填入后必须形成真实常用词语。",
  contextualPinyinWrite: "contextualPinyinWrite 字段：word、pinyin、stem；stem 必须包含 ____ 书写位置，pinyin 必须带声调。",
  mixedErrorChoice: "mixedErrorChoice 字段：stem、options、answer、answerText、explanation；选项至少 4 个且只有一个正确答案；每题必须同时出现读音错误和可信字形错误，答案项应包含字形错误改正。",
  meaningSameChoice: "meaningSameChoice 字段：stem、options、answer、answerText、explanation；每个 option 必须是 {words,targetChar,sameMeaning,reason}，且只有一个 sameMeaning=true；同一道题四个选项里的词语不得重复。",
  wordSentence: "wordSentence 字段：word；必须是适合学生造句的正确词语。"
};

function usedQuestionSummary(payload) {
  const items = [];
  (payload.sections || []).forEach(section => {
    (section.questions || []).forEach(question => {
      const text = answerTextForQuestion(section, question) || question.word || question.stem || "";
      const clean = String(text || "").replace(/\s+/g, "");
      if (clean) items.push(clean.slice(0, 12));
    });
  });
  return Array.from(new Set(items)).slice(0, 80).join("、");
}

function buildRepairMessages(input, payload, slots) {
  const grade = input.grade || "三年级";
  const textbookVersion = String(input.textbookVersion || "统编版小学语文").slice(0, 30);
  const wrongChars = parseWrongChars(input.wrongChars);
  const typeRules = Array.from(new Set(slots.map(slot => slot.type)))
    .map(type => repairTypeRules[type] || `${type}: 按原题型补题。`);
  const slotList = slots.map(slot => ({
    type: slot.type,
    title: slot.title,
    index: slot.index,
    questionNumber: slot.index + 1,
    issue: slot.issue
  }));

  return [
    {
      role: "system",
      content: [
        `你是${grade}${textbookVersion}字词练习命题老师。`,
        "你只补写指定位置的题目，只返回合法 JSON，不要 Markdown，不要解释。",
        "题目必须符合对应年级课内常见字词，句子自然，答案准确唯一。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "当前练习有少量题目不合格或数量不足。请只补写下面这些位置的新题。",
        `年级：${grade}；孩子错字：${wrongChars.join("、")}`,
        `已有合格答案/词语，尽量避免重复：${usedQuestionSummary(payload) || "无"}`,
        "补题必须保持原题型要求、同年级课内难度、句子自然通顺、答案唯一。",
        "所有拼音必须带声调。所有 options 不要带 A./B./C./D. 编号，且同题不得重复。",
        "本次涉及题型字段规则：",
        ...typeRules,
        "只返回合法 JSON，格式如下：",
        "{\"replacements\":[{\"type\":\"confusingCharFill\",\"index\":1,\"question\":{...}}]}",
        "index 从 0 开始，必须逐一对应下面 slot，不要返回整份练习。",
        JSON.stringify(slotList, null, 2)
      ].join("\n")
    }
  ];
}

function replacementItemsFromPayload(payload, slots) {
  const items = [];
  if (!payload || typeof payload !== "object") return items;

  if (Array.isArray(payload.replacements)) {
    payload.replacements.forEach(item => {
      if (!item || typeof item !== "object") return;
      const question = item.question || item.item || item.content;
      items.push({
        type: item.type || item.sectionType,
        index: Number(item.index ?? item.questionIndex ?? item.position),
        question
      });
    });
    return items;
  }

  const queues = new Map();
  slots.forEach(slot => {
    if (!queues.has(slot.type)) queues.set(slot.type, []);
    queues.get(slot.type).push(slot);
  });

  if (Array.isArray(payload.sections)) {
    payload.sections.forEach(section => {
      if (!section || typeof section !== "object" || !Array.isArray(section.questions)) return;
      const queue = queues.get(section.type || section.sectionType) || [];
      section.questions.forEach((question, order) => {
        const index = Number(question?.index ?? question?.questionIndex ?? queue[order]?.index);
        items.push({
          type: section.type || section.sectionType,
          index,
          question
        });
      });
    });
  }

  return items;
}

function applyReplacementPayload(targetPayload, replacementPayload, slots) {
  const expectedTypes = Array.from(new Set([
    ...(targetPayload.sections || []).map(section => section.type).filter(Boolean),
    ...slots.map(slot => slot.type)
  ]));
  ensureTargetSections(targetPayload, expectedTypes);
  const slotMap = new Map(slots.map(slot => [slotKey(slot.type, slot.index), slot]));
  let applied = 0;

  replacementItemsFromPayload(replacementPayload, slots).forEach(item => {
    const type = item.type;
    const index = Number(item.index);
    const key = slotKey(type, index);
    if (!slotMap.has(key) || !item.question || typeof item.question !== "object") return;

    const section = targetPayload.sections.find(current => current.type === type);
    if (!section) return;
    section.questions[index] = normalizeQuestionOptions({
      ...item.question,
      id: item.question.id || `${type}-${index + 1}`
    });
    applied += 1;
  });

  return applied;
}

const localMaterialBank = [
  {
    char: "拔",
    pinyin: "bá",
    confusables: ["拨", "跋", "把"],
    words: [
      { word: "拔河", pinyin: "bá hé", sentence: "运动会上，我们班参加了拔河比赛。", meaning: "双方用力拉绳子的比赛" },
      { word: "拔草", pinyin: "bá cǎo", sentence: "周末，我和爷爷一起在菜地里拔草。", meaning: "把草连根拉出来" },
      { word: "拔高", pinyin: "bá gāo", sentence: "写作文时，不能故意拔高主题。", meaning: "提高" }
    ],
    meaningOptions: [
      { words: ["拔草", "拔河"], targetChar: "拔", sameMeaning: true, reason: "都表示用力拉。" },
      { words: ["拔高", "拔草"], targetChar: "拔", sameMeaning: false, reason: "拔高是提高，拔草是拉出草。" },
      { words: ["拔尖", "拔河"], targetChar: "拔", sameMeaning: false, reason: "拔尖是突出，拔河是拉绳。" },
      { words: ["海拔", "拔牙"], targetChar: "拔", sameMeaning: false, reason: "海拔指高度，拔牙是拉出牙。" }
    ]
  },
  {
    char: "戴",
    pinyin: "dài",
    confusables: ["带", "代", "待"],
    words: [
      { word: "戴帽子", pinyin: "dài mào zi", sentence: "下雨了，妈妈戴上帽子出门。", meaning: "把帽子放在头上" },
      { word: "佩戴", pinyin: "pèi dài", sentence: "少先队员佩戴着鲜艳的红领巾。", meaning: "把标志物戴在身上" },
      { word: "戴眼镜", pinyin: "dài yǎn jìng", sentence: "哥哥看书时总是戴眼镜。", meaning: "把眼镜架在脸上" }
    ],
    meaningOptions: [
      { words: ["戴帽子", "戴眼镜"], targetChar: "戴", sameMeaning: true, reason: "都表示把东西放在身上某处。" },
      { words: ["佩戴", "爱戴"], targetChar: "戴", sameMeaning: false, reason: "佩戴是戴在身上，爱戴是敬爱。" },
      { words: ["戴帽子", "爱戴"], targetChar: "戴", sameMeaning: false, reason: "一个是穿戴，一个是敬爱。" },
      { words: ["穿戴", "戴罪"], targetChar: "戴", sameMeaning: false, reason: "穿戴是装束，戴罪是承担罪名。" }
    ]
  },
  {
    char: "辨",
    pinyin: "biàn",
    confusables: ["辩", "辫", "瓣"],
    words: [
      { word: "辨别", pinyin: "biàn bié", sentence: "我们要学会辨别方向。", meaning: "分清楚不同之处" },
      { word: "分辨", pinyin: "fēn biàn", sentence: "雾太大了，我分辨不清远处的房子。", meaning: "区别、认出" },
      { word: "辨认", pinyin: "biàn rèn", sentence: "警察叔叔正在辨认脚印。", meaning: "根据特点认出来" }
    ],
    meaningOptions: [
      { words: ["辨别", "分辨"], targetChar: "辨", sameMeaning: true, reason: "都表示分清、区别。" },
      { words: ["辨认", "辨别"], targetChar: "辨", sameMeaning: true, reason: "都和分清事物有关。" },
      { words: ["辨别", "争辨"], targetChar: "辨", sameMeaning: false, reason: "辨别是区分，争辨不是正确字形。" },
      { words: ["分辨", "花辨"], targetChar: "辨", sameMeaning: false, reason: "花辨不是正确词语。" }
    ]
  },
  {
    char: "静",
    pinyin: "jìng",
    confusables: ["净", "靖", "境"],
    words: [
      { word: "安静", pinyin: "ān jìng", sentence: "上课时，教室里非常安静。", meaning: "没有声音或很少声音" },
      { word: "平静", pinyin: "píng jìng", sentence: "听完老师的话，我的心情渐渐平静下来。", meaning: "心情安定" },
      { word: "宁静", pinyin: "níng jìng", sentence: "夜晚的湖边十分宁静。", meaning: "安静、平和" }
    ],
    meaningOptions: [
      { words: ["安静", "宁静"], targetChar: "静", sameMeaning: true, reason: "都表示安静。" },
      { words: ["平静", "安静"], targetChar: "静", sameMeaning: false, reason: "平静多指心情，安静多指环境。" },
      { words: ["静止", "安静"], targetChar: "静", sameMeaning: false, reason: "静止是不动，安静是少声音。" },
      { words: ["冷静", "宁静"], targetChar: "静", sameMeaning: false, reason: "冷静指沉着，宁静指安宁。" }
    ]
  },
  {
    char: "察",
    pinyin: "chá",
    confusables: ["查", "擦", "嚓"],
    words: [
      { word: "观察", pinyin: "guān chá", sentence: "科学课上，我们仔细观察蚂蚁搬家。", meaning: "仔细看并发现特点" },
      { word: "察看", pinyin: "chá kàn", sentence: "老师走近花坛，察看小苗的生长情况。", meaning: "仔细看" },
      { word: "警察", pinyin: "jǐng chá", sentence: "警察叔叔帮助迷路的小朋友回家。", meaning: "维护安全的人" }
    ],
    meaningOptions: [
      { words: ["观察", "察看"], targetChar: "察", sameMeaning: true, reason: "都表示仔细看。" },
      { words: ["警察", "观察"], targetChar: "察", sameMeaning: false, reason: "警察是职业，观察是仔细看。" },
      { words: ["察觉", "警察"], targetChar: "察", sameMeaning: false, reason: "察觉是发觉，警察是人。" },
      { words: ["明察", "察看"], targetChar: "察", sameMeaning: true, reason: "都含仔细看、了解的意思。" }
    ]
  },
  {
    char: "做",
    pinyin: "zuò",
    confusables: ["作", "坐", "座"],
    words: [
      { word: "做作业", pinyin: "zuò zuò yè", sentence: "我每天认真做作业。", meaning: "完成作业" },
      { word: "做饭", pinyin: "zuò fàn", sentence: "爸爸正在厨房里做饭。", meaning: "烹调饭菜" },
      { word: "做事", pinyin: "zuò shì", sentence: "做事要认真，不能马虎。", meaning: "办事情" }
    ],
    meaningOptions: [
      { words: ["做事", "做饭"], targetChar: "做", sameMeaning: true, reason: "都表示从事某件事。" },
      { words: ["做作业", "做饭"], targetChar: "做", sameMeaning: true, reason: "都表示完成具体事情。" },
      { words: ["做人", "做饭"], targetChar: "做", sameMeaning: false, reason: "做人指处世，做饭指烹调。" },
      { words: ["做梦", "做事"], targetChar: "做", sameMeaning: false, reason: "做梦是梦见，做事是办事。" }
    ]
  },
  {
    char: "在",
    pinyin: "zài",
    confusables: ["再", "载", "栽"],
    words: [
      { word: "正在", pinyin: "zhèng zài", sentence: "妹妹正在认真写作业。", meaning: "动作进行中" },
      { word: "在家", pinyin: "zài jiā", sentence: "周末，我在家读书。", meaning: "处在家里" },
      { word: "存在", pinyin: "cún zài", sentence: "这个问题仍然存在。", meaning: "有、出现" }
    ],
    meaningOptions: [
      { words: ["在家", "在校"], targetChar: "在", sameMeaning: true, reason: "都表示处在某地。" },
      { words: ["正在", "在家"], targetChar: "在", sameMeaning: false, reason: "正在表动作进行，在家表地点。" },
      { words: ["存在", "在校"], targetChar: "在", sameMeaning: false, reason: "存在表示有，在校表示地点。" },
      { words: ["在意", "在家"], targetChar: "在", sameMeaning: false, reason: "在意是放在心上，在家是地点。" }
    ]
  },
  {
    char: "的",
    pinyin: "de",
    confusables: ["地", "得", "底"],
    words: [
      { word: "美丽的", pinyin: "měi lì de", sentence: "美丽的花园里开满了花。", meaning: "修饰名词" },
      { word: "我的", pinyin: "wǒ de", sentence: "这是我的语文书。", meaning: "表示所属" },
      { word: "红红的", pinyin: "hóng hóng de", sentence: "红红的太阳升起来了。", meaning: "修饰名词" }
    ],
    meaningOptions: [
      { words: ["我的", "美丽的"], targetChar: "的", sameMeaning: true, reason: "都用于修饰或连接名词。" },
      { words: ["的确", "我的"], targetChar: "的", sameMeaning: false, reason: "的确表示确实，我的是助词。" },
      { words: ["目的", "红红的"], targetChar: "的", sameMeaning: false, reason: "目的里的的不是助词。" },
      { words: ["有的", "美丽的"], targetChar: "的", sameMeaning: false, reason: "有的指一部分，美丽的是修饰名词。" }
    ]
  }
];

const commonConfusingChars = ["拔", "拨", "戴", "带", "辨", "辩", "辫", "瓣", "静", "净", "察", "查", "做", "作", "在", "再", "的", "地", "得"];
const commonPronunciationOptions = ["bá", "bō", "dài", "dǎi", "biàn", "bàn", "jìng", "jǐng", "chá", "cá", "zuò", "zuō", "zài", "zǎi", "de", "dì"];
const pinyinStructuralAlternates = {
  hao: ["gao", "kao"],
  yi: ["qi", "ji"],
  rong: ["long", "yong"],
  ang: ["yang", "wang"],
  yang: ["xiang", "ang"],
  feng: ["peng", "fen"],
  qiang: ["jiang", "xiang"],
  huang: ["guang", "wang"],
  hong: ["gong", "heng"],
  shi: ["si", "chi"],
  di: ["ti", "ji"],
  fa: ["hua", "pa"],
  ba: ["pa", "bo"],
  dai: ["tai", "gai"],
  bian: ["pian", "ban"],
  jing: ["qing", "jin"],
  cha: ["ca", "zha"],
  zuo: ["cuo", "zhuo"],
  zai: ["cai", "zhai"],
  de: ["di", "dei"]
};
const pinyinInitials = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "z", "c", "s", "r", "y", "w"];
const pinyinInitialAlternates = {
  b: ["p"],
  p: ["b"],
  d: ["t"],
  t: ["d"],
  g: ["k", "h"],
  k: ["g"],
  h: ["g"],
  j: ["q"],
  q: ["j", "x"],
  x: ["q"],
  z: ["zh", "c"],
  zh: ["z"],
  c: ["ch", "z"],
  ch: ["c"],
  s: ["sh"],
  sh: ["s"],
  l: ["n", "r"],
  n: ["l"],
  r: ["l"],
  f: ["h"]
};
const pinyinFinalAlternates = {
  an: ["ang"],
  ang: ["an"],
  en: ["eng"],
  eng: ["en"],
  in: ["ing"],
  ing: ["in"],
  ao: ["ou"],
  ou: ["ao"],
  ai: ["ei"],
  ei: ["ai"],
  ian: ["iang"],
  iang: ["ian"],
  uan: ["uang"],
  uang: ["uan"],
  ong: ["eng"]
};
const pinyinToneMarks = {
  a: ["ā", "á", "ǎ", "à"],
  e: ["ē", "é", "ě", "è"],
  i: ["ī", "í", "ǐ", "ì"],
  o: ["ō", "ó", "ǒ", "ò"],
  u: ["ū", "ú", "ǔ", "ù"],
  v: ["ǖ", "ǘ", "ǚ", "ǜ"]
};
const pinyinToneLookup = Object.entries(pinyinToneMarks).reduce((map, [plain, marks]) => {
  marks.forEach((mark, index) => {
    map[mark] = { plain, tone: index + 1 };
  });
  return map;
}, { ü: { plain: "v", tone: 0 } });
const localMaterialByChar = new Map(localMaterialBank.map(item => [item.char, item]));
const localWordPinyin = new Map(localMaterialBank.flatMap(item => item.words.map(word => [word.word, word.pinyin])));

function loadTextbookWordBank() {
  const filePath = path.join(rootDir, "data", "word-bank.json");
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      chars: Array.isArray(payload.chars) ? payload.chars : [],
      words: Array.isArray(payload.words) ? payload.words : [],
      counts: payload.counts || {}
    };
  } catch (error) {
    console.warn(`Textbook word bank not loaded: ${error.message}`);
    return { chars: [], words: [], counts: {} };
  }
}

const textbookWordBank = loadTextbookWordBank();
const textbookCharEntries = textbookWordBank.chars
  .filter(item => item && item.char && item.pinyin)
  .map(item => ({
    ...item,
    char: firstCjk(item.char),
    pinyin: String(item.pinyin || "").trim(),
    words: Array.isArray(item.words) ? item.words : [],
    confusables: Array.isArray(item.confusables) ? item.confusables.map(firstCjk).filter(Boolean) : []
  }))
  .filter(item => item.char);
const textbookWordEntries = textbookWordBank.words
  .filter(item => item && item.word && item.pinyin && hasToneMark(item.pinyin))
  .map(item => ({
    ...item,
    word: String(item.word || "").trim(),
    pinyin: String(item.pinyin || "").trim()
  }));
const textbookWordPinyin = new Map();
textbookWordEntries.forEach(item => {
  if (!textbookWordPinyin.has(item.word)) textbookWordPinyin.set(item.word, item.pinyin);
});
textbookCharEntries.forEach(item => {
  (item.words || []).forEach(word => {
    if (word?.word && word?.pinyin && hasToneMark(word.pinyin) && !textbookWordPinyin.has(word.word)) {
      textbookWordPinyin.set(word.word, word.pinyin);
    }
  });
});

function baseGrade(value) {
  return String(value || "").match(/[一二三四五六]年级/)?.[0] || String(value || "").trim();
}

function gradeMatches(item, grade) {
  const target = baseGrade(grade);
  if (!target) return true;
  return baseGrade(item?.grade || item?.sourceGrade || "") === target;
}

function firstPinyinReading(value) {
  return String(value || "")
    .split(/[;；、/]/)
    .map(item => item.trim())
    .find(item => item && hasToneMark(item)) || "";
}

function textbookEntriesForChar(char, grade = "") {
  const cleanChar = firstCjk(char);
  if (!cleanChar) return [];
  const exactGrade = textbookCharEntries.filter(item => item.char === cleanChar && gradeMatches(item, grade));
  return exactGrade.length ? exactGrade : textbookCharEntries.filter(item => item.char === cleanChar);
}

function bestTextbookCharEntry(char, grade = "") {
  const entries = textbookEntriesForChar(char, grade);
  return entries
    .slice()
    .sort((a, b) => (b.words?.length || 0) - (a.words?.length || 0))[0] || null;
}

function textbookCharPinyin(char, grade = "") {
  const entry = bestTextbookCharEntry(char, grade);
  return firstPinyinReading(entry?.pinyin) || "";
}

function textbookWordItemsForGrade(grade) {
  const gradeWords = textbookWordEntries.filter(item => gradeMatches(item, grade));
  const fallbackWords = gradeWords.length ? gradeWords : textbookWordEntries;
  return uniqueBy(fallbackWords, item => item.word)
    .map(item => ({ word: item.word, pinyin: item.pinyin }));
}

function textbookWordsForChar(char, grade = "", limit = 8) {
  const cleanChar = firstCjk(char);
  if (!cleanChar) return [];
  const fromCharEntries = textbookEntriesForChar(cleanChar, grade).flatMap(entry => (
    Array.isArray(entry.words) ? entry.words : []
  ));
  const fromWordEntries = textbookWordEntries
    .filter(item => item.word.includes(cleanChar) && gradeMatches(item, grade));
  const fallbackWordEntries = fromWordEntries.length
    ? []
    : textbookWordEntries.filter(item => item.word.includes(cleanChar));
  return uniqueBy([
    ...fromCharEntries,
    ...fromWordEntries,
    ...fallbackWordEntries
  ].map(item => ({
    word: String(item.word || "").trim(),
    pinyin: repairWordPinyin(String(item.word || "").trim(), String(item.pinyin || "").trim()),
    sentence: `请正确书写“${String(item.word || "").trim()}”这个词。`,
    meaning: "教材常见词语"
  })).filter(item => item.word && item.word.includes(cleanChar) && item.pinyin && hasToneMark(item.pinyin)), item => item.word).slice(0, limit);
}

function textbookMeaningOptions(char, words) {
  return [];
}

function textbookMaterialForChar(char, grade = "") {
  const cleanChar = firstCjk(char);
  const entry = bestTextbookCharEntry(cleanChar, grade);
  if (!entry) return null;
  const words = textbookWordsForChar(cleanChar, grade);
  const pinyin = firstPinyinReading(entry.pinyin)
    || syllableForChar(words[0]?.word || "", words[0]?.pinyin || "", cleanChar)
    || "";
  return {
    char: cleanChar,
    grade: baseGrade(grade),
    pinyin,
    confusables: entry.confusables || [],
    words,
    meaningOptions: textbookMeaningOptions(cleanChar, words)
  };
}

function supplementalMaterialForChar(char, grade = "") {
  const cleanChar = firstCjk(char);
  const local = localMaterialByChar.get(cleanChar);
  const textbook = textbookMaterialForChar(cleanChar, grade);
  if (!local && !textbook) return null;
  return {
    char: cleanChar,
    grade: baseGrade(grade),
    pinyin: textbook?.pinyin || local?.pinyin || "",
    confusables: Array.from(new Set([
      ...(textbook?.confusables || []),
      ...(local?.confusables || [])
    ].map(firstCjk).filter(item => item && item !== cleanChar))).slice(0, 8),
    words: uniqueBy([
      ...(textbook?.words || []),
      ...(local?.words || [])
    ], item => item.word).slice(0, 10),
    meaningOptions: uniqueBy([
      ...(local?.meaningOptions || []),
      ...(textbook?.meaningOptions || [])
    ], item => `${item.targetChar}:${item.words.join("|")}`).slice(0, 6)
  };
}

const supplementalWordPinyin = new Map([
  ["作业", "zuò yè"],
  ["作文", "zuò wén"],
  ["动作", "dòng zuò"],
  ["做手工", "zuò shǒu gōng"],
  ["做游戏", "zuò yóu xì"],
  ["再见", "zài jiàn"],
  ["再次", "zài cì"],
  ["再三", "zài sān"],
  ["地方", "dì fāng"],
  ["大地", "dà dì"],
  ["草地", "cǎo dì"],
  ["得到", "dé dào"],
  ["得意", "dé yì"],
  ["得分", "dé fēn"],
  ["快乐的", "kuài lè de"],
  ["红的", "hóng de"],
  ["戴红领巾", "dài hóng lǐng jīn"]
]);
const supplementalCharPinyin = new Map([
  ["作", "zuò"],
  ["业", "yè"],
  ["文", "wén"],
  ["动", "dòng"],
  ["再", "zài"],
  ["次", "cì"],
  ["三", "sān"],
  ["地", "dì"],
  ["方", "fāng"],
  ["大", "dà"],
  ["草", "cǎo"],
  ["得", "dé"],
  ["到", "dào"],
  ["意", "yì"],
  ["分", "fēn"],
  ["快", "kuài"],
  ["乐", "lè"],
  ["红", "hóng"],
  ["字", "zì"]
]);
const textbookConfusingChars = textbookCharEntries.flatMap(item => [item.char, ...(item.confusables || [])]);
const fallbackConfusingChars = Array.from(new Set([
  ...textbookConfusingChars,
  ...localMaterialBank.flatMap(item => [item.char, ...(item.confusables || [])]),
  ...commonConfusingChars
].filter(Boolean)));
const gradeSupplementWordBank = {
  "一年级": [
    { word: "太阳", pinyin: "tài yáng" },
    { word: "小河", pinyin: "xiǎo hé" },
    { word: "学校", pinyin: "xué xiào" },
    { word: "花朵", pinyin: "huā duǒ" },
    { word: "朋友", pinyin: "péng yǒu" },
    { word: "天空", pinyin: "tiān kōng" }
  ],
  "二年级": [
    { word: "办法", pinyin: "bàn fǎ" },
    { word: "知识", pinyin: "zhī shí" },
    { word: "城市", pinyin: "chéng shì" },
    { word: "海洋", pinyin: "hǎi yáng" },
    { word: "故事", pinyin: "gù shì" },
    { word: "温暖", pinyin: "wēn nuǎn" }
  ],
  "三年级": [
    { word: "观察", pinyin: "guān chá" },
    { word: "准备", pinyin: "zhǔn bèi" },
    { word: "旅行", pinyin: "lǚ xíng" },
    { word: "勇敢", pinyin: "yǒng gǎn" },
    { word: "清楚", pinyin: "qīng chǔ" },
    { word: "继续", pinyin: "jì xù" },
    { word: "安静", pinyin: "ān jìng" },
    { word: "普通", pinyin: "pǔ tōng" }
  ],
  "四年级": [
    { word: "宽阔", pinyin: "kuān kuò" },
    { word: "均匀", pinyin: "jūn yún" },
    { word: "临时", pinyin: "lín shí" },
    { word: "著名", pinyin: "zhù míng" },
    { word: "逐渐", pinyin: "zhú jiàn" },
    { word: "慎重", pinyin: "shèn zhòng" }
  ],
  "五年级": [
    { word: "吩咐", pinyin: "fēn fù" },
    { word: "珍贵", pinyin: "zhēn guì" },
    { word: "协调", pinyin: "xié tiáo" },
    { word: "隐蔽", pinyin: "yǐn bì" },
    { word: "繁殖", pinyin: "fán zhí" },
    { word: "黎明", pinyin: "lí míng" }
  ],
  "六年级": [
    { word: "慷慨", pinyin: "kāng kǎi" },
    { word: "抵御", pinyin: "dǐ yù" },
    { word: "沮丧", pinyin: "jǔ sàng" },
    { word: "澄碧", pinyin: "chéng bì" },
    { word: "贡献", pinyin: "gòng xiàn" },
    { word: "陶醉", pinyin: "táo zuì" }
  ]
};
const commonSupplementWords = [
  { word: "认真", pinyin: "rèn zhēn" },
  { word: "美丽", pinyin: "měi lì" },
  { word: "活动", pinyin: "huó dòng" },
  { word: "发现", pinyin: "fā xiàn" },
  { word: "帮助", pinyin: "bāng zhù" },
  { word: "整齐", pinyin: "zhěng qí" }
];
const pinyinConfusableHints = {
  rong: ["戎", "荣", "容", "溶", "融"],
  ang: ["仰", "昂", "迎"],
  yang: ["杨", "阳", "洋", "扬"],
  feng: ["凤", "枫", "疯"],
  qiang: ["蔷", "樯", "抢"],
  huang: ["恍", "幌", "煌"],
  ba: ["拔", "拨", "跋", "把"],
  dai: ["戴", "带", "代", "待"],
  bian: ["辨", "辩", "辫", "瓣"],
  jing: ["静", "净", "镜", "境"],
  cha: ["察", "查", "擦"],
  zuo: ["做", "作", "坐", "座"],
  zai: ["在", "再", "载", "栽"],
  de: ["的", "地", "得", "底"]
};
const gradeMeaningOptionBank = {
  "一年级": [
    { words: ["开门", "开花"], targetChar: "开", sameMeaning: false, reason: "开门是打开，开花是花朵开放。" },
    { words: ["大人", "大风"], targetChar: "大", sameMeaning: false, reason: "大人指成年人，大风表示风力强。" },
    { words: ["上山", "上课"], targetChar: "上", sameMeaning: false, reason: "上山是向高处走，上课是开始学习。" },
    { words: ["白云", "白纸"], targetChar: "白", sameMeaning: true, reason: "都表示颜色白。" }
  ],
  "二年级": [
    { words: ["打水", "打伞"], targetChar: "打", sameMeaning: false, reason: "打水是汲取，打伞是撑开。" },
    { words: ["明亮", "明白"], targetChar: "明", sameMeaning: false, reason: "明亮指光线足，明白指懂得。" },
    { words: ["看书", "看望"], targetChar: "看", sameMeaning: false, reason: "看书是阅读，看望是探访。" },
    { words: ["走路", "走开"], targetChar: "走", sameMeaning: true, reason: "都表示离开或行走的动作。" }
  ],
  "三年级": [
    { words: ["深夜", "深蓝"], targetChar: "深", sameMeaning: false, reason: "深夜指时间晚，深蓝指颜色浓。" },
    { words: ["落叶", "落后"], targetChar: "落", sameMeaning: false, reason: "落叶是掉下，落后是不先进。" },
    { words: ["举手", "举行"], targetChar: "举", sameMeaning: false, reason: "举手是抬起，举行是举办。" },
    { words: ["细心", "细雨"], targetChar: "细", sameMeaning: false, reason: "细心指认真，细雨指雨点小。" },
    { words: ["发现", "发明"], targetChar: "发", sameMeaning: false, reason: "发现是找到，发明是创造。" },
    { words: ["安静", "平静"], targetChar: "静", sameMeaning: false, reason: "安静多指声音少，平静多指心情或水面安稳。" },
    { words: ["开门", "开花"], targetChar: "开", sameMeaning: false, reason: "开门是打开，开花是开放。" },
    { words: ["高兴", "高山"], targetChar: "高", sameMeaning: false, reason: "高兴指快乐，高山指高度大。" },
    { words: ["看见", "看望"], targetChar: "看", sameMeaning: false, reason: "看见是瞧见，看望是探访。" },
    { words: ["打球", "打水"], targetChar: "打", sameMeaning: false, reason: "打球是进行球类活动，打水是取水。" },
    { words: ["明亮", "明白"], targetChar: "明", sameMeaning: false, reason: "明亮指光线足，明白指懂得。" },
    { words: ["轻声", "轻重"], targetChar: "轻", sameMeaning: false, reason: "轻声指声音小，轻重指重量或程度。" },
    { words: ["长大", "长短"], targetChar: "长", sameMeaning: false, reason: "长大指成长，长短指长度。" },
    { words: ["花朵", "花钱"], targetChar: "花", sameMeaning: false, reason: "花朵是植物，花钱是使用钱。" },
    { words: ["回家", "回信"], targetChar: "回", sameMeaning: false, reason: "回家是返回，回信是答复来信。" },
    { words: ["过桥", "过年"], targetChar: "过", sameMeaning: false, reason: "过桥是经过，过年是度过节日。" },
    { words: ["观察", "察看"], targetChar: "察", sameMeaning: true, reason: "都表示仔细看。" },
    { words: ["安静", "宁静"], targetChar: "静", sameMeaning: true, reason: "都表示安静。" },
    { words: ["拔草", "拔河"], targetChar: "拔", sameMeaning: true, reason: "都表示用力拉。" },
    { words: ["辨别", "分辨"], targetChar: "辨", sameMeaning: true, reason: "都表示分清、区别。" },
    { words: ["做饭", "做事"], targetChar: "做", sameMeaning: true, reason: "都表示从事或完成事情。" },
    { words: ["在家", "在校"], targetChar: "在", sameMeaning: true, reason: "都表示处在某地。" }
  ],
  "四年级": [
    { words: ["观潮", "观察"], targetChar: "观", sameMeaning: true, reason: "都表示看。" },
    { words: ["逐渐", "追逐"], targetChar: "逐", sameMeaning: false, reason: "逐渐是慢慢变化，追逐是追赶。" },
    { words: ["临时", "临近"], targetChar: "临", sameMeaning: false, reason: "临时是暂时，临近是靠近。" },
    { words: ["宽阔", "开阔"], targetChar: "阔", sameMeaning: true, reason: "都含宽广的意思。" }
  ],
  "五年级": [
    { words: ["珍贵", "贵客"], targetChar: "贵", sameMeaning: false, reason: "珍贵指价值高，贵客指尊贵的客人。" },
    { words: ["协调", "调查"], targetChar: "调", sameMeaning: false, reason: "协调读 tiáo，表示配合；调查读 chá，表示了解情况。" },
    { words: ["躲避", "避雨"], targetChar: "避", sameMeaning: true, reason: "都含避开、防止碰上的意思。" },
    { words: ["黎明", "明亮"], targetChar: "明", sameMeaning: false, reason: "黎明指清晨，明亮指光线足。" }
  ],
  "六年级": [
    { words: ["慷慨", "感慨"], targetChar: "慨", sameMeaning: false, reason: "慷慨指大方，感慨指有所感触。" },
    { words: ["抵御", "御寒"], targetChar: "御", sameMeaning: true, reason: "都含抵挡、防护的意思。" },
    { words: ["贡献", "献花"], targetChar: "献", sameMeaning: false, reason: "贡献指奉献力量，献花是送上花。" },
    { words: ["陶醉", "沉醉"], targetChar: "醉", sameMeaning: true, reason: "都含沉浸、入迷的意思。" }
  ]
};

const gradeOrder = ["一年级", "二年级", "三年级", "四年级", "五年级", "六年级"];

function buildMaterialPrompt(input, charsOverride = null) {
  const grade = input.grade || "三年级";
  const textbookVersion = String(input.textbookVersion || "统编版小学语文").slice(0, 30);
  const wrongChars = Array.isArray(charsOverride) && charsOverride.length ? charsOverride : parseWrongChars(input.wrongChars);
  const wordCount = 3;
  const mixedChoiceWordCount = Math.min(Math.max(wrongChars.length * 6, 24), 80);
  const wordBankHint = buildWordBankPromptHint(grade, wrongChars);
  const schema = {
    materials: [
      {
        char: "拔",
        pinyin: "bá",
        confusables: ["拨", "跋", "把"],
        words: [
          { word: "拔河", pinyin: "bá hé", sentence: "运动会上，我们班参加了拔河比赛。", meaning: "双方用力拉绳子的比赛" }
        ],
        meaningOptions: [
          { words: ["拔草", "拔河"], targetChar: "拔", sameMeaning: true, reason: "都表示用力拉。" }
        ]
      }
    ],
    mixedChoiceWords: [
      { word: "观察", pinyin: "guān chá" },
      { word: "准备", pinyin: "zhǔn bèi" }
    ]
  };

  return [
    {
      role: "system",
      content: [
        `你是${grade}${textbookVersion}字词素材整理老师。`,
        "只返回合法 JSON，不要 Markdown，不要解释。",
        "你只提供素材，不出题，不生成试卷，不生成答案页。",
        "所有拼音必须带声调；句子必须自然、短，适合小学生。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `年级：${grade}`,
        `孩子写错的单字：${wrongChars.join("、")}`,
        ...(wordBankHint ? [
          "本地教材字库补充参考如下。它只用于帮助你选真实常见词、正确读音和易混字；不要违背这些信息，也不要照搬到所有题中：",
          wordBankHint
        ] : []),
        `必须逐一返回这些字的素材，materials 数组数量必须等于 ${wrongChars.length}，不得只返回第一个字。`,
        `每个字提供 ${wordCount} 个常见词语素材。`,
        "每个 material 必须包含：char、pinyin、confusables、words、meaningOptions。",
        "words 每项包含 word、pinyin、sentence、meaning；word 必须尽量包含 char。可选 wrongWord 只允许填写真实常见误写词，必须是小学语文中真实存在的词或短语；如果没有可靠误写词就不要填写。禁止把易混字硬替换进原词来造不存在的词，例如“迪子”“戎毛”这类内容绝不能出现。",
        "confusables 给 3-5 个形近/音近/常误用单字。",
        "meaningOptions 给 2-4 个对象，用于比较同一个 targetChar 在不同词语中的意思。",
        `另外返回 mixedChoiceWords：${mixedChoiceWordCount} 个适合该年级的常见语文词语，用于字音字形综合选择题扩展选项。`,
        "mixedChoiceWords 每项包含 word、pinyin；word 不要和孩子错字素材重复，pinyin 必须带声调。",
        "mixedChoiceWords 尽量覆盖不同课内常见词，不要重复词语，也不要只围绕同一个主题。",
        "返回结构示例：",
        JSON.stringify(schema)
      ].join("\n")
    }
  ];
}

function buildWordBankPromptHint(grade, wrongChars) {
  const charHints = wrongChars.map(char => {
    const material = supplementalMaterialForChar(char, grade);
    if (!material) return null;
    return {
      char,
      pinyin: material.pinyin,
      words: material.words.slice(0, 4).map(item => `${item.word} ${item.pinyin}`),
      confusables: material.confusables.slice(0, 5)
    };
  }).filter(Boolean);
  const usedWords = new Set(charHints.flatMap(item => item.words.map(word => word.replace(/\s+[A-Za-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹḿ\s]+$/i, ""))));
  const gradeWords = textbookWordItemsForGrade(grade)
    .filter(item => !usedWords.has(item.word))
    .slice(0, 24);
  if (!charHints.length && !gradeWords.length) return "";
  return JSON.stringify({
    chars: charHints,
    gradeWords
  });
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function firstCjk(value) {
  return cjkChars(value)[0] || "";
}

function repairWordPinyin(word, pinyin) {
  if (pinyin && hasToneMark(pinyin)) return pinyin;
  if (localWordPinyin.has(word)) return localWordPinyin.get(word);
  if (textbookWordPinyin.has(word)) return textbookWordPinyin.get(word);
  if (supplementalWordPinyin.has(word)) return supplementalWordPinyin.get(word);
  const chars = cjkChars(word);
  const syllables = chars.map(char => localMaterialByChar.get(char)?.pinyin || textbookCharPinyin(char) || supplementalCharPinyin.get(char) || "");
  return syllables.every(Boolean) ? syllables.join(" ") : chars.map(() => "pīn").join(" ");
}

function normalizeMaterialWord(raw, materialChar) {
  if (typeof raw === "string") {
    return {
      word: raw,
      pinyin: repairWordPinyin(raw, ""),
      sentence: `请认真书写“${raw}”这个词。`,
      meaning: "常用词语"
    };
  }
  const word = String(raw?.word || raw?.term || raw?.text || "").trim();
  if (!cjkChars(word).length) return null;
  return {
    word,
    pinyin: repairWordPinyin(word, String(raw.pinyin || raw.reading || "").trim()),
    sentence: String(raw.sentence || raw.example || `请认真书写“${word}”这个词。`).trim(),
    meaning: String(raw.meaning || raw.explanation || "常用词语").trim(),
    wrongWord: String(raw.wrongWord || "").trim()
  };
}

function normalizeMeaningOption(option, materialChar) {
  if (!option || typeof option !== "object") return null;
  const targetChar = firstCjk(option.targetChar || option.char || materialChar);
  const words = Array.isArray(option.words) ? option.words.map(word => String(word || "").trim()).filter(word => word.includes(targetChar)) : [];
  if (words.length < 2 || !targetChar) return null;
  return {
    words: words.slice(0, 3),
    targetChar,
    sameMeaning: option.sameMeaning === true || option.same === true || option.isSameMeaning === true,
    reason: String(option.reason || option.explanation || "结合词义判断。").trim()
  };
}

function normalizeMaterial(raw, charHint = "", grade = "") {
  const char = firstCjk(raw?.char || raw?.wrongChar || charHint) || charHint;
  if (!char) return null;
  const supplemental = supplementalMaterialForChar(char, grade);
  const materialPinyin = hasToneMark(raw?.pinyin)
    ? firstPinyinReading(String(raw.pinyin).trim()) || String(raw.pinyin).trim()
    : (supplemental?.pinyin || supplementalCharPinyin.get(char) || "pīn");
  const rawWords = Array.isArray(raw?.words) ? raw.words : [];
  const words = uniqueBy([
    ...rawWords.map(item => normalizeMaterialWord(item, char)).filter(Boolean),
    ...(supplemental?.words || [])
  ], item => item.word).slice(0, 8);
  const confusables = Array.from(new Set([
    ...(Array.isArray(raw?.confusables) ? raw.confusables : []),
    ...(supplemental?.confusables || []),
    ...(pinyinConfusableHints[plainPinyinSyllable(materialPinyin)] || [])
  ].map(firstCjk).filter(item => item && item !== char))).slice(0, 5);
  const meaningOptions = uniqueBy([
    ...(Array.isArray(raw?.meaningOptions) ? raw.meaningOptions : []).map(item => normalizeMeaningOption(item, char)).filter(Boolean),
    ...(supplemental?.meaningOptions || [])
  ], item => `${item.targetChar}:${item.words.join("|")}`).slice(0, 4);

  return {
    char,
    grade: baseGrade(grade),
    missingMaterial: !supplemental && !rawWords.length,
    pinyin: materialPinyin,
    confusables,
    words: words.length ? words : [{
      word: `${char}字`,
      pinyin: materialPinyin === "pīn" ? "pīn zì" : `${materialPinyin} zì`,
      sentence: `请认真书写“${char}字”。`,
      meaning: "待补充的字词素材"
    }],
    meaningOptions
  };
}

function normalizeWordPinyinItem(raw) {
  const word = String(raw?.word || raw?.term || raw?.text || "").trim();
  const pinyin = String(raw?.pinyin || raw?.reading || "").trim();
  if (!cjkChars(word).length || !pinyin || !hasToneMark(pinyin)) return null;
  return {
    word,
    pinyin
  };
}

function mixedChoiceWordsFromPayload(input, payload, materials = []) {
  const wrongWords = new Set(materials.flatMap(material => (material.words || []).map(item => item.word)));
  const raw = Array.isArray(payload?.mixedChoiceWords)
    ? payload.mixedChoiceWords
    : (Array.isArray(payload?.choiceWords) ? payload.choiceWords : []);
  const apiWords = raw
    .map(normalizeWordPinyinItem)
    .filter(item => item && !wrongWords.has(item.word));
  return uniqueBy(apiWords, item => item.word);
}

function materialsFromPayload(input, payload) {
  const wrongChars = parseWrongChars(input.wrongChars);
  const rawMaterials = Array.isArray(payload?.materials)
    ? payload.materials
    : (Array.isArray(payload?.items) ? payload.items : []);
  const byChar = new Map();
  rawMaterials.forEach(item => {
    const material = normalizeMaterial(item, "", input.grade);
    if (material) byChar.set(material.char, material);
  });

  return wrongChars.map(char => byChar.get(char) || normalizeMaterial({}, char, input.grade)).filter(Boolean);
}

function missingMaterialChars(materials) {
  return materials
    .filter(material => {
      const words = Array.isArray(material.words) ? material.words : [];
      const hasUsefulWord = words.some(item => item.word && item.word.includes(material.char) && item.word !== `${material.char}字`);
      const hasMeaningSeed = Array.isArray(material.meaningOptions) && material.meaningOptions.some(option => option.sameMeaning === true);
      return material.missingMaterial || !hasUsefulWord || material.pinyin === "pīn" || !hasMeaningSeed;
    })
    .map(material => material.char);
}

function mergeMaterialPayloads(primaryPayload, supplementPayload) {
  const primary = Array.isArray(primaryPayload?.materials) ? primaryPayload.materials : [];
  const supplement = Array.isArray(supplementPayload?.materials) ? supplementPayload.materials : [];
  const primaryChoiceWords = Array.isArray(primaryPayload?.mixedChoiceWords) ? primaryPayload.mixedChoiceWords : [];
  const supplementChoiceWords = Array.isArray(supplementPayload?.mixedChoiceWords) ? supplementPayload.mixedChoiceWords : [];
  const byChar = new Map();
  primary.forEach(item => {
    const char = firstCjk(item?.char || item?.wrongChar);
    if (char) byChar.set(char, item);
  });
  supplement.forEach(item => {
    const char = firstCjk(item?.char || item?.wrongChar);
    if (char) byChar.set(char, item);
  });
  return {
    materials: Array.from(byChar.values()),
    mixedChoiceWords: uniqueBy([...primaryChoiceWords, ...supplementChoiceWords], item => `${item?.word || item?.term || ""}:${item?.pinyin || item?.reading || ""}`)
  };
}

function cyclePick(items, index) {
  return items[index % items.length];
}

function materialAt(materials, index) {
  return cyclePick(materials.filter(Boolean), index);
}

function wordFromMaterial(material, index) {
  const words = Array.isArray(material?.words) && material.words.length ? material.words : [{
    word: `${material?.char || "字"}字`,
    pinyin: "pīn zì",
    sentence: `请认真书写“${material?.char || "字"}字”。`,
    meaning: "待补充的字词素材"
  }];
  return {
    ...cyclePick(words, index),
    char: material.char,
    material
  };
}

function allMaterialWords(materials) {
  return uniqueBy(materials.flatMap(material => material.words.map(word => ({ ...word, char: material.char, material }))), item => item.word);
}

function supplementWordsForGrade(grade) {
  const gradeWords = gradeSupplementWordBank[grade] || gradeSupplementWordBank["三年级"] || [];
  const localWords = localMaterialBank.flatMap(material => material.words.map(word => ({ word: word.word, pinyin: word.pinyin })));
  return uniqueBy([
    ...textbookWordItemsForGrade(grade),
    ...gradeWords,
    ...commonSupplementWords,
    ...localWords
  ].filter(item => item.word && item.pinyin && hasToneMark(item.pinyin)), item => item.word);
}

function supplementWordForGrade(grade, seed, excludeWords = []) {
  const excludes = new Set(excludeWords.filter(Boolean));
  const candidates = supplementWordsForGrade(grade).filter(item => !excludes.has(item.word));
  return cyclePick(rotatedCandidates(candidates, seed), 0) || commonSupplementWords[0];
}

function takeSupplementWordsForGrade(grade, seed, count, excludeWords = [], apiWords = []) {
  const excludes = new Set(excludeWords.filter(Boolean));
  const picked = [];
  const candidates = uniqueBy([
    ...apiWords,
    ...supplementWordsForGrade(grade)
  ].filter(item => item?.word && item?.pinyin && hasToneMark(item.pinyin)), item => item.word);
  for (const item of rotatedCandidates(candidates, seed)) {
    if (!item?.word || excludes.has(item.word) || picked.some(existing => existing.word === item.word)) continue;
    picked.push(item);
    if (picked.length >= count) break;
  }
  for (const item of commonSupplementWords) {
    if (picked.length >= count) break;
    if (!excludes.has(item.word) && !picked.some(existing => existing.word === item.word)) picked.push(item);
  }
  return picked;
}

function syllableForChar(word, pinyin, char) {
  const chars = cjkChars(word);
  const index = Math.max(0, chars.indexOf(char));
  const syllables = splitPinyin(pinyin);
  return syllables[index] || syllables[0] || localMaterialByChar.get(char)?.pinyin || textbookCharPinyin(char) || "bá";
}

function optionList(answer, candidates, size = 4) {
  return Array.from(new Set([answer, ...candidates].filter(Boolean))).slice(0, size);
}

function rotatedCandidates(items, seed) {
  const clean = Array.from(new Set(items.filter(Boolean)));
  if (!clean.length) return [];
  const offset = seed % clean.length;
  return [...clean.slice(offset), ...clean.slice(0, offset)];
}

function confusingCharOptions(answer, material, seed, size = 4) {
  const localCandidates = Array.isArray(material?.confusables) ? material.confusables : [];
  const candidates = [
    ...localCandidates,
    ...rotatedCandidates(fallbackConfusingChars.filter(char => char !== answer), seed)
  ].map(firstCjk).filter(char => char && char !== answer);
  return fixedSizeOptionList(answer, candidates, size, seed);
}

function plainPinyinSyllable(value) {
  return Array.from(String(value || "").trim().toLowerCase()).map(char => {
    if (pinyinToneLookup[char]) return pinyinToneLookup[char].plain;
    return char
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/ü/g, "v");
  }).join("").replace(/[^a-zv]/g, "");
}

function toneNumberForSyllable(value) {
  for (const char of Array.from(String(value || "").trim().toLowerCase())) {
    if (pinyinToneLookup[char]?.tone) return pinyinToneLookup[char].tone;
  }
  return 0;
}

function toneTargetIndex(plain) {
  const chars = Array.from(plain);
  const aIndex = chars.indexOf("a");
  if (aIndex >= 0) return aIndex;
  const eIndex = chars.indexOf("e");
  if (eIndex >= 0) return eIndex;
  const ouIndex = plain.indexOf("ou");
  if (ouIndex >= 0) return ouIndex;
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    if ("aeiouv".includes(chars[index])) return index;
  }
  return -1;
}

function markPinyinTone(plain, tone) {
  const syllable = plainPinyinSyllable(plain);
  if (!syllable) return "";
  if (!tone) return syllable.replace(/v/g, "ü");
  const targetIndex = toneTargetIndex(syllable);
  if (targetIndex < 0) return syllable;
  const chars = Array.from(syllable);
  const vowel = chars[targetIndex] === "ü" ? "v" : chars[targetIndex];
  const marks = pinyinToneMarks[vowel];
  if (!marks) return syllable.replace(/v/g, "ü");
  chars[targetIndex] = marks[tone - 1];
  return chars.join("").replace(/v/g, "ü");
}

function wrongToneSyllable(syllable, seed = 0) {
  const plain = plainPinyinSyllable(syllable);
  if (!plain) return syllable;
  const currentTone = toneNumberForSyllable(syllable);
  const tones = [1, 2, 3, 4].filter(tone => tone !== currentTone);
  return markPinyinTone(plain, tones[seed % tones.length] || 1);
}

function wrongTonePinyin(pinyin, seed = 0) {
  const syllables = splitPinyin(pinyin);
  if (!syllables.length) return pinyin;
  const index = seed % syllables.length;
  return syllables.map((syllable, syllableIndex) => (
    syllableIndex === index ? wrongToneSyllable(syllable, seed + syllableIndex) : syllable
  )).join(" ");
}

function splitPlainPinyinParts(plain) {
  const initial = pinyinInitials.find(item => plain.startsWith(item)) || "";
  return {
    initial,
    final: initial ? plain.slice(initial.length) : plain
  };
}

function markCandidatePlain(candidatePlain, answerTone) {
  const plain = plainPinyinSyllable(candidatePlain);
  if (!plain) return "";
  return markPinyinTone(plain, answerTone || 2);
}

function structuralPinyinCandidates(answerText, material) {
  const plain = plainPinyinSyllable(answerText);
  const currentTone = toneNumberForSyllable(answerText);
  const answerTone = currentTone || 2;
  const directCandidates = pinyinStructuralAlternates[plain] || [];
  const { initial, final } = splitPlainPinyinParts(plain);
  const heuristicCandidates = [
    ...(pinyinInitialAlternates[initial] || []).map(nextInitial => `${nextInitial}${final}`),
    ...(pinyinFinalAlternates[final] || []).map(nextFinal => `${initial}${nextFinal}`)
  ];
  const confusableCandidates = (material?.confusables || [])
    .map(char => localMaterialByChar.get(char)?.pinyin || textbookCharPinyin(char, material?.grade))
    .filter(Boolean)
    .filter(item => plainPinyinSyllable(item) !== plain);
  const commonCandidates = commonPronunciationOptions
    .filter(item => plainPinyinSyllable(item) !== plain);
  return Array.from(new Set([
    ...directCandidates.map(item => markCandidatePlain(item, answerTone)),
    ...confusableCandidates,
    ...heuristicCandidates.map(item => markCandidatePlain(item, answerTone)),
    ...commonCandidates
  ])).filter(item => item && item !== answerText && hasToneMark(item));
}

function toneOnlyPinyinCandidates(answerText) {
  const plain = plainPinyinSyllable(answerText);
  const currentTone = toneNumberForSyllable(answerText);
  const toneCandidates = [1, 2, 3, 4]
    .filter(tone => tone !== currentTone)
    .map(tone => markPinyinTone(plain, tone));
  return toneCandidates.filter(item => item && item !== answerText && hasToneMark(item));
}

function pronunciationDistractors(answerText, material, seed = 0) {
  const structuralCandidates = structuralPinyinCandidates(answerText, material);
  const toneCandidates = rotatedCandidates(toneOnlyPinyinCandidates(answerText), seed + 1);
  const ordered = [
    structuralCandidates[0],
    toneCandidates[0],
    ...structuralCandidates.slice(1),
    ...toneCandidates.slice(1)
  ];
  return Array.from(new Set(ordered)).filter(Boolean);
}

function fixedSizeOptionList(answer, candidates, size, seed) {
  const cleanAnswer = String(answer || "").trim();
  const others = Array.from(new Set(candidates.filter(item => item && item !== cleanAnswer)));
  const picked = others.slice(0, Math.max(0, size - 1));
  const answerSlot = answerSlotForSeed(seed, size);
  const options = [];
  for (let index = 0; index < size; index += 1) {
    if (index === answerSlot) {
      options.push(cleanAnswer);
    } else {
      options.push(picked.shift());
    }
  }
  return options.filter(Boolean);
}

function answerSlotForSeed(seed, size) {
  if (!size) return 0;
  const row = Math.floor(seed / size);
  const col = seed % size;
  const mixed = (col * 2 + row + (row % 2 ? 1 : 0)) % size;
  return mixed;
}

function makePronunciationQuestion(materials, index) {
  const material = materialAt(materials, index);
  const wordItem = wordFromMaterial(material, Math.floor(index / Math.max(materials.length, 1)));
  const char = wordItem.char || firstCjk(wordItem.word);
  const answerText = syllableForChar(wordItem.word, wordItem.pinyin, char);
  const options = fixedSizeOptionList(answerText, pronunciationDistractors(answerText, material, index), 3, index);
  return {
    id: `pronunciationChoice-${index + 1}`,
    word: wordItem.word,
    char,
    stem: `${wordItem.word}中“${char}”的正确读音是？`,
    options,
    answer: optionLetter(options.indexOf(answerText)),
    answerText,
    explanation: `“${char}”读${answerText}。`
  };
}

function makePinyinWordQuestion(materials, index) {
  const material = materialAt(materials, index);
  const wordItem = wordFromMaterial(material, Math.floor(index / Math.max(materials.length, 1)));
  return {
    id: `pinyinWriteWord-${index + 1}`,
    word: wordItem.word,
    pinyin: wordItem.pinyin,
    explanation: wordItem.meaning || ""
  };
}

function makeConfusingFillQuestion(materials, index) {
  const material = materialAt(materials, index);
  const wordItem = wordFromMaterial(material, Math.floor(index / Math.max(materials.length, 1)));
  const answer = material.char;
  const word = wordItem.word.includes(answer) ? wordItem.word : `${answer}${wordItem.word.slice(1)}`;
  const sentence = wordItem.sentence.includes(word) ? wordItem.sentence : `请正确书写“${word}”这个词。`;
  const blankWord = word.replace(answer, "（ ）");
  const stem = sentence.includes(word) ? sentence.replace(word, blankWord) : `请写出词语：${blankWord}`;
  const options = confusingCharOptions(answer, material, index, 4);
  return {
    id: `confusingCharFill-${index + 1}`,
    stem,
    options,
    answer,
    answerWord: word,
    completedSentence: sentence,
    explanation: `这里应写“${word}”。`
  };
}

function makeContextualPinyinQuestion(materials, index) {
  const material = materialAt(materials, index);
  const wordItem = wordFromMaterial(material, Math.floor(index / Math.max(materials.length, 1)) + 1);
  const stem = wordItem.sentence.includes(wordItem.word)
    ? wordItem.sentence.replace(wordItem.word, "____")
    : `请根据拼音写出词语：____。`;
  return {
    id: `contextualPinyinWrite-${index + 1}`,
    word: wordItem.word,
    pinyin: wordItem.pinyin,
    stem,
    explanation: wordItem.meaning || ""
  };
}

function stripTone(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ü/g, "v");
}

function wrongCharForMaterial(material, seed) {
  const answer = material?.char || "";
  const localCandidates = (Array.isArray(material?.confusables) ? material.confusables : [])
    .map(firstCjk)
    .filter(char => char && char !== answer);
  if (localCandidates.length) {
    return rotatedCandidates(localCandidates, seed)[0] || localCandidates[0];
  }
  return rotatedCandidates(fallbackConfusingChars.filter(char => char !== answer), seed)[0] || "错";
}

function replaceTargetChar(word, target, replacement) {
  const chars = Array.from(String(word || ""));
  const index = chars.indexOf(target);
  if (index >= 0) {
    chars[index] = replacement;
    return chars.join("");
  }
  return replacement + chars.slice(1).join("");
}

function formatWordWithPinyin(wordItem, pinyinOverride) {
  return `${wordItem.word}(${pinyinOverride || wordItem.pinyin})`;
}

function correctionText(wrong, correct) {
  return `${wrong} 应改为 ${correct}`;
}

const trustedWrongWordItems = [
  { correct: "拔河", wrong: "拨河", pinyin: "bá hé" },
  { correct: "拔草", wrong: "拨草", pinyin: "bá cǎo" },
  { correct: "戴帽子", wrong: "带帽子", pinyin: "dài mào zi" },
  { correct: "戴眼镜", wrong: "带眼镜", pinyin: "dài yǎn jìng" },
  { correct: "辨别", wrong: "辩别", pinyin: "biàn bié" },
  { correct: "分辨", wrong: "分辩", pinyin: "fēn biàn" },
  { correct: "辨认", wrong: "辩认", pinyin: "biàn rèn" },
  { correct: "安静", wrong: "安净", pinyin: "ān jìng" },
  { correct: "平静", wrong: "平净", pinyin: "píng jìng" },
  { correct: "观察", wrong: "观查", pinyin: "guān chá" },
  { correct: "做作业", wrong: "作作业", pinyin: "zuò zuò yè" },
  { correct: "做饭", wrong: "作饭", pinyin: "zuò fàn" },
  { correct: "做事", wrong: "作事", pinyin: "zuò shì" },
  { correct: "正在", wrong: "正再", pinyin: "zhèng zài" },
  { correct: "在家", wrong: "再家", pinyin: "zài jiā" },
  { correct: "存在", wrong: "存再", pinyin: "cún zài" }
];

const trustedWrongWordByCorrectWord = trustedWrongWordItems.reduce((map, item) => {
  if (!map.has(item.correct)) map.set(item.correct, []);
  map.get(item.correct).push(item);
  return map;
}, new Map());

function trustedWrongWordItemFromWordItem(wordItem) {
  const wrongWord = String(wordItem?.wrongWord || "").trim();
  if (!wrongWord || wrongWord === wordItem.word || !cjkChars(wrongWord).length) return null;
  if (cjkChars(wrongWord).length !== cjkChars(wordItem.word).length) return null;
  const trustedWrongWords = trustedWrongWordByCorrectWord.get(wordItem.word) || [];
  const matched = trustedWrongWords.find(item => item.wrong === wrongWord);
  if (!matched) return null;
  return {
    ...matched,
    pinyin: wordItem.pinyin || matched.pinyin
  };
}

function takeTrustedWrongWordItems(seed, count, excludeWords = []) {
  const excludes = new Set(excludeWords.filter(Boolean));
  const picked = [];
  for (const item of rotatedCandidates(trustedWrongWordItems, seed)) {
    if (excludes.has(item.correct) || excludes.has(item.wrong)) continue;
    picked.push(item);
    excludes.add(item.correct);
    excludes.add(item.wrong);
    if (picked.length >= count) break;
  }
  return picked;
}

function reliableWrongWordFromWordItem(wordItem) {
  return trustedWrongWordItemFromWordItem(wordItem)?.wrong || "";
}

function makeMixedChoiceQuestion(materials, index, context = {}) {
  const firstMaterial = materialAt(materials, index);
  const first = wordFromMaterial(firstMaterial, Math.floor(index / Math.max(materials.length, 1)));
  const grade = context.input?.grade || "三年级";
  const targetWrongItem = trustedWrongWordItemFromWordItem(first);
  const [fallbackWrongItem, secondaryWrongItem] = takeTrustedWrongWordItems(index * 11, 2, [
    first.word,
    targetWrongItem?.correct,
    targetWrongItem?.wrong
  ]);
  const answerWrongItem = targetWrongItem || fallbackWrongItem;
  const extraWrongItem = secondaryWrongItem || fallbackWrongItem || targetWrongItem;
  const excludeWords = [
    first.word,
    answerWrongItem?.correct,
    answerWrongItem?.wrong,
    extraWrongItem?.correct,
    extraWrongItem?.wrong
  ].filter(Boolean);
  const supports = takeSupplementWordsForGrade(grade, index * 7, targetWrongItem ? 6 : 7, excludeWords, context.mixedChoiceWords || []);
  const [supportA, supportB, supportC, supportD, supportE, supportF, supportG] = supports;
  const targetWrongTone = wrongTonePinyin(first.pinyin, index);
  const correctTarget = formatWordWithPinyin(first);
  const answerWrongSupportPinyin = wrongTonePinyin(supportB.pinyin, index + 2);
  const supportDWrongPinyin = wrongTonePinyin(supportD.pinyin, index + 3);
  const baseOptions = [
    {
      text: targetWrongItem
        ? `${correctTarget}　${formatWordWithPinyin(supportA)}`
        : `${formatWordWithPinyin(supportA)}　${formatWordWithPinyin(supportG)}`,
      corrections: []
    },
    {
      text: targetWrongItem
        ? `${answerWrongItem.wrong}(${targetWrongTone})　${supportB.word}(${answerWrongSupportPinyin})`
        : `${first.word}(${targetWrongTone})　${answerWrongItem.wrong}(${answerWrongItem.pinyin})`,
      corrections: [
        ...(targetWrongItem
          ? [
              correctionText(answerWrongItem.wrong, answerWrongItem.correct),
              correctionText(`${answerWrongItem.wrong}(${targetWrongTone})`, `${answerWrongItem.correct}(${answerWrongItem.pinyin})`)
            ]
          : [
              correctionText(`${first.word}(${targetWrongTone})`, `${first.word}(${first.pinyin})`),
              correctionText(answerWrongItem.wrong, answerWrongItem.correct)
            ]),
        ...(targetWrongItem
          ? [correctionText(`${supportB.word}(${answerWrongSupportPinyin})`, `${supportB.word}(${supportB.pinyin})`)]
          : [])
      ]
    },
    {
      text: `${formatWordWithPinyin(supportC)}　${supportD.word}(${supportDWrongPinyin})`,
      corrections: [
        correctionText(`${supportD.word}(${supportDWrongPinyin})`, `${supportD.word}(${supportD.pinyin})`)
      ]
    },
    {
      text: `${extraWrongItem.wrong}(${extraWrongItem.pinyin})　${formatWordWithPinyin(supportF || supportE)}`,
      corrections: [
        correctionText(extraWrongItem.wrong, extraWrongItem.correct)
      ]
    }
  ];
  const rotated = rotateOptionsWithAnswer(baseOptions, 1, index);
  const options = rotated.options.map(option => option.text);
  const answerCorrections = rotated.options[rotated.answerIndex]?.corrections || [];
  return {
    id: `mixedErrorChoice-${index + 1}`,
    stem: "下列词语中，字音字形错误最多的是？",
    options,
    answer: optionLetter(rotated.answerIndex),
    answerText: options[rotated.answerIndex],
    corrections: answerCorrections,
    explanation: answerCorrections.length ? answerCorrections.join("；") : "本项没有明显错误。"
  };
}

function fallbackMeaningOptionsForMaterial(material) {
  const targetChar = material.char || firstCjk(material.words?.[0]?.word) || "字";
  const words = Array.isArray(material.words) && material.words.length
    ? material.words.map(item => item.word).filter(word => word && word.includes(targetChar))
    : [];
  const first = words[0] || `${targetChar}字`;
  const second = words[1] || `${targetChar}词`;
  const third = words[2] || `${targetChar}语`;
  const fourth = `${targetChar}形`;
  return [
    { words: [first, second], targetChar, sameMeaning: true, reason: "这里都取这个字在词语中的常见本义或相关义。" },
    { words: [first, third], targetChar, sameMeaning: false, reason: "两个词中的这个字用法不同。" },
    { words: [second, fourth], targetChar, sameMeaning: false, reason: "一个偏词义，一个偏字形说法。" },
    { words: [third, fourth], targetChar, sameMeaning: false, reason: "一个是词语用法，一个是字形说法。" }
  ];
}

function meaningOptionsForGrade(grade) {
  const gradeName = baseGrade(grade) || "三年级";
  const gradeIndex = gradeOrder.indexOf(gradeName);
  const allowedGrades = gradeIndex >= 0 ? gradeOrder.slice(0, gradeIndex + 1) : [gradeName];
  const candidates = allowedGrades.flatMap(item => gradeMeaningOptionBank[item] || []);
  const fallback = candidates.length ? candidates : (gradeMeaningOptionBank["三年级"] || []);
  return uniqueBy(fallback, meaningOptionKey)
    .filter(option => option.words.every(word => word.includes(option.targetChar)));
}

function meaningOptionKey(option) {
  return `${option?.targetChar || ""}:${(option?.words || []).join("|")}`;
}

function meaningOptionWords(option) {
  return Array.isArray(option?.words)
    ? option.words.map(word => String(word || "").trim()).filter(Boolean)
    : [];
}

function meaningOptionHasWordOverlap(option, usedWords) {
  return meaningOptionWords(option).some(word => usedWords.has(word));
}

function reliableMeaningOption(option, expectedSame = null) {
  if (!option || typeof option !== "object") return false;
  const target = String(option.targetChar || "").trim();
  if (!isSingleCjkChar(target) || !Array.isArray(option.words) || option.words.length < 2) return false;
  const words = meaningOptionWords(option);
  if (new Set(words).size !== words.length) return false;
  if (!words.every(word => word.includes(target))) return false;
  if (!String(option.reason || "").trim()) return false;
  if (expectedSame !== null && option.sameMeaning !== expectedSame) return false;
  return true;
}

function buildMeaningDistractors(grade, sourceOptions, targetWrong, index, targetCorrect, usedKeys = new Set(), usedWords = new Set()) {
  const allDistractors = uniqueBy([
    targetWrong,
    ...rotatedCandidates(meaningOptionsForGrade(grade).filter(option => option.sameMeaning !== true), index * 5),
    ...sourceOptions.filter(option => option.sameMeaning !== true)
  ].filter(option => reliableMeaningOption(option, false)), meaningOptionKey);
  const targetKey = meaningOptionKey(targetCorrect);
  const pickedWords = new Set(usedWords);
  const picked = [];
  for (const option of allDistractors) {
    const key = meaningOptionKey(option);
    if (key === targetKey || usedKeys.has(key) || meaningOptionHasWordOverlap(option, pickedWords)) continue;
    picked.push(option);
    meaningOptionWords(option).forEach(word => pickedWords.add(word));
    if (picked.length >= 3) break;
  }
  return picked;
}

function pickMeaningCorrectOption(sourceOptions, grade, index, usedKeys = new Set()) {
  const sourceCorrect = sourceOptions.find(option => reliableMeaningOption(option, true));
  if (sourceCorrect && !usedKeys.has(meaningOptionKey(sourceCorrect))) {
    return sourceCorrect;
  }
  const gradeCorrects = rotatedCandidates(
    meaningOptionsForGrade(grade).filter(option => reliableMeaningOption(option, true)),
    index * 3
  );
  const unusedGradeCorrect = gradeCorrects.find(option => !usedKeys.has(meaningOptionKey(option)));
  return unusedGradeCorrect || sourceCorrect || gradeCorrects[0] || null;
}

function rotateOptionsWithAnswer(options, answerIndex, seed) {
  if (!options.length) return { options, answerIndex: -1 };
  const shift = seed % options.length;
  const rotated = [...options.slice(shift), ...options.slice(0, shift)];
  const answerOption = options[answerIndex];
  return {
    options: rotated,
    answerIndex: rotated.indexOf(answerOption)
  };
}

function makeMeaningQuestion(materials, index, context = {}) {
  const sourceMaterial = materialAt(materials, index);
  const local = localMaterialByChar.get(sourceMaterial.char);
  const material = sourceMaterial.meaningOptions.length >= 4 ? sourceMaterial : (local || sourceMaterial);
  const rawSourceOptions = material.meaningOptions.length ? material.meaningOptions : [];
  const sourceOptions = rawSourceOptions.filter(option => reliableMeaningOption(option));
  const targetWrong = rawSourceOptions.find(option => reliableMeaningOption(option, false));
  const grade = context.input?.grade || "三年级";
  const usedKeys = context.usedMeaningOptionKeys || new Set();
  const targetCorrect = pickMeaningCorrectOption(sourceOptions, grade, index, usedKeys) || fallbackMeaningOptionsForMaterial(sourceMaterial)[0];
  const questionWords = new Set();
  const baseOptions = [];
  const pushOption = (option, allowUsedKey = false) => {
    if (!reliableMeaningOption(option)) return false;
    const key = meaningOptionKey(option);
    if (!allowUsedKey && usedKeys.has(key)) return false;
    if (baseOptions.some(existing => meaningOptionKey(existing) === key)) return false;
    if (meaningOptionHasWordOverlap(option, questionWords)) return false;
    baseOptions.push(option);
    meaningOptionWords(option).forEach(word => questionWords.add(word));
    return true;
  };
  pushOption(targetCorrect, true);
  const distractors = buildMeaningDistractors(grade, sourceOptions, targetWrong, index, targetCorrect, usedKeys, questionWords);
  distractors.forEach(option => pushOption(option));
  const fallbackDistractors = rotatedCandidates(
    meaningOptionsForGrade(grade).filter(option => reliableMeaningOption(option, false)),
    index * 7
  );
  let fallbackIndex = 0;
  while (baseOptions.length < 4 && fallbackIndex < fallbackDistractors.length) {
    const fallback = fallbackDistractors[fallbackIndex];
    fallbackIndex += 1;
    pushOption(fallback);
  }
  fallbackIndex = 0;
  while (baseOptions.length < 4 && fallbackIndex < fallbackDistractors.length) {
    const fallback = fallbackDistractors[fallbackIndex];
    fallbackIndex += 1;
    pushOption(fallback, true);
  }
  const normalizedOptions = baseOptions.map((option, optionIndex) => ({
    ...option,
    sameMeaning: optionIndex === 0
  }));
  const rotated = rotateOptionsWithAnswer(normalizedOptions, 0, index);
  const options = rotated.options;
  const answerIndexValue = rotated.answerIndex;
  options.forEach(option => usedKeys.add(meaningOptionKey(option)));
  return {
    id: `meaningSameChoice-${index + 1}`,
    stem: "下列各组词语中，加点字意思相同的一项是？",
    options,
    answer: optionLetter(answerIndexValue),
    answerText: options[answerIndexValue].words.join("、"),
    explanation: options[answerIndexValue].reason
  };
}

function makeWordSentenceQuestion(materials, index) {
  const material = materialAt(materials, index);
  const wordItem = wordFromMaterial(material, Math.floor(index / Math.max(materials.length, 1)));
  return {
    id: `wordSentence-${index + 1}`,
    word: wordItem.word,
    explanation: wordItem.meaning || ""
  };
}

function composeWorksheetFromMaterials(input, materialPayload) {
  const materials = materialsFromPayload(input, materialPayload);
  const mixedChoiceWords = mixedChoiceWordsFromPayload(input, materialPayload, materials);
  const builders = {
    pronunciationChoice: makePronunciationQuestion,
    pinyinWriteWord: makePinyinWordQuestion,
    confusingCharFill: makeConfusingFillQuestion,
    contextualPinyinWrite: makeContextualPinyinQuestion,
    mixedErrorChoice: makeMixedChoiceQuestion,
    meaningSameChoice: makeMeaningQuestion,
    wordSentence: makeWordSentenceQuestion
  };

  const payload = {
    title: String(input.title || "字词练习").slice(0, 40),
    grade: input.grade || "三年级",
    textbookVersion: input.textbookVersion || "统编版小学语文",
    wrongChars: parseWrongChars(input.wrongChars),
    sections: parseTypes(input.types).map((type, typeIndex) => {
      const count = expectedQuestionCount(input, type);
      const sectionContext = { typeIndex, count, input, mixedChoiceWords, usedMeaningOptionKeys: new Set() };
      return {
        type,
        title: typeLabels[type] || type,
        instruction: sectionInstructions[type] || "",
        questions: Array.from({ length: count }, (_, index) => builders[type](materials, index, sectionContext))
      };
    }),
    answerKey: [],
    generationMode: "material-compose"
  };

  return finalizeGeneratedPayload(payload, input, { mode: "material-compose" });
}

async function callModel(input) {
  const config = input.apiConfig && typeof input.apiConfig === "object" ? input.apiConfig : {};
  const requestBaseUrl = String(config.baseUrl || defaultBaseUrl).replace(/\/$/, "");
  const requestModel = String(config.model || defaultModel).trim();
  const requestApiKey = String(config.apiKey || defaultApiKey).trim();
  const allowInsecureTLS = Boolean(config.allowInsecureTLS);
  const timeoutMs = Math.min(Math.max(Number(config.timeoutSeconds) || 30, 15), 180) * 1000;
  const provider = String(config.provider || "").toLowerCase();
  const fastMode = config.fastMode !== false;

  if (!/^https?:\/\//.test(requestBaseUrl)) {
    const error = new Error("Invalid API Base URL.");
    error.status = 400;
    throw error;
  }
  if (!requestModel) {
    const error = new Error("Missing model name.");
    error.status = 400;
    throw error;
  }
  if (!requestApiKey) {
    const error = new Error("Missing API Key. Please save API config in the page.");
    error.status = 400;
    throw error;
  }

  async function requestJson(messages, temperature) {
    const maxApiAttempts = fastMode ? 1 : 2;
    const requestPayload = {
      model: requestModel,
      messages,
      temperature,
      stream: false,
      response_format: { type: "json_object" }
    };
    if (provider === "deepseek" && fastMode) {
      requestPayload.thinking = { type: "disabled" };
    }

    let response;
    for (let apiAttempt = 0; apiAttempt < maxApiAttempts; apiAttempt += 1) {
      try {
        response = await postJson(`${requestBaseUrl}/chat/completions`, {
            "authorization": `Bearer ${requestApiKey}`,
            "content-type": "application/json"
          }, requestPayload, { allowInsecureTLS, timeoutMs });
      } catch (error) {
        if (apiAttempt < maxApiAttempts - 1) {
          await wait(apiRetryDelayMs(apiAttempt));
          continue;
        }
        const detailed = new Error(describeFetchError(error, requestBaseUrl));
        detailed.status = 502;
        throw detailed;
      }

      if (response.ok || !isRetryableApiStatus(response.status) || apiAttempt === maxApiAttempts - 1) {
        break;
      }
      await wait(apiRetryDelayMs(apiAttempt));
    }

    const text = response.text;
    if (!response.ok) {
      const error = new Error(formatApiError(response.status, text, maxApiAttempts - 1));
      error.status = response.status;
      throw error;
    }

    let apiPayload;
    try {
      apiPayload = JSON.parse(text);
    } catch {
      throw new Error("LLM API returned non-JSON HTTP payload.");
    }

    const content = apiPayload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("LLM API response has no message content.");
    }

    let generated;
    try {
      generated = JSON.parse(content);
    } catch {
      throw new Error("Model message content is not valid JSON.");
    }

    return generated;
  }

  const materialMessages = buildMaterialPrompt(input);
  try {
    let generated = await requestJson(materialMessages, 0.18);
    const missing = missingMaterialChars(materialsFromPayload(input, generated));
    if (missing.length) {
      try {
        const supplement = await requestJson(buildMaterialPrompt(input, missing), 0.12);
        generated = mergeMaterialPayloads(generated, supplement);
      } catch {
        generated = {
          ...generated,
          partialMaterialWarning: `仍缺少部分字的素材：${missing.join("、")}`
        };
      }
    }
    return composeWorksheetFromMaterials(input, generated);
  } catch (error) {
    if (error.status === 401 || error.status === 403 || error.status === 400) {
      throw error;
    }
    const fallback = composeWorksheetFromMaterials(input, { materials: [] });
    fallback.repairInfo = {
      mode: "local-material-fallback",
      reason: "API 素材生成失败，已使用本地保守素材组卷。"
    };
    return fallback;
  }
}

function serveFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(rootDir, pathname));

  if (!filePath.startsWith(rootDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".md": "text/markdown; charset=utf-8"
    };
    sendText(res, 200, content, types[ext] || "application/octet-stream");
  });
}

function createAppServer() {
  return http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/generate") {
      try {
        const body = await readBody(req);
        const input = JSON.parse(body || "{}");
        const wrongChars = parseWrongChars(input.wrongChars);
        if (!wrongChars.length) {
          sendJson(res, 400, { error: "请至少输入一个错误单字。" });
          return;
        }
        const generated = await callModel({ ...input, wrongChars });
        sendJson(res, 200, generated);
      } catch (error) {
        sendJson(res, error.status || 500, { error: error.message || "Generate failed." });
      }
      return;
    }

    if (req.method === "GET") {
      serveFile(req, res);
      return;
    }

    sendText(res, 405, "Method not allowed");
  });
}

function startServer(options = {}) {
  const appServer = createAppServer();
  const targetHost = options.host || host;
  const targetPort = Number(options.port ?? preferredPort);
  const shouldLog = options.log !== false;

  return new Promise((resolve, reject) => {
    function listen(port) {
      appServer.once("error", error => {
        if (error.code === "EADDRINUSE" && targetPort !== 0 && port < targetPort + 20) {
          if (shouldLog) console.warn(`Port ${port} is busy, trying ${port + 1}...`);
          listen(port + 1);
          return;
        }
        reject(error);
      });

      appServer.listen(port, targetHost, () => {
        const address = appServer.address();
        const actualPort = typeof address === "object" && address ? address.port : port;
        const displayHost = targetHost === "0.0.0.0" ? "127.0.0.1" : targetHost;
        const url = `http://${displayHost}:${actualPort}`;
        if (shouldLog) {
          console.log(`Word practice generator: ${url}`);
          console.log(`Default model: ${defaultModel}`);
        }
        resolve({
          server: appServer,
          host: targetHost,
          port: actualPort,
          url
        });
      });
    }

    listen(targetPort);
  });
}

if (require.main === module) {
  startServer().catch(error => {
    throw error;
  });
}

module.exports = {
  createAppServer,
  startServer
};
