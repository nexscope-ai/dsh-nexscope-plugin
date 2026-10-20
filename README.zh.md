# Nexscope for DeepSeek Harness

在 DeepSeek Harness 中使用 [Nexscope](https://www.nexscope.ai) 做电商研究：商品、关键词、市场、竞品、评论与广告数据，覆盖 Amazon、TikTok、Temu、Shopee、1688、eBay、Etsy、Walmart，并可直接导出文件。

这是 DSH 的插件 bundle：通过 OAuth 连接 Nexscope MCP 服务，提供可搜索的能力目录，并内置 `nexscope` skill 说明调用规则。

## 环境要求

- DeepSeek Harness `>=0.2.0-rc.2 <0.3.0`
- 有可用额度的 Nexscope 账号
- 能打开浏览器的桌面环境

## 安装

```sh
dsh plugin --profile web add @nexscope/dsh-nexscope
```

然后重启 profile。插件会出现在 Plugins 页，`nexscope` skill 会出现在会话的技能目录中。

## 登录

让 DeepSeek Harness 连接 Nexscope，或调用 `nexscope_sign_in`。插件会打开 Nexscope 登录页，并在本机 `127.0.0.1:45871`–`45873` 监听回调。授权信息保存在 harness 凭据库中，之后会自动 refresh，不需要 API key，也不需要把密钥贴进对话。

## 工具

Nexscope 发布 500 多个工具。全部注册会占用大量上下文，因此插件只注册八个：

| 工具 | 用途 |
| --- | --- |
| `nexscope_sign_in` | 打开浏览器并保存授权 |
| `nexscope_sign_out` | 删除已保存的授权并关闭连接 |
| `nexscope_status` | 查看连接状态与目录工具数 |
| `nexscope_find_tools` | 按关键词搜索能力目录 |
| `nexscope_describe_tool` | 读取某个工具的精确输入 schema，并提示是否消耗 credits |
| `nexscope_call_tool` | 按名字调用任意已发布工具 |
| `nexscope_export` | 把 JSON 结果导出为 CSV / JSON / JSONL |
| `nexscope_account` | 查看余额与用量（需要 API key，见下） |

## 配置

```yaml
- id: nexscope
  config:
    callbackPorts: [45871, 45872, 45873]
    toolCallTimeoutMs: 120000
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `mcpUrl` | `https://api.nexscope.ai/api/skill-api/v2/mcp` | MCP 端点 |
| `scope` | `mcp:tools` | OAuth scope |
| `clientMetadataUrl` | `https://www.nexscope.ai/.well-known/dsh-nexscope-client.json` | 客户端身份文档 |
| `signInTimeoutMs` | `300000` | 登录等待时间 |
| `toolCallTimeoutMs` | `120000` | 单次调用超时 |
| `apiBase` | `https://api.nexscope.ai` | 账户查询用的 REST 地址 |
| `apiKeyEnv` | `NEXSCOPE_API_KEY` | 可选的 API key 引用 |
| `callbackPorts` | `[45871, 45872, 45873]` | OAuth 回调端口 |

### 余额查询

账户接口只接受 API key（OAuth token 会被拒绝）。在 `~/.dsh/.env` 加一行 `NEXSCOPE_API_KEY=nk-...`，或写入 DSH 凭据库，重启 profile 后 `nexscope_account` 就会显示余额。不配置也不影响工具调用。

## 与原有插件的差异

- 工具面按需发现：541 个技能都可经 `nexscope_find_tools` → `nexscope_describe_tool` → `nexscope_call_tool` 调用。
- `nexscope_workflow_*` 目前生产与测试环境都未发布；发布后会自动出现在目录中，无需改插件。
- 交互式 Research Canvas 需要 MCP Apps 宿主，DSH 没有，因此不提供画布 UI；workflow 的 draft/read 类工具仍可无界面使用。
- 导出用 `nexscope_export` 完成，不依赖 Python CLI。

## 开发

```sh
npm ci
npm run verify
```

`npm run verify` 依次执行 typecheck、37 个测试和构建。

## 许可

专有许可，见 [LICENSE](LICENSE)。
