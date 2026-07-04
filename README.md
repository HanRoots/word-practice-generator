# 字词练习生成器

面向小学语文字词复习的本地网页工具。家长输入孩子写错的单字，工具会结合本地教材字库和大模型素材生成可打印练习页。

## 功能

- 支持按年级生成字词练习。
- 支持前端配置 OpenAI 兼容 API、DeepSeek 或自定义接口。
- 支持 8 类题型：
  - 抄写巩固
  - 错字组词辨音
  - 看拼音写词语
  - 易混字填空辨析
  - 语境看拼音写词
  - 字音字形综合选择
  - 加点字意思辨析
  - 组词造句
- 支持每类题型按错字量生成 1 倍、2 倍、3 倍练习；抄写题的倍数表示每个错字抄写几遍。
- 内置三至六年级统编版字词补充库，用于补充读音、常用词、易混字和年级词语。
- 大模型不可用时，会尽量用本地字库兜底生成保守练习。
- 支持 A4 打印预览和答案页。

## 启动

### 网页版

```bash
node server.js
```

默认地址：

```text
http://127.0.0.1:8797
```

也可以通过环境变量指定端口：

```bash
PORT=8899 node server.js
```

### 桌面版

首次安装依赖：

```bash
npm install
```

开发运行：

```bash
npm run desktop
```

生成本机可运行的 macOS 应用目录：

```bash
npm run pack
```

生成 Windows x64 安装包和便携版：

```bash
npm run dist:win
```

桌面版会把网页、`server.js` 组题服务和本地字库一起打包。API Key 不会写入安装包，使用者仍然需要在「API 配置」里填写自己的模型服务；如果只使用本地兜底素材，生成能力会保守一些。

## API 配置

页面左侧的「API 配置」可以填写：

- Provider
- Base URL
- Model
- API Key
- 超时时间

配置保存在浏览器本地，只发送到本机 `server.js` 代理服务，不会写入项目文件。

服务端也支持环境变量兜底：

```bash
LLM_BASE_URL=https://api.openai.com/v1 \
LLM_MODEL=gpt-4.1-mini \
LLM_API_KEY=YOUR_API_KEY \
node server.js
```

## 字库

当前字库文件：

```text
data/word-bank.json
```

它由桌面上的 Word 字表导入生成，用于补充教材字词资料，不替代现有生成链路。

重新导入：

```bash
python3 tools/import_word_bank.py /Users/han/Desktop/字表库 data/word-bank.json
```

## 文件说明

- `index.html`：前端页面、打印排版和本地状态保存。
- `server.js`：本地服务、大模型调用、素材规范化和组题逻辑。
- `data/word-bank.json`：三至六年级字词补充库。
- `tools/import_word_bank.py`：从 `.docx` 字表导入本地 JSON 字库。
- `api-contract.md`：大模型素材生成契约。
