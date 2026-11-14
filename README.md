# Synthesizer V Sharp MCP

把「旋律 + 歌词」直接写成 Synthesizer V Studio 工程文件的 MCP 服务器。

## 这是什么

一个零依赖的 MCP stdio 服务端（只要 Node.js 18+）。模型用它调几个工具，就能生成合法的 `.svp` 工程，然后在 Synthesizer V Studio 里试听、改、导出。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `list_voices` | 列出本机装的所有声库（名称、版本、支持的语种、文件夹） |
| `write_song` | 用 `notes` 数组或 `notation` 简谱写出 `.svp`，含速度、拍号、声库、语言、Vocal Mode |
| `read_song` | 读回一个 `.svp` 的摘要（速度、拍号、声库、歌词、音域、时长），可选返回逐音符 |
| `open_song` | 用 `synthv-sharp.exe` 打开工程，窗口独立于本服务器 |
| `app_status` | 编辑器是否在运行、程序路径、默认输出目录 |

## 简谱写法

每个音 `音高:拍数:歌词`，空格分隔，`|` 是隔线。

```
C4:1:你 D4:0.5:好 E4:0.5:吗 R:1 | F4:2:啊 -:1:啊
```

- 拍数按四分音符计，`0.5` 是八分音符；`4/4` 一小节 4 拍。
- `R` 是休止（占时间不发声），`-` 是把前一个音高再唱一个音节。
- 音高写 `C4`、`F#3`、`Bb2` 或 MIDI 数字 `60`。

## 为什么是「写工程文件」而不是「控制正在运行的编辑器」

Synthesizer V Studio 没有对外 API，渲染也只在 GUI 里发生。所以这里的做法是：直接生成合法的 `.svp`（纯 JSON，编辑器自带格式），再由编辑器自己加载、合成、导出。

好处是确定、可回读、不依赖正在运行的窗口；代价是**出音频仍要在编辑器里点一次渲染**。

## 安装

`package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`，其中插入 `@deepseek-ai/dsh-mcp-client`，用 stdio 拉起 `server.mjs`。

```
dsh plugin add <本目录>
```

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `SV_APP_DIR` | 编辑器所在目录 |
| `SV_DATABASES_DIR` | 声库目录，默认 `Documents\Dreamtonics\Synthesizer V Studio\databases` |
| `SV_SONGS_DIR` | `write_song` 的默认输出目录 |

## 已知边界

- 不做渲染、不做实时编辑、不碰已打开的工程；只生成与读取文件。
- 非默认声库的语言/版本来自 `voice.nofs` 头部推断，个别 Lite 声库的描述符可能不准，此时用 `read_song` 检查、或在编辑器里手动换声库。

## 许可证

本仓库只包含 MCP 服务端代码，不包含 Synthesizer V Studio 本体、声库或任何语音数据。
