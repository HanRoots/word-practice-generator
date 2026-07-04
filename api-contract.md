# 字词练习 API 生成契约

## 输入

前端提交孩子写错的单字、年级、题量、题型开关，以及从配置页加载的 API 配置。

`apiConfig` 由前端配置页读取，提交给本机 `server.js` 代理服务。服务端优先使用前端配置；如果没有提交，则回退到环境变量 `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY` 或 `OPENAI_API_KEY`。

```json
{
  "grade": "三年级",
  "textbookVersion": "统编版小学语文",
  "trainingLevel": "regular",
  "trainingLabel": "常规巩固",
  "wrongChars": ["拔", "戴", "辨"],
  "title": "暑假字词闯关练习",
  "questionCount": 6,
  "typeMultipliers": {
    "pronunciationChoice": 1,
    "pinyinWriteWord": 2,
    "confusingCharFill": 1,
    "contextualPinyinWrite": 1,
    "mixedErrorChoice": 1,
    "meaningSameChoice": 1,
    "wordSentence": 1
  },
  "apiConfig": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4.1-mini",
    "apiKey": "YOUR_API_KEY",
    "allowInsecureTLS": false,
    "timeoutSeconds": 30,
    "fastMode": true
  },
  "types": [
    "pronunciationChoice",
    "pinyinWriteWord",
    "confusingCharFill",
    "contextualPinyinWrite",
    "mixedErrorChoice",
    "meaningSameChoice",
    "wordSentence"
  ]
}
```

## 素材输出

大模型必须返回纯 JSON。当前链路采用“素材包 + 程序组题”：大模型只提供每个错字的词语、拼音、例句、易混字和少量字义素材；本机 `server.js` 用确定性规则生成各题型，并根据题目重建答案页。模型不再直接输出整张试卷。

`typeMultipliers` 用于专项强化：每个题型可设为 `1`、`2` 或 `3` 倍错字量。比如输入 10 个错字，`pinyinWriteWord: 3` 会生成 30 道“看拼音写词语”，其余题型仍按各自倍数生成。

```json
{
  "materials": [
    {
      "char": "拔",
      "pinyin": "bá",
      "confusables": ["拨", "跋", "把"],
      "words": [
        {
          "word": "拔河",
          "pinyin": "bá hé",
          "sentence": "运动会上，我们班参加了拔河比赛。",
          "meaning": "双方用力拉绳子的比赛"
        }
      ],
      "meaningOptions": [
        {
          "words": ["拔草", "拔河"],
          "targetChar": "拔",
          "sameMeaning": true,
          "reason": "都表示用力拉。"
        }
      ]
    }
  ]
}
```

## 七类题型

1. `pronunciationChoice`：错字组词后辨析字音，孩子选正确读音。每题固定 3 个读音候选；候选不能全部只是同一拼音组合改声调，至少一个干扰项要改变声母或韵母，例如 `hào/gào`、`yì/qì` 这类近音辨析。
2. `pinyinWriteWord`：错字自动组词，看拼音写词语。
3. `confusingCharFill`：由错字延伸 3-4 个易混字，放入句子中选正确字。
4. `contextualPinyinWrite`：把看拼音写词语放入语境中再测一次。
5. `mixedErrorChoice`：字音字形综合选择题，例如“错误最多的一项是”。每题必须同时出现读音错误和可信字形错误；字形错误只能来自真实常见错写或常见误用，例如 `拨河/拔河`、`辩别/辨别`，不能硬造不存在的词。
6. `meaningSameChoice`：测试同一个字在不同词语中的意思是否相同，例如“加点字意思相同的一项是”。每个选项推荐用对象格式：`{"words":["拔草","拔河"],"targetChar":"拔","sameMeaning":true,"reason":"都表示向外拉出"}`。`words` 应是一组 2-3 个词语，且每个词语都包含 `targetChar`；同一道题四个选项里的词语不得重复；不要用 `·` 或把加点字单独拆出来，前端会自动给 `targetChar` 加下点。每个选项都必须有 `reason`，正确项解释为什么意思相同，错误项解释为什么意思不同。错误选项也必须比较同一个汉字在不同词语里的意思，不要用“辨/辩”“在/再”“做/作”这种不同字形来凑选项。
7. `wordSentence`：用错字组词，并要求孩子造句。

## 生成原则

- 所有题目必须先适配用户选择的 `grade` 和 `trainingLevel`。
- 内容参考统编版/部编版小学语文该年级课内常见生字、词语、课文语境和常见易错点，不使用明显高年级、生僻或超纲表达。
- 句子自然、短、清楚，符合对应年级学生理解水平。
- 所有题目都必须是语文内容：考查字音、字形、字义、词语搭配或语境表达，不能只是机械拆字、凑字或生成不通顺句子。
- `confusingCharFill` 必须保证答案字填入后形成真实常用词语，并提供 `answerWord`、`completedSentence` 和 `explanation`，服务端会校验这些字段。
- `meaningSameChoice` 必须保证每个选项都围绕同一个 `targetChar` 比较字义，并为每个选项提供原因说明。
- `meaningSameChoice` 同一道题内不得重复使用同一个词语。
- 所有拼音必须带声调符号，例如 `cháo shuǐ`、`biàn bié`，不能输出 `chao shui`。
- 辨音题每个字只给 3 个读音候选，不能全靠改声调凑选项。
- 字音字形综合选择题必须同时考查读音和字形；不能只用读音错误充当干扰。
- 每一道题都必须围绕输入的错字或其易混字，不要泛泛出题。
- 干扰项必须合理，但不能故意制造错误知识。
- 同一张练习页避免重复使用完全相同的词语。
- 答案解释要短，一句话即可，家长能快速核对。
- 服务端不能靠删除坏题来通过校验；每个已选题型必须补足 `questionCount` 道合格题。生成链路默认只请求 1 次素材包，不再整卷重写；API 繁忙时使用本地保守素材兜底。
- 不要输出 Markdown、注释、代码块或额外说明，只输出 JSON。
